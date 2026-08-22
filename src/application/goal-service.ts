// ─── Server: Goal Service ────────────────────────────────────────────────────
// Manages goal lifecycle: start, pause, resume, retry, clear.
// Creates worker sessions, drives continuation, handles completion.
// Worker registry is persisted; in-memory map is a cache only.

import { randomUUID } from "crypto"
import type { Goal, GoalID } from "../domain/goal"
import { createGoal, canTransition, isTerminal } from "../domain/goal"
import type { GoalRuntimeState, RunID } from "../domain/runtime"
import { createRuntimeState, acquireLease, releaseLease, leaseIsValid, markProgress } from "../domain/runtime"
import { readState, writeState, appendEvent, drainGoalInbox, readEvents, goalArtifactDir, ensureGoalArtifactDir } from "../infrastructure/state-repository"
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
    const state = await readState(directory)
    const id = randomUUID() as GoalID

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

    // Compute per-goal artifact directory and wire defaults
    const artifactDir = goalArtifactDir(directory, id)
    goal.config.artifactDir = artifactDir
    if (!goal.config.progressFile) goal.config.progressFile = path.join(artifactDir, "progress.md")
    await ensureGoalArtifactDir(directory, id)

    state.goals.push(goal)
    state.runtimes.push(createRuntimeState(id))

    // Persist state with goal in queued phase before creating worker
    const runtime = state.runtimes.find((r) => r.goalID === id)
    if (runtime) {
      runtime.phase = "queued"
      await writeState(directory, state)
    }

    // Create worker session
    let worker: WorkerSession
    try {
      worker = await workers.createWorker(goal)
    } catch (error) {
      const detail = describeError(error)
      goal.status = "blocked"
      goal.updatedAt = new Date().toISOString()
      goal.blocker = {
        reason: detail,
        needed: "Start the goal again from a valid OpenCode session after correcting the worker creation error.",
        at: new Date().toISOString(),
      }
      if (runtime) {
        runtime.phase = "idle"
        runtime.lastError = detail
        runtime.updatedAt = new Date().toISOString()
      }
      await writeState(directory, state)
      await appendEvent(directory, {
        version: 1,
        eventID: randomUUID(),
        goalID: id,
        type: "goal.blocked",
        reason: detail,
        needed: goal.blocker.needed,
        timestamp: new Date().toISOString(),
        revision: state.revision,
      } satisfies LoopEvent)
      await logServerEvent(directory, "goal.start.failed", { goalID: id, ownerSessionID: input.ownerSessionID, detail })
      throw error
    }
    sessions.set(id, worker)
    goal.workerSessionID = worker.workerSessionID

    // Persist worker session ID before prompting
    await writeState(directory, state)

    await appendEvent(directory, {
      version: 1,
      eventID: randomUUID(),
      goalID: id,
      type: "goal.created",
      name: input.name,
      objective: input.objective,
      ownerSessionID: input.ownerSessionID,
      timestamp: new Date().toISOString(),
      revision: state.revision,
    } satisfies LoopEvent)

    // Send first continuation
    if (runtime) {
      const runID = randomUUID() as RunID
      Object.assign(runtime, acquireLease(runtime, goal.config.timeoutMs || 300_000))
      runtime.activeRunID = runID
      runtime.turnCount = 1
      runtime.runCount = 1
      runtime.lastRunAt = new Date().toISOString()
      await writeState(directory, state)
      await appendEvent(directory, {
        version: 1,
        eventID: randomUUID(),
        goalID: id,
        type: "run.started",
        runID,
        turnCount: runtime.turnCount,
        timestamp: new Date().toISOString(),
        revision: state.revision,
      } satisfies LoopEvent)
      await workers.continueWorker(worker, goal, runtime)
    }

    return { goal, worker }
  }

  async function continueTurn(directory: string, goalID: GoalID, opts?: { forceFinish?: boolean }) {
    const state = await readState(directory)
    const goal = state.goals.find((g) => g.id === goalID)
    if (!goal || isTerminal(goal.status)) return

    const runtime = state.runtimes.find((r) => r.goalID === goalID)
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

    // Acquire lease
    const timeoutMs = goal.config.timeoutMs || 300_000
    const leased = acquireLease(runtime, timeoutMs)
    Object.assign(runtime, leased)
    const runID = randomUUID() as RunID
    runtime.activeRunID = runID
    runtime.turnCount += 1
    runtime.runCount += 1
    runtime.lastRunAt = new Date().toISOString()
    await writeState(directory, state)
    await appendEvent(directory, {
      version: 1,
      eventID: randomUUID(),
      goalID,
      type: "run.started",
      runID,
      turnCount: runtime.turnCount,
      timestamp: new Date().toISOString(),
      revision: state.revision,
    } satisfies LoopEvent)

    // Send continuation with accumulated context
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
      transcriptTail = await host.readMessages(goal.workerSessionID!, 5)
    } catch {
      transcriptTail = []
    }

    // Deterministic verification pre-screen (cheap, no shell)
    let verification: ContinuationContext["verification"]
    try {
      const artifactDir = (goal.config as any).artifactDir as string | undefined
      if (artifactDir) {
        try {
          const files = await fs.readdir(artifactDir)
          verification = { artifactSummary: files.length ? `${files.length} file(s): ${files.slice(0, 8).join(", ")}` : "no artifacts yet" }
        } catch {
          verification = { artifactSummary: "no artifacts yet" }
        }
      }
      if (goal.config.checks?.length) {
        const c = `checks configured: ${goal.config.checks.length} — run them before claiming completion`
        verification = { ...(verification || {}), failedChecks: [c], checksPassed: undefined }
      }
    } catch {}

    const context: ContinuationContext = {
      inboxMessages: inboxMessages.length > 0 ? inboxMessages : undefined,
      progressHistory: progressHistory.length > 0 ? progressHistory : undefined,
      transcriptTail: transcriptTail && transcriptTail.length > 0 ? transcriptTail : undefined,
      forceFinish: opts?.forceFinish || undefined,
      verification,
    }

    await workers.continueWorker(session, goal, runtime, context)
  }

  async function pause(directory: string, goalID: GoalID) {
    const state = await readState(directory)
    const goal = state.goals.find((g) => g.id === goalID)
    if (!goal) return

    if (!canTransition(goal.status, "paused", "user")) return

    goal.status = "paused"
    goal.updatedAt = new Date().toISOString()

    // Abort worker from cache or persisted state
    const session = sessions.get(goalID) || (goal.workerSessionID ? {
      goalID: goal.id,
      workerSessionID: goal.workerSessionID,
      startedAt: goal.createdAt,
    } : undefined)
    if (session) {
      await workers.abortWorker(session.workerSessionID)
      sessions.delete(goalID)
    }

    // Release lease
    const runtime = state.runtimes.find((r) => r.goalID === goalID)
    if (runtime) {
      Object.assign(runtime, releaseLease(runtime))
    }

    await writeState(directory, state)
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
    const state = await readState(directory)
    const goal = state.goals.find((g) => g.id === goalID)
    if (!goal) return

    if (!canTransition(goal.status, "active", "user")) return

    goal.status = "active"
    goal.updatedAt = new Date().toISOString()

    // Get or recreate worker
    let session = sessions.get(goalID)
    if (!session) {
      session = await workers.createWorker(goal)
      sessions.set(goalID, session)
      goal.workerSessionID = session.workerSessionID
    }

    await writeState(directory, state)
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
    const state = await readState(directory)
    const goal = state.goals.find((g) => g.id === goalID)
    if (!goal || goal.status !== "blocked") return

    goal.status = "active"
    goal.updatedAt = new Date().toISOString()

    const runtime = state.runtimes.find((r) => r.goalID === goalID)
    if (runtime) {
      runtime.consecutiveFailures = 0
      runtime.lastError = undefined
      runtime.forceFinishRequested = undefined
      runtime.phase = "idle"
      runtime.updatedAt = new Date().toISOString()
    }

    await writeState(directory, state)
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

    // Abort worker from cache or persisted state
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
      type: "goal.cleared",
      timestamp: new Date().toISOString(),
      revision: state.revision,
    } satisfies LoopEvent)

    state.goals = state.goals.filter((g) => g.id !== goalID)
    state.runtimes = state.runtimes.filter((r) => r.goalID !== goalID)

    await writeState(directory, state)
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
