// ─── Server: Owner Tools ────────────────────────────────────────────────────
// Tools for the PARENT agent to inspect and interact with background goals.
// Matched by ownerSessionID (the session that created the goal).

import { tool } from "@opencode-ai/plugin/tool"
import { readState, appendGoalInbox, readEvents, peekGoalInbox } from "../infrastructure/state-repository"
import type { GoalID } from "../domain/goal"
import type { LoopHost } from "./host-adapter"
import type { GoalService } from "../application/goal-service"
import { goalStatusLabel, phaseLabel, describeGoalState } from "../domain/status-labels"
import { promises as fs } from "fs"
import path from "path"

export interface OwnerToolsOptions {
  directory: string
  host: LoopHost
  goalService: GoalService
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), ms)),
  ])
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
          const phase = runtime?.phase ?? "unknown"
          const goalLabel = goalStatusLabel(g.status)
          const activityLabel = phaseLabel(phase)
          return {
            id: g.id,
            name: g.name,
            status: g.status,
            statusDisplay: `${goalLabel.short} — ${goalLabel.hint}`,
            phase,
            activityDisplay: `${activityLabel.short} — ${activityLabel.hint}`,
            stateSummary: describeGoalState(g.status, runtime?.phase),
            turn: runtime?.runCount ?? 0,
            budgetTurnCount: runtime?.budgetTurnCount ?? 0,
            maxTurns: (g.config as any).maxTurns,
            agent: g.config.agent,
            model: g.config.model,
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
        "Inspect a goal’s full contract, runtime, and live execution state: objective, config{agent,model,checks,checkCwd,workspaceWrite,limits}, progress, blocker, runtime{phase,runCount,budgetTurnCount,runGeneration,evaluatorRejectionCount,unknownStatusCount,lastActivityAt,activePromptMessageID}, plus live transcriptTail, activeToolCallIDs, progressHistory, artifactSummary, pendingInbox. Single-call follow-up for parent to see what child is actually doing.",
      args: {
        goal_id: tool.schema.string().optional().describe("Goal ID. Omit to inspect the first active goal."),
        includeTranscript: tool.schema.boolean().optional().describe("Include live transcript tail (adds ~100ms). Default true. Set false for fast metadata-only."),
        transcriptLimit: tool.schema.number().optional().describe("Number of transcript messages to include (1-10). Default 3."),
      },
      execute: async (args, context) => {
        const state = await readState(directory)
        const ownerID = context?.sessionID
        const goal = args.goal_id
          ? state.goals.find((g) => g.id === args.goal_id && g.ownerSessionID === ownerID)
          : state.goals.find((g) => g.ownerSessionID === ownerID && g.status !== "complete")

        if (!goal) {
          if (!ownerID) {
            return {
              title: "No goal found",
              output: JSON.stringify({ ok: false, message: "No session context available, so goal ownership cannot be matched." }),
            }
          }
          // Bare "no matching goal" reads as a failure even when the session
          // simply owns nothing (e.g. goals live under another session).
          // Report what exists so the caller can tell those cases apart.
          const ownedActive = state.goals.filter((g) => g.ownerSessionID === ownerID && g.status !== "complete")
          const ownedComplete = state.goals.filter((g) => g.ownerSessionID === ownerID && g.status === "complete").length
          const othersActive = state.goals.filter((g) => g.ownerSessionID !== ownerID && g.status !== "complete").length
          const message = ownedActive.length > 0
            ? `No goal matched (tried ${args.goal_id ? `ID ${args.goal_id}` : "first active goal"}). This session owns ${ownedActive.length} active goal(s) — pass its goal_id explicitly.`
            : othersActive > 0
              ? `No matching active goal for this session. ${othersActive} active goal(s) exist, all owned by other sessions — inspect from the owning session.`
              : ownedComplete > 0
                ? "No matching active goal for this session. Your goals are all complete."
                : "No matching active goal for this session. No goals exist yet — create one with /goal."
          return {
            title: "No goal found",
            output: JSON.stringify({
              ok: false,
              message,
              ownedGoals: ownedActive.map((g) => ({ id: g.id, name: g.name, status: g.status })),
              ownedElsewhereActive: othersActive,
            }),
          }
        }

        const runtime = state.runtimes.find((r) => r.goalID === goal.id) as any

        // Enriched live fields — parallel with timeouts, additive
        const includeTranscript = args.includeTranscript !== false
        const tLimit = Math.min(10, Math.max(1, args.transcriptLimit ?? 3))

        const [transcriptTail, progressHistory, artifactSummary, pendingInbox] = await Promise.all([
          includeTranscript && goal.workerSessionID
            ? withTimeout(host.readMessages(goal.workerSessionID, tLimit), 900).catch(() => null)
            : Promise.resolve(null),
          readEvents(directory, 60).then((evs) =>
            evs.filter((e) => (e as any).goalID === goal.id && (e as any).type === "goal.progress")
               .slice(-5).map((e: any) => ({ summary: String(e.summary || "").slice(0, 120), next: e.next ? String(e.next).slice(0, 80) : undefined, at: String(e.timestamp || "") }))
          ).catch(() => []),
          (async () => {
            const dir = (goal.config as any).artifactDir as string | undefined
            if (!dir) return undefined
            try {
              const files = await fs.readdir(dir)
              return files.length ? `${files.length} file(s): ${files.slice(0, 8).join(", ")}` : "no artifacts yet"
            } catch { return "no artifacts yet" }
          })(),
          peekGoalInbox(directory, goal.id).then((msgs) => msgs.slice(-3)).catch(() => []),
        ] as const)

        const activeToolCallIDs = runtime?.activeToolCallIDs ?? []

        return {
          title: `Goal: ${goal.name}`,
          output: JSON.stringify({
            ok: true,
            id: goal.id,
            name: goal.name,
            objective: goal.objective,
            status: goal.status,
            statusDisplay: `${goalStatusLabel(goal.status).short} — ${goalStatusLabel(goal.status).hint}`,
            activityDisplay: runtime?.phase ? `${phaseLabel(runtime.phase).short} — ${phaseLabel(runtime.phase).hint}` : undefined,
            stateSummary: describeGoalState(goal.status, runtime?.phase),
            ownerSessionID: goal.ownerSessionID,
            workerSessionID: goal.workerSessionID,
            workerTopology: goal.workerTopology,
            ...(goal.nativeParentID ? { nativeParentID: goal.nativeParentID } : {}),
            config: {
              maxTurns: goal.config.maxTurns,
              maxFailures: goal.config.maxFailures,
              timeoutMs: goal.config.timeoutMs,
              progressFile: goal.config.progressFile,
              checks: goal.config.checks,
              checkCwd: goal.config.checkCwd,
              workspaceWrite: goal.config.workspaceWrite,
              agent: goal.config.agent,
              model: goal.config.model,
              parentAgent: goal.parentAgent,
              parentModel: goal.parentModel,
              schedule: (goal.config as any).schedule,
            },
            lastProgress: goal.lastProgress,
            completionEvidence: goal.completionEvidence,
            blocker: goal.blocker,
            tokensUsed: goal.tokensUsed,
            tokenBudget: goal.tokenBudget,
            costUsed: goal.costUsed ?? 0,
            costBudget: goal.costBudget,
            timeUsedSeconds: goal.timeUsedSeconds,
            progressHistory: progressHistory as any,
            pendingInbox: pendingInbox as any,
            live: {
              artifactSummary: artifactSummary as any,
              transcriptTail: transcriptTail ? (transcriptTail as any[]).map((m: any) => ({ role: m.role, content: String(m.content || "").slice(0, 400), timestamp: m.timestamp, messageID: m.messageID, parentMessageID: m.parentMessageID })) : undefined,
              activeToolCallIDs: activeToolCallIDs as any,
              pendingToolCalls: activeToolCallIDs.length,
              lastActivityAge: runtime?.lastActivityAt ? `${Math.floor((Date.now() - Date.parse(runtime.lastActivityAt)) / 1000)}s ago` : undefined,
            },
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
              workerAbortedAt: (runtime as any).workerAbortedAt,
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
        "Send bare words to the worker as their own turn (no steering wrapper). Delivers immediately if the goal is active, otherwise queues for the next active turn. Use to answer `question`, redirect, or nudge with a short message.",
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

        const result = await goalService.sendUserMessage(directory, goal.id, args.message)

        return {
          title: result.ok ? "Message sent" : "Send failed",
          output: JSON.stringify({
            ok: result.ok,
            goalID: goal.id,
            goalName: goal.name,
            message: result.message,
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

    abort_goal_worker: tool({
      description:
        "Abort the worker session only (N / :abort in TUI). Keeps goal+transcript+session browsable, clears the run lease. Use for compaction-spin or stuck runs. Status unchanged; active goals resume next turn in the same session.",
      args: {
        goal_id: tool.schema.string().optional().describe("Goal ID. Omit to abort the first active goal."),
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
          const result = await goalService.abortWorker(directory, goal.id)
          return {
            title: result.ok ? "Worker aborted" : "Abort failed",
            output: JSON.stringify({ ...result, goalID: goal.id, goalName: goal.name }),
          }
        } catch (error) {
          return {
            title: "Abort failed",
            output: JSON.stringify({
              ok: false,
              goalName: goal.name,
              message: error instanceof Error ? error.message : String(error),
            }),
          }
        }
      },
    }),

    force_complete_goal: tool({
      description:
        "Force-complete a goal with summary/evidence, bypassing checks (:force in TUI). Use when the worker produced the right artifact but checks are stale or you have verified manually.",
      args: {
        goal_id: tool.schema.string().optional().describe("Goal ID. Omit to target the first non-complete goal."),
        summary: tool.schema.string().describe("What was completed."),
        evidence: tool.schema.string().describe("Concrete evidence of completion."),
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

        // Reuse control bus path so ledger/events stay consistent; direct write would bypass it.
        // We do the state mutation here for the agent path — same effect as :force via control worker.
        const { readState: rs, writeState: ws, appendEvent: ae } = await import("../infrastructure/state-repository")
        const { releaseLease } = await import("../domain/runtime")
        const { randomUUID } = await import("crypto")
        const st = await rs(directory)
        const g = st.goals.find((x) => x.id === goal.id)
        if (!g) return { title: "No goal", output: JSON.stringify({ ok: false, message: "Goal not found." }) }
        if (g.status === "complete") {
          return { title: "Already complete", output: JSON.stringify({ ok: true, message: `Goal "${g.name}" already complete.` }) }
        }
        g.status = "complete"
        g.updatedAt = new Date().toISOString()
        g.completionEvidence = { summary: args.summary, evidence: args.evidence, at: new Date().toISOString() }
        const rt = st.runtimes.find((r) => r.goalID === goal.id)
        if (rt) {
          Object.assign(rt, releaseLease(rt))
          rt.activeRunID = undefined
          rt.lastError = undefined
          rt.updatedAt = new Date().toISOString()
        }
        await ws(directory, st)
        await ae(directory, {
          version: 1,
          eventID: randomUUID(),
          goalID: goal.id as any,
          type: "goal.completed",
          summary: args.summary,
          evidence: args.evidence,
          timestamp: new Date().toISOString(),
          revision: st.revision,
        })
        return { title: "Goal force-completed", output: JSON.stringify({ ok: true, goalID: goal.id, goalName: g.name }) }
      },
    }),

    force_block_goal: tool({
      description:
        "Force-block a goal with reason/needed (:block in TUI). Use when the goal is stuck on an external blocker and should stop retrying.",
      args: {
        goal_id: tool.schema.string().optional().describe("Goal ID. Omit to target the first non-complete goal."),
        reason: tool.schema.string().describe("Why the goal is blocked."),
        needed: tool.schema.string().describe("What is needed to unblock."),
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

        const { readState: rs, writeState: ws, appendEvent: ae } = await import("../infrastructure/state-repository")
        const { releaseLease } = await import("../domain/runtime")
        const { randomUUID } = await import("crypto")
        const st = await rs(directory)
        const g = st.goals.find((x) => x.id === goal.id)
        if (!g) return { title: "No goal", output: JSON.stringify({ ok: false, message: "Goal not found." }) }
        if (g.status === "blocked") {
          return { title: "Already blocked", output: JSON.stringify({ ok: true, message: `Goal "${g.name}" already blocked.` }) }
        }
        g.status = "blocked"
        g.updatedAt = new Date().toISOString()
        g.blocker = { reason: args.reason, needed: args.needed, at: new Date().toISOString() }
        const rt = st.runtimes.find((r) => r.goalID === goal.id)
        if (rt) {
          Object.assign(rt, releaseLease(rt))
          rt.activeRunID = undefined
          rt.lastError = undefined
          rt.updatedAt = new Date().toISOString()
        }
        await ws(directory, st)
        await ae(directory, {
          version: 1,
          eventID: randomUUID(),
          goalID: goal.id as any,
          type: "goal.blocked",
          reason: args.reason,
          needed: args.needed,
          timestamp: new Date().toISOString(),
          revision: st.revision,
        })
        return { title: "Goal blocked", output: JSON.stringify({ ok: true, goalID: goal.id, goalName: g.name }) }
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
