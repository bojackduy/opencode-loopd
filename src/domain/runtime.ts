// ─── Domain: Runtime ─────────────────────────────────────────────────────────
// Runtime execution state — separate from goal status.

import type { GoalID } from "./goal"

export type RuntimePhase =
  | "idle"       // no active run
  | "queued"     // scheduled but not started
  | "running"    // prompt sent, agent working
  | "compacting" // compaction in progress
  | "waiting_retry" // backoff before retry
  | "stopping"   // abort in flight

export type RunID = string & { readonly __brand: "RunID" }

export interface GoalRuntimeState {
  goalID: GoalID
  phase: RuntimePhase

  /** Active run identifier. */
  activeRunID?: RunID

  /** Lease prevents concurrent turns. Expires after timeoutMs. */
  leaseExpiresAt?: string

  /** Consecutive failures on current stage. Reset on success. */
  consecutiveFailures: number

  /** Last error message. */
  lastError?: string

  /** When to retry (ISO timestamp). */
  retryAfter?: string

  /** Run counter for this goal. */
  runCount: number

  /** Turn counter (incremented on each continuation). */
  turnCount: number

  /** Progress count from the no-progress guard. */
  noProgressCount: number

  /** Timestamps. */
  lastRunAt?: string
  lastProgressAt?: string
  lastCompactAt?: string
  createdAt: string
  updatedAt: string
}

export function createRuntimeState(goalID: GoalID): GoalRuntimeState {
  const now = new Date().toISOString()
  return {
    goalID,
    phase: "idle",
    consecutiveFailures: 0,
    runCount: 0,
    turnCount: 0,
    noProgressCount: 0,
    createdAt: now,
    updatedAt: now,
  }
}

export function acquireLease(rt: GoalRuntimeState, timeoutMs: number): GoalRuntimeState {
  const now = Date.now()
  const expires = new Date(now + timeoutMs).toISOString()
  return { ...rt, phase: "running", leaseExpiresAt: expires, updatedAt: new Date(now).toISOString() }
}

export function releaseLease(rt: GoalRuntimeState): GoalRuntimeState {
  return { ...rt, phase: "idle", leaseExpiresAt: undefined, updatedAt: new Date().toISOString() }
}

export function leaseIsValid(rt: GoalRuntimeState): boolean {
  if (!rt.leaseExpiresAt) return false
  return Date.now() < Date.parse(rt.leaseExpiresAt)
}
