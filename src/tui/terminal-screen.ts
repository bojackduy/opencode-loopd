// ─── TUI: Headless Terminal Screen (view layer ONLY) ──────────────────────────
// Screen emulation as a VIEW over the unchanged command byte stream
// (protocol/broker/transport/host-backends untouched). Wraps @xterm/headless:
// real PTY bytes (cursor addressing, alt-screen, SGR colors) in, styled grid
// out. No OpenCode TUI imports — bun-testable.
//
// Best-effort caveat: the panel replays a BOUNDED retained log (32KB window of
// a 512KB retained log). Bytes before the retained window are gone, so escape
// sequences that set up state (cursor home, alt-screen enter, scroll regions)
// may be missing and the emulated grid can diverge from what a live terminal
// showed. The raw log remains the durable record; this grid is a display aid.
// Snapshot/resync reset the emulator and re-feed from the snapshot start, so
// divergence never accumulates across resyncs.

import { Terminal } from "@xterm/headless"

export interface ScreenCell {
  /** Single visible character (space for empty cells). */
  text: string
  /** Display-resolved foreground as #rrggbb (undefined = terminal default). */
  fg?: string
  /** Display-resolved background as #rrggbb (undefined = terminal default). */
  bg?: string
  bold?: boolean
  underline?: boolean
  /** Raw attribute flag; fg/bg above are already inverse-resolved. */
  inverse?: boolean
  /**
   * Cell width from the emulator: 1 for normal cells, 2 for a wide glyph
   * (CJK/emoji lead cell), 0 for the continuation cell after a wide glyph.
   * Renderers must preserve continuation cells (never collapse them) so
   * wide text keeps its column alignment.
   */
  width?: number
}

export interface CursorState {
  x: number
  y: number
  /** False after DECTCEM hide (CSI ? 25 l); true after show / reset. */
  visible: boolean
}

export interface TerminalScreen {
  readonly cols: number
  readonly rows: number
  /** "alternate" while a fullscreen app (vim/less/htop) owns the screen. */
  readonly activeBuffer: "normal" | "alternate"
  /** Cursor position + DECTCEM visibility on the ACTIVE buffer. */
  readonly cursor: CursorState
  /** Feed raw PTY bytes. Async-parsed; call flush() before readScreen in tests. */
  write(data: string): void
  /** Resolve when all bytes written so far are parsed. */
  flush(): Promise<void>
  resize(cols: number, rows: number): void
  /** Full reset (RIS): clears the grid, exits alt-screen, resets attributes. */
  reset(): void
  /** ACTIVE screen cells in row-major order (cols*rows entries). */
  readScreen(): ScreenCell[]
  /** Serialize the ACTIVE viewport to plain text rows (trailing spaces kept). */
  serialize(): string[]
  dispose(): void
}

// Standard xterm palette 0-15.
const BASE_COLORS = [
  "#000000", "#cd0000", "#00cd00", "#cdcd00",
  "#0000cd", "#cd00cd", "#00cdcd", "#e5e5e5",
  "#7f7f7f", "#ff0000", "#00ff00", "#ffff00",
  "#5c5cff", "#ff00ff", "#00ffff", "#ffffff",
]

function toHex(n: number): string {
  return `#${n.toString(16).padStart(6, "0")}`
}

function paletteToHex(index: number): string | undefined {
  if (index < 0 || index > 255) return undefined
  if (index < 16) return BASE_COLORS[index]
  if (index < 232) {
    const i = index - 16
    const r = Math.floor(i / 36)
    const g = Math.floor((i % 36) / 6)
    const b = i % 6
    // xterm 256-color cube: 0 → 0, else 55 + 40*c (max 255).
    const v = (c: number) => (c === 0 ? 0 : 55 + c * 40)
    return toHex((v(r) << 16) | (v(g) << 8) | v(b))
  }
  const g = 8 + (index - 232) * 10
  return toHex((g << 16) | (g << 8) | g)
}

export function createTerminalScreen(cols: number, rows: number): TerminalScreen {
  // allowProposedApi unlocks the buffer namespace (cell/cursor/alt-screen
  // readout) — verified against @xterm/headless 6.0.0 types + probe script.
  function makeTerm(nextCols: number, nextRows: number): InstanceType<typeof Terminal> {
    return new Terminal({
      cols: nextCols,
      rows: nextRows,
      scrollback: 0,
      allowProposedApi: true,
    } as unknown as Record<string, unknown> as never)
  }
  let term = makeTerm(cols, rows)
  let disposed = false
  // Reset invalidates pending old writes by disposing the parser: bytes
  // written before the reset parse into the DISPOSED instance and can never
  // repaint the new grid. Pending flush waiters resolve immediately on reset
  // (stale waiter, never a fresh paint — session-side revision fencing drops
  // their emission).
  let pendingFlushes: Array<() => void> = []
  // DECTCEM cursor visibility tracked view-side: hide on CSI ? 25 l, show on
  // CSI ? 25 h, reset to visible on full reset. Defaults to visible.
  let cursorVisible = true

  function trackCursorVisibility(data: string): void {
    if (!data) return
    // Scan for DECTCEM show/hide; last occurrence wins.
    const re = /\x1b\[\?25([lh])/g
    let m: RegExpExecArray | null
    while ((m = re.exec(data)) !== null) {
      cursorVisible = m[1] === "h"
    }
  }

  function readCursor(): CursorState {
    try {
      const buf = term.buffer.active as unknown as { cursorX?: number; cursorY?: number }
      const x = typeof buf.cursorX === "number" ? buf.cursorX : 0
      const y = typeof buf.cursorY === "number" ? buf.cursorY : 0
      return {
        x: Math.max(0, Math.min(term.cols - 1, x)),
        y: Math.max(0, Math.min(term.rows - 1, y)),
        visible: cursorVisible,
      }
    } catch {
      return { x: 0, y: 0, visible: cursorVisible }
    }
  }

  return {
    get cols() {
      return term.cols
    },
    get rows() {
      return term.rows
    },
    get activeBuffer() {
      try {
        return term.buffer.active.type === "alternate" ? "alternate" : "normal"
      } catch {
        return "normal"
      }
    },
    get cursor() {
      return readCursor()
    },
    write(data: string): void {
      if (disposed || !data) return
      trackCursorVisibility(data)
      term.write(data)
    },
    flush(): Promise<void> {
      if (disposed) return Promise.resolve()
      const myTerm = term
      return new Promise<void>((resolve) => {
        let done = false
        const finish = () => {
          if (done) return
          done = true
          pendingFlushes = pendingFlushes.filter((f) => f !== finish)
          resolve()
        }
        pendingFlushes.push(finish)
        try {
          // An empty write still schedules (and fires) the parse callback —
          // verified by probe — so this resolves after all prior bytes parsed.
          myTerm.write("", finish)
        } catch {
          finish()
        }
      })
    },
    resize(nextCols: number, nextRows: number): void {
      if (disposed) return
      if (!Number.isInteger(nextCols) || !Number.isInteger(nextRows)) return
      if (nextCols <= 0 || nextRows <= 0) return
      if (nextCols === term.cols && nextRows === term.rows) return
      try {
        term.resize(nextCols, nextRows)
      } catch {
        // Best-effort view: never throw into the panel render path.
      }
    },
    reset(): void {
      if (disposed) return
      cursorVisible = true
      let nextCols = 80
      let nextRows = 24
      try {
        nextCols = term.cols
        nextRows = term.rows
      } catch {
        // Fall through to the fallback size.
      }
      const stale = term
      try {
        stale.dispose()
      } catch {
        // Best-effort view only.
      }
      // Stale flush waiters resolve without effect: the parser they waited
      // on is gone, and session-side revision fencing drops their emission.
      const waiters = pendingFlushes
      pendingFlushes = []
      for (const w of waiters) {
        try {
          w()
        } catch {
          // Never throw from reset.
        }
      }
      term = makeTerm(nextCols, nextRows)
    },
    readScreen(): ScreenCell[] {
      const out: ScreenCell[] = []
      if (disposed) return out
      let active: typeof term.buffer.active
      try {
        active = term.buffer.active
      } catch {
        return out
      }
      const c = term.cols
      const r = term.rows
      // scrollback: 0 pins baseY/viewportY at 0, so lines 0..rows-1 ARE the
      // visible screen (verified by probe). Read defensively anyway.
      for (let y = 0; y < r; y++) {
        let line: ReturnType<typeof active.getLine>
        try {
          line = active.getLine(y)
        } catch {
          line = undefined
        }
        for (let x = 0; x < c; x++) {
          let cell: ReturnType<NonNullable<typeof line>["getCell"]> | undefined
          try {
            cell = line?.getCell(x)
          } catch {
            cell = undefined
          }
          if (!cell) {
            out.push({ text: " " })
            continue
          }
          const text = cell.getChars() || " "
          const entry: ScreenCell = { text }
          try {
            const w = cell.getWidth()
            if (w === 0 || w === 2) entry.width = w
          } catch {
            // Width readout is decorative — text still renders.
          }
          // Foreground.
          try {
            if (!cell.isFgDefault()) {
              if (cell.isFgRGB()) entry.fg = toHex(cell.getFgColor())
              else if (cell.isFgPalette()) entry.fg = paletteToHex(cell.getFgColor())
            }
            if (!cell.isBgDefault()) {
              if (cell.isBgRGB()) entry.bg = toHex(cell.getBgColor())
              else if (cell.isBgPalette()) entry.bg = paletteToHex(cell.getBgColor())
            }
            if (cell.isBold()) entry.bold = true
            if (cell.isUnderline()) entry.underline = true
            if (cell.isInverse()) entry.inverse = true
          } catch {
            // A cell that fails attribute readout keeps its text.
          }
          // The panel renderer has no inverse style: resolve it here by
          // swapping so fg/bg are display-ready. The inverse flag above
          // still reports the raw attribute for tests/diagnostics.
          if (entry.inverse) {
            const fg = entry.fg
            entry.fg = entry.bg
            entry.bg = fg
          }
          out.push(entry)
        }
      }
      return out
    },
    serialize(): string[] {
      if (disposed) return []
      const cells = this.readScreen()
      const rows: string[] = []
      const c = term.cols
      const r = term.rows
      // Every viewport row is serialized (blank rows preserved as spaces) so
      // a full-screen renderer can repaint without stale-row artifacts.
      for (let y = 0; y < r; y++) {
        let row = ""
        for (let x = 0; x < c; x++) {
          row += cells[y * c + x]?.text ?? " "
        }
        rows.push(row)
      }
      return rows
    },
    dispose(): void {
      disposed = true
      const waiters = pendingFlushes
      pendingFlushes = []
      for (const w of waiters) {
        try {
          w()
        } catch {}
      }
      try {
        term.dispose()
      } catch {
        // Never throw from dispose.
      }
    },
  }
}

// ─── Snapshot/delta/resync feed ──────────────────────────────────────────────
// Headless driver the panel uses to feed the emulator from the stream client
// (or the poll fallback) without duplicating bytes. The stream client already
// guarantees exact-continue-or-resync; this tracks offsets belt-and-braces so
// a duplicated/redelivered frame can never double-feed the grid:
//   snapshot → reset + feed (same path as resync)
//   delta    → append only when it continues exactly; stale/overlap ignored
//     (the stream client requests a fresh snapshot on gap/overlap, which
//     arrives here as applySnapshot and re-baselines).

export interface CommandScreenFeed {
  applySnapshot(data: string, startOffset: number, endOffset: number): void
  /** Returns true when the delta continued the stream and was fed. */
  applyDelta(data: string, startOffset: number, endOffset: number): boolean
  reset(): void
  readonly endOffset: number | undefined
}

export function createCommandScreenFeed(screen: TerminalScreen): CommandScreenFeed {
  let end: number | undefined

  return {
    get endOffset() {
      return end
    },
    applySnapshot(data: string, _startOffset: number, endOffset: number): void {
      screen.reset()
      if (data) screen.write(data)
      end = endOffset
    },
    applyDelta(data: string, startOffset: number, endOffset: number): boolean {
      if (end === undefined) return false // no baseline: wait for snapshot
      if (startOffset !== end) return false // gap/overlap: resync owns recovery
      if (data) screen.write(data)
      end = endOffset
      return true
    },
    reset(): void {
      screen.reset()
      end = undefined
    },
  }
}
