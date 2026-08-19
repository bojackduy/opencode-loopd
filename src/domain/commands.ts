// ─── Domain: Commands ────────────────────────────────────────────────────────
// Typed control commands from TUI → server engine.

import type { GoalID } from "./goal"
import type { GoalConfig } from "./goal"

export type CommandVersion = 1

export interface BaseCommand {
  version: CommandVersion
  requestID: string
  goalID?: GoalID
  requestedAt: string
}

// ─── Goal Lifecycle ──────────────────────────────────────────────────────────

export interface StartGoalCommand extends BaseCommand {
  command: "start"
  args: {
    name: string
    objective: string
    config: GoalConfig
  }
}

export interface PauseGoalCommand extends BaseCommand {
  command: "pause"
}

export interface ResumeGoalCommand extends BaseCommand {
  command: "resume"
}

export interface RetryGoalCommand extends BaseCommand {
  command: "retry"
}

export interface ClearGoalCommand extends BaseCommand {
  command: "clear"
}

export interface UpdateGoalCommand extends BaseCommand {
  command: "update"
  args: {
    objective?: string
    config?: Partial<GoalConfig>
  }
}

// ─── Engine Control ──────────────────────────────────────────────────────────

export interface CompactCommand extends BaseCommand {
  command: "compact"
}

export interface InspectCommand extends BaseCommand {
  command: "inspect"
  args: {
    what: "state" | "runtime" | "logs" | "progress"
  }
}

export interface OpenWorkerCommand extends BaseCommand {
  command: "open_worker"
}

// ─── Union ───────────────────────────────────────────────────────────────────

export type LoopCommand =
  | StartGoalCommand
  | PauseGoalCommand
  | ResumeGoalCommand
  | RetryGoalCommand
  | ClearGoalCommand
  | UpdateGoalCommand
  | CompactCommand
  | InspectCommand
  | OpenWorkerCommand

export type CommandName = LoopCommand["command"]
