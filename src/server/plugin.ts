// ─── Server Plugin Entry ─────────────────────────────────────────────────────
// The engine. Hooks, tools, control worker, goal tools, event handling.
// Starts lazily: no timers, no polling, no disk reads until a goal exists.

import type { Plugin, PluginModule } from "@opencode-ai/plugin"
import { createControlWorker } from "../application/control-worker"
import { createLoopEngine } from "../application/loop-engine"
import { createGoalService } from "../application/goal-service"
import { createRealHost } from "./host-adapter"
import { goalTools } from "./goal-tools"
import { describeError, logServerEvent } from "../infrastructure/server-log"

const PLUGIN_ID = "opencode-loopd.server"

const server: Plugin = async ({ client, directory }) => {
  const host = createRealHost(client, directory)
  const goalService = createGoalService(host)

  const worker = createControlWorker({
    directory,
    goalService,
    pollIntervalMs: 1_000,
  })

  const engine = createLoopEngine({
    directory,
    host,
    goalService,
    pollIntervalMs: 30_000,
  })

  // Start lazily: only when first event arrives or goal is created
  let started = false
  let reconciliationStarted = false
  function ensureStarted() {
    if (started) return
    started = true
    engine.start()
    worker.start()
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
    tool: goalTools(directory, goalService),
    "tool.execute.after": async (input, output) => {
      // Lazy start when goal tools are used
      if (input.tool === "loopd_create_goal" || input.tool === "get_goal" || input.tool === "report_goal_progress") {
        ensureStarted()
        reconcileInBackground()
      }
    },
    dispose: async () => {
      engine.stop()
      await worker.stop()
    },
  }
}

export default {
  id: PLUGIN_ID,
  server,
} satisfies PluginModule & { id: string }
