// ─── Server: Owner Tools ────────────────────────────────────────────────────
// Tools for the PARENT agent to inspect and interact with background goals.
// Matched by ownerSessionID (the session that created the goal).

import { tool } from "@opencode-ai/plugin/tool"
import { readState, appendGoalInbox } from "../infrastructure/state-repository"
import type { GoalID } from "../domain/goal"
import type { LoopHost } from "./host-adapter"
import type { GoalService } from "../application/goal-service"

export interface OwnerToolsOptions {
  directory: string
  host: LoopHost
  goalService: GoalService
}

export function ownerTools(options: OwnerToolsOptions) {
  const { directory, host, goalService } = options

  return {
    list_background_goals: tool({
      description:
        "List all active background goals owned by this session. Shows contract (name, status, phase, turn, last progress, blocker) — only goals with your ownerSessionID appear.",
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
          const runtime = state.runtimes.find((r) => r.goalID === g.id) as any
          return {
            id: g.id,
            name: g.name,
            status: g.status,
            phase: runtime?.phase ?? "unknown",
            turn: runtime?.runCount ?? 0,
            budgetTurnCount: runtime?.budgetTurnCount ?? 0,
            maxTurns: (g.config as any).maxTurns,
            lastProgress: g.lastProgress?.summary?.slice(0, 120),
            lastProgressAt: g.lastProgress?.at,
            blocker: g.blocker?.reason?.slice(0, 120),
            evaluatorRejectionCount: runtime?.evaluatorRejectionCount ?? 0,
            unknownStatusCount: runtime?.unknownStatusCount ?? 0,
            lastActivityAt: runtime?.lastActivityAt,
            retryAfter: runtime?.retryAfter,
            nextRunAt: runtime?.nextRunAt,
            scheduleRunCount: runtime?.scheduleRunCount,
            consecutiveFailures: runtime?.consecutiveFailures ?? 0,
            noProgressCount: runtime?.noProgressCount ?? 0,
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
        "Inspect a goal’s full contract and runtime: objective, config{agent,checks,checkCwd,workspaceWrite,limits}, progress, blocker, and runtime{phase,runCount,budgetTurnCount,runGeneration,evaluatorRejectionCount,unknownStatusCount,lastActivityAt,activePromptMessageID}. The source for recovery decisions.",
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
              checkCwd: goal.config.checkCwd,
              workspaceWrite: goal.config.workspaceWrite,
              agent: goal.config.agent,
              schedule: (goal.config as any).schedule,
            },
            lastProgress: goal.lastProgress,
            completionEvidence: goal.completionEvidence,
            blocker: goal.blocker,
            tokensUsed: goal.tokensUsed,
            timeUsedSeconds: goal.timeUsedSeconds,
            runtime: runtime ? {
              phase: runtime.phase,
              runCount: runtime.runCount,
              budgetTurnCount: runtime.budgetTurnCount,
              runGeneration: runtime.runGeneration,
              evaluatorRejectionCount: runtime.evaluatorRejectionCount,
              freeRetryPending: runtime.freeRetryPending,
              lastRejectionDetails: (runtime as any).lastRejectionDetails?.slice(0, 800),
              consecutiveFailures: runtime.consecutiveFailures,
              noProgressCount: (runtime as any).noProgressCount,
              lastError: runtime.lastError,
              lastProgressAt: runtime.lastProgressAt,
              lastRunAt: runtime.lastRunAt,
              lastActivityAt: (runtime as any).lastActivityAt,
              lastCompactAt: (runtime as any).lastCompactAt,
              activePromptMessageID: (runtime as any).activePromptMessageID,
              activeAssistantMessageID: (runtime as any).activeAssistantMessageID,
              activeAssistantCompletedAt: (runtime as any).activeAssistantCompletedAt,
              idleCandidateAt: (runtime as any).idleCandidateAt,
              idleCandidateGeneration: (runtime as any).idleCandidateGeneration,
              unknownStatusCount: (runtime as any).unknownStatusCount,
              lastUnknownStatusAt: (runtime as any).lastUnknownStatusAt,
              workerUnreachableNotifiedAt: (runtime as any).workerUnreachableNotifiedAt,
              retryAfter: (runtime as any).retryAfter,
              forceFinishRequested: (runtime as any).forceFinishRequested,
              scheduleRunCount: (runtime as any).scheduleRunCount,
              nextRunAt: (runtime as any).nextRunAt,
              lastScheduleAt: (runtime as any).lastScheduleAt,
              lastVerificationAttempt: (runtime as any).lastVerificationAttempt,
              recentVerificationAttempts: (runtime as any).recentVerificationAttempts?.slice(-2),
            } : undefined,
          }, null, 2),
        }
      },
    }),

    read_goal_transcript: tool({
      description:
        "Read the last N messages from the worker transcript (role, content, messageID). Shows HOST VERDICT, steering, and whether the worker’s last prompt was correlated. Use to debug why a completion was rejected or why a worker is stuck.",
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
        "Send an inbox message to the worker (injected as ## USER INSTRUCTIONS on next turn). Use to answer `question`, redirect, or refine scope. Does NOT itself re-prompt — the engine re-prompts on next idle/maintenance; use nudge_goal if the worker is stuck with no activity.",
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

    pause_goal: tool({
      description:
        "Pause an active goal: status active → paused, releaseLease, abortWorker, per-goal mutex. Frees the workspaceWrite slot. Use to investigate or to free the single-writer slot.",
      args: {
        goal_id: tool.schema.string().optional().describe("Goal ID. Omit to pause the first active goal."),
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

        if (goal.status === "paused") {
          return {
            title: "Already paused",
            output: JSON.stringify({ ok: true, message: `Goal "${goal.name}" is already paused.` }),
          }
        }

        try {
          await goalService.pause(directory, goal.id)
          return {
            title: "Goal paused",
            output: JSON.stringify({
              ok: true,
              goalID: goal.id,
              goalName: goal.name,
              message: `Goal "${goal.name}" paused. Resume with resume_goal.`,
            }),
          }
        } catch (error) {
          return {
            title: "Pause failed",
            output: JSON.stringify({
              ok: false,
              goalName: goal.name,
              message: error instanceof Error ? error.message : String(error),
            }),
          }
        }
      },
    }),

    resume_goal: tool({
      description:
        "Resume a paused (→active, reuses existing worker if sessionStatus still idle/busy) or retry a blocked (→active, resets consecutiveFailures/forceFinish). Fails with 'already active' if another workspaceWrite writer is active. Per-goal mutex.",
      args: {
        goal_id: tool.schema.string().optional().describe("Goal ID. Omit to resume the first paused/blocked goal."),
      },
      execute: async (args, context) => {
        const state = await readState(directory)
        const ownerID = context?.sessionID
        const goal = args.goal_id
          ? state.goals.find((g) => g.id === args.goal_id && g.ownerSessionID === ownerID)
          : state.goals.find(
              (g) =>
                g.ownerSessionID === ownerID &&
                (g.status === "paused" || g.status === "blocked"),
            )

        if (!goal) {
          return {
            title: "No goal found",
            output: JSON.stringify({
              ok: false,
              message: "No matching paused/blocked goal for this session.",
            }),
          }
        }

        if (goal.status === "active") {
          return {
            title: "Already active",
            output: JSON.stringify({ ok: true, message: `Goal "${goal.name}" is already active.` }),
          }
        }

        try {
          if (goal.status === "paused") {
            await goalService.resume(directory, goal.id)
          } else if (goal.status === "blocked") {
            await goalService.retry(directory, goal.id)
          }
          return {
            title: "Goal resumed",
            output: JSON.stringify({
              ok: true,
              goalID: goal.id,
              goalName: goal.name,
              message: `Goal "${goal.name}" resumed.`,
            }),
          }
        } catch (error) {
          return {
            title: "Resume failed",
            output: JSON.stringify({
              ok: false,
              goalName: goal.name,
              message: error instanceof Error ? error.message : String(error),
            }),
          }
        }
      },
    }),

    nudge_goal: tool({
      description:
        "Force re-prompt a stuck active worker (the hardened recovery). Clears stale activeRunID/idleCandidate/generation/lease (phase→idle) and calls continueTurn({force:true}) even if sessionStatus is not idle. Use when unknownStatusCount≥3, lastActivityAt is stale, or maintenance notified 'worker is unreachable'. Per-goal mutex.",
      args: {
        goal_id: tool.schema.string().optional().describe("Goal ID. Omit to nudge the first active goal."),
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

        try {
          const result = await goalService.nudge(directory, goal.id)
          return {
            title: result.ok ? "Goal nudged" : "Nudge failed",
            output: JSON.stringify({ ...result, goalID: goal.id, goalName: goal.name }),
          }
        } catch (error) {
          return {
            title: "Nudge failed",
            output: JSON.stringify({
              ok: false,
              goalName: goal.name,
              message: error instanceof Error ? error.message : String(error),
            }),
          }
        }
      },
    }),

    clear_goal: tool({
      description:
        "Clear a goal: aborts worker and removes goal+runtime+ledger (cannot be undone). Use when the goal is no longer needed or to free a stuck writer slot after inspection.",
      args: {
        goal_id: tool.schema.string().optional().describe("Goal ID. Omit to clear the first active goal."),
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

        try {
          await goalService.clear(directory, goal.id)
          return {
            title: "Goal cleared",
            output: JSON.stringify({
              ok: true,
              goalID: goal.id,
              goalName: goal.name,
              message: `Goal "${goal.name}" cleared and removed.`,
            }),
          }
        } catch (error) {
          return {
            title: "Clear failed",
            output: JSON.stringify({
              ok: false,
              goalName: goal.name,
              message: error instanceof Error ? error.message : String(error),
            }),
          }
        }
      },
    }),
  }
}
