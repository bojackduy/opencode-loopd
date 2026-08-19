// ─── Infrastructure: Control Client ──────────────────────────────────────────
// TUI-side: writes control requests, polls for responses, subscribes to events.

import { randomUUID } from "crypto"
import {
  writeControlRequest,
  readControlResponse,
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
    const request: ControlRequest = {
      requestID: command.requestID,
      command: command.command,
      goalID: command.goalID,
      args: "args" in command ? (command as any).args : undefined,
      requestedAt: command.requestedAt,
    }

    await writeControlRequest(directory, request)

    // Poll for response
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const response = await readControlResponse(directory, request.requestID)
      if (response) return response
      await delay(100)
    }

    return {
      requestID: request.requestID,
      ok: false,
      message: "timeout waiting for response",
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

  return { execute, getState, getEvents }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
