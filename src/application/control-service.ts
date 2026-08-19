// ─── Application: Control Service ────────────────────────────────────────────
// Receives typed commands from TUI, validates, mutates state, emits events.

import { randomUUID } from "crypto"
import type { Goal, GoalID, GoalConfig } from "../domain/goal"
import { createGoal, canTransition } from "../domain/goal"
import type { GoalRuntimeState } from "../domain/runtime"
import { createRuntimeState, acquireLease, releaseLease } from "../domain/runtime"
import type { LoopCommand, StartGoalCommand } from "../domain/commands"
import type { LoopEvent } from "../domain/events"
import {
  readState,
  writeState,
  appendEvent,
  readEvents,
  type StoreState,
} from "../infrastructure/state-store"

export interface ControlContext {
  directory: string
  sessionID: string
}

export interface ControlResponse {
  ok: boolean
  requestID: string
  message: string
  stateRevision?: number
  errorCode?: string
}

export interface ControlService {
  execute(ctx: ControlContext, command: LoopCommand): Promise<ControlResponse>
  getState(ctx: ControlContext): Promise<StoreState>
  getEvents(ctx: ControlContext, limit?: number): Promise<Record<string, unknown>[]>
}

export function createControlService(): ControlService {
  // In-memory lock per session to serialize mutations
  const locks = new Map<string, Promise<void>>()

  async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = locks.get(key) || Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((r) => { release = r })
    const next = prev.catch(() => {}).then(() => current)
    locks.set(key, next)
    await prev.catch(() => {})
    try {
      return await fn()
    } finally {
      release()
      if (locks.get(key) === next) locks.delete(key)
    }
  }

  async function execute(
    ctx: ControlContext,
    command: LoopCommand,
  ): Promise<ControlResponse> {
    return withLock(ctx.sessionID, async () => {
      const state = await readState(ctx.directory, ctx.sessionID)
      try {
        switch (command.command) {
          case "start":
            return await handleStart(ctx, state, command)
          case "pause":
            return await handleTransition(ctx, state, command, "paused", "user")
          case "resume":
            return await handleTransition(ctx, state, command, "active", "user")
          case "retry":
            return await handleRetry(ctx, state, command)
          case "clear":
            return await handleClear(ctx, state, command)
          case "update":
            return await handleUpdate(ctx, state, command)
          case "inspect":
            return { ok: true, requestID: command.requestID, message: "inspect not yet implemented" }
          case "open_worker":
            return { ok: true, requestID: command.requestID, message: "open_worker not yet implemented" }
          case "compact":
            return { ok: true, requestID: command.requestID, message: "compact not yet implemented" }
          default: {
            const req = command as { requestID: string; command: string }
            return {
              ok: false,
              requestID: req.requestID,
              message: `unknown command: ${req.command}`,
              errorCode: "unknown_command",
            }
          }
        }
      } finally {
        await writeState(ctx.directory, ctx.sessionID, state)
      }
    })
  }

  async function handleStart(
    ctx: ControlContext,
    state: StoreState,
    cmd: StartGoalCommand,
  ): Promise<ControlResponse> {
    const id = randomUUID() as GoalID

    // Check if a goal with this name already exists
    const existing = state.goals.find(
      (g) => g.name === cmd.args.name && g.status !== "complete" && g.status !== "paused",
    )
    if (existing) {
      return {
        ok: false,
        requestID: cmd.requestID,
        message: `goal "${cmd.args.name}" already exists (${existing.status})`,
        errorCode: "goal_exists",
      }
    }

    const goal = createGoal({
      id,
      name: cmd.args.name,
      objective: cmd.args.objective,
      status: "active",
      ownerSessionID: ctx.sessionID,
      config: cmd.args.config,
    })

    state.goals.push(goal)
    state.runtimes.push(createRuntimeState(id))

    const event: LoopEvent = {
      version: 1,
      eventID: randomUUID(),
      goalID: id,
      type: "goal.created",
      name: cmd.args.name,
      objective: cmd.args.objective,
      timestamp: new Date().toISOString(),
      revision: state.revision,
    }
    await appendEvent(ctx.directory, ctx.sessionID, event)

    return {
      ok: true,
      requestID: cmd.requestID,
      message: `goal "${cmd.args.name}" created and active`,
      stateRevision: state.revision,
    }
  }

  async function handleTransition(
    ctx: ControlContext,
    state: StoreState,
    cmd: { requestID: string; goalID?: GoalID },
    target: "paused" | "active",
    caller: "user" | "model",
  ): Promise<ControlResponse> {
    const goal = findGoal(state, cmd.goalID)
    if (!goal) {
      return {
        ok: false,
        requestID: cmd.requestID,
        message: "goal not found",
        errorCode: "goal_not_found",
      }
    }

    if (!canTransition(goal.status, target, caller)) {
      return {
        ok: false,
        requestID: cmd.requestID,
        message: `cannot transition from ${goal.status} to ${target} (caller: ${caller})`,
        errorCode: "invalid_transition",
      }
    }

    const from = goal.status
    goal.status = target
    goal.updatedAt = new Date().toISOString()

    const event: LoopEvent = {
      version: 1,
      eventID: randomUUID(),
      goalID: goal.id,
      type: "goal.status_changed",
      from,
      to: target,
      timestamp: new Date().toISOString(),
      revision: state.revision,
    }
    await appendEvent(ctx.directory, ctx.sessionID, event)

    return {
      ok: true,
      requestID: cmd.requestID,
      message: `goal "${goal.name}" ${target}`,
      stateRevision: state.revision,
    }
  }

  async function handleRetry(
    ctx: ControlContext,
    state: StoreState,
    cmd: { requestID: string; goalID?: GoalID },
  ): Promise<ControlResponse> {
    const goal = findGoal(state, cmd.goalID)
    if (!goal) {
      return { ok: false, requestID: cmd.requestID, message: "goal not found", errorCode: "goal_not_found" }
    }
    if (goal.status !== "blocked") {
      return { ok: false, requestID: cmd.requestID, message: "can only retry blocked goals", errorCode: "invalid_transition" }
    }

    goal.status = "active"
    goal.updatedAt = new Date().toISOString()

    const runtime = findRuntime(state, goal.id)
    if (runtime) {
      runtime.consecutiveFailures = 0
      runtime.lastError = undefined
      runtime.phase = "idle"
      runtime.updatedAt = new Date().toISOString()
    }

    const event: LoopEvent = {
      version: 1,
      eventID: randomUUID(),
      goalID: goal.id,
      type: "goal.status_changed",
      from: "blocked",
      to: "active",
      timestamp: new Date().toISOString(),
      revision: state.revision,
    }
    await appendEvent(ctx.directory, ctx.sessionID, event)

    return { ok: true, requestID: cmd.requestID, message: `goal "${goal.name}" retried`, stateRevision: state.revision }
  }

  async function handleClear(
    ctx: ControlContext,
    state: StoreState,
    cmd: { requestID: string; goalID?: GoalID },
  ): Promise<ControlResponse> {
    const goal = findGoal(state, cmd.goalID)
    if (!goal) {
      return { ok: false, requestID: cmd.requestID, message: "goal not found", errorCode: "goal_not_found" }
    }

    const event: LoopEvent = {
      version: 1,
      eventID: randomUUID(),
      goalID: goal.id,
      type: "goal.cleared",
      timestamp: new Date().toISOString(),
      revision: state.revision,
    }
    await appendEvent(ctx.directory, ctx.sessionID, event)

    // Remove goal and runtime
    state.goals = state.goals.filter((g) => g.id !== goal.id)
    state.runtimes = state.runtimes.filter((r) => r.goalID !== goal.id)

    return { ok: true, requestID: cmd.requestID, message: `goal "${goal.name}" cleared`, stateRevision: state.revision }
  }

  async function handleUpdate(
    ctx: ControlContext,
    state: StoreState,
    cmd: { requestID: string; goalID?: GoalID; args: { objective?: string; config?: Partial<GoalConfig> } },
  ): Promise<ControlResponse> {
    const goal = findGoal(state, cmd.goalID)
    if (!goal) {
      return { ok: false, requestID: cmd.requestID, message: "goal not found", errorCode: "goal_not_found" }
    }

    if (cmd.args.objective !== undefined) goal.objective = cmd.args.objective
    if (cmd.args.config !== undefined) {
      goal.config = { ...goal.config, ...cmd.args.config }
    }
    goal.updatedAt = new Date().toISOString()

    return { ok: true, requestID: cmd.requestID, message: `goal "${goal.name}" updated`, stateRevision: state.revision }
  }

  function findGoal(state: StoreState, id?: GoalID): Goal | undefined {
    if (id) return state.goals.find((g) => g.id === id)
    // Find the first active or blocked goal
    return state.goals.find((g) => g.status === "active" || g.status === "blocked")
  }

  function findRuntime(state: StoreState, goalID: GoalID): GoalRuntimeState | undefined {
    return state.runtimes.find((r) => r.goalID === goalID)
  }

  async function getState(ctx: ControlContext): Promise<StoreState> {
    return readState(ctx.directory, ctx.sessionID)
  }

  async function getEvents(ctx: ControlContext, limit?: number): Promise<Record<string, unknown>[]> {
    return readEvents(ctx.directory, ctx.sessionID, limit)
  }

  return { execute, getState, getEvents }
}
