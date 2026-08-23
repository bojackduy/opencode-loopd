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

  /** When the current turn started (ISO timestamp). */
  turnStartedAt?: string

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

  /** Whether progress occurred during the current turn. */
  progressDuringTurn: boolean

  /** Last observed worker status from SDK. */
  lastWorkerStatus?: "idle" | "busy" | "retry"

  /** Number of tokens consumed during current turn. */
  turnTokensUsed?: number

  /** Whether the engine has already asked the child to wrap up . */
  forceFinishRequested?: boolean

  /** How many times the evaluator has rejected the child's completion claim. */
  evaluatorRejectionCount?: number

  /** Last parent notification dedup — prevents tool + engine double-inject. */
  lastParentNotifiedAt?: string
  lastParentNotifiedFor?: "complete" | "blocked" | "failed" | "stopped"

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
    progressDuringTurn: false,
    createdAt: now,
    updatedAt: now,
  }
}

export function acquireLease(rt: GoalRuntimeState, timeoutMs: number): GoalRuntimeState {
  const now = Date.now()
  const expires = new Date(now + timeoutMs).toISOString()
  return {
    ...rt,
    phase: "running",
    leaseExpiresAt: expires,
    turnStartedAt: new Date(now).toISOString(),
    progressDuringTurn: false,
    turnTokensUsed: 0,
    updatedAt: new Date(now).toISOString(),
  }
}

export function releaseLease(rt: GoalRuntimeState): GoalRuntimeState {
  return {
    ...rt,
    phase: "idle",
    leaseExpiresAt: undefined,
    turnStartedAt: undefined,
    updatedAt: new Date().toISOString(),
  }
}

export function leaseIsValid(rt: GoalRuntimeState): boolean {
  if (!rt.leaseExpiresAt) return false
  return Date.now() < Date.parse(rt.leaseExpiresAt)
}

export function markProgress(rt: GoalRuntimeState): GoalRuntimeState {
  return { ...rt, progressDuringTurn: true, lastProgressAt: new Date().toISOString() }
}

const PARENT_NOTIFY_DEDUPE_MS = 60_000

export function shouldNotifyParent(runtime: GoalRuntimeState, type: GoalRuntimeState["lastParentNotifiedFor"]): boolean {
  if (!runtime.lastParentNotifiedAt || !runtime.lastParentNotifiedFor) return true
  if (runtime.lastParentNotifiedFor !== type) return true
  const elapsed = Date.now() - Date.parse(runtime.lastParentNotifiedAt)
  return !Number.isFinite(elapsed) || elapsed > PARENT_NOTIFY_DEDUPE_MS
}

export function markParentNotified(runtime: GoalRuntimeState, type: NonNullable<GoalRuntimeState["lastParentNotifiedFor"]>): void {
  runtime.lastParentNotifiedFor = type
  runtime.lastParentNotifiedAt = new Date().toISOString()
  runtime.updatedAt = new Date().toISOString()
}
