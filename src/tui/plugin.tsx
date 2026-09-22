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
export function adaptThemeV2(theme: TuiV2.Context["theme"]): TuiThemeCurrent {
  // The live theme object may omit nested groups (custom/minimal themes),
  // and this getter runs inside render — a throw here crashes the whole TUI.
  // Keep the former field names as fallbacks for pre-release v2 themes.
  const t = (theme ?? {}) as any
  const text = t.text ?? {}
  const fb = text.feedback ?? {}
  const bg = t.background ?? {}
  const raised = bg.raised ?? bg.surface ?? {}
  const diff = t.diff ?? {}
  const diffText = diff.text ?? {}
  const diffBg = diff.background ?? {}
  const diffHi = diff.highlight ?? {}
  const diffLn = diff.lineNumber ?? {}
  const syntax = t.syntax ?? {}
  const md = t.markdown ?? {}
  const pick = (...values: unknown[]) => values.find((value) => value !== undefined && value !== null)
  const base = pick(text.base, text.default, "#ffffff")
  const muted = pick(text.muted, text.subdued, "#888888")
  const primary = pick(t.hue?.interactive?.[200], text.formfield?.focused, text.action?.primary?.selected, base)
  const accent = pick(t.hue?.accent?.[200], text.action?.primary?.focused, primary)
  const background = pick(bg.base, bg.default, "#000000")
  return {
    text: base,
    textMuted: muted,
    primary,
    secondary: pick(t.hue?.accent?.[300], accent),
    accent,
    success: pick(fb.success?.base, fb.success?.default, "#22c55e"),
    warning: pick(fb.warning?.base, fb.warning?.default, "#eab308"),
    error: pick(fb.error?.base, fb.error?.default, "#ef4444"),
    info: pick(fb.info?.base, fb.info?.default, accent),
    selectedListItemText: pick(text.action?.primary?.focused, base),
    background,
    backgroundPanel: pick(raised.base, raised.overlay, background),
    backgroundElement: pick(raised.high, raised.offset, background),
    backgroundMenu: pick(raised.max, raised.high, background),
    border: pick(t.border?.base, muted),
    borderActive: pick(t.scrollbar?.base, primary),
    borderSubtle: pick(t.border?.base, muted),
    diffAdded: pick(diffText.added, base),
    diffRemoved: pick(diffText.removed, base),
    diffContext: pick(diffText.context, muted),
    diffHunkHeader: pick(diffText.hunkHeader, accent),
    diffAddedBg: pick(diffBg.added, background),
    diffRemovedBg: pick(diffBg.removed, background),
    diffContextBg: pick(diffBg.context, background),
    diffHighlightAdded: pick(diffHi.added, base),
    diffHighlightRemoved: pick(diffHi.removed, base),
    diffLineNumber: pick(diffLn.text, muted),
    diffAddedLineNumberBg: pick(diffLn.background?.added, background),
    diffRemovedLineNumberBg: pick(diffLn.background?.removed, background),
    syntaxComment: pick(syntax.comment, muted),
    syntaxKeyword: pick(syntax.keyword, base),
    syntaxFunction: pick(syntax.function, base),
    syntaxVariable: pick(syntax.variable, base),
    syntaxString: pick(syntax.string, base),
    syntaxNumber: pick(syntax.number, base),
    syntaxType: pick(syntax.type, base),
    syntaxOperator: pick(syntax.operator, base),
    syntaxPunctuation: pick(syntax.punctuation, muted),
    markdownText: pick(md.text, base),
    markdownHeading: pick(md.heading, primary),
    markdownLink: pick(md.link, accent),
    markdownLinkText: pick(md.linkText, accent),
    markdownCode: pick(md.code, base),
    markdownBlockQuote: pick(md.blockQuote, muted),
    markdownEmph: pick(md.emphasis, base),
    markdownStrong: pick(md.strong, base),
    markdownHorizontalRule: pick(md.horizontalRule, muted),
    markdownListItem: pick(md.listItem, accent),
    markdownListEnumeration: pick(md.listEnumeration, accent),
    markdownImage: pick(md.image, accent),
    markdownImageText: pick(md.imageText, base),
    markdownCodeBlock: pick(md.codeBlock, base),
    thinkingOpacity: 0.6,
    _hasSelectedListItemText: true,
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
