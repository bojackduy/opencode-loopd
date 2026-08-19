// ─── Server Plugin Entry ─────────────────────────────────────────────────────
// The engine. Hooks, tools, control worker, goal tools, event handling.
// Starts lazily: no timers, no polling, no disk reads until a goal exists.

import type { Plugin, PluginModule } from "@opencode-ai/plugin"
import { createControlWorker } from "../application/control-worker"
import { createLoopEngine } from "../application/loop-engine"
import { createGoalService } from "../application/goal-service"
import { createRealHost } from "./host-adapter"
import { goalTools } from "./goal-tools"

const PLUGIN_ID = "opencode-loopd.server"

const server: Plugin = async ({ client, directory }) => {
  const host = createRealHost(client)
  const goalService = createGoalService(host)

  const worker = createControlWorker({
    directory,
    host,
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
  function ensureStarted() {
    if (started) return
    started = true
    engine.start()
    worker.start()
  }

  return {
    event: async ({ event }) => {
      // Lazy start on first relevant event
      const type = (event as any)?.type as string | undefined
      if (type?.startsWith("session.")) ensureStarted()

      // Route through engine (engine filters by type before disk I/O)
      await engine.handleEvent(event)
    },
    tool: goalTools(directory),
    "tool.execute.after": async (input, output) => {
      // Lazy start when goal tools are used
      if (input.tool === "get_goal" || input.tool === "report_goal_progress") {
        ensureStarted()
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
