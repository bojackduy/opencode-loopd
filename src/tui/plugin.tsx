// ─── TUI Plugin Entry ────────────────────────────────────────────────────────
// Modal dashboard for the loop engine. Neovim-style, command-driven.

/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { LoopDashboard } from "./dashboard"

const PLUGIN_ID = "opencode-loopd.tui"

const tui: TuiPlugin = async (api) => {
  const directory = api.state.path.directory

  const open = () => {
    api.ui.dialog.replace(() => <LoopDashboard api={api} directory={directory} />)
    api.ui.dialog.setSize("xlarge")
  }

  api.keymap.registerLayer({
    commands: [
      {
        name: "opencode.loopd.dashboard",
        title: "Loop Dashboard",
        category: "Loop",
        namespace: "palette",
        slashName: "loop",
        run: open,
      },
    ],
    bindings: [
      { key: "ctrl+shift+l", cmd: "opencode.loopd.dashboard", desc: "Open loop dashboard" },
    ],
  })

  api.lifecycle.onDispose(() => {})
}

export default {
  id: PLUGIN_ID,
  tui,
} satisfies TuiPluginModule & { id: string }
