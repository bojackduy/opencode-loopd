// ─── Server: Goal Service ────────────────────────────────────────────────────
// Manages goal lifecycle: start, pause, resume, retry, clear.
// Creates worker sessions, drives continuation, handles completion.
// Worker registry is persisted; in-memory map is a cache only.

import { randomUUID } from "crypto"
import type { Goal, GoalID } from "../domain/goal"
import { createGoal, canTransition, isTerminal } from "../domain/goal"
import type { GoalRuntimeState, RunID } from "../domain/runtime"
import { createRuntimeState, acquireLease, releaseLease, leaseIsValid, markProgress } from "../domain/runtime"
import { readState, mutateState, appendEvent, drainGoalInbox, readEvents, goalArtifactDir, ensureGoalArtifactDir } from "../infrastructure/state-repository"
import * as path from "path"
import { promises as fs } from "fs"
import type { StoreState } from "../infrastructure/state-repository"
import type { LoopHost } from "../server/host-adapter"
import { createWorkerManager, type WorkerManager, type WorkerSession, type ContinuationContext } from "../server/worker-session"
import type { LoopEvent } from "../domain/events"
import { describeError, logServerEvent } from "../infrastructure/server-log"

export interface GoalService {
  /** Start a goal: create goal + worker session + first continuation. */
  start(directory: string, input: {
    name: string
    objective: string
    ownerSessionID: string
    config?: Goal["config"]
  }): Promise<{ goal: Goal; worker: WorkerSession }>

  /** Drive one continuation turn for a goal. */
  continueTurn(directory: string, goalID: GoalID, opts?: { forceFinish?: boolean; force?: boolean }): Promise<void>

  /** Force re-prompt a stuck worker even if the session reports non-idle. */
  nudge(directory: string, goalID: GoalID): Promise<{ ok: boolean; message: string }>

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

  function assertWorkspaceWriteAvailable(state: StoreState, goal: Goal): void {
    if (!goal.config.workspaceWrite) return
    const activeWriter = state.goals.find(
      (item) => item.id !== goal.id && item.status === "active" && item.config.workspaceWrite,
    )
    if (activeWriter) {
      throw new Error(
        `Workspace-writing goal "${activeWriter.name}" (${activeWriter.id}) is already active. ` +
        "Pause, block, complete, or clear it before activating another workspace-writing goal.",
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
        goal.status = "blocked"
        goal.blocker = {
          reason: `Worker prompt delivery failed: ${detail}`,
          needed: "Retry after the OpenCode worker/session API is available.",
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
        needed: "Retry after the OpenCode worker/session API is available.",
        timestamp: new Date().toISOString(),
        revision: state.revision,
      } satisfies LoopEvent)
    }
  }

  async function ensureWorkerSession(directory: string, goal: Goal): Promise<WorkerSession> {
    let session = sessions.get(goal.id)
    if (!session && goal.workerSessionID) {
      const status = await host.sessionStatus(goal.workerSessionID)
      if (status !== "unknown") {
        session = {
          goalID: goal.id,
          workerSessionID: goal.workerSessionID,
          startedAt: goal.createdAt,
        }
        sessions.set(goal.id, session)
      }
    }
    if (session) return session

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
  }) {
    const id = randomUUID() as GoalID
    return withGoalOperation(id, () => startUnlocked(directory, input, id))
  }

  async function startUnlocked(directory: string, input: {
    name: string
    objective: string
    ownerSessionID: string
    config?: Goal["config"]
  }, id: GoalID) {
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
    const artifactDir = goalArtifactDir(directory, id)
    goal.config.artifactDir = artifactDir
    if (!goal.config.progressFile) goal.config.progressFile = path.join(artifactDir, "progress.md")
    await ensureGoalArtifactDir(directory, id)

    // Atomically persist goal and set queued phase
    const state1 = await mutateState(directory, `goal.create:${id}`, async (state) => {
      assertWorkspaceWriteAvailable(state, goal)
      state.goals.push(goal)
      state.runtimes.push(createRuntimeState(id))
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
      throw error
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
        rt.activePromptMessageID = randomUUID()
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
        await recordPromptFailure(directory, id, error, true)
        throw error
      }
    }

    return { goal, worker }
  }

  async function continueTurnUnlocked(directory: string, goalID: GoalID, opts?: { forceFinish?: boolean; force?: boolean }) {
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
      rt.activePromptMessageID = randomUUID()
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
      if (rt) Object.assign(rt, releaseLease(rt))
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
      assertWorkspaceWriteAvailable(state, goal)
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
      assertWorkspaceWriteAvailable(state, goal)
      goal.status = "active"
      goal.updatedAt = new Date().toISOString()
      retried = true
      const runtime = state.runtimes.find((r) => r.goalID === goalID)
      if (runtime) {
        runtime.consecutiveFailures = 0
        runtime.lastError = undefined
        runtime.forceFinishRequested = undefined
        runtime.lastParentNotifiedAt = undefined
        runtime.lastParentNotifiedFor = undefined
        runtime.phase = "idle"
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

  function continueTurn(directory: string, goalID: GoalID, opts?: { forceFinish?: boolean; force?: boolean }) {
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

  return { start, continueTurn, nudge, pause, resume, retry, clear, getWorker, getActiveWorkers, reconcile }
}
