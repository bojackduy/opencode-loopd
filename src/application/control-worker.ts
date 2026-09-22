// ─── Application: Control Worker ─────────────────────────────────────────────
// Server-side: watches for control requests, processes them, writes responses.
// Integrates with GoalService for real goal lifecycle.
// Supports idempotency via command ledger and response caching.

import { promises as fs } from "fs"
import path from "path"
import { randomUUID } from "crypto"
import { releaseLease } from "../domain/runtime"
import {
  listPendingRequests,
  claimControlRequest,
  writeControlResponse,
  readControlResponse,
  recoverStaleProcessing,
  readState,
  writeState,
  mutateState,
  appendEvent,
  type ControlRequest,
  type ControlResponse,
} from "../infrastructure/state-repository"
import type { GoalService } from "./goal-service"
import type { CommandService } from "./command-service"
import {
  resolveGoalCreationConfig,
  type GoalCreationDefaults,
} from "./goal-policy"
import { describeError, logServerEvent, SERVER_LOG_FILE } from "../infrastructure/server-log"
import { requestCommandAwait, wakeGoalForAwait } from "./command-await"

const MAX_LEDGER_SIZE = 100
const RESPONSE_CLEANUP_AGE_MS = 60 * 60 * 1000 // 1 hour

export interface ControlWorkerOptions {
  directory: string
  goalService: GoalService
  commandService?: CommandService
  pollIntervalMs?: number
  defaults?: GoalCreationDefaults
  onRequest?: (request: ControlRequest) => void
  onResponse?: (response: ControlResponse) => void
}

export interface ControlWorker {
  start(): void
  stop(): Promise<void>
  isRunning(): boolean
}

export function createControlWorker(options: ControlWorkerOptions): ControlWorker {
  const directory = options.directory
  const pollMs = options.pollIntervalMs ?? 1_000
  const goalSvc = options.goalService

  let running = false
  let pollTimer: ReturnType<typeof setInterval> | undefined
  let processing = new Set<string>()
  let lastProcessDone = true

  function start() {
    if (running) return
    running = true
    // Process immediately on start, then activate interval if needed
    processPending().catch((error) => {
      void logServerEvent(directory, "control.worker.error", { detail: describeError(error) }).catch(() => {})
    })
    pollTimer = setInterval(() => {
      if (running && lastProcessDone) {
        lastProcessDone = false
        // The reset MUST survive rejection: without the rejection handler a
        // single infrastructure failure (lock contention, disk hiccup) left
        // lastProcessDone false forever and the worker silently stopped
        // processing — every later keypress queued without effect.
        processPending().then(
          () => { lastProcessDone = true },
          (error) => {
            lastProcessDone = true
            void logServerEvent(directory, "control.worker.error", { detail: describeError(error) }).catch(() => {})
          },
        )
      }
    }, pollMs)
  }

  async function stop() {
    running = false
    if (pollTimer) clearInterval(pollTimer)
    pollTimer = undefined
    processing.clear()
  }

  async function processPending() {
    if (!running) return

    const requests = await listPendingRequests(directory)
    for (const request of requests) {
      if (processing.has(request.requestID)) continue

      const claimed = await claimControlRequest(directory, request.requestID)
      if (!claimed) continue

      processing.add(request.requestID)
      options.onRequest?.(request)

      try {
        const response = await handleRequest(request)
        await writeControlResponse(directory, response)
        options.onResponse?.(response)
      } catch (error) {
        const detail = describeError(error)
        await logServerEvent(directory, "control.request.failed", {
          requestID: request.requestID,
          command: request.command,
          goalID: request.goalID,
          detail,
        })
        const response: ControlResponse = {
          requestID: request.requestID,
          ok: false,
          message: `internal error: ${detail}. Diagnostics: ${SERVER_LOG_FILE}`,
          errorCode: "internal_error",
          completedAt: new Date().toISOString(),
        }
        await writeControlResponse(directory, response)
        options.onResponse?.(response)
      } finally {
        processing.delete(request.requestID)
      }
    }
  }

  async function handleRequest(request: ControlRequest): Promise<ControlResponse> {
    // Check idempotency: if we already have a response, return it
    const existingResponse = await readControlResponse(directory, request.requestID)
    if (existingResponse) {
      return existingResponse
    }

    // Check command ledger for accepted commands
    const state = await readState(directory)
    const ledgerEntry = state.commandLedger?.find((e) => e.requestID === request.requestID)
    if (ledgerEntry?.completedAt) {
      // Command was already processed, return cached response
      return {
        requestID: request.requestID,
        ok: true,
        message: `command "${request.command}" already processed`,
        stateRevision: state.revision,
        completedAt: ledgerEntry.completedAt,
      }
    }

    const base = {
      requestID: request.requestID,
      ok: true as boolean,
      message: "" as string,
      stateRevision: undefined as number | undefined,
      errorCode: undefined as string | undefined,
      completedAt: new Date().toISOString(),
    }

    let response: ControlResponse

    switch (request.command) {
      case "start": {
        const args = request.args as { name: string; objective: string; config?: any; ownerSessionID?: string }
        if (!args.ownerSessionID || args.ownerSessionID === "main") {
          response = {
            ...base,
            ok: false,
            message: "cannot start goal without a valid owner session; open /loop from an active OpenCode session",
            errorCode: "invalid_owner_session",
          }
          break
        }
        const resolution = resolveGoalCreationConfig({
          directory,
          objective: args.objective,
          config: args.config,
          defaults: options.defaults,
        })
        if (!resolution.ok) {
          response = {
            ...base,
            ok: false,
            message: resolution.message,
            errorCode: resolution.errorCode,
          }
          break
        }
        const { goal } = await goalSvc.start(directory, {
          name: args.name,
          objective: args.objective,
          ownerSessionID: args.ownerSessionID,
          config: resolution.config,
        })
        const state = await readState(directory)
        response = {
          ...base,
          message: `goal "${args.name}" created (${goal.id.slice(0, 8)}...)`,
          stateRevision: state.revision,
        }
        break
      }

      case "pause": {
        await goalSvc.pause(directory, request.goalID as any)
        const state = await readState(directory)
        const goal = state.goals.find((g) => g.id === request.goalID)
        response = {
          ...base,
          message: `goal "${goal?.name || request.goalID}" paused`,
          stateRevision: state.revision,
        }
        break
      }

      case "resume": {
        await goalSvc.resume(directory, request.goalID as any)
        const state = await readState(directory)
        const goal = state.goals.find((g) => g.id === request.goalID)
        response = {
          ...base,
          message: `goal "${goal?.name || request.goalID}" resumed`,
          stateRevision: state.revision,
        }
        break
      }

      case "retry": {
        await goalSvc.retry(directory, request.goalID as any)
        const state = await readState(directory)
        const goal = state.goals.find((g) => g.id === request.goalID)
        response = {
          ...base,
          message: `goal "${goal?.name || request.goalID}" retried`,
          stateRevision: state.revision,
        }
        break
      }

      case "nudge": {
        if (!request.goalID) {
          response = { ...base, ok: false, message: "goalID is required", errorCode: "bad_request" }
          break
        }
        const result = await goalSvc.nudge(directory, request.goalID as any)
        const state = await readState(directory)
        response = {
          ...base,
          ok: result.ok,
          message: result.message,
          stateRevision: state.revision,
        }
        break
      }

      case "clear": {
        await goalSvc.clear(directory, request.goalID as any)
        const state = await readState(directory)
        response = {
          ...base,
          message: `goal cleared`,
          stateRevision: state.revision,
        }
        break
      }

      case "send": {
        const args = request.args as { message: string }
        const text = String(args.message || "").trim()
        if (!text) {
          response = { ...base, ok: false, message: "message is required", errorCode: "bad_request" }
          break
        }
        if (!request.goalID) {
          response = { ...base, ok: false, message: "goalID is required", errorCode: "bad_request" }
          break
        }
        // Bare words own turn: queued and delivered immediately as the whole
        // prompt (no steering wrapper), or queued for later when inactive.
        const sent = await goalSvc.sendUserMessage(directory, request.goalID as any, text)
        const state = await readState(directory)
        response = {
          ...base,
          ok: sent.ok,
          message: sent.message,
          stateRevision: state.revision,
        }
        break
      }

      case "abort_worker": {
        if (!request.goalID) {
          response = { ...base, ok: false, message: "goalID is required", errorCode: "bad_request" }
          break
        }
        const result = await goalSvc.abortWorker(directory, request.goalID as any)
        const state = await readState(directory)
        response = {
          ...base,
          ok: result.ok,
          message: result.message,
          stateRevision: state.revision,
        }
        break
      }

      case "force_complete": {
        const args = request.args as { summary?: string; evidence?: string }
        const state = await readState(directory)
        const goal = state.goals.find((g) => g.id === request.goalID)
        if (!goal) {
          response = { ...base, ok: false, message: "goal not found", errorCode: "not_found" }
          break
        }
        if (goal.status === "complete") {
          response = { ...base, message: `goal "${goal.name}" already complete`, stateRevision: state.revision }
          break
        }
        goal.status = "complete"
        goal.updatedAt = new Date().toISOString()
        goal.completionEvidence = {
          summary: String(args.summary || "Force-completed from dashboard."),
          evidence: String(args.evidence || "Manual override — no verification checks run."),
          at: new Date().toISOString(),
        }
        const runtime = state.runtimes.find((r) => r.goalID === goal.id)
        if (runtime) {
          Object.assign(runtime, releaseLease(runtime))
          runtime.activeRunID = undefined
          runtime.lastError = undefined
          runtime.updatedAt = new Date().toISOString()
        }
        await writeState(directory, state)
        await appendEvent(directory, {
          version: 1,
          eventID: randomUUID(),
          goalID: goal.id as any,
          type: "goal.completed",
          summary: goal.completionEvidence.summary,
          evidence: goal.completionEvidence.evidence,
          timestamp: new Date().toISOString(),
          revision: state.revision,
        })
        response = { ...base, message: `goal "${goal.name}" force-completed`, stateRevision: state.revision }
        break
      }

      case "force_block":
      case "block": {
        const args = request.args as { reason?: string; needed?: string }
        const state = await readState(directory)
        const goal = state.goals.find((g) => g.id === request.goalID)
        if (!goal) {
          response = { ...base, ok: false, message: "goal not found", errorCode: "not_found" }
          break
        }
        if (goal.status === "blocked") {
          response = { ...base, message: `goal "${goal.name}" already blocked`, stateRevision: state.revision }
          break
        }
        goal.status = "blocked"
        goal.updatedAt = new Date().toISOString()
        goal.blocker = {
          reason: String(args.reason || "Blocked from dashboard."),
          needed: String(args.needed || "User intervention required."),
          at: new Date().toISOString(),
        }
        const runtime = state.runtimes.find((r) => r.goalID === goal.id)
        if (runtime) {
          Object.assign(runtime, releaseLease(runtime))
          runtime.activeRunID = undefined
          runtime.lastError = undefined
          runtime.updatedAt = new Date().toISOString()
        }
        await writeState(directory, state)
        await appendEvent(directory, {
          version: 1,
          eventID: randomUUID(),
          goalID: goal.id as any,
          type: "goal.blocked",
          reason: goal.blocker.reason,
          needed: goal.blocker.needed,
          timestamp: new Date().toISOString(),
          revision: state.revision,
        })
        response = { ...base, message: `goal "${goal.name}" blocked`, stateRevision: state.revision }
        break
      }

      // ── Command await (explicit opt-in wake; the ONLY command→goal edge) ──
      // A goal wakes on a command's exit ONLY after an explicit await. The
      // display-only goalID linkage is unchanged: merely linked commands
      // never wake. Delivery is inbox + the existing idle-continuation path.
      case "cmd_await": {
        const args = (request.args ?? {}) as Record<string, unknown>
        const ownerSessionID = typeof args.ownerSessionID === "string" ? args.ownerSessionID : ""
        if (!ownerSessionID || ownerSessionID === "main") {
          response = { ...base, ok: false, message: "ownerSessionID is required for command operations", errorCode: "no_session" }
          break
        }
        const goalID = typeof args.goalID === "string" ? args.goalID : ""
        const commandID = typeof args.commandID === "string" && args.commandID
          ? String(args.commandID)
          : String(request.goalID || "")
        if (!goalID || !commandID) {
          response = { ...base, ok: false, message: "goalID and commandID are required", errorCode: "bad_request" }
          break
        }
        const result = await requestCommandAwait(directory, { goalID, commandID, ownerSessionID })
        if (result.ok && result.fired && result.active) {
          await wakeGoalForAwait(directory, goalSvc, goalID as any).catch(() => {})
        }
        const state = await readState(directory)
        response = {
          ...base,
          ok: result.ok,
          message: result.message,
          stateRevision: state.revision,
          errorCode: result.ok ? undefined : "await_failed",
        }
        break
      }

      // ── Command sessions (standalone; never touch goals) ──────────────
      case "cmd_start":
      case "cmd_write":
      case "cmd_interrupt":
      case "cmd_terminate":
      case "cmd_remove":
      case "cmd_resize": {
        const cmdSvc = options.commandService
        if (!cmdSvc) {
          response = {
            requestID: request.requestID,
            ok: false,
            message: `command "${request.command}" unavailable (command service not initialized)`,
            errorCode: "unavailable",
            completedAt: new Date().toISOString(),
          }
          break
        }
        const args = (request.args ?? {}) as Record<string, unknown>
        const ownerSessionID = typeof args.ownerSessionID === "string" ? args.ownerSessionID : ""
        // The local control bus is not an authentication boundary. Require the
        // selected session explicitly so the TUI cannot accidentally cross
        // session ownership; autonomous agent starts use OpenCode permission.
        if (!ownerSessionID || ownerSessionID === "main") {
          response = { ...base, ok: false, message: "ownerSessionID is required for command operations", errorCode: "no_session" }
          break
        }
        try {
          if (request.command === "cmd_start") {
            const session = await cmdSvc.start(directory, {
              title: String(args.title || "command"),
              command: String(args.command || ""),
              args: Array.isArray(args.cmdArgs) ? (args.cmdArgs as string[]) : [],
              cwd: typeof args.cwd === "string" ? args.cwd : undefined,
              ownerSessionID,
              goalID: typeof args.goalID === "string" ? args.goalID : undefined,
              cols: typeof args.cols === "number" ? args.cols : undefined,
              rows: typeof args.rows === "number" ? args.rows : undefined,
            })
            const state = await readState(directory)
            response = { ...base, message: `command "${session.title}" started (${session.id.slice(0, 8)}...)`, stateRevision: state.revision }
          } else {
            const id = String(args.commandID || request.goalID || "")
            if (!id) {
              response = { ...base, ok: false, message: "commandID is required", errorCode: "bad_request" }
              break
            }
            if (request.command === "cmd_write") {
              const r = await cmdSvc.write(directory, id, ownerSessionID, String(args.input ?? ""))
              const state = await readState(directory)
              response = { ...base, ok: r.ok, message: r.message, stateRevision: state.revision }
            } else if (request.command === "cmd_interrupt") {
              const r = await cmdSvc.interrupt(directory, id, ownerSessionID)
              const state = await readState(directory)
              response = { ...base, ok: r.ok, message: r.message, stateRevision: state.revision }
            } else if (request.command === "cmd_terminate") {
              const r = await cmdSvc.terminate(directory, id, ownerSessionID)
              const state = await readState(directory)
              response = { ...base, ok: r.ok, message: r.message, stateRevision: state.revision }
            } else if (request.command === "cmd_remove") {
              const r = await cmdSvc.remove(directory, id, ownerSessionID)
              const state = await readState(directory)
              response = { ...base, ok: r.ok, message: r.message, stateRevision: state.revision }
            } else {
              const r = await cmdSvc.resize(directory, id, ownerSessionID, Number(args.cols), Number(args.rows))
              const state = await readState(directory)
              response = { ...base, ok: r.ok, message: r.message, stateRevision: state.revision }
            }
          }
        } catch (error) {
          response = { ...base, ok: false, message: error instanceof Error ? error.message : String(error), errorCode: "command_failed" }
        }
        break
      }

      default: {
        response = {
          requestID: request.requestID,
          ok: false,
          message: `command "${request.command}" not implemented in worker`,
          errorCode: "unknown_command",
          completedAt: new Date().toISOString(),
        }
      }
    }

    // Record in command ledger
    await recordInLedger(directory, request)

    return response
  }

  async function recordInLedger(directory: string, request: ControlRequest) {
    await mutateState(directory, `control.ledger:${request.requestID}`, async (state) => {
      if (!state.commandLedger) state.commandLedger = []
      if (state.commandLedger.some((entry) => entry.requestID === request.requestID)) return state
      state.commandLedger.push({
        requestID: request.requestID,
        command: request.command,
        goalID: request.goalID,
        acceptedAt: request.requestedAt,
        completedAt: new Date().toISOString(),
      })
      if (state.commandLedger.length > MAX_LEDGER_SIZE) {
        state.commandLedger = state.commandLedger.slice(-MAX_LEDGER_SIZE)
      }
      return state
    })
  }

  return { start, stop: async () => { await stop() }, isRunning: () => running }
}
