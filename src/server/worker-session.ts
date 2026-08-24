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
  /** When set, the engine requires the child to wrap up . */
  forceFinish?: boolean
  /** Deterministic verification pre-screen (host-owned, not semantic judgment). */
  verification?: {
    checksPassed?: boolean
    failedChecks?: string[]
    artifactSummary?: string
    evaluatorRejectionCount?: number
    lastRejectionDetails?: string
  }
}

export interface WorkerManager {
  /** Create a worker session for a goal. */
  createWorker(goal: Goal): Promise<WorkerSession>

  /** Send a continuation prompt to the worker. Returns the SDK messageID. */
  continueWorker(worker: WorkerSession, goal: Goal, runtime: GoalRuntimeState, context?: ContinuationContext): Promise<{ messageID?: string }>

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
        agent: goal.config.agent,
      })

      return {
        goalID: goal.id,
        workerSessionID,
        startedAt: new Date().toISOString(),
      }
    },

    async continueWorker(worker, goal, runtime, context) {
      const prompt = buildContinuationSteering(goal, runtime, context)
      const result = await host.promptWorker({
        sessionID: worker.workerSessionID,
        prompt,
        messageID: runtime.activePromptMessageID,
        agent: goal.config.agent,
      })
      return result
    },

    async isIdle(workerSessionID: string) {
      const status = await host.sessionStatus(workerSessionID)
      // Only trust confirmed idle; unknown means don't act
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

  const artifactDir = (goal.config as any).artifactDir as string | undefined
  function outputLocationBlock(): string[] {
    if (!artifactDir) return []
    return [
      ``,
      `## OUTPUT LOCATION`,
      `Write all files, logs, and artifacts under:`,
      artifactDir,
      ``,
      `Exception: if the objective explicitly specifies a different output directory, follow the objective instead.`,
    ]
  }

  // ── Header ─────────────────────────────────────────────────────────────
  if (runtime.runCount <= 1) {
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
    parts.push(...outputLocationBlock())
  } else {
    // ── Continuation steering (turn 2+) ──────────────────────────────────
    parts.push(
      `This is continuation run ${runtime.runCount} for the goal below.`,
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

    // ── Output location (turn 2+) ─────────────────────────────────────────
    parts.push(...outputLocationBlock())

    // ── Host verdict (deterministic, host-owned) ────────────────────────────
    if (context?.verification) {
      const v = context.verification

      // If there was a recent rejection, show the EXACT host verdict
      if (v.evaluatorRejectionCount && v.evaluatorRejectionCount > 0) {
        parts.push(``, `## HOST VERDICT: COMPLETION REJECTED`)
        parts.push(`Rejection #${v.evaluatorRejectionCount}`)
        if (v.lastRejectionDetails) {
          parts.push(v.lastRejectionDetails)
        }
        parts.push(``, `Required action:`)
        parts.push(`- Fix the behavior causing the command(s) above to fail.`)
        parts.push(`- Do NOT merely rewrite the completion evidence.`)
        parts.push(`- Rerun the command from the stated directory.`)
        parts.push(`- Call complete_goal only after the command passes.`)
      } else {
        // Normal verification pre-screen
        parts.push(``, `## VERIFICATION (deterministic pre-screen)`)
        if (v.checksPassed !== undefined) {
          if (v.checksPassed) parts.push(`- checks: all passed`)
          else if (v.failedChecks?.length) parts.push(`- checks FAILED: ${v.failedChecks.join(", ")} — fix before claiming completion`)
          else parts.push(`- checks: not yet run`)
        }
        if (v.artifactSummary) parts.push(`- artifacts: ${v.artifactSummary}`)
      }
    }

    // ── Completion review — model proposes, host decides ─────────────────────
    parts.push(
      ``,
      `## COMPLETION REVIEW`,
      `You are the semantic reviewer. The host is the acceptance authority.`,
      `Before proposing completion:`,
      `1. Derive concrete requirements from the objective and any referenced files/plans/specs/issues.`,
      `2. For each requirement, identify authoritative evidence: files, command output, test results.`,
      `3. Judge each: proves | contradicts | incomplete | missing.`,
      `4. Only call complete_goal when you have verified every requirement yourself.`,
      `5. If objective and checks appear contradictory, call block_goal — do not silently violate either.`,
    )

    // ── Force-finish vs normal instructions ────────────────────────────────
    if (context?.forceFinish) {
      parts.push(
        ``,
        `## FINAL REPORT REQUIRED — STOPPING SOON`,
        `The system requires you to wrap up now. Do NOT start new work.`,
        `Call complete_goal NOW with:`,
        `- summary: a specific semantic summary of what was accomplished (files changed, results, key findings)`,
        `- evidence: concrete proof (commands run, files created, checks passed)`,
        `If you cannot complete truthfully, call block_goal with the reason — do not fabricate evidence.`,
      )
    } else {
      parts.push(
        ``,
        `## INSTRUCTIONS`,
        `1. Inspect current workspace state — read files, check what exists. Do NOT redo completed work.`,
        `2. Continue concrete progress toward the objective.`,
        `3. After completing a batch, call report_goal_progress with what you did and what's next.`,
        `4. Use the built-in question tool only for genuinely risky ambiguity.`,
      )
    }
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
