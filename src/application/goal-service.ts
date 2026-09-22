// ─── Server: Goal Service ────────────────────────────────────────────────────
// Manages goal lifecycle: start, pause, resume, retry, clear.
// Creates worker sessions, drives continuation, handles completion.
// Worker registry is persisted; in-memory map is a cache only.

import { randomUUID } from "crypto"
import type { Goal, GoalID } from "../domain/goal"
import { createGoal, canTransition, isTerminal } from "../domain/goal"
import type { GoalRuntimeState, RunID } from "../domain/runtime"
import { createRuntimeState, acquireLease, releaseLease, leaseIsValid, markProgress } from "../domain/runtime"
import { readState, mutateState, appendEvent, appendGoalInbox, drainGoalInbox, readEvents, goalArtifactDir, ensureGoalArtifactDir } from "../infrastructure/state-repository"
import * as path from "path"
import { promises as fs } from "fs"
import type { StoreState } from "../infrastructure/state-repository"
import { cancelAwaitsForGoal } from "./command-await"
import type { LoopHost, SessionMessage } from "../server/host-adapter"
import { newPromptMessageID } from "../server/host-adapter"
import { createWorkerManager, type WorkerManager, type WorkerSession, type ContinuationContext } from "../server/worker-session"
import type { LoopEvent } from "../domain/events"
import { describeError, logServerEvent } from "../infrastructure/server-log"

/**
 * Structured startup failure. start() persists the goal (and worker, when
 * created) as blocked BEFORE throwing, so a failed creation is recoverable
 * state — not "nothing happened". Carrying the IDs lets the tool response
 * point at the persisted goal instead of inviting a duplicate creation.
 */
export type GoalStartStage = "worker_create" | "prompt_delivery"
export class GoalStartError extends Error {
  readonly goalID: GoalID
  readonly workerSessionID?: string
  readonly failedStage: GoalStartStage
  constructor(message: string, info: { goalID: GoalID; workerSessionID?: string; failedStage: GoalStartStage }) {
    super(message)
    this.name = "GoalStartError"
    this.goalID = info.goalID
    this.workerSessionID = info.workerSessionID
    this.failedStage = info.failedStage
  }
}

export interface GoalService {
  /** Start a goal: create goal + worker session + first continuation. */
  start(directory: string, input: {
    name: string
    objective: string
    ownerSessionID: string
    config?: Goal["config"]
    costBudget?: number
    parentAgent?: string
    parentModel?: string
  }): Promise<{ goal: Goal; worker: WorkerSession }>

  /** Drive one continuation turn for a goal. */
  continueTurn(directory: string, goalID: GoalID, opts?: { forceFinish?: boolean; force?: boolean }): Promise<void>

  /** Force re-prompt a stuck worker even if the session reports non-idle. */
  nudge(directory: string, goalID: GoalID): Promise<{ ok: boolean; message: string }>

  /**
   * Deliver the owner's words as a bare turn: the drained inbox texts become
   * the WHOLE prompt (no steering, history, or verification wrapper) and the
   * turn starts immediately instead of waiting for the next idle boundary.
   * Engine turns are unaffected — they keep building full steering.
   */
  sendUserMessage(directory: string, goalID: GoalID, text: string): Promise<{ ok: boolean; message: string }>

  /**
   * Abort the worker session without changing goal status. Manual kill switch
   * for sessions spinning outside engine visibility (e.g. OpenCode-internal
   * error loops): releases the lease and forgets the session so the next turn
   * starts fresh. Active goals continue afterwards on a new worker.
   */
  abortWorker(directory: string, goalID: GoalID): Promise<{ ok: boolean; message: string }>

  /**
   * Fold newly completed worker messages into goal usage totals. Idempotent via
   * the accountedMessageIDs watermark. Returns the deltas that were applied.
   */
  accountUsage(directory: string, goalID: GoalID): Promise<{ tokenDelta: number; costDelta: number; timeDeltaSeconds: number; counted: string[] }>

  /** Pause a goal and abort its worker. */
  pause(directory: string, goalID: GoalID): Promise<void>

  /** Resume a paused goal. */
  resume(directory: string, goalID: GoalID): Promise<void>

  /** Retry a blocked goal. */
  retry(directory: string, goalID: GoalID): Promise<void>

  /** Clear a goal and abort its worker. */
  clear(directory: string, goalID: GoalID): Promise<void>

  /** Get the worker session for a goal (for engine to check status). */
  getWorker(goalID: GoalID): WorkerSession | undefined

  /** Get all active worker sessions. */
  getActiveWorkers(): Map<GoalID, WorkerSession>

  /** Reconcile partially started goals after restart. */
  reconcile(directory: string): Promise<void>
}

export function createGoalService(host: LoopHost): GoalService {
  const workers: WorkerManager = createWorkerManager(host)
  // In-memory cache: goalID -> worker session
  // Persisted source of truth: goal.workerSessionID in state.json
  const sessions = new Map<GoalID, WorkerSession>()
  const goalOperations = new Map<GoalID, Promise<void>>()

  // Serializes all operations for a single goal. `gate` never rejects so the
  // chain cannot stall on a thrown error; `current === gate` deletion check
  // ensures a newer waiter does not delete the successor's gate if `fn()`
  // throws synchronously before `release()` is assigned.
  async function withGoalOperation<T>(goalID: GoalID, fn: () => Promise<T>): Promise<T> {
    const previous = goalOperations.get(goalID) || Promise.resolve()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const current = previous.catch(() => {}).then(() => gate)
    goalOperations.set(goalID, current)
    await previous.catch(() => {})
    try {
      return await fn()
    } finally {
      release()
      if (goalOperations.get(goalID) === current) goalOperations.delete(goalID)
    }
  }

  function assertWorkspaceWriteAvailable(state: StoreState, goal: Goal, requesterSessionID?: string): void {
    if (!goal.config.workspaceWrite) return
    const activeWriter = state.goals.find(
      (item) => item.id !== goal.id && item.status === "active" && item.config.workspaceWrite,
    )
    if (activeWriter) {
      // The writer lock is workspace-wide but goal listing is owner-scoped,
      // so the blocker can be invisible to this caller. Say so explicitly
      // instead of letting the caller conclude the lock is stale.
      const ownedElsewhere = requesterSessionID !== undefined && activeWriter.ownerSessionID !== requesterSessionID
      throw new Error(
        `Workspace-writing goal "${activeWriter.name}" (${activeWriter.id}) is already active` +
        (ownedElsewhere ? ` (owned by session ${activeWriter.ownerSessionID}, not this session)` : "") +
        ". Pause, block, complete, or clear it before activating another workspace-writing goal." +
        (ownedElsewhere ? " Note: list_background_goals shows only this session's goals; clear/pause it from its owning session." : ""),
      )
    }
  }

  async function recordPromptFailure(
    directory: string,
    goalID: GoalID,
    error: unknown,
    blockImmediately = false,
  ): Promise<void> {
    const detail = describeError(error)
    let runID: string = "unknown"
    let failureCount = 0
    let blocked = false
    let blockerNeeded = "Retry after the OpenCode worker/session API is available."
    const state = await mutateState(directory, `turn.prompt-failed:${goalID}`, async (s) => {
      const goal = s.goals.find((item) => item.id === goalID)
      const rt = s.runtimes.find((item) => item.goalID === goalID)
      if (!goal || !rt) return s

      runID = rt.activeRunID || "unknown"
      failureCount = rt.consecutiveFailures + 1
      Object.assign(rt, releaseLease(rt))
      rt.activeRunID = undefined
      rt.consecutiveFailures = failureCount
      rt.lastError = detail

      blocked = blockImmediately || failureCount >= (goal.config.maxFailures || 5)
      if (blocked) {
        blockerNeeded = blockImmediately
          ? "Retry after the OpenCode worker/session API is available."
          : "Fix the underlying error and use retry_goal to attempt again."
        goal.status = "blocked"
        goal.blocker = {
          reason: `Worker prompt delivery failed: ${detail}`,
          needed: blockerNeeded,
          at: new Date().toISOString(),
        }
      } else {
        const backoffMs = Math.min(30_000, 1_000 * Math.pow(2, failureCount))
        rt.phase = "waiting_retry"
        rt.retryAfter = new Date(Date.now() + backoffMs).toISOString()
      }
      goal.updatedAt = new Date().toISOString()
      rt.updatedAt = new Date().toISOString()
      return s
    })

    await appendEvent(directory, {
      version: 1,
      eventID: randomUUID(),
      goalID,
      type: "run.failed",
      runID,
      error: detail,
      consecutiveFailures: failureCount,
      timestamp: new Date().toISOString(),
      revision: state.revision,
    } satisfies LoopEvent)
    if (blocked) {
      await appendEvent(directory, {
        version: 1,
        eventID: randomUUID(),
        goalID,
        type: "goal.blocked",
        reason: `Worker prompt delivery failed: ${detail}`,
        needed: blockerNeeded,
        timestamp: new Date().toISOString(),
        revision: state.revision,
      } satisfies LoopEvent)
    }
  }

  async function ensureWorkerSession(directory: string, goal: Goal): Promise<WorkerSession> {
    let session = sessions.get(goal.id)
    if (session) return session
    if (goal.workerSessionID) {
      // Reuse persisted session to keep 1 goal = 1 session; avoids duplicate on retry when cache is cold
      // Previously checked status !== "unknown" and created duplicate on unknown, causing 2 sessions per goal
      session = {
        goalID: goal.id,
        workerSessionID: goal.workerSessionID,
        startedAt: goal.createdAt,
      }
      sessions.set(goal.id, session)
      return session
    }

    session = await workers.createWorker(goal)
    sessions.set(goal.id, session)
    await mutateState(directory, `goal.set-worker:${goal.id}`, async (s) => {
      const persisted = s.goals.find((item) => item.id === goal.id)
      if (persisted) persisted.workerSessionID = session!.workerSessionID
      return s
    })
    return session
  }

  async function start(directory: string, input: {
    name: string
    objective: string
    ownerSessionID: string
    config?: Goal["config"]
    costBudget?: number
    parentAgent?: string
    parentModel?: string
  }) {
    const id = randomUUID() as GoalID
    return withGoalOperation(id, () => startUnlocked(directory, input, id))
  }

  async function startUnlocked(directory: string, input: {
    name: string
    objective: string
    ownerSessionID: string
    config?: Goal["config"]
    costBudget?: number
    parentAgent?: string
    parentModel?: string
  }, id: GoalID) {
    // Inherit the calling session's live identity when the caller didn't
    // snapshot it (TUI path). Best-effort: failure falls back to existing
    // defaults/global behavior. Keep this outside the state lock.
    let parentAgent = input.parentAgent
    let parentModel = input.parentModel
    if ((!parentAgent || !parentModel) && host.readSession) {
      try {
        const identity = await host.readSession(input.ownerSessionID)
        if (!parentAgent && identity?.agent) parentAgent = identity.agent
        if (!parentModel && identity?.model) parentModel = `${identity.model.providerID}/${identity.model.modelID}`
      } catch {
        // ignore — will fall back
      }
    }

    // Create goal and artifact directory (external I/O before lock)
    const goal = createGoal({
      id,
      name: input.name,
      objective: input.objective,
      status: "active",
      ownerSessionID: input.ownerSessionID,
      config: {
        maxTurns: 50,
        workspaceWrite: true,
        ...input.config,
      },
    })
    if (typeof input.costBudget === "number") goal.costBudget = input.costBudget
    if (parentAgent) goal.parentAgent = parentAgent
    if (parentModel) goal.parentModel = parentModel
    const artifactDir = goalArtifactDir(directory, id)
    goal.config.artifactDir = artifactDir
    if (!goal.config.progressFile) goal.config.progressFile = path.join(artifactDir, "progress.md")
    await ensureGoalArtifactDir(directory, id)

    // Atomically persist goal and set queued phase
    const state1 = await mutateState(directory, `goal.create:${id}`, async (state) => {
      assertWorkspaceWriteAvailable(state, goal, goal.ownerSessionID)
      state.goals.push(goal)
      const rt = createRuntimeState(id)
      // Initialize schedule counters (v6)
      if ((goal.config as any).schedule) {
        ;(rt as any).scheduleRunCount = 0
        ;(rt as any).nextRunAt = undefined
        ;(rt as any).lastScheduleAt = undefined
      }
      state.runtimes.push(rt)
      const runtime = state.runtimes.find((r) => r.goalID === id)
      if (runtime) runtime.phase = "queued"
      return state
    })
    let runtime = state1.runtimes.find((r) => r.goalID === id)

    // Create worker session (external I/O — not under lock)
    let worker: WorkerSession
    try {
      worker = await workers.createWorker(goal)
    } catch (error) {
      const detail = describeError(error)
      // Persist blocked state atomically
      const blockedState = await mutateState(directory, `goal.blocked:${id}`, async (state) => {
        const g = state.goals.find((item) => item.id === id)
        if (!g) return state
        g.status = "blocked"
        g.updatedAt = new Date().toISOString()
        g.blocker = {
          reason: detail,
          needed: "Start the goal again from a valid OpenCode session after correcting the worker creation error.",
          at: new Date().toISOString(),
        }
        const rt = state.runtimes.find((item) => item.goalID === id)
        if (rt) {
          rt.phase = "idle"
          rt.lastError = detail
          rt.updatedAt = new Date().toISOString()
        }
        return state
      })
      await appendEvent(directory, {
        version: 1,
        eventID: randomUUID(),
        goalID: id,
        type: "goal.blocked",
        reason: detail,
        needed: goal.blocker?.needed || "",
        timestamp: new Date().toISOString(),
        revision: blockedState.revision,
      } satisfies LoopEvent)
      await logServerEvent(directory, "goal.start.failed", { goalID: id, ownerSessionID: input.ownerSessionID, detail })
      throw new GoalStartError(detail, { goalID: id, failedStage: "worker_create" })
    }
    sessions.set(id, worker)

    // Persist worker session ID and acquire lease atomically
    const state2 = await mutateState(directory, `goal.worker-assign:${id}`, async (state) => {
      const g = state.goals.find((item) => item.id === id)
      if (!g) return state
      g.workerSessionID = worker.workerSessionID
      goal.workerSessionID = worker.workerSessionID
      const rt = state.runtimes.find((item) => item.goalID === id)
      if (rt) {
        Object.assign(rt, acquireLease(rt, g.config.timeoutMs || 300_000))
        rt.activeRunID = randomUUID() as RunID
        // "msg_" spelling: valid on v1 ("msg" prefix) and required on v2
        // (SessionMessage.ID schema). Persisted verbatim for correlation.
        rt.activePromptMessageID = newPromptMessageID()
        rt.runCount = 1
        rt.budgetTurnCount = 1
        rt.lastRunAt = new Date().toISOString()
      }
      return state
    })
    runtime = state2.runtimes.find((r) => r.goalID === id)

    await appendEvent(directory, {
      version: 1,
      eventID: randomUUID(),
      goalID: id,
      type: "goal.created",
      name: input.name,
      objective: input.objective,
      ownerSessionID: input.ownerSessionID,
      timestamp: new Date().toISOString(),
      revision: state2.revision,
    } satisfies LoopEvent)

    // Send first continuation (external I/O — not under lock)
    if (runtime) {
      await appendEvent(directory, {
        version: 1,
        eventID: randomUUID(),
        goalID: id,
        type: "run.started",
        runID: runtime.activeRunID!,
        turnCount: runtime.runCount,
        timestamp: new Date().toISOString(),
        revision: state2.revision,
      } satisfies LoopEvent)
      try {
        await workers.continueWorker(worker, goal, runtime)
      } catch (error) {
        // recordPromptFailure persists the blocked goal AND releases the run
        // lease, so resume can reuse this same worker session afterwards.
        await recordPromptFailure(directory, id, error, true)
        throw new GoalStartError(describeError(error), {
          goalID: id,
          workerSessionID: worker.workerSessionID,
          failedStage: "prompt_delivery",
        })
      }
    }

    return { goal, worker }
  }

  async function accountTailUsage(
    directory: string,
    goalID: GoalID,
    runtime: GoalRuntimeState,
    tail: SessionMessage[],
  ): Promise<{ tokenDelta: number; costDelta: number; timeDeltaSeconds: number; counted: string[] }> {
    const seenIDs = new Set(runtime.accountedMessageIDs ?? [])
    let tokenDelta = 0
    let costDelta = 0
    let timeDeltaSeconds = 0
    const counted: string[] = []
    for (const m of tail) {
      if (m.role !== "assistant" || !m.messageID || !m.completedAt) continue
      if (seenIDs.has(m.messageID)) continue
      seenIDs.add(m.messageID)
      counted.push(m.messageID)
      if (m.tokens) {
        tokenDelta += (m.tokens.input || 0) + (m.tokens.output || 0) + (m.tokens.reasoning || 0)
          + (m.tokens.cacheRead || 0) + (m.tokens.cacheWrite || 0)
      }
      if (typeof m.cost === "number") costDelta += m.cost
      if (typeof m.durationMs === "number") timeDeltaSeconds += m.durationMs / 1000
    }
    if (counted.length === 0) return { tokenDelta: 0, costDelta: 0, timeDeltaSeconds: 0, counted }
    const mergedWatermark = [...(runtime.accountedMessageIDs ?? []), ...counted].slice(-200)
    await mutateState(directory, `turn.account-usage:${goalID}`, async (s) => {
      const g = s.goals.find((item) => item.id === goalID)
      if (g) {
        g.tokensUsed += tokenDelta
        g.costUsed = (g.costUsed ?? 0) + costDelta
        g.timeUsedSeconds += timeDeltaSeconds
        g.updatedAt = new Date().toISOString()
      }
      const rt = s.runtimes.find((item) => item.goalID === goalID)
      if (rt) {
        rt.turnTokensUsed = (rt.turnTokensUsed ?? 0) + tokenDelta
        rt.accountedMessageIDs = mergedWatermark
        rt.updatedAt = new Date().toISOString()
      }
      return s
    })
    return { tokenDelta, costDelta, timeDeltaSeconds, counted }
  }

  async function accountUsageUnlocked(directory: string, goalID: GoalID) {
    const preState = await readState(directory)
    const goal = preState.goals.find((g) => g.id === goalID)
    const runtime = preState.runtimes.find((r) => r.goalID === goalID)
    if (!goal?.workerSessionID || !runtime) {
      return { tokenDelta: 0, costDelta: 0, timeDeltaSeconds: 0, counted: [] as string[] }
    }
    let tail: SessionMessage[] = []
    try {
      // Wide enough that a busy turn polled on the maintenance cadence cannot
      // push completed messages out of view before they are ever accounted.
      tail = await host.readMessages(goal.workerSessionID, 50)
    } catch {
      return { tokenDelta: 0, costDelta: 0, timeDeltaSeconds: 0, counted: [] as string[] }
    }
    return accountTailUsage(directory, goalID, runtime, tail)
  }

  async function continueTurnUnlocked(directory: string, goalID: GoalID, opts?: { forceFinish?: boolean; force?: boolean; bare?: boolean }) {
    // Read state for pre-checks (lease validity, worker idle)
    const preState = await readState(directory)
    const goal = preState.goals.find((g) => g.id === goalID)
    if (!goal || goal.status !== "active") return

    const runtime = preState.runtimes.find((r) => r.goalID === goalID)
    if (!runtime) return

    // Check lease
    if (runtime.phase === "running" && leaseIsValid(runtime)) return

    // Get worker from cache or reconstruct from persisted state
    let session = sessions.get(goalID)
    if (!session && goal.workerSessionID) {
      session = {
        goalID: goal.id,
        workerSessionID: goal.workerSessionID,
        startedAt: goal.createdAt,
      }
      sessions.set(goalID, session)
    }
    if (!session) return

    // Check worker idle — unless force is set (nudge/re-prompt)
    if (!opts?.force && !(await workers.isIdle(session.workerSessionID))) return

    // Acquire lease and increment run count atomically
    let acquired = false
    const state = await mutateState(directory, `turn.acquire:${goalID}`, async (s) => {
      const g = s.goals.find((item) => item.id === goalID)
      if (!g || g.status !== "active") return s
      const rt = s.runtimes.find((item) => item.goalID === goalID)
      if (!rt) return s
      if (rt.phase === "running" && leaseIsValid(rt)) return s
      const timeoutMs = g.config.timeoutMs || 300_000
      Object.assign(rt, acquireLease(rt, timeoutMs))
      rt.activeRunID = randomUUID() as RunID
      // "msg_" spelling: valid on v1 ("msg" prefix) and required on v2
      // (SessionMessage.ID schema). Persisted verbatim for correlation.
      rt.activePromptMessageID = newPromptMessageID()
      rt.runCount += 1
      if (rt.freeRetryPending) {
        rt.freeRetryPending = false
      } else {
        rt.budgetTurnCount += 1
      }
      rt.lastRunAt = new Date().toISOString()
      acquired = true
      return s
    })
    const freshGoal = state.goals.find((g) => g.id === goalID)
    const freshRuntime = state.runtimes.find((r) => r.goalID === goalID)
    if (!acquired || !freshGoal || freshGoal.status !== "active" || !freshRuntime?.activeRunID) return

    await appendEvent(directory, {
      version: 1,
      eventID: randomUUID(),
      goalID,
      type: "run.started",
      runID: freshRuntime.activeRunID!,
      turnCount: freshRuntime.runCount,
      timestamp: new Date().toISOString(),
      revision: state.revision,
    } satisfies LoopEvent)

    // Bare turn: the owner's drained words ARE the prompt — no steering,
    // history, or verification wrapper. Falls through to full steering when
    // the inbox is unexpectedly empty (never open a phantom turn).
    if (opts?.bare) {
      const bareWords = await drainGoalInbox(directory, goalID)
      const bareText = bareWords.join("\n").trim()
      if (bareText) {
        try {
          await workers.sendBare(session, freshGoal, freshRuntime, bareText)
        } catch (error) {
          await recordPromptFailure(directory, goalID, error)
          throw error
        }
        return
      }
    }

    // Send continuation with accumulated context (external I/O — not under lock)
    const inboxMessages = await drainGoalInbox(directory, goalID)

    // Gather progress history from events
    const allEvents = await readEvents(directory, 200)
    const progressHistory = allEvents
      .filter((e) => e.goalID === goalID && e.type === "goal.progress")
      .map((e) => ({
        summary: String(e.summary || ""),
        next: e.next ? String(e.next) : undefined,
        at: String(e.timestamp || ""),
      }))

    // Gather last 5 transcript messages from the worker session
    let transcriptTail: ContinuationContext["transcriptTail"]
    try {
      transcriptTail = await host.readMessages(freshGoal.workerSessionID!, 5)
    } catch {
      transcriptTail = []
    }

    // Usage accounting: fold newly completed assistant messages into goal totals.
    // tokensUsed counts total consumption (input+output+reasoning+cache), matching
    // what OpenCode reports per session — cache dominates in practice, so excluding
    // it would undercount by orders of magnitude. The watermark keeps overlapping
    // transcript tails from double counting; turn-level attribution is approximate,
    // lifetime totals are exact.
    await accountTailUsage(directory, goalID, freshRuntime, transcriptTail ?? [])

    // Deterministic verification pre-screen (cheap, no shell)
    let verification: ContinuationContext["verification"]
    try {
      const artifactDir = (freshGoal.config as any).artifactDir as string | undefined
      if (artifactDir) {
        try {
          const files = await fs.readdir(artifactDir)
          verification = { artifactSummary: files.length ? `${files.length} file(s): ${files.slice(0, 8).join(", ")}` : "no artifacts yet" }
        } catch {
          verification = { artifactSummary: "no artifacts yet" }
        }
      }
      if (freshGoal.config.checks?.length) {
        const c = `checks configured: ${freshGoal.config.checks.length} — run them before claiming completion`
        verification = { ...(verification || {}), failedChecks: [c], checksPassed: undefined }
      }
      // Pass evaluator rejection count and details to steering
      if (freshRuntime.evaluatorRejectionCount && freshRuntime.evaluatorRejectionCount > 0) {
        verification = { ...(verification || {}), evaluatorRejectionCount: freshRuntime.evaluatorRejectionCount }
      }
      // Pass last rejection details for exact failure context
      if (freshRuntime.lastRejectionDetails) {
        verification = { ...(verification || {}), lastRejectionDetails: freshRuntime.lastRejectionDetails }
      }
    } catch {}

    const context: ContinuationContext = {
      inboxMessages: inboxMessages.length > 0 ? inboxMessages : undefined,
      progressHistory: progressHistory.length > 0 ? progressHistory : undefined,
      transcriptTail: transcriptTail && transcriptTail.length > 0 ? transcriptTail : undefined,
      forceFinish: opts?.forceFinish || undefined,
      verification,
    }

    try {
      await workers.continueWorker(session, freshGoal, freshRuntime, context)
    } catch (error) {
      await recordPromptFailure(directory, goalID, error)
      throw error
    }
  }

  async function pauseUnlocked(directory: string, goalID: GoalID) {
    const preState = await readState(directory)
    const goal = preState.goals.find((g) => g.id === goalID)
    if (!goal) return

    if (!canTransition(goal.status, "paused", "user")) return

    const state = await mutateState(directory, `goal.pause:${goalID}`, async (s) => {
      const g = s.goals.find((item) => item.id === goalID)
      if (!g) return s
      g.status = "paused"
      g.updatedAt = new Date().toISOString()

      const rt = s.runtimes.find((r) => r.goalID === goalID)
      if (rt) {
        Object.assign(rt, releaseLease(rt))
        // releaseLease keeps activeRunID by design (other transitions clear
        // it explicitly). Pause must too — otherwise maintenance logs a
        // terminal-leak repair for a goal the owner just parked, which reads
        // as the engine misclassifying a healthy pause.
        rt.activeRunID = undefined
      }
      return s
    })

    // Abort worker from cache or persisted state (external I/O — not under lock)
    const session = sessions.get(goalID) || (goal.workerSessionID ? {
      goalID: goal.id,
      workerSessionID: goal.workerSessionID,
      startedAt: goal.createdAt,
    } : undefined)
    if (session) {
      await workers.abortWorker(session.workerSessionID)
      sessions.delete(goalID)
    }

    // Pausing cancels outstanding command awaits: an exit landing afterwards
    // fires nothing (no orphan wakes for a parked goal).
    await cancelAwaitsForGoal(directory, goalID, "goal paused").catch(() => {})

    await appendEvent(directory, {
      version: 1,
      eventID: randomUUID(),
      goalID,
      type: "goal.status_changed",
      from: "active",
      to: "paused",
      timestamp: new Date().toISOString(),
      revision: state.revision,
    } satisfies LoopEvent)
  }

  async function resumeUnlocked(directory: string, goalID: GoalID) {
    let resumed = false
    const state = await mutateState(directory, `goal.resume:${goalID}`, async (state) => {
      const goal = state.goals.find((g) => g.id === goalID)
      if (!goal) return state
      if (!canTransition(goal.status, "active", "user")) return state
      assertWorkspaceWriteAvailable(state, goal, goal.ownerSessionID)
      goal.status = "active"
      goal.updatedAt = new Date().toISOString()
      resumed = true
      return state
    })

    const goal = state.goals.find((g) => g.id === goalID)
    if (!goal || !resumed) return

    // Get or recreate worker (external I/O — not under lock)
    try {
      await ensureWorkerSession(directory, goal)
    } catch (error) {
      await mutateState(directory, `goal.resume-rollback:${goalID}`, async (s) => {
        const g = s.goals.find((item) => item.id === goalID)
        if (g?.status === "active") g.status = "paused"
        return s
      })
      throw error
    }

    await appendEvent(directory, {
      version: 1,
      eventID: randomUUID(),
      goalID,
      type: "goal.status_changed",
      from: "paused",
      to: "active",
      timestamp: new Date().toISOString(),
      revision: state.revision,
    } satisfies LoopEvent)

    // Drive first continuation
    await continueTurnUnlocked(directory, goalID)
  }

  async function retryUnlocked(directory: string, goalID: GoalID) {
    let retried = false
    const state = await mutateState(directory, `goal.retry:${goalID}`, async (state) => {
      const goal = state.goals.find((g) => g.id === goalID)
      if (!goal || goal.status !== "blocked") return state
      assertWorkspaceWriteAvailable(state, goal, goal.ownerSessionID)
      goal.status = "active"
      goal.updatedAt = new Date().toISOString()
      retried = true
      const runtime = state.runtimes.find((r) => r.goalID === goalID)
      if (runtime) {
        runtime.consecutiveFailures = 0
        runtime.lastError = undefined
        runtime.forceFinishRequested = undefined
        runtime.evaluatorRejectionCount = 0
        runtime.lastRejectionDetails = undefined
        runtime.freeRetryPending = false
        runtime.lastParentNotifiedAt = undefined
        runtime.lastParentNotifiedFor = undefined
        Object.assign(runtime, releaseLease(runtime))
        runtime.activeRunID = undefined
        runtime.updatedAt = new Date().toISOString()
      }
      return state
    })

    const goal = state.goals.find((g) => g.id === goalID)
    if (!goal || !retried) return

    try {
      await ensureWorkerSession(directory, goal)
    } catch (error) {
      await mutateState(directory, `goal.retry-rollback:${goalID}`, async (s) => {
        const g = s.goals.find((item) => item.id === goalID)
        if (g?.status === "active") g.status = "blocked"
        return s
      })
      throw error
    }

    await appendEvent(directory, {
      version: 1,
      eventID: randomUUID(),
      goalID,
      type: "goal.status_changed",
      from: "blocked",
      to: "active",
      timestamp: new Date().toISOString(),
      revision: state.revision,
    } satisfies LoopEvent)

    await continueTurnUnlocked(directory, goalID)
  }

  async function clearUnlocked(directory: string, goalID: GoalID) {
    const state = await readState(directory)
    const goal = state.goals.find((g) => g.id === goalID)
    if (!goal) return

    // Abort worker from cache or persisted state (external I/O — not under lock)
    const session = sessions.get(goalID) || (goal.workerSessionID ? {
      goalID: goal.id,
      workerSessionID: goal.workerSessionID,
      startedAt: goal.createdAt,
    } : undefined)
    if (session) {
      await workers.abortWorker(session.workerSessionID)
      sessions.delete(goalID)
    }

    await mutateState(directory, `goal.clear:${goalID}`, async (s) => {
      s.goals = s.goals.filter((g) => g.id !== goalID)
      s.runtimes = s.runtimes.filter((r) => r.goalID !== goalID)
      // Clearing cancels outstanding awaits: no orphan wakes after clear.
      s.commandAwaits = (s.commandAwaits ?? []).filter((a) => a.goalID !== goalID)
      return s
    })

    await appendEvent(directory, {
      version: 1,
      eventID: randomUUID(),
      goalID,
      type: "goal.cleared",
      timestamp: new Date().toISOString(),
      revision: state.revision,
    } satisfies LoopEvent)
  }

  function getWorker(goalID: GoalID): WorkerSession | undefined {
    return sessions.get(goalID)
  }

  function getActiveWorkers(): Map<GoalID, WorkerSession> {
    return new Map(sessions)
  }

  async function reconcile(directory: string) {
    const state = await readState(directory)

    for (const goal of state.goals) {
      if (isTerminal(goal.status)) continue
      if (goal.status === "paused") continue

      // Active goal without worker ID: create a worker (external I/O — not under lock)
      if (!goal.workerSessionID) {
        let worker: WorkerSession | undefined
        try {
          worker = await workers.createWorker(goal)
          sessions.set(goal.id, worker)
        } catch (error) {
          const detail = describeError(error)
          await mutateState(directory, `reconcile.block:${goal.id}`, async (s) => {
            const g = s.goals.find((item) => item.id === goal.id)
            if (!g) return s
            g.status = "blocked"
            g.updatedAt = new Date().toISOString()
            g.blocker = {
              reason: detail,
              needed: "Clear this goal and start it again from a valid OpenCode session.",
              at: new Date().toISOString(),
            }
            const rt = s.runtimes.find((item) => item.goalID === goal.id)
            if (rt) {
              rt.phase = "idle"
              rt.lastError = detail
              rt.updatedAt = new Date().toISOString()
            }
            return s
          })
          await logServerEvent(directory, "goal.reconcile.failed", { goalID: goal.id, ownerSessionID: goal.ownerSessionID, detail })
          continue
        }
        await mutateState(directory, `reconcile.set-worker:${goal.id}`, async (s) => {
          const g = s.goals.find((item) => item.id === goal.id)
          if (g) {
            g.workerSessionID = worker!.workerSessionID
            g.updatedAt = new Date().toISOString()
          }
          return s
        })
      }

      // Active goal with worker ID: cache the worker session
      if (goal.workerSessionID && !sessions.has(goal.id)) {
        sessions.set(goal.id, {
          goalID: goal.id,
          workerSessionID: goal.workerSessionID,
          startedAt: goal.createdAt,
        })
      }

      // Active goal with expired lease and idle worker: release and resume
      const preRt = state.runtimes.find((r) => r.goalID === goal.id)
      if (preRt?.phase === "running" && !leaseIsValid(preRt)) {
        const session = sessions.get(goal.id)
        if (session && await workers.isIdle(session.workerSessionID)) {
          await mutateState(directory, `reconcile.release-lease:${goal.id}`, async (s) => {
            const rt = s.runtimes.find((r) => r.goalID === goal.id)
            if (rt) {
              Object.assign(rt, releaseLease(rt))
              const g = s.goals.find((item) => item.id === goal.id)
              if (g) g.updatedAt = new Date().toISOString()
            }
            return s
          })
        }
      }
    }
  }

  async function nudgeUnlocked(directory: string, goalID: GoalID): Promise<{ ok: boolean; message: string }> {
    const preState = await readState(directory)
    const goal = preState.goals.find((g) => g.id === goalID)
    if (!goal) return { ok: false, message: "Goal not found." }
    if (goal.status !== "active") {
      return { ok: false, message: `Goal is ${goal.status}; resume or retry it before nudging.` }
    }

    // Clear stale run state so the continuation is not gated on an old lease/run.
    const cleared = await mutateState(directory, `goal.nudge:${goalID}`, async (s) => {
      const rt = s.runtimes.find((r) => r.goalID === goalID)
      if (!rt) return s
      rt.phase = "idle"
      rt.activeRunID = undefined
      rt.idleCandidateAt = undefined
      rt.activePromptMessageID = undefined
      rt.activeToolCallIDs = []
      rt.updatedAt = new Date().toISOString()
      return s
    })
    const freshGoal = cleared.goals.find((g) => g.id === goalID)
    if (!freshGoal || !freshGoal.workerSessionID) {
      return { ok: false, message: "Goal has no worker session. Use resume_goal or retry_goal." }
    }

    // Force a continuation even if the session reports non-idle.
    await continueTurnUnlocked(directory, goalID, { force: true })
    return { ok: true, message: `Re-prompted worker for "${freshGoal.name}".` }
  }

  async function sendUnlocked(directory: string, goalID: GoalID, text: string): Promise<{ ok: boolean; message: string }> {
    const trimmed = text.trim()
    if (!trimmed) return { ok: false, message: "Nothing to send." }
    const preState = await readState(directory)
    const goal = preState.goals.find((g) => g.id === goalID)
    if (!goal) return { ok: false, message: "Goal not found." }

    await appendGoalInbox(directory, goalID, "user", trimmed)
    if (goal.status !== "active") {
      return { ok: true, message: `Queued for "${goal.name}" (goal is ${goal.status}; delivers on the next active turn).` }
    }

    // Clear stale run state so the bare turn is not gated on an old lease/run.
    const cleared = await mutateState(directory, `goal.send:${goalID}`, async (s) => {
      const rt = s.runtimes.find((r) => r.goalID === goalID)
      if (!rt) return s
      rt.phase = "idle"
      rt.activeRunID = undefined
      rt.idleCandidateAt = undefined
      rt.activePromptMessageID = undefined
      rt.activeToolCallIDs = []
      rt.updatedAt = new Date().toISOString()
      return s
    })
    const freshGoal = cleared.goals.find((g) => g.id === goalID)
    if (!freshGoal || !freshGoal.workerSessionID) {
      return { ok: true, message: `Queued for "${goal.name}" (no worker session yet; delivers on the next turn).` }
    }

    // Force a bare turn now: the drained words alone, no steering wrapper.
    await continueTurnUnlocked(directory, goalID, { force: true, bare: true })
    return { ok: true, message: `Sent to "${freshGoal.name}" as its own turn.` }
  }

  function sendUserMessage(directory: string, goalID: GoalID, text: string) {
    return withGoalOperation(goalID, () => sendUnlocked(directory, goalID, text))
  }

  function continueTurn(directory: string, goalID: GoalID, opts?: { forceFinish?: boolean; force?: boolean; bare?: boolean }) {
    return withGoalOperation(goalID, () => continueTurnUnlocked(directory, goalID, opts))
  }

  function pause(directory: string, goalID: GoalID) {
    return withGoalOperation(goalID, () => pauseUnlocked(directory, goalID))
  }

  function resume(directory: string, goalID: GoalID) {
    return withGoalOperation(goalID, () => resumeUnlocked(directory, goalID))
  }

  function retry(directory: string, goalID: GoalID) {
    return withGoalOperation(goalID, () => retryUnlocked(directory, goalID))
  }

  function clear(directory: string, goalID: GoalID) {
    return withGoalOperation(goalID, () => clearUnlocked(directory, goalID))
  }

  function nudge(directory: string, goalID: GoalID) {
    return withGoalOperation(goalID, () => nudgeUnlocked(directory, goalID))
  }

  async function abortWorkerUnlocked(directory: string, goalID: GoalID): Promise<{ ok: boolean; message: string }> {
    const preState = await readState(directory)
    const goal = preState.goals.find((g) => g.id === goalID)
    if (!goal) return { ok: false, message: "Goal not found." }
    const workerID = sessions.get(goalID)?.workerSessionID || goal.workerSessionID
    if (!workerID) return { ok: false, message: `Goal "${goal.name}" has no worker session to abort.` }

    try {
      await workers.abortWorker(workerID)
    } catch {
      // Best-effort — state cleanup below still detaches the run.
    }
    sessions.delete(goalID)

    // NOTE: goal.workerSessionID is deliberately kept. Abort stops the run but
    // does not delete the OpenCode session — transcript stays browsable via
    // the dashboard, and the next turn reuses the session. Only the live run
    // markers are cleared.
    await mutateState(directory, `goal.abort-worker:${goalID}`, async (s) => {
      const rt = s.runtimes.find((r) => r.goalID === goalID)
      if (rt) {
        Object.assign(rt, releaseLease(rt))
        rt.activeRunID = undefined
        rt.activePromptMessageID = undefined
        rt.activeToolCallIDs = []
        rt.idleCandidateAt = undefined
        rt.idleCandidateGeneration = undefined
        rt.workerAbortedAt = new Date().toISOString()
        rt.updatedAt = new Date().toISOString()
      }
      const g = s.goals.find((item) => item.id === goalID)
      if (g) g.updatedAt = new Date().toISOString()
      return s
    })
    await logServerEvent(directory, "worker.aborted-manual", { goalID, workerSessionID: workerID })
    return {
      ok: true,
      message: `Worker run for "${goal.name}" aborted, session kept for inspection (status unchanged: ${goal.status}).` +
        (goal.status === "active" ? " Engine continues the same session next turn." : ""),
    }
  }

  function abortWorker(directory: string, goalID: GoalID) {
    return withGoalOperation(goalID, () => abortWorkerUnlocked(directory, goalID))
  }

  function accountUsage(directory: string, goalID: GoalID) {
    return withGoalOperation(goalID, () => accountUsageUnlocked(directory, goalID))
  }

  return { start, continueTurn, nudge, pause, resume, retry, clear, getWorker, getActiveWorkers, reconcile, accountUsage, abortWorker, sendUserMessage }
}
