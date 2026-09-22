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
  return `${c.title} — ${argv} — ${tail}`
}
