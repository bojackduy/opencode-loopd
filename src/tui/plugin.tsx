// ─── TUI Plugin Entry ────────────────────────────────────────────────────────
// Modal dashboard for the loop engine. Neovim-style, command-driven.

/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi, TuiPluginModule, TuiThemeCurrent } from "@opencode-ai/plugin/tui"
import type { Plugin as TuiV2 } from "@opencode/plugin/tui"
import { LoopDashboard } from "./dashboard"
import { CommandPanel } from "./command-panel"
import { TerminalView } from "./terminal-view"
import { TERMINAL_ROUTE_NAME, currentRouteSessionID, terminalRoutePayload } from "./terminal-route"
import { nativeRpcDefinition } from "../v2/native-rpc"
import { subscribeNativeRequests, type NativeRpcClient } from "../v2/native-tui"

const PLUGIN_ID = "opencode-loopd.tui"

/**
 * Open the plugin-owned fullscreen terminal page for a command. Returns true
 * when the host accepted route navigation; false when the host truly lacks
 * route support (caller renders the CommandPanel compatibility fallback).
 */
export function navigateToTerminalV1(
  api: Pick<TuiPluginApi, "route" | "ui">,
  commandID: string,
  ownerSessionID: string,
  returnSessionID: string,
): boolean {
  const payload = terminalRoutePayload(commandID, ownerSessionID, returnSessionID)
  try {
    api.route.navigate(TERMINAL_ROUTE_NAME, payload)
    api.ui.dialog.clear()
    return true
  } catch {
    return false
  }
}

const tui: TuiPlugin = async (api) => {
  const directory = api.state.path.directory

  // Full-screen terminal route (custom OpenCode page — not a dialog, panel,
  // or chat session). Hosts that truly lack route support get the CommandPanel
  // compatibility fallback instead.
  let terminalRouteAvailable = false
  let unregisterTerminalRoute: (() => void) | undefined
  try {
    unregisterTerminalRoute = api.route.register([
      {
        name: TERMINAL_ROUTE_NAME,
        render: ({ params }) => <TerminalView api={api} directory={directory} data={params} />,
      },
    ])
    terminalRouteAvailable = true
  } catch {
    terminalRouteAvailable = false
  }

  const openTerminal = (commandID: string, ownerSessionID: string, returnSessionID: string) => {
    if (terminalRouteAvailable && navigateToTerminalV1(api, commandID, ownerSessionID, returnSessionID)) return
    // Compatibility fallback: clipped monitor dialog (route-less hosts only).
    const previousFocus = api.renderer.currentFocusedRenderable
    api.ui.dialog.replace(() => (
      <CommandPanel
        api={api}
        directory={directory}
        ownerSessionID={ownerSessionID}
        onOpenCommand={(payload) => openTerminal(payload.commandID, payload.ownerSessionID, payload.returnSessionID)}
      />
    ))
    api.ui.dialog.setSize("xlarge")
    previousFocus?.blur()
  }

  const open = () => {
    const previousFocus = api.renderer.currentFocusedRenderable
    api.ui.dialog.replace(() => <LoopDashboard api={api} directory={directory} />)
    api.ui.dialog.setSize("xlarge")
    previousFocus?.blur()
  }

  const openCommands = () => {
    // Same shared dashboard as /loop, focused on Commands — never the
    // separate clipped terminal monitor.
    const previousFocus = api.renderer.currentFocusedRenderable
    api.ui.dialog.replace(() => (
      <LoopDashboard
        api={api}
        directory={directory}
        initialView="commands"
        ownerSessionID={currentRouteSessionID(api)}
        onOpenCommand={(payload) => openTerminal(payload.commandID, payload.ownerSessionID, payload.returnSessionID)}
      />
    ))
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

  api.lifecycle.onDispose(() => {
    try {
      unregisterTerminalRoute?.()
    } catch {}
  })
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

/**
 * v2 navigation to the fullscreen terminal page.
 * Returns true when the host accepted it, false for route-less hosts.
 */
export function navigateToTerminalV2(
  router: { navigate(destination: unknown): void },
  commandID: string,
  ownerSessionID: string,
  returnSessionID: string,
): boolean {
  try {
    router.navigate({
      type: "plugin",
      name: TERMINAL_ROUTE_NAME,
      data: terminalRoutePayload(commandID, ownerSessionID, returnSessionID),
    })
    return true
  } catch {
    return false
  }
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

  // Native-worker bridge (v2 only): subscribe to the server's
  // workerCreateRequested events and fork real children via the full client.
  // Unsupported hosts (no client.rpc) simply never claim; the server takes
  // its flagged root fallback. Never touches command/PTY state.
  const claimantID = `tui-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`
  let unsubscribeNative: (() => void) | undefined
  try {
    const rpcClient = (ctx.client as unknown as {
      rpc: (definition: unknown) => NativeRpcClient
    }).rpc(nativeRpcDefinition) as NativeRpcClient
    unsubscribeNative = subscribeNativeRequests(rpcClient, {
      client: {
        session: {
          fork: (input) => ctx.client.session.fork(input),
          switchAgent: (input) => ctx.client.session.switchAgent(input),
          switchModel: (input) => ctx.client.session.switchModel(input),
          update: (input) => ctx.client.session.update(input),
        },
      },
      data: {
        session: {
          get: (sessionID) => {
            const session = ctx.data.session.get(sessionID)
            return session ? { id: session.id } : undefined
          },
          message: {
            list: (sessionID) =>
              ctx.data.session.message.list(sessionID).map((message) => ({ id: (message as { id: string }).id })),
          },
        },
      },
      claimantID,
      onOutcome: (outcome, requestID) => {
        try {
          const { appendFileSync } = require("node:fs") as typeof import("node:fs")
          appendFileSync(
            "/tmp/loopd-tui.log",
            `[${new Date().toISOString()}] native-worker request=${requestID} outcome=${JSON.stringify(outcome)}\n`,
          )
        } catch {}
      },
      isKnownParent: (parentSessionID) => {
        const parent = ctx.data.session.get(parentSessionID) as
          | { location?: { directory?: string } }
          | undefined
        if (!parent) return false
        const parentDirectory = parent.location?.directory
        if (!parentDirectory) return true
        return parentDirectory === directory
      },
    })
  } catch {
    unsubscribeNative = undefined
  }

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

  // Full-screen terminal route (custom OpenCode page — not a dialog, panel,
  // or chat session). Route-less hosts fall back to the CommandPanel monitor.
  let terminalRouteAvailable = false
  let unregisterTerminalRoute: (() => void) | undefined
  try {
    unregisterTerminalRoute = ctx.ui.router.register({
      name: TERMINAL_ROUTE_NAME,
      render: ({ data }) => <TerminalView api={facade} directory={directory} data={data} />,
    })
    terminalRouteAvailable = true
  } catch {
    terminalRouteAvailable = false
  }

  const openTerminal = (commandID: string, ownerSessionID: string, returnSessionID: string): boolean => {
    if (!terminalRouteAvailable) return false
    const ok = navigateToTerminalV2(ctx.ui.router, commandID, ownerSessionID, returnSessionID)
    if (ok) {
      try {
        ctx.ui.panel.close()
      } catch {}
      closeDialog()
    }
    return ok
  }

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
    // Same shared dashboard as /loop, focused on Commands.
    const previousFocus = (ctx.renderer as unknown as { currentFocusedRenderable?: { blur(): void } })
      .currentFocusedRenderable
    dialogOpen = true
    ctx.ui.dialog.show(() => (
      <LoopDashboard
        api={facade}
        directory={directory}
        initialView="commands"
        ownerSessionID={undefined}
        onOpenCommand={(payload) => {
          openTerminal(payload.commandID, payload.ownerSessionID, payload.returnSessionID)
        }}
      />
    ), () => {
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
    // The shared dashboard focused on Commands (same component as /loop).
    // Fullscreen presentation from the host; `o` navigates to the terminal
    // route. CommandPanel remains only as the route-less compat fallback.
    render: (input) => input.name === commandsPanel
      ? <LoopDashboard
          api={facade}
          directory={directory}
          initialView="commands"
          ownerSessionID={input.sessionID}
          onOpenCommand={(payload) => {
            openTerminal(payload.commandID, payload.ownerSessionID, payload.returnSessionID)
          }}
          isActive={() => input.focused !== false}
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
    try {
      unsubscribeNative?.()
    } catch {}
    try {
      unregisterTerminalRoute?.()
    } catch {}
    unclaimCommandPanel()
    unclaimSlot()
  }
}

export default {
  id: PLUGIN_ID,
  tui,
  setup: v2setup,
} satisfies TuiPluginModule & { id: string; setup: typeof v2setup }
