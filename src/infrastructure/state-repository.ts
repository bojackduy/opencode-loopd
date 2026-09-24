// ─── Infrastructure: State Repository ────────────────────────────────────────
// Single source of truth for all state mutations.
// Provides locking, validation, migration, and transactional mutations.

import { promises as fs } from "fs"
import path from "path"
import os from "os"

import type { Goal, GoalID } from "../domain/goal"
import type { GoalRuntimeState } from "../domain/runtime"
import type { CommandSession } from "../domain/command-session"
import type { CommandAwait } from "../domain/command-await"

const CURRENT_VERSION = 9

export interface StoreState {
  version: number
  revision: number
  goals: Goal[]
  runtimes: GoalRuntimeState[]
  /** Command ledger for idempotency. Bounded to last 100 entries. */
  commandLedger?: CommandLedgerEntry[]
  /** Standalone command sessions (metadata only — never handles/screens). */
  commands?: CommandSession[]
  /**
   * Outstanding opt-in goal awaits for command exits (IDs only — never output
   * bytes). Consumed exactly once when the awaited command reaches a terminal
   * status; cancelled when the goal pauses/clears or the command is removed.
   */
  commandAwaits?: CommandAwait[]
}

export interface CommandLedgerEntry {
  requestID: string
  command: string
  goalID?: string
  acceptedAt: string
  completedAt?: string
}

function emptyState(): StoreState {
  return { version: CURRENT_VERSION, revision: 0, goals: [], runtimes: [], commandLedger: [], commands: [] }
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

      // Try to create the lock file exclusively — "wx" fails with EEXIST if it exists
      const meta: LockMeta = { pid: process.pid, operation, acquiredAt: new Date().toISOString() }
      const fd = await fs.open(lockPath, "wx")
      try {
        await fd.writeFile(JSON.stringify(meta), "utf8")
      } finally {
        await fd.close()
      }
      return // Lock acquired
    } catch (error: any) {
      if (error?.code === "EEXIST") {
        // Lock held by another process — retry
      } else if (error?.code === "ENOENT") {
        await fs.mkdir(dir, { recursive: true })
        continue
      } else {
        throw error
      }
    }
    await delay(25 * (attempt + 1))
  }
  throw new Error(`failed to acquire lock "${key}" for "${operation}" after retries`)
}

async function releaseLock(directory: string, key: string): Promise<void> {
  const lockPath = lockFile(directory, key)
  try {
    const raw = await fs.readFile(lockPath, "utf8")
    const meta: LockMeta = JSON.parse(raw)
    // Only release if we own the lock (same PID) or it's stale
    const age = Date.now() - Date.parse(meta.acquiredAt)
    const shouldRelease = meta.pid === process.pid || age > LOCK_STALE_MS
    if (!shouldRelease) return
    // Re-verify before delete to avoid racing with a fresh acquirer
    try {
      const raw2 = await fs.readFile(lockPath, "utf8")
      const meta2: LockMeta = JSON.parse(raw2)
      if (meta2.acquiredAt !== meta.acquiredAt || meta2.pid !== meta.pid) return
    } catch {
      return
    }
    await fs.rm(lockPath, { force: true })
  } catch {
    // Lock file doesn't exist or is unreadable — nothing to release
  }
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

  if (result.version < 3) {
    result.version = 3
    // Migrate turnCount -> budgetTurnCount + runGeneration
    result.runtimes = result.runtimes.map((rt: any) => {
      const oldTurnCount = rt.turnCount ?? 0
      const { turnCount: _deprecatedTurnCount, ...rest } = rt
      void _deprecatedTurnCount
      return {
        ...rest,
        budgetTurnCount: (rest as any).budgetTurnCount ?? oldTurnCount,
        runCount: (rest as any).runCount ?? oldTurnCount,
        runGeneration: (rest as any).runGeneration ?? 0,
        freeRetryPending: (rest as any).freeRetryPending ?? false,
        lastRejectionDetails: (rest as any).lastRejectionDetails ?? undefined,
        activePromptMessageID: (rest as any).activePromptMessageID ?? undefined,
        lastActivityAt: (rest as any).lastActivityAt ?? undefined,
        idleCandidateAt: (rest as any).idleCandidateAt ?? undefined,
        activeToolCallIDs: (rest as any).activeToolCallIDs ?? [],
      }
    })
  }

  if (result.version < 4) {
    result.version = 4
    // Add verification attempt fields to runtimes
    result.runtimes = result.runtimes.map((rt: any) => ({
      ...rt,
      lastVerificationAttempt: rt.lastVerificationAttempt ?? undefined,
      recentVerificationAttempts: rt.recentVerificationAttempts ?? [],
    }))
  }

  if (result.version < 5) {
    result.version = 5
    result.goals = result.goals.map((goal: any) => ({
      ...goal,
      config: {
        ...goal.config,
        // Legacy goals did not classify workspace access. Conservatively
        // serialize them until they complete or are recreated explicitly.
        workspaceWrite: goal.config?.workspaceWrite ?? true,
      },
    }))
    result.runtimes = result.runtimes.map((rt: any) => ({
      ...rt,
      activePromptObservedAt: rt.activePromptObservedAt ?? undefined,
      activeAssistantMessageID: rt.activeAssistantMessageID ?? undefined,
      activeAssistantCompletedAt: rt.activeAssistantCompletedAt ?? undefined,
      idleCandidateGeneration: rt.idleCandidateGeneration ?? undefined,
      unknownStatusCount: rt.unknownStatusCount ?? 0,
      lastUnknownStatusAt: rt.lastUnknownStatusAt ?? undefined,
      workerUnreachableNotifiedAt: rt.workerUnreachableNotifiedAt ?? undefined,
    }))
  }

  if (result.version < 6) {
    result.version = 6
    result.goals = result.goals.map((goal: any) => ({
      ...goal,
      config: {
        ...goal.config,
        schedule: goal.config?.schedule ?? undefined,
      },
    }))
    // Validate schedule shape for legacy data
    result.goals = result.goals.map((goal: any) => {
      const s = goal.config?.schedule
      if (s && typeof s.everyMs === "number" && s.everyMs >= 1000) return goal
      if (s) {
        const { schedule: _s, ...restConfig } = goal.config
        void _s
        return { ...goal, config: restConfig }
      }
      return goal
    })
    result.runtimes = result.runtimes.map((rt: any) => ({
      ...rt,
      scheduleRunCount: typeof rt.scheduleRunCount === "number" ? rt.scheduleRunCount : 0,
      nextRunAt: rt.nextRunAt ?? undefined,
      lastScheduleAt: rt.lastScheduleAt ?? undefined,
    }))
  }

  if (result.version < 7) {
    result.version = 7
    // Command sessions are new in v7. Never synthesize them: only ensure the
    // array exists so readers can treat it as authoritative.
    if (!Array.isArray((result as any).commands)) (result as any).commands = []
  }

  if (result.version < 8) {
    result.version = 8
    // Opt-in command awaits are new in v8. IDs only — never synthesize entries
    // on migrate; only ensure the array exists.
    if (!Array.isArray((result as any).commandAwaits)) (result as any).commandAwaits = []
  }

  if (result.version < 9) {
    result.version = 9
    // v2-native worker topology is new in v9. Additive optionals only: leave
    // existing goals without topology metadata (absent = legacy / unknown),
    // so reconcile/restart keeps prior behavior for pre-bridge goals.
    result.goals = result.goals.map((goal: any) => ({
      ...goal,
      workerTopology: goal.workerTopology ?? undefined,
      nativeParentID: goal.nativeParentID ?? undefined,
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

export async function peekGoalInbox(
  directory: string,
  goalID: string,
): Promise<string[]> {
  const file = inboxFile(directory, goalID)
  try {
    const raw = await fs.readFile(file, "utf8")
    const lines = raw.trim().split("\n").filter(Boolean)
    if (lines.length === 0) return []
    const messages = lines.map((l) => JSON.parse(l) as GoalInboxMessage)
    return messages.map((m) => `[${m.from}] ${m.text}`)
  } catch {
    return []
  }
}

// ─── Command Session Output Logs ─────────────────────────────────────────────
// Per-command byte-stream logs so cross-process readers (TUI) can replay
// output without access to the server's in-memory handles. Bounded: when the
// file exceeds twice the retain budget, the oldest half is dropped and the
// session is flagged truncated.

export function commandLogFile(directory: string, commandID: string): string {
  return path.join(loopDir(directory), "commands", `${commandID}.log`)
}

export async function appendCommandLog(
  directory: string,
  commandID: string,
  chunk: string,
): Promise<void> {
  const file = commandLogFile(directory, commandID)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.appendFile(file, chunk, "utf8")
}

export async function readCommandLog(
  directory: string,
  commandID: string,
  opts?: { offsetBytes?: number; limitBytes?: number },
): Promise<{ text: string; totalBytes: number; startByte: number }> {
  const file = commandLogFile(directory, commandID)
  try {
    const stat = await fs.stat(file)
    const totalBytes = stat.size
    const requestedStart = Math.max(0, opts?.offsetBytes ?? 0)
    if (requestedStart >= totalBytes) return { text: "", totalBytes, startByte: requestedStart }
    const fh = await fs.open(file, "r")
    try {
      const want = Math.min(opts?.limitBytes ?? 64 * 1024, totalBytes - requestedStart)
      const buf = Buffer.alloc(want)
      await fh.read(buf, 0, want, requestedStart)
      // UTF-8 boundary safety: an arbitrary byte window may split a
      // multi-byte sequence at either edge. buf.toString("utf8") would then
      // emit U+FFFD replacements whose re-encoded byte length differs from
      // the bytes consumed — breaking lifetime offset arithmetic downstream.
      // Trim to complete sequences so the invariant
      // utf8ByteLength(text) === (endByte - startByte) always holds.
      const { text, startByte, endByte } = decodeUtf8Window(buf, requestedStart)
      void endByte
      return { text, totalBytes, startByte }
    } finally {
      await fh.close()
    }
  } catch {
    return { text: "", totalBytes: 0, startByte: 0 }
  }
}

/**
 * Decode a raw byte window to a string containing only complete UTF-8
 * sequences. Leading bytes that continue a sequence started before the
 * window are skipped (startByte advances); a trailing incomplete sequence
 * is trimmed. Returned startByte is the file offset of the first decoded
 * byte, so callers can compute absolute offsets as
 * startByte + utf8ByteLength(text).
 */
export function decodeUtf8Window(
  buf: Buffer,
  windowStart: number,
): { text: string; startByte: number; endByte: number } {
  let start = 0
  // Skip leading continuation bytes (10xxxxxx): they belong to a character
  // that starts before this window. At most 3 can lead a window.
  while (start < buf.length && (buf[start]! & 0xc0) === 0x80 && start < 4) start++
  let end = buf.length
  // Trim a trailing incomplete sequence: scan back over continuation bytes
  // to the lead byte, then check whether the sequence is complete.
  let leadIndex = end
  while (leadIndex > start && (buf[leadIndex - 1]! & 0xc0) === 0x80) leadIndex--
  if (leadIndex > start) {
    const lead = buf[leadIndex - 1]!
    let expected = 1
    if ((lead & 0x80) === 0) expected = 1
    else if ((lead & 0xe0) === 0xc0) expected = 2
    else if ((lead & 0xf0) === 0xe0) expected = 3
    else if ((lead & 0xf8) === 0xf0) expected = 4
    if (end - (leadIndex - 1) < expected) end = leadIndex - 1
  } else if (leadIndex === start && start > 0 && end > start) {
    // Window is all continuation bytes with no lead: nothing decodable.
    // (start > 0 means we already skipped leading continuations.)
    end = start
  }
  const slice = buf.subarray(start, end)
  return { text: slice.toString("utf8"), startByte: windowStart + start, endByte: windowStart + end }
}

export async function removeCommandLog(directory: string, commandID: string): Promise<void> {
  try {
    await fs.rm(commandLogFile(directory, commandID), { force: true })
  } catch {}
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
