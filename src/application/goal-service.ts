// ─── Server: Goal Service ────────────────────────────────────────────────────
// Manages goal lifecycle: start, pause, resume, retry, clear.
// Creates worker sessions, drives continuation, handles completion.
// Worker registry is persisted; in-memory map is a cache only.

import { randomUUID } from "crypto"
import type { Goal, GoalID } from "../domain/goal"
import { createGoal, canTransition, isTerminal } from "../domain/goal"
import type { GoalRuntimeState, RunID } from "../domain/runtime"
import { createRuntimeState, acquireLease, releaseLease, leaseIsValid, markProgress } from "../domain/runtime"
import { readState, writeState, mutateState, appendEvent, drainGoalInbox, readEvents, goalArtifactDir, ensureGoalArtifactDir } from "../infrastructure/state-repository"
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
  continueTurn(directory: string, goalID: GoalID, opts?: { forceFinish?: boolean }): Promise<void>

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

  async function start(directory: string, input: {
    name: string
    objective: string
    ownerSessionID: string
    config?: Goal["config"]
  }) {
    const id = randomUUID() as GoalID

    // Create goal and artifact directory (external I/O before lock)
    const goal = createGoal({
      id,
      name: input.name,
      objective: input.objective,
      status: "active",
      ownerSessionID: input.ownerSessionID,
      config: {
        maxTurns: 50,
        ...input.config,
      },
    })
    const artifactDir = goalArtifactDir(directory, id)
    goal.config.artifactDir = artifactDir
    if (!goal.config.progressFile) goal.config.progressFile = path.join(artifactDir, "progress.md")
    await ensureGoalArtifactDir(directory, id)

    // Atomically persist goal and set queued phase
    const state1 = await mutateState(directory, `goal.create:${id}`, async (state) => {
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
        needed: goal.blocker.needed,
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
      const rt = state.runtimes.find((item) => item.goalID === id)
      if (rt) {
        Object.assign(rt, acquireLease(rt, g.config.timeoutMs || 300_000))
        rt.activeRunID = randomUUID() as RunID
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
      const result = await workers.continueWorker(worker, goal, runtime)
      if (result.messageID) {
        await mutateState(directory, `goal.message-id:${id}`, async (state) => {
          const rt = state.runtimes.find((item) => item.goalID === id)
          if (rt) rt.activePromptMessageID = result.messageID
          return state
        })
      }
    }

    return { goal, worker }
  }

  async function continueTurn(directory: string, goalID: GoalID, opts?: { forceFinish?: boolean }) {
    // Read state for pre-checks (lease validity, worker idle)
    const preState = await readState(directory)
    const goal = preState.goals.find((g) => g.id === goalID)
    if (!goal || isTerminal(goal.status)) return

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

    // Check worker idle
    if (!(await workers.isIdle(session.workerSessionID))) return

    // Acquire lease and increment run count atomically
    const state = await mutateState(directory, `turn.acquire:${goalID}`, async (s) => {
      const g = s.goals.find((item) => item.id === goalID)
      if (!g || isTerminal(g.status)) return s
      const rt = s.runtimes.find((item) => item.goalID === goalID)
      if (!rt) return s
      const timeoutMs = g.config.timeoutMs || 300_000
      Object.assign(rt, acquireLease(rt, timeoutMs))
      rt.activeRunID = randomUUID() as RunID
      rt.runCount += 1
      if (rt.freeRetryPending) {
        rt.freeRetryPending = false
      } else {
        rt.budgetTurnCount += 1
      }
      rt.lastRunAt = new Date().toISOString()
      return s
    })
    const freshGoal = state.goals.find((g) => g.id === goalID)
    const freshRuntime = state.runtimes.find((r) => r.goalID === goalID)
    if (!freshGoal || !freshRuntime) return

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

    await workers.continueWorker(session, freshGoal, freshRuntime, context)
  }

  async function pause(directory: string, goalID: GoalID) {
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

  async function resume(directory: string, goalID: GoalID) {
    const state = await mutateState(directory, `goal.resume:${goalID}`, async (state) => {
      const goal = state.goals.find((g) => g.id === goalID)
      if (!goal) return state
      if (!canTransition(goal.status, "active", "user")) return state
      goal.status = "active"
      goal.updatedAt = new Date().toISOString()
      return state
    })

    const goal = state.goals.find((g) => g.id === goalID)
    if (!goal) return

    // Get or recreate worker (external I/O — not under lock)
    let session = sessions.get(goalID)
    if (!session) {
      session = await workers.createWorker(goal)
      sessions.set(goalID, session)
      await mutateState(directory, `goal.set-worker:${goalID}`, async (s) => {
        const g = s.goals.find((x) => x.id === goalID)
        if (g) g.workerSessionID = session!.workerSessionID
        return s
      })
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
    await continueTurn(directory, goalID)
  }

  async function retry(directory: string, goalID: GoalID) {
    const state = await mutateState(directory, `goal.retry:${goalID}`, async (state) => {
      const goal = state.goals.find((g) => g.id === goalID)
      if (!goal || goal.status !== "blocked") return state
      goal.status = "active"
      goal.updatedAt = new Date().toISOString()
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
    if (!goal || goal.status !== "active") return

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

    await continueTurn(directory, goalID)
  }

  async function clear(directory: string, goalID: GoalID) {
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

      // Active goal without worker ID: create a worker
      if (!goal.workerSessionID) {
        try {
          const worker = await workers.createWorker(goal)
          sessions.set(goal.id, worker)
          goal.workerSessionID = worker.workerSessionID
          goal.updatedAt = new Date().toISOString()
        } catch (error) {
          const detail = describeError(error)
          goal.status = "blocked"
          goal.updatedAt = new Date().toISOString()
          goal.blocker = {
            reason: detail,
            needed: "Clear this goal and start it again from a valid OpenCode session.",
            at: new Date().toISOString(),
          }
          const runtime = state.runtimes.find((item) => item.goalID === goal.id)
          if (runtime) {
            runtime.phase = "idle"
            runtime.lastError = detail
            runtime.updatedAt = new Date().toISOString()
          }
          await logServerEvent(directory, "goal.reconcile.failed", { goalID: goal.id, ownerSessionID: goal.ownerSessionID, detail })
          continue
        }
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
      const runtime = state.runtimes.find((r) => r.goalID === goal.id)
      if (runtime?.phase === "running" && !leaseIsValid(runtime)) {
        const session = sessions.get(goal.id)
        if (session && await workers.isIdle(session.workerSessionID)) {
          Object.assign(runtime, releaseLease(runtime))
          goal.updatedAt = new Date().toISOString()
        }
      }
    }

    await writeState(directory, state)
  }

  return { start, continueTurn, pause, resume, retry, clear, getWorker, getActiveWorkers, reconcile }
}
