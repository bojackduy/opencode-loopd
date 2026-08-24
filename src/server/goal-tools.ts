// ─── Server: Goal Tools ──────────────────────────────────────────────────────
// Authoritative goal tools. Requires exact worker-session matching.
// Returns structured JSON for get_goal. Validates transitions.

import { randomUUID } from "crypto"
import { tool } from "@opencode-ai/plugin/tool"
import { readState, writeState, appendEvent, appendGoalInbox } from "../infrastructure/state-repository"
import type { Goal, GoalID, GoalConfig } from "../domain/goal"
import { canTransition } from "../domain/goal"
import type { GoalRuntimeState } from "../domain/runtime"
import { markProgress } from "../domain/runtime"
import type { LoopEvent } from "../domain/events"
import type { VerificationAttempt } from "../domain/verification"
import { appendVerificationAttempt } from "../domain/verification"
import { exec as execChild } from "child_process"
import { promisify } from "util"
import type { GoalService } from "../application/goal-service"
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
) {
  return {
    loopd_create_goal: tool({
      description:
        "Create a new background loop goal (contract: objective + checks + agent + workspaceWrite). " +
        "The engine spawns a dedicated worker session that does the work autonomously — it never runs in this chat. " +
        "Call this after clarifying the contract with the user. " +
        "Host is the acceptance authority: checks must pass for complete_goal (free retry if rejected <3, blocked after 3). " +
        "Workspace-writing goals are serialized (only one active writer) and require checks. " +
        "Specify 'agent' or configure plugin defaultAgent.",
      args: {
        name: tool.schema.string().describe("Short goal name (used in the dashboard)."),
        objective: tool.schema.string().describe("What the goal should accomplish, in detail."),
        agent: tool.schema.string().optional().describe("Agent to run the worker as. Required unless the plugin has defaultAgent configured."),
        checks: tool.schema.array(tool.schema.string()).optional().describe("Shell commands that must pass for completion to be accepted. E.g. [\"npm test\"]."),
        checkCwd: tool.schema.string().optional().describe("Directory where completion checks run. Workspace-writing goals default to the project root."),
        workspaceWrite: tool.schema.boolean().optional().describe("Whether this goal edits the shared project workspace. Defaults to true; explicitly set false for artifact-only/read-only work."),
        progressFile: tool.schema.string().optional().describe("Markdown file the worker reads/writes as its transaction state."),
        maxTurns: tool.schema.number().optional().describe("Max turns before auto-block."),
        maxNoProgress: tool.schema.number().optional().describe("Block after N turns without progress."),
        maxFailures: tool.schema.number().optional().describe("Block after N consecutive failures."),
        compactEvery: tool.schema.number().optional().describe("Compact the worker session every N turns."),
        timeoutMs: tool.schema.number().optional().describe("Per-turn timeout in ms."),
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
        if (args.checks) config.checks = args.checks
        if (args.checkCwd) config.checkCwd = args.checkCwd
        if (args.workspaceWrite !== undefined) config.workspaceWrite = args.workspaceWrite
        if (args.progressFile) config.progressFile = args.progressFile
        if (args.maxTurns !== undefined) config.maxTurns = args.maxTurns
        if (args.maxNoProgress !== undefined) config.maxNoProgress = args.maxNoProgress
        if (args.maxFailures !== undefined) config.maxFailures = args.maxFailures
        if (args.compactEvery !== undefined) config.compactEvery = args.compactEvery
        if (args.timeoutMs !== undefined) config.timeoutMs = args.timeoutMs

        const resolution = resolveGoalCreationConfig({
          directory: dir,
          objective: args.objective,
          config,
          defaults,
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
          const { goal, worker } = await goalService.start(dir, {
            name: args.name,
            objective: args.objective,
            ownerSessionID: sessionID,
            config: resolution.config,
          })
          return {
            title: "Goal created",
            output: JSON.stringify({
              ok: true,
              goalID: goal.id,
              workerSessionID: worker.workerSessionID,
              artifactDir: goal.config.artifactDir,
              agent: resolution.config.agent,
              checks: resolution.config.checks || [],
              workspaceWrite: resolution.config.workspaceWrite,
              defaultsApplied: resolution.defaultsApplied,
              name: args.name,
              message: `Goal "${args.name}" created and started in the background. Artifacts: ${goal.config.artifactDir}. Monitor with /loop (<leader>o).`,
            }),
          }
        } catch (error) {
          return {
            title: "Goal creation failed",
            output: JSON.stringify({
              ok: false,
              name: args.name,
              message: error instanceof Error ? error.message : String(error),
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
            // Evaluator rejected — child gets a free retry turn
            const runtime = state.runtimes.find((r) => r.goalID === goal.id)
            if (runtime) {
              runtime.evaluatorRejectionCount = (runtime.evaluatorRejectionCount || 0) + 1
              // Build detailed rejection message — include stdout+stderr for diagnostics
              const failureDetails = checkResults.failures.map((f) => {
                const stdoutSnippet = f.stdout ? `\nStdout: ${f.stdout.slice(0, 500)}` : ""
                const stderrSnippet = f.stderr ? `\nStderr: ${f.stderr.slice(0, 500)}` : ""
                return `Command: ${f.command}\nExit code: ${f.exitCode}${stdoutSnippet}${stderrSnippet}`
              }).join("\n\n")
              runtime.lastRejectionDetails = `Rejection #${runtime.evaluatorRejectionCount} at ${new Date().toISOString()}\n\nWorking directory: ${cwd}\n\n${failureDetails}`

              // Create a VerificationAttempt for this rejection
              const attemptID = randomUUID()
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

              // Emit goal.completion_rejected event
              const rejectEvent: LoopEvent = {
                version: 1,
                eventID: randomUUID(),
                goalID: goal.id,
                type: "goal.completion_rejected",
                attemptID,
                rejectionCount: runtime.evaluatorRejectionCount,
                failedCheckCount: checkResults.failures.length,
                failureSummary: failureDetails.slice(0, 500),
                timestamp: new Date().toISOString(),
                revision: state.revision,
              }
              await appendEvent(dir, rejectEvent)

              // After maxEvaluatorRejections (default 3), block immediately
              const maxRejections = (goal.config as any).maxEvaluatorRejections || 3
              if (runtime.evaluatorRejectionCount >= maxRejections) {
                goal.status = "blocked"
                goal.updatedAt = new Date().toISOString()
                goal.blocker = {
                  reason: `Evaluator rejected ${runtime.evaluatorRejectionCount} time(s). Last failure:\n${failureDetails.slice(0, 500)}`,
                  needed: "Fix the failing checks and retry the goal.",
                  at: new Date().toISOString(),
                }
                runtime.forceFinishRequested = undefined
                // Emit blocked event
                await appendEvent(dir, {
                  version: 1,
                  eventID: randomUUID(),
                  goalID: goal.id,
                  type: "goal.blocked",
                  reason: goal.blocker.reason,
                  needed: goal.blocker.needed,
                  timestamp: new Date().toISOString(),
                  revision: state.revision,
                } satisfies LoopEvent)
              } else {
                // Free retry: grant un-charged continuation
                runtime.forceFinishRequested = false
                runtime.freeRetryPending = true
              }
              runtime.updatedAt = new Date().toISOString()
              await writeState(dir, state)
            }
            return {
              title: "Completion rejected — keep working",
              output: JSON.stringify({
                passed: false,
                failedChecks: checkResults.failures,
                message: "Evaluator rejected completion. Fix the issues above and try again.",
                rejectionCount: runtime?.evaluatorRejectionCount || 0,
                status: goal.status,
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
