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

    await writeControlRequest(directory, request)

    // Poll for response
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const response = await readControlResponse(directory, request.requestID)
      if (response) return response
      await delay(100)
    }

    // Final re-read: a response may have landed inside the last poll window.
    // A late server reply still lands in responses/<requestID>.json afterwards,
    // but this call already timed out — the retry uses a NEW requestID, so a
    // late reply never double-applies to the retry (ledger dedups by the
    // ORIGINAL requestID only).
    const late = await readControlResponse(directory, request.requestID).catch(() => undefined)
    if (late) return late

    // Stage-aware timeout: distinguish "server never picked it up" (server
    // down or poll wedged) from "accepted and still running" (slow/blocked
    // handler — the operation may complete later; do not blindly retry
    // non-idempotent commands, check the server log first).
    let stage = "not yet accepted by the server"
    try {
      const claimed = await statProcessingRequest(directory, request.requestID)
      if (claimed) {
        stage = `accepted by the server ${(claimed.requestAgeMs / 1000).toFixed(1)}s ago, still processing — ` +
          `the operation may complete later (late reply under this requestID); ` +
          `check the server log before retrying`
      }
    } catch {
      // Stage probe is best-effort; the timeout below is still accurate.
    }

    return {
      requestID: request.requestID,
      ok: false,
      message: `timeout waiting for response (${stage})`,
      errorCode: "timeout",
      completedAt: new Date().toISOString(),
    }
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
