// ─── TUI: Command Sessions Panel ─────────────────────────────────────────────
// Native host-owned overlay (xlarge dialog) for standalone command sessions.
// Output is a replayed byte stream; commands confirmed on the PTY backend
// render through a headless screen emulator (terminal-screen.ts, view only —
// the raw log stays the durable record), pipe-backend sessions keep the raw
// text view. Live updates via the command stream socket when available (2s
// polling stays as the fallback); keyboard input writes raw stdin; closing
// detaches, never terminates. Resize applies live on PTY (debounced),
// stored-only on pipes.
//
// TUI key/action vocabulary (mirrors interaction-registry tuiKeys):
// "commands" (open), "new", "open-cmd" (refresh), "write"/"input" (insert
// mode), "ctrl-c"/"interrupt" (SIGINT), "terminate", "remove", "resize"
// (via :resize cols rows), "q"/close (detach).

/** @jsxImportSource @opentui/solid */
import { createSignal, For, Show, onCleanup, onMount } from "solid-js"
import { useKeyboard } from "@opentui/solid"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { ParsedKey, InputRenderable } from "@opentui/core"
import { readState, readCommandLog } from "../infrastructure/state-repository"
import { createControlClient } from "../infrastructure/control-client"
import type { CommandSession } from "../domain/command-session"
import {
  emptyCommandPanelState,
  refreshCommandList,
  moveCommandSelection,
  selectCommandFirst,
  selectCommandLast,
  parseCommandLine,
  type CommandPanelState,
} from "./command-controller"
import { createCommandStreamClient } from "./command-stream-client"
import { resolveOpenTarget, TERMINAL_ROUTE_NAME, terminalRoutePayload, currentRouteSessionID } from "./terminal-route"
import {
  createCommandScreenFeed,
  createTerminalScreen,
  type CommandScreenFeed,
  type ScreenCell,
  type TerminalScreen,
} from "./terminal-screen"
import { isEnterKey, isEscapeKey } from "./dashboard"

interface Props {
  api: TuiPluginApi
  directory: string
  ownerSessionID?: string
  onDetach?: () => void
  /** Fullscreen open. Default: route-navigate + close popup (fallback: stay). */
  onOpenCommand?: (payload: { commandID: string; ownerSessionID: string; returnSessionID: string }) => void
}

function prevent(evt: ParsedKey) {
  const e = evt as ParsedKey & { preventDefault?: () => void; stopPropagation?: () => void }
  e.preventDefault?.()
  e.stopPropagation?.()
}

function routeOwnerSessionID(api: TuiPluginApi): string | undefined {
  return currentRouteSessionID(api)
}

// ─── Emulated screen rows (PTY view) ─────────────────────────────────────────
// One display row: runs coalesce consecutive same-style cells so a row renders
// as a handful of spans, not one span per column. Inverse is already resolved
// into fg/bg by terminal-screen; only fg/bg/bold/underline reach the renderer.
interface ScreenRun {
  text: string
  fg?: string
  bg?: string
  bold?: boolean
  underline?: boolean
}

interface ScreenRow {
  runs: ScreenRun[]
}

function sameStyle(a: ScreenCell, b: ScreenCell): boolean {
  return a.fg === b.fg && a.bg === b.bg && a.bold === b.bold && a.underline === b.underline
}

function buildScreenRows(cells: ScreenCell[], cols: number): ScreenRow[] {
  const rows: ScreenRow[] = []
  const rowCount = Math.floor(cells.length / cols)
  for (let y = 0; y < rowCount; y++) {
    const runs: ScreenRun[] = []
    let current: ScreenRun | undefined
    for (let x = 0; x < cols; x++) {
      const cell = cells[y * cols + x]
      if (!cell) continue
      const prev = x > 0 ? cells[y * cols + x - 1] : undefined
      if (current && prev && sameStyle(cell, prev)) {
        current.text += cell.text
      } else {
        current = { text: cell.text }
        if (cell.fg !== undefined) current.fg = cell.fg
        if (cell.bg !== undefined) current.bg = cell.bg
        if (cell.bold) current.bold = true
        if (cell.underline) current.underline = true
        runs.push(current)
      }
    }
    // Trailing blank cells carry no information — drop them so rows render
    // tight; a fully blank row keeps one space to preserve the line.
    while (runs.length > 1 && runs[runs.length - 1] && /^ *$/.test((runs[runs.length - 1] as ScreenRun).text)) runs.pop()
    const first = runs[0]
    if (runs.length === 1 && first && /^ *$/.test(first.text)) first.text = " "
    rows.push({ runs })
  }
  // Trailing blank rows carry no information either.
  while (rows.length > 1) {
    const last = rows[rows.length - 1]
    if (!last || !last.runs.every((r) => /^ *$/.test(r.text))) break
    rows.pop()
  }
  return rows
}

export function CommandPanel(props: Props) {
  const theme = () => props.api.theme.current
  const [state, setState] = createSignal<CommandPanelState>(emptyCommandPanelState())
  const [output, setOutput] = createSignal("")
  const [outputMeta, setOutputMeta] = createSignal({ startByte: 0, totalBytes: 0, live: false })
  const [insertMode, setInsertMode] = createSignal(false)
  const [inputValue, setInputValue] = createSignal("")
  const [statusText, setStatusText] = createSignal("commands: j/k move · o fullscreen · enter write-mode · ctrl-c interrupt · :terminate :remove :resize :await · q detach")
  let inputEl: InputRenderable | undefined
  const client = createControlClient(props.directory)
  const ownerSessionID = props.ownerSessionID ?? routeOwnerSessionID(props.api)

  // ─── Stream-primary output (poll fallback) ──────────────────────────────
  // The stream client owns live deltas when connected+subscribed; the 2s
  // pollers below stay as the fallback and are gated off while the stream is
  // live (same client drives both the v1 xlarge dialog and the v2 fullscreen
  // session.panel paths — this component is shared).
  const stream = createCommandStreamClient()
  let subscribedID: string | undefined
  let streamConnected = false
  let lastSlowListRefresh = 0
  const SLOW_LIST_REFRESH_MS = 30_000

  // ─── Terminal emulation view (PTY backend only) ──────────────────────────
  // One headless emulator for the selected command, fed from the same
  // snapshot/delta bytes as the raw view (never a second byte source).
  // PTY-vs-pipe is learned per command from the existing cmd_resize result
  // (ok = PTY winsize applied, unsupported = pipe fallback): the panel owns
  // no new capability channel, and protocol/broker/transport/service are
  // untouched. Until a command is confirmed PTY, it keeps today's raw view.
  const [screenRows, setScreenRows] = createSignal<ScreenRow[]>([])
  const [emulated, setEmulated] = createSignal(false)
  let screen: TerminalScreen | undefined
  let feed: CommandScreenFeed | undefined
  let feedForID: string | undefined
  const ptyKnown = new Map<string, boolean>()
  let screenDirty = false
  let screenFlushTimer: ReturnType<typeof setTimeout> | undefined
  let lastScreenFlushAt = 0
  const SCREEN_FLUSH_MIN_MS = 120
  let lastResizeAppliedAt = 0
  const RESIZE_DEBOUNCE_MS = 500
  let autoResizeTimer: ReturnType<typeof setTimeout> | undefined
  let pendingAutoResize: { cols: number; rows: number } | undefined

  function emuSizeFor(cmd: CommandSession): { cols: number; rows: number } {
    return { cols: cmd.cols ?? 80, rows: cmd.rows ?? 24 }
  }

  function ensureEmulatorFor(cmd: CommandSession): void {
    if (!screen || !feed) {
      const size = emuSizeFor(cmd)
      screen = createTerminalScreen(size.cols, size.rows)
      feed = createCommandScreenFeed(screen)
      feedForID = undefined
    }
    if (feedForID === cmd.id) return
    const size = emuSizeFor(cmd)
    screen.resize(size.cols, size.rows)
    feed.reset()
    feedForID = cmd.id
    setScreenRows([])
    screenDirty = false
    setEmulated(ptyKnown.get(cmd.id) === true)
  }

  function flushScreenRows(): void {
    lastScreenFlushAt = Date.now()
    if (!screenDirty) return
    screenDirty = false
    if (!screen || !feedForID) return
    const sel = state().selectedCommand
    if (!sel || sel.id !== feedForID) return
    if (ptyKnown.get(sel.id) !== true) return // raw view owns the paint
    try {
      setScreenRows(buildScreenRows(screen.readScreen(), screen.cols))
    } catch {
      // Best-effort view: a failed paint never breaks the panel.
    }
  }

  function markScreenDirty(): void {
    screenDirty = true
    if (screenFlushTimer) return // one trailing paint at a time — no per-chunk storms
    const wait = Math.max(0, SCREEN_FLUSH_MIN_MS - (Date.now() - lastScreenFlushAt))
    screenFlushTimer = setTimeout(() => {
      screenFlushTimer = undefined
      flushScreenRows()
    }, wait)
  }

  function feedSnapshotFor(id: string, data: string, startOffset: number, endOffset: number): void {
    if (!feed || feedForID !== id) return
    feed.applySnapshot(data, startOffset, endOffset)
    markScreenDirty()
  }

  function feedDeltaFor(id: string, data: string, startOffset: number, endOffset: number): void {
    if (!feed || feedForID !== id) return
    if (feed.applyDelta(data, startOffset, endOffset)) markScreenDirty()
  }

  /** Existing resize flow + backend learning: ok ⇒ PTY, unsupported ⇒ pipe. */
  async function doResizeAndLearn(cols: number, rows: number): Promise<void> {
    const id = selectedID()
    if (!id || !ownerSessionID) return
    lastResizeAppliedAt = Date.now()
    try {
      screen?.resize(cols, rows)
      const r = await client.executeRaw({
        command: "cmd_resize",
        goalID: id,
        args: { commandID: id, cols, rows, ownerSessionID },
      })
      ptyKnown.set(id, r.ok)
      if (selectedID() === id) {
        setEmulated(r.ok)
        if (r.ok) markScreenDirty() // same-size winsize can reflow the grid
        else setStatusText(r.message)
      }
      if (r.ok) await refresh()
    } catch (e) {
      setStatusText(`Error: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  /**
   * Push the panel's layout dimensions to the child so a PTY observes the real
   * winsize. Auto path (selection change): trailing — collapses bursts into
   * one send at the end of the debounce window, and doubles as the PTY probe
   * for commands whose backend is still unknown.
   */
  function scheduleAutoResize(cmd: CommandSession): void {
    // Probe + winsize sync for commands whose backend is still unknown: push
    // the panel's current dimensions (the emulator size, seeded from the
    // command's stored size) through the existing resize flow. Known backends
    // skip — future syncs belong to the explicit :resize path below.
    if (!ownerSessionID) return
    if (ptyKnown.has(cmd.id)) return
    pendingAutoResize = emuSizeFor(cmd)
    if (autoResizeTimer) return
    const wait = Math.max(0, RESIZE_DEBOUNCE_MS - (Date.now() - lastResizeAppliedAt))
    autoResizeTimer = setTimeout(() => {
      autoResizeTimer = undefined
      const p = pendingAutoResize
      pendingAutoResize = undefined
      if (!p) return
      if (selectedID() !== cmd.id) return // selection moved on; its own select schedules fresh
      void doResizeAndLearn(p.cols, p.rows)
    }, wait)
  }

  function selectChanged(): void {
    const sel = state().selectedCommand
    syncStreamSubscription()
    if (sel) {
      ensureEmulatorFor(sel)
      scheduleAutoResize(sel)
    }
    void refreshOutput()
  }

  function streamLiveForSelected(): boolean {
    const id = state().selectedCommand?.id
    return streamConnected && !!id && stream.isLive(id)
  }

  function applyCommandMetadata(cmd: CommandSession) {
    setState((prev) => {
      const idx = prev.commands.findIndex((c) => c.id === cmd.id)
      if (idx < 0) return prev
      const next = [...prev.commands]
      next[idx] = cmd
      return { ...prev, commands: next, selectedCommand: next[prev.selected] ?? null }
    })
  }

  function syncStreamSubscription() {
    const sel = state().selectedCommand
    if (!ownerSessionID || !sel) {
      if (subscribedID) {
        stream.unsubscribe(subscribedID)
        subscribedID = undefined
      }
      return
    }
    if (subscribedID === sel.id && stream.isLive(sel.id)) return
    if (subscribedID && subscribedID !== sel.id) stream.unsubscribe(subscribedID)
    subscribedID = sel.id
    stream.subscribe(sel.id, ownerSessionID, {
      onSnapshot: (snap) => {
        if (subscribedID !== sel.id) return
        ensureEmulatorFor(snap.command)
        setOutput(snap.data)
        setOutputMeta({ startByte: snap.startOffset, totalBytes: snap.endOffset, live: snap.command.status === "running" })
        // Snapshot AND resync share this path: reset + re-feed, never append.
        feedSnapshotFor(snap.command.id, snap.data, snap.startOffset, snap.endOffset)
        applyCommandMetadata(snap.command)
      },
      onDelta: (delta) => {
        if (subscribedID !== sel.id) return
        setOutput((prev) => prev + delta.data)
        setOutputMeta((prev) => ({ ...prev, totalBytes: delta.endOffset }))
        feedDeltaFor(delta.commandID, delta.data, delta.startOffset, delta.endOffset)
      },
      onStatus: (cmd) => {
        applyCommandMetadata(cmd)
      },
      onError: (message) => {
        setStatusText(message)
      },
      onConnection: (s) => {
        streamConnected = s === "connected"
        if (streamConnected) syncStreamSubscription()
      },
    })
    // Keep the locally tracked flag in sync for the synchronous path (the
    // onConnection callback above covers async transitions).
    streamConnected = stream.connectionState === "connected"
  }

  async function tryStreamConnect() {
    if (!ownerSessionID) return
    try {
      const r = await stream.connect(props.directory)
      streamConnected = stream.connectionState === "connected"
      if (r.ok) syncStreamSubscription()
      // "no-endpoint" is NORMAL (server starts lazily) — stay on polling;
      // the refresh tick below retries discovery on its existing cadence.
    } catch {
      // Connect failure → stay on polling, retry on the refresh tick.
    }
  }

  async function refresh() {
    try {
      // Stream-live: slow 30s metadata safety refresh for list-level changes
      // (new commands started elsewhere); output comes from live deltas.
      if (streamLiveForSelected()) {
        const now = Date.now()
        flushScreenRows() // reuse the existing cadence for coalesced paints
        if (now - lastSlowListRefresh < SLOW_LIST_REFRESH_MS) return
        lastSlowListRefresh = now
        const s = await readState(props.directory)
        const mine = (s.commands ?? []).filter((c) =>
          ownerSessionID ? c.ownerSessionID === ownerSessionID : false,
        )
        setState((prev) => refreshCommandList(prev, mine as CommandSession[]))
        syncStreamSubscription()
        return
      }
      const s = await readState(props.directory)
      const mine = (s.commands ?? []).filter((c) =>
        ownerSessionID ? c.ownerSessionID === ownerSessionID : false,
      )
      setState((prev) => refreshCommandList(prev, mine as CommandSession[]))
      syncStreamSubscription()
      // Disconnected: retry endpoint discovery on the existing refresh tick
      // (no new timer) so the stream resumes when the server appears.
      if (!streamConnected) void tryStreamConnect()
      await refreshOutput()
    } catch (e) {
      setStatusText(`Error: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  async function refreshOutput() {
    // Stream-live: deltas append immediately; the 2s output poller is
    // effectively stopped for the selected command (early return, no fetch).
    if (streamLiveForSelected()) return
    const sel = state().selectedCommand
    if (!sel) {
      setOutput("")
      return
    }
    try {
      // Bounded replay: last 32KB of the retained log (paging via outputOffset).
      const total = sel.outputBytes
      const window = 32 * 1024
      const startByte = Math.max(0, total - window)
      const log = await readCommandLog(props.directory, sel.id, { offsetBytes: startByte, limitBytes: window })
      if (state().selectedCommand?.id !== sel.id) return // selection moved on
      ensureEmulatorFor(sel)
      setOutput(log.text)
      setOutputMeta({ startByte: log.startByte, totalBytes: total, live: sel.status === "running" })
      // Poll fallback feeds as a snapshot: reset + re-feed (same path as a
      // stream resync). flushScreenRows below reuses this 2s cadence so the
      // emulated view paints without per-chunk setState storms.
      feedSnapshotFor(sel.id, log.text, log.startByte, total)
      flushScreenRows()
    } catch {
      setOutput("")
    }
  }

  async function sendRaw(command: string, args: Record<string, unknown>, commandID?: string) {
    if (!ownerSessionID) {
      setStatusText("No owning session (open from a session view) — mutations disabled.")
      return
    }
    setStatusText(`sending ${command}…`)
    try {
      const r = await client.executeRaw({ command, goalID: commandID, args: { ...args, ownerSessionID } })
      setStatusText(r.ok ? r.message : `Error: ${r.message}`)
      if (r.ok) await refresh()
    } catch (e) {
      setStatusText(`Error: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  function selectedID(): string | undefined {
    return state().selectedCommand?.id
  }

  // "open-cmd" refreshes the selected command's output snapshot.
  async function openCmd() {
    await refreshOutput()
    setStatusText("open-cmd: output snapshot refreshed (live while running).")
  }

  // "write"/"input": insert-mode typing goes to stdin as raw bytes.
  // Prefers the stream socket when connected+subscribed, else falls back to
  // the control bus. Never double-sends on both paths.
  async function writeInput(text: string) {
    const id = selectedID()
    if (!id) {
      setStatusText("No command selected.")
      return
    }
    const payload = text.endsWith("\n") ? text : `${text}\n`
    if (streamLiveForSelected() && stream.sendInput(id, payload).ok) return
    await sendRaw("cmd_write", { commandID: id, input: payload }, id)
  }

  // "ctrl-c"/"interrupt": SIGINT delivery, never a kill.
  async function interrupt() {
    const id = selectedID()
    if (!id) {
      setStatusText("No command selected.")
      return
    }
    if (streamLiveForSelected() && stream.sendInterrupt(id).ok) return
    await sendRaw("cmd_interrupt", { commandID: id }, id)
  }

  async function terminate() {
    const id = selectedID()
    if (!id) {
      setStatusText("No command selected.")
      return
    }
    await sendRaw("cmd_terminate", { commandID: id }, id)
  }

  async function remove() {
    const id = selectedID()
    if (!id) {
      setStatusText("No command selected.")
      return
    }
    await sendRaw("cmd_remove", { commandID: id }, id)
  }

  // "await": explicit opt-in wake — the goal wakes once when the selected
  // command exits (terminal-only, 4KB-bounded evidence). Defaults to the
  // selected command's linked goal; ":await <goalID>" overrides it.
  async function awaitExit(goalID?: string) {
    const sel = state().selectedCommand
    if (!sel) {
      setStatusText("No command selected.")
      return
    }
    const target = (goalID || sel.goalID || "").trim()
    if (!target) {
      setStatusText("Usage: :await <goalID> (selected command has no linked goal to default to).")
      return
    }
    await sendRaw("cmd_await", { commandID: sel.id, goalID: target }, sel.id)
  }

  async function resize(cols: number, rows: number) {
    const id = selectedID()
    if (!id) {
      setStatusText("No command selected.")
      return
    }
    // Debounce: ignore explicit resizes within 500ms of the last applied one
    // so a burst (or a held key) cannot storm the control bus / child winsize.
    if (Date.now() - lastResizeAppliedAt < RESIZE_DEBOUNCE_MS) {
      setStatusText("resize debounced — retry in a moment.")
      return
    }
    await doResizeAndLearn(cols, rows)
  }

  // "new": start a command — ":new <command> [args...]" typed in insert mode.
  async function startNew(raw: string) {
    const parts = parseCommandLine(raw)
    if (!parts) {
      setStatusText("Invalid command line: close quotes and trailing escapes.")
      return
    }
    if (parts.length === 0) {
      setStatusText("Usage: :new <command> [args...]")
      return
    }
    const [command, ...cmdArgs] = parts
    if (!ownerSessionID) {
      setStatusText("No owning session (open from a session view) — mutations disabled.")
      return
    }
    setStatusText(`sending cmd_start…`)
    try {
      const r = await client.executeRaw({
        command: "cmd_start",
        args: { title: command, command, cmdArgs, ownerSessionID },
      })
      setStatusText(r.ok ? r.message : `Error: ${r.message}`)
      if (r.ok) await refresh()
    } catch (e) {
      setStatusText(`Error: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  void openCmd
  void writeInput
  void interrupt
  void terminate
  void remove
  void resize
  void startNew
  void awaitExit

  async function executeColonCommand(raw: string) {
    const text = raw.startsWith(":") ? raw.slice(1) : raw
    const [verb, ...rest] = text.trim().split(/\s+/)
    switch (verb) {
      case "new":
        await startNew(rest.join(" "))
        break
      case "terminate":
        await terminate()
        break
      case "remove":
        await remove()
        break
      case "interrupt":
        await interrupt()
        break
      case "resize": {
        const cols = Number(rest[0])
        const rows = Number(rest[1])
        if (!Number.isInteger(cols) || !Number.isInteger(rows)) {
          setStatusText("Usage: :resize <cols> <rows> (stored only — unsupported by pipe host)")
          break
        }
        await resize(cols, rows)
        break
      }
      case "open-cmd":
        await openCmd()
        break
      case "await":
        await awaitExit(rest[0])
        break
      default:
        setStatusText(`Unknown :${verb}. Try :new, :terminate, :remove, :interrupt, :resize, :open-cmd, :await <goalID>`)
    }
  }

  function focusInput() {
    setTimeout(() => {
      const current = props.api.renderer.currentFocusedRenderable
      if (current && current !== inputEl) current.blur()
      inputEl?.focus()
    }, 10)
  }

  onMount(() => {
    void refresh()
    void tryStreamConnect()
    focusInput()
  })
  const pollers = [setInterval(refresh, 2000), setInterval(refreshOutput, 2000)]
  const unsubs = [
    props.api.event.on("session.idle", () => refresh()),
    props.api.event.on("session.status", () => refresh()),
  ]
  onCleanup(() => {
    for (const u of unsubs) if (typeof u === "function") (u as () => void)()
    for (const p of pollers) clearInterval(p)
    if (screenFlushTimer) clearTimeout(screenFlushTimer)
    if (autoResizeTimer) clearTimeout(autoResizeTimer)
    screenFlushTimer = undefined
    autoResizeTimer = undefined
    try {
      screen?.dispose()
    } catch {}
    screen = undefined
    feed = undefined
    feedForID = undefined
    // Detach semantics unchanged: unsubscribe locally, never terminate.
    if (subscribedID) stream.unsubscribe(subscribedID)
    subscribedID = undefined
    stream.dispose()
  })

  useKeyboard((evt: ParsedKey) => {
    const name = ((evt as unknown as { name?: string }).name || "").toLowerCase()
    const seq = ((evt as unknown as { sequence?: string }).sequence || "")
    const raw = ((evt as unknown as { raw?: string }).raw || "")
    const key = raw || seq || name
    const ctrlC = Boolean(evt.ctrl) && name === "c"

    if (insertMode()) {
      if (isEnterKey(evt)) {
        prevent(evt)
        const v = inputValue()
        if (v.startsWith(":")) void executeColonCommand(v)
        else void writeInput(v)
        setInputValue("")
        if (inputEl) inputEl.value = ""
        setInsertMode(false)
        return
      }
      if (isEscapeKey(evt)) {
        prevent(evt)
        setInsertMode(false)
        setInputValue("")
        if (inputEl) inputEl.value = ""
        return
      }
      return
    }

    // Normal mode. "ctrl-c" interrupts the selected command (SIGINT, not kill).
    if (ctrlC) {
      prevent(evt)
      void interrupt() // "ctrl-c" → "interrupt"
      return
    }
    if (key === ":") {
      prevent(evt)
      setInsertMode(true)
      focusInput()
      return
    }
    if (name === "down" || key === "j") {
      prevent(evt)
      setState((s) => moveCommandSelection(s, 1))
      selectChanged()
      return
    }
    if (name === "up" || key === "k") {
      prevent(evt)
      setState((s) => moveCommandSelection(s, -1))
      selectChanged()
      return
    }
    if (key === "g") {
      prevent(evt)
      setState(selectCommandFirst)
      selectChanged()
      return
    }
    if (key === "G") {
      prevent(evt)
      setState(selectCommandLast)
      selectChanged()
      return
    }
    // "o": fullscreen terminal page for the selected command. Closes the
    // popup and navigates to the plugin-owned route (detach-safe: the
    // command keeps running). Goal selections never reach this path.
    if (key === "o") {
      prevent(evt)
      const selCmd = state().selectedCommand
      const returnSessionID = routeOwnerSessionID(props.api)
      const target = resolveOpenTarget({
        selection: selCmd ? { kind: "command", commandID: selCmd.id } : null,
        ownerSessionID,
        returnSessionID,
      })
      if (target.kind === "none") {
        setStatusText(
          target.reason === "no-command"
            ? "No command selected."
            : target.reason === "owner-required"
              ? "No owning session (open from a session view) — open disabled."
              : "No return session — open disabled.",
        )
        return
      }
      if (target.kind !== "command") return
      if (props.onOpenCommand) {
        props.onOpenCommand(target.data)
        return
      }
      try {
        ;(props.api.route as unknown as { navigate(name: string, params?: Record<string, unknown>): void }).navigate(
          TERMINAL_ROUTE_NAME,
          terminalRoutePayload(target.data.commandID, target.data.ownerSessionID, target.data.returnSessionID),
        )
        if (props.onDetach) props.onDetach()
        else props.api.ui.dialog.clear()
      } catch {
        setStatusText("Fullscreen route unavailable on this host — staying in the monitor.")
      }
      return
    }
    // Detach: "q"/close only clears the view — the command keeps running.
    if (key === "q") {
      prevent(evt)
      if (props.onDetach) props.onDetach()
      else props.api.ui.dialog.clear() // detach, never terminate
      return
    }
  })

  const sel = () => state().selectedCommand

  return (
    <box flexDirection="column" width="100%" alignItems="center" padding={1}>
      <box flexDirection="column" width="90%" border={true} borderColor={theme().border} padding={1}>
        <box flexDirection="row" justifyContent="space-between" flexShrink={0}>
          <text>
            <span style={{ fg: theme().primary, bold: true }}>⬢ Command Sessions</span>
            <span style={{ fg: theme().textMuted }}>{emulated() ? " │ terminal screen (emulated view · raw log is the record)" : " │ byte-stream output (raw text)"}</span>
          </text>
          <text>
            <span style={{ fg: theme().textMuted }}>{state().commands.length} owned</span>
          </text>
        </box>

        <Show
          when={state().commands.length > 0}
          fallback={
            <box padding={1}>
              <text>
                <span style={{ fg: theme().textMuted }}>
                  {ownerSessionID ? "No command sessions. :new <command> [args...] to start one." : "Open this panel from a session view — owner scoping needs a session."}
                </span>
              </text>
            </box>
          }
        >
          <box flexDirection="column" flexShrink={1} minHeight={0} overflow="hidden">
            <For each={state().commands}>
              {(cmd, i) => (
                <box paddingLeft={1} paddingRight={1} backgroundColor={i() === state().selected ? theme().backgroundElement : undefined}>
                  <text wrapMode="none" truncate={true}>
                    <span style={{ fg: cmd.status === "running" ? theme().success : theme().textMuted, bold: i() === state().selected }}>
                      {i() === state().selected ? "▶ " : "  "}{cmd.title}
                    </span>
                    <span style={{ fg: theme().textMuted }}> │ {[cmd.command, ...cmd.args].join(" ").slice(0, 60)} │ {cmd.status}{cmd.exitCode !== undefined ? ` (${cmd.exitCode})` : ""}</span>
                  </text>
                </box>
              )}
            </For>
          </box>
        </Show>

        <Show when={sel()}>
          {(cmd) => (
            <box flexDirection="column" border={true} borderColor={theme().border} padding={1} flexShrink={0} maxHeight={16} overflow="hidden">
              <text>
                <span style={{ fg: theme().primary, bold: true }}>{cmd().title}</span>
                <span style={{ fg: theme().textMuted }}> │ {[cmd().command, ...cmd().args].join(" ")} │ {cmd().status} │ {outputMeta().totalBytes} bytes{outputMeta().live ? " · live" : ""}{cmd().truncated ? " · truncated" : ""}{emulated() && screen && feedForID === cmd().id ? ` · ${screen.cols}x${screen.rows} screen${screen.activeBuffer === "alternate" ? " · alt-screen" : ""}` : ""}</span>
              </text>
              <Show
                when={emulated() && screenRows().length > 0}
                fallback={
                  <text>
                    <span style={{ fg: theme().text }}>{output().slice(-4000) || "(no output yet)"}</span>
                  </text>
                }
              >
                <For each={screenRows()}>
                  {(row) => (
                    <text wrapMode="none" truncate={true}>
                      <For each={row.runs}>
                        {(run) => (
                          <span
                            style={{
                              fg: run.fg ?? theme().text,
                              bg: run.bg,
                              bold: run.bold,
                              underline: run.underline,
                            }}
                          >
                            {run.text}
                          </span>
                        )}
                      </For>
                    </text>
                  )}
                </For>
              </Show>
            </box>
          )}
        </Show>

        <box flexDirection="row" border={true} borderColor={insertMode() ? theme().warning : theme().border} paddingLeft={1} paddingRight={1} flexShrink={0} height={3} gap={1}>
          <text>
            <span style={{ fg: insertMode() ? theme().warning : theme().success, bold: true }}>{insertMode() ? " INPUT " : " NORMAL "}</span>
          </text>
          <input
            ref={(el: InputRenderable) => {
              inputEl = el
            }}
            flexGrow={1}
            placeholder={insertMode() ? "type stdin, Enter sends (:new/:terminate/:remove/:interrupt/:resize/:open-cmd/:await)" : (statusText() || "Press : to type, q to detach")}
            placeholderColor={theme().textMuted}
            cursorColor={theme().primary}
            focusedTextColor={theme().text}
            focusedBackgroundColor={theme().background}
            onInput={(v: string) => {
              if (insertMode()) setInputValue(v)
              else if (inputEl?.value) inputEl.value = ""
            }}
          />
        </box>
      </box>
    </box>
  )
}
