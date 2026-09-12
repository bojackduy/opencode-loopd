// ─── Domain: Events ──────────────────────────────────────────────────────────
// Typed engine events emitted by the server, consumed by TUI.

import type { GoalID, GoalStatus } from "./goal"
import type { RuntimePhase } from "./runtime"

export type EventVersion = 1

export interface BaseEvent {
  version: EventVersion
  eventID: string
  goalID: GoalID
  timestamp: string
  revision: number
}

// ─── Goal Events ─────────────────────────────────────────────────────────────

export interface GoalCreatedEvent extends BaseEvent {
  type: "goal.created"
  name: string
  objective: string
  ownerSessionID: string
}

export interface GoalStatusChangedEvent extends BaseEvent {
  type: "goal.status_changed"
  from: GoalStatus
  to: GoalStatus
}

export interface GoalProgressEvent extends BaseEvent {
  type: "goal.progress"
  summary: string
  next?: string
  verifiedCount?: number
}

export interface GoalCompletedEvent extends BaseEvent {
  type: "goal.completed"
  summary: string
  evidence: string
}

export interface GoalBlockedEvent extends BaseEvent {
  type: "goal.blocked"
  reason: string
  needed: string
}

export interface GoalClearedEvent extends BaseEvent {
  type: "goal.cleared"
}

export interface GoalCompletionRejectedEvent extends BaseEvent {
  type: "goal.completion_rejected"
  attemptID: string
  rejectionCount: number
  failedCheckCount: number
  failureSummary: string
}

// ─── Runtime Events ──────────────────────────────────────────────────────────

export interface RunStartedEvent extends BaseEvent {
  type: "run.started"
  runID: string
  turnCount: number
}

export interface RunCompletedEvent extends BaseEvent {
  type: "run.completed"
  runID: string
}

export interface RunFailedEvent extends BaseEvent {
  type: "run.failed"
  runID: string
  error: string
  consecutiveFailures: number
}

export interface IdleConfirmFailedEvent extends BaseEvent {
  type: "idle.confirm-failed"
  reason: "prompt-outside-window" | "assistant-incomplete" | "worker-active"
  runGeneration: number
}

export interface RunStuckEvent extends BaseEvent {
  type: "run.stuck"
  runID: string
  stuckSeconds: number
}

export interface RuntimePhaseChangedEvent extends BaseEvent {
  type: "runtime.phase_changed"
  from: RuntimePhase
  to: RuntimePhase
}

export interface CompactionStartedEvent extends BaseEvent {
  type: "compaction.started"
}

export interface CompactionCompletedEvent extends BaseEvent {
  type: "compaction.completed"
}

// ─── Command Response Events ─────────────────────────────────────────────────

export interface CommandAcceptedEvent extends BaseEvent {
  type: "command.accepted"
  requestID: string
  command: string
}

export interface CommandRejectedEvent extends BaseEvent {
  type: "command.rejected"
  requestID: string
  command: string
  reason: string
}

// ─── Union ───────────────────────────────────────────────────────────────────

export type LoopEvent =
  | GoalCreatedEvent
  | GoalStatusChangedEvent
  | GoalProgressEvent
  | GoalCompletedEvent
  | GoalBlockedEvent
  | GoalClearedEvent
  | GoalCompletionRejectedEvent
  | RunStartedEvent
  | RunCompletedEvent
  | RunFailedEvent
  | IdleConfirmFailedEvent
  | RunStuckEvent
  | RuntimePhaseChangedEvent
  | CompactionStartedEvent
  | CompactionCompletedEvent
  | CommandAcceptedEvent
  | CommandRejectedEvent
