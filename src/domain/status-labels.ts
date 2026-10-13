// ─── Domain: Status Labels ───────────────────────────────────────────────────
// Display-only labels for goal status (contract/ownership) vs runtime phase
// (worker activity right now). Stored enums never change; these map them to
// plain words so new users can tell "Active" from "Running" apart.
// TUI dashboard and owner-tool text both read this module.

import type { GoalStatus } from "./goal"
import type { GoalRuntimeState, RuntimePhase } from "./runtime"

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
  running: { short: "Reserved", hint: "turn reserved; activity unconfirmed" },
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

/** Stored running phase means a lease, not proof of worker execution. */
export function workerActivityLabel(runtime: GoalRuntimeState, now = Date.now()): StatusLabel & { acting: boolean } {
  if (runtime.phase !== "running") return { ...phaseLabel(runtime.phase), acting: false }
  if (runtime.executionSource === "native") {
    const status = runtime.nativeExecutionStatus
    if (status === "busy") return { short: "Running", hint: "OpenCode execution is active", acting: true }
    if (status === "retry") return { short: "Retrying", hint: "OpenCode is retrying execution", acting: false }
    if (status === "idle") return { short: "Finishing", hint: "OpenCode is idle; reconciling goal outcome", acting: false }
    return { short: "Unconfirmed", hint: "native execution state unavailable", acting: false }
  }
  const expires = runtime.leaseExpiresAt ? Date.parse(runtime.leaseExpiresAt) : NaN
  if (Number.isFinite(expires) && expires <= now) return { short: "Stale", hint: "lease expired; activity unconfirmed (not proof of worker exit)", acting: false }
  if (!Number.isFinite(expires) || (runtime.unknownStatusCount ?? 0) > 0) return { short: "Unconfirmed", hint: "worker status unavailable; do not assume the prompt failed", acting: false }
  if (runtime.activeAssistantCompletedAt) return { short: "Finishing", hint: "response completed; waiting for turn reconciliation", acting: false }
  if (runtime.activePromptObservedAt && runtime.lastWorkerStatus !== "idle" && runtime.lastWorkerStatus !== "retry" &&
      (runtime.activeAssistantMessageID || runtime.activeToolCallIDs?.length)) {
    return { short: "Running", hint: "correlated assistant or tool activity observed", acting: true }
  }
  if (runtime.activePromptObservedAt) return { short: "Prompt seen", hint: "prompt observed; response activity not confirmed", acting: false }
  if (runtime.activePromptAcceptedAt) return { short: "Awaiting", hint: "host accepted prompt; transcript activity not confirmed", acting: false }
  if (runtime.activePromptDispatchAt) return { short: "Sending", hint: "dispatch requested; awaiting host acceptance", acting: false }
  return { short: "Requested", hint: "run reserved; no dispatch evidence yet", acting: false }
}

/** One plain sentence combining ownership + current activity. */
export function describeGoalState(status: string, phase?: string | GoalRuntimeState, now = Date.now()): string {
  const goal = goalStatusLabel(status)
  const activity = phase ? typeof phase === "string" ? phaseLabel(phase) : workerActivityLabel(phase, now) : undefined
  const workerClause = activity
    ? `worker is ${activity.hint || activity.short.toLowerCase()}`
    : "worker state unknown"
  if (status === "active") return `Loopd owns this; ${workerClause}.`
  if (status === "complete") return "Done — verified; worker is stopped."
  return `Parked — ${goal.hint || goal.short.toLowerCase()}; ${workerClause}.`
}
