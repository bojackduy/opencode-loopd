// ─── TUI: Command Controller (headless-testable) ─────────────────────────────
// Pure selection/input logic for the command-sessions panel. Rendering lives
// in command-panel.tsx; this module has no OpenCode TUI imports so bun test
// can exercise it directly.

import type { CommandSession } from "../domain/command-session"

export interface CommandPanelState {
  commands: CommandSession[]
  selected: number
  selectedCommand: CommandSession | null
  /** Byte offset into the selected command's output log (paging). */
  outputOffset: number
  statusText: string
  /** Insert mode = keystrokes go to the command's stdin. */
  inputMode: boolean
}

export function emptyCommandPanelState(): CommandPanelState {
  return { commands: [], selected: 0, selectedCommand: null, outputOffset: 0, statusText: "", inputMode: false }
}

/** Refresh selection after a list update; keeps the cursor stable by ID. */
export function refreshCommandList(
  state: CommandPanelState,
  commands: CommandSession[],
): CommandPanelState {
  const prevID = state.selectedCommand?.id
  let selected = 0
  if (prevID) {
    const idx = commands.findIndex((c) => c.id === prevID)
    if (idx >= 0) selected = idx
    else selected = Math.min(state.selected, Math.max(0, commands.length - 1))
  }
  return { ...state, commands, selected, selectedCommand: commands[selected] ?? null, outputOffset: 0 }
}

export function moveCommandSelection(
  state: CommandPanelState,
  delta: number,
): CommandPanelState {
  if (state.commands.length === 0) return state
  const next = Math.min(Math.max(0, state.selected + delta), state.commands.length - 1)
  return { ...state, selected: next, selectedCommand: state.commands[next] ?? null, outputOffset: 0 }
}

export function selectCommandFirst(state: CommandPanelState): CommandPanelState {
  if (state.commands.length === 0) return state
  return { ...state, selected: 0, selectedCommand: state.commands[0] ?? null, outputOffset: 0 }
}

export function selectCommandLast(state: CommandPanelState): CommandPanelState {
  if (state.commands.length === 0) return state
  const last = state.commands.length - 1
  return { ...state, selected: last, selectedCommand: state.commands[last] ?? null, outputOffset: 0 }
}

export type CommandPanelAction =
  | { kind: "write"; input: string }
  | { kind: "interrupt" }
  | { kind: "terminate" }
  | { kind: "remove" }
  | { kind: "resize"; cols: number; rows: number }
  | { kind: "await"; goalID?: string }
  | { kind: "refresh" }
  | { kind: "detach" }

/**
 * Resolve a single-keypress panel key to an action. Detach ("q"/escape) is an
 * explicit no-op on the session: closing the view never terminates.
 * "ctrl-c" maps to interrupt (SIGINT delivery, never kill).
 */
export function commandPanelKey(key: string, state: CommandPanelState): CommandPanelAction | undefined {
  switch (key) {
    case "ctrl-c":
      return state.selectedCommand ? { kind: "interrupt" } : undefined
    case "terminate":
      return state.selectedCommand ? { kind: "terminate" } : undefined
    case "remove":
      return state.selectedCommand ? { kind: "remove" } : undefined
    case "resize":
      return undefined // resize needs dimensions — handled via :resize cols rows
    case "write":
    case "input":
      return undefined // insert mode typing flows through write directly
    case "await":
      // Opt-in wake: the selected command's linked goal awaits its exit.
      // An explicit ":await <goalID>" overrides the linked goal.
      return state.selectedCommand ? { kind: "await", goalID: state.selectedCommand.goalID } : undefined
    case "open-cmd":
      return { kind: "refresh" }
    case "q":
    case "close":
    case "detach":
      return { kind: "detach" }
    default:
      return undefined
  }
}

/** Parse `:resize <cols> <rows>` args; undefined when malformed. */
export function parseResizeArgs(positional: string[]): { cols: number; rows: number } | undefined {
  const cols = Number(positional[0])
  const rows = Number(positional[1])
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols <= 0 || rows <= 0) return undefined
  return { cols, rows }
}

/** Split a command line without shell expansion, preserving quoted arguments. */
export function parseCommandLine(input: string): string[] | undefined {
  const args: string[] = []
  let current = ""
  let quote: "'" | '"' | undefined
  let escaped = false
  let started = false
  for (const char of input.trim()) {
    if (escaped) {
      current += char
      escaped = false
      started = true
      continue
    }
    if (char === "\\" && quote !== "'") {
      escaped = true
      started = true
      continue
    }
    if (quote) {
      if (char === quote) quote = undefined
      else current += char
      started = true
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      started = true
      continue
    }
    if (/\s/.test(char)) {
      if (started) {
        args.push(current)
        current = ""
        started = false
      }
      continue
    }
    current += char
    started = true
  }
  if (quote || escaped) return undefined
  if (started) args.push(current)
  return args
}

export function formatCommandRow(c: CommandSession): string {
  const argv = [c.command, ...c.args].join(" ")
  const tail = c.status === "running" ? "running" : `${c.status}${c.exitCode !== undefined ? ` (${c.exitCode})` : ""}`
  const extra = commandBadges(c)
  return extra.length > 0 ? `${c.title} — ${argv} — ${tail} — ${extra.join(" ")}` : `${c.title} — ${argv} — ${tail}`
}

// ─── M3 watch/endReason badges (testable row vocabulary) ─────────────────────
// Badge strings: `watch:filter` (filter armed, no until), `until:stop-armed` /
// `until:keep-armed` (until armed, still active), `until-matched`,
// `flood-suspended`, `budget-exhausted`, plus the terminal `endReason`
// (timeout/until/...) on non-running rows. Terminal watch states outrank the
// armed forms; endReason is terminal-only (running rows never show one).

/** Watch badge for one command, or undefined when no watch is configured. */
export function watchBadge(c: CommandSession): string | undefined {
  const st = c.watchState?.state
  if (st === "until-matched") return "until-matched"
  if (st === "flood-suspended") return "flood-suspended"
  if (st === "budget-exhausted") return "budget-exhausted"
  if (c.watchUntil !== undefined) return `until:${c.watchUntilAction ?? "stop"}-armed`
  if (c.watchFilter !== undefined) return "watch:filter"
  return undefined
}

/** Row badges: terminal endReason (when set) + watch badge (when configured). */
export function commandBadges(c: CommandSession): string[] {
  const out: string[] = []
  if (c.status !== "running" && c.endReason) out.push(c.endReason)
  const w = watchBadge(c)
  if (w) out.push(w)
  return out
}

/** One-line watch detail for the detail panel (spec + live counters). */
export function formatWatchDetail(c: CommandSession): string | undefined {
  if (c.watchFilter === undefined && c.watchUntil === undefined && c.watchState === undefined) return undefined
  const spec = [
    c.watchFilter !== undefined ? `filter="${c.watchFilter}"` : null,
    c.watchUntil !== undefined ? `until="${c.watchUntil}"` : null,
    `action=${c.watchUntilAction ?? "stop"}`,
    c.watchIgnoreCase === true ? "ignore-case" : null,
  ].filter((x): x is string => x !== null).join(" ")
  const st = c.watchState
  const counters = st ? `state=${st.state} matches=${st.matches} pushes=${st.pushes} dropped=${st.droppedLines}` : "state=—"
  return `watch ${spec} · ${counters}`
}

/**
 * Parse the `:new` command tail (everything after the `new` verb) into an
 * argv with quoted/escaped boundaries preserved. The dashboard's
 * parseCommand already tokenized the line once (and routes `--flags` into
 * args), so re-splitting its positional values would lose boundaries such
 * as `:new bash -c "echo hi"` → ["bash","-c","echo hi"]. Parsing the raw
 * tail directly keeps `echo hi` as one argument. Returns undefined for
 * missing/empty tails and unbalanced quotes/escapes.
 */
export function parseNewCommandTail(raw: string): string[] | undefined {
  const match = /^(?::?\s*new)(?:\s+(.*))?\s*$/s.exec(raw.trim())
  if (!match) return undefined
  const tail = (match[1] ?? "").trim()
  if (!tail) return undefined
  return parseCommandLine(tail)
}

/**
 * Split a `:new` line into spawn argv: the first tail token is the command,
 * the rest are its args. Quoted boundaries survive (`:new bash -c "echo hi"`
 * → `{ command: "bash", cmdArgs: ["-c", "echo hi"] }`). Undefined when the
 * tail is missing or unbalanced.
 */
export function parseNewCommand(raw: string): { command: string; cmdArgs: string[] } | undefined {
  const parts = parseNewCommandTail(raw)
  if (!parts || parts.length === 0) return undefined
  const [command, ...cmdArgs] = parts as [string, ...string[]]
  return { command, cmdArgs }
}
