// ─── Server: Owner Tools ────────────────────────────────────────────────────
// Tools for the PARENT agent to inspect and interact with background goals.
// Matched by ownerSessionID (the session that created the goal).

import { tool } from "@opencode-ai/plugin/tool"
import { readState, writeState, appendGoalInbox } from "../infrastructure/state-repository"
import type { GoalID } from "../domain/goal"
import type { LoopHost } from "./host-adapter"

export interface OwnerToolsOptions {
  directory: string
  host: LoopHost
}

export function ownerTools(options: OwnerToolsOptions) {
  const { directory, host } = options

  return {
    list_background_goals: tool({
      description:
        "List all background loop goals visible to this session. " +
        "Shows name, status, progress, and whether any goal is waiting for user input.",
      args: {},
      execute: async (_args, context) => {
        const state = await readState(directory)
        const ownerID = context?.sessionID
        if (!ownerID) {
          return {
            title: "No session",
            output: JSON.stringify({ ok: false, message: "No session context available." }),
          }
        }

        const goals = state.goals.filter(
          (g) => g.ownerSessionID === ownerID && g.status !== "complete",
        )
        if (goals.length === 0) {
          return {
            title: "No active goals",
            output: JSON.stringify({
              ok: true,
              goals: [],
              message: "No active background goals for this session.",
            }),
          }
        }

        const summaries = goals.map((g) => {
          const runtime = state.runtimes.find((r) => r.goalID === g.id)
          return {
            id: g.id,
            name: g.name,
            status: g.status,
            phase: runtime?.phase ?? "unknown",
            turn: runtime?.turnCount ?? 0,
            lastProgress: g.lastProgress?.summary?.slice(0, 120),
            lastProgressAt: g.lastProgress?.at,
            blocker: g.blocker?.reason?.slice(0, 120),
            question: g.question?.text?.slice(0, 120),
          }
        })

        return {
          title: `${goals.length} active goal(s)`,
          output: JSON.stringify({ ok: true, goals: summaries }, null, 2),
        }
      },
    }),

    inspect_background_goal: tool({
      description:
        "Inspect a background goal in detail: objective, contract, progress, " +
        "blockers, questions, runtime state, and recent events.",
      args: {
        goal_id: tool.schema.string().optional().describe("Goal ID. Omit to inspect the first active goal."),
      },
      execute: async (args, context) => {
        const state = await readState(directory)
        const ownerID = context?.sessionID
        const goal = args.goal_id
          ? state.goals.find((g) => g.id === args.goal_id && g.ownerSessionID === ownerID)
          : state.goals.find((g) => g.ownerSessionID === ownerID && g.status !== "complete")

        if (!goal) {
          return {
            title: "No goal found",
            output: JSON.stringify({ ok: false, message: "No matching active goal for this session." }),
          }
        }

        const runtime = state.runtimes.find((r) => r.goalID === goal.id)

        return {
          title: `Goal: ${goal.name}`,
          output: JSON.stringify({
            ok: true,
            id: goal.id,
            name: goal.name,
            objective: goal.objective,
            status: goal.status,
            ownerSessionID: goal.ownerSessionID,
            workerSessionID: goal.workerSessionID,
            config: {
              maxTurns: goal.config.maxTurns,
              maxFailures: goal.config.maxFailures,
              timeoutMs: goal.config.timeoutMs,
              progressFile: goal.config.progressFile,
              checks: goal.config.checks,
            },
            lastProgress: goal.lastProgress,
            completionEvidence: goal.completionEvidence,
            blocker: goal.blocker,
            question: goal.question,
            tokensUsed: goal.tokensUsed,
            timeUsedSeconds: goal.timeUsedSeconds,
            runtime: runtime ? {
              phase: runtime.phase,
              turnCount: runtime.turnCount,
              runCount: runtime.runCount,
              consecutiveFailures: runtime.consecutiveFailures,
              lastError: runtime.lastError,
              lastProgressAt: runtime.lastProgressAt,
              lastRunAt: runtime.lastRunAt,
            } : undefined,
          }, null, 2),
        }
      },
    }),

    read_goal_transcript: tool({
      description:
        "Read the last N messages from a goal's worker session transcript. " +
        "Shows what the worker has been doing: tool calls, file changes, responses.",
      args: {
        goal_id: tool.schema.string().optional().describe("Goal ID. Omit to read the first active goal."),
        limit: tool.schema.number().optional().describe("Max messages to return (default: 20)."),
      },
      execute: async (args, context) => {
        const state = await readState(directory)
        const ownerID = context?.sessionID
        const goal = args.goal_id
          ? state.goals.find((g) => g.id === args.goal_id && g.ownerSessionID === ownerID)
          : state.goals.find((g) => g.ownerSessionID === ownerID && g.status !== "complete")

        if (!goal) {
          return {
            title: "No goal found",
            output: JSON.stringify({ ok: false, message: "No matching active goal for this session." }),
          }
        }
        if (!goal.workerSessionID) {
          return {
            title: "No worker",
            output: JSON.stringify({ ok: false, message: "Goal has no worker session yet." }),
          }
        }

        try {
          const messages = await host.readMessages(goal.workerSessionID, args.limit || 20)
          return {
            title: `Transcript: ${goal.name}`,
            output: JSON.stringify({
              ok: true,
              goalID: goal.id,
              workerSessionID: goal.workerSessionID,
              messages: messages.map((m) => ({
                role: m.role,
                content: m.content.slice(0, 2000),
                timestamp: m.timestamp,
                messageID: m.messageID,
              })),
            }, null, 2),
          }
        } catch (error) {
          return {
            title: "Transcript error",
            output: JSON.stringify({
              ok: false,
              message: error instanceof Error ? error.message : String(error),
            }),
          }
        }
      },
    }),

    send_goal_input: tool({
      description:
        "Send a message, instruction, or answer to a background goal's worker session. " +
        "The message will be injected into the worker's next continuation prompt. " +
        "Use this to answer worker questions, redirect work, or refine scope.",
      args: {
        goal_id: tool.schema.string().optional().describe("Goal ID. Omit to target the first active goal."),
        message: tool.schema.string().describe("Message to send to the worker."),
      },
      execute: async (args, context) => {
        const state = await readState(directory)
        const ownerID = context?.sessionID
        const goal = args.goal_id
          ? state.goals.find((g) => g.id === args.goal_id && g.ownerSessionID === ownerID)
          : state.goals.find((g) => g.ownerSessionID === ownerID && g.status !== "complete")

        if (!goal) {
          return {
            title: "No goal found",
            output: JSON.stringify({ ok: false, message: "No matching active goal for this session." }),
          }
        }

        await appendGoalInbox(directory, goal.id, "user", args.message)

        // If goal was awaiting_user, resume it
        if (goal.status === "awaiting_user") {
          goal.status = "active"
          goal.question = undefined
          goal.updatedAt = new Date().toISOString()
          await writeState(directory, state)
        }

        return {
          title: "Message sent",
          output: JSON.stringify({
            ok: true,
            goalID: goal.id,
            goalName: goal.name,
            message: `Message delivered to "${goal.name}". It will appear in the worker's next turn.`,
          }),
        }
      },
    }),
  }
}
