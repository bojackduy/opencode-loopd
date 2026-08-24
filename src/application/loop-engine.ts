// ─── Application: Loop Engine ────────────────────────────────────────────────
// The central orchestrator. Handles session events, drives continuation,
// enforces limits, and manages compaction.
// Zero-cost when no goals exist: event hook filters by type before disk read.

import { randomUUID } from "crypto"
import { readState, mutateState, appendEvent } from "../infrastructure/state-repository"
import type { StoreState } from "../infrastructure/state-repository"
import { isTerminal } from "../domain/goal"
import type { GoalID } from "../domain/goal"
import {
  releaseLease,
  recordActivity,
  shouldNotifyParent,
  markParentNotified,
  type GoalRuntimeState,
} from "../domain/runtime"
import type { LoopEvent } from "../domain/events"
import type { GoalService } from "./goal-service"
import type { LoopHost } from "../server/host-adapter"
import { describeError, logServerEvent } from "../infrastructure/server-log"

/** Two-stage idle debounce — require two idle signals 2s apart with no activity in between. */
const CONFIRM_IDLE_DURATION_MS = 2000

const HANDLED_EVENT_TYPES = new Set([
  "session.idle",
  "session.status",
  "session.error",
  "session.compacted",
  "message.updated",
  "message.part.updated",
])

export interface LoopEngineOptions {
  directory: string
  host: LoopHost
  goalService: GoalService
  pollIntervalMs?: number
  confirmIdleMs?: number
  unknownStatusThreshold?: number
}

export interface LoopEngine {
  start(): void
  stop(): void
  isRunning(): boolean
  /** Handle a plugin event. Returns true if the event was consumed. */
  handleEvent(event: any): Promise<boolean>
  /** Preload worker sessions into cache (for tests). */
  preloadWorkerSessions(): Promise<void>
}

export function createLoopEngine(options: LoopEngineOptions): LoopEngine {
  const { directory, host, goalService } = options
  const maintenanceMs = options.pollIntervalMs ?? 30_000
  const confirmIdleMs = options.confirmIdleMs ?? CONFIRM_IDLE_DURATION_MS
  const unknownStatusThreshold = Math.max(1, options.unknownStatusThreshold ?? 3)

  let running = false
  let maintenanceTimer: ReturnType<typeof setInterval> | undefined
  // In-memory cache of worker session IDs — avoids disk read on every event
  let knownWorkerSessions = new Set<string>()
  let knownWorkerSessionsLoaded = false
  // Guard against concurrent continuations for the same goal
  const inflightContinuations = new Set<GoalID>()
  const recentForceFinishBlocked = new Map<GoalID, number>()

  async function loadWorkerSessionsIfneeded() {
    if (knownWorkerSessionsLoaded) return
    try {
      const state = await readState(directory)
      for (const g of state.goals) {
        if (g.workerSessionID) knownWorkerSessions.add(g.workerSessionID)
      }
      knownWorkerSessionsLoaded = true
    } catch {}
  }

  function syncWorkerSessionsFromService() {
    for (const worker of goalService.getActiveWorkers().values()) {
      knownWorkerSessions.add(worker.workerSessionID)
    }
  }

  // Exposed for tests to preload worker sessions
  async function preloadWorkerSessions() {
    await loadWorkerSessionsIfneeded()
    syncWorkerSessionsFromService()
  }

  function start() {
    if (running) return
    running = true
    // Load worker sessions eagerly so event hook is ready immediately
    loadWorkerSessionsIfneeded().catch(() => {})
    // Maintenance timer — much slower than before (30s vs 5s)
    maintenanceTimer = setInterval(() => {
      if (running) maintenance().catch(() => {})
    }, maintenanceMs)
  }

  function stop() {
    running = false
    if (maintenanceTimer) clearInterval(maintenanceTimer)
    maintenanceTimer = undefined
    inflightContinuations.clear()
  }

  function isRunning() {
    return running
  }

  async function continueGoal(goalID: GoalID): Promise<boolean> {
    if (inflightContinuations.has(goalID)) return false
    inflightContinuations.add(goalID)
    try {
      await goalService.continueTurn(directory, goalID)
      return true
    } finally {
      inflightContinuations.delete(goalID)
    }
  }

  // ─── Event Handling ───────────────────────────────────────────────────────

  async function handleEvent(event: any): Promise<boolean> {
    if (!running || !event || typeof event !== "object") return false

    // FAST PATH: filter by event type BEFORE any disk I/O
    const type = event.type as string | undefined
    if (!type || !HANDLED_EVENT_TYPES.has(type)) return false

    // FAST PATH: check if this session is one we care about
    const sessionID = eventSessionID(event)
    if (!sessionID) return false

    // Load worker sessions on first event (lazy)
    await loadWorkerSessionsIfneeded()
    syncWorkerSessionsFromService()

    // FAST PATH: if we know there are no worker sessions, skip without disk read
    if (knownWorkerSessionsLoaded && knownWorkerSessions.size === 0) return false

    // FAST PATH: skip events for sessions we don't own
    if (knownWorkerSessions.size > 0 && !knownWorkerSessions.has(sessionID)) return false

    // SLOW PATH: only now read state from disk
    const state = await readState(directory)
    const goal = state.goals.find((g) => g.workerSessionID === sessionID)
    if (!goal) return false

    // Update worker session cache
    if (goal.workerSessionID) knownWorkerSessions.add(goal.workerSessionID)

    // Only active goals own live worker runs. Blocked/limited/paused goals wait
    // for an explicit owner transition.
    if (goal.status !== "active") return false

    switch (type) {
      case "session.idle":
        return await handleSessionIdle(state, goal)
      case "session.status":
        return await handleSessionStatus(state, goal, event)
      case "session.error":
        return await handleSessionError(state, goal, event)
      case "session.compacted":
        return await handleSessionCompacted(state, goal)
      case "message.updated":
      case "message.part.updated":
        return await handleMessageActivity(goal, event)
      default:
        return false
    }
  }

  function eventSessionID(event: any): string | undefined {
    return event.properties?.sessionID
      || event.properties?.info?.sessionID
      || event.properties?.part?.sessionID
  }

  async function handleMessageActivity(goal: any, event: any): Promise<boolean> {
    let matched = false
    await mutateState(directory, `message-activity:${goal.id}`, async (s) => {
      const rt = s.runtimes.find((r) => r.goalID === goal.id)
      if (!rt || rt.phase !== "running" || !rt.activePromptMessageID) return s

      if (event.type === "message.updated") {
        const info = event.properties?.info
        if (info?.role === "user" && info.id === rt.activePromptMessageID) {
          Object.assign(rt, recordActivity(rt))
          rt.activePromptObservedAt = new Date().toISOString()
          matched = true
        } else if (info?.role === "assistant" && info.parentID === rt.activePromptMessageID) {
          Object.assign(rt, recordActivity(rt))
          rt.activeAssistantMessageID = info.id
          if (info.time?.completed) {
            rt.activeAssistantCompletedAt = new Date(info.time.completed).toISOString()
          }
          matched = true
        }
      } else {
        const part = event.properties?.part
        if (part?.messageID && part.messageID === rt.activeAssistantMessageID) {
          Object.assign(rt, recordActivity(rt))
          matched = true
        }
      }
      return s
    })
    return matched
  }

  // ─── Idle Handler ─────────────────────────────────────────────────────────

  async function handleSessionIdle(state: StoreState, goal: any): Promise<boolean> {
    const goalID = goal.id
    // Guard against concurrent continuations
    if (inflightContinuations.has(goalID)) return false

    // Stage an idle candidate under the current run generation. New prompts
    // clear the candidate, and a stale event can never release a newer lease.
    let completedRunID: string | undefined
    let confirmation: {
      generation: number
      promptMessageID: string
      candidateAt: string
      assistantCompleted: boolean
    } | undefined
    let afterIdle = await mutateState(directory, `idle:${goalID}`, async (s) => {
      const g = s.goals.find((item) => item.id === goalID)
      if (!g) return s
      if (isTerminal(g.status) || g.status === "paused") return s
      const rt = s.runtimes.find((r) => r.goalID === goalID)
      if (!rt) return s
      if (rt.phase !== "running") return s
      if ((rt.activeToolCallIDs?.length ?? 0) > 0) {
        rt.idleCandidateAt = undefined
        rt.idleCandidateGeneration = undefined
        return s
      }

      const now = Date.now()
      if (!rt.idleCandidateAt || rt.idleCandidateGeneration !== rt.runGeneration) {
        rt.idleCandidateAt = new Date(now).toISOString()
        rt.idleCandidateGeneration = rt.runGeneration
        return s
      }
      const elapsed = now - Date.parse(rt.idleCandidateAt)
      if (elapsed < confirmIdleMs) return s
      if (rt.lastActivityAt && rt.lastActivityAt > rt.idleCandidateAt) {
        rt.idleCandidateAt = undefined
        rt.idleCandidateGeneration = undefined
        return s
      }

      if (rt.activePromptMessageID) {
        confirmation = {
          generation: rt.runGeneration,
          promptMessageID: rt.activePromptMessageID,
          candidateAt: rt.idleCandidateAt,
          assistantCompleted: Boolean(rt.activeAssistantCompletedAt),
        }
      } else {
        // Compatibility path for a run persisted by an older plugin version.
        completedRunID = rt.activeRunID
        Object.assign(rt, releaseLease(rt))
        rt.activeRunID = undefined
        rt.lastWorkerStatus = "idle"
      }
      return s
    })

    if (confirmation) {
      const candidate = confirmation
      const transcript = await inspectPromptTurn(goal.workerSessionID, candidate.promptMessageID)
      if (!transcript.latestUserPrompt || (!candidate.assistantCompleted && !transcript.assistantCompleted)) {
        return true
      }

      afterIdle = await mutateState(directory, `idle.confirm:${goalID}`, async (s) => {
        const g = s.goals.find((item) => item.id === goalID)
        const rt = s.runtimes.find((r) => r.goalID === goalID)
        if (!g || !rt || isTerminal(g.status) || g.status === "paused") return s
        if (rt.phase !== "running") return s
        if (rt.runGeneration !== candidate.generation) return s
        if (rt.activePromptMessageID !== candidate.promptMessageID) return s
        if (rt.idleCandidateGeneration !== candidate.generation) return s
        if (rt.idleCandidateAt !== candidate.candidateAt) return s
        if (rt.lastActivityAt && rt.lastActivityAt > candidate.candidateAt) return s
        if ((rt.activeToolCallIDs?.length ?? 0) > 0) return s

        completedRunID = rt.activeRunID
        Object.assign(rt, releaseLease(rt))
        rt.activeRunID = undefined
        rt.lastWorkerStatus = "idle"
        return s
      })
    }

    if (completedRunID) {
      await appendEvent(directory, {
        version: 1,
        eventID: randomUUID(),
        goalID,
        type: "run.completed",
        runID: completedRunID,
        timestamp: new Date().toISOString(),
        revision: afterIdle.revision,
      } satisfies LoopEvent)
    } else {
      // Candidate not confirmed, transcript not anchored, or generation changed.
      return true
    }

    // Re-read fresh state for limit enforcement
    const freshState = await readState(directory)
    const freshGoal = freshState.goals.find((g) => g.id === goalID)
    if (!freshGoal || freshGoal.status !== "active") return false
    const freshRuntime = freshState.runtimes.find((r) => r.goalID === goalID)
    if (!freshRuntime) return false

    const limitResult = enforceLimits(freshGoal, freshRuntime)
    if (limitResult.stop === "force_finish") {
      if (!freshRuntime.forceFinishRequested) {
        await mutateState(directory, `idle.force-finish:${goalID}`, async (s) => {
          const rt = s.runtimes.find((r) => r.goalID === goalID)
          if (rt) rt.forceFinishRequested = true
          return s
        })
        await goalService.continueTurn(directory, goalID, { forceFinish: true })
        return true
      }
      const blockedKey = goalID
      const nowBlocked = Date.now()
      const lastBlocked = recentForceFinishBlocked.get(blockedKey)
      if (lastBlocked !== undefined && nowBlocked - lastBlocked < 60_000) return true
      recentForceFinishBlocked.set(blockedKey, nowBlocked)
      let shouldNotifyBlocked = false
      const blockedState = await mutateState(directory, `idle.blocked:${goalID}`, async (s) => {
        const g = s.goals.find((item) => item.id === goalID)
        if (!g) return s
        g.status = "blocked"
        g.updatedAt = new Date().toISOString()
        g.blocker = {
          reason: limitResult.reason + " (force-finish ignored)",
          needed: "User intervention required. Use retry to attempt again.",
          at: new Date().toISOString(),
        }
        const rt = s.runtimes.find((r) => r.goalID === goalID)
        if (rt) {
          rt.forceFinishRequested = undefined
          if (shouldNotifyParent(rt, "stopped")) {
            markParentNotified(rt, "stopped")
            shouldNotifyBlocked = true
          }
        }
        return s
      })
      await appendEvent(directory, {
        version: 1,
        eventID: randomUUID(),
        goalID,
        type: "goal.blocked",
        reason: limitResult.reason + " (force-finish ignored)",
        needed: "User intervention required. Use retry to attempt again.",
        timestamp: new Date().toISOString(),
        revision: blockedState.revision,
      } satisfies LoopEvent)
      if (shouldNotifyBlocked) {
        await host.notifyOwner(
          goal.ownerSessionID,
          `Loop goal "${goal.name}" stopped: ${limitResult.reason} (child did not wrap up). Status: blocked. Last progress: ${goal.lastProgress?.summary || "none"}.`,
        )
      }
      return true
    }
    if (limitResult.stop === "budget") {
      const budgetState = await mutateState(directory, `idle.budget:${goalID}`, async (s) => {
        const g = s.goals.find((item) => item.id === goalID)
        if (g) {
          g.status = "budget_limited"
          g.updatedAt = new Date().toISOString()
        }
        return s
      })
      await appendEvent(directory, {
        version: 1,
        eventID: randomUUID(),
        goalID,
        type: "goal.status_changed",
        from: "active",
        to: "budget_limited",
        timestamp: new Date().toISOString(),
        revision: budgetState.revision,
      } satisfies LoopEvent)
      return true
    }

    if (shouldCompact(freshGoal, freshRuntime)) {
      await doCompact(freshGoal, freshRuntime)
      return true
    }

    await continueGoal(goalID)
    return true
  }

  async function inspectPromptTurn(
    workerSessionID: string | undefined,
    promptMessageID: string,
  ): Promise<{ latestUserPrompt: boolean; assistantCompleted: boolean }> {
    const noMatch = { latestUserPrompt: false, assistantCompleted: false }
    if (!workerSessionID) return noMatch
    let messages
    try {
      messages = await host.readMessages(workerSessionID, 50)
    } catch {
      return noMatch
    }
    const users = messages.filter((message) => message.role === "user")
    if (users.length === 0) return noMatch

    const allTimestamped = users.every((message) => message.timestamp && Number.isFinite(Date.parse(message.timestamp)))
    const ordered = allTimestamped
      ? [...users].sort((a, b) => Date.parse(a.timestamp!) - Date.parse(b.timestamp!))
      : users
    return {
      latestUserPrompt: ordered.at(-1)?.messageID === promptMessageID,
      assistantCompleted: messages.some(
        (message) => message.role === "assistant"
          && message.parentMessageID === promptMessageID
          && Boolean(message.completedAt),
      ),
    }
  }

  // ─── Status Handler ───────────────────────────────────────────────────────

  async function handleSessionStatus(state: StoreState, goal: any, event: any): Promise<boolean> {
    const runtime = state.runtimes.find((r) => r.goalID === goal.id)
    if (!runtime) return false

    const status = event.properties?.status
    const statusType = status?.type as string | undefined
    if (!statusType) return false

    if (statusType === "idle") return handleSessionIdle(state, goal)

    await mutateState(directory, `status:${goal.id}`, async (s) => {
      const rt = s.runtimes.find((r) => r.goalID === goal.id)
      if (!rt) return s
      if (statusType === "busy" || statusType === "retry") {
        Object.assign(rt, recordActivity(rt))
      }
      rt.lastWorkerStatus = statusType as any
      rt.updatedAt = new Date().toISOString()
      return s
    })
    return true
  }

  // ─── Error Handler ────────────────────────────────────────────────────────

  async function handleSessionError(state: StoreState, goal: any, event: any): Promise<boolean> {
    const runtime = state.runtimes.find((r) => r.goalID === goal.id)
    if (!runtime) return false

    const error = event.properties?.error
    const message = describeError(error) || "unknown error"

    let shouldNotify = false
    const newState = await mutateState(directory, `error:${goal.id}`, async (s) => {
      const g = s.goals.find((item) => item.id === goal.id)
      const rt = s.runtimes.find((r) => r.goalID === goal.id)
      if (!rt) return s

      rt.consecutiveFailures += 1
      rt.lastError = message
      rt.updatedAt = new Date().toISOString()
      rt.idleCandidateAt = undefined

      // Release lease
      if (rt.phase === "running") {
        Object.assign(rt, releaseLease(rt))
      }

      if (rt.consecutiveFailures >= (goal.config?.maxFailures || 5)) {
        if (g) {
          g.status = "blocked"
          g.updatedAt = new Date().toISOString()
          g.blocker = {
            reason: `Failed ${rt.consecutiveFailures} times. Last error: ${message}`,
            needed: "User intervention required. Use retry to attempt again.",
            at: new Date().toISOString(),
          }
        }
        if (shouldNotifyParent(rt, "failed")) {
          markParentNotified(rt, "failed")
          shouldNotify = true
        }
      } else {
        const backoffMs = Math.min(30_000, 1_000 * Math.pow(2, rt.consecutiveFailures))
        rt.retryAfter = new Date(Date.now() + backoffMs).toISOString()
        rt.phase = "waiting_retry"
      }

      return s
    })

    await appendEvent(directory, {
      version: 1,
      eventID: randomUUID(),
      goalID: goal.id,
      type: "run.failed",
      runID: runtime.activeRunID || "unknown",
      error: message,
      consecutiveFailures: runtime.consecutiveFailures + 1,
      timestamp: new Date().toISOString(),
      revision: newState.revision,
    } satisfies LoopEvent)

    const updatedGoal = newState.goals.find((g) => g.id === goal.id)
    if (updatedGoal?.status === "blocked") {
      await appendEvent(directory, {
        version: 1,
        eventID: randomUUID(),
        goalID: goal.id,
        type: "goal.blocked",
        reason: `Failed ${runtime.consecutiveFailures + 1} times`,
        needed: "User intervention required",
        timestamp: new Date().toISOString(),
        revision: newState.revision,
      } satisfies LoopEvent)
      if (shouldNotify) {
        await host.notifyOwner(
          goal.ownerSessionID,
          `Loop goal "${goal.name}" blocked after ${runtime.consecutiveFailures + 1} failures. Last error: ${message}.`,
        )
      }
    }

    return true
  }

  // ─── Compacted Handler ────────────────────────────────────────────────────

  async function handleSessionCompacted(state: StoreState, goal: any): Promise<boolean> {
    const runtime = state.runtimes.find((r) => r.goalID === goal.id)
    if (!runtime) return false

    const newState = await mutateState(directory, `compacted:${goal.id}`, async (s) => {
      const rt = s.runtimes.find((r) => r.goalID === goal.id)
      if (!rt) return s
      rt.lastCompactAt = new Date().toISOString()
      rt.updatedAt = new Date().toISOString()
      return s
    })

    await appendEvent(directory, {
      version: 1,
      eventID: randomUUID(),
      goalID: goal.id,
      type: "compaction.completed",
      timestamp: new Date().toISOString(),
      revision: newState.revision,
    } satisfies LoopEvent)

    return true
  }

  // ─── Limit Enforcement ────────────────────────────────────────────────────

  type LimitStop = "none" | "force_finish" | "budget"
  interface LimitResult {
    stop: LimitStop
    blocked: boolean
    event: "goal.blocked" | "goal.status_changed"
    reason: string
  }

  function enforceLimits(goal: any, runtime: GoalRuntimeState): LimitResult {
    const noResult: LimitResult = { stop: "none", blocked: false, event: "goal.status_changed", reason: "" }

    // Max turns — force child to wrap up with a semantic summary
    const maxTurns = goal.config?.maxTurns
    if (maxTurns && runtime.budgetTurnCount >= maxTurns) {
      return {
        stop: "force_finish",
        blocked: true,
        event: "goal.blocked",
        reason: `Reached max turns (${maxTurns})`,
      }
    }

    // Max no-progress — force child to wrap up
    const maxNoProgress = goal.config?.maxNoProgress
    if (maxNoProgress && runtime.noProgressCount >= maxNoProgress) {
      return {
        stop: "force_finish",
        blocked: true,
        event: "goal.blocked",
        reason: `No progress for ${runtime.noProgressCount} consecutive turns`,
      }
    }

    // Token budget — direct status change (no semantic summary needed)
    if (goal.tokenBudget && goal.tokensUsed >= goal.tokenBudget) {
      goal.status = "budget_limited"
      goal.updatedAt = new Date().toISOString()
      return {
        stop: "budget",
        blocked: true,
        event: "goal.status_changed",
        reason: `Token budget exhausted (${goal.tokensUsed}/${goal.tokenBudget})`,
      }
    }

    return noResult
  }

  // ─── Compaction ───────────────────────────────────────────────────────────

  function shouldCompact(goal: any, runtime: GoalRuntimeState): boolean {
    const compactEvery = goal.config?.compactEvery
    if (!compactEvery) return false
    return runtime.runCount > 0 && runtime.runCount % compactEvery === 0
  }

  async function doCompact(goal: any, runtime: GoalRuntimeState) {
    if (!goal.workerSessionID) return

    const prevPhase = runtime.phase

    const state = await mutateState(directory, `compact.start:${goal.id}`, async (s) => {
      const rt = s.runtimes.find((r) => r.goalID === goal.id)
      if (!rt) return s
      rt.phase = "compacting"
      rt.lastCompactAt = new Date().toISOString()
      return s
    })

    await appendEvent(directory, {
      version: 1,
      eventID: randomUUID(),
      goalID: goal.id,
      type: "compaction.started",
      timestamp: new Date().toISOString(),
      revision: state.revision,
    } satisfies LoopEvent)

    try {
      await host.compactSession(goal.workerSessionID)
    } catch {
      // Best-effort compaction
    }

    await mutateState(directory, `compact.end:${goal.id}`, async (s) => {
      const rt = s.runtimes.find((r) => r.goalID === goal.id)
      if (rt) rt.phase = prevPhase
      return s
    })
  }

  // ─── Maintenance ──────────────────────────────────────────────────────────

  async function maintenance() {
    syncWorkerSessionsFromService()
    // FAST PATH: skip entirely if no known worker sessions
    if (knownWorkerSessions.size === 0) return

    const state = await readState(directory)
    // FAST PATH: skip if no active goals
    const hasActiveGoals = state.goals.some((g) => g.status === "active")
    if (!hasActiveGoals) return

    for (const goal of state.goals) {
      if (goal.status !== "active") continue

      const runtime = state.runtimes.find((r) => r.goalID === goal.id)
      if (!runtime) continue

      // Handle waiting_retry: check if retry time has passed
      if (runtime.phase === "waiting_retry" && runtime.retryAfter) {
        if (Date.now() >= Date.parse(runtime.retryAfter)) {
          await mutateState(directory, `retry-ready:${goal.id}`, async (s) => {
            const rt = s.runtimes.find((r) => r.goalID === goal.id)
            if (rt) {
              rt.retryAfter = undefined
              rt.phase = "idle"
            }
            return s
          })
          goalService.continueTurn(directory, goal.id).catch(() => {})
        }
      }

      // Some OpenCode transports miss the idle event. Poll active workers so a
      // completed turn is continued on the maintenance cadence, not lease expiry.
      // Also poll idle-phase goals that missed the idle event entirely.
      if ((runtime.phase === "running" || runtime.phase === "idle") && goal.workerSessionID) {
        if (runtime.phase === "idle" && runtime.activeRunID) {
          await mutateState(directory, `maintenance.clear-stale-run:${goal.id}`, async (s) => {
            const rt = s.runtimes.find((r) => r.goalID === goal.id)
            if (rt?.phase === "idle" && rt.activeRunID) {
              Object.assign(rt, releaseLease(rt))
              rt.activeRunID = undefined
              rt.lastWorkerStatus = "idle"
            }
            return s
          })
          await logServerEvent(directory, "maintenance.stale-run-cleared", { goalID: goal.id })
        }

        const status = await host.sessionStatus(goal.workerSessionID)
        if (status === "unknown") {
          let shouldNotify = false
          const unknownState = await mutateState(directory, `maintenance.unknown-status:${goal.id}`, async (s) => {
            const rt = s.runtimes.find((r) => r.goalID === goal.id)
            if (!rt) return s
            rt.unknownStatusCount = Math.min(
              unknownStatusThreshold,
              (rt.unknownStatusCount ?? 0) + 1,
            )
            rt.lastUnknownStatusAt = new Date().toISOString()
            if (rt.unknownStatusCount >= unknownStatusThreshold && !rt.workerUnreachableNotifiedAt) {
              rt.workerUnreachableNotifiedAt = new Date().toISOString()
              shouldNotify = true
            }
            rt.updatedAt = new Date().toISOString()
            return s
          })
          const unknownRuntime = unknownState.runtimes.find((r) => r.goalID === goal.id)
          if (shouldNotify) {
            await logServerEvent(directory, "maintenance.worker-unreachable", {
              goalID: goal.id,
              workerSessionID: goal.workerSessionID,
              count: unknownRuntime?.unknownStatusCount,
            })
            await host.notifyOwner(
              goal.ownerSessionID,
              `Loop goal "${goal.name}" worker is unreachable after ${unknownRuntime?.unknownStatusCount ?? unknownStatusThreshold} status checks. The goal remains active; use inspect_background_goal, nudge_goal, pause_goal, or resume_goal to recover it.`,
            )
          }
          continue
        }

        if ((runtime.unknownStatusCount ?? 0) > 0 || runtime.workerUnreachableNotifiedAt) {
          await mutateState(directory, `maintenance.status-recovered:${goal.id}`, async (s) => {
            const rt = s.runtimes.find((r) => r.goalID === goal.id)
            if (rt) {
              rt.unknownStatusCount = 0
              rt.lastUnknownStatusAt = undefined
              rt.workerUnreachableNotifiedAt = undefined
              rt.updatedAt = new Date().toISOString()
            }
            return s
          })
          await logServerEvent(directory, "maintenance.worker-recovered", { goalID: goal.id })
        }

        if (status === "idle") {
          if (runtime.phase === "idle") {
            await continueGoal(goal.id)
          } else {
            await handleSessionIdle(state, goal)
          }
          continue
        }
      }
    }
  }

  return { start, stop, isRunning, handleEvent, preloadWorkerSessions }
}
