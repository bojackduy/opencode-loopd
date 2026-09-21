// ─── Domain: Status Labels ───────────────────────────────────────────────────
// Display-only labels for goal status (contract/ownership) vs runtime phase
// (worker activity right now). Stored enums never change; these map them to
// plain words so new users can tell "Active" from "Running" apart.
// TUI dashboard and owner-tool text both read this module.

import type { GoalStatus } from "./goal"
import type { RuntimePhase } from "./runtime"

export interface StatusLabel {
  short: string
  hint: string
}

export const GOAL_STATUS_META: Record<GoalStatus, StatusLabel> = {
  active: { short: "Active", hint: "loopd owns it" },
  paused: { short: "Paused", hint: "stopped by you" },
  blocked: { short: "Blocked", hint: "needs you" },
  budget_limited: { short: "Out of budget", hint: "resume to spend" },
  usage_limited: { short: "Waiting for capacity", hint: "auto-resumes" },
  complete: { short: "Done", hint: "verified" },
}

export const PHASE_META: Record<RuntimePhase, StatusLabel> = {
  idle: { short: "Idle", hint: "between turns" },
  queued: { short: "Queued", hint: "waiting to start" },
  running: { short: "Running", hint: "worker acting now" },
  compacting: { short: "Compacting", hint: "summarizing context" },
  waiting_retry: { short: "Retrying", hint: "backing off" },
  stopping: { short: "Stopping", hint: "abort in flight" },
}

export function goalStatusLabel(status: string): StatusLabel {
  return (GOAL_STATUS_META as Record<string, StatusLabel>)[status]
    ?? { short: status, hint: "" }
}

export function phaseLabel(phase: string): StatusLabel {
  return (PHASE_META as Record<string, StatusLabel>)[phase]
    ?? { short: phase, hint: "" }
}

/** One plain sentence combining ownership + current activity. */
export function describeGoalState(status: string, phase?: string): string {
  const goal = goalStatusLabel(status)
  const activity = phase ? phaseLabel(phase) : undefined
  const workerClause = activity
    ? `worker is ${activity.hint || activity.short.toLowerCase()}`
    : "worker state unknown"
  if (status === "active") return `Loopd owns this; ${workerClause}.`
  if (status === "complete") return "Done — verified; worker is stopped."
  return `Parked — ${goal.hint || goal.short.toLowerCase()}; ${workerClause}.`
}
