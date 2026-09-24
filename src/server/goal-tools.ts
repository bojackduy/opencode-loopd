// ─── Server: Goal Tools ──────────────────────────────────────────────────────
// Authoritative goal tools. Requires exact worker-session matching.
// Returns structured JSON for get_goal. Validates transitions.

import { randomUUID } from "crypto"
import { tool } from "@opencode-ai/plugin/tool"
import { readState, writeState, mutateState, appendEvent, appendGoalInbox } from "../infrastructure/state-repository"
import type { Goal, GoalID, GoalConfig } from "../domain/goal"
import { canTransition } from "../domain/goal"
import type { GoalRuntimeState } from "../domain/runtime"
import { markProgress, releaseLease } from "../domain/runtime"
import type { LoopEvent } from "../domain/events"
import type { VerificationAttempt } from "../domain/verification"
import { appendVerificationAttempt } from "../domain/verification"
import { exec as execChild } from "child_process"
import { promisify } from "util"
import type { GoalService } from "../application/goal-service"
import { GoalStartError } from "../application/goal-service"
import type { LoopHost } from "./host-adapter"
import {
  resolveGoalCreationConfig,
  type GoalCreationDefaults,
} from "../application/goal-policy"
import { SERVER_LOG_FILE } from "../infrastructure/server-log"

const execAsync = promisify(execChild)

export type GoalToolDefaults = GoalCreationDefaults

export function goalTools(
  dir: string,
  goalService: GoalService,
  hostSessionID?: string,
  defaults: GoalToolDefaults = {},
  host?: LoopHost,
) {
  return {
    loopd_create_goal: tool({
      description:
        "Create a new background loop GOAL: an autonomous AI worker that loops turn-by-turn on a multi-step objective until deterministic checks pass or it needs you (contract: objective + checks + agent/model + workspaceWrite). " +
        "The engine spawns a dedicated worker session that does the work autonomously — it never runs in this chat. " +
        "Use this for AI reasoning work spanning multiple turns (implement a feature, fix a failing suite, research and write a report) — NOT for running a single process you just want to start, watch, and type into. " +
        "For that (dev servers, `npm test --watch`, REPLs, log tails, one-off scripts, interactive shells with a fullscreen terminal UI), use loopd_command_start instead: it is lighter-weight, has no agent/checks/turn loop, and is a raw OS process, not an AI worker. " +
        "Call this after clarifying the contract with the user. " +
        "Worker identity is free-form: agent is any OpenCode agent name (built-in, ~/.config/opencode/agents/*.md, or opencode.jsonc agent.* — discover with `opencode agent list`), " +
        "model is any \"providerID/modelID\" (discover with `opencode models [provider]`). When omitted, both inherit the CALLING session's live agent/model (read at creation), then plugin defaultAgent/defaultModel. " +
        "Host is the acceptance authority: checks must pass for complete_goal (free retry if rejected <3, blocked after 3). " +
        "Workspace-writing goals are serialized (only one active writer) and require checks. " +
        "Monitor with the /loop dashboard's Goals tab (Tab/h to switch there if Commands is focused).",
      args: {
        name: tool.schema.string().describe("Short goal name (used in the dashboard)."),
        objective: tool.schema.string().describe("What the goal should accomplish, in detail."),
        agent: tool.schema.string().optional().describe("Agent to run the worker as (e.g. \"researcher\", \"smart-agent\"). Optional — inherits the calling session's agent if omitted, else plugin defaultAgent."),
        model: tool.schema.string().optional().describe("Model to run the worker as, as \"providerID/modelID\" (e.g. \"openai/gpt-5.6-sol\", \"ollama/qwen3.8:27b\"). Optional — inherits the calling session's live model if omitted, else plugin defaultModel."),
        costBudget: tool.schema.number().optional().describe("Max provider cost in dollars before the engine stops the goal as budget_limited (e.g. 0.5). Optional — unlimited if omitted."),
        checks: tool.schema.array(tool.schema.string()).optional().describe("Shell commands that must pass for completion to be accepted. E.g. [\"npm test\"]."),
        checkCwd: tool.schema.string().optional().describe("Directory where completion checks run. Workspace-writing goals default to the project root."),
        workspaceWrite: tool.schema.boolean().optional().describe("Whether this goal edits the shared project workspace. Defaults to true; explicitly set false for artifact-only/read-only work."),
        progressFile: tool.schema.string().optional().describe("Markdown file the worker reads/writes as its transaction state."),
        maxTurns: tool.schema.number().optional().describe("Max turns before auto-block."),
        maxNoProgress: tool.schema.number().optional().describe("Block after N turns without progress."),
        maxFailures: tool.schema.number().optional().describe("Block after N consecutive failures."),
        compactEvery: tool.schema.number().optional().describe("Compact the worker session every N turns."),
        timeoutMs: tool.schema.number().optional().describe("Per-turn timeout in ms."),
        scheduleEveryMs: tool.schema.number().optional().describe("Interval in ms to auto-requeue the same goal after each completion. Minimum 1000. Enables repetitive dialogue reduction."),
        scheduleMaxRuns: tool.schema.number().optional().describe("Maximum total runs including the initial run. Undefined = unlimited. Requires scheduleEveryMs."),
      },
      execute: async (args, context) => {
        const sessionID = context?.sessionID || hostSessionID
        if (!sessionID || sessionID === "main") {
          return {
            title: "Goal not created",
            output: JSON.stringify({
              ok: false,
              message: "A valid owner session is required. Run /goal from an active OpenCode session.",
            }),
          }
        }
        const config: GoalConfig = {
          maxTurns: 50,
        }
        if (args.agent) config.agent = args.agent
        if (args.model) config.model = args.model
        if (args.checks) config.checks = args.checks
        if (args.checkCwd) config.checkCwd = args.checkCwd
        if (args.workspaceWrite !== undefined) config.workspaceWrite = args.workspaceWrite
        if (args.progressFile) config.progressFile = args.progressFile
        if (args.maxTurns !== undefined) config.maxTurns = args.maxTurns
        if (args.maxNoProgress !== undefined) config.maxNoProgress = args.maxNoProgress
        if (args.maxFailures !== undefined) config.maxFailures = args.maxFailures
        if (args.compactEvery !== undefined) config.compactEvery = args.compactEvery
        if (args.timeoutMs !== undefined) config.timeoutMs = args.timeoutMs
        if (args.scheduleEveryMs !== undefined) {
          const everyMs = args.scheduleEveryMs
          if (typeof everyMs !== "number" || !Number.isFinite(everyMs) || everyMs < 1000) {
            return {
              title: "Goal not created",
              output: JSON.stringify({ ok: false, message: "scheduleEveryMs must be a number >= 1000", errorCode: "invalid_schedule" }),
            }
          }
          const maxRuns = args.scheduleMaxRuns
          if (maxRuns !== undefined && (typeof maxRuns !== "number" || !Number.isFinite(maxRuns) || maxRuns < 1 || Math.floor(maxRuns) !== maxRuns)) {
            return {
              title: "Goal not created",
              output: JSON.stringify({ ok: false, message: "scheduleMaxRuns must be an integer >= 1", errorCode: "invalid_schedule" }),
            }
          }
          ;(config as any).schedule = { everyMs, ...(maxRuns !== undefined ? { maxRuns } : {}) }
        } else if (args.scheduleMaxRuns !== undefined) {
          return {
            title: "Goal not created",
            output: JSON.stringify({ ok: false, message: "scheduleMaxRuns requires scheduleEveryMs", errorCode: "invalid_schedule" }),
          }
        }

        let costBudget: number | undefined
        if (args.costBudget !== undefined) {
          if (typeof args.costBudget !== "number" || !Number.isFinite(args.costBudget) || args.costBudget <= 0) {
            return {
              title: "Goal not created",
              output: JSON.stringify({ ok: false, message: "costBudget must be a positive number of dollars", errorCode: "invalid_cost_budget" }),
            }
          }
          costBudget = args.costBudget
        }

        const resolution = resolveGoalCreationConfig({
          directory: dir,
          objective: args.objective,
          config,
          defaults: await withParentIdentity(defaults, host, sessionID),
        })
        if (!resolution.ok) {
          return {
            title: "Goal not created",
            output: JSON.stringify({
              ok: false,
              message: resolution.message,
              errorCode: resolution.errorCode,
            }),
          }
        }

        try {
          const parentDefaults = await withParentIdentity(defaults, host, sessionID)
          const { goal, worker } = await goalService.start(dir, {
            name: args.name,
            objective: args.objective,
            ownerSessionID: sessionID,
            config: resolution.config,
            costBudget,
            parentAgent: parentDefaults.parentAgent,
            parentModel: parentDefaults.parentModel,
          })
          return {
            title: "Goal created",
            output: JSON.stringify({
              ok: true,
              goalID: goal.id,
              workerSessionID: worker.workerSessionID,
              workerTopology: worker.topology,
              ...(worker.nativeParentID ? { nativeParentID: worker.nativeParentID } : {}),
              artifactDir: goal.config.artifactDir,
              agent: resolution.config.agent,
              model: resolution.config.model,
              costBudget: goal.costBudget,
              checks: resolution.config.checks || [],
              workspaceWrite: resolution.config.workspaceWrite,
              defaultsApplied: resolution.defaultsApplied,
              name: args.name,
              message: `Goal "${args.name}" created and started in the background. Artifacts: ${goal.config.artifactDir}. Monitor with /loop (<leader>o).`,
            }),
          }
        } catch (error) {
          // A GoalStartError means the goal WAS persisted (blocked) along
          // with its worker session when one was created. Report the IDs so
          // the caller resumes that goal instead of creating a duplicate.
          const startFailure = error instanceof GoalStartError ? error : undefined
          return {
            title: "Goal creation failed",
            output: JSON.stringify({
              ok: false,
              name: args.name,
              message: error instanceof Error ? error.message : String(error),
              ...(startFailure ? {
                goalID: startFailure.goalID,
                status: "blocked",
                failedStage: startFailure.failedStage,
                ...(startFailure.workerSessionID ? { workerSessionID: startFailure.workerSessionID } : {}),
                nextAction: `Resume the persisted goal with resume_goal (goal_id "${startFailure.goalID}") after fixing the cause — do not create another goal for the same task.`,
              } : {}),
              diagnostics: SERVER_LOG_FILE,
            }),
          }
        }
      },
    }),

    get_goal: tool({
      description:
        "Get the current goal contract and state. Call at the start of every turn to retrieve the objective, checks, limits, and recent failures (including HOST VERDICT if the last completion was rejected). Returns structured JSON with config and runtime (phase, runGeneration, rejectionCount).",
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
        "Report meaningful progress (resets consecutiveFailures/noProgressCount). Call after durable state changes (file writes, verifications) — not after thinking. The engine uses this to avoid force-finish.",
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
            turn: runtime?.runCount,
          }),
        }
      },
    }),

    complete_goal: tool({
      description:
        "Propose completion. Host runs checks from checkCwd (writers default to project root) — if any fail, host rejects (rejectionCount++, freeRetryPending if <3, blocked after 3 with HOST VERDICT). Only call when every requirement is proved with evidence; the host decides, not the model.",
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
          // Resolve check working directory
          const cwd = goal.config.checkCwd || goal.config.artifactDir || dir
          const checkResults = await runCompletionChecks(goal.config.checks, cwd)
          if (!checkResults.passed) {
            const failureDetails = checkResults.failures.map((f) => {
              const stdoutSnippet = f.stdout ? `\nStdout: ${f.stdout.slice(0, 500)}` : ""
              const stderrSnippet = f.stderr ? `\nStderr: ${f.stderr.slice(0, 500)}` : ""
              return `Command: ${f.command}\nExit code: ${f.exitCode}${stdoutSnippet}${stderrSnippet}`
            }).join("\n\n")
            let rejectionCount = 0
            let blocked = false
            let attemptID = ""

            // Checks can run for a long time. Apply their result to fresh state
            // so activity updates cannot be overwritten by this tool's snapshot.
            const rejectionState = await mutateState(dir, `goal.completion-rejected:${goal.id}`, async (current) => {
              const currentGoal = current.goals.find((item) => item.id === goal.id)
              const runtime = current.runtimes.find((r) => r.goalID === goal.id)
              if (!currentGoal || !runtime || currentGoal.status !== "active") return current

              runtime.evaluatorRejectionCount = (runtime.evaluatorRejectionCount || 0) + 1
              rejectionCount = runtime.evaluatorRejectionCount
              runtime.lastRejectionDetails = `Rejection #${runtime.evaluatorRejectionCount} at ${new Date().toISOString()}\n\nWorking directory: ${cwd}\n\n${failureDetails}`

              attemptID = randomUUID()
              const verificationAttempt: VerificationAttempt = {
                id: attemptID,
                sequence: runtime.evaluatorRejectionCount,
                runGeneration: runtime.runGeneration,
                claimedSummary: args.summary,
                claimedEvidence: args.evidence,
                startedAt: new Date().toISOString(),
                completedAt: new Date().toISOString(),
                status: "failed",
                cwd,
                checks: checkResults.failures.map((f) => ({
                  command: f.command,
                  exitCode: f.exitCode,
                  stderr: f.stderr,
                  stdout: f.stdout,
                })),
              }
              runtime.lastVerificationAttempt = verificationAttempt
              runtime.recentVerificationAttempts = appendVerificationAttempt(
                runtime.recentVerificationAttempts || [],
                verificationAttempt,
              )

              const maxRejections = (currentGoal.config as any).maxEvaluatorRejections || 3
              if (runtime.evaluatorRejectionCount >= maxRejections) {
                blocked = true
                currentGoal.status = "blocked"
                currentGoal.updatedAt = new Date().toISOString()
                currentGoal.blocker = {
                  reason: `Evaluator rejected ${runtime.evaluatorRejectionCount} time(s). Last failure:\n${failureDetails.slice(0, 500)}`,
                  needed: "Fix the failing checks and retry the goal.",
                  at: new Date().toISOString(),
                }
                Object.assign(runtime, releaseLease(runtime))
                runtime.activeRunID = undefined
                runtime.forceFinishRequested = undefined
                runtime.freeRetryPending = false
              } else {
                runtime.forceFinishRequested = false
                runtime.freeRetryPending = true
              }
              runtime.updatedAt = new Date().toISOString()
              return current
            })

            if (attemptID) {
              await appendEvent(dir, {
                version: 1,
                eventID: randomUUID(),
                goalID: goal.id,
                type: "goal.completion_rejected",
                attemptID,
                rejectionCount,
                failedCheckCount: checkResults.failures.length,
                failureSummary: failureDetails.slice(0, 500),
                timestamp: new Date().toISOString(),
                revision: rejectionState.revision,
              } satisfies LoopEvent)
            }

            const rejectedGoal = rejectionState.goals.find((item) => item.id === goal.id)
            const rejectedRuntime = rejectionState.runtimes.find((item) => item.goalID === goal.id)
            rejectionCount = rejectedRuntime?.evaluatorRejectionCount ?? rejectionCount
            const goalIsBlocked = rejectedGoal?.status === "blocked"
            if (blocked && rejectedGoal?.blocker) {
              await appendEvent(dir, {
                version: 1,
                eventID: randomUUID(),
                goalID: goal.id,
                type: "goal.blocked",
                reason: rejectedGoal.blocker.reason,
                needed: rejectedGoal.blocker.needed,
                timestamp: new Date().toISOString(),
                revision: rejectionState.revision,
              } satisfies LoopEvent)
              await goalService.accountUsage(dir, goal.id).catch(() => undefined)
            }

            return {
              title: goalIsBlocked ? "Completion rejected — goal blocked" : "Completion rejected — keep working",
              output: JSON.stringify({
                goalID: goal.id,
                goalName: goal.name,
                passed: false,
                failedChecks: checkResults.failures,
                message: goalIsBlocked
                  ? "Evaluator rejection limit reached. Goal blocked; owner retry required."
                  : "Evaluator rejected completion. Fix the issues above and try again.",
                rejectionCount,
                status: rejectedGoal?.status ?? goal.status,
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

        // Fold final-turn usage: no later turn will read the tail to account it.
        // Merged here so the final writeState below doesn't clobber fresh totals.
        const finalUsage = await goalService.accountUsage(dir, goal.id)
        goal.tokensUsed += finalUsage.tokenDelta
        goal.costUsed = (goal.costUsed ?? 0) + finalUsage.costDelta
        goal.timeUsedSeconds += finalUsage.timeDeltaSeconds

        const runtime = state.runtimes.find((r) => r.goalID === goal.id)
        if (runtime) {
          Object.assign(runtime, releaseLease(runtime))
          runtime.activeRunID = undefined
          runtime.lastError = undefined
          runtime.turnTokensUsed = (runtime.turnTokensUsed ?? 0) + finalUsage.tokenDelta
          runtime.accountedMessageIDs = [...(runtime.accountedMessageIDs ?? []), ...finalUsage.counted].slice(-200)
          runtime.updatedAt = new Date().toISOString()

          // Schedule: interval requeue — count this completion and set nextRunAt
          const schedule = (goal.config as any).schedule as { everyMs: number; maxRuns?: number } | undefined
          if (schedule && typeof schedule.everyMs === "number" && schedule.everyMs >= 1000) {
            const cur = typeof (runtime as any).scheduleRunCount === "number" ? (runtime as any).scheduleRunCount : 0
            const nextCount = cur + 1
            ;(runtime as any).scheduleRunCount = nextCount
            const max = schedule.maxRuns
            const hasMore = typeof max === "number" ? nextCount < max : true
            if (hasMore) {
              ;(runtime as any).nextRunAt = new Date(Date.now() + schedule.everyMs).toISOString()
              ;(runtime as any).lastScheduleAt = new Date().toISOString()
            } else {
              ;(runtime as any).nextRunAt = undefined
            }
            runtime.updatedAt = new Date().toISOString()
          }

          // Persist a passing verification attempt
          const attemptID = randomUUID()
          const cwd = goal.config.checkCwd || goal.config.artifactDir || dir
          const checks = (goal.config.checks || []).map((cmd) => ({
            command: cmd,
            exitCode: 0,
          }))
          const verificationAttempt: VerificationAttempt = {
            id: attemptID,
            sequence: (runtime.evaluatorRejectionCount || 0) + 1,
            runGeneration: runtime.runGeneration,
            claimedSummary: args.summary,
            claimedEvidence: args.evidence,
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
            status: "passed",
            cwd,
            checks,
          }
          runtime.lastVerificationAttempt = verificationAttempt
          runtime.recentVerificationAttempts = appendVerificationAttempt(
            runtime.recentVerificationAttempts || [],
            verificationAttempt,
          )
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
            goalID: goal.id,
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
        "Mark blocked for a real external blocker (missing creds, contradictory objective vs checks). Use only when you cannot proceed — the engine will not auto-continue blocked goals until resume/retry.",
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

        // Fold final-turn usage: a blocked goal gets no later accounting turn.
        const finalUsage = await goalService.accountUsage(dir, goal.id)
        goal.tokensUsed += finalUsage.tokenDelta
        goal.costUsed = (goal.costUsed ?? 0) + finalUsage.costDelta
        goal.timeUsedSeconds += finalUsage.timeDeltaSeconds

        const runtime = state.runtimes.find((r) => r.goalID === goal.id)
        if (runtime) {
          Object.assign(runtime, releaseLease(runtime))
          runtime.activeRunID = undefined
          runtime.lastError = undefined
          runtime.turnTokensUsed = (runtime.turnTokensUsed ?? 0) + finalUsage.tokenDelta
          runtime.accountedMessageIDs = [...(runtime.accountedMessageIDs ?? []), ...finalUsage.counted].slice(-200)
          runtime.updatedAt = new Date().toISOString()
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
            goalID: goal.id,
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

/**
 * Merge the calling session's live identity into creation defaults.
 * Best-effort and cached per owner session: session.get is one extra call at
 * creation time only, never on the hot turn path.
 */
const parentIdentityCache = new Map<string, { agent?: string; model?: string }>()
async function withParentIdentity(
  defaults: GoalToolDefaults,
  host: LoopHost | undefined,
  ownerSessionID: string,
): Promise<GoalToolDefaults> {
  if (!host?.readSession) return defaults
  let cached = parentIdentityCache.get(ownerSessionID)
  if (!cached) {
    try {
      const identity = await host.readSession(ownerSessionID)
      cached = {
        agent: identity?.agent,
        model: identity?.model ? `${identity.model.providerID}/${identity.model.modelID}` : undefined,
      }
    } catch {
      cached = {}
    }
    parentIdentityCache.set(ownerSessionID, cached)
    if (parentIdentityCache.size > 200) {
      const first = parentIdentityCache.keys().next()
      if (!first.done) parentIdentityCache.delete(first.value)
    }
  }
  return {
    ...defaults,
    parentAgent: cached.agent,
    parentModel: cached.model,
  }
}

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
      checkCwd: goal.config.checkCwd,
      workspaceWrite: goal.config.workspaceWrite,
      agent: goal.config.agent,
      model: goal.config.model,
      maxTurns: goal.config.maxTurns,
      maxNoProgress: goal.config.maxNoProgress,
      maxFailures: goal.config.maxFailures,
      compactEvery: goal.config.compactEvery,
      timeoutMs: goal.config.timeoutMs,
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
  }

  if (runtime) {
    output.runtime = {
      phase: runtime.phase,
      runCount: runtime.runCount,
      budgetTurnCount: runtime.budgetTurnCount,
      runGeneration: runtime.runGeneration,
      evaluatorRejectionCount: runtime.evaluatorRejectionCount,
      freeRetryPending: runtime.freeRetryPending,
      lastRejectionDetails: runtime.lastRejectionDetails,
      consecutiveFailures: runtime.consecutiveFailures,
      noProgressCount: runtime.noProgressCount,
      lastError: runtime.lastError,
      lastProgressAt: runtime.lastProgressAt,
      lastRunAt: runtime.lastRunAt,
      lastCompactAt: runtime.lastCompactAt,
      lastActivityAt: runtime.lastActivityAt,
      activePromptMessageID: runtime.activePromptMessageID,
      activeAssistantMessageID: runtime.activeAssistantMessageID,
      activeAssistantCompletedAt: runtime.activeAssistantCompletedAt,
      idleCandidateGeneration: runtime.idleCandidateGeneration,
      unknownStatusCount: runtime.unknownStatusCount,
      lastUnknownStatusAt: runtime.lastUnknownStatusAt,
      workerUnreachableNotifiedAt: runtime.workerUnreachableNotifiedAt,
      lastVerificationAttempt: runtime.lastVerificationAttempt,
      recentVerificationAttempts: runtime.recentVerificationAttempts,
      scheduleRunCount: (runtime as any).scheduleRunCount,
      nextRunAt: (runtime as any).nextRunAt,
      lastScheduleAt: (runtime as any).lastScheduleAt,
    }
  }

  return JSON.stringify(output, null, 2)
}

interface CheckResult {
  passed: boolean
  failures: Array<{ command: string; exitCode: number; stderr: string; stdout: string }>
}

async function runCompletionChecks(checks: string[], cwd?: string): Promise<CheckResult> {
  const failures: CheckResult["failures"] = []

  for (const cmd of checks) {
    try {
      const { stdout, stderr } = await execAsync(cmd, { timeout: 30_000, cwd }) as any
      // Success — nothing to record; stdout/stderr ignored for passing checks
      void stdout; void stderr
    } catch (error: any) {
      failures.push({
        command: cmd,
        exitCode: error.code ?? 1,
        stderr: String(error.stderr || error.message || "unknown error").slice(0, 1000),
        stdout: String(error.stdout || "").slice(0, 1000),
      })
    }
  }

  return {
    passed: failures.length === 0,
    failures,
  }
}
