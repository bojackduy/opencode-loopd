// ─── Domain: Goal ────────────────────────────────────────────────────────────
// Core goal model, statuses, and transition rules.

export type GoalStatus =
  | "active"
  | "paused"
  | "blocked"
  | "budget_limited"
  | "usage_limited"
  | "complete"

export type GoalID = string & { readonly __brand: "GoalID" }

export interface Goal {
  id: GoalID
  name: string
  objective: string
  status: GoalStatus

  /** Where the goal was created (owner session). */
  ownerSessionID: string

  /** Worker session doing the actual work. Created on start. */
  workerSessionID?: string

  /** Token budget. undefined = unlimited. */
  tokenBudget?: number

  /** Tokens consumed so far. */
  tokensUsed: number

  /** Wall-clock seconds consumed. */
  timeUsedSeconds: number

  /** Config files — read-only references the engine injects into steering. */
  config: GoalConfig

  /** Latest progress summary persisted by the model. */
  lastProgress?: {
    summary: string
    next?: string
    at: string
  }

  /** Completion evidence persisted by the model. */
  completionEvidence?: {
    summary: string
    evidence: string
    at: string
  }

  /** Blocker details persisted by the model. */
  blocker?: {
    reason: string
    needed: string
    at: string
  }

  createdAt: string
  updatedAt: string
}

export interface GoalConfig {
  /** Markdown file with the loop contract. */
  promptFile?: string

  /** Markdown/JSON file the engine reads for transaction state. */
  progressFile?: string

  /** Extra files to inject into continuation prompts. */
  includeFiles?: string[]

  /** Shell commands that must pass for completion to be accepted. */
  checks?: string[]

  /** Directory where completion checks run. Defaults to the artifact directory. */
  checkCwd?: string

  /** Whether this goal mutates the shared project workspace. Such goals are exclusive. */
  workspaceWrite?: boolean

  /** Max turns before auto-pause. */
  maxTurns?: number

  /** Auto-pause after N turns without progress. */
  maxNoProgress?: number

  /** Auto-pause after N failures. */
  maxFailures?: number

  /** Compact every N turns. */
  compactEvery?: number

  /** Timeout per turn (ms). */
  timeoutMs?: number

  /** Max evaluator rejections before the goal is blocked. Defaults to 3. */
  maxEvaluatorRejections?: number

  /** Per-goal artifact directory. Computed at creation; not user-supplied. */
  artifactDir?: string

  /** Agent that runs the worker session. Defaults to primary. */
  agent?: string
}

// ─── Transition Rules ────────────────────────────────────────────────────────

/** Model-controlled transitions (via tools). */
export const MODEL_TRANSITIONS: Record<GoalStatus, GoalStatus[]> = {
  active: ["complete", "blocked"],
  paused: [],
  blocked: [],
  budget_limited: ["complete", "blocked"],
  usage_limited: [],
  complete: [],
}

/** User/system-controlled transitions (via control API). */
export const USER_TRANSITIONS: Record<GoalStatus, GoalStatus[]> = {
  active: ["paused"],
  paused: ["active"],
  blocked: ["active"],
  budget_limited: ["active"],
  usage_limited: ["active"],
  complete: ["active"],
}

/** System-internal transitions (engine-driven). */
export const SYSTEM_TRANSITIONS: Record<GoalStatus, GoalStatus[]> = {
  active: ["budget_limited", "usage_limited"],
  paused: [],
  blocked: [],
  budget_limited: [],
  usage_limited: [],
  complete: [],
}

export function canTransition(
  current: GoalStatus,
  target: GoalStatus,
  caller: "model" | "user" | "system",
): boolean {
  const table =
    caller === "model"
      ? MODEL_TRANSITIONS
      : caller === "user"
        ? USER_TRANSITIONS
        : SYSTEM_TRANSITIONS
  return table[current]?.includes(target) ?? false
}

export function isTerminal(status: GoalStatus): boolean {
  return status === "complete"
}

export function isRunning(status: GoalStatus): boolean {
  return status === "active" || status === "blocked" || status === "budget_limited" || status === "usage_limited"
}

export function createGoal(
  input: Omit<Goal, "tokensUsed" | "timeUsedSeconds" | "createdAt" | "updatedAt">,
): Goal {
  const now = new Date().toISOString()
  return { ...input, tokensUsed: 0, timeUsedSeconds: 0, createdAt: now, updatedAt: now }
}
