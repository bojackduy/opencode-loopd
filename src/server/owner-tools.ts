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
import { resolveManagedDirs } from "../infrastructure/managed-dirs"
import { SERVER_LOG_FILE } from "../infrastructure/server-log"

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

function resolveTargetDir(instanceDir: string, override?: string): string {
  if (typeof override !== "string" || !override.trim()) return instanceDir
  const trimmed = override.trim()
  if (path.isAbsolute(trimmed)) return path.normalize(trimmed)
  return path.normalize(path.resolve(instanceDir, trimmed))
}

export function ownerTools(options: OwnerToolsOptions) {
  const { directory, host, goalService } = options

  return {
    loopd_list_models: tool({
      description:
        "Discover host providers/models and available OpenCode agents, inspect quota limitations plus assigned identities of this session's existing goals. " +
        "Remaining quota is unknown unless a supported integration reports it; connected/enabled is not remaining balance. " +
        "Workflow: discover -> inspect_background_goal for last local quota error -> switch_goal_identity on the SAME goal, never create a duplicate to change provider. No secrets/auth data are returned.",
      args: {},
      execute: async (_args, context) => {
        if (!context?.sessionID) return { title: "No session", output: JSON.stringify({ ok: false, message: "No session context available." }) }
        const [catalog, agentCatalog, state] = await Promise.all([goalService.listModels(), goalService.listAgents(), readState(directory)])
        return {
          title: "Provider/model capabilities",
          output: JSON.stringify({
            ok: true, ...catalog, agents: agentCatalog.agents, agentCatalog,
            assignedGoals: state.goals.filter((g) => g.ownerSessionID === context.sessionID).map((g) => ({
              id: g.id, model: g.config.model, agent: g.config.agent, agentSwitch: g.agentSwitch, pendingIdentity: g.pendingIdentity, workerSessionID: g.workerSessionID,
              modelSwitch: g.modelSwitch, modelFallback: g.modelFallback, fallbackModels: g.config.fallbackModels ?? [], lastProviderLimit: g.lastProviderLimit,
            })),
          }, null, 2),
        }
      },
    }),

    switch_goal_identity: tool({
      description: "Switch an EXISTING owned goal's model, agent, or both atomically, preserving the same worker/session, transcript, progress, inbox, checks, budgets and topology. At least one of model or agent is required. Discover identities with loopd_list_models first. Busy workers defer until the next permitted idle turn; legacy hosts apply on the next prompt. No implicit unpause or interactive wake. resume=true explicitly resumes only a blocked goal after a safe switch (model-only requires a provider-limit blocker); busy requests remain blocked until explicitly retried/resumed when idle. Combined host failures roll back successful changes; rollback failure requires inspecting the existing session. For a goal living in another workspace (lane worktree, monorepo package, other project) pass that absolute path as `directory`; otherwise the lookup fails because state is per-directory. Prefer this over editing state.json.",
      args: {
        goal_id: tool.schema.string().describe("Existing owned goal ID."),
        agent: tool.schema.string().optional().describe("Available agent name from loopd_list_models."),
        model: tool.schema.string().optional().describe("Available providerID/modelID from loopd_list_models. Provide model, agent, or both."),
        resume: tool.schema.boolean().optional().describe("Explicitly resume a blocked goal after a safe switch. Default false."),
        directory: tool.schema.string().optional().describe("Project directory override. Omit to use the instance directory. Required when the goal lives in another workspace/lane."),
      },
      execute: async (args, context) => {
        if (!context?.sessionID) return { title: "No session", output: JSON.stringify({ ok: false, message: "No session context available." }) }
        if (args.model === undefined && args.agent === undefined) return { title: "Identity switch failed", output: JSON.stringify({ ok: false, message: "At least one of model or agent is required." }) }
        const target = resolveTargetDir(directory, args.directory)
        const state = await readState(target)
        if (!state.goals.some((g) => g.id === args.goal_id && g.ownerSessionID === context.sessionID)) {
          return { title: "Switch denied", output: JSON.stringify({ ok: false, message: `Goal not found or not owned by this session in ${target}. If the goal lives in another workspace (e.g. a lane worktree), pass its absolute path as directory.` }) }
        }
        try {
          const result = await goalService.switchIdentity(target, args.goal_id as GoalID, context.sessionID, args)
          return { title: `Identity switch: ${result.outcome}`, output: JSON.stringify({ ok: result.outcome !== "unsupported", ...result, goalID: args.goal_id, message: "Same goal and worker retained. Deferred requests require the next permitted idle turn; no automatic interactive wake." }) }
        } catch (error) {
          // Don't leak host internals (e.g. SUPER-SECRET) — log details server-side, return single-thing message.
          const isHostError = error instanceof Error && /host|unsupported|unavailable/i.test(error.message)
          const hint = isHostError
            ? "Host unavailable to switch identity. Retry after host recovers; check loopd-server.log and loopd_list_models."
            : "Switch rejected: check loopd_list_models and inspect_background_goal for the specific blocker (ownership, model availability, or resume eligibility)."
          return { title: "Identity switch failed", output: JSON.stringify({ ok: false, message: `${hint} Existing goal/session retained.` }) }
        }
      },
    }),

    attach_worker_session: tool({
      description:
        "Attach an EXISTING OpenCode session as the worker of an owned goal, replacing the current worker. Use when you want a specific session (e.g. one a human is driving, or a lane's session) to do the work instead of the spawned worker. The goal, checks, budgets, scope and transcript are retained; the new session gains the worker tools and scope for this goal. The previous worker session is retired (its late tools are fenced). Requires the host to verify the session. For a goal living in another workspace pass its absolute path as `directory`. Does not start a turn — send_goal_input or nudge_goal afterward.",
      args: {
        goal_id: tool.schema.string().describe("Owned goal ID."),
        session_id: tool.schema.string().describe("Existing OpenCode session ID (ses_...) to attach as worker."),
        directory: tool.schema.string().optional().describe("Project directory override. Omit to use the instance directory."),
      },
      execute: async (args, context) => {
        if (!context?.sessionID) return { title: "No session", output: JSON.stringify({ ok: false, message: "No session context available." }) }
        const target = resolveTargetDir(directory, args.directory)
        const state = await readState(target)
        const goal = state.goals.find((g) => g.id === args.goal_id && g.ownerSessionID === context.sessionID)
        if (!goal) {
          return { title: "Attach denied", output: JSON.stringify({ ok: false, message: `Goal not found or not owned by this session in ${target}. If the goal lives in another workspace, pass its absolute path as directory.` }) }
        }
        try {
          const result = await goalService.attachWorker(target, args.goal_id as GoalID, context.sessionID, args.session_id)
          return { title: "Worker attached", output: JSON.stringify({ ok: true, ...result, message: `Session ${args.session_id} is now the worker for "${goal.name}". Send it work with send_goal_input or nudge_goal.` }) }
        } catch (error) {
          return { title: "Attach failed", output: JSON.stringify({ ok: false, message: error instanceof Error ? error.message : String(error) }) }
        }
      },
    }),

    send_to_session: tool({
      description:
        "Send a bare turn to ANY OpenCode session (no goal, no lease, no checks, no scope, no steering). Direct session-to-session talk: bypasses all loop machinery. Use when you need to talk to a session directly without creating/attaching a goal. The session's own permissions still gate writes; two concurrent sends to the same session can interleave, so check status first. Does not register it as a worker.",
      args: {
        session_id: tool.schema.string().describe("Existing OpenCode session ID (ses_...)."),
        text: tool.schema.string().describe("The turn to send."),
        directory: tool.schema.string().optional().describe("Project directory override. Omit to use the instance directory."),
      },
      execute: async (args, context) => {
        if (!context?.sessionID) return { title: "No session", output: JSON.stringify({ ok: false, message: "No session context available." }) }
        const target = resolveTargetDir(directory, args.directory)
        const known = host.sessionKnown ? await host.sessionKnown(args.session_id).catch(() => undefined) : undefined
        if (known === false) return { title: "Unknown session", output: JSON.stringify({ ok: false, message: `Session ${args.session_id} is not known to the host.` }) }
        const status = host.sessionStatus ? await host.sessionStatus(args.session_id).catch(() => "unknown" as const) : undefined
        if (status === "busy") return { title: "Busy", output: JSON.stringify({ ok: false, message: `Session ${args.session_id} is busy; queued text will be delivered by the host on next idle. Use peek_session to inspect.` }) }
        const result = host.promptSession ? await host.promptSession(args.session_id, args.text).catch(() => ({ messageID: undefined })) : { messageID: undefined }
        return { title: result?.messageID ? "Sent" : "Send failed", output: JSON.stringify({ ok: !!result?.messageID, session_id: args.session_id, directory: target, messageID: result?.messageID }) }
      },
    }),

    peek_session: tool({
      description:
        "Read-only visibility into ANY session: is it a worker of some goal, owner of which, runtime state, live host status + last assistant text, fence holders, tickets, transcript tail. Use instead of manual log/state archaeology. Does not mutate. No loop machinery involved.",
      args: {
        session_id: tool.schema.string().describe("OpenCode session ID (ses_...)."),
        directory: tool.schema.string().optional().describe("Project directory override. Omit to use the instance directory."),
        includeTranscript: tool.schema.boolean().optional().describe("Include live transcript tail (default true)."),
        transcriptLimit: tool.schema.number().optional().describe("Transcript messages to include (1-10, default 4)."),
      },
      execute: async (args, context) => {
        if (!context?.sessionID) return { title: "No session", output: JSON.stringify({ ok: false, message: "No session context available." }) }
        const target = resolveTargetDir(directory, args.directory)
        const state = await readState(target)
        const asWorker = state.goals.filter((g) => g.workerSessionID === args.session_id).map((g) => ({ id: g.id, name: g.name, status: g.status, ownerSessionID: g.ownerSessionID, topology: g.workerTopology }))
        const asOwner = state.goals.filter((g) => g.ownerSessionID === args.session_id).map((g) => ({ id: g.id, name: g.name, status: g.status, workerSessionID: g.workerSessionID }))
        const retired = (state.retiredWorkerSessions ?? []).includes(args.session_id)
        const fences = (state.workspaceCalls ?? []).filter((c) => c.sessionID === args.session_id)
        const tickets = (state.writeTickets?.holders ?? []).filter((h) => h.sessionID === args.session_id)
        const [known, status, exec] = await Promise.all([
          host.sessionKnown ? host.sessionKnown(args.session_id).catch(() => undefined) : Promise.resolve(undefined),
          host.sessionStatus ? host.sessionStatus(args.session_id).catch(() => "unknown" as const) : Promise.resolve(undefined),
          host.readExecution ? host.readExecution(args.session_id).catch(() => null) : Promise.resolve(null),
        ])
        const includeTranscript = args.includeTranscript !== false
        const tLimit = Math.min(10, Math.max(1, args.transcriptLimit ?? 4))
        const transcriptTail = includeTranscript && known !== false
          ? await withTimeout(host.readMessages(args.session_id, tLimit), 1200).catch(() => null)
          : null
        let recentLog: Array<{ timestamp: string; event: string; extra?: Record<string, unknown> }> = []
        try {
          const raw = await fs.readFile(SERVER_LOG_FILE, "utf8")
          const lines = raw.split("\n").filter(Boolean)
          for (const line of lines.slice(-2000)) {
            try {
              const e = JSON.parse(line)
              if (e?.sessionID !== args.session_id) continue
              const { timestamp, event, ...rest } = e
              recentLog.push({ timestamp, event, extra: Object.keys(rest).length ? rest : undefined })
            } catch { /* skip */ }
          }
          recentLog = recentLog.slice(-30)
        } catch { /* no log file */ }
        return {
          title: `Peek: ${args.session_id}`,
          output: JSON.stringify({
            ok: true,
            session_id: args.session_id,
            directory: target,
            known,
            workerStatus: status,
            hostExecution: exec,
            retired,
            asWorkerOf: asWorker,
            asOwnerOf: asOwner,
            fences,
            tickets,
            transcriptTail: transcriptTail ? (transcriptTail as any[]).map((m: any) => ({ role: m.role, content: String(m.content || "").slice(0, 300), timestamp: m.timestamp, messageID: m.messageID })) : undefined,
            recentLog,
          }, null, 2),
        }
      },
    }),

    list_background_goals: tool({
      description:
        "List all active background goals owned by this session. Shows contract (name, status, phase, turn, last progress, blocker) — only goals with your ownerSessionID appear. Scope caveat: this reads only the server's own workspace state. A goal created in another directory (lane worktree, monorepo package, other project) is invisible here — pass that absolute path as `directory`, or use the dashboard Fleet tab, which merges every directory registered in `.opencode/loopd/managed.json` (or LOOPD_MANAGED_DIRS) and routes each action to that directory's server. Never hand-edit another workspace's state.json.",
      args: {
        directory: tool.schema.string().optional().describe("Project directory override. Omit to use the instance directory."),
      },
      execute: async (args, context) => {
        const target = resolveTargetDir(directory, (args as { directory?: string }).directory)
        const state = await readState(target)
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
            modelSwitch: g.modelSwitch,
            agentSwitch: g.agentSwitch,
            pendingIdentity: g.pendingIdentity,
            modelFallback: g.modelFallback,
            lastProviderLimit: g.lastProviderLimit,
            fallbackModels: g.config.fallbackModels ?? [],
            quotaLimitation: "Remaining provider quota unknown; connected/enabled is not balance data. See loopd_list_models.",
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
          output: JSON.stringify({ ok: true, goals: summaries, directory: target }, null, 2),
        }
      },
    }),

    loopd_status_all: tool({
      description:
        "List owned active goals across all managed directories (instance directory + registry .opencode/loopd/managed.json + LOOPD_MANAGED_DIRS env — same unified resolver as the TUI :projects view). Each entry includes its directory.",
      args: {},
      execute: async (_args, context) => {
        const ownerID = context?.sessionID
        if (!ownerID) {
          return {
            title: "No session",
            output: JSON.stringify({ ok: false, message: "No session context available." }),
          }
        }
        const dirs = await resolveManagedDirs(directory).catch(() => [directory])
        const goals: Array<Record<string, unknown>> = []
        for (const dir of dirs) {
          let state
          try {
            state = await readState(dir)
          } catch {
            continue
          }
          for (const g of state.goals.filter((entry) => entry.ownerSessionID === ownerID && entry.status !== "complete")) {
            const runtime = state.runtimes.find((r) => r.goalID === g.id) as any
            goals.push({
              id: g.id,
              name: g.name,
              status: g.status,
              phase: runtime?.phase ?? "unknown",
              turn: runtime?.runCount ?? 0,
              directory: dir,
              lastProgress: g.lastProgress?.summary?.slice(0, 120),
              blocker: g.blocker?.reason?.slice(0, 120),
            })
          }
        }
        return {
          title: `${goals.length} active goal(s) across ${dirs.length} dir(s)`,
          output: JSON.stringify({ ok: true, dirs, goals }, null, 2),
        }
      },
    }),

    inspect_background_goal: tool({
      description:
        "Inspect a goal’s full contract, runtime, and live execution state: objective, config{agent,model,checks,checkCwd,workspaceWrite,limits}, progress, blocker, runtime{phase,runCount,budgetTurnCount,runGeneration,evaluatorRejectionCount,unknownStatusCount,lastActivityAt,activePromptMessageID}, plus live transcriptTail, activeToolCallIDs, progressHistory, artifactSummary, pendingInbox, and live.now{workerStatus, hostExecutionStatus, hostOutcome, runID, runGeneration, promptMessageID, assistantMessageID, turnStartedAt, lastActivityAt, leaseExpiresAt, leaseValid, lastAssistantText, lastAssistantAt} — the current turn, not just the last report. Single-call follow-up for parent to see what child is actually doing.",
      args: {
        goal_id: tool.schema.string().optional().describe("Goal ID. Omit to inspect the first active goal."),
        includeTranscript: tool.schema.boolean().optional().describe("Include live transcript tail (adds ~100ms). Default true. Set false for fast metadata-only."),
        transcriptLimit: tool.schema.number().optional().describe("Number of transcript messages to include (1-10). Default 3."),
        directory: tool.schema.string().optional().describe("Project directory override. Omit to use the instance directory."),
      },
      execute: async (args, context) => {
        const target = resolveTargetDir(directory, args.directory)
        const state = await readState(target)
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
          readEvents(target, 60).then((evs) =>
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
          peekGoalInbox(target, goal.id).then((msgs) => msgs.slice(-3)).catch(() => []),
        ] as const)

        const activeToolCallIDs = runtime?.activeToolCallIDs ?? []
        // What the worker is doing NOW, not what it reported last turn. The host
        // status is the only live truth we can ask for; everything else is
        // bookkeeping that may lag a whole turn.
        const [liveStatus, liveExecution] = await Promise.all([
          goal.workerSessionID && host.sessionStatus
            ? withTimeout(Promise.resolve(host.sessionStatus(goal.workerSessionID)), 900).catch(() => "unknown" as const)
            : Promise.resolve(undefined),
          goal.workerSessionID && host.readExecution
            ? withTimeout(Promise.resolve(host.readExecution(goal.workerSessionID)), 1200).catch(() => null)
            : Promise.resolve(null),
        ])
        const lastAssistant = (transcriptTail as any[] | null)?.filter((m: any) => m?.role === "assistant").at(-1)
        const liveNow = {
          workerStatus: liveStatus,
          hostExecutionStatus: (liveExecution as any)?.status,
          hostOutcome: (liveExecution as any)?.outcome,
          latestUserMessageID: (liveExecution as any)?.latestUserMessageID,
          runID: runtime?.activeRunID,
          runGeneration: runtime?.runGeneration,
          promptMessageID: runtime?.activePromptMessageID,
          assistantMessageID: runtime?.activeAssistantMessageID,
          turnStartedAt: runtime?.turnStartedAt,
          lastActivityAt: runtime?.lastActivityAt,
          leaseExpiresAt: runtime?.leaseExpiresAt,
          leaseValid: runtime?.leaseExpiresAt ? Date.now() < Date.parse(runtime.leaseExpiresAt) : false,
          lastAssistantText: lastAssistant ? String(lastAssistant.content || "").slice(0, 600) : undefined,
          lastAssistantAt: lastAssistant?.timestamp,
        }

        return {
          title: `Goal: ${goal.name}`,
          output: JSON.stringify({
            ok: true,
            directory: target,
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
              write_scope: goal.config.write_scope,
              approvedCommands: goal.config.approvedCommands,
              scopeClosing: goal.scopeClosing === true,
              scopeClearPending: goal.scopeClearPending === true,
              scopeRetryPolicy: "coordinate_then_retry_no_automatic_queue",
              agent: goal.config.agent,
              model: goal.config.model,
              fallbackModels: goal.config.fallbackModels ?? [],
              parentAgent: goal.parentAgent,
              parentModel: goal.parentModel,
              schedule: (goal.config as any).schedule,
            },
            lastProgress: goal.lastProgress,
            modelSwitch: goal.modelSwitch,
            agentSwitch: goal.agentSwitch,
            pendingIdentity: goal.pendingIdentity,
            modelFallback: goal.modelFallback,
            lastProviderLimit: goal.lastProviderLimit,
            quotaLimitation: "Remaining provider quota unknown; local quota errors are observations, not balance data. See loopd_list_models.",
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
              nativeReconcileBlocked: runtime?.nativeReconcileBlocked,
              pendingToolCalls: activeToolCallIDs.length,
              lastActivityAge: runtime?.lastActivityAt ? `${Math.floor((Date.now() - Date.parse(runtime.lastActivityAt)) / 1000)}s ago` : undefined,
              now: liveNow,
            },
            lastAnnouncement: goal.lastAnnouncement,
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
        directory: tool.schema.string().optional().describe("Project directory override. Omit to use the instance directory."),
      },
      execute: async (args, context) => {
        const target = resolveTargetDir(directory, args.directory)
        const state = await readState(target)
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
              directory: target,
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
        directory: tool.schema.string().optional().describe("Project directory override. Omit to use the instance directory."),
      },
      execute: async (args, context) => {
        const target = resolveTargetDir(directory, args.directory)
        const state = await readState(target)
        const ownerID = context?.sessionID
        const goal = args.goal_id
          ? state.goals.find((g) => g.id === args.goal_id)
          : state.goals.find((g) => g.ownerSessionID === ownerID && g.status !== "complete")

        if (!goal) {
          return {
            title: "No goal found",
            output: JSON.stringify({ ok: false, outcome: "not_found", message: args.goal_id ? "Goal not found (it may have been cleared). List your goals instead of retrying this ID." : "No matching active goal for this session." }),
          }
        }

        if (goal.ownerSessionID !== ownerID) {
          return { title: "Not authorized", output: JSON.stringify({ ok: false, outcome: "unauthorized", message: "This session cannot control that goal." }) }
        }
        const result = await goalService.sendUserMessage(target, goal.id, args.message)

        return {
          title: result.ok ? result.outcome === "queued" ? "Message queued" : "Message submitted" : "Send failed",
          output: JSON.stringify({
            ...result,
            directory: target,
            goalID: goal.id,
            goalName: goal.name,
            message: result.message,
          }),
        }
      },
    }),

    pause_goal: tool({
      description:
        "Pause an active goal under its operation mutex. Protected writes are fenced before abort; ownership remains held until in-flight tools drain. Use to investigate or release file claims after quiescence.",
      args: {
        goal_id: tool.schema.string().optional().describe("Goal ID. Omit to pause the first active goal."),
        directory: tool.schema.string().optional().describe("Project directory override. Omit to use the instance directory."),
      },
      execute: async (args, context) => {
        const target = resolveTargetDir(directory, args.directory)
        const state = await readState(target)
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
          await goalService.pause(target, goal.id)
          return {
            title: "Goal paused",
            output: JSON.stringify({
              ok: true,
              directory: target,
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
        "Resume a paused or retry a blocked goal. Atomically reacquires scope; overlapping ownership/in-flight writes deny activation. Explicit scoped workers rotate sessions to fence late tools; legacy workers retain their session. Per-goal mutex.",
      args: {
        goal_id: tool.schema.string().optional().describe("Goal ID. Omit to resume the first paused/blocked goal."),
        directory: tool.schema.string().optional().describe("Project directory override. Omit to use the instance directory."),
      },
      execute: async (args, context) => {
        const target = resolveTargetDir(directory, args.directory)
        const state = await readState(target)
        const ownerID = context?.sessionID
        const goal = args.goal_id
          ? state.goals.find((g) => g.id === args.goal_id)
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
              outcome: "not_found",
              message: args.goal_id ? "Goal not found (it may have been cleared). List your goals instead of retrying this ID." : "No matching paused/blocked goal for this session.",
            }),
          }
        }

        if (goal.ownerSessionID !== ownerID) {
          return { title: "Not authorized", output: JSON.stringify({ ok: false, outcome: "unauthorized", message: "This session cannot control that goal." }) }
        }

        if (goal.status === "active") {
          return {
            title: "Already active",
            output: JSON.stringify({ ok: true, message: `Goal "${goal.name}" is already active.` }),
          }
        }

        try {
          const result = goal.status === "blocked"
            ? await goalService.retry(target, goal.id)
            : await goalService.resume(target, goal.id)
          return {
            title: result.ok ? "Resume submitted" : "Resume not delivered",
            output: JSON.stringify({
              ...result,
              directory: target,
              goalID: goal.id,
              goalName: goal.name,
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
        "Request a recovery turn for an active goal after confirmed worker idle. Returns the actual delivery outcome or actionable blocker (in-flight writes, workspace operation, busy/unknown worker, pending identity, quota). Never interrupts a live worker or duplicates an unconfirmed prompt. Per-goal mutex.",
      args: {
        goal_id: tool.schema.string().optional().describe("Goal ID. Omit to nudge the first active goal."),
        directory: tool.schema.string().optional().describe("Project directory override. Omit to use the instance directory."),
      },
      execute: async (args, context) => {
        const target = resolveTargetDir(directory, args.directory)
        const state = await readState(target)
        const ownerID = context?.sessionID
        const goal = args.goal_id
          ? state.goals.find((g) => g.id === args.goal_id)
          : state.goals.find((g) => g.ownerSessionID === ownerID && g.status !== "complete")

        if (!goal) {
          return {
            title: "No goal found",
            output: JSON.stringify({ ok: false, outcome: "not_found", message: args.goal_id ? "Goal not found (it may have been cleared). List your goals instead of retrying this ID." : "No matching active goal for this session." }),
          }
        }

        if (goal.ownerSessionID !== ownerID) {
          return { title: "Not authorized", output: JSON.stringify({ ok: false, outcome: "unauthorized", message: "This session cannot control that goal." }) }
        }
        try {
          const result = await goalService.nudge(target, goal.id)
          return {
            title: result.ok ? "Goal nudged" : "Nudge failed",
            output: JSON.stringify({ ...result, directory: target, goalID: goal.id, goalName: goal.name }),
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
        directory: tool.schema.string().optional().describe("Project directory override. Omit to use the instance directory."),
      },
      execute: async (args, context) => {
        const target = resolveTargetDir(directory, args.directory)
        const state = await readState(target)
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
          const result = await goalService.abortWorker(target, goal.id)
          return {
            title: result.ok ? "Worker aborted" : "Abort failed",
            output: JSON.stringify({ ...result, directory: target, goalID: goal.id, goalName: goal.name }),
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
        directory: tool.schema.string().optional().describe("Project directory override. Omit to use the instance directory."),
      },
      execute: async (args, context) => {
        const target = resolveTargetDir(directory, args.directory)
        const state = await readState(target)
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
        const st = await rs(target)
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
        await ws(target, st)
        await ae(target, {
          version: 1,
          eventID: randomUUID(),
          goalID: goal.id as any,
          type: "goal.completed",
          summary: args.summary,
          evidence: args.evidence,
          timestamp: new Date().toISOString(),
          revision: st.revision,
        })
        return { title: "Goal force-completed", output: JSON.stringify({ ok: true, directory: target, goalID: goal.id, goalName: g.name }) }
      },
    }),

    force_block_goal: tool({
      description:
        "Force-block a goal with reason/needed (:block in TUI). Use when the goal is stuck on an external blocker and should stop retrying.",
      args: {
        goal_id: tool.schema.string().optional().describe("Goal ID. Omit to target the first non-complete goal."),
        reason: tool.schema.string().describe("Why the goal is blocked."),
        needed: tool.schema.string().describe("What is needed to unblock."),
        directory: tool.schema.string().optional().describe("Project directory override. Omit to use the instance directory."),
      },
      execute: async (args, context) => {
        const target = resolveTargetDir(directory, args.directory)
        const state = await readState(target)
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
        const st = await rs(target)
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
        await ws(target, st)
        await ae(target, {
          version: 1,
          eventID: randomUUID(),
          goalID: goal.id as any,
          type: "goal.blocked",
          reason: args.reason,
          needed: args.needed,
          timestamp: new Date().toISOString(),
          revision: st.revision,
        })
        return { title: "Goal blocked", output: JSON.stringify({ ok: true, directory: target, goalID: goal.id, goalName: g.name }) }
      },
    }),

    clear_goal: tool({
      description:
        "Clear a goal: aborts worker and removes goal+runtime+ledger (cannot be undone). Use when the goal is no longer needed or to free a stuck writer slot after inspection.",
      args: {
        goal_id: tool.schema.string().optional().describe("Goal ID. Omit to clear the first active goal."),
        directory: tool.schema.string().optional().describe("Project directory override. Omit to use the instance directory."),
      },
      execute: async (args, context) => {
        const target = resolveTargetDir(directory, args.directory)
        const state = await readState(target)
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
          await goalService.clear(target, goal.id)
          return {
            title: "Goal cleared",
            output: JSON.stringify({
              ok: true,
              directory: target,
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

    loopd_release_workspace: tool({
      description:
        "Diagnose and release stuck workspace write reservations (the fence that makes every write, check and goal start fail with \"Workspace is busy…\"). Call with no arguments to list every live reservation and whether it is releasable; then call again naming call_id, goal_id or session_id to release. Releasable = a goal you own, a reservation your own session made, or one whose goal no longer exists (nobody else can ever free those). A reservation whose session still belongs to a live goal is refused — those may be genuinely mid-write. Prefer this over editing state.json by hand.",
      args: {
        call_id: tool.schema.string().optional().describe("Exact reservation to release, from the no-argument listing."),
        goal_id: tool.schema.string().optional().describe("Release every reservation owned by this goal (only if you own it, or the goal no longer exists)."),
        session_id: tool.schema.string().optional().describe("Release reservations held by this execution session (only when releasable)."),
        directory: tool.schema.string().optional().describe("Project directory override. Omit to use the instance directory."),
      },
      execute: async (args, context) => {
        const ownerID = context?.sessionID
        if (!ownerID) {
          return {
            title: "No session",
            output: JSON.stringify({ ok: false, message: "No session context available, so reservation ownership cannot be matched." }),
          }
        }
        const target = resolveTargetDir(directory, args.directory)
        const selecting = Boolean(args.call_id || args.goal_id || args.session_id)
        if (!selecting) {
          const report = await goalService.workspaceReservations(target, ownerID)
          return {
            title: `${report.reservations.length} reservation(s)`,
            output: JSON.stringify({
              ok: true,
              mode: "inspect",
              directory: target,
              message: report.reservations.length
                ? "Re-call with call_id (or goal_id/session_id) to release a releasable entry."
                : "No live workspace reservations — nothing is fencing this project.",
              ...report,
            }),
          }
        }
        const result = await goalService.releaseWorkspace(target, ownerID, {
          callID: args.call_id,
          goalID: args.goal_id,
          sessionID: args.session_id,
        })
        return {
          title: result.ok ? `Released ${result.released.length}` : "Release refused",
          output: JSON.stringify({ mode: "release", ...result }),
        }
      },
    }),

    grant_approved_command: tool({
      description:
        "Grant ONE more owner-authorized command to an ACTIVE goal you own, mid-run (same strict rules as loopd_create_goal approvedCommands). For scoped workers that discover they need a command (tar, test runner, builder) the goal was not created with. Finite commands run to completion under the workspace lock; servers stay managed and stop with the goal. Owner-only: workers can never grant themselves authority. The worker picks it up on its next turn — nudge it if it is idle-waiting. Append-only: no revoke, no overwrite; clearing the goal removes everything.",
      args: {
        goal_id: tool.schema.string().describe("Active owned goal ID."),
        name: tool.schema.string().describe("Unique command name (letters, digits, dots, underscores, hyphens). The worker invokes it by this name only."),
        command: tool.schema.string().describe("Fixed executable (e.g. \"tar\"). Never a shell string."),
        args: tool.schema.array(tool.schema.string()).describe("Fixed argument vector, one element per argument."),
        cwd: tool.schema.string().describe("Workspace-relative directory that must already exist (e.g. \".\" for the project root)."),
        kind: tool.schema.enum(["finite", "server"]).describe("finite runs once under the workspace lock; server stays managed and stops with the goal."),
        timeoutSeconds: tool.schema.number().positive().finite().optional().describe("Finite-command timeout in seconds (positive integer)."),
      },
      execute: async (args, context) => {
        const ownerID = context?.sessionID
        if (!ownerID) {
          return { title: "No session", output: JSON.stringify({ ok: false, message: "No session context available, so ownership cannot be matched." }) }
        }
        const result = await goalService.grantApprovedCommand(directory, ownerID, args.goal_id, {
          name: args.name,
          command: args.command,
          args: args.args,
          cwd: args.cwd,
          kind: args.kind,
          ...(args.timeoutSeconds !== undefined ? { timeoutSeconds: args.timeoutSeconds } : {}),
        })
        return {
          title: result.ok ? `Granted ${args.name}` : "Grant refused",
          output: JSON.stringify(result),
        }
      },
    }),

    grant_write_scope: tool({
      description:
        "Widen write_scope of an ACTIVE scoped goal you own, mid-run — append exact file paths without recreating the goal. Same strict validation as creation (workspace-relative, no globs, no directory escape). Workers can also self-serve via claim_goal_scope, but this is the owner escape hatch when you want to open scope for them. Append-only, no revoke.",
      args: {
        goal_id: tool.schema.string().describe("Active owned goal ID."),
        paths: tool.schema.array(tool.schema.string()).describe("Exact workspace-relative file paths to add (e.g. [\"src/a.ts\",\"lib/b.js\"])."),
      },
      execute: async (args, context) => {
        const ownerID = context?.sessionID
        if (!ownerID) {
          return { title: "No session", output: JSON.stringify({ ok: false, message: "No session context available, so ownership cannot be matched." }) }
        }
        const result = await goalService.grantWriteScope(directory, ownerID, args.goal_id, args.paths)
        return {
          title: result.ok ? `Scope widened` : "Grant refused",
          output: JSON.stringify(result),
        }
      },
    }),
  }
}
