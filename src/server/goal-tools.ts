// ─── Server: Goal Tools ──────────────────────────────────────────────────────
// Authoritative goal tools. Requires exact worker-session matching.
// Returns structured JSON for get_goal. Validates transitions.

import { randomUUID } from "crypto"
import { tool } from "@opencode-ai/plugin/tool"
import { readState, writeState, appendEvent } from "../infrastructure/state-repository"
import type { Goal, GoalID } from "../domain/goal"
import { canTransition } from "../domain/goal"
import type { GoalRuntimeState } from "../domain/runtime"
import { markProgress } from "../domain/runtime"
import type { LoopEvent } from "../domain/events"
import { exec as execChild } from "child_process"
import { promisify } from "util"

const execAsync = promisify(execChild)

export function goalTools(dir: string, hostSessionID?: string) {
  return {
    get_goal: tool({
      description:
        "Get the current goal state. Call at the start of every continuation turn " +
        "to retrieve the objective, current state, acceptance criteria, and recent failures.",
      args: {},
      execute: async (_args, context) => {
        const state = await readState(dir)
        const workerID = context?.sessionID || hostSessionID

        const goal = findGoalByWorkerSession(state, workerID)
        if (!goal) {
          return {
            title: "No active goal",
            output: JSON.stringify({
              status: "none",
              message: "No active goal found for this worker session.",
            }),
          }
        }

        const runtime = state.runtimes.find((r) => r.goalID === goal.id)

        return {
          title: `Goal: ${goal.name}`,
          output: formatGoalStructured(goal, runtime),
        }
      },
    }),

    report_goal_progress: tool({
      description:
        "Report meaningful progress on the current goal without completing it. " +
        "Call after durable state changes (file writes, verifications).",
      args: {
        summary: tool.schema.string().describe("What was accomplished."),
        next: tool.schema.string().describe("The next concrete step."),
        evidence: tool.schema.string().describe("Optional concrete evidence."),
      },
      execute: async (args, context) => {
        const state = await readState(dir)
        const workerID = context?.sessionID || hostSessionID
        const goal = findGoalByWorkerSession(state, workerID)
        if (!goal) {
          return { title: "No goal", output: "No active goal to report progress for." }
        }

        if (goal.status !== "active") {
          return { title: "Invalid state", output: `Goal is ${goal.status}, not active. Cannot report progress.` }
        }

        const runtime = state.runtimes.find((r) => r.goalID === goal.id)
        if (runtime) {
          Object.assign(runtime, markProgress(runtime))
          runtime.noProgressCount = 0
          runtime.consecutiveFailures = 0
        }

        // Persist progress on goal
        goal.lastProgress = {
          summary: args.summary,
          next: args.next,
          at: new Date().toISOString(),
        }

        await writeState(dir, state)

        const event: LoopEvent = {
          version: 1,
          eventID: randomUUID(),
          goalID: goal.id,
          type: "goal.progress",
          summary: args.summary,
          next: args.next,
          timestamp: new Date().toISOString(),
          revision: state.revision,
        }
        await appendEvent(dir, event)

        return {
          title: "Progress recorded",
          output: JSON.stringify({
            goalName: goal.name,
            summary: args.summary,
            next: args.next,
            turn: runtime?.turnCount,
          }),
        }
      },
    }),

    complete_goal: tool({
      description:
        "Mark the current goal as completed. " +
        "Use only when all acceptance criteria pass with concrete evidence. " +
        "Runs configured completion checks before accepting.",
      args: {
        summary: tool.schema.string().describe("What was completed."),
        evidence: tool.schema.string().describe("Concrete evidence of completion."),
      },
      execute: async (args, context) => {
        const state = await readState(dir)
        const workerID = context?.sessionID || hostSessionID
        const goal = findGoalByWorkerSession(state, workerID)
        if (!goal) {
          return { title: "No goal", output: "No active goal to complete." }
        }

        if (!canTransition(goal.status, "complete", "model")) {
          return { title: "Invalid transition", output: `Cannot complete goal in ${goal.status} state.` }
        }

        // Run completion checks
        if (goal.config.checks?.length) {
          const checkResults = await runCompletionChecks(goal.config.checks)
          if (!checkResults.passed) {
            return {
              title: "Checks failed",
              output: JSON.stringify({
                passed: false,
                failedChecks: checkResults.failures,
                message: "Completion checks failed. Fix issues and try again.",
              }),
            }
          }
        }

        goal.status = "complete"
        goal.updatedAt = new Date().toISOString()
        goal.completionEvidence = {
          summary: args.summary,
          evidence: args.evidence,
          at: new Date().toISOString(),
        }

        const runtime = state.runtimes.find((r) => r.goalID === goal.id)
        if (runtime) {
          runtime.phase = "idle"
          runtime.lastError = undefined
        }

        await writeState(dir, state)

        const event: LoopEvent = {
          version: 1,
          eventID: randomUUID(),
          goalID: goal.id,
          type: "goal.completed",
          summary: args.summary,
          evidence: args.evidence,
          timestamp: new Date().toISOString(),
          revision: state.revision,
        }
        await appendEvent(dir, event)

        return {
          title: "Goal completed",
          output: JSON.stringify({
            goalName: goal.name,
            status: "complete",
            summary: args.summary,
            evidence: args.evidence,
          }),
        }
      },
    }),

    block_goal: tool({
      description:
        "Mark the current goal as blocked. " +
        "Use only for a real external blocker requiring user intervention.",
      args: {
        reason: tool.schema.string().describe("Why the goal is blocked."),
        needed: tool.schema.string().describe("What is needed to unblock."),
      },
      execute: async (args, context) => {
        const state = await readState(dir)
        const workerID = context?.sessionID || hostSessionID
        const goal = findGoalByWorkerSession(state, workerID)
        if (!goal) {
          return { title: "No goal", output: "No active goal to block." }
        }

        if (!canTransition(goal.status, "blocked", "model")) {
          return { title: "Invalid transition", output: `Cannot block goal in ${goal.status} state.` }
        }

        goal.status = "blocked"
        goal.updatedAt = new Date().toISOString()
        goal.blocker = {
          reason: args.reason,
          needed: args.needed,
          at: new Date().toISOString(),
        }

        const runtime = state.runtimes.find((r) => r.goalID === goal.id)
        if (runtime) {
          runtime.phase = "idle"
          runtime.lastError = undefined
        }

        await writeState(dir, state)

        const event: LoopEvent = {
          version: 1,
          eventID: randomUUID(),
          goalID: goal.id,
          type: "goal.blocked",
          reason: args.reason,
          needed: args.needed,
          timestamp: new Date().toISOString(),
          revision: state.revision,
        }
        await appendEvent(dir, event)

        return {
          title: "Goal blocked",
          output: JSON.stringify({
            goalName: goal.name,
            status: "blocked",
            reason: args.reason,
            needed: args.needed,
          }),
        }
      },
    }),
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function findGoalByWorkerSession(
  state: { goals: Goal[]; runtimes: GoalRuntimeState[] },
  sessionID?: string,
): Goal | undefined {
  if (!sessionID) return undefined

  // Match by worker session ID (exact match required)
  return state.goals.find(
    (g) => g.workerSessionID === sessionID && (g.status === "active" || g.status === "blocked"),
  )
}

function formatGoalStructured(goal: Goal, runtime?: GoalRuntimeState): string {
  const output: Record<string, any> = {
    id: goal.id,
    name: goal.name,
    objective: goal.objective,
    status: goal.status,
    ownerSessionID: goal.ownerSessionID,
    workerSessionID: goal.workerSessionID,
    config: {
      promptFile: goal.config.promptFile,
      progressFile: goal.config.progressFile,
      includeFiles: goal.config.includeFiles,
      checks: goal.config.checks,
      maxTurns: goal.config.maxTurns,
      maxNoProgress: goal.config.maxNoProgress,
      maxFailures: goal.config.maxFailures,
      compactEvery: goal.config.compactEvery,
      timeoutMs: goal.config.timeoutMs,
    },
    lastProgress: goal.lastProgress,
    completionEvidence: goal.completionEvidence,
    blocker: goal.blocker,
    tokensUsed: goal.tokensUsed,
    timeUsedSeconds: goal.timeUsedSeconds,
  }

  if (runtime) {
    output.runtime = {
      phase: runtime.phase,
      turnCount: runtime.turnCount,
      runCount: runtime.runCount,
      consecutiveFailures: runtime.consecutiveFailures,
      noProgressCount: runtime.noProgressCount,
      lastError: runtime.lastError,
      lastProgressAt: runtime.lastProgressAt,
      lastRunAt: runtime.lastRunAt,
      lastCompactAt: runtime.lastCompactAt,
    }
  }

  return JSON.stringify(output, null, 2)
}

interface CheckResult {
  passed: boolean
  failures: Array<{ command: string; exitCode: number; stderr: string }>
}

async function runCompletionChecks(checks: string[]): Promise<CheckResult> {
  const failures: CheckResult["failures"] = []

  for (const cmd of checks) {
    try {
      await execAsync(cmd, { timeout: 30_000 })
    } catch (error: any) {
      failures.push({
        command: cmd,
        exitCode: error.code || 1,
        stderr: error.stderr || error.message || "unknown error",
      })
    }
  }

  return {
    passed: failures.length === 0,
    failures,
  }
}
