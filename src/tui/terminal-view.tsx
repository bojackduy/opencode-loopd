// ─── TUI: Full-screen TerminalView ─────────────────────────────────────────────
// Plugin-owned full-screen terminal page for ONE command session (route
// `opencode.loopd.terminal`). Header = compact command metadata + connection
// status; viewport flexes to all remaining space (NO maxHeight constraint);
// footer = controls + dimensions.
//
// Raw input is immediate (useKeyboard → encodeTerminalKey → writeInput, never
// a line-submit InputRenderable). Ctrl+C reaches the PTY as interrupt input
// (prevented from closing OpenCode); Ctrl+] is the reserved LOCAL detach
// chord (back to returnSessionID, never terminate). Paste forwards raw bytes
// immediately via usePaste. Unmount disposes stream/keyboard/paste/resize/
// timer/socket resources and the emulator, but NEVER terminates the command.

/** @jsxImportSource @opentui/solid */
import { createSignal, For, Show, onCleanup, onMount } from "solid-js"
import { useKeyboard, usePaste } from "@opentui/solid"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { ParsedKey, Renderable } from "@opentui/core"
import {
  createTerminalSession,
  computeViewportSize,
  TERMINAL_FALLBACK_COLS,
  TERMINAL_FALLBACK_ROWS,
  type TerminalSession,
  type TerminalSessionOptions,
  type TerminalSessionSnapshot,
} from "./terminal-session"
import { encodeTerminalKey, isDetachChord, isInterruptChord, type TerminalKeyEvent } from "./terminal-keys"
import type { ScreenCell } from "./terminal-screen"

/** Namespaced input mode pushed while the fullscreen terminal is mounted. */
export const TERMINAL_INPUT_MODE = "loopd.terminal"

interface Props {
  api: TuiPluginApi
  directory: string
  /** Raw route data (v1 params or v2 data). Validated fail-closed. */
  data: unknown
  /** Detach navigation. Default: back to the return session. */
  onDetach?: () => void
  /** Test seam: inject a fake session driver. */
  createSession?: (options: TerminalSessionOptions) => TerminalSession
}

function prevent(evt: ParsedKey) {
  const e = evt as ParsedKey & { preventDefault?: () => void; stopPropagation?: () => void }
  e.preventDefault?.()
  e.stopPropagation?.()
}

function toKeyEvent(evt: ParsedKey): TerminalKeyEvent {
  const e = evt as unknown as {
    name?: string
    sequence?: string
    raw?: string
    text?: string
    ctrl?: boolean
    meta?: boolean
    option?: boolean
    shift?: boolean
    source?: string
    eventType?: string
  }
  return {
    name: e.name,
    text: e.text,
    sequence: e.sequence ?? e.raw,
    ctrl: e.ctrl,
    // OpenTUI alt arrives as meta/option depending on platform.
    alt: (evt as unknown as { alt?: boolean }).alt,
    meta: e.meta,
    option: e.option,
    shift: e.shift,
    source: e.source,
    release: e.eventType === "release",
    repeated: (evt as unknown as { repeated?: boolean }).repeated,
  }
}

interface ScreenRun {
  text: string
  fg?: string
  bg?: string
  bold?: boolean
  underline?: boolean
  cursor?: boolean
  /**
   * Raw inverse attribute from the cell. fg/bg above are already
   * inverse-swapped by readScreen; this flag lets the renderer resolve the
   * remaining default side (undefined fg or bg) against the live theme —
   * otherwise a default-color inverse would render invisibly.
   */
  inverse?: boolean
}

function sameStyle(a: ScreenCell, b: ScreenCell): boolean {
  return (
    a.fg === b.fg &&
    a.bg === b.bg &&
    a.bold === b.bold &&
    a.underline === b.underline &&
    (a.inverse ?? false) === (b.inverse ?? false)
  )
}

/** A trailing blank run is droppable only when it carries no styling. */
function isDroppableBlank(run: ScreenRun): boolean {
  if (!/^ *$/.test(run.text)) return false
  return run.fg === undefined && run.bg === undefined && !run.bold && !run.underline && !run.inverse && !run.cursor
}

/** Every viewport row is rendered (blank rows preserved as a space). */
export function buildTerminalRows(
  cells: ScreenCell[],
  cols: number,
  rows: number,
  cursor: { x: number; y: number; visible: boolean },
): ScreenRun[][] {
  const out: ScreenRun[][] = []
  for (let y = 0; y < rows; y++) {
    const runs: ScreenRun[] = []
    let current: ScreenRun | undefined
    let prev: ScreenCell | undefined
    let prevIsCursor = false
    for (let x = 0; x < cols; x++) {
      const cell = cells[y * cols + x]
      if (!cell) continue
      // Width-0 continuation after a wide glyph (CJK/emoji): the lead
      // character already renders double-wide, so the continuation carries
      // no text of its own. Emitting it as a literal space would consume an
      // extra column and misalign everything after it.
      if (cell.width === 0) continue
      const isCursor = cursor.visible && cursor.y === y && cursor.x === x
      if (current && prev && sameStyle(cell, prev) && isCursor === prevIsCursor) {
        current.text += cell.text
      } else {
        current = { text: cell.text }
        if (cell.fg !== undefined) current.fg = cell.fg
        if (cell.bg !== undefined) current.bg = cell.bg
        if (cell.bold) current.bold = true
        if (cell.underline) current.underline = true
        if (cell.inverse) current.inverse = true
        if (isCursor) current.cursor = true
        runs.push(current)
      }
      prev = cell
      prevIsCursor = isCursor
    }
    // Preserve blank rows/background spaces: only an UNSTYLED trailing blank
    // run collapses (a styled blank — e.g. a non-default background — is
    // visible output and must be kept). The row always keeps ≥1 run.
    while (runs.length > 1 && runs[runs.length - 1] && isDroppableBlank(runs[runs.length - 1] as ScreenRun)) runs.pop()
    const first = runs[0]
    if (runs.length === 0) runs.push({ text: " " })
    else if (runs.length === 1 && first && isDroppableBlank(first)) first.text = " "
    out.push(runs)
  }
  return out
}

export function TerminalView(props: Props) {
  const theme = () => props.api.theme.current
  const makeSession = props.createSession ?? createTerminalSession
  const [view, setView] = createSignal<TerminalSessionSnapshot | null>(null)
  let viewportEl: Renderable | undefined
  let measureTimer: ReturnType<typeof setInterval> | undefined
  // The terminal owns full-screen raw input while mounted: claim a
  // namespaced mode on mount (facade-compatible api.mode.push) and release
  // exactly it on cleanup — mirroring the dashboard's loopd.dashboard mode.
  let popTerminalMode: (() => void) | undefined

  const session = makeSession({
    directory: props.directory,
    routeData: props.data,
    onSnapshot: (snap) => setView({ ...snap }),
    onDetach: () => {
      if (props.onDetach) {
        props.onDetach()
        return
      }
      const ret = session.data?.returnSessionID
      if (ret) {
        try {
          props.api.route.navigate("session", { sessionID: ret })
        } catch {}
      }
    },
  })

  function measureViewport(): void {
    try {
      const w = (viewportEl as unknown as { width?: number })?.width
      const h = (viewportEl as unknown as { height?: number })?.height
      if (typeof w !== "number" || typeof h !== "number") return
      // The viewport box itself is measured: no chrome subtraction.
      const size = computeViewportSize(w, h, 0)
      if (size) session.requestViewportSize(size.cols, size.rows)
    } catch {}
  }

  onMount(() => {
    try {
      const push = (props.api as unknown as { mode?: { push(name: string): () => void } }).mode?.push
      if (typeof push === "function") {
        popTerminalMode = push.call((props.api as unknown as { mode?: unknown }).mode, TERMINAL_INPUT_MODE)
      }
    } catch {}
    void session.start()
    // Initial measure after layout, then onSizeChange + 1s backstop.
    setTimeout(measureViewport, 50)
    measureTimer = setInterval(measureViewport, 1000)
  })

  onCleanup(() => {
    if (measureTimer) clearInterval(measureTimer)
    measureTimer = undefined
    viewportEl = undefined
    try {
      popTerminalMode?.()
    } catch {}
    popTerminalMode = undefined
    // Dispose only: unsubscribe + free resources. NEVER terminate.
    session.dispose()
  })

  useKeyboard((evt: ParsedKey) => {
    if (isDetachChord(toKeyEvent(evt))) {
      prevent(evt)
      session.detach()
      return
    }
    if (isInterruptChord(toKeyEvent(evt))) {
      // Ctrl+C is interrupt INPUT to the PTY — prevent it from closing OpenCode.
      prevent(evt)
      session.interrupt()
      return
    }
    const bytes = encodeTerminalKey(toKeyEvent(evt))
    if (bytes !== undefined) {
      prevent(evt)
      session.writeInput(bytes)
    }
  })

  usePaste((event) => {
    try {
      const text = Buffer.from(event.bytes).toString("utf8")
      if (text) session.paste(text)
    } catch {}
  })

  const cmd = () => view()?.command
  const dims = () => {
    const v = view()
    if (!v) return `${TERMINAL_FALLBACK_COLS}x${TERMINAL_FALLBACK_ROWS}`
    return `${v.cols}x${v.viewportRows}`
  }

  return (
    <box flexDirection="column" width="100%" height="100%" padding={1}>
      {/* Header — compact command metadata + connection status */}
      <box flexDirection="row" justifyContent="space-between" flexShrink={0}>
        <text>
          <span style={{ fg: theme().primary, bold: true }}>⬢ {cmd()?.title ?? "Terminal"}</span>
          <Show when={cmd()}>
            <span style={{ fg: theme().textMuted }}> │ {[cmd()!.command, ...cmd()!.args].join(" ")} │ {cmd()!.status}{cmd()!.exitCode !== undefined ? ` (${cmd()!.exitCode})` : ""}</span>
          </Show>
          <span style={{ fg: theme().textMuted }}> │ </span>
          <span style={{ fg: view()?.connection === "stream" ? theme().success : view()?.connection === "polling" ? theme().warning : theme().error }}>
            {view()?.connectionDetail ?? "connecting…"}
          </span>
          <Show when={(view()?.activeBuffer ?? "normal") === "alternate"}>
            <span style={{ fg: theme().accent }}> │ alt-screen</span>
          </Show>
        </text>
        <text>
          <span style={{ fg: theme().textMuted }}>{dims()}{view()?.live ? " · live" : ""}</span>
        </text>
      </box>

      {/* Invalid route data renders safely: no subscribe, no writes. */}
      <Show when={view()?.invalid}>
        <box flexDirection="column" border={true} borderColor={theme().error} padding={1} flexShrink={0}>
          <text>
            <span style={{ fg: theme().error, bold: true }}>Invalid terminal route: {view()?.invalid}</span>
            <span style={{ fg: theme().textMuted }}>{"\n"}Press Ctrl+] to go back. Nothing was subscribed or written.</span>
          </text>
        </box>
      </Show>

      {/* Viewport — flexes to all remaining space, NO maxHeight constraint. */}
      <box
        flexDirection="column"
        flexGrow={1}
        minHeight={0}
        overflow="hidden"
        ref={(el: Renderable) => {
          viewportEl = el
          try {
            el.onSizeChange = () => measureViewport()
          } catch {}
          setTimeout(measureViewport, 50)
        }}
      >
        <Show
          when={view() && view()!.rows.length > 0}
          fallback={
            <text>
              <span style={{ fg: theme().textMuted }}>{view()?.invalid ? "" : "(no output yet)"}</span>
            </text>
          }
        >
          <For each={buildTerminalRows(view()!.rows, view()!.cols, view()!.viewportRows, view()!.cursor)}>
            {(runs) => (
              <text wrapMode="none" truncate={true}>
                <For each={runs}>
                  {(run) => (
                    <span
                      style={{
                        // Inverse with a default side resolves against the
                        // live theme: default fg inverts to the background
                        // color and vice versa (an un-resolved default
                        // inverse would be invisible).
                        fg: run.cursor
                          ? (theme().background as unknown as string)
                          : run.inverse
                            ? ((run.fg ?? theme().background) as unknown as string)
                            : ((run.fg ?? theme().text) as unknown as string),
                        bg: run.cursor
                          ? (theme().primary as unknown as string)
                          : run.inverse
                            ? ((run.bg ?? theme().text) as unknown as string)
                            : run.bg,
                        bold: run.bold ?? run.cursor,
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

      {/* Footer — controls + dimensions */}
      <box flexDirection="row" justifyContent="space-between" flexShrink={0}>
        <text>
          <span style={{ fg: theme().textMuted }}>type to write · </span>
          <span style={{ fg: theme().warning, bold: true }}>Ctrl+C</span>
          <span style={{ fg: theme().textMuted }}> interrupt · </span>
          <span style={{ fg: theme().warning, bold: true }}>Ctrl+]</span>
          <span style={{ fg: theme().textMuted }}> detach (keeps running)</span>
        </text>
        <text>
          <span style={{ fg: theme().textMuted }}>{dims()} · {view()?.totalBytes ?? 0} bytes</span>
        </text>
      </box>
    </box>
  )
}
