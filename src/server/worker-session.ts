// ─── Server: Worker Session ──────────────────────────────────────────────────
// Creates and manages a child worker session for a goal.

import type { GoalID, Goal } from "../domain/goal"
import type { GoalRuntimeState } from "../domain/runtime"
import { acquireLease, releaseLease } from "../domain/runtime"
import type { LoopHost } from "./host-adapter"

const CONTINUATION_PROMPT = `You are a worker for an active goal.

Call get_goal to retrieve the authoritative objective, current state, acceptance criteria, and recent failures. Perform one meaningful batch of work. After durable verification:

- Call report_goal_progress if work remains.
- Call complete_goal only if all acceptance criteria pass with concrete evidence.
- Call block_goal only for a real external blocker requiring user intervention.

Do not ask questions. Make reasonable assumptions. Work directly.`

export interface WorkerSession {
  goalID: GoalID
  workerSessionID: string
  startedAt: string
}

export interface WorkerManager {
  /** Create a worker session for a goal. */
  createWorker(goal: Goal): Promise<WorkerSession>

  /** Send a continuation prompt to the worker. */
  continueWorker(worker: WorkerSession, goal: Goal, runtime: GoalRuntimeState): Promise<void>

  /** Check if the worker session is idle. */
  isIdle(workerSessionID: string): Promise<boolean>

  /** Abort the worker. */
  abortWorker(workerSessionID: string): Promise<void>

  /** Compact a worker session. */
  compactWorker(workerSessionID: string): Promise<void>
}

export function createWorkerManager(host: LoopHost): WorkerManager {
  return {
    async createWorker(goal: Goal) {
      const workerSessionID = await host.createWorker({
        parentID: goal.ownerSessionID,
        title: `loopd: ${goal.name}`,
      })

      return {
        goalID: goal.id,
        workerSessionID,
        startedAt: new Date().toISOString(),
      }
    },

    async continueWorker(worker, goal, runtime) {
      const prompt = buildContinuationPrompt(goal, runtime)
      await host.promptWorker({
        sessionID: worker.workerSessionID,
        prompt,
      })
    },

    async isIdle(workerSessionID: string) {
      const status = await host.sessionStatus(workerSessionID)
      return status === "idle"
    },

    async abortWorker(workerSessionID: string) {
      await host.abortSession(workerSessionID)
    },

    async compactWorker(workerSessionID: string) {
      await host.compactSession(workerSessionID)
    },
  }
}

function buildContinuationPrompt(goal: Goal, runtime: GoalRuntimeState): string {
  const parts = [CONTINUATION_PROMPT]

  if (runtime.turnCount > 1) {
    parts.push(`\nThis is turn ${runtime.turnCount}.`)
  }

  if (runtime.consecutiveFailures > 0) {
    parts.push(`\nWarning: ${runtime.consecutiveFailures} consecutive failure(s). Last error: ${runtime.lastError || "unknown"}.`)
  }

  return parts.join("\n")
}
