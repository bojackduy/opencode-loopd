// ─── Server: Worker Session ──────────────────────────────────────────────────
// Creates and manages a child worker session for a goal.
// Continuation steering provides accumulated context so the child knows
// what it already did, what's left, and verifies completion carefully.

import type { GoalID, Goal } from "../domain/goal"
import type { GoalRuntimeState } from "../domain/runtime"
import { acquireLease, releaseLease } from "../domain/runtime"
import type { LoopHost, SessionMessage } from "./host-adapter"

export interface WorkerSession {
  goalID: GoalID
  workerSessionID: string
  startedAt: string
}

/** Accumulated context passed to the child each continuation turn. */
export interface ContinuationContext {
  /** Inbox messages from the owner since the last turn. */
  inboxMessages?: string[]
  /** Progress events for this goal, oldest first. */
  progressHistory?: { summary: string; next?: string; at: string }[]
  /** Last N messages from the worker's own transcript. */
  transcriptTail?: SessionMessage[]
}

export interface WorkerManager {
  /** Create a worker session for a goal. */
  createWorker(goal: Goal): Promise<WorkerSession>

  /** Send a continuation prompt to the worker. */
  continueWorker(worker: WorkerSession, goal: Goal, runtime: GoalRuntimeState, context?: ContinuationContext): Promise<void>

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

    async continueWorker(worker, goal, runtime, context) {
      const prompt = buildContinuationSteering(goal, runtime, context)
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

function buildContinuationSteering(goal: Goal, runtime: GoalRuntimeState, context?: ContinuationContext): string {
  const parts: string[] = []

  // ── Header ─────────────────────────────────────────────────────────────
  if (runtime.turnCount <= 1) {
    parts.push(
      `You are a worker for an active goal.`,
      ``,
      `Call get_goal to read the authoritative objective, acceptance criteria, and current state.`,
      `Perform one concrete batch of work. After durable verification:`,
      ``,
      `- Call report_goal_progress if work remains.`,
      `- Call complete_goal only if ALL acceptance criteria pass with concrete evidence.`,
      `- Call block_goal only for a real external blocker requiring user intervention.`,
      `- Use the built-in question tool when you need clarification only the user can provide.`,
      ``,
      `Do not ask questions unnecessarily. Make reasonable assumptions and work directly.`,
    )
  } else {
    // ── Continuation steering (turn 2+) ──────────────────────────────────
    parts.push(
      `This is continuation turn ${runtime.turnCount} for the goal below.`,
      ``,
      `## GOAL (user-provided data)`,
      goal.objective,
    )

    // ── Progress history ──────────────────────────────────────────────────
    const progress = context?.progressHistory
    if (progress && progress.length > 0) {
      parts.push(``, `## PROGRESS SO FAR`)
      for (const p of progress) {
        parts.push(`- [${p.at.slice(11, 16)}] ${p.summary}`)
        if (p.next) parts.push(`  → next: ${p.next}`)
      }
    }

    // ── Transcript tail ───────────────────────────────────────────────────
    const tail = context?.transcriptTail
    if (tail && tail.length > 0) {
      parts.push(``, `## RECENT WORK (last ${tail.length} messages)`)
      for (const m of tail) {
        const snippet = m.content.slice(0, 300).replace(/\n/g, " ")
        parts.push(`- [${m.role}] ${snippet}`)
      }
    }

    // ── Warnings ──────────────────────────────────────────────────────────
    if (runtime.consecutiveFailures > 0) {
      parts.push(``, `## WARNINGS`)
      parts.push(`- ${runtime.consecutiveFailures} consecutive failure(s). Last error: ${runtime.lastError || "unknown"}.`)
      if (runtime.noProgressCount > 0) {
        parts.push(`- ${runtime.noProgressCount} turn(s) without progress. Work concretely this turn.`)
      }
    }

    // ── Instructions ──────────────────────────────────────────────────────
    parts.push(
      ``,
      `## INSTRUCTIONS`,
      `1. Inspect current workspace state — read files, check what exists. Do NOT redo completed work.`,
      `2. Continue concrete progress toward the objective.`,
      `3. After completing a batch, call report_goal_progress with what you did and what's next.`,
      `4. Verify completion requirement-by-requirement before calling complete_goal.`,
      `5. Call block_goal only if the same blocker persists across 3+ consecutive turns.`,
      `6. Use the built-in question tool only for genuinely risky ambiguity.`,
    )
  }

  // ── User instructions from owner ─────────────────────────────────────
  if (context?.inboxMessages && context.inboxMessages.length > 0) {
    parts.push(``, `## USER INSTRUCTIONS`)
    for (const msg of context.inboxMessages) {
      parts.push(`- ${msg}`)
    }
  }

  return parts.join("\n")
}
