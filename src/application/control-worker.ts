// ─── Application: Control Worker ─────────────────────────────────────────────
// Server-side: watches for control requests, processes them, writes responses.
// Integrates with GoalService for real goal lifecycle.
// Supports idempotency via command ledger and response caching.

import { promises as fs } from "fs"
import path from "path"
import {
  listPendingRequests,
  claimControlRequest,
  writeControlResponse,
  readControlResponse,
  recoverStaleProcessing,
  readState,
  writeState,
  appendEvent,
  type ControlRequest,
  type ControlResponse,
} from "../infrastructure/state-repository"
import { createGoalService, type GoalService } from "./goal-service"
import type { LoopHost } from "../server/host-adapter"

const MAX_LEDGER_SIZE = 100
const RESPONSE_CLEANUP_AGE_MS = 60 * 60 * 1000 // 1 hour

export interface ControlWorkerOptions {
  directory: string
  host: LoopHost
  pollIntervalMs?: number
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
  const goalSvc: GoalService = createGoalService(options.host)

  let running = false
  let pollTimer: ReturnType<typeof setInterval> | undefined
  let processing = new Set<string>()
  let lastProcessDone = true

  function start() {
    if (running) return
    running = true
    // Process immediately on start, then activate interval if needed
    processPending()
    pollTimer = setInterval(() => {
      if (running && lastProcessDone) {
        lastProcessDone = false
        processPending().then(() => { lastProcessDone = true })
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
        const response: ControlResponse = {
          requestID: request.requestID,
          ok: false,
          message: `internal error: ${error instanceof Error ? error.message : String(error)}`,
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
        const { goal } = await goalSvc.start(directory, {
          name: args.name,
          objective: args.objective,
          ownerSessionID: args.ownerSessionID || "main",
          config: args.config,
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
    const state = await readState(directory)
    if (!state.commandLedger) state.commandLedger = []

    state.commandLedger.push({
      requestID: request.requestID,
      command: request.command,
      goalID: request.goalID,
      acceptedAt: request.requestedAt,
      completedAt: new Date().toISOString(),
    })

    // Trim to max size
    if (state.commandLedger.length > MAX_LEDGER_SIZE) {
      state.commandLedger = state.commandLedger.slice(-MAX_LEDGER_SIZE)
    }

    await writeState(directory, state)
  }

  return { start, stop: async () => { await stop() }, isRunning: () => running }
}
