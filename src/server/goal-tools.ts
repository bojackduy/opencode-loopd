// ─── Server: Goal Tools ──────────────────────────────────────────────────────
// Real goal tools that read/update goal state. Called by the worker session.

import { randomUUID } from "crypto"
import { tool } from "@opencode-ai/plugin/tool"
import { readState, writeState, appendEvent } from "../infrastructure/state-store"
import type { Goal, GoalID } from "../domain/goal"
import type { GoalRuntimeState } from "../domain/runtime"
import type { LoopEvent } from "../domain/events"

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

        // Find goal by worker session ID or owner session
        const goal = findGoalBySession(state, workerID)
        if (!goal) {
          return {
            title: "No active goal",
            output: JSON.stringify({
              status: "none",
              message: "No active goal found for this session.",
            }),
          }
        }

        const runtime = state.runtimes.find((r) => r.goalID === goal.id)

        return {
          title: `Goal: ${goal.name}`,
          output: formatGoalForModel(goal, runtime),
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
        const goal = findGoalBySession(state, workerID)
        if (!goal) {
          return { title: "No goal", output: "No active goal to report progress for." }
        }

        const runtime = state.runtimes.find((r) => r.goalID === goal.id)
        if (runtime) {
          runtime.noProgressCount = 0
          runtime.lastProgressAt = new Date().toISOString()
          runtime.consecutiveFailures = 0
          await writeState(dir, state)
        }

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
          output: `Progress on "${goal.name}": ${args.summary}\nNext: ${args.next}`,
        }
      },
    }),

    update_goal: tool({
      description:
        "Mark the current goal as completed or blocked. " +
        "Use complete only when all acceptance criteria pass with concrete evidence. " +
        "Use blocked only for a real external blocker requiring user intervention.",
      args: {
        status: tool.schema.enum(["complete", "blocked"]).describe("Terminal status."),
        summary: tool.schema.string().describe("What was completed or why blocked."),
        evidence: tool.schema.string().describe("Concrete evidence."),
        needed: tool.schema.string().describe("For blocked: what is needed to unblock."),
      },
      execute: async (args, context) => {
        const state = await readState(dir)
        const workerID = context?.sessionID || hostSessionID
        const goal = findGoalBySession(state, workerID)
        if (!goal) {
          return { title: "No goal", output: "No active goal to update." }
        }

        const from = goal.status
        goal.status = args.status as GoalStatus
        goal.updatedAt = new Date().toISOString()

        const runtime = state.runtimes.find((r) => r.goalID === goal.id)
        if (runtime) {
          runtime.phase = "idle"
          runtime.lastError = undefined
          runtime.updatedAt = new Date().toISOString()
        }

        await writeState(dir, state)

        const event: LoopEvent = {
          version: 1,
          eventID: randomUUID(),
          goalID: goal.id,
          type: args.status === "complete" ? "goal.completed" : "goal.blocked",
          ...(args.status === "complete"
            ? { summary: args.summary, evidence: args.evidence || "" }
            : { reason: args.summary, needed: args.needed || "" }),
          timestamp: new Date().toISOString(),
          revision: state.revision,
        } as LoopEvent
        await appendEvent(dir, event)

        return {
          title: `Goal ${args.status}`,
          output: `Goal "${goal.name}" marked as ${args.status}.\nSummary: ${args.summary}\nEvidence: ${args.evidence || "none"}`,
        }
      },
    }),
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function findGoalBySession(
  state: { goals: Goal[]; runtimes: GoalRuntimeState[] },
  sessionID?: string,
): Goal | undefined {
  if (!sessionID) {
    // Fall back to first active/blocked goal
    return state.goals.find((g) => g.status === "active" || g.status === "blocked")
  }

  // Match by worker session ID
  const byWorker = state.goals.find(
    (g) => g.workerSessionID === sessionID && (g.status === "active" || g.status === "blocked"),
  )
  if (byWorker) return byWorker

  // Match by owner session ID
  return state.goals.find(
    (g) => g.ownerSessionID === sessionID && (g.status === "active" || g.status === "blocked"),
  )
}

function formatGoalForModel(goal: Goal, runtime?: GoalRuntimeState): string {
  const lines = [
    `Goal: ${goal.name}`,
    `Objective: ${goal.objective}`,
    `Status: ${goal.status}`,
  ]

  if (goal.config.progressFile) {
    lines.push(`Progress file: ${goal.config.progressFile}`)
  }

  if (goal.config.checks?.length) {
    lines.push(`Checks: ${goal.config.checks.join(", ")}`)
  }

  if (runtime) {
    lines.push(`Turn: ${runtime.turnCount}`)
    lines.push(`Failures: ${runtime.consecutiveFailures}`)
    if (runtime.lastError) {
      lines.push(`Last error: ${runtime.lastError}`)
    }
  }

  return lines.join("\n")
}

type GoalStatus = Goal["status"]
