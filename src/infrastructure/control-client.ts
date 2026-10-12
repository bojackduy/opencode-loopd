// ─── Infrastructure: Control Client ──────────────────────────────────────────
// TUI-side: writes control requests, polls for responses, subscribes to events.

import { randomUUID } from "crypto"
import {
  writeControlRequest,
  readControlResponse,
  statProcessingRequest,
  readEvents,
  readState,
  type ControlRequest,
  type ControlResponse,
  type StoreState,
} from "./state-repository"
import type { LoopCommand } from "../domain/commands"

export interface ControlClient {
  /** Send a command and wait for the response. */
  execute(command: LoopCommand, timeoutMs?: number): Promise<ControlResponse>
  /** Send a raw control-bus command (e.g. cmd_* command-session ops). */
  executeRaw(
    command: { command: string; goalID?: string; args?: Record<string, unknown> },
    timeoutMs?: number,
  ): Promise<ControlResponse>
  /** Read current state. */
  getState(): Promise<StoreState>
  /** Read recent events. */
  getEvents(limit?: number): Promise<Record<string, unknown>[]>
}

export function createControlClient(directory: string): ControlClient {
  async function execute(
    command: LoopCommand,
    timeoutMs = 30_000,
  ): Promise<ControlResponse> {
    return executeRaw(
      {
        command: command.command,
        goalID: command.goalID,
        args: "args" in command ? (command as any).args : undefined,
      },
      timeoutMs,
    )
  }

  async function executeRaw(
    command: { command: string; goalID?: string; args?: Record<string, unknown> },
    timeoutMs = 30_000,
  ): Promise<ControlResponse> {
    const request: ControlRequest = {
      requestID: randomUUID(),
      command: command.command,
      goalID: command.goalID,
      args: command.args,
      requestedAt: new Date().toISOString(),
    }

    let submitted = false
    let expired = false
    let timeoutReply: Promise<ControlResponse> | undefined
    const deadline = performance.now() + timeoutMs

    function timedOut(): Promise<ControlResponse> {
      return timeoutReply ??= (async () => {
        // Diagnostics must not turn a bounded request into another hung I/O.
        let probeTimer: ReturnType<typeof setTimeout> | undefined
        let claimed: { requestAgeMs: number } | undefined
        try {
          claimed = await Promise.race([
            statProcessingRequest(directory, request.requestID),
            new Promise<undefined>((resolve) => { probeTimer = setTimeout(() => resolve(undefined), 100) }),
          ])
        } catch {} finally { if (probeTimer) clearTimeout(probeTimer) }
        const stage = claimed
          ? `accepted by the server ${(claimed.requestAgeMs / 1000).toFixed(1)}s ago, still processing`
          : submitted ? "request submitted; server acceptance or response could not be confirmed"
          : "request submission is still pending"
        return {
          requestID: request.requestID, ok: false, errorCode: "timeout",
          message: `timeout waiting for response (${stage}; the operation may complete later under this requestID — check the server log before retrying)`,
          completedAt: new Date().toISOString(),
        }
      })()
    }

    async function exchange(): Promise<ControlResponse> {
      await writeControlRequest(directory, request)
      submitted = true
      while (!expired && performance.now() < deadline) {
        const response = await readControlResponse(directory, request.requestID)
        if (response) return response
        if (!expired) await delay(Math.min(100, Math.max(0, deadline - performance.now())))
      }
      if (!expired) {
        const late = await readControlResponse(directory, request.requestID)
        if (late) return late
      }
      return timedOut()
    }

    // Bound the WHOLE exchange, including submission, response reads, and the
    // final read. A filesystem promise need not settle for the UI to finish.
    // Timeout is not cancellation: an already-started write may land later.
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<ControlResponse>((resolve) => {
      timer = setTimeout(() => { expired = true; void timedOut().then(resolve) }, timeoutMs)
    })
    try { return await Promise.race([exchange(), timeout]) }
    finally { expired = true; if (timer) clearTimeout(timer) }
  }

  async function getState(): Promise<StoreState> {
    return readState(directory)
  }

  async function getEvents(limit?: number): Promise<Record<string, unknown>[]> {
    return readEvents(directory, limit)
  }

  return { execute, executeRaw, getState, getEvents }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
