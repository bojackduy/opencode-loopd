// Approved command execution: the ONLY path that turns owner-configured
// authority into a process. Callers name a command; every executable detail
// comes from immutable persisted goal configuration.

import path from "node:path"
import { randomUUID } from "node:crypto"
import { spawn } from "node:child_process"
import type { ApprovedGoalCommand, Goal } from "../domain/goal"
import type { GoalRuntimeState } from "../domain/runtime"
import type { ApprovedServerRecord } from "../domain/approved-server"
import type { CommandSession, CommandSessionStatus } from "../domain/command-session"
import type { StoreState } from "../infrastructure/state-repository"
import { mutateState, readState } from "../infrastructure/state-repository"
import { DuplicateCommandError, type CommandService } from "./command-service"
import { withWorkspaceOperation } from "./workspace-execution"

export const DEFAULT_APPROVED_FINITE_TIMEOUT_SECONDS = 180
export const MAX_APPROVED_OUTPUT_BYTES = 64 * 1024

export type ApprovedCommandErrorCode =
  | "unapproved_caller"
  | "inactive_goal"
  | "unknown_approved_command"
  | "kind_mismatch"
  | "override_denied"
  | "workspace_busy"

export interface ApprovedCommandDenial {
  ok: false
  errorCode: ApprovedCommandErrorCode
  message: string
}

export interface ApprovedCommandAuthority {
  ok: true
  goal: Goal
  runtime?: GoalRuntimeState
  spec: ApprovedGoalCommand
  /** Current persisted worker generation, recorded with any managed process. */
  generation: number
}

/**
 * Resolve authority for exactly one persisted worker session. This is the
 * single authority gate; it never consults objective text or caller-supplied
 * executable details.
 */
export function resolveApprovedCommand(
  state: StoreState,
  sessionID: string | undefined,
  name: string,
  kind: ApprovedGoalCommand["kind"],
): ApprovedCommandAuthority | ApprovedCommandDenial {
  const deny = (errorCode: ApprovedCommandErrorCode, message: string): ApprovedCommandDenial => ({ ok: false, errorCode, message })
  if (!sessionID || sessionID === "main") return deny("unapproved_caller", "An active worker session is required.")
  if (state.retiredWorkerSessions?.includes(sessionID)) return deny("unapproved_caller", "Worker session is retired; goal cleared or worker rotated. Late executions are fenced.")
  const goal = state.goals.find((item) => item.workerSessionID === sessionID)
  if (!goal) return deny("unapproved_caller", "Session does not own a goal worker.")
  if (goal.status !== "active" || goal.scopeClosing || goal.scopeClearPending) {
    return deny("inactive_goal", `Worker goal is ${goal.scopeClosing ? "closing" : goal.status}, not active.`)
  }
  const spec = goal.config.approvedCommands?.find((command) => command.name === name)
  if (!spec) return deny("unknown_approved_command", `No approved command named "${name}" exists for this goal.`)
  if (spec.kind !== kind) return deny("kind_mismatch", `Approved command "${name}" is ${spec.kind}, not ${kind}.`)
  const runtime = state.runtimes.find((item) => item.goalID === goal.id)
  return { ok: true, goal, runtime, spec, generation: runtime?.runGeneration ?? 0 }
}

export class ApprovedAuthorityError extends Error {
  constructor(readonly denial: ApprovedCommandDenial) {
    super(denial.message)
    this.name = "ApprovedAuthorityError"
  }
}

export interface ApprovedFiniteResult {
  ok: boolean
  name: string
  command: string
  args: string[]
  cwd: string
  timeoutSeconds: number
  exitCode?: number
  signal?: string
  timedOut: boolean
  durationMs: number
  stdout: string
  stderr: string
  outputTruncated: boolean
  errorCode?: ApprovedCommandErrorCode
  message?: string
}

function capture(chunks: Buffer[], chunk: Buffer, state: { bytes: number; truncated: boolean }): void {
  if (state.truncated) return
  const remaining = MAX_APPROVED_OUTPUT_BYTES - state.bytes
  if (chunk.length > remaining) {
    chunks.push(chunk.subarray(0, Math.max(0, remaining)))
    state.bytes += Math.max(0, remaining)
    state.truncated = true
    return
  }
  chunks.push(chunk)
  state.bytes += chunk.length
}

function execute(
  directory: string,
  spec: ApprovedGoalCommand,
): Promise<Pick<ApprovedFiniteResult, "exitCode" | "signal" | "timedOut" | "durationMs" | "stdout" | "stderr" | "outputTruncated">> {
  const timeoutSeconds = spec.timeoutSeconds ?? DEFAULT_APPROVED_FINITE_TIMEOUT_SECONDS
  const cwd = path.resolve(directory, spec.cwd)
  const startedAt = Date.now()
  return new Promise((resolve) => {
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    const stdoutState = { bytes: 0, truncated: false }
    const stderrState = { bytes: 0, truncated: false }
    let timedOut = false
    let settled = false
    const child = spawn(spec.command, spec.args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] })
    const finish = (exitCode?: number, signal?: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({
        exitCode,
        signal,
        timedOut,
        durationMs: Date.now() - startedAt,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        outputTruncated: stdoutState.truncated || stderrState.truncated,
      })
    }
    // An unref'd timer cannot keep the host alive after a caller disappears;
    // the deadline still kills the child on a live host.
    const timer = setTimeout(() => {
      timedOut = true
      try { child.kill("SIGKILL") } catch {}
    }, timeoutSeconds * 1000)
    timer.unref?.()
    child.stdout?.on("data", (chunk: Buffer) => capture(stdout, chunk, stdoutState))
    child.stderr?.on("data", (chunk: Buffer) => capture(stderr, chunk, stderrState))
    child.on("error", (error) => {
      capture(stderr, Buffer.from(error instanceof Error ? error.message : String(error)), stderrState)
      finish(undefined)
    })
    child.on("close", (code, signal) => finish(code ?? undefined, signal ?? undefined))
  })
}

/**
 * Run one finite approved command under the workspace-wide operation lock.
 * Authority is re-read inside the lock-acquisition transaction, so retirement
 * or generation rotation racing this call cannot authorize execution.
 */
export async function runApprovedFiniteCommand(
  directory: string,
  sessionID: string | undefined,
  name: string,
): Promise<ApprovedFiniteResult> {
  const pre = resolveApprovedCommand(await readSnapshot(directory), sessionID, name, "finite")
  if (!pre.ok) return { ok: false, name, command: "", args: [], cwd: "", timeoutSeconds: 0, timedOut: false, durationMs: 0, stdout: "", stderr: "", outputTruncated: false, errorCode: pre.errorCode, message: pre.message }
  const spec = pre.spec
  const timeoutSeconds = spec.timeoutSeconds ?? DEFAULT_APPROVED_FINITE_TIMEOUT_SECONDS
  const base = { name, command: spec.command, args: [...spec.args], cwd: spec.cwd, timeoutSeconds }
  try {
    const outcome = await withWorkspaceOperation(directory, pre.goal.id, sessionID!, () => execute(directory, spec), {
      authorize(state) {
        const current = resolveApprovedCommand(state, sessionID, name, "finite")
        if (!current.ok) throw new ApprovedAuthorityError(current)
      },
    })
    return { ...base, ok: !outcome.timedOut && outcome.exitCode === 0, ...outcome }
  } catch (error) {
    if (error instanceof ApprovedAuthorityError) {
      return { ...base, ok: false, timedOut: false, durationMs: 0, stdout: "", stderr: "", outputTruncated: false, errorCode: error.denial.errorCode, message: error.denial.message }
    }
    const message = error instanceof Error ? error.message : String(error)
    return {
      ...base, ok: false, timedOut: false, durationMs: 0, stdout: "", stderr: "", outputTruncated: false,
      ...(message.includes("Workspace is busy") || message.includes("Workspace operation")
        ? { errorCode: "workspace_busy" as const, message: "Workspace is busy with another operation or in-flight writes; the approved command was not started." }
        : { message }),
    }
  }
}

async function readSnapshot(directory: string): Promise<StoreState> {
  return readState(directory)
}

// ─── Managed approved servers ────────────────────────────────────────────────
// A server is a CommandService process whose authority, ownership and cleanup
// are recorded in state.approvedServers. Ordinary commands with a goalID stay
// display-only: only recorded command IDs are lifecycle-owned.

export type ApprovedServerErrorCode =
  | ApprovedCommandErrorCode
  | "duplicate_server"
  | "start_in_progress"
  | "recovery_required"
  | "unmanaged_server"
  | "stop_unproven"

export interface ApprovedServerResult {
  ok: boolean
  name: string
  commandID?: string
  status?: CommandSessionStatus
  live?: boolean
  pid?: number
  exitCode?: number
  signal?: string
  command?: string
  args?: string[]
  cwd?: string
  timeoutSeconds?: number
  output?: string
  totalBytes?: number
  outputTruncated?: boolean
  errorCode?: ApprovedServerErrorCode
  message?: string
}

class ApprovedServerFailure extends Error {
  constructor(readonly errorCode: ApprovedServerErrorCode, message: string) {
    super(message)
    this.name = "ApprovedServerFailure"
  }
}

function failure(name: string, errorCode: ApprovedServerErrorCode, message: string): ApprovedServerResult {
  return { ok: false, name, errorCode, message }
}

function recordFor(state: StoreState, goalID: string, name: string): ApprovedServerRecord | undefined {
  return state.approvedServers?.find((record) => record.goalID === goalID && record.name === name)
}

function commandFor(state: StoreState, commandID: string): CommandSession | undefined {
  return state.commands?.find((command) => command.id === commandID)
}

function isTerminal(status: CommandSessionStatus | undefined): boolean {
  return status === "exited" || status === "terminated"
}

/**
 * Control authority for an existing managed server: the persisted worker of
 * the owning goal (current session only, never retired) or that goal's owner
 * session. Inactive goals stay controllable so an owner can always stop a
 * server that outlived a pause/rotation.
 */
function resolveServerControl(
  state: StoreState,
  sessionID: string | undefined,
  name: string,
): { ok: true; record: ApprovedServerRecord; goal: Goal } | ApprovedCommandDenial {
  const deny = (errorCode: ApprovedServerErrorCode, message: string): ApprovedCommandDenial => ({ ok: false, errorCode: errorCode as ApprovedCommandErrorCode, message })
  if (!sessionID || sessionID === "main") return deny("unapproved_caller", "An active worker or the owning session is required.")
  if (state.retiredWorkerSessions?.includes(sessionID)) return deny("unapproved_caller", "Worker session is retired; goal cleared or worker rotated. Late controls are fenced.")
  const workerGoal = state.goals.find((item) => item.workerSessionID === sessionID)
  const ownedGoals = state.goals.filter((item) => item.ownerSessionID === sessionID)
  const candidates = [workerGoal, ...ownedGoals].filter((goal): goal is Goal => !!goal)
  for (const goal of candidates) {
    const record = recordFor(state, goal.id, name)
    if (!record) continue
    if (goal !== workerGoal && goal.ownerSessionID !== sessionID) continue
    return { ok: true, record, goal }
  }
  return deny("unmanaged_server", `No managed approved server named "${name}" is owned by this session.`)
}

async function serverSnapshot(
  directory: string,
  commandService: CommandService,
  record: ApprovedServerRecord,
): Promise<ApprovedServerResult> {
  if (!record.commandID) {
    return failure(record.name, "recovery_required", `Approved server "${record.name}" has a persisted start reservation without a command id. Its process may exist; verify externally and stop it before starting another.`)
  }
  const session = await commandService.get(directory, record.commandID, record.workerSessionID)
  if (!session) {
    return failure(record.name, "recovery_required", `Approved server "${record.name}" (command_id ${record.commandID}) has no readable session. Its process exit is unproved; verify externally before restarting.`)
  }
  const base = {
    name: record.name,
    commandID: session.id,
    status: session.status,
    live: session.status === "running",
    ...(session.pid !== undefined ? { pid: session.pid } : {}),
    ...(session.exitCode !== undefined ? { exitCode: session.exitCode } : {}),
    ...(session.signal !== undefined ? { signal: session.signal } : {}),
    command: session.command,
    args: [...session.args],
    cwd: session.cwd,
    ...(session.timeoutSeconds !== undefined ? { timeoutSeconds: session.timeoutSeconds } : {}),
  }
  const first = await commandService.read(directory, record.commandID, record.workerSessionID)
  let output = first?.text ?? ""
  let totalBytes = first?.totalBytes ?? 0
  if (totalBytes > MAX_APPROVED_OUTPUT_BYTES) {
    const tail = await commandService.read(directory, record.commandID, record.workerSessionID, {
      offsetBytes: totalBytes - MAX_APPROVED_OUTPUT_BYTES,
      limitBytes: MAX_APPROVED_OUTPUT_BYTES,
    })
    output = tail?.text ?? output
  }
  return {
    ok: session.status === "running",
    ...base,
    output,
    totalBytes,
    outputTruncated: totalBytes > MAX_APPROVED_OUTPUT_BYTES,
    ...(session.status === "missing"
      ? { message: `Host restart lost the handle for command ${session.id}; exit is unproved. Stop it explicitly or verify the PID externally before restarting.` }
      : {}),
  }
}

/**
 * Start one owner-approved server by name. Authority is re-read inside the
 * reservation transaction, so a resume/rotation racing this call cannot
 * authorize a process. The reservation also makes duplicate prevention
 * atomic: a concurrent start of the same goal+name is refused before spawn.
 */
export async function startApprovedServer(
  directory: string,
  commandService: CommandService,
  sessionID: string | undefined,
  name: string,
): Promise<ApprovedServerResult> {
  let spec: ApprovedGoalCommand
  let goalID: string
  try {
    const state = await readState(directory)
    const pre = resolveApprovedCommand(state, sessionID, name, "server")
    if (!pre.ok) return failure(name, pre.errorCode, pre.message)
    spec = pre.spec
    goalID = pre.goal.id
  } catch (error) {
    return failure(name, "unapproved_caller", error instanceof Error ? error.message : String(error))
  }

  try {
    await mutateState(directory, `approved.server.reserve:${goalID}:${name}`, async (state) => {
      const current = resolveApprovedCommand(state, sessionID, name, "server")
      if (!current.ok) throw new ApprovedAuthorityError(current)
      if (state.workspaceOperation) {
        throw new ApprovedServerFailure("workspace_busy", `Workspace operation ${state.workspaceOperation.id} is active; a managed server cannot start during source writes or checks.`)
      }
      const existing = recordFor(state, goalID, name)
      if (existing) {
        const command = commandFor(state, existing.commandID)
        if (!existing.commandID) throw new ApprovedServerFailure("start_in_progress", `A start for approved server "${name}" is already in progress.`)
        if (!command || command.status === "missing") {
          throw new ApprovedServerFailure("recovery_required", `Approved server "${name}" (command_id ${existing.commandID}) lost its handle and exit is unproved. Stop it or verify the process externally before restarting.`)
        }
        if (command.status === "running") {
          throw new ApprovedServerFailure("duplicate_server", `Approved server "${name}" is already running as command_id ${existing.commandID}. Reuse that session.`)
        }
      }
      state.approvedServers = [
        ...(state.approvedServers ?? []).filter((record) => !(record.goalID === goalID && record.name === name)),
        { commandID: "", goalID, workerSessionID: sessionID!, runGeneration: current.generation, name, startedAt: new Date().toISOString() },
      ]
      return state
    })
  } catch (error) {
    if (error instanceof ApprovedAuthorityError) return failure(name, error.denial.errorCode, error.denial.message)
    if (error instanceof ApprovedServerFailure) return failure(name, error.errorCode, error.message)
    return failure(name, "start_in_progress", error instanceof Error ? error.message : String(error))
  }

  let session: CommandSession
  try {
    session = await commandService.start(directory, {
      title: `approved-server:${name}`,
      command: spec.command,
      args: [...spec.args],
      cwd: path.resolve(directory, spec.cwd),
      ownerSessionID: sessionID!,
      goalID,
      notifyOnExit: false,
      ...(spec.timeoutSeconds !== undefined ? { timeoutSeconds: spec.timeoutSeconds } : {}),
    }, { skipWorkspaceGate: true })
  } catch (error) {
    const code: ApprovedServerErrorCode = error instanceof DuplicateCommandError ? "duplicate_server" : "start_in_progress"
    await mutateState(directory, `approved.server.release:${goalID}:${name}`, async (state) => {
      state.approvedServers = (state.approvedServers ?? []).filter((record) => !(record.goalID === goalID && record.name === name && record.commandID === ""))
      return state
    }).catch(() => {})
    return failure(name, code, error instanceof Error ? error.message : String(error))
  }

  const record: ApprovedServerRecord = {
    commandID: session.id,
    goalID,
    workerSessionID: sessionID!,
    runGeneration: 0,
    name,
    startedAt: new Date().toISOString(),
  }
  try {
    await mutateState(directory, `approved.server.link:${session.id}`, async (state) => {
      const current = state.approvedServers?.find((item) => item.goalID === goalID && item.name === name && item.commandID === "")
      if (!current) throw new Error("Approved server reservation disappeared before linkage was recorded.")
      current.commandID = session.id
      current.startedAt = record.startedAt
      return state
    })
  } catch (error) {
    // The process exists but is unlinked: fail closed and keep it visible so
    // the owner must stop it explicitly. Never report a started server twice.
    return failure(name, "recovery_required", `${error instanceof Error ? error.message : String(error)} Command ${session.id} may still be running; stop it before retrying.`)
  }
  const snapshot = await serverSnapshot(directory, commandService, record)
  return { ...snapshot, ok: session.status === "running" }
}

/** Read one managed server by approved name: status, liveness, exit and output tail. */
export async function readApprovedServer(
  directory: string,
  commandService: CommandService,
  sessionID: string | undefined,
  name: string,
): Promise<ApprovedServerResult> {
  const state = await readState(directory)
  const control = resolveServerControl(state, sessionID, name)
  if (!control.ok) return failure(name, control.errorCode, control.message)
  return { ...(await serverSnapshot(directory, commandService, control.record)), name }
}

/**
 * Stop one managed server and release its linkage ONLY after the process exit
 * is proved by CommandService. A failed proof keeps the record (fence) and
 * reports visible recovery instead of pretending the server stopped.
 */
export async function stopApprovedServer(
  directory: string,
  commandService: CommandService,
  sessionID: string | undefined,
  name: string,
): Promise<ApprovedServerResult> {
  const state = await readState(directory)
  const control = resolveServerControl(state, sessionID, name)
  if (!control.ok) return failure(name, control.errorCode, control.message)
  const { record } = control
  if (!record.commandID) return failure(name, "recovery_required", `Approved server "${name}" has a reservation without a command id; verify the process externally.`)
  const session = commandFor(await readState(directory), record.commandID)
  if (!session) return failure(name, "recovery_required", `Approved server "${name}" (command_id ${record.commandID}) has no readable session; exit is unproved.`)

  if (session.status === "running") {
    const result = await commandService.terminate(directory, record.commandID, record.workerSessionID)
    if (!result.ok) return failure(name, "stop_unproven", result.message)
  }
  const after = commandFor(await readState(directory), record.commandID)
  if (!after || !isTerminal(after.status)) {
    return failure(name, "stop_unproven", `Approved server "${name}" (command_id ${record.commandID}) exit is unproved; linkage is retained and it must be stopped/verified explicitly.`)
  }
  await mutateState(directory, `approved.server.release:${record.commandID}`, async (current) => {
    current.approvedServers = (current.approvedServers ?? []).filter((item) => item.commandID !== record.commandID)
    return current
  })
  return {
    ...(await serverSnapshot(directory, commandService, record)),
    name,
    ok: true,
    message: `Approved server "${name}" stopped (${after.status}${after.exitCode !== undefined ? `, exit ${after.exitCode}` : ""}).`,
  }
}

/**
 * Goal lifecycle cleanup: stop every managed server owned by one goal (or all
 * goals) and drop each linkage only after a proved exit. Unproved processes
 * keep their record so the fence stays visible instead of aging out.
 */
export async function cleanupApprovedServers(
  directory: string,
  commandService: CommandService,
  goalID?: string,
): Promise<{ stopped: string[]; unproven: string[] }> {
  const state = await readState(directory)
  const records = (state.approvedServers ?? []).filter((record) => goalID === undefined || record.goalID === goalID)
  const stopped: string[] = []
  const unproven: string[] = []
  for (const record of records) {
    const label = `${record.goalID}:${record.name}`
    const session = record.commandID ? commandFor(state, record.commandID) : undefined
    try {
      if (record.commandID && session?.status === "running") {
        await commandService.terminate(directory, record.commandID, record.workerSessionID)
      }
    } catch {
      unproven.push(label)
      continue
    }
    const after = record.commandID ? commandFor(await readState(directory), record.commandID) : undefined
    if (!record.commandID || !after || !isTerminal(after.status)) {
      unproven.push(label)
      continue
    }
    await mutateState(directory, `approved.server.cleanup:${record.commandID || randomUUID()}`, async (current) => {
      current.approvedServers = (current.approvedServers ?? []).filter((item) => !(item.goalID === record.goalID && item.name === record.name))
      return current
    })
    stopped.push(label)
  }
  return { stopped, unproven }
}

/**
 * Reconciliation for the control tick: clean up managed servers whose goal is
 * gone, inactive, rotated to another worker session, or on another generation.
 * Ordinary command goalID linkage is never consulted here.
 */
export async function reconcileApprovedServers(
  directory: string,
  commandService: CommandService,
): Promise<{ stopped: string[]; unproven: string[] }> {
  const state = await readState(directory)
  const stale = new Set<string>()
  for (const record of state.approvedServers ?? []) {
    const goal = state.goals.find((item) => item.id === record.goalID)
    if (!goal) { stale.add(record.goalID); continue }
    const generation = state.runtimes.find((item) => item.goalID === goal.id)?.runGeneration ?? 0
    if (goal.status !== "active" || goal.workerSessionID !== record.workerSessionID || generation !== record.runGeneration) {
      stale.add(record.goalID)
    }
  }
  const stopped: string[] = []
  const unproven: string[] = []
  for (const goalID of stale) {
    const result = await cleanupApprovedServers(directory, commandService, goalID)
    stopped.push(...result.stopped)
    unproven.push(...result.unproven)
  }
  return { stopped, unproven }
}
