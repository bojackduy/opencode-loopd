// ─── Server: Goal Service ────────────────────────────────────────────────────
// Manages goal lifecycle: start, pause, resume, retry, clear.
// Creates worker sessions, drives continuation, handles completion.

import { randomUUID } from "crypto"
import type { Goal, GoalID } from "../domain/goal"
import { createGoal, canTransition } from "../domain/goal"
import type { GoalRuntimeState } from "../domain/runtime"
import { createRuntimeState, acquireLease, releaseLease, leaseIsValid } from "../domain/runtime"
import { readState, writeState, appendEvent } from "../infrastructure/state-store"
import type { StoreState } from "../infrastructure/state-store"
import type { LoopHost } from "../server/host-adapter"
import { createWorkerManager, type WorkerManager, type WorkerSession } from "../server/worker-session"
import type { LoopEvent } from "../domain/events"

export interface GoalService {
  /** Start a goal: create goal + worker session + first continuation. */
  start(directory: string, input: {
    name: string
    objective: string
    ownerSessionID: string
    config?: Goal["config"]
  }): Promise<{ goal: Goal; worker: WorkerSession }>

  /** Drive one continuation turn for a goal. */
  continueTurn(directory: string, goalID: GoalID): Promise<void>

  /** Pause a goal and abort its worker. */
  pause(directory: string, goalID: GoalID): Promise<void>

  /** Resume a paused goal. */
  resume(directory: string, goalID: GoalID): Promise<void>

  /** Retry a blocked goal. */
  retry(directory: string, goalID: GoalID): Promise<void>

  /** Clear a goal and abort its worker. */
  clear(directory: string, goalID: GoalID): Promise<void>
}

export function createGoalService(host: LoopHost): GoalService {
  const workers: WorkerManager = createWorkerManager(host)
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
      config: input.config || {},
    })

    state.goals.push(goal)
    state.runtimes.push(createRuntimeState(id))

    // Create worker session
    const worker = await workers.createWorker(goal)
    sessions.set(id, worker)
    goal.workerSessionID = worker.workerSessionID

    await writeState(directory, state)
    await appendEvent(directory, {
      version: 1,
      eventID: randomUUID(),
      goalID: id,
      type: "goal.created",
      name: input.name,
      objective: input.objective,
      timestamp: new Date().toISOString(),
      revision: state.revision,
    } satisfies LoopEvent)

    // Send first continuation
    const runtime = state.runtimes.find((r) => r.goalID === id)
    if (runtime) {
      runtime.turnCount = 1
      runtime.lastRunAt = new Date().toISOString()
      runtime.phase = "running"
      await writeState(directory, state)
      await workers.continueWorker(worker, goal, runtime)
    }

    return { goal, worker }
  }

  async function continueTurn(directory: string, goalID: GoalID) {
    const state = await readState(directory)
    const goal = state.goals.find((g) => g.id === goalID)
    if (!goal || goal.status !== "active") return

    const runtime = state.runtimes.find((r) => r.goalID === goalID)
    if (!runtime) return

    // Check lease
    if (runtime.phase === "running" && leaseIsValid(runtime)) return

    // Check worker idle
    const session = sessions.get(goalID)
    if (session && !(await workers.isIdle(session.workerSessionID))) return

    // Acquire lease
    const timeoutMs = goal.config.timeoutMs || 300_000
    const leased = acquireLease(runtime, timeoutMs)
    Object.assign(runtime, leased)
    runtime.turnCount += 1
    runtime.lastRunAt = new Date().toISOString()
    await writeState(directory, state)

    // Send continuation
    if (session) {
      await workers.continueWorker(session, goal, runtime)
    }
  }

  async function pause(directory: string, goalID: GoalID) {
    const state = await readState(directory)
    const goal = state.goals.find((g) => g.id === goalID)
    if (!goal) return

    if (!canTransition(goal.status, "paused", "user")) return

    goal.status = "paused"
    goal.updatedAt = new Date().toISOString()

    // Abort worker
    const session = sessions.get(goalID)
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

    // Recreate worker if needed
    if (!sessions.has(goalID)) {
      const worker = await workers.createWorker(goal)
      sessions.set(goalID, worker)
      goal.workerSessionID = worker.workerSessionID
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

    // Abort worker
    const session = sessions.get(goalID)
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

  return { start, continueTurn, pause, resume, retry, clear }
}
