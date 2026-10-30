// ─── Application: Loop Engine ────────────────────────────────────────────────
// The central orchestrator. Handles session events, drives continuation,
// enforces limits, and manages compaction.
// Zero-cost when no goals exist: event hook filters by type before disk read.

import { randomUUID } from "crypto"
import { readState, mutateState, appendEvent } from "../infrastructure/state-repository"
import type { StoreState } from "../infrastructure/state-repository"
import type { GoalID } from "../domain/goal"
import {
  releaseLease,
  recordActivity,
  shouldNotifyParent,
  markParentNotified,
  type GoalRuntimeState,
} from "../domain/runtime"
import type { LoopEvent, NativeReconcileBlockedEvent } from "../domain/events"
import type { GoalService } from "./goal-service"
import type { LoopHost } from "../server/host-adapter"
import type { WorkspaceSweepSummary } from "./workspace-execution"
import { releaseTerminalWorkspaceCalls, reconcileTerminalWorkspaceCalls } from "./workspace-execution"
import { terminalToolExecution } from "../domain/tool-execution"
import { isOutputlessTurn } from "../domain/message-turn"
import { describeError, logServerEvent } from "../infrastructure/server-log"

/** Two-stage idle debounce — require two idle signals 2s apart with no activity in between. */
const CONFIRM_IDLE_DURATION_MS = 2000

const HANDLED_EVENT_TYPES = new Set([
  "session.idle",
  "session.status",
  "session.error",
  "session.compacted",
  "session.execution.succeeded",
  "session.execution.started",
  "session.execution.failed",
  "session.execution.interrupted",
  "message.updated",
  "message.part.updated",
])

export interface LoopEngineOptions {
  directory: string
  host: LoopHost
  goalService: GoalService
  pollIntervalMs?: number
  confirmIdleMs?: number
  unknownStatusThreshold?: number
  /** Quiet time before a lease-expired running turn is reported stuck. Default 10 min. */
  stuckRunningMs?: number
  /** Quiet time before an unconfirmable idle turn is reported stuck. Default 5 min. */
  idleUnconfirmedMs?: number
  /** Quiet time before a running-phase stall on an idle worker is auto-recovered. Default 3 min. */
  idleRecoverMs?: number
  /** Continuous provider-retry time before one failure is charged. Default 2 min. */
  providerRetryGraceMs?: number
}

export interface LoopEngine {
  start(): void
  stop(): void
  isRunning(): boolean
  /** Handle a plugin event. Returns true if the event was consumed. */
  handleEvent(event: any): Promise<boolean>
  /** Preload worker sessions into cache (for tests). */
  preloadWorkerSessions(): Promise<void>
}

export function createLoopEngine(options: LoopEngineOptions): LoopEngine {
  const { directory, host, goalService } = options
  const maintenanceMs = options.pollIntervalMs ?? 30_000
  const confirmIdleMs = options.confirmIdleMs ?? CONFIRM_IDLE_DURATION_MS
  const unknownStatusThreshold = Math.max(1, options.unknownStatusThreshold ?? 3)
  const stuckRunningMs = options.stuckRunningMs ?? 10 * 60_000
  const idleUnconfirmedMs = options.idleUnconfirmedMs ?? 5 * 60_000
  const idleRecoverMs = options.idleRecoverMs ?? 3 * 60_000
  const providerRetryGraceMs = options.providerRetryGraceMs ?? 2 * 60_000

  let running = false
  let maintenanceTimer: ReturnType<typeof setInterval> | undefined
  let maintaining = false
  // In-memory cache of worker session IDs — avoids disk read on every event
  let knownWorkerSessions = new Set<string>()
  let knownWorkerSessionsLoaded = false
  // Guard against concurrent continuations for the same goal
  const inflightContinuations = new Set<GoalID>()
  const recentForceFinishBlocked = new Map<GoalID, number>()

  async function loadWorkerSessionsIfneeded() {
    if (knownWorkerSessionsLoaded) return
    try {
      const state = await readState(directory)
      for (const g of state.goals) {
        if (g.workerSessionID) knownWorkerSessions.add(g.workerSessionID)
      }
      knownWorkerSessionsLoaded = true
    } catch {}
  }

  function syncWorkerSessionsFromService() {
    for (const worker of goalService.getActiveWorkers().values()) {
      knownWorkerSessions.add(worker.workerSessionID)
    }
  }

  // Exposed for tests to preload worker sessions
  async function preloadWorkerSessions() {
    await loadWorkerSessionsIfneeded()
    syncWorkerSessionsFromService()
  }

  function start() {
    if (running) return
    running = true
    // Load worker sessions eagerly so event hook is ready immediately
    loadWorkerSessionsIfneeded().catch(() => {})
    // Maintenance timer — much slower than before (30s vs 5s)
    maintenanceTimer = setInterval(() => {
      if (running && !maintaining) {
        maintaining = true
        maintenance().catch(() => {}).finally(() => { maintaining = false })
      }
    }, maintenanceMs)
  }

  function stop() {
    running = false
    if (maintenanceTimer) clearInterval(maintenanceTimer)
    maintenanceTimer = undefined
    inflightContinuations.clear()
  }

  function isRunning() {
    return running
  }

  async function continueGoal(goalID: GoalID, opts?: { forceFinish?: boolean }): Promise<boolean> {
    if (inflightContinuations.has(goalID)) return false
    inflightContinuations.add(goalID)
    try {
      const state = await readState(directory)
      const goal = state.goals.find((g) => g.id === goalID)
      const rt = state.runtimes.find((r) => r.goalID === goalID)
      if (!running || !goal || goal.status !== "active" || goal.interactive || !rt) return false
      const forceFinish = opts?.forceFinish || enforceLimits(goal, rt).stop === "force_finish"
      const result = await goalService.continueTurn(directory, goalID, { forceFinish })
      if (!result.ok) await logServerEvent(directory, "engine.continuation-denied", { goalID, outcome: result.outcome, reason: result.message })
      return result.ok && result.outcome === "sent"
    } finally {
      inflightContinuations.delete(goalID)
    }
  }

  // ─── Event Handling ───────────────────────────────────────────────────────

  async function handleEvent(event: any): Promise<boolean> {
    if (!running || !event || typeof event !== "object") return false

    // FAST PATH: filter by event type BEFORE any disk I/O
    const type = event.type as string | undefined
    if (!type || !HANDLED_EVENT_TYPES.has(type)) return false

    // v1 may skip tool.execute.after when the executor throws. Handle exact
    // terminal parts before cleared/owner/retired sessions are filtered out.
    if (type === "message.part.updated") {
      const proof = terminalToolExecution(event.properties?.part)
      if (proof) await releaseTerminalWorkspaceCalls(directory, [proof])
    }

    // FAST PATH: check if this session is one we care about
    const sessionID = eventSessionID(event)
    if (!sessionID) return false

    // Load worker sessions on first event (lazy)
    await loadWorkerSessionsIfneeded()
    syncWorkerSessionsFromService()

    // FAST PATH: if we know there are no worker sessions, skip without disk read
    if (knownWorkerSessionsLoaded && knownWorkerSessions.size === 0) return false

    // FAST PATH: skip events for sessions we don't own
    if (knownWorkerSessions.size > 0 && !knownWorkerSessions.has(sessionID)) return false

    // SLOW PATH: only now read state from disk
    const state = await readState(directory)
    const goal = state.goals.find((g) => g.workerSessionID === sessionID)
    if (!goal) return false

    // Update worker session cache
    if (goal.workerSessionID) knownWorkerSessions.add(goal.workerSessionID)

    // Only active goals own live worker runs. Blocked/limited/paused goals wait
    // for an explicit owner transition.
    if (goal.status !== "active") return false

    if (host.readExecution) {
      // Native lifecycle signals trigger projection reconciliation, never
      // transcript/lease inference. Events have no execution ID in v2.
      if (type.startsWith("session.execution.") || type === "session.idle" || type === "session.status") {
        return await reconcileNativeExecution(goal, event.properties?.error)
      }
      if (type === "message.updated" || type === "message.part.updated") return false
    }

    // Interactive (manual) goals: the engine never starts turns. Idle events
    // from a worker waiting for input must not force a continuation — every
    // turn comes from :send/nudge/resume/retry. Other events are bookkeeping.
    if (goal.interactive === true && type === "session.idle") return false

    switch (type) {
      case "session.idle":
        return await handleSessionIdle(state, goal)
      case "session.status":
        return await handleSessionStatus(state, goal, event)
      case "session.error":
      case "session.execution.failed":
        return await handleSessionError(state, goal, event)
      case "session.compacted":
        return await handleSessionCompacted(state, goal)
      case "message.updated":
      case "message.part.updated":
        return await handleMessageActivity(goal, event)
      case "session.execution.succeeded":
        return await handleExecutionSucceeded(goal)
      default:
        return false
    }
  }

  function eventSessionID(event: any): string | undefined {
    return event.properties?.sessionID
      || event.properties?.info?.sessionID
      || event.properties?.part?.sessionID
  }

  async function handleMessageActivity(goal: any, event: any): Promise<boolean> {
    let matched = false
    let outputless: string | undefined
    const after = await mutateState(directory, `message-activity:${goal.id}`, async (s) => {
      const g = s.goals.find((item) => item.id === goal.id)
      const rt = s.runtimes.find((r) => r.goalID === goal.id)
      if (!g || g.status !== "active" || g.workerSessionID !== goal.workerSessionID || !rt || rt.phase !== "running" || !rt.activePromptMessageID) return s

      if (event.type === "message.updated") {
        const info = event.properties?.info
        if (info?.role === "user" && info.id === rt.activePromptMessageID) {
          Object.assign(rt, recordActivity(rt))
          rt.activePromptObservedAt = new Date().toISOString()
          matched = true
        } else if (info?.role === "assistant" && info.parentID === rt.activePromptMessageID) {
          Object.assign(rt, recordActivity(rt))
          rt.activePromptObservedAt ??= new Date().toISOString()
          rt.activeAssistantMessageID = info.id
          // A turn the host closed without output is a FAILURE, not a completion.
          // Stamping it as an anchor made a quota-closed turn look like delivered
          // work, stranding the goal in phase=running with nothing to show. Route
          // it through the bounded failure path so it is visible and retryable.
          if (isOutputlessTurn(info)) {
            outputless = info.id
            return s
          }
          rt.activeAssistantCompletedAt = info.time?.completed && info.finish !== "tool-calls"
            ? new Date(info.time.completed).toISOString() : undefined
          matched = true
        }
      } else {
        const part = event.properties?.part
        if (part?.messageID && part.messageID === rt.activeAssistantMessageID) {
          // Parts still trickle in after a message completes (tool-result
          // rendering, delayed part events). Treating that as work vetoed idle
          // confirmation indefinitely — a completed message is not activity.
          if (rt.activeAssistantCompletedAt) return s
          Object.assign(rt, recordActivity(rt))
          matched = true
        }
      }
      return s
    })
    if (outputless) {
      const runID = after.runtimes.find((r) => r.goalID === goal.id)?.activeRunID
      return await handleSessionError(after, goal, {
        type: "session.error",
        properties: {
          // The turn is closed, so fence this record to that run.
          expectedRunID: runID,
          runID,
          error: {
            message: `OpenCode closed this turn with no output (no finish reason, no parts, no error). The host accepted prompt ${outputless} and produced nothing — commonly a quota-limited model. No prompt failed at the transport layer; inspect the worker session and provider, then retry.`,
          },
        },
      })
    }
    return matched
  }

  // Completion anchor for v2 worker turns. v2 emits no per-message
  // "message.updated" events, so the transcript scan alone cannot anchor a
  // turn. session.execution.succeeded fires when the worker's execution for
  // the active prompt finishes; stamp it as the current generation's
  // completion. The stamp is cleared on every new lease, so it always
  // belongs to the current turn — exactly like the v1 assistant-complete
  // branch in handleMessageActivity.
  async function handleExecutionSucceeded(goal: any): Promise<boolean> {
    let matched = false
    await mutateState(directory, `execution-succeeded:${goal.id}`, async (s) => {
      const g = s.goals.find((item) => item.id === goal.id)
      const rt = s.runtimes.find((r) => r.goalID === goal.id)
      if (!g || g.status !== "active" || g.workerSessionID !== goal.workerSessionID || !rt || rt.phase !== "running" || !rt.activePromptMessageID) return s
      Object.assign(rt, recordActivity(rt))
      rt.activeAssistantCompletedAt = new Date().toISOString()
      matched = true
      return s
    })
    return matched
  }

  // ─── Idle Handler ─────────────────────────────────────────────────────────

  async function handleSessionIdle(state: StoreState, goal: any): Promise<boolean> {
    const goalID = goal.id
    // Guard against concurrent continuations
    if (inflightContinuations.has(goalID)) return false

    // Stage an idle candidate under the current run generation. New prompts
    // clear the candidate, and a stale event can never release a newer lease.
    let completedRunID: string | undefined
    let confirmation: {
      generation: number
      promptMessageID: string
      candidateAt: string
      assistantCompleted: boolean
    } | undefined
    let afterIdle = await mutateState(directory, `idle:${goalID}`, async (s) => {
      const g = s.goals.find((item) => item.id === goalID)
      if (!g) return s
      if (g.status !== "active" || g.interactive || g.workerSessionID !== goal.workerSessionID) return s
      const rt = s.runtimes.find((r) => r.goalID === goalID)
      if (!rt) return s
      if (rt.phase !== "running") return s
      if ((rt.activeToolCallIDs?.length ?? 0) > 0) {
        rt.idleCandidateAt = undefined
        rt.idleCandidateGeneration = undefined
        return s
      }

      const now = Date.now()
      if (!rt.idleCandidateAt || rt.idleCandidateGeneration !== rt.runGeneration) {
        rt.idleCandidateAt = new Date(now).toISOString()
        rt.idleCandidateGeneration = rt.runGeneration
        return s
      }
      const elapsed = now - Date.parse(rt.idleCandidateAt)
      if (elapsed < confirmIdleMs) return s
      // Veto only on activity AFTER the last known completion: a completion
      // event arriving after the candidate staged is terminal, not work.
      // activeAssistantCompletedAt is cleared on every new lease, so when set
      // it always belongs to the current generation.
      const anchoredHere = Boolean(rt.activeAssistantCompletedAt)
      const quietSince = anchoredHere && rt.activeAssistantCompletedAt
        ? rt.activeAssistantCompletedAt
        : rt.idleCandidateAt
      if (rt.lastActivityAt && rt.lastActivityAt > rt.idleCandidateAt && rt.lastActivityAt > quietSince) {
        rt.idleCandidateAt = undefined
        rt.idleCandidateGeneration = undefined
        return s
      }

      if (rt.activePromptMessageID) {
        confirmation = {
          generation: rt.runGeneration,
          promptMessageID: rt.activePromptMessageID,
          candidateAt: rt.idleCandidateAt,
          assistantCompleted: Boolean(rt.activeAssistantCompletedAt),
        }
      } else {
        // Compatibility path for a run persisted by an older plugin version.
        completedRunID = rt.activeRunID
        Object.assign(rt, releaseLease(rt))
        rt.activeRunID = undefined
        rt.lastWorkerStatus = "idle"
      }
      return s
    })

    if (confirmation) {
      const candidate = confirmation
      // Event anchor: the live event stream already observed this turn's
      // completion (stamp is cleared on every new lease, so it is always
      // current-generation). The transcript scan below is a fallback for
      // completions whose events were missed — never the sole authority,
      // since a fixed tail window cannot see prompts of long turns.
      const stagedRt = afterIdle.runtimes.find((r) => r.goalID === goalID)
      const eventAnchored = stagedRt?.runGeneration === candidate.generation
        && Boolean(stagedRt?.activeAssistantCompletedAt)
      const transcript = await inspectPromptTurn(goal.workerSessionID, candidate.promptMessageID)
      // Missed the live event but the transcript proves the host closed the turn
      // without output. That is a failure, not a completion: record it here so a
      // lost event cannot wedge the goal in phase=running again.
      if (!eventAnchored && transcript.outputless &&
          stagedRt?.runGeneration === candidate.generation &&
          stagedRt.phase === "running" &&
          stagedRt.activePromptMessageID === candidate.promptMessageID &&
          stagedRt.activeRunID) {
        return await handleSessionError(afterIdle, goal, {
          type: "session.error",
          properties: {
            expectedRunID: stagedRt.activeRunID,
            runID: stagedRt.activeRunID,
            error: {
              message: `OpenCode closed this turn with no output (no finish reason, no parts, no error). The host accepted the prompt and produced nothing — commonly a quota-limited model. Recovered from the transcript because the live turn event was missed.`,
            },
          },
        })
      }
      const failureReason: "prompt-outside-window" | "assistant-incomplete" | undefined =
        transcript.assistantInProgress ? "assistant-incomplete"
        : !transcript.latestUserPrompt && !eventAnchored
          ? "prompt-outside-window"
          : (!eventAnchored && !candidate.assistantCompleted && !transcript.assistantCompleted)
            ? "assistant-incomplete"
            : undefined
      if (failureReason) {
        // Stamp the first failure per generation and emit once. Later polls for
        // the same generation stay silent here — the maintenance watchdog owns
        // escalation, and per-poll events would only spam the ledger.
        let newlyStamped = false
        await mutateState(directory, `idle.confirm-stamp:${goalID}`, async (s) => {
          const rt = s.runtimes.find((r) => r.goalID === goalID)
          if (!rt || rt.runGeneration !== candidate.generation) return s
          if (rt.idleConfirmFailedGeneration !== candidate.generation) {
            rt.idleConfirmFailedAt = new Date().toISOString()
            rt.idleConfirmFailedGeneration = candidate.generation
            newlyStamped = true
          }
          return s
        })
        if (newlyStamped) {
          await appendEvent(directory, {
            version: 1,
            eventID: randomUUID(),
            goalID,
            type: "idle.confirm-failed",
            reason: failureReason,
            runGeneration: candidate.generation,
            timestamp: new Date().toISOString(),
            revision: afterIdle.revision,
          } satisfies LoopEvent)
        }
        return true
      }

      afterIdle = await mutateState(directory, `idle.confirm:${goalID}`, async (s) => {
        const g = s.goals.find((item) => item.id === goalID)
        const rt = s.runtimes.find((r) => r.goalID === goalID)
        if (!g || !rt || g.status !== "active" || g.interactive || g.workerSessionID !== goal.workerSessionID) return s
        if (rt.phase !== "running") return s
        if (rt.runGeneration !== candidate.generation) return s
        if (rt.activePromptMessageID !== candidate.promptMessageID) return s
        if (rt.idleCandidateGeneration !== candidate.generation) return s
        if (rt.idleCandidateAt !== candidate.candidateAt) return s
        if (rt.lastActivityAt && rt.lastActivityAt > candidate.candidateAt) {
          const quiet = rt.runGeneration === candidate.generation && rt.activeAssistantCompletedAt
            ? rt.activeAssistantCompletedAt
            : candidate.candidateAt
          if (rt.lastActivityAt > quiet) return s
        }
        if ((rt.activeToolCallIDs?.length ?? 0) > 0) return s

        completedRunID = rt.activeRunID
        Object.assign(rt, releaseLease(rt))
        rt.activeRunID = undefined
        rt.lastWorkerStatus = "idle"
        rt.idleConfirmFailedAt = undefined
        rt.idleConfirmFailedGeneration = undefined
        return s
      })
    }

    if (completedRunID) {
      await appendEvent(directory, {
        version: 1,
        eventID: randomUUID(),
        goalID,
        type: "run.completed",
        runID: completedRunID,
        timestamp: new Date().toISOString(),
        revision: afterIdle.revision,
      } satisfies LoopEvent)
    } else {
      // Candidate not confirmed, transcript not anchored, or generation changed.
      return true
    }

    return await afterCompletedTurn(goalID, goal)
  }

  async function afterCompletedTurn(goalID: GoalID, goal: any): Promise<boolean> {
    // Goal policy is independent of the host's execution lifecycle.
    const freshState = await readState(directory)
    const freshGoal = freshState.goals.find((g) => g.id === goalID)
    if (!freshGoal || freshGoal.status !== "active") return false
    const freshRuntime = freshState.runtimes.find((r) => r.goalID === goalID)
    if (!freshRuntime) return false

    const limitResult = enforceLimits(freshGoal, freshRuntime)
    if (limitResult.stop === "force_finish") {
      if (!freshRuntime.forceFinishRequested) {
        await continueGoal(goalID, { forceFinish: true })
        return true
      }
      const blockedKey = goalID
      const nowBlocked = Date.now()
      const lastBlocked = recentForceFinishBlocked.get(blockedKey)
      if (lastBlocked !== undefined && nowBlocked - lastBlocked < 60_000) return true
      recentForceFinishBlocked.set(blockedKey, nowBlocked)
      let shouldNotifyBlocked = false
      // Fold final-turn usage: a blocked goal gets no later accounting turn.
      await goalService.accountUsage(directory, goalID).catch(() => ({
        tokenDelta: 0, costDelta: 0, timeDeltaSeconds: 0, counted: [] as string[],
      }))
      const blockedState = await mutateState(directory, `idle.blocked:${goalID}`, async (s) => {
        const g = s.goals.find((item) => item.id === goalID)
        if (!g) return s
        g.status = "blocked"
        g.updatedAt = new Date().toISOString()
        g.blocker = {
          reason: limitResult.reason + " (force-finish ignored)",
          needed: "User intervention required. Use retry to attempt again.",
          at: new Date().toISOString(),
        }
        const rt = s.runtimes.find((r) => r.goalID === goalID)
        if (rt) {
          rt.forceFinishRequested = undefined
          if (shouldNotifyParent(rt, "stopped")) {
            markParentNotified(rt, "stopped")
            shouldNotifyBlocked = true
          }
        }
        return s
      })
      await appendEvent(directory, {
        version: 1,
        eventID: randomUUID(),
        goalID,
        type: "goal.blocked",
        reason: limitResult.reason + " (force-finish ignored)",
        needed: "User intervention required. Use retry to attempt again.",
        timestamp: new Date().toISOString(),
        revision: blockedState.revision,
      } satisfies LoopEvent)
      if (shouldNotifyBlocked) {
        await host.notifyOwner(
          goal.ownerSessionID,
          `Loop goal "${goal.name}" stopped: ${limitResult.reason} (child did not wrap up). Status: blocked. Last progress: ${goal.lastProgress?.summary || "none"}.`,
          (goal as any).parentAgent,
        )
      }
      return true
    }
    if (limitResult.stop === "budget") {
      const budgetState = await mutateState(directory, `idle.budget:${goalID}`, async (s) => {
        const g = s.goals.find((item) => item.id === goalID)
        if (g) {
          g.status = "budget_limited"
          g.updatedAt = new Date().toISOString()
        }
        return s
      })
      await appendEvent(directory, {
        version: 1,
        eventID: randomUUID(),
        goalID,
        type: "goal.status_changed",
        from: "active",
        to: "budget_limited",
        timestamp: new Date().toISOString(),
        revision: budgetState.revision,
      } satisfies LoopEvent)
      return true
    }

    if (shouldCompact(freshGoal, freshRuntime)) {
      await doCompact(freshGoal, freshRuntime)
      return true
    }

    await continueGoal(goalID)
    return true
  }

  async function reconcileNativeExecution(goal: any, nativeError?: unknown, recoverOutputless = false): Promise<boolean> {
    const before = await readState(directory)
    const runtime = before.runtimes.find((rt) => rt.goalID === goal.id)
    if (!runtime || !goal.workerSessionID || !host.readExecution) return false
    const observed = await host.readExecution(goal.workerSessionID)
    let completedRunID: string | undefined
    let blocked: NativeReconcileBlockedEvent | undefined
    let outputlessRunID: string | undefined
    // A provider retry is not silence: the host is telling us the model call
    // keeps failing. readExecution only resolves on idle, so a retrying worker
    // reads as "unknown" and used to be parked in a no-op forever — the failure
    // threshold was never reached and the owner was never told.
    const providerRetry = observed?.status === "unknown" && host.sessionStatus
      ? (await host.sessionStatus(goal.workerSessionID)) === "retry"
      : false
    let retryWindow: { elapsedMs: number; consecutiveFailures: number; runGeneration: number } | undefined
    let retryBlocked: { failures: number; message: string; notify: boolean } | undefined
    const after = await mutateState(directory, `native.execution:${goal.id}`, async (s) => {
      const g = s.goals.find((item) => item.id === goal.id)
      const rt = s.runtimes.find((item) => item.goalID === goal.id)
      if (!g || g.status !== "active" || g.scopeClosing || g.workerSessionID !== goal.workerSessionID || !rt || rt.runGeneration !== runtime.runGeneration || rt.activePromptMessageID !== runtime.activePromptMessageID) return s
      rt.executionSource = "native"
      rt.nativeExecutionStatus = providerRetry ? "retry" : (observed?.status ?? "unknown")
      // Only a live retry may escalate. Any other projection proves the retry
      // window ended, so a stale timestamp can never charge a later run.
      if (!providerRetry) rt.providerRetrySince = undefined
      if (providerRetry) {
        const since = rt.providerRetrySince
        if (!since) {
          rt.providerRetrySince = new Date().toISOString()
        } else {
          const elapsedMs = Date.now() - Date.parse(since)
          if (Number.isFinite(elapsedMs) && elapsedMs >= providerRetryGraceMs) {
            // One failure per window: a two-second blip must not block a goal,
            // and a quota wall must not be invisible.
            rt.providerRetrySince = new Date().toISOString()
            rt.consecutiveFailures += 1
            rt.lastError = `OpenCode reports the worker session in provider retry for ${Math.floor(elapsedMs / 1000)}s; the model call keeps failing (commonly a quota-limited model). No turn is being produced.`
            rt.updatedAt = new Date().toISOString()
            retryWindow = { elapsedMs, consecutiveFailures: rt.consecutiveFailures, runGeneration: rt.runGeneration }
            if (rt.consecutiveFailures >= (g.config?.maxFailures || 5)) {
              g.status = "blocked"
              g.updatedAt = new Date().toISOString()
              g.blocker = {
                reason: `Failed ${rt.consecutiveFailures} times while the provider kept retrying: ${rt.lastError}`,
                needed: "User intervention required: check the model's quota, switch the goal's model with switch_goal_identity, then retry.",
                at: new Date().toISOString(),
                kind: "provider-limit",
              }
              const notify = shouldNotifyParent(rt, "failed")
              if (notify) markParentNotified(rt, "failed")
              retryBlocked = { failures: rt.consecutiveFailures, message: rt.lastError, notify }
            }
          }
        }
      }
      if (observed?.status === "busy" || observed?.status === "retry") {
        rt.lastWorkerStatus = observed.status
        return s
      }
      const started = Date.parse(rt.turnStartedAt ?? "")
      const ended = Date.parse(observed?.idleAt ?? "")
      const inboxIDs = rt.nativeInboxMessageIDs ?? []
      const ownsLatest = observed?.latestUserMessageID === rt.activePromptMessageID || inboxIDs.includes(observed?.latestUserMessageID ?? "")
      // Order matters. "missing-outcome" is the one gate the maintenance
      // no-output recovery may act on, so it must be reachable only after every
      // conservative gate has already passed: a proven idle read, a valid
      // terminal time, and our own latest prompt. A foreign prompt or an
      // unproven read can therefore never be mistaken for a closed turn.
      const reason = rt.phase !== "running" ? "phase-not-running"
        : !rt.activeRunID || !rt.activePromptMessageID ? "missing-run-anchor"
        : observed?.status !== "idle" ? "host-not-idle"
        : s.workspaceOperation ? "workspace-operation"
        : s.workspaceCalls?.some((call) => call.goalID === goal.id) ? "workspace-call"
        : inboxIDs.some((id) => !observed.deliveredMessageIDs?.includes(id)) && observed.outcome !== "interrupted" ? "undelivered-inbox"
        : !Number.isFinite(started) || !Number.isFinite(ended) || ended < started ? "invalid-terminal-time"
        : !ownsLatest ? "foreign-prompt"
        : !observed.outcome ? "missing-outcome" : undefined
      if (reason) {
        rt.nativeReconcileBlocked = { reason, runGeneration: rt.runGeneration }
        if (rt.nativeReconcileBlockedReasons?.runGeneration !== rt.runGeneration) rt.nativeReconcileBlockedReasons = { runGeneration: rt.runGeneration, reasons: [] }
        if (!rt.nativeReconcileBlockedReasons.reasons.includes(reason)) {
          rt.nativeReconcileBlockedReasons.reasons.push(reason)
          blocked = { version: 1, eventID: randomUUID(), goalID: goal.id, type: "native.reconcile-blocked", reason, runGeneration: rt.runGeneration, phase: rt.phase, observedStatus: observed?.status ?? "unknown", observedOutcome: observed?.outcome, idleAt: observed?.idleAt, turnStartedAt: rt.turnStartedAt, ownsLatest, timestamp: new Date().toISOString(), revision: s.revision }
        }
        if (recoverOutputless && reason === "missing-outcome" && !g.interactive) outputlessRunID = rt.activeRunID
        return s
      }
      rt.nativeReconcileBlocked = undefined
      completedRunID = rt.activeRunID
      if (observed?.outcome === "failed") return s
      Object.assign(rt, releaseLease(rt))
      rt.activeRunID = undefined
      rt.lastWorkerStatus = "idle"
      rt.nativeExecutionStatus = "idle"
      rt.nativeInboxMessageIDs = undefined
      if (observed?.outcome === "interrupted") {
        g.status = "paused"
        g.updatedAt = new Date().toISOString()
      }
      return s
    })
    if (blocked) await appendEvent(directory, { ...blocked, revision: after.revision })
    if (retryWindow) {
      await appendEvent(directory, {
        version: 1,
        eventID: randomUUID(),
        goalID: goal.id,
        type: "native.provider-retry",
        elapsedMs: retryWindow.elapsedMs,
        consecutiveFailures: retryWindow.consecutiveFailures,
        runGeneration: retryWindow.runGeneration,
        timestamp: new Date().toISOString(),
        revision: after.revision,
      } satisfies LoopEvent)
    }
    if (retryBlocked) {
      await appendEvent(directory, {
        version: 1,
        eventID: randomUUID(),
        goalID: goal.id,
        type: "goal.blocked",
        reason: `Provider retry persisted across ${retryBlocked.failures} failure windows`,
        needed: "User intervention required: check the model's quota or switch this goal's model.",
        timestamp: new Date().toISOString(),
        revision: after.revision,
      } satisfies LoopEvent)
      if (retryBlocked.notify) {
        await host.notifyOwner(
          goal.ownerSessionID,
          `Loop goal "${goal.name}" blocked after ${retryBlocked.failures} provider-retry windows. Last error: ${retryBlocked.message}`,
          (goal as any).parentAgent,
        )
      }
    }
    if (outputlessRunID) return await handleSessionError(after, goal, { properties: { expectedRunID: outputlessRunID, runID: outputlessRunID, error: { message: "OpenCode closed this turn with no output (no finish reason, no parts, no error). The host accepted the prompt and produced nothing — commonly a quota-limited model." } } })
    if (!completedRunID) return false
    // An interrupted/failed execution is not successful work. Reuse the
    // existing error policy, but only after the host proves the terminal turn.
    if (observed?.outcome === "interrupted") {
      // Native interruption is an explicit stop, not a failed attempt to
      // immediately restart. Shutdown outcomes also wait for owner resume.
      await appendEvent(directory, { version: 1, eventID: randomUUID(), goalID: goal.id, type: "goal.status_changed", from: "active", to: "paused", timestamp: new Date().toISOString(), revision: after.revision } satisfies LoopEvent)
      return true
    }
    if (observed?.outcome === "failed") {
      return await handleSessionError(after, goal, { properties: { expectedRunID: completedRunID, runID: completedRunID, error: nativeError ?? { message: "OpenCode execution failed (reconciled native outcome)" } } })
    }
    await appendEvent(directory, { version: 1, eventID: randomUUID(), goalID: goal.id, type: "run.completed", runID: completedRunID, timestamp: new Date().toISOString(), revision: after.revision } satisfies LoopEvent)
    if (goal.interactive) return true
    return await afterCompletedTurn(goal.id, goal)
  }

  async function inspectPromptTurn(
    workerSessionID: string | undefined,
    promptMessageID: string,
  ): Promise<{ latestUserPrompt: boolean; assistantCompleted: boolean; assistantInProgress: boolean; outputless: boolean }> {
    const noMatch = { latestUserPrompt: false, assistantCompleted: false, assistantInProgress: false, outputless: false }
    if (!workerSessionID) return noMatch
    let messages
    try {
      // Window must cover long productive turns: a turn emitting more messages
      // than this window pushes its prompt out of view, which used to wedge
      // the goal in phase=running with zero diagnostics. The event-anchored
      // completion path means this scan is a fallback, not the authority.
      messages = await host.readMessages(workerSessionID, 200)
    } catch {
      return noMatch
    }
    const users = messages.filter((message) => message.role === "user")
    if (users.length === 0) return noMatch

    const allTimestamped = users.every((message) => message.timestamp && Number.isFinite(Date.parse(message.timestamp)))
    const ordered = allTimestamped
      ? [...users].sort((a, b) => Date.parse(a.timestamp!) - Date.parse(b.timestamp!))
      : users
    const assistants = messages.filter((message) => message.role === "assistant" && message.parentMessageID === promptMessageID)
    const orderedAssistants = assistants.every((message) => Number.isFinite(Date.parse(message.createdAt ?? message.timestamp ?? "")))
      ? [...assistants].sort((a, b) => Date.parse(a.createdAt ?? a.timestamp!) - Date.parse(b.createdAt ?? b.timestamp!))
      : assistants
    const latestAssistant = orderedAssistants.at(-1)
    const outputless = isOutputlessTurn(latestAssistant)
    // An outputless close is neither a completion nor work in progress. Reporting
    // it as completed would confirm a turn that produced nothing; reporting it as
    // in-progress would defer forever.
    const assistantCompleted = Boolean(latestAssistant?.completedAt) && latestAssistant?.finish !== "tool-calls" && !outputless
    return {
      latestUserPrompt: ordered.at(-1)?.messageID === promptMessageID,
      assistantCompleted,
      assistantInProgress: Boolean(latestAssistant) && !assistantCompleted && !outputless,
      outputless,
    }
  }

  // ─── Status Handler ───────────────────────────────────────────────────────

  async function handleSessionStatus(state: StoreState, goal: any, event: any): Promise<boolean> {
    const runtime = state.runtimes.find((r) => r.goalID === goal.id)
    if (!runtime) return false

    const status = event.properties?.status
    const statusType = status?.type as string | undefined
    if (!statusType) return false

    if (statusType === "idle") return handleSessionIdle(state, goal)

    await mutateState(directory, `status:${goal.id}`, async (s) => {
      const g = s.goals.find((item) => item.id === goal.id)
      const rt = s.runtimes.find((r) => r.goalID === goal.id)
      if (!g || g.status !== "active" || g.workerSessionID !== goal.workerSessionID || !rt || rt.runGeneration !== runtime.runGeneration) return s
      if (statusType === "busy" || statusType === "retry") {
        Object.assign(rt, recordActivity(rt))
      }
      rt.lastWorkerStatus = statusType as any
      rt.updatedAt = new Date().toISOString()
      return s
    })
    return true
  }

  // ─── Error Handler ────────────────────────────────────────────────────────

  async function handleSessionError(state: StoreState, goal: any, event: any): Promise<boolean> {
    const runtime = state.runtimes.find((r) => r.goalID === goal.id)
    if (!runtime) return false

    const error = event.properties?.error
    const message = describeError(error) || "unknown error"

    let shouldNotify = false
    let errorRecorded = false
    const newState = await mutateState(directory, `error:${goal.id}`, async (s) => {
      const g = s.goals.find((item) => item.id === goal.id)
      const rt = s.runtimes.find((r) => r.goalID === goal.id)
      if (!g || g.status !== "active" || g.workerSessionID !== goal.workerSessionID || !rt || rt.runGeneration !== runtime.runGeneration) return s
      if (event.properties?.expectedRunID && (rt.activeRunID !== event.properties.expectedRunID || rt.phase !== "running")) return s
      errorRecorded = true

      rt.consecutiveFailures += 1
      rt.lastError = message
      rt.updatedAt = new Date().toISOString()
      rt.idleCandidateAt = undefined

      // Release lease
      if (rt.phase === "running") {
        Object.assign(rt, releaseLease(rt))
      }
      if (event.properties?.expectedRunID) { rt.activeRunID = undefined; rt.nativeInboxMessageIDs = undefined }

      if (rt.consecutiveFailures >= (goal.config?.maxFailures || 5)) {
        if (g) {
          g.status = "blocked"
          g.updatedAt = new Date().toISOString()
          g.blocker = {
            reason: `Failed ${rt.consecutiveFailures} times. Last error: ${message}`,
            needed: "User intervention required. Use retry to attempt again.",
            at: new Date().toISOString(),
          }
        }
        if (shouldNotifyParent(rt, "failed")) {
          markParentNotified(rt, "failed")
          shouldNotify = true
        }
      } else {
        const backoffMs = Math.min(30_000, 1_000 * Math.pow(2, rt.consecutiveFailures))
        rt.retryAfter = new Date(Date.now() + backoffMs).toISOString()
        rt.phase = "waiting_retry"
      }

      return s
    })

    if (!errorRecorded) return false
    await appendEvent(directory, {
      version: 1,
      eventID: randomUUID(),
      goalID: goal.id,
      type: "run.failed",
      runID: event.properties?.runID || runtime.activeRunID || "unknown",
      error: message,
      consecutiveFailures: runtime.consecutiveFailures + 1,
      timestamp: new Date().toISOString(),
      revision: newState.revision,
    } satisfies LoopEvent)

    const updatedGoal = newState.goals.find((g) => g.id === goal.id)
    await goalService.observeProviderError(directory, goal.id, error, "session-error", goal.config.model)
    if (updatedGoal?.status === "blocked") {
      await appendEvent(directory, {
        version: 1,
        eventID: randomUUID(),
        goalID: goal.id,
        type: "goal.blocked",
        reason: `Failed ${runtime.consecutiveFailures + 1} times`,
        needed: "User intervention required",
        timestamp: new Date().toISOString(),
        revision: newState.revision,
      } satisfies LoopEvent)
      if (shouldNotify) {
        await host.notifyOwner(
          goal.ownerSessionID,
          `Loop goal "${goal.name}" blocked after ${runtime.consecutiveFailures + 1} failures. Last error: ${message}.`,
          (goal as any).parentAgent,
        )
      }
    }

    return true
  }

  // ─── Compacted Handler ────────────────────────────────────────────────────

  async function handleSessionCompacted(state: StoreState, goal: any): Promise<boolean> {
    const runtime = state.runtimes.find((r) => r.goalID === goal.id)
    if (!runtime) return false

    const newState = await mutateState(directory, `compacted:${goal.id}`, async (s) => {
      const rt = s.runtimes.find((r) => r.goalID === goal.id)
      if (!rt) return s
      rt.lastCompactAt = new Date().toISOString()
      rt.updatedAt = new Date().toISOString()
      return s
    })

    await appendEvent(directory, {
      version: 1,
      eventID: randomUUID(),
      goalID: goal.id,
      type: "compaction.completed",
      timestamp: new Date().toISOString(),
      revision: newState.revision,
    } satisfies LoopEvent)

    return true
  }

  // ─── Limit Enforcement ────────────────────────────────────────────────────

  type LimitStop = "none" | "force_finish" | "budget"
  interface LimitResult {
    stop: LimitStop
    blocked: boolean
    event: "goal.blocked" | "goal.status_changed"
    reason: string
  }

  function enforceLimits(goal: any, runtime: GoalRuntimeState): LimitResult {
    const noResult: LimitResult = { stop: "none", blocked: false, event: "goal.status_changed", reason: "" }

    // Max turns — force child to wrap up with a semantic summary
    const maxTurns = goal.config?.maxTurns
    if (maxTurns && runtime.budgetTurnCount >= maxTurns) {
      return {
        stop: "force_finish",
        blocked: true,
        event: "goal.blocked",
        reason: `Reached max turns (${maxTurns})`,
      }
    }

    // Max no-progress — force child to wrap up
    const maxNoProgress = goal.config?.maxNoProgress
    if (maxNoProgress && runtime.noProgressCount >= maxNoProgress) {
      return {
        stop: "force_finish",
        blocked: true,
        event: "goal.blocked",
        reason: `No progress for ${runtime.noProgressCount} consecutive turns`,
      }
    }

    // Token budget — direct status change (no semantic summary needed)
    if (goal.tokenBudget && goal.tokensUsed >= goal.tokenBudget) {
      goal.status = "budget_limited"
      goal.updatedAt = new Date().toISOString()
      return {
        stop: "budget",
        blocked: true,
        event: "goal.status_changed",
        reason: `Token budget exhausted (${goal.tokensUsed}/${goal.tokenBudget})`,
      }
    }

    // Cost budget — direct status change (no semantic summary needed)
    if (typeof goal.costBudget === "number" && (goal.costUsed ?? 0) >= goal.costBudget) {
      goal.status = "budget_limited"
      goal.updatedAt = new Date().toISOString()
      return {
        stop: "budget",
        blocked: true,
        event: "goal.status_changed",
        reason: `Cost budget exhausted ($${(goal.costUsed ?? 0).toFixed(4)}/$${goal.costBudget})`,
      }
    }

    return noResult
  }

  // ─── Compaction ───────────────────────────────────────────────────────────

  function shouldCompact(goal: any, runtime: GoalRuntimeState): boolean {
    const compactEvery = goal.config?.compactEvery
    if (!compactEvery) return false
    return runtime.runCount > 0 && runtime.runCount % compactEvery === 0
  }

  async function doCompact(goal: any, runtime: GoalRuntimeState) {
    if (!goal.workerSessionID) return

    const prevPhase = runtime.phase

    const state = await mutateState(directory, `compact.start:${goal.id}`, async (s) => {
      const rt = s.runtimes.find((r) => r.goalID === goal.id)
      if (!rt) return s
      rt.phase = "compacting"
      rt.lastCompactAt = new Date().toISOString()
      return s
    })

    await appendEvent(directory, {
      version: 1,
      eventID: randomUUID(),
      goalID: goal.id,
      type: "compaction.started",
      timestamp: new Date().toISOString(),
      revision: state.revision,
    } satisfies LoopEvent)

    try {
      await goalService.compact(directory, goal.id)
    } catch {
      // Best-effort compaction
    }

    await mutateState(directory, `compact.end:${goal.id}`, async (s) => {
      const rt = s.runtimes.find((r) => r.goalID === goal.id)
      if (rt) rt.phase = prevPhase
      return s
    })
  }

  // ─── Maintenance ──────────────────────────────────────────────────────────

  /**
   * Fold live worker usage into goal totals, then stop the goal if a budget is
   * exhausted — including mid-turn. Returns true when the goal was stopped.
   *
   * Aborting the worker session is the only way to halt spend inside a running
   * turn; without it the guard can only ever react after the money is gone.
   */
  async function accountAndEnforceBudget(goal: any): Promise<boolean> {
    try {
      await goalService.accountUsage(directory, goal.id)
    } catch {
      // Accounting is best-effort; never let it break the maintenance sweep.
    }

    const fresh = await readState(directory)
    const g = fresh.goals.find((item) => item.id === goal.id)
    if (!g || g.status !== "active") return false

    const overTokens = typeof g.tokenBudget === "number" && g.tokensUsed >= g.tokenBudget
    const overCost = typeof g.costBudget === "number" && (g.costUsed ?? 0) >= g.costBudget
    if (!overTokens && !overCost) return false

    const reason = overCost
      ? `Cost budget exhausted ($${(g.costUsed ?? 0).toFixed(4)}/$${g.costBudget})`
      : `Token budget exhausted (${g.tokensUsed}/${g.tokenBudget})`

    // Stop the burn first, then record the stop.
    if (g.workerSessionID) {
      try {
        await host.abortSession(g.workerSessionID)
      } catch {
        // Best-effort abort — status change below still stops continuations.
      }
    }

    let shouldNotify = false
    const stoppedState = await mutateState(directory, `maintenance.budget:${goal.id}`, async (s) => {
      const target = s.goals.find((item) => item.id === goal.id)
      if (!target || target.status !== "active") return s
      target.status = "budget_limited"
      target.updatedAt = new Date().toISOString()
      const rt = s.runtimes.find((r) => r.goalID === goal.id)
      if (rt) {
        Object.assign(rt, releaseLease(rt))
        rt.activeRunID = undefined
        rt.updatedAt = new Date().toISOString()
        if (shouldNotifyParent(rt, "stopped")) {
          markParentNotified(rt, "stopped")
          shouldNotify = true
        }
      }
      return s
    })
    const stoppedGoal = stoppedState.goals.find((item) => item.id === goal.id)
    if (stoppedGoal?.status !== "budget_limited") return false

    await appendEvent(directory, {
      version: 1,
      eventID: randomUUID(),
      goalID: goal.id,
      type: "goal.status_changed",
      from: "active",
      to: "budget_limited",
      timestamp: new Date().toISOString(),
      revision: stoppedState.revision,
    } satisfies LoopEvent)
    await logServerEvent(directory, "maintenance.budget-exhausted", {
      goalID: goal.id,
      reason,
      tokensUsed: stoppedGoal.tokensUsed,
      costUsed: stoppedGoal.costUsed,
    })
    if (shouldNotify) {
      await host.notifyOwner(
        goal.ownerSessionID,
        `Loop goal "${goal.name}" stopped: ${reason}. Worker aborted, status: budget_limited. Resume with resume_goal to continue spending.`,
        (goal as any).parentAgent,
      )
    }
    return true
  }

  function hasExecutionLeak(runtime: GoalRuntimeState): boolean {
    return runtime.phase !== "idle"
      || Boolean(runtime.activeRunID)
      || Boolean(runtime.leaseExpiresAt)
      || Boolean(runtime.turnStartedAt)
      || Boolean(runtime.activePromptMessageID)
      || Boolean(runtime.activePromptObservedAt)
      || Boolean(runtime.activeAssistantMessageID)
      || Boolean(runtime.activeAssistantCompletedAt)
      || Boolean(runtime.idleCandidateAt)
      || (runtime.activeToolCallIDs?.length ?? 0) > 0
  }

  /** Recover missed after-hooks from exact terminal transcript evidence,
   * then heal old goal flags even with zero active workers. No age, status,
   * absent-goal or generation inference releases an execution reservation. */
  async function sweepStaleWorkspaceOwnership() {
    try {
      await reconcileTerminalWorkspaceCalls(directory, host)
      const snapshot = await readState(directory)
      // Cheap pre-check: no reservations/closing flags anywhere means the
      // sweep could change nothing — skip the state rewrite (mutateState
      // bumps revision even with no changes).
      if (
        !(snapshot.workspaceCalls?.length) &&
        !(snapshot.writeTickets?.holders.length) &&
        !(snapshot.writeTickets?.queue.length) &&
        !snapshot.goals.some((g) => g.scopeClosing || g.scopeClearPending)
      ) {
        return
      }
      // Status probes cannot establish tool completion; keep closing flags
      // conservative until exact reservations drain.
      const { sweepStaleWorkspaceState } = await import("./workspace-execution")
      let summary: WorkspaceSweepSummary = { reapedCalls: [], resetClosing: [], finalizedClears: [], forceCleared: [], reapedTickets: [] }
      await mutateState(directory, "maintenance.sweep-stale-workspace", async (s) => {
        summary = sweepStaleWorkspaceState(s, {
          isWorkerLive: () => true,
          now: Date.now(),
        })
        return s
      })
      if (summary.reapedCalls.length || summary.resetClosing.length || summary.finalizedClears.length || summary.forceCleared.length || summary.reapedTickets.length) {
        await logServerEvent(directory, "maintenance.sweep-stale-workspace", {
          reapedCalls: summary.reapedCalls,
          resetClosing: summary.resetClosing,
          finalizedClears: summary.finalizedClears,
          forceCleared: summary.forceCleared,
          reapedTickets: summary.reapedTickets,
        })
      }
    } catch {}
  }

  async function maintenance() {
    // Ownership sweep FIRST — before the fast paths below, so limbo heals
    // even when there are no known worker sessions or no active goals.
    await sweepStaleWorkspaceOwnership()
    syncWorkerSessionsFromService()
    // FAST PATH: skip entirely if no known worker sessions
    if (knownWorkerSessions.size === 0) return

    const state = await readState(directory)

    // Repair leaks for terminal/paused goals that still carry activeRunID/lease (P2)
    for (const goal of state.goals) {
      if (goal.status === "active") continue
      const rt = state.runtimes.find((r) => r.goalID === goal.id)
      if (!rt) continue
      if (hasExecutionLeak(rt)) {
        await mutateState(directory, `maintenance.clear-terminal-leak:${goal.id}`, async (s) => {
          const r = s.runtimes.find((x) => x.goalID === goal.id)
          const g = s.goals.find((item) => item.id === goal.id)
          if (g?.status !== "active" && r && hasExecutionLeak(r)) {
            Object.assign(r, releaseLease(r))
            r.activeRunID = undefined
            r.unknownStatusCount = 0
            r.lastUnknownStatusAt = undefined
            r.workerUnreachableNotifiedAt = undefined
            r.updatedAt = new Date().toISOString()
          }
          return s
        })
        await logServerEvent(directory, "maintenance.terminal-leak-cleared", { goalID: goal.id, status: goal.status })
      }
    }

    // FAST PATH: skip if no active goals
    const hasActiveGoals = state.goals.some((g) => g.status === "active")
    if (!hasActiveGoals) return

    for (const goal of state.goals) {
      if (goal.status !== "active") continue

      const runtime = state.runtimes.find((r) => r.goalID === goal.id)
      if (!runtime) continue

      // Continuous usage accounting + budget enforcement. Turn boundaries are
      // not enough: a worker that burns everything inside ONE long turn was
      // never measured (usage read 0) and never stopped (limits only ran after
      // a run completed). Poll on the maintenance cadence instead, and abort
      // mid-turn when a budget is exhausted.
      if (goal.workerSessionID) {
        const stopped = await accountAndEnforceBudget(goal)
        if (stopped) continue
      }

      // Manual goals never get engine-started turns — retry-due included.
      // The owner retries explicitly when ready.
      const manual = goal.interactive === true

      // Handle waiting_retry: check if retry time has passed
      if (!manual && runtime.phase === "waiting_retry" && runtime.retryAfter) {
        if (Date.now() >= Date.parse(runtime.retryAfter)) {
          await mutateState(directory, `retry-ready:${goal.id}`, async (s) => {
            const rt = s.runtimes.find((r) => r.goalID === goal.id)
            if (rt) {
              rt.retryAfter = undefined
              rt.phase = "idle"
            }
            return s
          })
          await continueGoal(goal.id)
        }
      }

      // Native maintenance reconciles missed durable events, not idle guesses.
      if (host.readExecution) {
        if (runtime.phase === "running") await reconcileNativeExecution(goal, undefined, true)
        else if (!manual && runtime.phase === "idle" && goal.workerSessionID && (await host.readExecution(goal.workerSessionID))?.status === "idle") await continueGoal(goal.id)
        // Foreign-prompt watchdog: the native reconcile's verdict can be terminal
        // for this turn (the worker session's latest message is not our prompt —
        // e.g. a mid-turn model switch) while every legacy watchdog below is
        // bypassed by the `continue`. Without this, the goal stalls silently
        // forever: the lease expires, nobody re-prompts, nobody is told.
        // Notify-only, mirroring run.stuck: a nudge re-prompts with a fresh ID.
        if (runtime.phase === "running" && runtime.activeRunID) {
          const fresh = await readState(directory)
          const rt = fresh.runtimes.find((r) => r.goalID === goal.id)
          if (rt && rt.phase === "running" && rt.activeRunID === runtime.activeRunID
            && rt.nativeReconcileBlocked?.reason === "foreign-prompt"
            && rt.foreignPromptNotifiedRunID !== rt.activeRunID) {
            const leaseExpired = !rt.leaseExpiresAt || Date.now() >= Date.parse(rt.leaseExpiresAt)
            const lastActive = rt.lastActivityAt ? Date.parse(rt.lastActivityAt) : 0
            if (leaseExpired && Date.now() - lastActive > stuckRunningMs) {
              const stuckSeconds = Math.floor((Date.now() - lastActive) / 1000)
              const marked = await mutateState(directory, `maintenance.foreign-prompt:${goal.id}`, async (s) => {
                const r = s.runtimes.find((x) => x.goalID === goal.id)
                if (!r || r.activeRunID !== runtime.activeRunID) return s
                r.foreignPromptNotifiedRunID = r.activeRunID
                r.updatedAt = new Date().toISOString()
                return s
              })
              await appendEvent(directory, {
                version: 1,
                eventID: randomUUID(),
                goalID: goal.id,
                type: "run.stuck",
                runID: runtime.activeRunID,
                stuckSeconds,
                timestamp: new Date().toISOString(),
                revision: marked.revision,
              } satisfies LoopEvent)
              await logServerEvent(directory, "maintenance.foreign-prompt-stuck", {
                goalID: goal.id,
                runID: runtime.activeRunID,
                stuckSeconds,
              })
              await host.notifyOwner(
                goal.ownerSessionID,
                `Loop goal "${goal.name}" is stalled: its worker session's latest message is not this turn's prompt (e.g. a mid-turn model switch superseded it), so the engine will not re-prompt on its own. Use inspect_background_goal to look, nudge_goal to re-prompt with a fresh turn, or pause_goal to stop it.`,
                (goal as any).parentAgent,
              )
            }
          }
        }
        continue
      }

      // Legacy transports reconstruct turn completion from transcript evidence
      // on the maintenance cadence, not lease expiry.
      // Also poll idle-phase goals that missed the idle event entirely.
      // Manual goals skip the lease/state churn below (unknown-status and
      // stuck notifications further down still run — they notify, never turn).
      if (!manual && (runtime.phase === "running" || runtime.phase === "idle") && goal.workerSessionID) {
        if (runtime.phase === "idle" && runtime.activeRunID) {
          await mutateState(directory, `maintenance.clear-stale-run:${goal.id}`, async (s) => {
            const rt = s.runtimes.find((r) => r.goalID === goal.id)
            if (rt?.phase === "idle" && rt.activeRunID) {
              Object.assign(rt, releaseLease(rt))
              rt.activeRunID = undefined
              rt.lastWorkerStatus = "idle"
            }
            return s
          })
          await logServerEvent(directory, "maintenance.stale-run-cleared", { goalID: goal.id })
        }

        const status = await host.sessionStatus(goal.workerSessionID)
        if (status === "unknown") {
          let shouldNotify = false
          const unknownState = await mutateState(directory, `maintenance.unknown-status:${goal.id}`, async (s) => {
            const rt = s.runtimes.find((r) => r.goalID === goal.id)
            if (!rt) return s
            rt.unknownStatusCount = Math.min(
              unknownStatusThreshold,
              (rt.unknownStatusCount ?? 0) + 1,
            )
            rt.lastUnknownStatusAt = new Date().toISOString()
            if (rt.unknownStatusCount >= unknownStatusThreshold && !rt.workerUnreachableNotifiedAt) {
              rt.workerUnreachableNotifiedAt = new Date().toISOString()
              shouldNotify = true
            }
            rt.updatedAt = new Date().toISOString()
            return s
          })
          const unknownRuntime = unknownState.runtimes.find((r) => r.goalID === goal.id)
          if (shouldNotify) {
            await logServerEvent(directory, "maintenance.worker-unreachable", {
              goalID: goal.id,
              workerSessionID: goal.workerSessionID,
              count: unknownRuntime?.unknownStatusCount,
            })
            await host.notifyOwner(
              goal.ownerSessionID,
              `Loop goal "${goal.name}" worker is unreachable after ${unknownRuntime?.unknownStatusCount ?? unknownStatusThreshold} status checks. The goal remains active; use inspect_background_goal, nudge_goal, pause_goal, or resume_goal to recover it.`,
          (goal as any).parentAgent
        )
          }
          continue
        }

        if ((runtime.unknownStatusCount ?? 0) > 0 || runtime.workerUnreachableNotifiedAt) {
          await mutateState(directory, `maintenance.status-recovered:${goal.id}`, async (s) => {
            const rt = s.runtimes.find((r) => r.goalID === goal.id)
            if (rt) {
              rt.unknownStatusCount = 0
              rt.lastUnknownStatusAt = undefined
              rt.workerUnreachableNotifiedAt = undefined
              rt.updatedAt = new Date().toISOString()
            }
            return s
          })
          await logServerEvent(directory, "maintenance.worker-recovered", { goalID: goal.id })
        }

        // Recover a quiet idle session only after actual tool/operation fences
        // have drained. Idle status and elapsed time never prove tool exit.
        if (status === "idle" && runtime.phase === "running") {
          const lastSignal = Math.max(
            runtime.lastActivityAt ? Date.parse(runtime.lastActivityAt) : 0,
            runtime.lastRunAt ? Date.parse(runtime.lastRunAt) : 0,
            runtime.turnStartedAt ? Date.parse(runtime.turnStartedAt) : 0,
          )
          const quietMs = Date.now() - lastSignal
          if (lastSignal > 0 && quietMs > idleRecoverMs) {
            const generation = runtime.runGeneration
            const stalledRunID = runtime.activeRunID
            let clearedToolCalls = 0
            let recovered = false
            const recoveredState = await mutateState(directory, `maintenance.idle-recover:${goal.id}`, async (s) => {
              const g = s.goals.find((item) => item.id === goal.id)
              const rt = s.runtimes.find((r) => r.goalID === goal.id)
              if (!g || !rt || g.status !== "active") return s
              if (g.interactive || g.scopeClosing || g.workerSessionID !== goal.workerSessionID) return s
              if (rt.phase !== "running") return s
              if (rt.runGeneration !== generation) return s
              if (s.workspaceOperation || (s.workspaceCalls ?? []).some((call) => call.goalID === goal.id) || rt.activeToolCallIDs?.length) return s
              clearedToolCalls = rt.activeToolCallIDs?.length ?? 0
              Object.assign(rt, releaseLease(rt))
              rt.activeRunID = undefined
              rt.lastWorkerStatus = "idle"
              rt.idleConfirmFailedAt = undefined
              rt.idleConfirmFailedGeneration = undefined
              rt.idleStuckNotifiedGeneration = undefined
              recovered = true
              return s
            })
            if (recovered) {
              await appendEvent(directory, {
                version: 1,
                eventID: randomUUID(),
                goalID: goal.id,
                type: "run.recovered",
                runID: stalledRunID ?? "unknown",
                quietSeconds: Math.floor(quietMs / 1000),
                clearedToolCalls,
                timestamp: new Date().toISOString(),
                revision: recoveredState.revision,
              } satisfies LoopEvent)
              await logServerEvent(directory, "maintenance.idle-recovered", {
                goalID: goal.id,
                generation,
                quietSeconds: Math.floor(quietMs / 1000),
                clearedToolCalls,
              })
              await continueGoal(goal.id)
              continue
            }
          }
        }

        // Unconfirmable-idle watchdog: status reads idle but the turn cannot
        // confirm (see idle.confirm-failed) and nothing stirs. Time is the only
        // distinguisher between slow and dead — escalate once per generation,
        // never auto re-prompt (an extra prompt on a live worker corrupts).
        // (Before the idle branch below: that branch always continues.)
        if (status === "idle" && runtime.phase === "running"
          && runtime.idleConfirmFailedGeneration === runtime.runGeneration
          && runtime.idleConfirmFailedAt
          && runtime.idleStuckNotifiedGeneration !== runtime.runGeneration
          && Date.now() - Date.parse(runtime.idleConfirmFailedAt) > idleUnconfirmedMs) {
          const failedAt = runtime.idleConfirmFailedAt
          const generation = runtime.runGeneration
          const stuckState = await mutateState(directory, `maintenance.idle-stuck:${goal.id}`, async (s) => {
            const rt = s.runtimes.find((r) => r.goalID === goal.id)
            if (!rt || rt.runGeneration !== generation || rt.phase !== "running") return s
            rt.idleStuckNotifiedGeneration = generation
            rt.updatedAt = new Date().toISOString()
            return s
          })
          const stuckSeconds = Math.floor((Date.now() - Date.parse(failedAt)) / 1000)
          await appendEvent(directory, {
            version: 1,
            eventID: randomUUID(),
            goalID: goal.id,
            type: "run.stuck",
            runID: runtime.activeRunID ?? "unknown",
            stuckSeconds,
            timestamp: new Date().toISOString(),
            revision: stuckState.revision,
          } satisfies LoopEvent)
          await logServerEvent(directory, "maintenance.idle-stuck", {
            goalID: goal.id,
            generation,
            stuckSeconds,
          })
          const quietMinutes = Math.max(1, Math.floor(stuckSeconds / 60))
          await host.notifyOwner(
            goal.ownerSessionID,
            `Loop goal "${goal.name}" worker is idle but its turn will not confirm (unconfirmed for ${quietMinutes}m, no activity). The goal remains active; use inspect_background_goal to look, nudge_goal to re-prompt, or pause_goal to stop it.`,
          (goal as any).parentAgent
        )
          continue
        }

        if (status === "idle") {
          if (runtime.phase === "idle") {
            await continueGoal(goal.id)
          } else {
            await handleSessionIdle(state, goal)
          }
          continue
        }

        // Stuck-running watchdog: a busy/retry worker with an expired lease and
        // no activity for a long time is wedged (or hung) — the idle path will
        // never fire for it. Notify once per run; never force re-prompt, which
        // would overlap prompts on a worker that might still be alive.
        if ((status === "busy" || status === "retry")
          && runtime.phase === "running" && runtime.activeRunID
          && runtime.stuckNotifiedRunID !== runtime.activeRunID) {
          const leaseExpired = !runtime.leaseExpiresAt || Date.now() >= Date.parse(runtime.leaseExpiresAt)
          const lastActive = runtime.lastActivityAt ? Date.parse(runtime.lastActivityAt) : 0
          if (leaseExpired && Date.now() - lastActive > stuckRunningMs) {
            const stuckSeconds = Math.floor((Date.now() - lastActive) / 1000)
            const stuckState = await mutateState(directory, `maintenance.run-stuck:${goal.id}`, async (s) => {
              const rt = s.runtimes.find((r) => r.goalID === goal.id)
              if (!rt || rt.activeRunID !== runtime.activeRunID) return s
              rt.stuckNotifiedRunID = rt.activeRunID
              rt.updatedAt = new Date().toISOString()
              return s
            })
            await appendEvent(directory, {
              version: 1,
              eventID: randomUUID(),
              goalID: goal.id,
              type: "run.stuck",
              runID: runtime.activeRunID,
              stuckSeconds,
              timestamp: new Date().toISOString(),
              revision: stuckState.revision,
            } satisfies LoopEvent)
            await logServerEvent(directory, "maintenance.run-stuck", {
              goalID: goal.id,
              runID: runtime.activeRunID,
              stuckSeconds,
            })
            await host.notifyOwner(
              goal.ownerSessionID,
              `Loop goal "${goal.name}" worker may be stuck: no activity for ${Math.floor(stuckSeconds / 60)}m while reporting ${status}, lease expired. The goal remains active; use inspect_background_goal to look, nudge_goal to re-prompt, or pause_goal to stop it.`,
          (goal as any).parentAgent
        )
          }
        }
      }
    }
  }

  return { start, stop, isRunning, handleEvent, preloadWorkerSessions }
}
