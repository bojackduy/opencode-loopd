// ─── Infrastructure: State Store ─────────────────────────────────────────────
// Atomic, revisioned JSON persistence for goal + runtime state.
// Single state.json per project, NDJSON event log alongside.

import { promises as fs } from "fs"
import path from "path"
import os from "os"
import type { Goal } from "../domain/goal"
import type { GoalRuntimeState } from "../domain/runtime"

const STATE_VERSION = 1

export interface StoreState {
  version: number
  revision: number
  goals: Goal[]
  runtimes: GoalRuntimeState[]
}

function emptyState(): StoreState {
  return { version: STATE_VERSION, revision: 0, goals: [], runtimes: [] }
}

const EMPTY_STATE: StoreState = emptyState()

function loopDir(directory: string): string {
  return path.join(directory, ".opencode", "loopd")
}

function stateFile(directory: string): string {
  return path.join(loopDir(directory), "state.json")
}

function eventsFile(directory: string): string {
  return path.join(loopDir(directory), "events.ndjson")
}

// ─── Read ────────────────────────────────────────────────────────────────────

export async function readState(directory: string): Promise<StoreState> {
  const target = stateFile(directory)
  const attempts = 5
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const raw = await fs.readFile(target, "utf8")
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === "object" && Array.isArray(parsed.goals)) {
        return parsed as StoreState
      }
      return emptyState()
    } catch (error: any) {
      if (error?.code === "ENOENT") return emptyState()
      const transient =
        error instanceof SyntaxError ||
        error?.code === "EPERM" ||
        error?.code === "EACCES" ||
        error?.code === "EBUSY"
      if (!transient || attempt === attempts - 1) break
      await delay(25 * (attempt + 1))
    }
  }
  return emptyState()
}

// ─── Write ───────────────────────────────────────────────────────────────────

async function writeAtomic(target: string, contents: string): Promise<void> {
  const dir = path.dirname(target)
  await fs.mkdir(dir, { recursive: true })
  const temp = path.join(
    os.tmpdir(),
    `loopd-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`,
  )
  await fs.writeFile(temp, contents, "utf8")
  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await fs.rename(temp, target)
        return
      } catch (error: any) {
        if (error?.code === "EXDEV") break
        if (
          error?.code !== "EPERM" &&
          error?.code !== "EACCES" &&
          error?.code !== "EBUSY" &&
          error?.code !== "EEXIST" &&
          error?.code !== "EAGAIN"
        )
          throw error
        if (attempt < 4) await delay(25 * (attempt + 1))
      }
    }
    await fs.copyFile(temp, target)
  } finally {
    try { await fs.rm(temp, { force: true }) } catch {}
  }
}

export async function writeState(
  directory: string,
  state: StoreState,
): Promise<void> {
  state.revision += 1
  const payload = JSON.stringify(state, null, 2)
  await writeAtomic(stateFile(directory), payload)
}

// ─── Events Log ──────────────────────────────────────────────────────────────

export async function appendEvent(
  directory: string,
  event: unknown,
): Promise<void> {
  await fs.mkdir(loopDir(directory), { recursive: true })
  const line = JSON.stringify(event as object) + "\n"
  await fs.appendFile(eventsFile(directory), line, "utf8")
}

export async function readEvents(
  directory: string,
  limit = 50,
): Promise<Record<string, unknown>[]> {
  try {
    const raw = await fs.readFile(eventsFile(directory), "utf8")
    const lines = raw.trim().split("\n").filter(Boolean)
    return lines.slice(-limit).map((l) => JSON.parse(l) as Record<string, unknown>)
  } catch {
    return []
  }
}

// ─── Control Mailbox ─────────────────────────────────────────────────────────

export interface ControlRequest {
  requestID: string
  command: string
  goalID?: string
  args?: Record<string, unknown>
  requestedAt: string
}

export interface ControlResponse {
  requestID: string
  ok: boolean
  message: string
  stateRevision?: number
  errorCode?: string
  completedAt: string
}

function controlDir(directory: string): string {
  return path.join(loopDir(directory), "control")
}

function requestFile(directory: string, requestID: string): string {
  return path.join(controlDir(directory), "requests", `${requestID}.json`)
}

function processingFile(directory: string, requestID: string): string {
  return path.join(controlDir(directory), "processing", `${requestID}.json`)
}

function responseFile(directory: string, requestID: string): string {
  return path.join(controlDir(directory), "responses", `${requestID}.json`)
}

export async function writeControlRequest(
  directory: string,
  request: ControlRequest,
): Promise<void> {
  const dir = path.join(controlDir(directory), "requests")
  await fs.mkdir(dir, { recursive: true })
  await writeAtomic(requestFile(directory, request.requestID), JSON.stringify(request, null, 2))
}

export async function readControlRequest(
  directory: string,
  requestID: string,
): Promise<ControlRequest | undefined> {
  try {
    const raw = await fs.readFile(requestFile(directory, requestID), "utf8")
    return JSON.parse(raw) as ControlRequest
  } catch {
    return undefined
  }
}

export async function claimControlRequest(
  directory: string,
  requestID: string,
): Promise<boolean> {
  const src = requestFile(directory, requestID)
  const dst = processingFile(directory, requestID)
  try {
    await fs.mkdir(path.dirname(dst), { recursive: true })
    await fs.rename(src, dst)
    return true
  } catch {
    return false
  }
}

export async function writeControlResponse(
  directory: string,
  response: ControlResponse,
): Promise<void> {
  const dir = path.join(controlDir(directory), "responses")
  await fs.mkdir(dir, { recursive: true })
  await writeAtomic(responseFile(directory, response.requestID), JSON.stringify(response, null, 2))
  // Clean up processing file
  try { await fs.rm(processingFile(directory, response.requestID), { force: true }) } catch {}
}

export async function readControlResponse(
  directory: string,
  requestID: string,
): Promise<ControlResponse | undefined> {
  try {
    const raw = await fs.readFile(responseFile(directory, requestID), "utf8")
    return JSON.parse(raw) as ControlResponse
  } catch {
    return undefined
  }
}

export async function listPendingRequests(directory: string): Promise<ControlRequest[]> {
  const dir = path.join(controlDir(directory), "requests")
  try {
    const files = await fs.readdir(dir)
    const requests: ControlRequest[] = []
    for (const file of files) {
      if (!file.endsWith(".json")) continue
      try {
        const raw = await fs.readFile(path.join(dir, file), "utf8")
        requests.push(JSON.parse(raw) as ControlRequest)
      } catch {}
    }
    return requests.sort((a, b) => a.requestedAt.localeCompare(b.requestedAt))
  } catch {
    return []
  }
}

export async function recoverStaleProcessing(directory: string): Promise<ControlRequest[]> {
  const dir = path.join(controlDir(directory), "processing")
  try {
    const files = await fs.readdir(dir)
    const recovered: ControlRequest[] = []
    for (const file of files) {
      if (!file.endsWith(".json")) continue
      const processingPath = path.join(dir, file)
      const requestPath = path.join(controlDir(directory), "requests", file)
      try {
        const raw = await fs.readFile(processingPath, "utf8")
        const request = JSON.parse(raw) as ControlRequest
        // Move back to requests
        await fs.rename(processingPath, requestPath)
        recovered.push(request)
      } catch {}
    }
    return recovered
  } catch {
    return []
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
