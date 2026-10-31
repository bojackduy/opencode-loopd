// ─── Server: Goal Service ────────────────────────────────────────────────────
// Manages goal lifecycle: start, pause, resume, retry, clear.
// Creates worker sessions, drives continuation, handles completion.
// Worker registry is persisted; in-memory map is a cache only.

import { randomUUID } from "crypto"
import type { Goal, GoalID } from "../domain/goal"
import { createGoal, canTransition, isTerminal } from "../domain/goal"
import type { GoalRuntimeState, RunID } from "../domain/runtime"
import { createRuntimeState, acquireLease, releaseLease, leaseIsValid, markProgress } from "../domain/runtime"
import { readState, mutateState, appendEvent, appendGoalInbox, deleteGoalInbox, snapshotGoalInbox, acknowledgeGoalInbox, readEvents, goalArtifactDir, ensureGoalArtifactDir } from "../infrastructure/state-repository"
import * as path from "path"
import { promises as fs } from "fs"
import type { StoreState } from "../infrastructure/state-repository"
import { cancelAwaitsForGoal } from "./command-await"
import type { LoopHost, SessionMessage } from "../server/host-adapter"
import { newPromptMessageID, parseModelRef } from "../server/host-adapter"
import { emptyCatalog, type ModelCatalog } from "../server/model-catalog"
import { emptyAgentCatalog, type AgentCatalog } from "../server/agent-catalog"
import { observeProviderLimit, type ProviderLimitObservation } from "../domain/provider-limit"
import { createWorkerManager, type WorkerManager, type WorkerSession, type ContinuationContext } from "../server/worker-session"
import type { LoopEvent } from "../domain/events"
import { describeError, logServerEvent } from "../infrastructure/server-log"
import { assertScopeAvailable, retireWorker, sweepStaleWorkspaceState, isStaleWorkspaceCall, isSyncStaleWorkspaceCall, reconcileTerminalWorkspaceCalls } from "./workspace-execution"
import { inferNamedFileWriteScope } from "./goal-policy"
import { canonicalGoalCommands } from "../infrastructure/goal-commands"

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

/** A control being accepted is not evidence that its worker is acting. */
export interface GoalActionResult {
  ok: boolean
  outcome: "sent" | "queued" | "not_found" | "invalid_state" | "blocked"
  message: string
  goalID?: GoalID
  workerSessionID?: string
  runGeneration?: number
  promptMessageID?: string
}

/** One durable write reservation, with the ownership a caller needs to judge it. */
export interface WorkspaceReservation {
  callID: string
  sessionID: string
  goalID?: string
  goalName?: string
  goalStatus?: string
  paths: string[]
  uncontrolled?: boolean
  at?: string
  /** This caller owns the reservation's goal, or the goal is gone. */
  releasable: boolean
  /** Why the reservation cannot be released by this caller. */
  reason?: string
}

export interface WorkspaceReservations {
  reservations: WorkspaceReservation[]
  operation?: { id: string; goalID: string; sessionID: string }
}

export interface WorkspaceReleaseResult {
  ok: boolean
  message: string
  released: WorkspaceReservation[]
  remaining: WorkspaceReservations
}

class GoalDeliveryBlockedError extends Error {
  constructor(readonly result: GoalActionResult) { super(result.message) }
}

export interface GoalService {
  readonly scopedExecution: boolean
  switchIdentity(directory: string, goalID: GoalID, ownerSessionID: string, opts: { model?: string; agent?: string; resume?: boolean }): Promise<{ outcome: "applied" | "deferred" | "unsupported"; model?: string; agent?: string; resumed?: boolean }>
  listAgents(): Promise<AgentCatalog>
  switchAgent(directory: string, goalID: GoalID, ownerSessionID: string, agent: string, opts?: { resume?: boolean }): Promise<{ outcome: "applied" | "deferred" | "unsupported"; agent: string; resumed?: boolean }>
  listModels(): Promise<ModelCatalog>
  /** Owner-only; busy/unknown sessions defer without aborting or waking. */
  switchModel(directory: string, goalID: GoalID, ownerSessionID: string, model: string, opts?: { resume?: boolean }): Promise<{ outcome: "applied" | "deferred" | "unsupported"; model: string; resumed?: boolean }>
  observeProviderError(directory: string, goalID: GoalID, error: unknown, source: ProviderLimitObservation["source"], expectedModel?: string): Promise<void>
  compact(directory: string, goalID: GoalID): Promise<void>
  /** Start a goal: create goal + worker session + first continuation. */
  start(directory: string, input: {
    name: string
    objective: string
    ownerSessionID: string
    config?: Goal["config"]
    costBudget?: number
    parentAgent?: string
    parentModel?: string
    /** Manual mode: engine never starts turns (see Goal.interactive). */
    interactive?: boolean
  }): Promise<{ goal: Goal; worker: WorkerSession }>

  /** Drive one continuation turn for a goal. */
  continueTurn(directory: string, goalID: GoalID, opts?: { forceFinish?: boolean; force?: boolean }): Promise<GoalActionResult>

  /** Request a recovery turn only after confirmed idle and quiescence. */
  nudge(directory: string, goalID: GoalID): Promise<GoalActionResult>

  /**
   * Deliver the owner's words as a bare turn: the drained inbox texts become
   * the WHOLE prompt (no steering, history, or verification wrapper) and the
   * turn starts immediately instead of waiting for the next idle boundary.
   * Engine turns are unaffected — they keep building full steering.
   */
  sendUserMessage(directory: string, goalID: GoalID, text: string): Promise<GoalActionResult>

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

  /**
   * Toggle manual/interactive mode. Engine never starts turns for interactive
   * goals; explicit owner actions (:send, nudge, resume, retry) still work.
   */
  setInteractive(directory: string, goalID: GoalID, interactive: boolean): Promise<{ ok: boolean; message: string }>

  /** Pause a goal and abort its worker. */
  pause(directory: string, goalID: GoalID): Promise<void>

  /** Resume a paused goal. */
  resume(directory: string, goalID: GoalID): Promise<GoalActionResult>

  /** Retry a blocked goal. */
  retry(directory: string, goalID: GoalID): Promise<GoalActionResult>

  /** Clear a goal and abort its worker. */
  clear(directory: string, goalID: GoalID): Promise<void>

  /**
   * Every live write reservation in this project, with the ownership a caller
   * needs to judge whether it may be released. Diagnosis never mutates.
   */
  workspaceReservations(directory: string, ownerSessionID: string): Promise<WorkspaceReservations>

  /**
   * Owner escape hatch. Releases reservations the caller owns, or those whose
   * goal no longer exists (nobody can ever release those otherwise), so a
   * leaked fence never requires editing state.json by hand.
   */
  releaseWorkspace(directory: string, ownerSessionID: string, input: { callID?: string; goalID?: string; sessionID?: string }): Promise<WorkspaceReleaseResult>

  /**
   * Owner-only mid-goal grant: append one named approved command to an active
   * goal (same strict validation as creation). Workers can never grant
   * themselves authority. The worker picks it up on its next turn; there is
   * no revoke — clearing the goal removes everything.
   */
  grantApprovedCommand(directory: string, ownerSessionID: string, goalID: string, spec: unknown): Promise<{ ok: boolean; message: string; spec?: import("../domain/goal").ApprovedGoalCommand }>

  /**
   * Owner-only mid-goal grant: widen write_scope by appending exact file paths
   * (same strict validation as creation). Workers can also self-serve via
   * claim_goal_scope, but this lets the owner open scope without worker action.
   * Append-only, no revoke.
   */
  grantWriteScope(directory: string, ownerSessionID: string, goalID: string, paths: unknown): Promise<{ ok: boolean; message: string; write_scope?: string[] }>

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
    if (goal.config.write_scope !== undefined && !host.scopedExecution) throw new Error("Enforced file scopes are unsupported on this host. Use the guarded v2 tool execution surface; v1 retains legacy exclusivity only.")
    assertScopeAvailable(state, goal)
  }

  async function listModels(): Promise<ModelCatalog> {
    return host.listModels ? host.listModels() : emptyCatalog("host catalog capability absent", "unsupported")
  }

  async function listAgents(): Promise<AgentCatalog> {
    return host.listAgents ? host.listAgents() : emptyAgentCatalog("host agent catalog capability absent", "unsupported")
  }

  async function validateAgent(value: string) {
    const agent = value.trim()
    if (!agent) throw new Error("Agent name is required.")
    const catalog = await listAgents()
    if (catalog.capability === "supported" && !catalog.agents.some((a) => a.name === agent)) {
      throw new Error("Agent is unavailable. Discover agents with loopd_list_models first.")
    }
    return { agent, catalog }
  }

  async function applyAgent(directory: string, goal: Goal, agent: string, persist = true) {
    if (!goal.workerSessionID || !host.switchSessionAgent) return "unsupported" as const
    const previousAgent = goal.config.agent ?? (await host.readSession(goal.workerSessionID))?.agent
    const outcome = await host.switchSessionAgent(goal.workerSessionID, agent)
    if (outcome === "unsupported") return outcome
    if (!persist) return outcome
    try {
      await mutateState(directory, `goal.agent-switch:${goal.id}`, async (s) => {
        const current = s.goals.find((g) => g.id === goal.id)
        if (!current) throw new Error("Goal removed during agent switch.")
        current.config.agent = agent
        current.agentSwitch = { pending: undefined, lastFailure: undefined, last: { from: goal.config.agent, to: agent, at: new Date().toISOString(), outcome } }
        current.updatedAt = new Date().toISOString()
        return s
      })
    } catch (error) {
      if (outcome === "applied") {
        if (!previousAgent) throw new Error("Host accepted agent switch but persistence failed; previous host agent unknown, rollback unavailable.")
        await host.switchSessionAgent(goal.workerSessionID, previousAgent)
      }
      throw error
    }
    await logServerEvent(directory, "goal.agent-switched", { goalID: goal.id, workerSessionID: goal.workerSessionID, from: goal.config.agent, to: agent, outcome })
    return outcome
  }

  function switchAgent(directory: string, goalID: GoalID, ownerSessionID: string, value: string, opts?: { resume?: boolean }) {
    return withGoalOperation(goalID, () => switchAgentUnlocked(directory, goalID, ownerSessionID, value, opts))
  }

  async function switchAgentUnlocked(directory: string, goalID: GoalID, ownerSessionID: string, value: string, opts?: { resume?: boolean; persist?: boolean }) {
      const state = await readState(directory)
      const goal = state.goals.find((g) => g.id === goalID)
      if (!goal || !ownerSessionID || goal.ownerSessionID !== ownerSessionID) throw new Error("Goal not found or not owned by this session.")
      if (goal.status === "complete") throw new Error("Cannot switch a completed goal.")
      if (opts?.resume && goal.status !== "blocked") throw new Error("resume is only valid for a blocked goal.")
      if (opts?.resume && goal.config.write_scope !== undefined) throw new Error("Scoped identity-resume is unsupported. Use resume_goal to reacquire and fence the session, then switch identity.")
      if (opts?.resume) assertWorkspaceWriteAvailable(state, goal, ownerSessionID)
      const { agent, catalog } = await validateAgent(value)
      if (catalog.capability !== "supported" || catalog.switching === "unsupported" || !host.switchSessionAgent || !goal.workerSessionID) {
        return { outcome: "unsupported" as const, agent }
      }
      const runtime = state.runtimes.find((r) => r.goalID === goalID)
      if (await host.sessionStatus(goal.workerSessionID) !== "idle" || (runtime?.phase === "running" && leaseIsValid(runtime))) {
        if (opts?.persist === false) throw new Error("Worker became busy during identity switch.")
        await mutateState(directory, `goal.agent-deferred:${goalID}`, async (s) => {
          const current = s.goals.find((g) => g.id === goalID)
          if (current) {
            current.agentSwitch = { ...current.agentSwitch, pending: { agent, requestedAt: new Date().toISOString() } }
            current.updatedAt = new Date().toISOString()
          }
          return s
        })
        return { outcome: "deferred" as const, agent }
      }
      const applied = await applyAgent(directory, goal, agent, opts?.persist !== false)
      if (opts?.resume && applied !== "unsupported") {
        await mutateState(directory, `goal.agent-resume:${goalID}`, async (s) => {
          const current = s.goals.find((g) => g.id === goalID)
          if (current?.status === "blocked") {
            assertWorkspaceWriteAvailable(s, current, ownerSessionID)
            current.status = "active"
            current.blocker = undefined
            current.updatedAt = new Date().toISOString()
          }
          return s
        })
        await continueTurnUnlocked(directory, goalID)
      }
      return { outcome: applied === "next-prompt" ? "deferred" as const : applied, agent, ...(opts?.resume && applied !== "unsupported" ? { resumed: true } : {}) }
  }

  async function applyPendingAgent(directory: string, goal: Goal): Promise<void> {
    const pending = goal.agentSwitch?.pending
    if (!pending) return
    let reason: "host-rejected" | "catalog-unavailable" = "catalog-unavailable"
    try {
      const { catalog } = await validateAgent(pending.agent)
      if (catalog.capability !== "supported" || catalog.switching === "unsupported") throw new Error("Agent catalog unavailable.")
      reason = "host-rejected"
      if (await applyAgent(directory, goal, pending.agent) === "unsupported") throw new Error("Agent switching unsupported.")
    } catch {
      await mutateState(directory, `goal.agent-switch-failed:${goal.id}`, async (s) => {
        const current = s.goals.find((g) => g.id === goal.id)
        const runtime = s.runtimes.find((r) => r.goalID === goal.id)
        if (current) {
          current.agentSwitch = { ...current.agentSwitch, pending: undefined, lastFailure: { at: new Date().toISOString(), reason } }
          if (current.status === "active") {
            current.status = "blocked"
            current.blocker = { reason: "Pending agent switch was not accepted.", needed: "Discover agents, switch the same goal explicitly, then retry when safe.", at: new Date().toISOString() }
          }
          current.updatedAt = new Date().toISOString()
        }
        if (runtime) { Object.assign(runtime, releaseLease(runtime)); runtime.retryAfter = undefined }
        return s
      })
      throw new Error("Pending agent switch was not accepted; goal blocked without replacing its worker.")
    }
  }

  async function validateModel(value: string): Promise<{ model: string; catalog: ModelCatalog }> {
    const ref = parseModelRef(value)
    if (!ref) throw new Error("Model is required: providerID/modelID.")
    const model = `${ref.providerID}/${ref.modelID}`
    const catalog = await listModels()
    if (catalog.capability !== "supported" || catalog.switching === "unsupported" || !host.switchSessionModel) {
      return { model, catalog }
    }
    if (!catalog.models.some((m) => m.providerID === ref.providerID && m.modelID === ref.modelID && m.usable === true)) {
      throw new Error("Model is unavailable or not positively known usable. Discover models with loopd_list_models first.")
    }
    return { model, catalog }
  }

  async function applyModel(directory: string, goal: Goal, model: string, reason: "owner" | "quota", persist = true) {
    if (!goal.workerSessionID || !host.switchSessionModel) return "unsupported" as const
    const previousModel = parseModelRef(goal.config.model) ?? (await host.readSession(goal.workerSessionID))?.model
    const outcome = await host.switchSessionModel(goal.workerSessionID, parseModelRef(model)!)
    if (outcome === "unsupported") return outcome
    if (!persist) return outcome
    try {
      await mutateState(directory, `goal.model-switch:${goal.id}`, async (s) => {
        const current = s.goals.find((g) => g.id === goal.id)
        if (!current) throw new Error("Goal removed during model switch.")
        current.config.model = model
        current.modelSwitch = {
          ...current.modelSwitch, pending: undefined, lastFailure: undefined,
          last: { from: goal.config.model, to: model, at: new Date().toISOString(), outcome, reason },
        }
        current.updatedAt = new Date().toISOString()
        return s
      })
    } catch (error) {
      // Restore host identity if persistence fails after a session-level switch.
      // If there was no explicit assignment, restore the pre-switch live model.
      if (outcome === "applied") {
        if (!previousModel) throw new Error("Host accepted model switch but persistence failed; previous host model unknown, rollback unavailable.")
        await host.switchSessionModel(goal.workerSessionID, previousModel)
      }
      throw error
    }
    await logServerEvent(directory, "goal.model-switched", { goalID: goal.id, workerSessionID: goal.workerSessionID, from: goal.config.model, to: model, reason, outcome })
    return outcome
  }

  function switchModel(directory: string, goalID: GoalID, ownerSessionID: string, value: string, opts?: { resume?: boolean }) {
    return withGoalOperation(goalID, () => switchModelUnlocked(directory, goalID, ownerSessionID, value, opts))
  }

  async function switchModelUnlocked(directory: string, goalID: GoalID, ownerSessionID: string, value: string, opts?: { resume?: boolean; persist?: boolean }) {
      const state = await readState(directory)
      const goal = state.goals.find((g) => g.id === goalID)
      if (!goal || !ownerSessionID || goal.ownerSessionID !== ownerSessionID) throw new Error("Goal not found or not owned by this session.")
      if (goal.status === "complete") throw new Error("Cannot switch a completed goal.")
      if (opts?.resume && (goal.status !== "blocked" || goal.blocker?.kind !== "provider-limit")) {
        throw new Error("resume is only valid for a provider-limit-blocked goal.")
      }
      if (opts?.resume && goal.config.write_scope !== undefined) throw new Error("Scoped identity-resume is unsupported. Use resume_goal to reacquire and fence the session, then switch identity.")
      if (opts?.resume) assertWorkspaceWriteAvailable(state, goal, ownerSessionID)
      const { model, catalog } = await validateModel(value)
      if (catalog.capability !== "supported" || catalog.switching === "unsupported" || !host.switchSessionModel || !goal.workerSessionID) {
        return { outcome: "unsupported" as const, model }
      }
      const runtime = state.runtimes.find((r) => r.goalID === goalID)
      const status = await host.sessionStatus(goal.workerSessionID)
      if (status !== "idle" || (runtime?.phase === "running" && leaseIsValid(runtime))) {
        if (opts?.persist === false) throw new Error("Worker became busy during identity switch.")
        await mutateState(directory, `goal.model-deferred:${goalID}`, async (s) => {
          const current = s.goals.find((g) => g.id === goalID)
          if (current) {
            current.modelSwitch = { ...current.modelSwitch, pending: { model, requestedAt: new Date().toISOString(), reason: "owner" } }
            current.updatedAt = new Date().toISOString()
          }
          return s
        })
        return { outcome: "deferred" as const, model }
      }
      const applied = await applyModel(directory, goal, model, "owner", opts?.persist !== false)
      if (opts?.resume && applied !== "unsupported") {
        await mutateState(directory, `goal.model-resume:${goalID}`, async (s) => {
          const g = s.goals.find((g) => g.id === goalID)
          if (g?.status === "blocked" && g.blocker?.kind === "provider-limit") {
            assertWorkspaceWriteAvailable(s, g, ownerSessionID)
            g.status = "active"
            g.blocker = undefined
            g.updatedAt = new Date().toISOString()
          }
          return s
        })
        // Explicit resume is an owner turn, including for interactive goals.
        // No rejection/turn/cost counters are reset by switching.
        await continueTurnUnlocked(directory, goalID)
      }
      return { outcome: applied === "next-prompt" ? "deferred" as const : applied, model, ...(opts?.resume && applied !== "unsupported" ? { resumed: true } : {}) }
  }

  function switchIdentity(directory: string, goalID: GoalID, ownerSessionID: string, opts: { model?: string; agent?: string; resume?: boolean }) {
    return withGoalOperation(goalID, () => switchIdentityUnlocked(directory, goalID, ownerSessionID, opts))
  }

  async function switchIdentityUnlocked(directory: string, goalID: GoalID, ownerSessionID: string, opts: { model?: string; agent?: string; resume?: boolean }) {
    if (opts.model === undefined && opts.agent === undefined) throw new Error("At least one of model or agent is required.")
    const pending = (await readState(directory)).goals.find((g) => g.id === goalID)?.pendingIdentity
    if (pending) opts = { model: opts.model ?? pending.model, agent: opts.agent ?? pending.agent, resume: opts.resume }
    if (opts.agent === undefined) return switchModelUnlocked(directory, goalID, ownerSessionID, opts.model!, opts)
    if (opts.model === undefined) return switchAgentUnlocked(directory, goalID, ownerSessionID, opts.agent, opts)
    const state = await readState(directory)
    const goal = state.goals.find((g) => g.id === goalID)
    if (!goal || !ownerSessionID || goal.ownerSessionID !== ownerSessionID) throw new Error("Goal not found or not owned by this session.")
    if (goal.status === "complete") throw new Error("Cannot switch a completed goal.")
    if (opts.resume && goal.status !== "blocked") throw new Error("resume is only valid for a blocked goal.")
    if (opts.resume && goal.config.write_scope !== undefined) throw new Error("Scoped identity-resume is unsupported. Use resume_goal to reacquire and fence the session, then switch identity.")
    if (opts.resume) assertWorkspaceWriteAvailable(state, goal, ownerSessionID)
    const { model, catalog: models } = await validateModel(opts.model)
    const { agent, catalog: agents } = await validateAgent(opts.agent)
    if (models.capability !== "supported" || models.switching === "unsupported" || agents.capability !== "supported" || agents.switching === "unsupported" || !host.switchSessionModel || !host.switchSessionAgent || !goal.workerSessionID) {
      return { outcome: "unsupported" as const, model, agent }
    }
    const runtime = state.runtimes.find((r) => r.goalID === goalID)
    if (await host.sessionStatus(goal.workerSessionID) !== "idle" || (runtime?.phase === "running" && leaseIsValid(runtime))) {
      await mutateState(directory, `goal.identity-deferred:${goalID}`, async (s) => {
        const current = s.goals.find((g) => g.id === goalID)!
        current.pendingIdentity = { model, agent }
        current.modelSwitch = { ...current.modelSwitch, pending: undefined }
        current.agentSwitch = { ...current.agentSwitch, pending: undefined }
        current.updatedAt = new Date().toISOString()
        return s
      })
      return { outcome: "deferred" as const, model, agent }
    }
    const live = await host.readSession(goal.workerSessionID)
    const previousModel = parseModelRef(goal.config.model) ?? live?.model
    const previousAgent = goal.config.agent ?? live?.agent
    if (!previousModel || !previousAgent) throw new Error("Combined switch requires a known previous identity for rollback.")
    let modelChanged = false
    let agentChanged = false
    let outcome: "applied" | "deferred" = "applied"
    try {
      const changedModel = await switchModelUnlocked(directory, goalID, ownerSessionID, model, { persist: false })
      if (changedModel.outcome === "unsupported") return { outcome: "unsupported" as const, model, agent }
      modelChanged = true
      const changedAgent = await switchAgentUnlocked(directory, goalID, ownerSessionID, agent, { persist: false })
      if (changedAgent.outcome === "unsupported") throw new Error("Agent switch unsupported after model switch.")
      agentChanged = true
      if (changedModel.outcome === "deferred" || changedAgent.outcome === "deferred") outcome = "deferred"
      await mutateState(directory, `goal.identity-switched:${goalID}`, async (s) => {
        const current = s.goals.find((g) => g.id === goalID)!
        const at = new Date().toISOString()
        current.config.model = model
        current.config.agent = agent
        current.modelSwitch = { ...current.modelSwitch, pending: undefined, lastFailure: undefined, last: { from: goal.config.model, to: model, at, outcome: changedModel.outcome === "deferred" ? "next-prompt" : "applied", reason: "owner" } }
        current.agentSwitch = { pending: undefined, lastFailure: undefined, last: { from: goal.config.agent, to: agent, at, outcome: changedAgent.outcome === "deferred" ? "next-prompt" : "applied" } }
        current.pendingIdentity = undefined
        current.updatedAt = at
        return s
      })
    } catch (error) {
      // Persisted assignments stay unchanged on failure. Restore accepted host
      // changes, including next-prompt hosts, without an intervening prompt.
      const rollbacks = await Promise.allSettled([
        ...(agentChanged ? [host.switchSessionAgent(goal.workerSessionID, previousAgent)] : []),
        ...(modelChanged ? [host.switchSessionModel(goal.workerSessionID, previousModel)] : []),
      ])
      if (rollbacks.some((result) => result.status === "rejected" || result.value === "unsupported")) {
        throw new Error("Identity switch failed and host rollback failed; inspect the existing session before retrying.")
      }
      throw error
    }
    if (opts.resume) {
      await mutateState(directory, `goal.identity-resume:${goalID}`, async (s) => {
        const current = s.goals.find((g) => g.id === goalID)!
        assertWorkspaceWriteAvailable(s, current, ownerSessionID)
        current.status = "active"
        current.blocker = undefined
        current.updatedAt = new Date().toISOString()
        return s
      })
      await continueTurnUnlocked(directory, goalID)
    }
    return { outcome, model, agent, ...(opts.resume ? { resumed: true } : {}) }
  }

  async function applyPendingIdentity(directory: string, goal: Goal) {
    if (!goal.pendingIdentity) return
    try {
      const result = await switchIdentityUnlocked(directory, goal.id, goal.ownerSessionID!, goal.pendingIdentity)
      if (result.outcome === "unsupported") throw new Error("Identity switching unsupported.")
    } catch {
      await mutateState(directory, `goal.identity-switch-failed:${goal.id}`, async (s) => {
        const current = s.goals.find((g) => g.id === goal.id)!
        current.pendingIdentity = undefined
        if (current.status === "active") {
          current.status = "blocked"
          current.blocker = { reason: "Pending identity switch was not accepted.", needed: "Inspect the existing session, switch identity explicitly, then retry when safe.", at: new Date().toISOString() }
        }
        const runtime = s.runtimes.find((r) => r.goalID === goal.id)
        if (runtime) { Object.assign(runtime, releaseLease(runtime)); runtime.retryAfter = undefined }
        return s
      })
      throw new Error("Pending identity switch was not accepted; goal blocked without replacing its worker.")
    }
  }

  async function applyPendingModel(directory: string, goal: Goal): Promise<void> {
    const pending = goal.modelSwitch?.pending
    if (!pending) return
    let reason: "host-rejected" | "catalog-unavailable" = "catalog-unavailable"
    try {
      const { catalog } = await validateModel(pending.model)
      if (catalog.capability !== "supported" || catalog.switching === "unsupported") throw new Error("Pending model switch catalog unavailable.")
      reason = "host-rejected"
      const result = await applyModel(directory, goal, pending.model, pending.reason)
      if (result === "unsupported") throw new Error("Pending model switching unsupported by host.")
    } catch {
      // Stop rather than maintenance-retrying an unaccepted identity forever.
      // Raw provider rejection may contain request secrets: persist only a tag.
      await mutateState(directory, `goal.model-switch-failed:${goal.id}`, async (s) => {
        const g = s.goals.find((g) => g.id === goal.id)
        const rt = s.runtimes.find((r) => r.goalID === goal.id)
        if (g) {
          g.modelSwitch = { ...g.modelSwitch, pending: undefined, lastFailure: { at: new Date().toISOString(), reason } }
          if (g.status === "active") {
            g.status = "blocked"
            g.blocker = { reason: "Pending model switch was not accepted.", needed: "Discover available models, switch the same goal explicitly, then retry when safe.", at: new Date().toISOString() }
          }
          g.updatedAt = new Date().toISOString()
        }
        if (rt) { Object.assign(rt, releaseLease(rt)); rt.retryAfter = undefined }
        return s
      })
      throw new Error("Pending model switch was not accepted; goal blocked without replacing its worker.")
    }
  }

  async function observeProviderErrorUnlocked(directory: string, goalID: GoalID, error: unknown, source: ProviderLimitObservation["source"], expectedModel?: string) {
    const state = await readState(directory)
    const goal = state.goals.find((g) => g.id === goalID)
    if (!goal) return
    const observation = observeProviderLimit(error, source, expectedModel ?? goal.config.model)
    if (!observation) return
    const fallbackModels = goal.config.fallbackModels ?? []
    const attempted = new Set(goal.modelFallback?.attempted ?? [])
    if (goal.config.model) attempted.add(goal.config.model)
    let pending: { model: string; requestedAt: string; reason: "quota" } | undefined
    let status: NonNullable<Goal["modelFallback"]>["status"] = "disabled"
    // A late event must not override a user pause or a manual pending switch.
    const runtime = state.runtimes.find((r) => r.goalID === goalID)
    const quotaBlocked = goal.status === "blocked" && runtime?.lastError === describeError(error)
    const sameModel = expectedModel === undefined || expectedModel === goal.config.model
    const eligible = sameModel && !goal.pendingIdentity && (goal.status === "active" || quotaBlocked) && (!goal.modelSwitch?.pending || goal.modelSwitch.pending.reason === "quota")
    if (eligible && goal.modelSwitch?.pending?.reason === "quota") {
      pending = { ...goal.modelSwitch.pending, reason: "quota" }
      status = "prepared"
    } else if (eligible && fallbackModels.length) {
      const catalog = await listModels()
      if (catalog.capability === "unsupported" || catalog.switching === "unsupported" || !host.switchSessionModel) status = "unsupported"
      else if (catalog.capability !== "supported") status = "unavailable"
      else {
        status = "exhausted"
        for (const value of fallbackModels) {
          if (attempted.has(value)) continue
          attempted.add(value)
          const ref = parseModelRef(value)
          if (ref && catalog.models.some((m) => m.providerID === ref.providerID && m.modelID === ref.modelID && m.usable === true)) {
            pending = { model: value, requestedAt: new Date().toISOString(), reason: "quota" }
            status = "prepared"
            break
          }
        }
      }
    }
    await mutateState(directory, `goal.provider-limit:${goalID}`, async (s) => {
      const g = s.goals.find((g) => g.id === goalID)
      const rt = s.runtimes.find((r) => r.goalID === goalID)
      if (!g) return s
      g.lastProviderLimit = observation
      if (sameModel && g.status === "blocked" && g.blocker && rt?.lastError === describeError(error)) g.blocker.kind = "provider-limit"
      if (eligible) {
        g.modelFallback = { attempted: [...attempted], status }
        if (pending && (!g.modelSwitch?.pending || g.modelSwitch.pending.reason === "quota")) {
          g.modelSwitch = { ...g.modelSwitch, pending }
        }
      }
      if (rt?.phase === "waiting_retry" && observation.retryAt && Date.parse(observation.retryAt) > Date.parse(rt.retryAfter ?? "")) rt.retryAfter = observation.retryAt
      g.updatedAt = new Date().toISOString()
      return s
    })
    await logServerEvent(directory, "goal.provider-limit", { goalID, model: goal.config.model, kind: observation.kind, source, fallbackStatus: status, to: pending?.model })
  }

  function observeProviderError(directory: string, goalID: GoalID, error: unknown, source: ProviderLimitObservation["source"], expectedModel?: string) {
    return withGoalOperation(goalID, () => observeProviderErrorUnlocked(directory, goalID, error, source, expectedModel))
  }

  function compact(directory: string, goalID: GoalID) {
    return withGoalOperation(goalID, async () => {
      const state = await readState(directory)
      const goal = state.goals.find((g) => g.id === goalID)
      if (!goal?.workerSessionID || goal.status !== "active") return
      if (await host.sessionStatus(goal.workerSessionID) !== "idle") return
      await applyPendingIdentity(directory, goal)
      await applyPendingModel(directory, goal)
      await applyPendingAgent(directory, goal)
      const fresh = (await readState(directory)).goals.find((g) => g.id === goalID)
      if (fresh?.workerSessionID) await host.compactSession(fresh.workerSessionID, parseModelRef(fresh.config.model))
    })
  }

  async function recordPromptFailure(
    directory: string,
    goalID: GoalID,
    error: unknown,
    blockImmediately = false,
    expectedRunID?: string,
  ): Promise<void> {
    const detail = describeError(error)
    let runID: string = "unknown"
    let failureCount = 0
    let blocked = false
    let superseded = false
    let blockerNeeded = "Retry after the OpenCode worker/session API is available."
    const state = await mutateState(directory, `turn.prompt-failed:${goalID}`, async (s) => {
      const goal = s.goals.find((item) => item.id === goalID)
      const rt = s.runtimes.find((item) => item.goalID === goalID)
      if (!goal || !rt) return s

      // Generation fence: only the turn that still owns the lease records the
      // failure. A superseded turn (a retry/nudge already acquired a newer
      // run while this dispatch was in flight) must not release the newer
      // lease or consume its failure budget — that is how a late error killed
      // a healthy replacement turn.
      if (expectedRunID !== undefined && rt.activeRunID !== expectedRunID) {
        superseded = true
        return s
      }
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

    if (superseded) {
      // The lease already belongs to a newer run: leave it (and its failure
      // budget) alone. Quota classification is still recorded — a 429 observed
      // here must inform the CURRENT run's fallback logic too.
      await logServerEvent(directory, "turn.prompt-failed-superseded", { goalID, expectedRunID }).catch(() => {})
      await observeProviderErrorUnlocked(directory, goalID, error, "prompt-delivery")
      return
    }

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
    await observeProviderErrorUnlocked(directory, goalID, error, "prompt-delivery")
  }

  /**
   * Quota hold for nudge: a provider 429/rate-limit/quota is distinct from a
   * host timeout — re-prompting the same model burns quota without helping.
   * Returns an actionable message while the provider's own retry time is still
   * in the future; undefined otherwise (nudge proceeds). Scoped to the
   * currently configured model: a switch already applied clears the hold.
   */
  function quotaHoldMessage(goal: Goal): string | undefined {
    const observation = goal.lastProviderLimit
    const retryMs = observation?.retryAt ? Date.parse(observation.retryAt) : NaN
    if (!observation || !Number.isFinite(retryMs) || retryMs <= Date.now()) return undefined
    if (observation.model && observation.model !== goal.config.model) return undefined
    const kind = observation.kind === "quota" ? "quota exhausted" : "rate-limited"
    const pending = goal.modelSwitch?.pending?.reason === "quota"
      ? ` A quota fallback to "${goal.modelSwitch.pending.model}" is prepared and applies on the next idle turn.`
      : ""
    return `Model "${goal.config.model ?? "default"}" is provider-${kind} ` +
      `(observed ${observation.observedAt}; provider says retry after ${observation.retryAt}).` +
      `${pending} Not re-prompting: nudging a limited model burns quota without helping. ` +
      `Wait for the retry time, switch model, or use retry_goal afterwards.`
  }

  /**
   * Late-acceptance check: did the prompt land in the worker transcript
   * despite the dispatch error/timeout? A lost acceptance race never cancels
   * the enqueue, so a retry must verify first — re-prompting an accepted
   * prompt double-dispatches into the worker session. Best-effort and
   * bounded; "not found" falls back to recording the failure (current
   * behavior, safe direction).
   */
  async function wasPromptAccepted(
    directory: string,
    workerSessionID: string,
    promptMessageID?: string,
  ): Promise<boolean> {
    if (!promptMessageID) return false
    try {
      const tail = await withStageTimeout(
        host.readMessages(workerSessionID, 10),
        PROMPT_VERIFY_TIMEOUT_MS,
        `late prompt-acceptance verify for session "${workerSessionID}"`,
      )
      const found = tail.some((m) => m.messageID === promptMessageID || m.parentMessageID === promptMessageID)
      if (found) {
        await logServerEvent(directory, "worker.prompted-late", { workerSessionID, promptMessageID }).catch(() => {})
      }
      return found
    } catch {
      return false
    }
  }

  /**
   * Dispatch a turn prompt; on dispatch error verify late acceptance before
   * recording a failure. Returns normally when the prompt was accepted (the
   * lease stays held — the engine observes completion via status/events);
   * throws only for genuine delivery failures (after a fenced
   * recordPromptFailure tied to THIS run).
   */
  async function dispatchOrRecordFailure(
    directory: string,
    goalID: GoalID,
    dispatch: () => Promise<unknown>,
    run: { activeRunID?: string; activePromptMessageID?: string; runGeneration?: number; forceFinish?: boolean },
    workerSessionID: string,
    blockImmediately = false,
  ): Promise<boolean> {
    let blocked: GoalActionResult | undefined
    await mutateState(directory, `turn.dispatch-intent:${goalID}`, async (s) => {
      blocked = continuationGuard(s, goalID)
      const g = s.goals.find((item) => item.id === goalID)
      const rt = s.runtimes.find((item) => item.goalID === goalID)
      const ownsRun = rt && g?.workerSessionID === workerSessionID && rt.activeRunID === run.activeRunID && rt.activePromptMessageID === run.activePromptMessageID && (run.runGeneration === undefined || rt.runGeneration === run.runGeneration)
      if (!ownsRun) blocked ??= rejected(goalID, "blocked", "Run or worker was superseded before dispatch; no prompt was sent.")
      if (blocked) {
        if (ownsRun) {
          Object.assign(rt, releaseLease(rt))
          rt.activeRunID = undefined
        }
      } else if (rt) {
        rt.activePromptDispatchAt = new Date().toISOString()
      }
      return s
    })
    if (blocked) {
      if (blocked.outcome === "not_found") sessions.delete(goalID)
      throw new GoalDeliveryBlockedError(blocked)
    }
    let observed = false
    try {
      await dispatch()
      observed = await wasPromptAccepted(directory, workerSessionID, run.activePromptMessageID)
    } catch (error) {
      const current = await readState(directory)
      if (!current.goals.some((goal) => goal.id === goalID)) {
        throw new GoalDeliveryBlockedError(rejected(goalID, "not_found", "Goal cleared while host delivery was pending. Its late result was ignored; list current goals instead of retrying this ID."))
      }
      observed = await wasPromptAccepted(directory, workerSessionID, run.activePromptMessageID)
      if (!observed) {
        await recordPromptFailure(directory, goalID, error, blockImmediately, run.activeRunID)
        throw error
      }
    }
    let removed = false
    let acceptedRun = false
    const accepted = await mutateState(directory, `turn.dispatch-accepted:${goalID}`, async (s) => {
      const g = s.goals.find((item) => item.id === goalID)
      removed = !g
      const rt = s.runtimes.find((item) => item.goalID === goalID)
      if (rt && g?.status === "active" && g.workerSessionID === workerSessionID && rt.activeRunID === run.activeRunID && rt.activePromptMessageID === run.activePromptMessageID && (run.runGeneration === undefined || rt.runGeneration === run.runGeneration)) {
        acceptedRun = true
        rt.activePromptAcceptedAt = new Date().toISOString()
        if (run.forceFinish) rt.forceFinishRequested = true
        if (observed) rt.activePromptObservedAt ??= rt.activePromptAcceptedAt
      }
      return s
    })
    if (removed) throw new GoalDeliveryBlockedError(rejected(goalID, "not_found", "Goal cleared while host delivery was pending. Its late result was ignored; list current goals instead of retrying this ID."))
    if (!acceptedRun) throw new GoalDeliveryBlockedError(rejected(goalID, "blocked", "The turn or worker changed while host delivery was pending. Its late result was ignored; inspect the current run before retrying."))
    const rt = accepted.runtimes.find((item) => item.goalID === goalID)
    if (rt && rt.activeRunID === run.activeRunID && rt.activePromptAcceptedAt) {
      await acknowledgeGoalInbox(directory, goalID, rt.activeInboxLines ?? [])
    }
    return observed
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

    session = await workers.createWorker(goal, directory)
    let linked = false
    let failure: GoalActionResult | undefined
    await mutateState(directory, `goal.set-worker:${goal.id}`, async (s) => {
      const persisted = s.goals.find((item) => item.id === goal.id)
      if (!persisted) failure = rejected(goal.id, "not_found", "Goal cleared during worker creation; the new worker was retired. List your goals instead of retrying this ID.")
      else if (persisted.ownerSessionID !== goal.ownerSessionID || persisted.workerSessionID !== goal.workerSessionID || persisted.status !== "active") {
        failure = rejected(goal.id, "blocked", "Goal changed during worker creation; the unused worker was retired. Inspect current state before retrying.")
      } else {
        persisted.workerSessionID = session!.workerSessionID
        linked = true
        if (session!.topology) {
          persisted.workerTopology = session!.topology
          persisted.nativeParentID = session!.nativeParentID
        }
      }
      if (!linked) retireWorker(s, { ...goal, workerSessionID: session!.workerSessionID })
      return s
    })
    if (!linked) {
      sessions.delete(goal.id)
      await workers.abortWorker(session.workerSessionID).catch(() => {})
      throw new GoalDeliveryBlockedError(failure!)
    }
    sessions.set(goal.id, session)
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
    interactive?: boolean
  }, id: GoalID) {
    if (input.config?.approvedCommands !== undefined) {
      input.config = { ...input.config, approvedCommands: await canonicalGoalCommands(directory, input.config.approvedCommands) }
    }
    // Prefer enforceable, disjoint file ownership when the user explicitly
    // names files. Do not silently enable scopes on the legacy host.
    if (host.scopedExecution && input.config?.workspaceWrite !== false && input.config?.write_scope === undefined) {
      const inferred = inferNamedFileWriteScope(input.objective, directory)
      if (inferred) input.config = { ...input.config, write_scope: inferred }
    }
    // Reject malformed/unavailable alternatives before any worker or goal exists.
    if (input.config?.write_scope !== undefined && !host.scopedExecution) throw new Error("Enforced file scopes are unsupported on this host. Use the guarded v2 tool execution surface; v1 retains legacy exclusivity only.")
    if (input.config?.fallbackModels?.length) {
      if (input.config.fallbackModels.length > 16) throw new Error("At most 16 ordered fallback models are allowed.")
      const catalog = await listModels()
      for (const value of input.config.fallbackModels) {
        const ref = parseModelRef(value)
        if (!ref) throw new Error("Fallback model must be providerID/modelID.")
        if (catalog.capability === "supported" && !catalog.models.some((m) => m.providerID === ref.providerID && m.modelID === ref.modelID && m.usable === true)) {
          throw new Error("Fallback model is unavailable or not positively known usable.")
        }
      }
      input.config.fallbackModels = [...new Set(input.config.fallbackModels.map((m) => m.trim()))]
    }
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
    if (goal.config.write_scope !== undefined) {
      if (!Array.isArray(goal.config.write_scope)) throw new Error("write_scope must be an array of exact file paths")
      if (!goal.config.workspaceWrite && goal.config.write_scope.length > 0) {
        throw new Error("Read-only/artifact goals cannot claim shared workspace files.")
      }
      const { canonicalWriteScope } = await import("../infrastructure/workspace-scope")
      goal.config.write_scope = await canonicalWriteScope(directory, goal.config.write_scope)
    }
    if (typeof input.costBudget === "number") goal.costBudget = input.costBudget
    if (input.interactive === true) goal.interactive = true
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
      worker = await workers.createWorker(goal, directory)
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
      if (worker.topology) {
        g.workerTopology = worker.topology
        g.nativeParentID = worker.nativeParentID
        goal.workerTopology = worker.topology
        goal.nativeParentID = worker.nativeParentID
      }
      const rt = state.runtimes.find((item) => item.goalID === id)
      if (rt) {
        Object.assign(rt, acquireLease(rt, g.config.timeoutMs || 300_000))
        if (host.readExecution) { rt.executionSource = "native"; rt.nativeExecutionStatus = "unknown" }
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
        // Verify-before-retry applies here too: a late-accepted startup
        // prompt means the worker IS running — blocking the goal would strand
        // a healthy session. blockImmediately still persists genuinely failed
        // startups as blocked (run-fenced to this startup run).
        await dispatchOrRecordFailure(directory, id, () => workers.continueWorker(worker, goal, runtime), runtime, worker.workerSessionID, true)
      } catch (error) {
        // recordPromptFailure persists the blocked goal AND releases the run
        // lease, so resume can reuse this same worker session afterwards.
        throw new GoalStartError(describeError(error), {
          goalID: id,
          workerSessionID: worker.workerSessionID,
          failedStage: "prompt_delivery",
        })
      }
    }

    void logServerEvent(directory, "goal.created", {
      goalID: id,
      name: goal.name,
      ownerSessionID: goal.ownerSessionID,
      workerSessionID: worker.workerSessionID,
      topology: worker.topology,
    }).catch(() => {})
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

  function rejected(goalID: GoalID, outcome: "not_found" | "invalid_state" | "blocked", message: string): GoalActionResult {
    if (outcome === "not_found") sessions.delete(goalID)
    return { ok: false, outcome, goalID, message }
  }

  function continuationGuard(state: StoreState, goalID: GoalID): GoalActionResult | undefined {
    const goal = state.goals.find((g) => g.id === goalID)
    if (!goal) return rejected(goalID, "not_found", "Goal not found (it may have been cleared). List your goals instead of retrying this ID.")
    if (goal.status !== "active") return rejected(goalID, "invalid_state", `Goal is ${goal.status}; resume or retry it before requesting a turn.`)
    if (goal.config.write_scope !== undefined && !host.scopedExecution) return rejected(goalID, "blocked", "Enforced scopes are unsupported on this host.")
    if (goal.scopeClosing) return rejected(goalID, "blocked", "Goal is closing; wait for in-flight writes to finish before resuming.")
    if ((state.workspaceCalls ?? []).some((call) => call.goalID === goalID && !isSyncStaleWorkspaceCall(state, call, Date.now()))) {
      return rejected(goalID, "blocked", "Goal has in-flight write reservations. Nothing was sent; retry after writes finish.")
    }
    if (state.workspaceOperation) return rejected(goalID, "blocked", `Workspace operation ${state.workspaceOperation.id} is in progress. Nothing was sent; retry after it finishes.`)
    const runtime = state.runtimes.find((r) => r.goalID === goalID)
    if (!runtime) return rejected(goalID, "blocked", "Goal runtime is missing; no turn was sent.")
    if (runtime.activeToolCallIDs?.length) return rejected(goalID, "blocked", "Worker has outstanding tool calls. Nothing was sent; wait for terminal tool evidence.")
  }

  async function continueTurnUnlocked(directory: string, goalID: GoalID, opts?: { forceFinish?: boolean; force?: boolean; bare?: boolean }): Promise<GoalActionResult> {
    await reconcileTerminalWorkspaceCalls(directory, host)
    // Read state for pre-checks (lease validity, worker idle)
    const preState = await readState(directory)
    const goal = preState.goals.find((g) => g.id === goalID)
    const guard = continuationGuard(preState, goalID)
    if (guard) return guard
    if (!goal) return rejected(goalID, "not_found", "Goal not found.")

    const runtime = preState.runtimes.find((r) => r.goalID === goalID)
    if (!runtime) return rejected(goalID, "blocked", "Goal runtime is missing; no turn was sent.")
    if (runtime.activePromptAcceptedAt) await acknowledgeGoalInbox(directory, goalID, runtime.activeInboxLines ?? [])

    // Check lease
    if (runtime.phase === "running" && leaseIsValid(runtime)) return rejected(goalID, "blocked", "An existing turn holds the run lease; no additional prompt was sent.")

    // Get worker from cache or reconstruct from persisted state
    let session = sessions.get(goalID)
    if (session && session.workerSessionID !== goal.workerSessionID) { sessions.delete(goalID); session = undefined }
    if (!session && goal.workerSessionID) {
      session = {
        goalID: goal.id,
        workerSessionID: goal.workerSessionID,
        startedAt: goal.createdAt,
      }
      sessions.set(goalID, session)
    }
    if (!session && !goal.workerSessionID) session = await ensureWorkerSession(directory, goal)
    if (!session) return rejected(goalID, "blocked", "Worker session is missing; resume or retry the goal.")

    // Check worker idle — unless force is set (nudge/re-prompt)
    if (!opts?.force && !(await workers.isIdle(session.workerSessionID))) return rejected(goalID, "blocked", "Worker is busy or its status is unknown; no prompt was sent. Retry after confirmed idle.")

    // Never change a running session even when an explicit nudge bypasses idle.
    // Require confirmed idle for pending identity; nudge never interrupts a live worker.
    if (goal.pendingIdentity || goal.modelSwitch?.pending || goal.agentSwitch?.pending) {
      if (await host.sessionStatus(session.workerSessionID) !== "idle") return rejected(goalID, "blocked", "Pending identity requires an idle worker; no prompt was sent. Wait for idle and retry.")
      await applyPendingIdentity(directory, goal)
      await applyPendingModel(directory, goal)
      await applyPendingAgent(directory, goal)
    }

    // Acquire lease and increment run count atomically
    let acquired = false
    let acquisitionFailure: GoalActionResult | undefined
    const state = await mutateState(directory, `turn.acquire:${goalID}`, async (s) => {
      acquisitionFailure = continuationGuard(s, goalID)
      if (acquisitionFailure) return s
      const g = s.goals.find((item) => item.id === goalID)
      if (!g || g.status !== "active") return s
      const rt = s.runtimes.find((item) => item.goalID === goalID)
      if (!rt) return s
      if (rt.phase === "running" && leaseIsValid(rt)) return s
      const timeoutMs = g.config.timeoutMs || 300_000
      Object.assign(rt, acquireLease(rt, timeoutMs))
      if (host.readExecution) { rt.executionSource = "native"; rt.nativeExecutionStatus = "unknown" }
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
    if (!acquired || !freshGoal || freshGoal.status !== "active" || !freshRuntime?.activeRunID) return acquisitionFailure ?? rejected(goalID, "blocked", "Run lease acquisition lost to another turn; no prompt was sent.")

    const sent: GoalActionResult = {
      ok: true, outcome: "sent", goalID, workerSessionID: session.workerSessionID,
      runGeneration: freshRuntime.runGeneration, promptMessageID: freshRuntime.activePromptMessageID,
      message: `Prompt submitted for "${freshGoal.name}"; worker activity is not yet confirmed.`,
    }

    let dispatchAttempted = false
    try {
    const inbox = await snapshotGoalInbox(directory, goalID)
    const inboxMessages = inbox.messages
    await mutateState(directory, `turn.inbox-snapshot:${goalID}`, async (s) => {
      const rt = s.runtimes.find((r) => r.goalID === goalID)
      if (rt && rt.activeRunID === freshRuntime.activeRunID) rt.activeInboxLines = inbox.lines
      return s
    })
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
      const bareText = inboxMessages.join("\n").trim()
      if (bareText) {
        // Verify-before-retry: a late-accepted bare prompt returns normally
        // (turn dispatched, lease held) instead of failing a healthy turn.
        dispatchAttempted = true
        const observed = await dispatchOrRecordFailure(directory, goalID, () => workers.sendBare(session, freshGoal, freshRuntime, bareText), freshRuntime, session.workerSessionID)
        if (host.readExecution && !observed) return {
          ...sent, outcome: "queued",
          message: `OpenCode accepted prompt ${freshRuntime.activePromptMessageID} into its inbox; delivery and execution are not confirmed. Do not resend while this receipt is pending.`,
        }
        return sent
      }
    }

    // Send continuation with accumulated context (external I/O — not under lock)

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

    // Send continuation with accumulated context (external I/O — not under lock).
    // A late-accepted prompt keeps the lease; only genuine delivery failures
    // throw (after a run-fenced recordPromptFailure).
    dispatchAttempted = true
    const observed = await dispatchOrRecordFailure(directory, goalID, () => workers.continueWorker(session, freshGoal, freshRuntime, context), { ...freshRuntime, forceFinish: opts?.forceFinish }, session.workerSessionID)
    if (host.readExecution && !observed) return {
      ...sent, outcome: "queued",
      message: `OpenCode accepted prompt ${freshRuntime.activePromptMessageID} into its inbox for "${freshGoal.name}"; delivery and execution are not confirmed. No duplicate prompt will be sent while this receipt is pending.`,
    }
    return sent
    } catch (error) {
      if (error instanceof GoalDeliveryBlockedError) return error.result
      if (!dispatchAttempted) await recordPromptFailure(directory, goalID, error, false, freshRuntime.activeRunID)
      throw error
    }
  }

  async function setInteractiveUnlocked(directory: string, goalID: GoalID, interactive: boolean) {
    const state = await mutateState(directory, `goal.interactive:${goalID}`, async (s) => {
      const g = s.goals.find((item) => item.id === goalID)
      if (!g) return s
      if (interactive) g.interactive = true
      else delete g.interactive
      g.updatedAt = new Date().toISOString()
      return s
    })
    const goal = state.goals.find((g) => g.id === goalID)
    if (!goal) return { ok: false, message: "Goal not found." }
    await appendEvent(directory, {
      version: 1,
      eventID: randomUUID(),
      goalID,
      type: "goal.interactive_changed",
      interactive,
      timestamp: new Date().toISOString(),
      revision: state.revision,
    } satisfies LoopEvent).catch(() => {})
    return {
      ok: true,
      message: interactive
        ? `Goal "${goal.name}" is now manual: the engine will not start turns — steer it with :send/nudge.`
        : `Goal "${goal.name}" is back on auto: the engine resumes idle recovery and retries.`,
    }
  }

  function setInteractive(directory: string, goalID: GoalID, interactive: boolean) {
    return withGoalOperation(goalID, () => setInteractiveUnlocked(directory, goalID, interactive))
  }

  async function pauseUnlocked(directory: string, goalID: GoalID) {
    const preState = await readState(directory)
    const goal = preState.goals.find((g) => g.id === goalID)
    if (!goal) return

    if (!canTransition(goal.status, "paused", "user")) return

    // Fence first, abort second, publish the parked status last. Reservations
    // continue retaining ownership even if abort returns before a tool drains.
    if (goal.config.write_scope !== undefined) {
      await mutateState(directory, `goal.pause-closing:${goalID}`, async (s) => {
        const g = s.goals.find((item) => item.id === goalID)
        if (g) { g.scopeClosing = true; retireWorker(s, g) }
        return s
      })
      if (goal.workerSessionID) await workers.abortWorker(goal.workerSessionID)
      sessions.delete(goalID)
    }

    const state = await mutateState(directory, `goal.pause:${goalID}`, async (s) => {
      const g = s.goals.find((item) => item.id === goalID)
      if (!g) return s
      g.status = "paused"
      g.scopeClosing = false
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
    if (session && goal.config.write_scope === undefined) {
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

  /** Bounded race for control-path stages. Rejects on timeout but NEVER cancels
   * the underlying work: a lost race leaves the side effect pending/unknown,
   * which callers must verify (transcript check) rather than blindly retry. */
  async function withStageTimeout<T>(promise: Promise<T>, ms: number, stage: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`${stage} timed out after ${ms}ms`)), ms)
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  const PROBE_TIMEOUT_MS = 15_000
  const PROMPT_VERIFY_TIMEOUT_MS = 12_000

  /**
   * Bounded tri-state worker liveness probe (outside the state lock).
   * "dead" ONLY when there is no worker session ID at all. A timed-out or
   * unreachable probe is "unknown" — never proof of death. Callers fail
   * CLOSED on "unknown" (keep write protection, report actionable stage
   * evidence); only "dead" or "live" drive reap/proceed decisions.
   */
  async function probeWorkerLiveness(workerSessionID?: string): Promise<"live" | "dead" | "unknown"> {
    if (!workerSessionID) return "dead"
    try {
      const status = await withStageTimeout(
        host.sessionStatus(workerSessionID),
        PROBE_TIMEOUT_MS,
        `worker liveness probe for session "${workerSessionID}"`,
      )
      return status === "unknown" ? "unknown" : "live"
    } catch {
      return "unknown"
    }
  }

  async function resumeUnlocked(directory: string, goalID: GoalID) {
    await reconcileTerminalWorkspaceCalls(directory, host)
    // Probe outside the transaction for actionable status, never tool-exit proof.
    const preState = await readState(directory)
    const preGoal = preState.goals.find((g) => g.id === goalID)
    const workerLiveness = await probeWorkerLiveness(preGoal?.workerSessionID)
    let resumed = false
    const state = await mutateState(directory, `goal.resume:${goalID}`, async (state) => {
      const goal = state.goals.find((g) => g.id === goalID)
      if (!goal) return state
      if (!canTransition(goal.status, "active", "user")) return state
      // Heal interrupted goal flags without discarding execution reservations.
      const liveness = { isWorkerLive: (_gid: string, _wsid?: string) => _gid === goalID ? workerLiveness !== "dead" : false, now: Date.now() }
      sweepStaleWorkspaceState(state, liveness)
      const rt = state.runtimes.find((r) => r.goalID === goalID)
      const liveCalls = (state.workspaceCalls ?? []).filter(
        (call) => call.goalID === goalID && !isStaleWorkspaceCall(state, call, liveness),
      )
      const blocking = liveCalls
      if (blocking.length) {
        if (workerLiveness === "unknown") {
          throw new Error(
            `Worker liveness unknown for session "${goal.workerSessionID}" (probe timed out or unreachable); ` +
            `keeping ${blocking.length} write reservation(s) — nothing reaped, nothing rotated. ` +
            `The worker may still be running; wait for actual tool completion/quiescence. Neither age nor a missing session releases execution fences.`,
          )
        }
        throw new Error("Goal still has closing/in-flight writes; ownership cannot be reacquired before quiescence.")
      }
      // Fence first: retire the old worker, rotate generation/session, clear
      // closing flags — all atomically, so no crash window can orphan
      // scopeClosing again. Legacy (unscoped) goals keep their session:
      // scopeClosing is never set for them, so there is nothing to fence.
      // (A later throw aborts this whole transaction, so fencing before the
      // availability check persists nothing on the blocking path.)
      if (goal.config.write_scope !== undefined) {
        retireWorker(state, goal)
        goal.workerSessionID = undefined
        sessions.delete(goalID)
        if (rt) {
          rt.runGeneration += 1
          rt.updatedAt = new Date().toISOString()
        }
      }
      goal.scopeClosing = false
      goal.scopeClearPending = false
      assertWorkspaceWriteAvailable(state, goal, goal.ownerSessionID)
      goal.status = "active"
      goal.updatedAt = new Date().toISOString()
      resumed = true
      return state
    })

    const goal = state.goals.find((g) => g.id === goalID)
    if (!goal) return rejected(goalID, "not_found", "Goal not found (it may have been cleared). List your goals instead of retrying this ID.")

    if (!resumed) return rejected(goalID, "invalid_state", `Cannot resume a ${goal.status} goal; no turn was sent.`)

    // Get or recreate worker (external I/O — not under lock)
    try {
      await ensureWorkerSession(directory, goal)
    } catch (error) {
      if (error instanceof GoalDeliveryBlockedError) return error.result
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
    const result = await continueTurnUnlocked(directory, goalID)
    return result.ok ? { ...result, message: `Goal "${goal.name}" resumed; ${result.message}` } : result
  }

  async function retryUnlocked(directory: string, goalID: GoalID) {
    await reconcileTerminalWorkspaceCalls(directory, host)
    const preState = await readState(directory)
    const workerLiveness = await probeWorkerLiveness(preState.goals.find((g) => g.id === goalID)?.workerSessionID)
    let retried = false
    const state = await mutateState(directory, `goal.retry:${goalID}`, async (state) => {
      const goal = state.goals.find((g) => g.id === goalID)
      if (!goal || goal.status !== "blocked") return state
      // Fail-closed like resume: an "unknown" probe keeps reservations.
      const liveness = { isWorkerLive: (_gid: string, _wsid?: string) => _gid === goalID ? workerLiveness !== "dead" : false, now: Date.now() }
      sweepStaleWorkspaceState(state, liveness)
      const blocking = (state.workspaceCalls ?? []).filter(
        (call) =>
          call.goalID === goalID &&
          !isStaleWorkspaceCall(state, call, liveness),
      )
      if (blocking.length) {
        if (workerLiveness === "unknown") {
          throw new Error(
            `Worker liveness unknown for session "${goal.workerSessionID}" (probe timed out or unreachable); ` +
            `keeping ${blocking.length} write reservation(s) — nothing reaped, nothing rotated. ` +
            `The worker may still be running; wait for actual tool completion/quiescence. Neither age nor a missing session releases execution fences.`,
          )
        }
        throw new Error("Goal still has closing/in-flight writes; ownership cannot be reacquired before quiescence.")
      }
      // Fence first (throw below aborts the transaction, persisting nothing).
      if (goal.config.write_scope !== undefined) {
        retireWorker(state, goal)
        goal.workerSessionID = undefined
        sessions.delete(goalID)
        const rt = state.runtimes.find((r) => r.goalID === goalID)
        if (rt) {
          rt.runGeneration += 1
          rt.updatedAt = new Date().toISOString()
        }
      }
      goal.scopeClosing = false
      goal.scopeClearPending = false
      state.workspaceCalls = (state.workspaceCalls ?? []).filter((call) => call.goalID !== goalID)
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
    if (!goal) return rejected(goalID, "not_found", "Goal not found (it may have been cleared). List your goals instead of retrying this ID.")
    if (!retried) return rejected(goalID, "invalid_state", `Cannot retry a ${goal.status} goal; no turn was sent.`)

    try {
      await ensureWorkerSession(directory, goal)
    } catch (error) {
      if (error instanceof GoalDeliveryBlockedError) return error.result
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

    return continueTurnUnlocked(directory, goalID)
  }

  /**
   * Read-only projection of the fence table. `releasable` is a *ownership*
   * judgement, not a liveness one: a reservation stays unreleasable while its
   * session is still the worker of a non-terminal goal, because that session
   * may legitimately be mid-write.
   */
  function describeReservations(state: StoreState, callerSessionID: string): WorkspaceReservations {
    const liveWorkerSessions = new Set(
      state.goals.filter((goal) => !isTerminal(goal.status) && goal.workerSessionID).map((goal) => goal.workerSessionID!),
    )
    const reservations = (state.workspaceCalls ?? []).map((call) => {
      const goal = state.goals.find((item) => item.id === call.goalID)
      const owned = Boolean(call.goalID && goal?.ownerSessionID === callerSessionID)
      const orphaned = Boolean(call.goalID && !goal)
      // Your own session's reservations are always yours to release: you are
      // the only one who can know the call that opened them is dead. This is
      // the common shape of a leaked fence — the writing session *is* the
      // chat session, and it has no goal to be matched through.
      const ownSession = call.sessionID === callerSessionID
      const liveWorker = liveWorkerSessions.has(call.sessionID)
      const releasable = (owned || orphaned || ownSession) && !liveWorker
      return {
        callID: call.callID,
        sessionID: call.sessionID,
        goalID: call.goalID,
        goalName: goal?.name,
        goalStatus: goal?.status,
        paths: call.paths,
        uncontrolled: call.uncontrolled,
        at: call.at,
        releasable,
        reason: releasable
          ? undefined
          : liveWorker
            ? "Its session is still the worker of a non-terminal goal and may be mid-write."
            : "Owned by another session. Only a goal you own, your own session's calls, or a goal that no longer exists, can be released here.",
      }
    })
    const operation = state.workspaceOperation
      ? { id: state.workspaceOperation.id, goalID: state.workspaceOperation.goalID, sessionID: state.workspaceOperation.sessionID }
      : undefined
    return { reservations, operation }
  }

  async function workspaceReservationsUnlocked(directory: string, ownerSessionID: string): Promise<WorkspaceReservations> {
    return describeReservations(await readState(directory), ownerSessionID)
  }

  async function releaseWorkspaceUnlocked(
    directory: string,
    ownerSessionID: string,
    input: { callID?: string; goalID?: string; sessionID?: string },
  ): Promise<WorkspaceReleaseResult> {
    const pre = await readState(directory)
    const report = describeReservations(pre, ownerSessionID)
    if (!input.callID && !input.goalID && !input.sessionID) {
      return { ok: false, message: "Name a call_id, goal_id or session_id to release. This is a deliberate escape hatch, not a sweep.", released: [], remaining: report }
    }
    if (pre.workspaceOperation) {
      return { ok: false, message: `Workspace operation ${pre.workspaceOperation.id} is mid-flight. Wait for it to finish, then release.`, released: [], remaining: report }
    }
    const targets = report.reservations.filter((item) =>
      (!input.callID || item.callID === input.callID) &&
      (!input.goalID || item.goalID === input.goalID) &&
      (!input.sessionID || item.sessionID === input.sessionID),
    )
    if (!targets.length) {
      return { ok: false, message: "No workspace reservation matches that selection.", released: [], remaining: report }
    }
    const blocked = targets.filter((item) => !item.releasable)
    if (blocked.length) {
      return {
        ok: false,
        message: `Refusing to release ${blocked.length} of ${targets.length} reservation(s): ${blocked.map((item) => `${item.callID} — ${item.reason}`).join("; ")}`,
        released: [],
        remaining: report,
      }
    }
    const ids = new Set(targets.map((item) => item.callID))
    const after = await mutateState(directory, "workspace.release-manual", async (state) => {
      state.workspaceCalls = (state.workspaceCalls ?? []).filter((call) => !ids.has(call.callID))
      // scopeClosing exists only because in-flight writes did; once the owner
      // has asserted those writes are dead, keeping the flag would wedge the
      // goal in "cannot reacquire ownership" forever.
      for (const goal of state.goals) {
        if (!goal.scopeClosing) continue
        if ((state.workspaceCalls ?? []).some((call) => call.goalID === goal.id) || state.workspaceOperation?.goalID === goal.id) continue
        goal.scopeClosing = false
        goal.updatedAt = new Date().toISOString()
      }
      return state
    })
    await logServerEvent(directory, "workspace.released-manual", {
      released: targets.map((item) => ({ callID: item.callID, sessionID: item.sessionID, goalID: item.goalID })),
      ownerSessionID,
    }).catch(() => {})
    return {
      ok: true,
      message: `Released ${targets.length} workspace reservation(s): ${targets.map((item) => item.callID).join(", ")}.`,
      released: targets,
      remaining: describeReservations(after, ownerSessionID),
    }
  }

  async function clearUnlocked(directory: string, goalID: GoalID) {
    // Terminal by design: clear is NEVER gated on quiescence. The old
    // two-step scopeClearPending tombstone kept dead goals visible forever.
    // Retire the worker and remove goal+runtimes immediately, but retain
    // independent execution fences until their actual after-hook/finally.
    // Revoking session authority cannot stop an already executing write.
    const pre = await readState(directory)
    const workerID = sessions.get(goalID)?.workerSessionID || pre.goals.find((g) => g.id === goalID)?.workerSessionID
    const state = await mutateState(directory, `goal.clear:${goalID}`, async (s) => {
      const g = s.goals.find((item) => item.id === goalID)
      if (g) retireWorker(s, g)
      s.goals = s.goals.filter((g) => g.id !== goalID)
      s.runtimes = s.runtimes.filter((r) => r.goalID !== goalID)
      // Clearing cancels outstanding awaits: no orphan wakes after clear.
      s.commandAwaits = (s.commandAwaits ?? []).filter((a) => a.goalID !== goalID)
      await deleteGoalInbox(directory, goalID)
      return s
    })
    sessions.delete(goalID)

    // Best-effort abort AFTER the terminal state change (never gates it).
    if (workerID) {
      try { await workers.abortWorker(workerID) } catch {}
    }

    // Pausing cancels outstanding command awaits: an exit landing afterwards
    // fires nothing (no orphan wakes for a cleared goal).
    await cancelAwaitsForGoal(directory, goalID, "goal cleared").catch(() => {})

    await appendEvent(directory, {
      version: 1,
      eventID: randomUUID(),
      goalID,
      type: "goal.cleared",
      timestamp: new Date().toISOString(),
      revision: state.revision,
    } satisfies LoopEvent)
    await logServerEvent(directory, "goal.cleared-terminal", { goalID }).catch(() => {})
  }

  function getWorker(goalID: GoalID): WorkerSession | undefined {
    return sessions.get(goalID)
  }

  function getActiveWorkers(): Map<GoalID, WorkerSession> {
    return new Map(sessions)
  }

  async function reconcile(directory: string) {
    await reconcileTerminalWorkspaceCalls(directory, host)
    // Heal old goal flags after exact terminal proof drained reservations.
    // Restart, elapsed time and changed generations are not tool-exit proof.
    // Makes a restart self-healing instead of reconstructing the limbo.
    try {
      let summary = { reapedCalls: [], resetClosing: [], finalizedClears: [], forceCleared: [], reapedTickets: [] } as import("./workspace-execution").WorkspaceSweepSummary
      const pre = await readState(directory)
      if ((pre.workspaceCalls?.length) || pre.goals.some((g) => g.scopeClosing || g.scopeClearPending)) {
        await mutateState(directory, "reconcile.sweep-stale-workspace", async (s) => {
          summary = sweepStaleWorkspaceState(s)
          return s
        })
      }
      if (summary.reapedCalls.length || summary.resetClosing.length || summary.finalizedClears.length || summary.forceCleared.length || summary.reapedTickets.length) {
        await logServerEvent(directory, "reconcile.sweep-stale-workspace", {
          reapedCalls: summary.reapedCalls,
          resetClosing: summary.resetClosing,
          finalizedClears: summary.finalizedClears,
          forceCleared: summary.forceCleared,
          reapedTickets: summary.reapedTickets,
        }).catch(() => {})
      }
    } catch {}
    const state = await readState(directory)

    for (const goal of state.goals) {
      if (isTerminal(goal.status)) continue
      if (goal.status === "paused") continue
      if (goal.config.write_scope !== undefined && !host.scopedExecution) {
        await mutateState(directory, `reconcile.unsupported-scope:${goal.id}`, async (s) => {
          const g = s.goals.find((item) => item.id === goal.id)
          if (g) {
            g.scopeClosing = true
            retireWorker(s, g)
            g.status = "blocked"
            g.blocker = { reason: "Host lacks audited scoped execution guard.", needed: "Load guarded v2 execution surface; do not resume scoped goals on v1.", at: new Date().toISOString() }
          }
          return s
        })
        if (goal.workerSessionID) await workers.abortWorker(goal.workerSessionID)
        sessions.delete(goal.id)
        continue
      }

      // Active goal without worker ID: create a worker (external I/O — not under lock)
      if (!goal.workerSessionID) {
        let worker: WorkerSession | undefined
        try {
          worker = await workers.createWorker(goal, directory)
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
            if (worker!.topology) {
              g.workerTopology = worker!.topology
              g.nativeParentID = worker!.nativeParentID
            }
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
      if (!host.readExecution && preRt?.phase === "running" && !leaseIsValid(preRt)) {
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

  async function nudgeUnlocked(directory: string, goalID: GoalID): Promise<GoalActionResult> {
    await reconcileTerminalWorkspaceCalls(directory, host)
    const preState = await readState(directory)
    const goal = preState.goals.find((g) => g.id === goalID)
    if (!goal) return rejected(goalID, "not_found", "Goal not found (it may have been cleared). List your goals instead of retrying this ID.")
    if (goal.status !== "active") {
      return rejected(goalID, "invalid_state", `Goal is ${goal.status}; resume or retry it before nudging.`)
    }
    // Quota is not a timeout: never burn a turn re-prompting a model the
    // provider just limited. ok:false (not an exception) keeps nudge usable —
    // the operator waits, switches model, or retries after the hold lifts.
    const quotaHold = quotaHoldMessage(goal)
    if (quotaHold) return rejected(goalID, "blocked", quotaHold)
    const guard = continuationGuard(preState, goalID)
    if (guard) return guard
    const currentRun = preState.runtimes.find((rt) => rt.goalID === goalID)
    if (host.readExecution && goal.workerSessionID && currentRun?.phase === "running" && currentRun.activePromptAcceptedAt) {
      const prompt = currentRun.activePromptMessageID
      const projection = await host.readExecution(goal.workerSessionID)
      if (prompt && !projection?.deliveredMessageIDs?.includes(prompt) && projection?.latestUserMessageID !== prompt) {
        // Dead-prompt escape hatch: an accepted prompt with an expired lease
        // on a worker the host confirms idle is not in flight anymore —
        // delivery bookkeeping will never confirm it, so refusing here stalls
        // the goal forever (same class as foreign-prompt stalls). A manual
        // nudge is an explicit operator action; the fresh turn gets a new ID.
        // Lease-valid or non-idle workers keep the fail-closed refusal below.
        const workerStatus = await host.sessionStatus(goal.workerSessionID).catch(() => "unknown" as const)
        if (workerStatus === "idle" && !leaseIsValid(currentRun)) {
          await logServerEvent(directory, "goal.nudge.dead-prompt-override", { goalID, runID: currentRun.activeRunID }).catch(() => {})
        } else {
          return rejected(goalID, "blocked", `OpenCode already accepted prompt ${prompt}, but delivery is unconfirmed. No duplicate nudge was sent; inspect the native inbox/session.`)
        }
      }
      if (currentRun.nativeInboxMessageIDs?.some((id) => !projection?.deliveredMessageIDs?.includes(id))) {
        return rejected(goalID, "blocked", "Native inbox messages are still awaiting delivery. No duplicate nudge was sent.")
      }
    }
    if (goal.workerSessionID) {
      const status = await host.sessionStatus(goal.workerSessionID)
      if (status === "busy") return rejected(goalID, "blocked", "Worker is busy; no prompt was sent and its active turn was left intact. Retry after idle.")
      if (status !== "idle" && (goal.pendingIdentity || goal.modelSwitch?.pending || goal.agentSwitch?.pending)) {
        return rejected(goalID, "blocked", "Pending identity requires confirmed idle; worker status is unknown. No prompt was sent.")
      }
      if (status !== "idle") return rejected(goalID, "blocked", "Worker status is unknown or retrying; an outstanding prompt may already be accepted. Nothing was sent or reset. Retry after confirmed idle.")
    }
    if (goal.config.write_scope !== undefined) {
      await pauseUnlocked(directory, goalID)
      return resumeUnlocked(directory, goalID)
    }

    // Clear stale run state so the continuation is not gated on an old lease/run.
    let resetFailure: GoalActionResult | undefined
    const cleared = await mutateState(directory, `goal.nudge:${goalID}`, async (s) => {
      resetFailure = continuationGuard(s, goalID)
      if (resetFailure) return s
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
    if (resetFailure) return resetFailure
    const freshGoal = cleared.goals.find((g) => g.id === goalID)
    if (!freshGoal || !freshGoal.workerSessionID) {
      return rejected(goalID, "blocked", "Goal has no worker session. Use resume_goal or retry_goal.")
    }

    // Idle was confirmed above; force bypasses only the redundant host probe.
    return continueTurnUnlocked(directory, goalID, { force: true })
  }

  async function sendUnlocked(directory: string, goalID: GoalID, text: string): Promise<GoalActionResult> {
    const trimmed = text.trim()
    if (!trimmed) return rejected(goalID, "invalid_state", "Nothing to send.")
    await reconcileTerminalWorkspaceCalls(directory, host)
    const preState = await readState(directory)
    const goal = preState.goals.find((g) => g.id === goalID)
    if (!goal) return rejected(goalID, "not_found", "Goal not found (it may have been cleared). List your goals instead of retrying this ID.")

    const active = preState.runtimes.find((rt) => rt.goalID === goalID)
    if (host.readExecution && host.enqueueWorkerMessage && goal.status === "active" && !goal.scopeClosing && goal.workerSessionID && active?.phase === "running" && active.activePromptAcceptedAt) {
      // Persist receipt intent; v2 owns queue contents and actual delivery.
      const messageID = newPromptMessageID()
      let reserved = false
      await mutateState(directory, `native.inbox:${goalID}`, async (s) => {
        const g = s.goals.find((item) => item.id === goalID)
        const rt = s.runtimes.find((item) => item.goalID === goalID)
        if (g?.status !== "active" || g.scopeClosing || g.workerSessionID !== goal.workerSessionID || !rt || rt.phase !== "running" || rt.runGeneration !== active.runGeneration || rt.activeRunID !== active.activeRunID) return s
        rt.nativeInboxMessageIDs = [...(rt.nativeInboxMessageIDs ?? []), messageID]
        reserved = true
        return s
      })
      if (reserved) {
        try {
          await host.enqueueWorkerMessage(goal.workerSessionID, messageID, trimmed)
          const current = await readState(directory)
          if (!current.goals.some((g) => g.id === goalID && g.workerSessionID === goal.workerSessionID)) return rejected(goalID, "not_found", "Goal cleared during native enqueue; late acceptance grants no authority.")
          const currentGoal = current.goals.find((g) => g.id === goalID)
          const currentRun = current.runtimes.find((rt) => rt.goalID === goalID)
          if (currentGoal?.status !== "active" || currentRun?.runGeneration !== active.runGeneration || currentRun.activeRunID !== active.activeRunID) return rejected(goalID, "blocked", "Goal or turn changed during native enqueue; late acceptance grants no authority.")
          return { ok: true, outcome: "queued", goalID, promptMessageID: messageID, message: `Queued in inbox for "${goal.name}" — worker is busy, will deliver on next idle turn. Use nudge_goal to deliver now (forced), or wait.` }
        } catch {
          // A timeout is ambiguous acceptance, never cancellation or permission
          // to retry blindly. Keep the receipt until host delivery is observed.
          return rejected(goalID, "blocked", `Native inbox acceptance is unconfirmed for ${messageID}; inspect the session before resending.`)
        }
      }
    }

    if (!await appendGoalInbox(directory, goalID, "user", trimmed)) return rejected(goalID, "not_found", "Goal cleared before words could be queued. List current goals instead of retrying this ID.")
    if (goal.status !== "active") {
      return { ok: true, outcome: "queued", goalID, message: `Queued for "${goal.name}" (goal is ${goal.status} — not running). Will deliver when you resume it to active via resume_goal.` }
    }
    const guard = continuationGuard(preState, goalID)
    if (guard) return { ok: true, outcome: "queued", goalID, message: `Saved in inbox for "${goal.name}". ${guard.message}` }
    const status = goal.workerSessionID ? await host.sessionStatus(goal.workerSessionID) : undefined
    if (!(await readState(directory)).goals.some((item) => item.id === goalID)) return rejected(goalID, "not_found", "Goal cleared during worker status probe; no prompt was sent.")
    if (goal.workerSessionID && status !== "idle") {
      return { ok: true, outcome: "queued", goalID, message: `Saved in inbox for "${goal.name}" — worker is busy (status: ${status}). Left intact; will deliver on next idle. Use nudge_goal to force now.` }
    }
    if (goal.config.write_scope !== undefined) {
      const result = await continueTurnUnlocked(directory, goalID, { bare: true })
      return result.ok || result.outcome === "not_found" ? result : { ok: true, outcome: "queued", goalID, message: `Saved in inbox for "${goal.name}". ${result.message}` }
    }

    // Clear stale run state so the bare turn is not gated on an old lease/run.
    let resetFailure: GoalActionResult | undefined
    const cleared = await mutateState(directory, `goal.send:${goalID}`, async (s) => {
      resetFailure = continuationGuard(s, goalID)
      if (resetFailure) return s
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
    if (resetFailure) return resetFailure.outcome === "not_found" ? resetFailure : { ok: true, outcome: "queued", goalID, message: `Words saved in inbox. ${resetFailure.message}` }
    const freshGoal = cleared.goals.find((g) => g.id === goalID)
    if (!freshGoal || !freshGoal.workerSessionID) {
      return { ok: true, outcome: "queued", goalID, message: `Queued for "${goal.name}" (no worker session yet; delivers on the next turn).` }
    }

    // Force a bare turn now: the drained words alone, no steering wrapper.
    const result = await continueTurnUnlocked(directory, goalID, { force: true, bare: true })
    return result.ok || result.outcome === "not_found" ? result : { ok: true, outcome: "queued", goalID, message: `Saved in inbox for "${goal.name}". ${result.message}` }
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

  async function grantApprovedCommandUnlocked(
    directory: string,
    ownerSessionID: string,
    goalID: string,
    spec: unknown,
  ): Promise<{ ok: boolean; message: string; spec?: import("../domain/goal").ApprovedGoalCommand }> {
    const pre = await readState(directory)
    const goal = pre.goals.find((g) => g.id === goalID)
    if (!goal) return { ok: false, message: "Goal not found." }
    if (goal.ownerSessionID !== ownerSessionID) {
      return { ok: false, message: "Only the goal's owner session can grant commands — workers can never authorize themselves." }
    }
    if (goal.status !== "active" || goal.scopeClosing || goal.scopeClearPending) {
      return { ok: false, message: `Goal "${goal.name}" is ${goal.scopeClosing ? "closing" : goal.status}, not active; grant while it is active.` }
    }
    let canonical: import("../domain/goal").ApprovedGoalCommand
    try {
      const [only] = await canonicalGoalCommands(directory, [spec])
      canonical = only!
    } catch (error) {
      return { ok: false, message: describeError(error) }
    }
    if ((goal.config.approvedCommands ?? []).some((c) => c.name === canonical.name)) {
      return { ok: false, message: `An approved command named "${canonical.name}" already exists for this goal; names are unique and grants are append-only (no revoke, no overwrite).` }
    }
    await mutateState(directory, `goal.grant-command:${goalID}:${canonical.name}`, async (s) => {
      const g = s.goals.find((x) => x.id === goalID)
      if (!g || g.ownerSessionID !== ownerSessionID) return s
      g.config.approvedCommands = [...(g.config.approvedCommands ?? []), canonical]
      g.updatedAt = new Date().toISOString()
      return s
    })
    await logServerEvent(directory, "goal.approved-command-granted", {
      goalID,
      name: canonical.name,
      kind: canonical.kind,
      ownerSessionID,
    }).catch(() => {})
    return {
      ok: true,
      spec: canonical,
      message: `Granted approved ${canonical.kind} command "${canonical.name}" to goal "${goal.name}". The worker picks it up on its next turn (finite: run_approved_command, server: start/read/stop_approved_server). Grants are append-only; clearing the goal removes everything.`,
    }
  }

  function grantApprovedCommand(directory: string, ownerSessionID: string, goalID: string, spec: unknown) {
    return withGoalOperation(goalID as GoalID, () => grantApprovedCommandUnlocked(directory, ownerSessionID, goalID, spec))
  }

  async function grantWriteScopeUnlocked(
    directory: string,
    ownerSessionID: string,
    goalID: string,
    paths: unknown,
  ): Promise<{ ok: boolean; message: string; write_scope?: string[] }> {
    const pre = await readState(directory)
    const goal = pre.goals.find((g) => g.id === goalID)
    if (!goal) return { ok: false, message: "Goal not found." }
    if (goal.ownerSessionID !== ownerSessionID) {
      return { ok: false, message: "Only the goal's owner session can widen scope — workers can never authorize themselves." }
    }
    if (goal.status !== "active" || goal.scopeClosing || goal.scopeClearPending) {
      return { ok: false, message: `Goal "${goal.name}" is ${goal.scopeClosing ? "closing" : goal.status}, not active; grant while it is active.` }
    }
    if (goal.config.workspaceWrite === false) {
      return { ok: false, message: `Goal "${goal.name}" is artifact-only (workspaceWrite:false); it has no workspace scope to widen. Recreate with workspaceWrite:true if it needs to edit repo files.` }
    }
    if (!Array.isArray(paths) || paths.length === 0) {
      return { ok: false, message: "Provide at least one file path to grant (exact workspace-relative paths, no globs)." }
    }
    let canonical: string[]
    try {
      const { canonicalWriteScope } = await import("../infrastructure/workspace-scope")
      canonical = await canonicalWriteScope(directory, paths as string[])
    } catch (error) {
      return { ok: false, message: describeError(error) }
    }
    const existing = goal.config.write_scope ?? []
    const toAdd = canonical.filter((p) => !existing.includes(p))
    if (toAdd.length === 0) {
      return { ok: false, message: `All ${canonical.length} path(s) already in write_scope. Current scope: [${existing.join(", ")}]` }
    }
    // Check for conflicts with other active goals before granting
    const { findScopeConflict } = await import("../infrastructure/workspace-scope")
    const heldGoals = pre.goals.filter((g) => g.id !== goalID && g.status === "active" && g.config.workspaceWrite !== false)
    for (const p of toAdd) {
      const candidate = { ...goal, config: { ...goal.config, write_scope: [p] } } as typeof goal
      const conflict = findScopeConflict(heldGoals as any, candidate as any)
      if (conflict) {
        return { ok: false, message: `Cannot grant "${p}": write scope conflict on "${conflict.path}": goal "${conflict.name}" (${conflict.goalID}), owned by session ${conflict.ownerSessionID}.` }
      }
    }
    await mutateState(directory, `goal.grant-scope:${goalID}`, async (s) => {
      const g = s.goals.find((x) => x.id === goalID)
      if (!g || g.ownerSessionID !== ownerSessionID) return s
      g.config.write_scope = [...(g.config.write_scope ?? []), ...toAdd].sort()
      g.updatedAt = new Date().toISOString()
      return s
    })
    await logServerEvent(directory, "goal.write-scope-granted", {
      goalID,
      paths: toAdd,
      ownerSessionID,
    }).catch(() => {})
    const updated = (await readState(directory)).goals.find((g) => g.id === goalID)?.config.write_scope
    return {
      ok: true,
      write_scope: updated,
      message: `Granted ${toAdd.length} path(s) to "${goal.name}": [${toAdd.join(", ")}]. Worker picks it up next turn via claim_goal_scope or direct write. Full scope now: [${updated?.join(", ")}]`,
    }
  }

  function grantWriteScope(directory: string, ownerSessionID: string, goalID: string, paths: unknown) {
    return withGoalOperation(goalID as GoalID, () => grantWriteScopeUnlocked(directory, ownerSessionID, goalID, paths))
  }

  async function abortWorkerUnlocked(directory: string, goalID: GoalID): Promise<{ ok: boolean; message: string }> {
    const preState = await readState(directory)
    const goal = preState.goals.find((g) => g.id === goalID)
    if (!goal) return { ok: false, message: "Goal not found." }
    if (goal.config.write_scope !== undefined && goal.status === "active") {
      await pauseUnlocked(directory, goalID)
      await resumeUnlocked(directory, goalID)
      return { ok: true, message: `Protected worker for "${goal.name}" aborted and replaced with a fenced session.` }
    }
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

  function workspaceReservations(directory: string, ownerSessionID: string) {
    return workspaceReservationsUnlocked(directory, ownerSessionID)
  }

  function releaseWorkspace(directory: string, ownerSessionID: string, input: { callID?: string; goalID?: string; sessionID?: string }) {
    return releaseWorkspaceUnlocked(directory, ownerSessionID, input)
  }

  return { scopedExecution: host.scopedExecution === true, start, continueTurn, nudge, pause, resume, retry, clear, workspaceReservations, releaseWorkspace, grantApprovedCommand, grantWriteScope, getWorker, getActiveWorkers, reconcile, accountUsage, abortWorker, sendUserMessage, setInteractive, listModels, switchModel, listAgents, switchAgent, switchIdentity, observeProviderError, compact }
}
