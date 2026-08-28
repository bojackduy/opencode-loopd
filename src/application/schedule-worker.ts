// ─── Application: Schedule Worker ───────────────────────────────────────────
// Interval requeue for scheduled goals — requeue same goal periodically.
// - Scans goals with config.schedule every intervalMs (default 5000)
// - Resurrects completed scheduled goals when nextRunAt due
// - Skip-if-running: respects lease, phase, workspaceWrite serialization
// - No LLM per tick beyond normal continueTurn

import { randomUUID } from "crypto"
import { readState, mutateState, appendEvent, appendGoalInbox } from "../infrastructure/state-repository"
import type { GoalID } from "../domain/goal"
import { leaseIsValid, releaseLease } from "../domain/runtime"
import type { GoalService } from "./goal-service"
import { logServerEvent } from "../infrastructure/server-log"

export interface ScheduleWorkerOptions {
  directory: string
  goalService: GoalService
  intervalMs?: number
}

export interface ScheduleWorker {
  start(): void
  stop(): void
  isRunning(): boolean
  tick(): Promise<number> // returns number of resurrected goals, for tests
}

export function createScheduleWorker(options: ScheduleWorkerOptions): ScheduleWorker {
  const { directory, goalService } = options
  const intervalMs = options.intervalMs ?? 5000
  let running = false
  let timer: ReturnType<typeof setInterval> | undefined

  function start() {
    if (running) return
    running = true
    timer = setInterval(() => {
      tick().catch(() => {})
    }, intervalMs)
  }

  function stop() {
    running = false
    if (timer) clearInterval(timer)
    timer = undefined
  }

  function isRunning() {
    return running
  }

  async function tick(): Promise<number> {
    const state = await readState(directory)
    let resurrected = 0

    for (const goal of state.goals) {
      const schedule = (goal.config as any).schedule as { everyMs: number; maxRuns?: number } | undefined
      if (!schedule || typeof schedule.everyMs !== "number" || schedule.everyMs < 1000) continue

      const runtime = state.runtimes.find((r) => r.goalID === goal.id)
      if (!runtime) continue

      // Only completed scheduled goals are resurrected — active idle is not requeued
      // Paused/blocked/budget_limited never auto-resurrect
      if (goal.status !== "complete") continue

      const count = runtime.scheduleRunCount ?? 0
      const max = schedule.maxRuns
      if (typeof max === "number" && count >= max) continue

      const nextAt = runtime.nextRunAt
      if (!nextAt) continue
      if (Date.now() < Date.parse(nextAt)) continue

      // WorkspaceWrite serialization — skip if another writer active
      const activeWriter = state.goals.find(
        (g) => g.id !== goal.id && g.status === "active" && (g.config as any).workspaceWrite,
      )
      if (goal.config.workspaceWrite && activeWriter) {
        await logServerEvent(directory, "schedule.skipped-writer-active", {
          goalID: goal.id,
          activeWriter: activeWriter.id,
        })
        continue
      }

      // Lease/phase guard — should be idle/complete, but double-check
      if (runtime.phase === "running" || runtime.phase === "queued" || runtime.phase === "compacting") continue
      if (leaseIsValid(runtime as any)) continue

      // Resurrect: complete -> active
      const didResurrect = await mutateState(directory, `schedule.tick:${goal.id}`, async (s) => {
        const g = s.goals.find((x) => x.id === goal.id)
        const rt = s.runtimes.find((x) => x.goalID === goal.id)
        if (!g || !rt) return s
        if (g.status !== "complete") return s
        // Re-check max after lock
        const curCount = rt.scheduleRunCount ?? 0
        if (typeof max === "number" && curCount >= max) return s
        const curNext = rt.nextRunAt
        if (!curNext || Date.now() < Date.parse(curNext)) return s

        g.status = "active"
        g.updatedAt = new Date().toISOString()
        // Keep completionEvidence as history; new run will overwrite on next complete
        g.blocker = undefined

        Object.assign(rt, releaseLease(rt))
        rt.activeRunID = undefined
        rt.consecutiveFailures = 0
        rt.noProgressCount = 0
        rt.progressDuringTurn = false
        rt.forceFinishRequested = undefined
        rt.lastError = undefined
        rt.lastScheduleAt = new Date().toISOString()
        // nextRunAt is kept until next completion updates it; clear to avoid double-fire
        // Keep it so if continueTurn fails, next tick will retry; completion will overwrite
        rt.updatedAt = new Date().toISOString()
        return s
      })

      const after = didResurrect.goals.find((g) => g.id === goal.id)
      if (!after || after.status !== "active") continue

      await appendEvent(directory, {
        version: 1,
        eventID: randomUUID(),
        goalID: goal.id as GoalID,
        type: "schedule.tick",
        scheduleRunCount: count,
        nextRunAt: nextAt,
        timestamp: new Date().toISOString(),
        revision: didResurrect.revision,
      } as any)

      await logServerEvent(directory, "schedule.resurrected", {
        goalID: goal.id,
        scheduleRunCount: count,
        nextRunAt: nextAt,
      })

      // Inject scheduled tick context for the worker
      const maxLabel = typeof max === "number" ? `/${max}` : ""
      await appendGoalInbox(
        directory,
        goal.id,
        "user",
        `Scheduled tick ${count + 1}${maxLabel} — re-execute the objective now. Previous completion: ${runtime.scheduleRunCount ?? 0} runs. Ensure artifact checks pass for this tick (e.g., append timestamp to tick.txt).`,
      )

      // Drive continuation — this will acquire lease and prompt worker
      try {
        await goalService.continueTurn(directory, goal.id as GoalID)
        resurrected++
      } catch {}
    }

    return resurrected
  }

  return { start, stop, isRunning, tick }
}
