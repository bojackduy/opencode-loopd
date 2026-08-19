// ─── Application: Control Worker ─────────────────────────────────────────────
// Server-side: watches for control requests, processes them, writes responses.
// Integrates with GoalService for real goal lifecycle.

import { promises as fs } from "fs"
import path from "path"
import {
  listPendingRequests,
  claimControlRequest,
  writeControlResponse,
  recoverStaleProcessing,
  readState,
  writeState,
  appendEvent,
  type ControlRequest,
  type ControlResponse,
} from "../infrastructure/state-store"
import { createControlService, type ControlService } from "./control-service"
import { createGoalService, type GoalService } from "./goal-service"
import type { LoopCommand } from "../domain/commands"
import type { LoopHost } from "../server/host-adapter"
import type { LoopEvent } from "../domain/events"
import { randomUUID } from "crypto"

export interface ControlWorkerOptions {
  directory: string
  host: LoopHost
  pollIntervalMs?: number
  onRequest?: (request: ControlRequest) => void
  onResponse?: (response: ControlResponse) => void
}

export interface ControlWorker {
  start(): void
  stop(): void
  isRunning(): boolean
}

export function createControlWorker(options: ControlWorkerOptions): ControlWorker {
  const directory = options.directory
  const pollMs = options.pollIntervalMs ?? 500
  const goalSvc: GoalService = createGoalService(options.host)

  let running = false
  let pollTimer: ReturnType<typeof setInterval> | undefined
  let processing = new Set<string>()

  function start() {
    if (running) return
    running = true
    recoverStaleProcessing(directory).catch(() => {})
    pollTimer = setInterval(() => {
      if (running) processPending()
    }, pollMs)
  }

  function stop() {
    running = false
    if (pollTimer) clearInterval(pollTimer)
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
    const base = {
      requestID: request.requestID,
      ok: true as boolean,
      message: "" as string,
      stateRevision: undefined as number | undefined,
      errorCode: undefined as string | undefined,
      completedAt: new Date().toISOString(),
    }

    switch (request.command) {
      case "start": {
        const args = request.args as { name: string; objective: string; config?: any }
        const { goal } = await goalSvc.start(directory, {
          name: args.name,
          objective: args.objective,
          ownerSessionID: "main",
          config: args.config,
        })
        const state = await readState(directory)
        return {
          ...base,
          message: `goal "${args.name}" created (${goal.id.slice(0, 8)}...)`,
          stateRevision: state.revision,
        }
      }

      case "pause": {
        await goalSvc.pause(directory, request.goalID as any)
        const state = await readState(directory)
        const goal = state.goals.find((g) => g.id === request.goalID)
        return {
          ...base,
          message: `goal "${goal?.name || request.goalID}" paused`,
          stateRevision: state.revision,
        }
      }

      case "resume": {
        await goalSvc.resume(directory, request.goalID as any)
        const state = await readState(directory)
        const goal = state.goals.find((g) => g.id === request.goalID)
        return {
          ...base,
          message: `goal "${goal?.name || request.goalID}" resumed`,
          stateRevision: state.revision,
        }
      }

      case "retry": {
        await goalSvc.retry(directory, request.goalID as any)
        const state = await readState(directory)
        const goal = state.goals.find((g) => g.id === request.goalID)
        return {
          ...base,
          message: `goal "${goal?.name || request.goalID}" retried`,
          stateRevision: state.revision,
        }
      }

      case "clear": {
        await goalSvc.clear(directory, request.goalID as any)
        const state = await readState(directory)
        return {
          ...base,
          message: `goal cleared`,
          stateRevision: state.revision,
        }
      }

      default: {
        // Delegate simple commands to the basic control service
        const cmd = buildBasicCommand(request)
        const svc = createControlService()
        const result = await svc.execute(directory, cmd)
        return {
          requestID: request.requestID,
          ok: result.ok,
          message: result.message,
          stateRevision: result.stateRevision,
          errorCode: result.errorCode,
          completedAt: new Date().toISOString(),
        }
      }
    }
  }

  function buildBasicCommand(request: ControlRequest): LoopCommand {
    const base = {
      version: 1 as const,
      requestID: request.requestID,
      requestedAt: request.requestedAt,
    }
    switch (request.command) {
      case "update":
        return { ...base, command: "update", goalID: request.goalID as any, args: request.args as any }
      case "inspect":
        return { ...base, command: "inspect", args: request.args as any }
      case "open_worker":
        return { ...base, command: "open_worker" }
      case "compact":
        return { ...base, command: "compact" }
      default:
        return { ...base, command: request.command as any }
    }
  }

  return { start, stop, isRunning: () => running }
}
