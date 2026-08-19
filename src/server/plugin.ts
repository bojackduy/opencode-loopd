// ─── Server Plugin Entry ─────────────────────────────────────────────────────
// The engine. Hooks, tools, control worker, goal tools.

import type { Plugin, PluginModule } from "@opencode-ai/plugin"
import { createControlWorker } from "../application/control-worker"
import { createRealHost } from "./host-adapter"
import { goalTools } from "./goal-tools"

const PLUGIN_ID = "opencode-loopd.server"
let worker: ReturnType<typeof createControlWorker> | undefined

const server: Plugin = async ({ client, directory }) => {
  const host = createRealHost(client)

  worker = createControlWorker({
    directory,
    host,
    pollIntervalMs: 500,
  })
  worker.start()

  return {
    event: async ({ event }) => {
      // Future: detect session idle for continuation
    },
    tool: goalTools(directory),
    "tool.execute.after": async (input, output) => {
      // Future: detect goal-related tool completions
    },
    dispose: async () => {
      worker?.stop()
    },
  }
}

export default {
  id: PLUGIN_ID,
  server,
} satisfies PluginModule & { id: string }
