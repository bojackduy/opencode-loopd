// ─── Server Plugin Entry ─────────────────────────────────────────────────────
// The engine. Hooks, tools, control worker, goal tools, event handling.
// Starts lazily: no timers, no polling, no disk reads until a goal exists.

import type { Plugin, PluginModule } from "@opencode-ai/plugin"
import { define } from "@opencode-ai/plugin/v2/promise"
import { createControlWorker } from "../application/control-worker"
import { createLoopEngine } from "../application/loop-engine"
import { createGoalService } from "../application/goal-service"
import { createScheduleWorker } from "../application/schedule-worker"
import { createRealHost } from "./host-adapter"
import { goalTools } from "./goal-tools"
import { ownerTools } from "./owner-tools"
import { describeError, logServerEvent } from "../infrastructure/server-log"
import { addToolCall, removeToolCall } from "../domain/runtime"
import { readState, mutateState } from "../infrastructure/state-repository"
import type { GoalToolDefaults } from "./goal-tools"

const PLUGIN_ID = "opencode-loopd.server"

const server: Plugin = async ({ client, directory }, pluginOptions) => {
  const defaults = parsePluginDefaults(pluginOptions)
  const host = createRealHost(client, directory)
  const goalService = createGoalService(host)

  const worker = createControlWorker({
    directory,
    goalService,
    pollIntervalMs: 1_000,
    defaults,
  })

  const engine = createLoopEngine({
    directory,
    host,
    goalService,
    pollIntervalMs: 30_000,
  })

  const scheduleWorker = createScheduleWorker({
    directory,
    goalService,
    intervalMs: 5_000,
  })

  // Start lazily: only when first event arrives or goal is created
  let started = false
  let reconciliationStarted = false
  function ensureStarted() {
    if (started) return
    started = true
    engine.start()
    worker.start()
    scheduleWorker.start()
  }

  function reconcileInBackground() {
    if (reconciliationStarted) return
    reconciliationStarted = true
    void logServerEvent(directory, "reconcile.started")
    void goalService.reconcile(directory).then(
      () => logServerEvent(directory, "reconcile.completed"),
      (error) => logServerEvent(directory, "reconcile.failed", { detail: describeError(error) }),
    )
  }

  return {
    event: async ({ event }) => {
      // Lazy start on first relevant event
      const type = (event as any)?.type as string | undefined
      if (type?.startsWith("session.")) {
        ensureStarted()
      }

      // Route through engine (engine filters by type before disk I/O)
      await engine.handleEvent(event)
      if (type?.startsWith("session.")) reconcileInBackground()
    },
    tool: { ...goalTools(directory, goalService, undefined, defaults), ...ownerTools({ directory, host, goalService }) },
    "tool.execute.before": async (input, _output) => {
      // Track tool call start for worker sessions only
      const activeWorkers = goalService.getActiveWorkers()
      let matchedGoalID: string | undefined
      for (const [goalID, worker] of activeWorkers) {
        if (worker.workerSessionID === input.sessionID) {
          matchedGoalID = goalID
          break
        }
      }
      if (!matchedGoalID) return

      try {
        await mutateState(directory, `tool-call.start:${matchedGoalID}:${input.callID}`, async (s) => {
          const runtime = s.runtimes.find((r) => r.goalID === matchedGoalID)
          if (runtime) Object.assign(runtime, addToolCall(runtime, input.callID))
          return s
        })
      } catch {}
    },
    "tool.execute.after": async (input, output) => {
      // Lazy start when goal tools are used
      if (input.tool === "loopd_create_goal" || input.tool === "get_goal" || input.tool === "report_goal_progress") {
        ensureStarted()
        reconcileInBackground()
      }

      // Track tool call end for worker sessions only
      const activeWorkers = goalService.getActiveWorkers()
      let matchedGoalID: string | undefined
      for (const [goalID, worker] of activeWorkers) {
        if (worker.workerSessionID === input.sessionID) {
          matchedGoalID = goalID
          break
        }
      }
      if (matchedGoalID) {
        try {
          await mutateState(directory, `tool-call.end:${matchedGoalID}:${input.callID}`, async (s) => {
            const runtime = s.runtimes.find((r) => r.goalID === matchedGoalID)
            if (runtime) Object.assign(runtime, removeToolCall(runtime, input.callID))
            return s
          })
        } catch {}
      }

      // Forward terminal worker events to the parent session (deduped)
      if (input.tool === "complete_goal" || input.tool === "block_goal") {
        try {
          const raw = (output as any)?.output as string | undefined
          if (!raw) return
          const parsed = JSON.parse(raw) as any
          if (parsed.status !== "complete" && parsed.status !== "blocked") return
          const goalID = parsed.goalID as string | undefined
          if (!goalID) return
          const { shouldNotifyParent, markParentNotified } = await import("../domain/runtime")
          const state = await readState(directory)
          const goal = state.goals.find((g) => g.id === goalID)
          if (!goal) return
          const runtime = state.runtimes.find((r) => r.goalID === goalID)
          const notifyType = parsed.status === "complete" ? ("complete" as const) : ("blocked" as const)
          if (runtime && !shouldNotifyParent(runtime, notifyType)) return
          if (runtime) {
            await mutateState(directory, `notify-parent:${goalID}`, async (s) => {
              const rt = s.runtimes.find((r) => r.goalID === goalID)
              if (rt) markParentNotified(rt, notifyType)
              return s
            })
          }
          const message =
            parsed.status === "complete"
              ? `Loop goal "${goal.name}" completed: ${parsed.summary || ""}. Evidence: ${parsed.evidence || ""}. Artifacts: ${goal.config.artifactDir || "n/a"}.`
              : `Loop goal "${goal.name}" blocked: ${parsed.reason || ""}. Needed: ${parsed.needed || ""}.`
          await host.notifyOwner(goal.ownerSessionID, message)
        } catch {}
      }
    },
    dispose: async () => {
      engine.stop()
      await worker.stop()
      scheduleWorker.stop()
    },
  }
}

function parsePluginDefaults(options: Record<string, unknown> | undefined): GoalToolDefaults {
  const agent = typeof options?.defaultAgent === "string" ? options.defaultAgent.trim() : ""
  const model = typeof options?.defaultModel === "string" ? options.defaultModel.trim() : ""
  const checks = Array.isArray(options?.defaultChecks)
    ? options.defaultChecks
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean)
    : []
  return {
    defaultAgent: agent || undefined,
    defaultModel: model || undefined,
    defaultChecks: checks.length > 0 ? checks : undefined,
  }
}

// ─── V2 (opencode v2 core) ───────────────────────────────────────────────────
// Dual export: the v1 loader (`readV1Plugin`, kind=server) reads `.server` and
// ignores the extra `setup` key; the v2 external loader
// (`core/src/config/plugin/external.ts`, decodes default as { id, effect } |
// { id, setup }) reads `.setup` and ignores the extra `server` key.
// The engine is v1-driven (tools + session events + client.session.* have no
// v2 PluginContext equivalent yet), so v2 setup is intentionally dormant: it
// lets the package load cleanly on v2 instead of being silently skipped,
// while the TUI dashboard (unchanged v1 TUI runtime) keeps rendering state.
const v2 = define({
  id: PLUGIN_ID,
  async setup() {},
})

export default {
  id: PLUGIN_ID,
  server,
  setup: v2.setup,
} satisfies PluginModule & { id: string; setup: typeof v2.setup }
