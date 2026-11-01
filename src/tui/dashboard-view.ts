// ─── TUI: Shared Dashboard View State (headless-testable) ─────────────────────
// `/loop` and `/commands` open the SAME dashboard; this module owns the
// Goals/Commands tab state, per-view selection, and `o` dispatch so the
// component (dashboard.tsx) stays a thin renderer. No OpenCode TUI imports.

import { filterCommandsByOwner, resolveOpenTarget, type OpenTarget } from "./terminal-route"
import { TERMINAL_COMMAND_STATUSES } from "../domain/command-await"
import type { CommandSession } from "../domain/command-session"
import type { Goal } from "../domain/goal"

export type DashboardView = "project" | "fleet" | "commands"

/** Legacy alias: the goals tab is now the Project tab (one managed directory). */
export type GoalsView = Extract<DashboardView, "project">

export function toggleDashboardView(view: DashboardView): DashboardView {
  if (view === "project") return "fleet"
  if (view === "fleet") return "commands"
  return "project"
}

export function toggleDashboardViewBack(view: DashboardView): DashboardView {
  if (view === "project") return "commands"
  if (view === "fleet") return "project"
  return "fleet"
}

/**
 * Tab selection keys: `1` Project, `2` Fleet, `3` Commands.
 * Legacy `h`/`l` tab keys are retired so `h` is exclusively history.
 */
export function dashboardViewForKey(key: string): DashboardView | undefined {
  if (key === "1") return "project"
  if (key === "2") return "fleet"
  if (key === "3") return "commands"
  return undefined
}

export interface DashboardSelection {
  view: DashboardView
  goalIndex: number
  commandIndex: number
}

/** Stable row identity across refresh/filter/history/collapse. */
export function goalSelectionKey(directory: string, goalID: string): string {
  return `${directory}\n${goalID}`
}

export function initialDashboardSelection(view: DashboardView = "project"): DashboardSelection {
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
  if (sel.view !== "commands") {
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
 * Command indexes use the same completed visibility as rendering/movement.
 */
export function resolveDashboardOpen(
  lists: DashboardLists,
  sel: DashboardSelection,
  ownerSessionID: string | undefined,
  returnSessionID: string | undefined,
  showCompleted = false,
): OpenTarget {
  if (sel.view === "project" || sel.view === "fleet") {
    const goal = lists.goals[sel.goalIndex]
    return resolveOpenTarget(
      { selection: goal ? { kind: "goal", workerSessionID: goal.workerSessionID } : null, ownerSessionID, returnSessionID },
    )
  }
  const ownerCommands = visibleOwnerCommands(lists.commands, ownerSessionID, showCompleted)
  const cmd = ownerCommands[sel.commandIndex]
  return resolveOpenTarget(
    {
      selection: cmd ? { kind: "command", commandID: cmd.id } : null,
      ownerSessionID,
      returnSessionID,
    },
  )
}

/**
 * Commands view is always owner-scoped; empty owner shows nothing.
 *
 * Finished commands (exited/terminated/missing) are hidden by default so the
 * list shows live work — the same rule the Goals tab applies to `complete`
 * goals via the `c` toggle. Pass showCompleted=true to reveal them.
 */
export function visibleOwnerCommands(
  commands: CommandSession[] | undefined,
  ownerSessionID: string | undefined,
  showCompleted = false,
): CommandSession[] {
  const owned = filterCommandsByOwner(commands ?? [], ownerSessionID)
  if (showCompleted) return owned
  const terminal = TERMINAL_COMMAND_STATUSES as readonly string[]
  return owned.filter((c) => !terminal.includes(c.status))
}

/** Resolve a stable selection key back to a row index after re-filtering. */
export function indexForSelectionKey(
  keysInOrder: string[],
  key: string | undefined,
): number {
  if (!key) return 0
  const idx = keysInOrder.indexOf(key)
  return idx < 0 ? 0 : idx
}

/** Toggle a directory in the Fleet collapse set. */
export function toggleCollapsed(collapsed: string[], directory: string): string[] {
  return collapsed.includes(directory)
    ? collapsed.filter((d) => d !== directory)
    : [...collapsed, directory]
}
