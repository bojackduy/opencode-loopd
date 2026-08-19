// ─── Application: Loop Engine ────────────────────────────────────────────────
// The central orchestrator. Handles session events, drives continuation,
// enforces limits, and manages compaction.
// Zero-cost when no goals exist: event hook filters by type before disk read.

import { randomUUID } from "crypto"
import { readState, writeState, appendEvent } from "../infrastructure/state-repository"
import type { StoreState } from "../infrastructure/state-repository"
import { isTerminal } from "../domain/goal"
import type { GoalID } from "../domain/goal"
import {
  leaseIsValid,
  releaseLease,
  acquireLease,
  type GoalRuntimeState,
} from "../domain/runtime"
import type { LoopEvent } from "../domain/events"
import type { GoalService } from "./goal-service"
import type { LoopHost } from "../server/host-adapter"

const HANDLED_EVENT_TYPES = new Set([
  "session.idle",
  "session.status",
  "session.error",
  "session.compacted",
])

export interface LoopEngineOptions {
  directory: string
  host: LoopHost
  goalService: GoalService
  pollIntervalMs?: number
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

  let running = false
  let maintenanceTimer: ReturnType<typeof setInterval> | undefined
  // In-memory cache of worker session IDs — avoids disk read on every event
  let knownWorkerSessions = new Set<string>()
  let knownWorkerSessionsLoaded = false
  // Guard against concurrent continuations for the same goal
  const inflightContinuations = new Set<GoalID>()

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

  // Exposed for tests to preload worker sessions
  async function preloadWorkerSessions() {
    await loadWorkerSessionsIfneeded()
  }

  function start() {
    if (running) return
    running = true
    // Load worker sessions eagerly so event hook is ready immediately
    loadWorkerSessionsIfneeded().catch(() => {})
    // Maintenance timer — much slower than before (30s vs 5s)
    maintenanceTimer = setInterval(() => {
      if (running) maintenance().catch(() => {})
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

  // ─── Event Handling ───────────────────────────────────────────────────────

  async function handleEvent(event: any): Promise<boolean> {
    if (!running || !event || typeof event !== "object") return false

    // FAST PATH: filter by event type BEFORE any disk I/O
    const type = event.type as string | undefined
    if (!type || !HANDLED_EVENT_TYPES.has(type)) return false

    // FAST PATH: check if this session is one we care about
    const sessionID = event.properties?.sessionID as string | undefined
    if (!sessionID) return false

    // Load worker sessions on first event (lazy)
    await loadWorkerSessionsIfneeded()

    // FAST PATH: skip events for sessions we don't own
    // (but only if we've loaded the cache — don't reject if cache is empty)
    if (knownWorkerSessions.size > 0 && !knownWorkerSessions.has(sessionID)) return false

    // SLOW PATH: only now read state from disk
    const state = await readState(directory)
    const goal = state.goals.find((g) => g.workerSessionID === sessionID)
    if (!goal) return false

    // Update worker session cache
    if (goal.workerSessionID) knownWorkerSessions.add(goal.workerSessionID)

    // Skip terminal or paused goals
    if (isTerminal(goal.status) || goal.status === "paused") return false

    switch (type) {
      case "session.idle":
        return await handleSessionIdle(state, goal)
      case "session.status":
        return await handleSessionStatus(state, goal, event)
      case "session.error":
        return await handleSessionError(state, goal, event)
      case "session.compacted":
        return await handleSessionCompacted(state, goal)
      default:
        return false
    }
  }

  // ─── Idle Handler ─────────────────────────────────────────────────────────

  async function handleSessionIdle(state: StoreState, goal: any): Promise<boolean> {
    const runtime = state.runtimes.find((r) => r.goalID === goal.id)
    if (!runtime) return false

    // Guard against concurrent continuations
    if (inflightContinuations.has(goal.id)) return false

    // Release current lease
    if (runtime.phase === "running") {
      Object.assign(runtime, releaseLease(runtime))
      runtime.lastWorkerStatus = "idle"
      await writeState(directory, state)
    }

    // Check if goal is still active
    if (goal.status !== "active") return false

    // Enforce limits
    const limitResult = enforceLimits(goal, runtime)
    if (limitResult.blocked) {
      await writeState(directory, state)
      if (limitResult.event === "goal.blocked") {
        await appendEvent(directory, {
          version: 1,
          eventID: randomUUID(),
          goalID: goal.id,
          type: "goal.blocked",
          reason: limitResult.reason,
          needed: limitResult.reason,
          timestamp: new Date().toISOString(),
          revision: state.revision,
        } satisfies LoopEvent)
      } else {
        await appendEvent(directory, {
          version: 1,
          eventID: randomUUID(),
          goalID: goal.id,
          type: "goal.status_changed",
          from: "active",
          to: goal.status,
          timestamp: new Date().toISOString(),
          revision: state.revision,
        } satisfies LoopEvent)
      }
      return true
    }

    // Check compaction due
    if (shouldCompact(goal, runtime)) {
      await doCompact(goal, runtime)
      return true
    }

    // Schedule next turn
    inflightContinuations.add(goal.id)
    try {
      await goalService.continueTurn(directory, goal.id)
    } finally {
      inflightContinuations.delete(goal.id)
    }

    return true
  }

  // ─── Status Handler ───────────────────────────────────────────────────────

  async function handleSessionStatus(state: StoreState, goal: any, event: any): Promise<boolean> {
    const runtime = state.runtimes.find((r) => r.goalID === goal.id)
    if (!runtime) return false

    const status = event.properties?.status
    const statusType = status?.type as string | undefined
    if (!statusType) return false

    runtime.lastWorkerStatus = statusType as any
    runtime.updatedAt = new Date().toISOString()

    await writeState(directory, state)
    return true
  }

  // ─── Error Handler ────────────────────────────────────────────────────────

  async function handleSessionError(state: StoreState, goal: any, event: any): Promise<boolean> {
    const runtime = state.runtimes.find((r) => r.goalID === goal.id)
    if (!runtime) return false

    const error = event.properties?.error
    const message = error?.message || error?.toString() || "unknown error"

    runtime.consecutiveFailures += 1
    runtime.lastError = message
    runtime.updatedAt = new Date().toISOString()

    // Release lease
    if (runtime.phase === "running") {
      Object.assign(runtime, releaseLease(runtime))
    }

    // Record failure event
    await appendEvent(directory, {
      version: 1,
      eventID: randomUUID(),
      goalID: goal.id,
      type: "run.failed",
      runID: runtime.activeRunID || "unknown",
      error: message,
      consecutiveFailures: runtime.consecutiveFailures,
      timestamp: new Date().toISOString(),
      revision: state.revision,
    } satisfies LoopEvent)

    // Check max failures
    const maxFailures = goal.config?.maxFailures || 5
    if (runtime.consecutiveFailures >= maxFailures) {
      goal.status = "blocked"
      goal.updatedAt = new Date().toISOString()
      goal.blocker = {
        reason: `Failed ${runtime.consecutiveFailures} times. Last error: ${message}`,
        needed: "User intervention required. Use retry to attempt again.",
        at: new Date().toISOString(),
      }

      await appendEvent(directory, {
        version: 1,
        eventID: randomUUID(),
        goalID: goal.id,
        type: "goal.blocked",
        reason: `Failed ${runtime.consecutiveFailures} times`,
        needed: "User intervention required",
        timestamp: new Date().toISOString(),
        revision: state.revision,
      } satisfies LoopEvent)
    } else {
      // Set retry backoff
      const backoffMs = Math.min(30_000, 1_000 * Math.pow(2, runtime.consecutiveFailures))
      runtime.retryAfter = new Date(Date.now() + backoffMs).toISOString()
      runtime.phase = "waiting_retry"
    }

    await writeState(directory, state)
    return true
  }

  // ─── Compacted Handler ────────────────────────────────────────────────────

  async function handleSessionCompacted(state: StoreState, goal: any): Promise<boolean> {
    const runtime = state.runtimes.find((r) => r.goalID === goal.id)
    if (!runtime) return false

    runtime.lastCompactAt = new Date().toISOString()
    runtime.updatedAt = new Date().toISOString()

    await writeState(directory, state)

    await appendEvent(directory, {
      version: 1,
      eventID: randomUUID(),
      goalID: goal.id,
      type: "compaction.completed",
      timestamp: new Date().toISOString(),
      revision: state.revision,
    } satisfies LoopEvent)

    return true
  }

  // ─── Limit Enforcement ────────────────────────────────────────────────────

  interface LimitResult {
    blocked: boolean
    event: "goal.blocked" | "goal.status_changed"
    reason: string
  }

  function enforceLimits(goal: any, runtime: GoalRuntimeState): LimitResult {
    const noResult: LimitResult = { blocked: false, event: "goal.status_changed", reason: "" }

    // Max turns
    const maxTurns = goal.config?.maxTurns
    if (maxTurns && runtime.turnCount >= maxTurns) {
      goal.status = "blocked"
      goal.updatedAt = new Date().toISOString()
      goal.blocker = {
        reason: `Reached max turns (${maxTurns})`,
        needed: "Use retry to reset turns and continue.",
        at: new Date().toISOString(),
      }
      return {
        blocked: true,
        event: "goal.blocked",
        reason: `Reached max turns (${maxTurns})`,
      }
    }

    // Max no-progress
    const maxNoProgress = goal.config?.maxNoProgress
    if (maxNoProgress && runtime.noProgressCount >= maxNoProgress) {
      goal.status = "blocked"
      goal.updatedAt = new Date().toISOString()
      goal.blocker = {
        reason: `No progress for ${runtime.noProgressCount} consecutive turns`,
        needed: "Use retry to reset and continue.",
        at: new Date().toISOString(),
      }
      return {
        blocked: true,
        event: "goal.blocked",
        reason: `No progress for ${runtime.noProgressCount} consecutive turns`,
      }
    }

    // Token budget
    if (goal.tokenBudget && goal.tokensUsed >= goal.tokenBudget) {
      goal.status = "budget_limited"
      goal.updatedAt = new Date().toISOString()
      return {
        blocked: true,
        event: "goal.status_changed",
        reason: `Token budget exhausted (${goal.tokensUsed}/${goal.tokenBudget})`,
      }
    }

    return noResult
  }

  // ─── Compaction ───────────────────────────────────────────────────────────

  function shouldCompact(goal: any, runtime: GoalRuntimeState): boolean {
    const compactEvery = goal.config?.compactEvery
    if (!compactEvery) return false
    return runtime.turnCount > 0 && runtime.turnCount % compactEvery === 0
  }

  async function doCompact(goal: any, runtime: GoalRuntimeState) {
    if (!goal.workerSessionID) return

    const prevPhase = runtime.phase
    runtime.phase = "compacting"
    runtime.lastCompactAt = new Date().toISOString()

    const state = await readState(directory)
    await writeState(directory, state)

    await appendEvent(directory, {
      version: 1,
      eventID: randomUUID(),
      goalID: goal.id,
      type: "compaction.started",
      timestamp: new Date().toISOString(),
      revision: state.revision,
    } satisfies LoopEvent)

    try {
      await host.compactSession(goal.workerSessionID)
    } catch {
      // Best-effort compaction
    }

    // Restore phase after compaction
    const updatedState = await readState(directory)
    const updatedRuntime = updatedState.runtimes.find((r) => r.goalID === goal.id)
    if (updatedRuntime) {
      updatedRuntime.phase = prevPhase
      await writeState(directory, updatedState)
    }
  }

  // ─── Maintenance ──────────────────────────────────────────────────────────

  async function maintenance() {
    // FAST PATH: skip entirely if no known worker sessions
    if (knownWorkerSessions.size === 0) return

    const state = await readState(directory)
    // FAST PATH: skip if no active goals
    const hasActiveGoals = state.goals.some(
      (g) => !isTerminal(g.status) && g.status !== "paused",
    )
    if (!hasActiveGoals) return

    for (const goal of state.goals) {
      if (isTerminal(goal.status) || goal.status === "paused") continue

      const runtime = state.runtimes.find((r) => r.goalID === goal.id)
      if (!runtime) continue

      // Handle waiting_retry: check if retry time has passed
      if (runtime.phase === "waiting_retry" && runtime.retryAfter) {
        if (Date.now() >= Date.parse(runtime.retryAfter)) {
          runtime.retryAfter = undefined
          runtime.phase = "idle"
          await writeState(directory, state)
          // Trigger continuation
          goalService.continueTurn(directory, goal.id).catch(() => {})
        }
      }

      // Handle expired leases
      if (runtime.phase === "running" && !leaseIsValid(runtime)) {
        const session = goalService.getWorker(goal.id)
        if (session && await host.sessionStatus(session.workerSessionID) === "idle") {
          Object.assign(runtime, releaseLease(runtime))
          runtime.lastWorkerStatus = "idle"
          await writeState(directory, state)
          // Trigger continuation
          goalService.continueTurn(directory, goal.id).catch(() => {})
        }
      }
    }
  }

  return { start, stop, isRunning, handleEvent, preloadWorkerSessions }
}
