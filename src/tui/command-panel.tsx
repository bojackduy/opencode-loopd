// ─── TUI: Command Sessions Panel ─────────────────────────────────────────────
// Native host-owned overlay (xlarge dialog) for standalone command sessions.
// Honest bounded slice: output is a replayed byte stream (plain text), NOT
// full terminal emulation — labeled as such in the UI. Live updates via the
// command stream socket when available (2s polling stays as the fallback);
// keyboard input writes raw stdin; closing detaches, never
// terminates. Resize is stored-only (pipe host has no tty winsize).
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
import { isEnterKey, isEscapeKey } from "./dashboard"

interface Props {
  api: TuiPluginApi
  directory: string
  ownerSessionID?: string
  onDetach?: () => void
}

function prevent(evt: ParsedKey) {
  const e = evt as ParsedKey & { preventDefault?: () => void; stopPropagation?: () => void }
  e.preventDefault?.()
  e.stopPropagation?.()
}

function routeOwnerSessionID(api: TuiPluginApi): string | undefined {  try {
    const current = (api as unknown as { route?: { current?: { name?: string; params?: { sessionID?: string } } } }).route?.current
    if (current?.name === "session" && current.params?.sessionID) return current.params.sessionID
  } catch {}
  return undefined
}

export function CommandPanel(props: Props) {
  const theme = () => props.api.theme.current
  const [state, setState] = createSignal<CommandPanelState>(emptyCommandPanelState())
  const [output, setOutput] = createSignal("")
  const [outputMeta, setOutputMeta] = createSignal({ startByte: 0, totalBytes: 0, live: false })
  const [insertMode, setInsertMode] = createSignal(false)
  const [inputValue, setInputValue] = createSignal("")
  const [statusText, setStatusText] = createSignal("commands: j/k move · enter write-mode · ctrl-c interrupt · :terminate :remove :resize · q detach")
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
        setOutput(snap.data)
        setOutputMeta({ startByte: snap.startOffset, totalBytes: snap.endOffset, live: snap.command.status === "running" })
        applyCommandMetadata(snap.command)
      },
      onDelta: (delta) => {
        if (subscribedID !== sel.id) return
        setOutput((prev) => prev + delta.data)
        setOutputMeta((prev) => ({ ...prev, totalBytes: delta.endOffset }))
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
      setOutput(log.text)
      setOutputMeta({ startByte: log.startByte, totalBytes: total, live: sel.status === "running" })
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

  async function resize(cols: number, rows: number) {
    const id = selectedID()
    if (!id) {
      setStatusText("No command selected.")
      return
    }
    await sendRaw("cmd_resize", { commandID: id, cols, rows }, id)
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
      default:
        setStatusText(`Unknown :${verb}. Try :new, :terminate, :remove, :interrupt, :resize, :open-cmd`)
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
      syncStreamSubscription()
      void refreshOutput()
      return
    }
    if (name === "up" || key === "k") {
      prevent(evt)
      setState((s) => moveCommandSelection(s, -1))
      syncStreamSubscription()
      void refreshOutput()
      return
    }
    if (key === "g") {
      prevent(evt)
      setState(selectCommandFirst)
      syncStreamSubscription()
      void refreshOutput()
      return
    }
    if (key === "G") {
      prevent(evt)
      setState(selectCommandLast)
      syncStreamSubscription()
      void refreshOutput()
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
            <span style={{ fg: theme().textMuted }}> │ byte-stream output (not a terminal emulator)</span>
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
                <span style={{ fg: theme().textMuted }}> │ {[cmd().command, ...cmd().args].join(" ")} │ {cmd().status} │ {outputMeta().totalBytes} bytes{outputMeta().live ? " · live" : ""}{cmd().truncated ? " · truncated" : ""}</span>
                {"\n"}
                <span style={{ fg: theme().text }}>{output().slice(-4000) || "(no output yet)"}</span>
              </text>
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
            placeholder={insertMode() ? "type stdin, Enter sends (:new/:terminate/:remove/:interrupt/:resize/:open-cmd)" : (statusText() || "Press : to type, q to detach")}
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
