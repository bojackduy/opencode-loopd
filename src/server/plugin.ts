// ─── Server Plugin Entry ─────────────────────────────────────────────────────
// The engine. Hooks, tools, control worker, goal tools, event handling.

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

  // Start the control worker
  const worker = createControlWorker({
    directory,
    host,
    pollIntervalMs: 500,
  })
  worker.start()

  // Start the loop engine
  const engine = createLoopEngine({
    directory,
    host,
    goalService,
    pollIntervalMs: 5_000,
  })
  engine.start()

  return {
    event: async ({ event }) => {
      // Route all events through the engine
      await engine.handleEvent(event)
    },
    tool: goalTools(directory),
    "tool.execute.after": async (input, output) => {
      // Future: detect goal-related tool completions
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
