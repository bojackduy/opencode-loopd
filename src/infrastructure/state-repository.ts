// ─── Infrastructure: State Repository ────────────────────────────────────────
// Single source of truth for all state mutations.
// Provides locking, validation, migration, and transactional mutations.

import { promises as fs } from "fs"
import path from "path"
import os from "os"
import { randomUUID } from "crypto"
import type { Goal, GoalID } from "../domain/goal"
import type { GoalRuntimeState } from "../domain/runtime"

const CURRENT_VERSION = 2

export interface StoreState {
  version: number
  revision: number
  goals: Goal[]
  runtimes: GoalRuntimeState[]
  /** Command ledger for idempotency. Bounded to last 100 entries. */
  commandLedger?: CommandLedgerEntry[]
}

export interface CommandLedgerEntry {
  requestID: string
  command: string
  goalID?: string
  acceptedAt: string
  completedAt?: string
}

function emptyState(): StoreState {
  return { version: CURRENT_VERSION, revision: 0, goals: [], runtimes: [], commandLedger: [] }
}

function loopDir(directory: string): string {
  return path.join(directory, ".opencode", "loopd")
}

function stateFile(directory: string): string {
  return path.join(loopDir(directory), "state.json")
}

function eventsFile(directory: string): string {
  return path.join(loopDir(directory), "events.ndjson")
}

function lockDir(directory: string): string {
  // Lock files go in /tmp, not inside the project, to avoid snapshot noise
  const projectHash = Buffer.from(directory).toString("base64url").slice(0, 32)
  return path.join(os.tmpdir(), "loopd-locks", projectHash)
}

function lockFile(directory: string, key: string): string {
  return path.join(lockDir(directory), `${key}.lock`)
}

// ─── Locking ─────────────────────────────────────────────────────────────────

interface LockMeta {
  pid: number
  operation: string
  acquiredAt: string
}

const LOCK_TIMEOUT_MS = 30_000
const LOCK_STALE_MS = 10_000

async function acquireLock(directory: string, key: string, operation: string): Promise<void> {
  const dir = lockDir(directory)
  await fs.mkdir(dir, { recursive: true })

  const lockPath = lockFile(directory, key)
  const lockID = randomUUID()

  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      // Check for stale lock
      try {
        const raw = await fs.readFile(lockPath, "utf8")
        const meta: LockMeta = JSON.parse(raw)
        const age = Date.now() - Date.parse(meta.acquiredAt)
        if (age > LOCK_STALE_MS) {
          // Stale lock — remove it
          await fs.rm(lockPath, { force: true })
        }
      } catch {}

      // Try to create the lock file exclusively
      const temp = lockPath + `.${lockID}.tmp`
      const meta: LockMeta = { pid: process.pid, operation, acquiredAt: new Date().toISOString() }
      await fs.writeFile(temp, JSON.stringify(meta), "utf8")
      try {
        await fs.rename(temp, lockPath)
        return // Lock acquired
      } catch (error: any) {
        await fs.rm(temp, { force: true })
        if (error?.code !== "EEXIST") throw error
      }
    } catch (error: any) {
      if (error?.code === "ENOENT") {
        await fs.mkdir(dir, { recursive: true })
        continue
      }
      throw error
    }
    await delay(25 * (attempt + 1))
  }
  throw new Error(`failed to acquire lock "${key}" for "${operation}" after retries`)
}

async function releaseLock(directory: string, key: string): Promise<void> {
  try {
    await fs.rm(lockFile(directory, key), { force: true })
  } catch {}
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
        return migrate(parsed as StoreState)
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

// ─── Migration ───────────────────────────────────────────────────────────────

function migrate(state: StoreState): StoreState {
  if (state.version === CURRENT_VERSION) return state

  let result = { ...state }

  if (result.version < 2) {
    result.version = 2
    // Ensure commandLedger exists
    if (!result.commandLedger) result.commandLedger = []
    // Ensure runtime progressDuringTurn exists
    result.runtimes = result.runtimes.map((rt) => ({
      ...rt,
      progressDuringTurn: (rt as any).progressDuringTurn ?? false,
    }))
    // Ensure goal progress/blocker fields exist
    result.goals = result.goals.map((g) => ({
      ...g,
      lastProgress: (g as any).lastProgress ?? undefined,
      completionEvidence: (g as any).completionEvidence ?? undefined,
      blocker: (g as any).blocker ?? undefined,
    }))
  }

  return result
}

// ─── Write ───────────────────────────────────────────────────────────────────

async function writeAtomic(target: string, contents: string): Promise<void> {
  const dir = path.dirname(target)
  await fs.mkdir(dir, { recursive: true })

  // Write temp file in the same directory as target for safe rename
  const temp = path.join(
    dir,
    `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
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

// ─── Transactional Mutation ──────────────────────────────────────────────────

export async function mutateState(
  directory: string,
  description: string,
  fn: (state: StoreState) => Promise<StoreState>,
): Promise<StoreState> {
  await acquireLock(directory, "state", description)
  try {
    const state = await readState(directory)
    const next = await fn(state)
    await writeState(directory, next)
    return next
  } finally {
    await releaseLock(directory, "state")
  }
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
        await fs.rename(processingPath, requestPath)
        recovered.push(request)
      } catch {}
    }
    return recovered
  } catch {
    return []
  }
}

// ─── Goal Artifact Directory ─────────────────────────────────────────────────

export function goalArtifactDir(directory: string, goalID: string): string {
  return path.join(loopDir(directory), "goals", goalID)
}

export async function ensureGoalArtifactDir(directory: string, goalID: string): Promise<string> {
  const dir = goalArtifactDir(directory, goalID)
  await fs.mkdir(dir, { recursive: true })
  return dir
}

// ─── Goal Inbox ─────────────────────────────────────────────────────────────

interface GoalInboxMessage {
  from: "user" | "worker"
  text: string
  at: string
}

function inboxFile(directory: string, goalID: string): string {
  return path.join(loopDir(directory), "inboxes", `${goalID}.jsonl`)
}

export async function appendGoalInbox(
  directory: string,
  goalID: string,
  from: "user" | "worker",
  text: string,
): Promise<void> {
  const dir = path.join(loopDir(directory), "inboxes")
  await fs.mkdir(dir, { recursive: true })
  const msg: GoalInboxMessage = { from, text, at: new Date().toISOString() }
  await fs.appendFile(inboxFile(directory, goalID), JSON.stringify(msg) + "\n", "utf8")
}

export async function drainGoalInbox(
  directory: string,
  goalID: string,
): Promise<string[]> {
  const file = inboxFile(directory, goalID)
  try {
    const raw = await fs.readFile(file, "utf8")
    const lines = raw.trim().split("\n").filter(Boolean)
    if (lines.length === 0) return []
    const messages = lines.map((l) => JSON.parse(l) as GoalInboxMessage)
    // Delete the file after draining
    await fs.rm(file, { force: true })
    return messages.map((m) => `[${m.from}] ${m.text}`)
  } catch {
    return []
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
