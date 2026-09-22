// ─── TUI Plugin Entry ────────────────────────────────────────────────────────
// Modal dashboard for the loop engine. Neovim-style, command-driven.

/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi, TuiPluginModule, TuiThemeCurrent } from "@opencode-ai/plugin/tui"
import type { Plugin as TuiV2 } from "@opencode/plugin/tui"
import { LoopDashboard } from "./dashboard"
import { CommandPanel } from "./command-panel"

const PLUGIN_ID = "opencode-loopd.tui"

const tui: TuiPlugin = async (api) => {
  const directory = api.state.path.directory

  const open = () => {
    const previousFocus = api.renderer.currentFocusedRenderable
    api.ui.dialog.replace(() => <LoopDashboard api={api} directory={directory} />)
    api.ui.dialog.setSize("xlarge")
    previousFocus?.blur()
  }

  const openCommands = () => {
    const previousFocus = api.renderer.currentFocusedRenderable
    api.ui.dialog.replace(() => <CommandPanel api={api} directory={directory} />)
    api.ui.dialog.setSize("xlarge")
    previousFocus?.blur()
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
      {
        name: "opencode.loopd.commands",
        title: "Command Sessions",
        category: "Loop",
        namespace: "palette",
        slashName: "commands",
        run: openCommands,
      },
    ],
    bindings: [
      { key: "<leader>o", cmd: "opencode.loopd.dashboard", desc: "Open loop dashboard" },
    ],
  })

  api.lifecycle.onDispose(() => {})
}

// ─── V2 (opencode v2 TUI) ───────────────────────────────────────────────────
// dashboard.tsx was written against the v1 api prop. Only the calls it (and
// this entry) actually make are mapped here; everything else is untouched.
// - dialog: `replace` → `show`, `setSize` → `set({ size })`; v2 `Dialog` has
//   no `open` getter, so openness is tracked locally (we own show/clear).
// - keymap: `{ name, category, namespace: "palette", slashName }` commands +
//   `{ key, cmd }` bindings → `{ id, group, palette: true, slash: { name } }`
//   commands with `bind`, activated via layer `bindings: [id]`.
// - events: v1 `session.status/error/compacted` have no v2 counterparts; the
//   dashboard only needs "something changed, refresh", mapped to the closest
//   v2 execution/compaction events.
// - theme: v2 `ResolvedTheme` is nested vs v1's flat `TuiThemeCurrent`.
function adaptThemeV2(theme: TuiV2.Context["theme"]): TuiThemeCurrent {
  // The live theme object may omit nested groups (custom/minimal themes),
  // and this getter runs inside render — a throw here crashes the whole TUI.
  // Every leaf falls back through text.default to a hardcoded default.
  const t = (theme ?? {}) as any
  const text = t.text ?? {}
  const fb = text.feedback ?? {}
  const bg = t.background ?? {}
  const surface = bg.surface ?? {}
  const diff = t.diff ?? {}
  const diffText = diff.text ?? {}
  const diffBg = diff.background ?? {}
  const diffHi = diff.highlight ?? {}
  const diffLn = diff.lineNumber ?? {}
  const syntax = t.syntax ?? {}
  const md = t.markdown ?? {}
  const dv = (v: unknown, fallback: string) => (typeof v === "string" ? v : fallback)
  const base = dv(text.default, "#ffffff")
  const muted = dv(text.subdued, "#888888")
  return {
    text: base,
    textMuted: muted,
    primary: base,
    accent: base,
    success: dv(fb.success?.default, "#22c55e"),
    warning: dv(fb.warning?.default, "#eab308"),
    error: dv(fb.error?.default, "#ef4444"),
    info: dv(fb.info?.default, base),
    background: dv(bg.default, "#000000"),
    backgroundPanel: dv(surface.overlay, dv(bg.default, "#000000")),
    backgroundElement: dv(surface.offset, dv(bg.default, "#000000")),
    diffAdded: dv(diffText.added, base),
    diffRemoved: dv(diffText.removed, base),
    diffContext: dv(diffText.context, muted),
    diffAddedBg: dv(diffBg.added, dv(bg.default, "#000000")),
    diffRemovedBg: dv(diffBg.removed, dv(bg.default, "#000000")),
    diffContextBg: dv(diffBg.context, dv(bg.default, "#000000")),
    diffHighlightAdded: dv(diffHi.added, base),
    diffHighlightRemoved: dv(diffHi.removed, base),
    diffLineNumber: dv(diffLn.text, muted),
    diffAddedLineNumberBg: dv(diffLn.background?.added, dv(bg.default, "#000000")),
    diffRemovedLineNumberBg: dv(diffLn.background?.removed, dv(bg.default, "#000000")),
    syntaxComment: dv(syntax.comment, muted),
    syntaxKeyword: dv(syntax.keyword, base),
    syntaxFunction: dv(syntax.function, base),
    syntaxVariable: dv(syntax.variable, base),
    syntaxString: dv(syntax.string, base),
    syntaxNumber: dv(syntax.number, base),
    syntaxType: dv(syntax.type, base),
    syntaxOperator: dv(syntax.operator, base),
    syntaxPunctuation: dv(syntax.punctuation, muted),
    markdownText: dv(md.text, base),
    markdownHeading: dv(md.heading, base),
    markdownLink: dv(md.link, base),
    markdownLinkText: dv(md.linkText, base),
    markdownCode: dv(md.code, base),
    markdownBlockQuote: dv(md.blockQuote, muted),
    markdownEmph: dv(md.emphasis, base),
    markdownStrong: dv(md.strong, base),
    markdownListItem: dv(md.listItem, base),
  } as unknown as TuiThemeCurrent
}

// v1 dashboard refresh triggers → closest v2 events ("something changed").
const REFRESH_EVENTS = [
  "session.idle",
  "session.execution.started",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.compaction.ended",
] as const

const v2setup: TuiV2.Definition["setup"] = (ctx) => {
  const directory = ctx.location?.directory ?? ctx.data.location.default().directory

  let dialogOpen = false
  const closeDialog = () => {
    dialogOpen = false
    ctx.ui.dialog.clear()
  }
  // Facade: dashboard.tsx was written against the v1 TuiPluginApi. Only the
  // calls it actually makes are mapped here; everything else is untouched.
  const facade = {
    theme: {
      get current() {
        return adaptThemeV2(ctx.theme)
      },
    },
    mode: {
      push: (name: string) => ctx.keymap.mode.push(name),
    },
    renderer: ctx.renderer,
    client: ctx.client,
    event: {
      on: (name: string, callback: () => void) => {
        if (name === "session.idle") return ctx.data.on("session.idle", callback)
        if (name === "session.status") {
          const unsubs = [
            ctx.data.on("session.execution.started", callback),
            ctx.data.on("session.execution.succeeded", callback),
          ]
          return () => void unsubs.forEach((un) => un())
        }
        if (name === "session.error") return ctx.data.on("session.execution.failed", callback)
        if (name === "session.compacted") return ctx.data.on("session.compaction.ended", callback)
        return ctx.data.on(name as (typeof REFRESH_EVENTS)[number], callback as () => void)
      },
    },
    ui: {
      dialog: {
        clear: closeDialog,
        get open() {
          return dialogOpen
        },
        replace: (render: () => unknown) => {
          dialogOpen = true
          ctx.ui.dialog.show(render as () => unknown as never)
        },
        setSize: (_size: string) => ctx.ui.dialog.set({ size: "xlarge" }),
      },
    },
    route: {
      get current() {
        const current = ctx.ui.router.current()
        return current.type === "session"
          ? { name: "session", params: { sessionID: current.sessionID } }
          : { name: current.type, params: {} }
      },
      navigate: (name: string, params?: Record<string, unknown>) => {
        if (name === "session") ctx.ui.router.navigate({ type: "session", sessionID: params?.sessionID as string })
      },
    },
  } as unknown as TuiPluginApi

  const open = () => {
    const previousFocus = (ctx.renderer as unknown as { currentFocusedRenderable?: { blur(): void } })
      .currentFocusedRenderable
    dialogOpen = true
    ctx.ui.dialog.show(() => <LoopDashboard api={facade} directory={directory} />, () => {
      dialogOpen = false
    })
    ctx.ui.dialog.set({ size: "xlarge" })
    previousFocus?.blur()
  }

  const openCommands = () => {
    const previousFocus = (ctx.renderer as unknown as { currentFocusedRenderable?: { blur(): void } })
      .currentFocusedRenderable
    dialogOpen = true
    ctx.ui.dialog.show(() => <CommandPanel api={facade} directory={directory} />, () => {
      dialogOpen = false
    })
    ctx.ui.dialog.set({ size: "xlarge" })
    previousFocus?.blur()
  }

  // NOTE: ctx.keymap.layer() must run inside a component — the host resolves
  // the layer against the ambient Keymap provider, so calling it in setup()
  // throws. Claim the always-mounted "app" slot with a null-render component
  // as the mount point (same pattern as telescope).
  const command = "opencode.loopd.dashboard"
  const commandsCommand = "opencode.loopd.commands"
  const commandsPanel = "opencode.loopd.commands"
  const unclaimCommandPanel = ctx.ui.slot({
    append: "session.panel",
    render: (input) => input.name === commandsPanel
      ? <CommandPanel
          api={facade}
          directory={directory}
          ownerSessionID={input.sessionID}
          onDetach={input.close}
        />
      : null,
  })
  let layerRegistered = false
  const unclaimSlot = ctx.ui.slot({
    append: "app",
    render: () => {
      if (!layerRegistered) {
        layerRegistered = true
        ctx.keymap.layer(() => ({
          commands: [
            {
              id: command,
              title: "Loop Dashboard",
              group: "Loop",
              palette: true,
              slash: { name: "loop" },
              bind: "<leader>o",
              run: open,
            },
            {
              id: commandsCommand,
              title: "Command Sessions",
              group: "Loop",
              palette: true,
              slash: { name: "commands" },
              run: () => {
                if (!ctx.ui.panel.open(commandsPanel, { presentation: "fullscreen" })) openCommands()
              },
            },
          ],
          bindings: [command],
        }))
      }
      return null
    },
  })

  return () => {
    closeDialog()
    ctx.ui.panel.close()
    unclaimCommandPanel()
    unclaimSlot()
  }
}

export default {
  id: PLUGIN_ID,
  tui,
  setup: v2setup,
} satisfies TuiPluginModule & { id: string; setup: typeof v2setup }
