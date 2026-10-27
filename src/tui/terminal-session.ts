// ─── TUI: Terminal Session Driver (headless-testable) ─────────────────────────
// Lifecycle owner for ONE fullscreen terminal route instance. No OpenCode TUI
// imports — bun-testable with fakes. The TerminalView component wraps this
// driver with rendering + keyboard/paste/viewport measurement.
//
// Mount: validate route data → connect → ownership-check → subscribe →
// snapshot then live deltas/status; stream-primary with bounded polling
// fallback. Detach/dispose: unsubscribe + clear timers + dispose the emulator,
// NEVER terminate the command.

import { readState, readCommandLog, type StoreState } from "../infrastructure/state-repository"
import { createControlClient, type ControlClient } from "../infrastructure/control-client"
import { createCommandStreamClient, type CommandStreamClient } from "./command-stream-client"
import { utf8ByteLength } from "../domain/command-events"
import {
  createCommandScreenFeed,
  createTerminalScreen,
  type CommandScreenFeed,
  type CursorState,
  type ScreenCell,
  type TerminalScreen,
} from "./terminal-screen"
import { validateTerminalRouteData, isTerminalRouteConsistent, type TerminalRouteData } from "./terminal-route"
import type { CommandSession } from "../domain/command-session"

export const TERMINAL_FALLBACK_COLS = 80
export const TERMINAL_FALLBACK_ROWS = 24
export const TERMINAL_POLL_INTERVAL_MS = 2000
export const TERMINAL_RESIZE_DEBOUNCE_MS = 75
export const TERMINAL_LOG_WINDOW_BYTES = 32 * 1024

export type TerminalConnectionKind = "stream" | "polling" | "error"

export interface TerminalSessionSnapshot {
  rows: ScreenCell[]
  cols: number
  viewportRows: number
  cursor: CursorState
  activeBuffer: "normal" | "alternate"
  command: CommandSession | null
  connection: TerminalConnectionKind
  connectionDetail: string
  totalBytes: number
  live: boolean
  /** Lines scrolled up from live output (0 = following). */
  scrollOffset: number
  /** Lines hidden above / below the viewport (alt-screen: 0,0). */
  scrollAbove: number
  scrollBelow: number
  invalid: string | undefined
}

export interface TerminalSessionOptions {
  directory: string
  /** Raw route data (v1 params or v2 data). Re-validated fail-closed. */
  routeData: unknown
  createStreamClient?: () => CommandStreamClient
  createControl?: (directory: string) => ControlClient
  createScreen?: (cols: number, rows: number) => TerminalScreen
  /** Test seam: stored-state snapshot (defaults to the real state repo). */
  readStateFn?: (directory: string) => Promise<StoreState>
  /** Test seam: bounded log read (defaults to the real state repo). */
  readLogFn?: (
    directory: string,
    commandID: string,
    range: { offsetBytes: number; limitBytes: number },
  ) => Promise<{ text: string; startByte: number }>
  onSnapshot?: (snap: TerminalSessionSnapshot) => void
  onDetach?: () => void
  pollIntervalMs?: number
  resizeDebounceMs?: number
}

export interface TerminalSession {
  readonly data: TerminalRouteData | undefined
  readonly invalidReason: string | undefined
  start(): Promise<void>
  /** Immediate raw stdin bytes (stream when live, control bus otherwise). */
  writeInput(bytes: string): void
  /** Paste bytes forward immediately as raw stdin (never key-encoded). */
  paste(text: string): void
  /** SIGINT delivery, never a kill. */
  interrupt(): void
  /** Local detach: unsubscribe + cleanup, NEVER terminate. Then onDetach. */
  detach(): void
  /** Viewport-measured size; debounced to emulator + real PTY winsize. */
  requestViewportSize(cols: number, rows: number): void
  /** Scroll the viewport into scrollback (negative = up) or toward live. */
  scrollBy(lines: number): void
  /** Resume following live output. */
  scrollToBottom(): void
  /** Last applied viewport size (fallback 80x24 until measured). */
  readonly appliedSize: { cols: number; rows: number }
  readView(): TerminalSessionSnapshot
  dispose(): void
}

export function computeViewportSize(
  measuredWidth: number,
  measuredHeight: number,
  chromeRows: number,
): { cols: number; rows: number } | undefined {
  const cols = Math.floor(measuredWidth)
  const rows = Math.floor(measuredHeight) - chromeRows
  if (!Number.isFinite(cols) || !Number.isFinite(rows)) return undefined
  if (cols < 1 || rows < 1) return undefined
  return { cols, rows }
}

export function createTerminalSession(options: TerminalSessionOptions): TerminalSession {
  const validated = validateTerminalRouteData(options.routeData)
  const data = validated.ok ? validated.data : undefined
  const invalidReason = validated.ok ? undefined : validated.reason
  // Route data is NOT an authentication token: server/service ownership
  // checks remain authoritative (stored-state pre-check below, per-snapshot
  // re-check, broker subscribe ownership). For the supported dashboard flow
  // the command owner and the originating return session are the same
  // trusted current session — fail closed when they differ.
  const routeConsistent = !data || isTerminalRouteConsistent(data)
  const routeReason = !data ? invalidReason : routeConsistent ? undefined : "owner-return-mismatch"
  const pollIntervalMs = options.pollIntervalMs ?? TERMINAL_POLL_INTERVAL_MS
  const resizeDebounceMs = options.resizeDebounceMs ?? TERMINAL_RESIZE_DEBOUNCE_MS

  const stream = (options.createStreamClient ?? createCommandStreamClient)()
  const control = (options.createControl ?? createControlClient)(options.directory)
  const readStateFn = options.readStateFn ?? readState
  const readLogFn =
    options.readLogFn ??
    ((dir: string, id: string, range: { offsetBytes: number; limitBytes: number }) =>
      readCommandLog(dir, id, range))
  let screen: TerminalScreen | undefined
  let feed: CommandScreenFeed | undefined
  let command: CommandSession | null = null
  let connection: TerminalConnectionKind = "polling"
  let connectionDetail = "connecting…"
  let totalBytes = 0
  let live = false
  let disposed = false
  let started = false
  let appliedSize = { cols: TERMINAL_FALLBACK_COLS, rows: TERMINAL_FALLBACK_ROWS }
  let pollTimer: ReturnType<typeof setInterval> | undefined
  let resizeTimer: ReturnType<typeof setTimeout> | undefined
  let pendingResize: { cols: number; rows: number } | undefined
  let emitTimer: ReturnType<typeof setTimeout> | undefined
  let lastEmitAt = 0
  const EMIT_MIN_MS = 120
  /** Scroll offset carried across a resnapshot grid rebuild. */
  let pendingScrollRestore = 0
  /**
   * Paint revision: incremented on every feed write and every reset. Async
   * flush continuations capture their revision and skip emission when a
   * newer write/reset landed meanwhile — a write arriving during a flush
   * schedules another paint rather than being lost, and a reset never shows
   * pre-reset bytes.
   */
  let paintRevision = 0

  function ensureEmulator(): void {
    if (screen && feed) return
    const make = options.createScreen ?? createTerminalScreen
    screen = make(appliedSize.cols, appliedSize.rows)
    feed = createCommandScreenFeed(screen)
  }

  function emit(): void {
    if (disposed) return
    try {
      options.onSnapshot?.(readView())
    } catch {}
  }

  function emitSoon(): void {
    if (disposed) return
    const wait = Math.max(0, EMIT_MIN_MS - (Date.now() - lastEmitAt))
    if (emitTimer) return
    emitTimer = setTimeout(() => {
      emitTimer = undefined
      lastEmitAt = Date.now()
      emit()
    }, wait)
  }

  function applySnapshotBytes(snapshotData: string, startOffset: number, endOffset: number): void {
    ensureEmulator()
    // Unchanged window: skip the reset+repaint so a scrolled-up viewport is
    // never yanked back to the bottom by an idle poll.
    if (feed?.endOffset === endOffset) return
    // A resnapshot rebuilds the grid from the retained window: carry the
    // scroll offset across the reset so new output doesn't yank the view.
    const keepOffset = screen?.scrollOffset ?? 0
    const revision = ++paintRevision
    feed!.applySnapshot(snapshotData, startOffset, endOffset)
    totalBytes = endOffset
    if (keepOffset > 0) pendingScrollRestore = keepOffset
    void flushThenEmit(revision)
  }

  function applyDeltaBytes(deltaData: string, startOffset: number, endOffset: number): void {
    if (!feed) return
    if (feed.applyDelta(deltaData, startOffset, endOffset)) {
      const revision = ++paintRevision
      totalBytes = endOffset
      void flushThenEmit(revision)
    }
  }

  /**
   * Await xterm-headless parsing before emitting the snapshot/delta view.
   * Revision-fenced: when a newer write/reset landed during the flush, this
   * revision's paint is stale — the newer revision already scheduled its own
   * paint, so this one stays silent instead of repainting old bytes.
   */
  async function flushThenEmit(revision: number): Promise<void> {
    try {
      await screen?.flush()
    } catch {}
    if (disposed || revision !== paintRevision) return
    // Restore a carried scroll offset after a resnapshot rebuilds the grid.
    if (pendingScrollRestore > 0) {
      const keep = pendingScrollRestore
      pendingScrollRestore = 0
      try {
        screen?.scrollToBottom()
        screen?.scrollBy(-keep)
      } catch {}
    }
    emitSoon()
  }

  function streamLive(): boolean {
    return !!data && stream.isLive(data.commandID)
  }

  async function pollOnce(): Promise<void> {
    if (disposed || !data) return
    // Fail-closed route (invalid or owner/return mismatch) keeps its error
    // rendering; the poller never clears it and never feeds bytes.
    if (!routeConsistent) return
    // Stream-live: deltas append immediately; the output poller stands down.
    if (streamLive()) return
    try {
      const state = await readStateFn(options.directory)
      const found = (state.commands ?? []).find((c) => c.id === data.commandID) ?? null
      if (!found) {
        connection = "error"
        connectionDetail = "command not found"
        emitSoon()
        return
      }
      if (found.ownerSessionID !== data.ownerSessionID) {
        connection = "error"
        connectionDetail = "not owned by this session"
        emitSoon()
        return
      }
      command = found as CommandSession
      const windowBytes = TERMINAL_LOG_WINDOW_BYTES
      // File-local request window (retained log file coordinates).
      const fileStartByte = Math.max(0, found.outputBytes - windowBytes)
      const log = await readLogFn(options.directory, found.id, {
        offsetBytes: fileStartByte,
        limitBytes: windowBytes,
      })
      if (disposed || !data) return
      ensureEmulator()
      // Lifetime protocol offsets: the retained file starts at
      // max(0, streamBytes - outputBytes) in lifetime coordinates
      // (truncation drops the oldest bytes). The log reader returns the
      // actual file-local start (UTF-8 boundary adjusted), and the payload
      // length is measured in UTF-8 bytes — never string.length — so the
      // next stream delta continues exactly.
      const lifetimeBase = Math.max(0, (found.streamBytes ?? found.outputBytes) - found.outputBytes)
      const absoluteStart = lifetimeBase + log.startByte
      const absoluteEnd = absoluteStart + utf8ByteLength(log.text)
      applySnapshotBytes(log.text, absoluteStart, absoluteEnd)
      live = found.status === "running"
      if (connection !== "stream") {
        connection = "polling"
        connectionDetail = "polling fallback (stream unavailable)"
      }
      // Poll repaints reuse the emit throttle (same coalescing as deltas).
      emitSoon()
    } catch (error) {
      connectionDetail = error instanceof Error ? error.message : String(error)
      emitSoon()
    }
  }

  async function start(): Promise<void> {
    if (started || disposed) return
    started = true
    ensureEmulator()
    if (!data) {
      connection = "error"
      connectionDetail = `invalid route data: ${invalidReason}`
      emit()
      return
    }
    if (!routeConsistent) {
      connection = "error"
      connectionDetail = `invalid route data: ${routeReason}`
      emit()
      pollTimer = setInterval(() => void pollOnce(), pollIntervalMs)
      return
    }
    // Ownership pre-check from stored state (fail closed before subscribing).
    try {
      const state = await readStateFn(options.directory)
      const found = (state.commands ?? []).find((c) => c.id === data.commandID)
      if (!found) {
        connection = "error"
        connectionDetail = "command not found"
        emit()
      } else if (found.ownerSessionID !== data.ownerSessionID) {
        connection = "error"
        connectionDetail = "not owned by this session"
        emit()
      } else {
        command = found as CommandSession
      }
    } catch (error) {
      connectionDetail = error instanceof Error ? error.message : String(error)
    }
    if (connection === "error") {
      // Invalid/missing/cross-owner: render safely, never subscribe or write.
      pollTimer = setInterval(() => void pollOnce(), pollIntervalMs)
      return
    }
    try {
      const result = await stream.connect(options.directory)
      if (!result.ok) {
        connection = "polling"
        connectionDetail = "polling fallback (stream unavailable)"
      }
    } catch {
      connection = "polling"
      connectionDetail = "polling fallback (stream unavailable)"
    }
    // Past the error gate above: invalid/missing/cross-owner returned early
    // and never subscribes or writes.
    stream.subscribe(data.commandID, data.ownerSessionID, {
        onSnapshot: (snap) => {
          if (disposed || snap.command.id !== data.commandID) return
          // Ownership re-check on every snapshot (fail closed).
          if (snap.command.ownerSessionID !== data.ownerSessionID) {
            connection = "error"
            connectionDetail = "not owned by this session"
            stream.unsubscribe(data.commandID)
            emit()
            return
          }
          command = snap.command as CommandSession
          connection = "stream"
          live = (snap.command as CommandSession).status === "running"
          connectionDetail = live ? "live" : "saved output (process ended)"
          applySnapshotBytes(snap.data, snap.startOffset, snap.endOffset)
        },
        onDelta: (delta) => {
          if (disposed || delta.commandID !== data.commandID) return
          applyDeltaBytes(delta.data, delta.startOffset, delta.endOffset)
        },
        onStatus: (cmd) => {
          if (disposed || (cmd as CommandSession).id !== data.commandID) return
          if ((cmd as CommandSession).ownerSessionID !== data.ownerSessionID) return
          command = cmd as CommandSession
          live = (cmd as CommandSession).status === "running"
          connectionDetail = live ? "live" : "saved output (process ended)"
          emitSoon()
        },
        onError: (message) => {
          if (disposed) return
          // Snapshot-timeout / resync-guard → polling fallback stays live.
          if (/snapshot-timeout|resync-loop-guard/.test(message) && connection !== "error") {
            connection = "polling"
            connectionDetail = "polling fallback (stream unavailable)"
          } else if (connection !== "stream") {
            connectionDetail = message
          }
          emitSoon()
        },
        onConnection: (next) => {
          if (disposed) return
          if (next === "connected" && connection !== "stream" && connection !== "error") {
            connectionDetail = "stream connected — awaiting snapshot…"
          } else if (next === "disconnected" && connection === "stream") {
            connection = "polling"
            connectionDetail = "polling fallback (stream unavailable)"
          }
          emitSoon()
        },
      })
    await pollOnce()
    pollTimer = setInterval(() => void pollOnce(), pollIntervalMs)
  }

  function writeInput(bytes: string): void {
    if (disposed || !data || !bytes) return
    if (connection === "error") return // invalid/cross-owner: never write
    if (command && command.status !== "running") return
    // Adopted after a host restart: stdin died with the old host, so bytes
    // have nowhere to go. The view guards this too; belt-and-braces here.
    if ((command as unknown as { detached?: boolean } | null)?.detached === true) return
    if (streamLive() && stream.sendInput(data.commandID, bytes).ok) return
    // Fallback to the control bus (never double-send on both paths).
    void control
      .executeRaw({ command: "cmd_write", goalID: data.commandID, args: { commandID: data.commandID, input: bytes, ownerSessionID: data.ownerSessionID } })
      .catch(() => {})
  }

  function paste(text: string): void {
    // Paste bytes forward immediately as raw stdin — never key-encoded.
    if (disposed || !data || !text) return
    if ((command as unknown as { detached?: boolean } | null)?.detached === true) return
    writeInput(text)
  }

  function interrupt(): void {
    if (disposed || !data) return
    if (connection === "error") return
    if (command && command.status !== "running") return
    // Adopted stdin is gone; SIGINT-by-write is impossible. Terminate/kill
    // from Commands still stops the pid (they signal it directly).
    if ((command as unknown as { detached?: boolean } | null)?.detached === true) return
    if (streamLive() && stream.sendInterrupt(data.commandID).ok) return
    void control
      .executeRaw({ command: "cmd_interrupt", goalID: data.commandID, args: { commandID: data.commandID, ownerSessionID: data.ownerSessionID } })
      .catch(() => {})
  }

  function applyResize(cols: number, rows: number): void {
    if (disposed || !data) return
    appliedSize = { cols, rows }
    try {
      screen?.resize(cols, rows)
    } catch {}
    if (connection === "error") {
      emitSoon()
      return
    }
    // Real PTY winsize follows the measured viewport (pipe: stored only).
    void control
      .executeRaw({ command: "cmd_resize", goalID: data.commandID, args: { commandID: data.commandID, cols, rows, ownerSessionID: data.ownerSessionID } })
      .catch(() => {})
    emitSoon()
  }

  function requestViewportSize(cols: number, rows: number): void {    if (disposed) return
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1) return
    if (cols === appliedSize.cols && rows === appliedSize.rows && !pendingResize) return
    pendingResize = { cols, rows }
    if (resizeTimer) return
    resizeTimer = setTimeout(() => {
      resizeTimer = undefined
      const next = pendingResize
      pendingResize = undefined
      if (!next || disposed) return
      applyResize(next.cols, next.rows)
    }, resizeDebounceMs)
  }

  function scrollBy(lines: number): void {
    if (disposed || !data) return
    if (!Number.isFinite(lines) || lines === 0) return
    try {
      screen?.scrollBy(Math.trunc(lines))
    } catch {}
    emitSoon()
  }

  function scrollToBottom(): void {
    if (disposed) return
    try {
      screen?.scrollToBottom()
    } catch {}
    emitSoon()
  }

  function cleanup(): void {
    if (pollTimer) clearInterval(pollTimer)
    if (resizeTimer) clearTimeout(resizeTimer)
    if (emitTimer) clearTimeout(emitTimer)
    pollTimer = undefined
    resizeTimer = undefined
    emitTimer = undefined
    pendingResize = undefined
    try {
      if (data) stream.unsubscribe(data.commandID)
    } catch {}
    try {
      stream.dispose()
    } catch {}
    try {
      screen?.dispose()
    } catch {}
    screen = undefined
    feed = undefined
  }

  function detach(): void {
    if (disposed) return
    // Detach is client-side only: the command keeps running. Termination is
    // explicit-only (never here, never on unmount).
    cleanup()
    disposed = true
    try {
      options.onDetach?.()
    } catch {}
  }

  function dispose(): void {
    if (disposed) return
    cleanup()
    disposed = true
  }

  function readView(): TerminalSessionSnapshot {
    ensureEmulator()
    let rows: ScreenCell[] = []
    try {
      rows = screen!.readScreen()
    } catch {
      rows = []
    }
    let cursor: CursorState = { x: 0, y: 0, visible: true }
    try {
      cursor = screen!.cursor
    } catch {}
    let activeBuffer: "normal" | "alternate" = "normal"
    try {
      activeBuffer = screen!.activeBuffer
    } catch {}
    let scrollOffset = 0
    let scrollAbove = 0
    let scrollBelow = 0
    try {
      scrollOffset = screen?.scrollOffset ?? 0
      const pos = screen?.scrollPosition
      scrollAbove = pos?.above ?? 0
      scrollBelow = pos?.below ?? 0
    } catch {
      scrollOffset = 0
    }
    return {
      rows,
      cols: screen!.cols,
      viewportRows: screen!.rows,
      cursor,
      activeBuffer,
      command,
      connection,
      connectionDetail,
      totalBytes,
      live,
      scrollOffset,
      scrollAbove,
      scrollBelow,
      invalid: routeReason,
    }
  }

  return {
    get data() {
      return data
    },
    get invalidReason() {
      return routeReason
    },
    start,
    writeInput,
    paste,
    interrupt,
    detach,
    requestViewportSize,
    scrollBy,
    scrollToBottom,
    get appliedSize() {
      return { ...appliedSize }
    },
    readView,
    dispose,
  }
}
