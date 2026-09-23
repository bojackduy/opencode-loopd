// ─── TUI: Shared Dashboard View State (headless-testable) ─────────────────────
// `/loop` and `/commands` open the SAME dashboard; this module owns the
// Goals/Commands tab state, per-view selection, and `o` dispatch so the
// component (dashboard.tsx) stays a thin renderer. No OpenCode TUI imports.

import { filterCommandsByOwner, resolveOpenTarget, type OpenTarget } from "./terminal-route"
import type { CommandSession } from "../domain/command-session"
import type { Goal } from "../domain/goal"

export type DashboardView = "goals" | "commands"

export function toggleDashboardView(view: DashboardView): DashboardView {
  return view === "goals" ? "commands" : "goals"
}

/**
 * Directional tab selection: `h` selects Goals, `l` selects Commands
 * (Tab toggles — see toggleDashboardView). Returns the target view, or
 * undefined when the key is not a directional tab key.
 */
export function dashboardViewForKey(key: string): DashboardView | undefined {
  if (key === "h") return "goals"
  if (key === "l") return "commands"
  return undefined
}

export interface DashboardSelection {
  view: DashboardView
  goalIndex: number
  commandIndex: number
}

export function initialDashboardSelection(view: DashboardView = "goals"): DashboardSelection {
  return { view, goalIndex: 0, commandIndex: 0 }
}

export function switchDashboardView(sel: DashboardSelection, view: DashboardView): DashboardSelection {
  return { ...sel, view }
}

/** j/k/g/G movement applies to the ACTIVE view only; the other index is kept. */
export function moveDashboardSelection(
  sel: DashboardSelection,
  move: "down" | "up" | "first" | "last",
  goalCount: number,
  commandCount: number,
): DashboardSelection {
  if (sel.view === "goals") {
    const max = Math.max(0, goalCount - 1)
    const cur = Math.min(sel.goalIndex, max)
    switch (move) {
      case "down":
        return { ...sel, goalIndex: Math.min(max, cur + 1) }
      case "up":
        return { ...sel, goalIndex: Math.max(0, cur - 1) }
      case "first":
        return { ...sel, goalIndex: 0 }
      case "last":
        return { ...sel, goalIndex: max }
    }
  }
  const max = Math.max(0, commandCount - 1)
  const cur = Math.min(sel.commandIndex, max)
  switch (move) {
    case "down":
      return { ...sel, commandIndex: Math.min(max, cur + 1) }
    case "up":
      return { ...sel, commandIndex: Math.max(0, cur - 1) }
    case "first":
      return { ...sel, commandIndex: 0 }
    case "last":
      return { ...sel, commandIndex: max }
  }
}

export interface DashboardLists {
  goals: Goal[]
  commands: CommandSession[]
}

/**
 * `o` dispatches by active selection type: goals open their native worker
 * session (unchanged); commands open the fullscreen terminal route. Goal
 * actions must never apply to a command selection or vice versa.
 */
export function resolveDashboardOpen(
  lists: DashboardLists,
  sel: DashboardSelection,
  ownerSessionID: string | undefined,
  returnSessionID: string | undefined,
): OpenTarget {
  if (sel.view === "goals") {
    const goal = lists.goals[sel.goalIndex]
    return resolveOpenTarget(
      { selection: goal ? { kind: "goal", workerSessionID: goal.workerSessionID } : null, ownerSessionID, returnSessionID },
    )
  }
  const ownerCommands = filterCommandsByOwner(lists.commands, ownerSessionID)
  const cmd = ownerCommands[sel.commandIndex]
  return resolveOpenTarget(
    {
      selection: cmd ? { kind: "command", commandID: cmd.id } : null,
      ownerSessionID,
      returnSessionID,
    },
  )
}

/** Commands view is always owner-scoped; empty owner shows nothing. */
export function visibleOwnerCommands(
  commands: CommandSession[] | undefined,
  ownerSessionID: string | undefined,
): CommandSession[] {
  return filterCommandsByOwner(commands ?? [], ownerSessionID)
}
