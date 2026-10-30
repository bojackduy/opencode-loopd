import { randomUUID } from "node:crypto"
import path from "node:path"
import type { ToolEditor as V2ToolEditor } from "@opencode/plugin/promise/tool"
import type { Goal } from "../domain/goal"
import { isTerminal } from "../domain/goal"
import { readState, mutateState, type StoreState } from "../infrastructure/state-repository"
import type { LoopHost } from "../server/host-adapter"
import type { TerminalToolExecution } from "../domain/tool-execution"
import { logServerEvent } from "../infrastructure/server-log"
import { canonicalScopePath, findScopeConflict, scopeConflictMessage } from "../infrastructure/workspace-scope"

const readTools = new Set([
  "read", "glob", "grep", "list", "webfetch", "websearch", "todowrite", "skill",
  "get_goal", "claim_goal_scope", "report_goal_progress", "complete_goal", "block_goal",
  "list_background_goals", "inspect_background_goal", "read_goal_transcript",
  "loopd_command_get", "loopd_command_list", "loopd_command_await",
  "loopd_command_interrupt", "loopd_command_terminate", "loopd_command_remove",
  "loopd_list_agents", "loopd_list_models", "run_goal_checks",
  "codegraph_codegraph_context", "codegraph_codegraph_search", "codegraph_codegraph_node",
  "codegraph_codegraph_explore", "codegraph_codegraph_files", "codegraph_codegraph_trace",
  "codegraph_codegraph_callers", "codegraph_codegraph_callees", "codegraph_codegraph_impact",
  "codegraph_codegraph_status",
  // Self-enforcing dedicated executors: they re-read persisted authority and
  // take the workspace operation lock themselves, so the generic reservation
  // path would double-fence (or permanently deny) their own execution.
  "run_approved_command",
  // Managed server controls enforce the same persisted authority and refuse
  // while a workspace operation is active; the generic path would deny every
  // scoped worker because starting a command is not a structured file write.
  "start_approved_server", "read_approved_server", "stop_approved_server",
])
const ownerTools = new Set(["loopd_create_goal", "switch_goal_identity", "pause_goal", "resume_goal", "clear_goal", "abort_goal_worker", "nudge_goal", "send_goal_input", "force_block_goal", "force_complete_goal"])

// ─── Ticket-based write concurrency (replaces global lock) ────────────────────
// Per-scope tickets: disjoint file sets run in parallel. Queued waiters are
// FIFO with owner priority. Shell is never ticketed — prompt awareness only.
// Read tools are always pass-through. Holders are reclaimed on crash/completion.

function ticketHolders(state: StoreState): NonNullable<StoreState["writeTickets"]>["holders"] {
  return state.writeTickets?.holders ?? []
}
function ticketQueue(state: StoreState): NonNullable<StoreState["writeTickets"]>["queue"] {
  return state.writeTickets?.queue ?? []
}
function ensureTickets(state: StoreState): NonNullable<StoreState["writeTickets"]> {
  if (!state.writeTickets) state.writeTickets = { holders: [], queue: [] }
  return state.writeTickets
}
function filesOverlap(a: string[], b: string[]): boolean {
  if (a.length === 0 || b.length === 0) return true // empty scope = exclusive
  return a.some((f) => b.includes(f))
}
function canGrantTicket(state: StoreState, files: string[]): boolean {
  if (ticketHolders(state).some((h) => filesOverlap(h.files, files))) return false
  // Legacy fence: workspaceCalls predating tickets still block overlapping files
  // until their after-hook clears them. Treat them as pseudo-holders.
  if ((state.workspaceCalls ?? []).some((c) => !c.uncontrolled && c.paths && filesOverlap(c.paths, files))) return false
  return true
}
function queuePosition(state: StoreState, callID: string): number {
  const q = ticketQueue(state)
  const idx = q.findIndex((w) => w.callID === callID)
  return idx >= 0 ? idx + 1 : 0
}

/** These calls never acquire a workspace reservation; tracking must not gate them. */
export function isWorkspaceToolExempt(tool: string): boolean { return readTools.has(tool) }

/** Only known structured formats are trusted; shell/custom/batch cannot be inferred safe. */
export function structuredWritePaths(tool: string, args: Record<string, unknown>): string[] | undefined {
  if (tool === "write" || tool === "edit") {
    if (args.filePath !== undefined && args.path !== undefined && args.filePath !== args.path) throw new Error(`Scope denied: ${tool} has conflicting path fields.`)
    const file = args.filePath ?? args.path
    if (typeof file !== "string") throw new Error(`Scope denied: ${tool} requires filePath (v1) or path (v2).`)
    return [file]
  }
  // v1/Codex calls this apply_patch; native v2 calls it patch with the same
  // structured patchText grammar. Both must pass identical path extraction.
  if (tool !== "apply_patch" && tool !== "patch") return undefined
  const source = args.patchText ?? args.patch
  if (typeof source !== "string" || !source.startsWith("*** Begin Patch\n") || !source.trimEnd().endsWith("*** End Patch")) {
    throw new Error("Scope denied: unsupported apply_patch format.")
  }
  const paths: string[] = []
  let section = false
  for (const line of source.split("\n")) {
    const header = /^\*\*\* (?:Add File|Update File|Delete File): (.+)$/.exec(line)
    if (header) { paths.push(header[1]!); section = true; continue }
    const move = /^\*\*\* Move to: (.+)$/.exec(line)
    if (move) {
      if (!section) throw new Error("Scope denied: rename outside patch section.")
      paths.push(move[1]!)
      continue
    }
    if (line.startsWith("*** ") && !["*** Begin Patch", "*** End Patch", "*** End of File"].includes(line)) {
      throw new Error("Scope denied: unknown patch operation.")
    }
  }
  if (!paths.length) throw new Error("Scope denied: patch has no file operations.")
  return paths
}

// ─── Stale scope-ownership sweep ─────────────────────────────────────────────
// Root causes fixed here (poweroff limbo, Oct 2026: a paused goal kept
// scopeClosing=true + scopeClearPending=true + 7 dead workspaceCalls forever,
// and resume AND clear both failed demanding quiescence first):
// (1) workspaceCalls were added in beforeWorkspaceTool but removed only in
// afterWorkspaceTool — missed after-hooks (crash/restart/dead session, denied
// executions) left them forever; (2) scopeClosing was set in two-step
// pause/clear/reconcile transactions with no reset path; (3)
// scopeClearPending deferred deletion completed only in afterWorkspaceTool.
// Goal tombstones can be removed without erasing independent execution fences.
// Historical TTL exports are retained for compatibility, never used as exit proof.
export const STALE_WORKSPACE_CALL_TTL_MS = 10 * 60_000
export const CLEAR_PENDING_FORCE_TTL_MS = 30 * 60_000
export const OWNER_CALL_TTL_MS = 30 * 60_000

export interface SweepLiveness {
  /** True when the worker session is known live (host sessionStatus !== unknown). Unknown/absent = not live. */
  isWorkerLive?: (goalID: string, workerSessionID?: string) => boolean
  now?: number
}

export interface WorkspaceSweepSummary {
  reapedCalls: Array<{ callID: string; sessionID: string; goalID?: string; reason: string }>
  resetClosing: string[]
  finalizedClears: string[]
  forceCleared: string[]
  reapedTickets: string[]
}

/** Generation metadata is an authority fence, never proof that a tool exited. */
export function isGenerationSuperseded(
  state: StoreState,
  call: { goalID?: string; generation?: number },
): boolean {
  if (call.generation === undefined || !call.goalID) return false
  const rt = state.runtimes.find((r) => r.goalID === call.goalID)
  return !!rt && call.generation < rt.runGeneration
}

/**
 * Compatibility query: no persisted reservation is proved finished by state alone.
 */
export function isSyncStaleWorkspaceCall(
  _state: StoreState,
  _call: { goalID?: string; generation?: number; at?: string },
  _now = Date.now(),
): boolean {
  // Neither time, goal deletion nor generation rotation proves tool exit.
  // Only the actual after-hook may remove a reserved execution fence.
  return false
}

/**
 * Host idle/unknown concerns a session, not the lifetime of an OS/tool call.
 */
export function isStaleWorkspaceCall(
  state: StoreState,
  call: { goalID?: string; generation?: number; at?: string; sessionID: string },
  liveness: SweepLiveness = {},
): boolean {
  return isSyncStaleWorkspaceCall(state, call, liveness.now ?? Date.now())
}

/** Live (non-stale) calls only — what genuinely fences activation and checks. */
export function liveWorkspaceCalls(
  state: StoreState,
  liveness: SweepLiveness = {},
): NonNullable<StoreState["workspaceCalls"]> {
  return (state.workspaceCalls ?? []).filter((call) => !isStaleWorkspaceCall(state, call, liveness))
}

/**
 * Heal old goal tombstones without discarding independent execution fences.
 */
export function sweepStaleWorkspaceState(
  state: StoreState,
  liveness: SweepLiveness = {},
): WorkspaceSweepSummary {
  const now = liveness.now ?? Date.now()
  const summary: WorkspaceSweepSummary = { reapedCalls: [], resetClosing: [], finalizedClears: [], forceCleared: [], reapedTickets: [] }
  const kept = state.workspaceCalls ?? []
  // Periodic fail-tolerance for write tickets (engine runs this on reconcile):
  // holders whose goal is terminal or gone can never be released by an
  // after-hook, so reclaim them here instead of fencing overlap forever.
  // Waiters bound to a terminal/gone goal are dropped too (owner waiters with
  // no goalID are kept — they are still grantable).
  if (state.writeTickets) {
    const liveHolders = state.writeTickets.holders.filter((h) => {
      if (!h.goalID) return true
      const g = state.goals.find((x) => x.id === h.goalID)
      if (!g || isTerminal(g.status)) {
        summary.reapedTickets.push(h.callID)
        return false
      }
      return true
    })
    if (liveHolders.length !== state.writeTickets.holders.length) state.writeTickets.holders = liveHolders
    const liveWaiters = state.writeTickets.queue.filter((w) => {
      if (!w.goalID) return true
      const g = state.goals.find((x) => x.id === w.goalID)
      if (!g || isTerminal(g.status)) {
        summary.reapedTickets.push(w.callID)
        return false
      }
      return true
    })
    if (liveWaiters.length !== state.writeTickets.queue.length) state.writeTickets.queue = liveWaiters
    // Promote queued waiters grantable after the reclaim (mirrors the
    // after-hook grant pass, minus logging — the sweep summary reports it).
    // A waiter still overlapping a live holder OR a legacy workspaceCall fence
    // stays queued; fail-closed reservations are never overridden here.
    if (state.writeTickets.queue.length) {
      const remaining: typeof state.writeTickets.queue = []
      for (const waiter of state.writeTickets.queue) {
        const blockedByHolder = state.writeTickets.holders.some((h) => filesOverlap(h.files, waiter.files))
        const blockedByLegacy = (state.workspaceCalls ?? []).some((c) => !c.uncontrolled && c.paths && filesOverlap(c.paths, waiter.files))
        if (!blockedByHolder && !blockedByLegacy) {
          state.writeTickets.holders.push({
            ticketID: randomUUID(),
            goalID: waiter.goalID,
            sessionID: waiter.sessionID,
            callID: waiter.callID,
            files: waiter.files,
            grantedAt: new Date(now).toISOString(),
          })
        } else {
          remaining.push(waiter)
        }
      }
      state.writeTickets.queue = remaining
    }
  }
  for (const goal of [...state.goals]) {
    const referenced = kept.some((call) => call.goalID === goal.id) || state.workspaceOperation?.goalID === goal.id
    if (goal.scopeClosing && !referenced && !(liveness.isWorkerLive?.(goal.id, goal.workerSessionID) ?? false)) {
      goal.scopeClosing = false
      goal.updatedAt = new Date(now).toISOString()
      summary.resetClosing.push(goal.id)
    }
    if (goal.scopeClearPending) {
      retireWorker(state, goal)
      state.goals = state.goals.filter((g) => g.id !== goal.id)
      state.runtimes = state.runtimes.filter((r) => r.goalID !== goal.id)
      state.commandAwaits = (state.commandAwaits ?? []).filter((a) => a.goalID !== goal.id)
      summary.finalizedClears.push(goal.id)
    }
  }
  return summary
}

/** Stamp the reservation generation whenever a runtime exists (fallback 0 — never undefined for goal calls). */
export function stampCallGeneration(state: StoreState, goalID: string | undefined): number | undefined {
  if (!goalID) return undefined
  return state.runtimes.find((runtime) => runtime.goalID === goalID)?.runGeneration ?? 0
}

export function heldGoals(state: StoreState): Goal[] {
  // Pending calls retain ownership even if the goal is parked. Cleared goals
  // are absent here, but their independent reservations still fence activation.
  const now = Date.now()
  return state.goals.filter((goal) => goal.status === "active" || goal.scopeClosing || (state.workspaceCalls ?? []).some((call) => call.goalID === goal.id && !isSyncStaleWorkspaceCall(state, call, now)) || state.workspaceOperation?.goalID === goal.id)
}

function mayBeAlive(pid?: number): boolean {
  if (!pid || pid < 1) return true
  try { process.kill(pid, 0); return true } catch (error: any) { return error?.code !== "ESRCH" }
}

/**
 * Best-effort executable identity for a live pid. Guard against OS pid reuse:
 * a `kill(pid, 0)` success only proves SOME process holds the pid, not ours.
 * Returns true (matches) when the probe cannot run or the command is unknown
 * — fail closed; only a successful probe with a clear mismatch returns false.
 */
function pidMatchesCommand(pid: number | undefined, command: string | undefined): boolean {
  if (!pid || pid < 1 || !command) return true
  try {
    const probe = Bun.spawnSync(["ps", "-p", String(pid), "-o", "command="])
    const line = probe.stdout?.toString() ?? ""
    if (!line.trim()) return true // probe inconclusive: fail closed
    return line.includes(path.basename(command))
  } catch {
    return true
  }
}

/**
 * Whether an orphaned/missing process entry genuinely fences work. Dead pids
 * never fence. Live pids fence only while they still look like our executable
 * — a recycled pid running something else is proof the original is gone.
 * Unknown pids and failed probes fence (fail closed); pid-less entries are
 * released only through explicit operator removal, never silently.
 */
function orphanBlocks(entry: { pid?: number; command?: string }): boolean {
  if (!mayBeAlive(entry.pid)) return false
  return pidMatchesCommand(entry.pid, entry.command)
}

export function assertScopeAvailable(state: StoreState, goal: Goal): void {
  // Artifact-only goals have no shared workspace ownership to acquire.
  // Their private outputs must not contend with writers or verification.
  if (goal.config.workspaceWrite === false) return
  // No session/generation/age inference can release an existing tool call.
  const now = Date.now()
  const liveCalls = (state.workspaceCalls ?? []).filter(
    (call) => call.goalID === goal.id && !isSyncStaleWorkspaceCall(state, call, now),
  )
  if (goal.scopeClosing || liveCalls.length) {
    throw new Error("Goal still has closing/in-flight writes; ownership cannot be reacquired before quiescence.")
  }
  if (state.workspaceOperation) throw new Error(`Workspace operation ${state.workspaceOperation.id} is active.`)
  if (goal.config.write_scope !== undefined) {
    const orphan = [...(state.orphanedCommandProcesses || []), ...(state.commands || []).filter((command) => command.status === "missing").map((command) => ({ commandID: command.id, pid: command.pid, command: command.command }))].find((process) => orphanBlocks(process))
    if (orphan) throw new Error(`Protected activation denied: command ${orphan.commandID} lost its handle and process exit is unproved. Stop it with loopd_command_terminate (works on missing commands), verify exit externally, then loopd_command_remove to clear the fence. Removing the record alone never clears a live process's fence.`)
    if (state.workspaceCalls?.some((call) => call.uncontrolled)) throw new Error("Protected goal activation denied: an uncontrolled tool/shell is still executing. Wait for its exit event, do not poll claims.")
    const running = state.commands?.find((command) => command.status === "running")
    if (running) throw new Error(`Protected goal activation denied: uncontrolled command ${running.id} is still running. Terminate it before starting scoped/read-only work.`)
  }
  const conflict = findScopeConflict(heldGoals(state).map((owner) => ({ ...owner, status: "active" })), goal)
  if (conflict) {
    const owner = state.goals.find((item) => item.id === conflict.goalID)
    if (goal.config.write_scope === undefined && owner?.config.write_scope === undefined) {
      throw new Error(`Workspace-writing goal "${conflict.name}" (${conflict.goalID}) is already active (owned by session ${conflict.ownerSessionID}). Pause, block, complete, or clear it before activating another workspace-writing goal. Note: list_background_goals shows only this session's goals.`)
    }
    throw new Error(scopeConflictMessage(conflict))
  }
  if (goal.config.write_scope?.length !== 0) {
    const now2 = Date.now()
    const call = state.workspaceCalls?.find((call) => call.goalID !== goal.id && !isSyncStaleWorkspaceCall(state, call, now2) && (goal.config.write_scope === undefined || call.paths.some((file) => goal.config.write_scope!.includes(file))))
    if (call) throw new Error(`Scope conflict with in-flight call ${call.callID}, session ${call.sessionID}, path ${call.paths[0]}.`)
  }
}

export function retireWorker(state: StoreState, goal: Goal): void {
  if (!goal.workerSessionID) return
  state.retiredWorkerSessions = [...new Set([...(state.retiredWorkerSessions || []), goal.workerSessionID])]
}

/**
 * Authoritative host evidence for a genuine main session that has no persisted
 * goal record yet. `undefined` (capability missing, timeout, error) is unproven
 * and must stay fail-closed: an unknown child is never an owner by default.
 */
export interface SessionIdentityProof {
  isMainSession?: (sessionID: string) => Promise<boolean | undefined>
}

/** A live uncontrolled call owned by another session — unsafe to write beside. */
function foreignUncontrolledCall(state: StoreState, input: { sessionID: string; callID: string }) {
  return (state.workspaceCalls ?? []).find(
    (call) => call.uncontrolled && call.sessionID !== input.sessionID && !(call.callID === input.callID && call.sessionID === input.sessionID),
  )
}

function busyMessage(call: NonNullable<StoreState["workspaceCalls"]>[number], state: StoreState): string {
  const holder = call.goalID ? state.goals.find((goal) => goal.id === call.goalID) : undefined
  return `Workspace busy: session ${call.sessionID} is executing tool call ${call.callID}${holder ? ` for goal "${holder.name}"` : ""}. Wait for that call's exit event, then retry. If the owning session is gone but the fence persists, use loopd_release_workspace to release it (your own calls, goals you own, or orphaned ones) — pausing or clearing a goal does not release another session's live reservation.`
}

function assertCommandQuiescence(state: StoreState): void {
  const command = state.commands?.find((item) => item.status === "running" || (item.status === "missing" && orphanBlocks({ pid: item.pid, command: item.command })))
  if (command) throw new Error(`Workspace busy: command ${command.id} has not proved exit. Stop it or wait for its exit event before source writes, shell or checks.`)
  const orphan = state.orphanedCommandProcesses?.find((item) => orphanBlocks(item))
  if (orphan) throw new Error(`Workspace busy: command ${orphan.commandID} has not proved exit. Verify process exit before retrying.`)
}

export async function beforeWorkspaceTool(
  directory: string,
  input: { tool: string; sessionID: string; callID: string },
  args: Record<string, unknown>,
  identity: SessionIdentityProof = {},
): Promise<void> {
  // These tools were already unconditionally exempt, including retired
  // sessions. No shared-state decision or reservation needs a transaction.
  if (readTools.has(input.tool)) return
  // Host evidence is gathered before the transaction: never await network I/O
  // while holding the store lock. It only matters for sessions with no record.
  let hostMain = false
  if (identity.isMainSession) {
    const known = await readState(directory)
    const recorded = known.goals.some((item) => item.workerSessionID === input.sessionID || item.ownerSessionID === input.sessionID)
    if (!recorded) {
      try { hostMain = (await identity.isMainSession(input.sessionID)) === true } catch { hostMain = false }
    }
  }
  let queuedPos = 0
  let queuedFiles: string[] = []
  let wasQueued = false
  await mutateState(directory, `workspace.before:${input.callID}`, async (state) => {
    const goal = state.goals.find((item) => item.workerSessionID === input.sessionID)
    if (state.retiredWorkerSessions?.includes(input.sessionID)) throw new Error("Scope denied: retired worker session; goal cleared or worker rotated. Stop work; late executions are fenced.")
    if (goal?.config.workspaceWrite === false) {
      // A read-only goal may write ONLY its private artifact directory. These
      // writes never acquire shared workspace reservations and therefore do
      // not block writers, checks, or other read-only goals.
      if (goal.status !== "active" || goal.scopeClosing) throw new Error("Scope denied: read-only worker is not active.")
      const writes = structuredWritePaths(input.tool, args)
      if (!writes) throw new Error(`Scope denied: uncontrolled tool "${input.tool}" in read-only goal (shell can write, so it is never allowed here). Inspect with read/glob/grep/list tools (they work anywhere), write reports with the write/edit tools into this goal's artifact directory only, verify with run_goal_checks, or ask the owner to grant a fixed executable via grant_approved_command.`)
      if (!goal.config.artifactDir) throw new Error("Scope denied: read-only artifact directory is missing.")
      const artifact = path.relative(directory, goal.config.artifactDir).split(path.sep).join("/")
      const paths = await Promise.all(writes.map((file) => canonicalScopePath(directory, file)))
      for (const file of paths) {
        if (!file.startsWith(`${artifact}/`)) throw new Error(`Scope denied: "${file}" is outside this goal's artifact directory.`)
      }
      return state
    }
    const held = heldGoals(state)
    const protectedGoals = held.filter((item) => item.config.workspaceWrite !== false && item.config.write_scope !== undefined)
    // Preserve legacy operation when no scoped/read-only contract is present.
    if (!goal && ownerTools.has(input.tool) && (!protectedGoals.length || state.goals.some((item) => item.ownerSessionID === input.sessionID))) return state
    // Trusted owner/main authority. A persisted owner session, or a session the
    // host proves is a root session, may run ordinary tools even while protected
    // goals exist. Scoped-worker restrictions win: `goal` is only set for the
    // session that is the current worker of a goal.
    // NOTE (accepted hole): stdin written into a command (loopd_command_write,
    // exempt from quiescence below) can drive the child to write files the
    // fence cannot see — e.g. typing into a shell REPL. Interactive typing
    // must work, so the fence stays at process start/stop, not at keystrokes.
    const isOwner = !goal && (state.goals.some((item) => item.ownerSessionID === input.sessionID) || hostMain)
    // Commands and goals now coexist (ticket per scope). No global command fence.
    if (!state.workspaceOperation && !protectedGoals.length && (!goal || goal.config.write_scope === undefined)) {
      // No protected goals, no checks running: shells from sibling sessions
      // run concurrently. The reservation below is still recorded BEFORE
      // execution, so a protected goal activating later sees it and refuses
      // (assertScopeAvailable fences on live uncontrolled calls) — the fence
      // lives at activation time, not at every unrelated shell.
      let paths: string[] = []
      let uncontrolled = false
      try {
        const writes = structuredWritePaths(input.tool, args)
        if (writes) paths = await Promise.all(writes.map((file) => canonicalScopePath(directory, file)))
        else uncontrolled = true
      } catch { uncontrolled = true }
      state.workspaceCalls ??= []
      if (!state.workspaceCalls.some((call) => call.callID === input.callID && call.sessionID === input.sessionID)) {
        state.workspaceCalls.push({ callID: input.callID, sessionID: input.sessionID, goalID: goal?.id, generation: stampCallGeneration(state, goal?.id), paths, uncontrolled, at: new Date().toISOString() })
      }
      return state
    }
    const writes = structuredWritePaths(input.tool, args)
    if (!writes) {
      // Shell / arbitrary tools are never ticketed — prompt awareness only.
      // They run concurrently; the initial worker prompt explains the circumstance
      // (not injected on every tool call). Still record for observability.
      // Workers are never allowed to use shell (even if they also own another goal) — prompt awareness only.
      if (goal) {
        throw new Error(`Scope denied: uncontrolled tool "${input.tool}" in worker goal (shell can write, so it is never allowed here). Use read tools or ask the owner to grant a fixed executable via grant_approved_command.`)
      }
      if (!isOwner) {
        throw new Error(`Scope denied: unrecognized session/child "${input.sessionID}". Subagent writes are unsupported — make file writes from the worker session (or the owning main session), not from a nested subagent.`)
      }
      state.workspaceCalls ??= []
      if (!state.workspaceCalls.some((call) => call.callID === input.callID && call.sessionID === input.sessionID)) {
        state.workspaceCalls.push({ callID: input.callID, sessionID: input.sessionID, paths: [], uncontrolled: true, at: new Date().toISOString() })
      }
      return state
    }
    if (state.workspaceOperation) throw new Error(`Workspace operation ${state.workspaceOperation.id} is active; source writes are denied until it finishes.`)
    if (goal && (goal.status !== "active" || goal.scopeClosing)) throw new Error(`Scope denied: worker goal is ${goal.scopeClosing ? "closing" : goal.status}.`)
    if (!goal && !isOwner) {
      throw new Error(`Scope denied: unrecognized session/child "${input.sessionID}". Subagent writes are unsupported — make file writes from the worker session (or the owning main session), not from a nested subagent.`)
    }
    const paths = await Promise.all(writes.map((file) => canonicalScopePath(directory, file)))
    const artifact = goal?.config.artifactDir ? path.relative(directory, goal.config.artifactDir).split(path.sep).join("/") : undefined
    for (const file of paths) {
      const inArtifact = artifact && file.startsWith(`${artifact}/`)
      if (goal && !inArtifact && goal.config.write_scope !== undefined && !goal.config.write_scope.includes(file)) {
        throw new Error(`Scope denied: "${file}" is outside this goal's write_scope. Claim it before editing.`)
      }
      const owner = !inArtifact && held.find((item) => item.id !== goal?.id && item.config.workspaceWrite !== false && (item.config.write_scope === undefined || item.config.write_scope.includes(file)))
      if (owner) throw new Error(scopeConflictMessage({ goalID: owner.id, ownerSessionID: owner.ownerSessionID, name: owner.name, path: file }))
    }
    // Ticket-based per-scope write concurrency: disjoint files run in parallel.
    const tickets = ensureTickets(state)
    // Reclaim holders whose goal is terminal or gone (fail-tolerance: crash must not hold ticket forever)
    const holdersToKeep: typeof tickets.holders = []
    for (const h of tickets.holders) {
      if (!h.goalID) { holdersToKeep.push(h); continue }
      const g = state.goals.find((x) => x.id === h.goalID || (x as any).id === h.goalID)
      if (!g || isTerminal(g.status)) continue
      holdersToKeep.push(h)
    }
    if (holdersToKeep.length !== tickets.holders.length) tickets.holders = holdersToKeep
    // If file set overlaps any holder, queue instead of blocking globally.
    if (!canGrantTicket(state, paths)) {
      const existing = tickets.queue.find((w) => w.callID === input.callID)
      if (!existing) {
        const waiter = {
          waiterID: randomUUID(),
          goalID: goal?.id ?? "",
          sessionID: input.sessionID,
          callID: input.callID,
          files: paths,
          requestedAt: new Date().toISOString(),
          isOwner,
        }
        const idx = isOwner ? tickets.queue.findIndex((w) => !w.isOwner) : -1
        if (idx === -1) tickets.queue.push(waiter)
        else tickets.queue.splice(idx, 0, waiter)
        await logServerEvent(directory, "ticket.queued", { callID: input.callID, sessionID: input.sessionID, files: paths, position: queuePosition(state, input.callID) }).catch(() => {})
      }
      queuedPos = queuePosition(state, input.callID)
      queuedFiles = paths
      wasQueued = true
      return state
    }
    // Grant ticket for this write
    tickets.holders.push({
      ticketID: randomUUID(),
      goalID: goal?.id ?? "",
      sessionID: input.sessionID,
      callID: input.callID,
      files: paths,
      grantedAt: new Date().toISOString(),
      generation: stampCallGeneration(state, goal?.id),
    })
    await logServerEvent(directory, "ticket.granted", { callID: input.callID, sessionID: input.sessionID, files: paths }).catch(() => {})
    if (!state.workspaceCalls) state.workspaceCalls = []
    if (!state.workspaceCalls.some((call) => call.callID === input.callID && call.sessionID === input.sessionID)) {
      state.workspaceCalls.push({ callID: input.callID, sessionID: input.sessionID, goalID: goal?.id, generation: stampCallGeneration(state, goal?.id), paths, at: new Date().toISOString() })
    }
    return state
  })
  if (wasQueued) {
    throw new Error(`Write ticket queued for ${queuedFiles.join(", ")} — position ${queuedPos} in queue. Current holder is writing overlapping files. You will be woken when your ticket is granted; do not retry manually. While waiting, use read tools or prepare the next patch.`)
  }
}

export async function afterWorkspaceTool(directory: string, sessionID: string, callID: string, tool?: string): Promise<void> {
  if (tool && isWorkspaceToolExempt(tool)) return
  const snapshot = await readState(directory)
  const hasCall = snapshot.workspaceCalls?.some((call) => call.sessionID === sessionID && call.callID === callID)
  const hasTicket = snapshot.writeTickets?.holders.some((h) => h.callID === callID) || snapshot.writeTickets?.queue.some((w) => w.callID === callID)
  if (!hasCall && !hasTicket) return
  await mutateState(directory, `workspace.after:${callID}`, async (state) => {
    state.workspaceCalls = state.workspaceCalls?.filter((call) => call.sessionID !== sessionID || call.callID !== callID)
    // Release write ticket holder for this call and try to grant next waiter
    if (state.writeTickets) {
      state.writeTickets.holders = state.writeTickets.holders.filter((h) => h.callID !== callID)
      // Remove from queue as well (if it was queued and never granted)
      state.writeTickets.queue = state.writeTickets.queue.filter((w) => w.callID !== callID)
      // Grant next waiters whose files don't overlap with remaining holders (round-robin, owner priority already queued)
      // Try to grant in queue order, but allow disjoint files to be granted together.
      const remaining: typeof state.writeTickets.queue = []
      for (const waiter of state.writeTickets.queue) {
        if (canGrantTicket(state, waiter.files)) {
          state.writeTickets.holders.push({
            ticketID: randomUUID(),
            goalID: waiter.goalID,
            sessionID: waiter.sessionID,
            callID: waiter.callID,
            files: waiter.files,
            grantedAt: new Date().toISOString(),
          })
          await logServerEvent(directory, "ticket.granted.queued", { callID: waiter.callID, sessionID: waiter.sessionID, files: waiter.files }).catch(() => {})
        } else {
          remaining.push(waiter)
        }
      }
      state.writeTickets.queue = remaining
    }
    const now = Date.now()
    state.goals = state.goals.filter((goal) => {
      const live = (state.workspaceCalls ?? []).some((call) => call.goalID === goal.id && !isSyncStaleWorkspaceCall(state, call, now))
      if (!goal.scopeClearPending || live || state.workspaceOperation?.goalID === goal.id) return true
      retireWorker(state, goal)
      state.workspaceCalls = (state.workspaceCalls ?? []).filter((call) => !(call.goalID === goal.id && isSyncStaleWorkspaceCall(state, call, now)))
      state.runtimes = state.runtimes.filter((runtime) => runtime.goalID !== goal.id)
      return false
    })
    return state
  })
}

/**
 * A guarded v2 invocation reserves under `${context.id}:${randomUUID()}` so that
 * parallel nested calls in one host call stay distinct, while host evidence only
 * ever names the outer call id. Comparing those two forms for equality can never
 * succeed, so every missed v2 after-hook became a reservation no evidence could
 * release — a permanent fence over the whole workspace. A proven-terminal outer
 * call ends its nested reservations too: the host reports the outer call only
 * once the executors inside it have returned.
 */
function provesSameCall(reservationID: string, evidenceCallID: string): boolean {
  if (reservationID === evidenceCallID) return true
  return reservationID.startsWith(`${evidenceCallID}:`)
}

/** Recover a missed v1 after-hook using exact terminal tool-part evidence. */
export async function releaseTerminalWorkspaceCalls(directory: string, evidence: TerminalToolExecution[]): Promise<number> {
  if (!evidence.length) return 0
  const snapshot = await readState(directory)
  // Most terminal events have already run their after-hook (or are unrelated).
  // Do not rewrite the entire store for those events or duplicate replays.
  const relevant = evidence.some((proof) =>
    snapshot.workspaceCalls?.some((call) => call.sessionID === proof.sessionID && provesSameCall(call.callID, proof.callID)) ||
    snapshot.goals.some((goal) => goal.workerSessionID === proof.sessionID && snapshot.runtimes.some((rt) => rt.goalID === goal.id && rt.activeToolCallIDs?.some((id) => provesSameCall(id, proof.callID)))))
  if (!relevant) return 0
  let released = 0
  await mutateState(directory, "workspace.terminal-evidence", async (state) => {
    state.workspaceCalls = (state.workspaceCalls ?? []).filter((call) => {
      const proof = evidence.find((item) => item.sessionID === call.sessionID && provesSameCall(call.callID, item.callID) &&
        (item.status === "completed" || item.status === "error") && Number.isFinite(item.endedAt) &&
        typeof call.at === "string" && Number.isFinite(Date.parse(call.at)) && item.endedAt >= Date.parse(call.at))
      if (!proof) return true
      released += 1
      const goal = state.goals.find((item) => item.id === call.goalID && item.workerSessionID === call.sessionID)
      const rt = goal && state.runtimes.find((item) => item.goalID === goal.id)
      if (rt && (call.generation === undefined || rt.runGeneration === call.generation)) {
        rt.activeToolCallIDs = rt.activeToolCallIDs?.filter((id) => id !== call.callID && !provesSameCall(id, proof.callID))
      }
      return false
    })
    // Exempt/read tools have runtime tracking without a workspace reservation.
    // Recover their missed after-hooks from exact proof, never elapsed time.
    for (const goal of state.goals) {
      const rt = state.runtimes.find((item) => item.goalID === goal.id)
      // releaseLease removes turnStartedAt, but lastRunAt still identifies the
      // same generation's start. Missed read/error hooks can be tracked while
      // idle; retain the exact session/call and not-before-run proof checks.
      const started = rt?.turnStartedAt || rt?.lastRunAt
        ? Date.parse(rt.turnStartedAt ?? rt.lastRunAt!) : NaN
      if (!rt?.activeToolCallIDs?.length || !Number.isFinite(started)) continue
      rt.activeToolCallIDs = rt.activeToolCallIDs.filter((callID) => {
        if (state.workspaceCalls?.some((call) => call.sessionID === goal.workerSessionID && provesSameCall(call.callID, callID))) return true
        return !evidence.some((item) => item.sessionID === goal.workerSessionID && provesSameCall(callID, item.callID) &&
          (item.status === "completed" || item.status === "error") && Number.isFinite(item.endedAt) && item.endedAt >= started)
      })
    }
    return state
  })
  if (released) await logServerEvent(directory, "workspace.terminal-evidence-released", { released }).catch(() => {})
  return released
}

export async function reconcileTerminalWorkspaceCalls(directory: string, host: LoopHost): Promise<void> {
  if (host.readToolExecutions) {
    const state = await readState(directory)
    const sessions = [...new Set([
      ...(state.workspaceCalls ?? []).map((call) => call.sessionID),
      ...state.goals.filter((goal) => goal.workerSessionID && state.runtimes.some((rt) => rt.goalID === goal.id && rt.activeToolCallIDs?.length)).map((goal) => goal.workerSessionID!),
    ])]
    if (sessions.length) {
      const proof = await Promise.all(sessions.map(async (sessionID) => {
        try { return (await host.readToolExecutions!(sessionID)).filter((item) => item.sessionID === sessionID) }
        catch { return [] }
      }))
      await releaseTerminalWorkspaceCalls(directory, proof.flat())
    }
  }
  // Second, independent proof: a session the host positively cannot resolve
  // can never finish its write, so its goal-owned reservations are released.
  await releaseAbsentSessionWorkspaceCalls(directory, host)
}

/**
 * Release goal-owned reservations whose owning session the host positively
 * cannot resolve AND whose goal is terminal or already gone.
 *
 * Both conditions are required, deliberately:
 * (a) Goal deletion alone is not proof that a write finished — a retired
 *     worker can still be mid-write, so tombstones keep their fences.
 * (b) An unproven probe is never absence. Only a definitive `false` releases;
 *     a timeout, an auth error or a missing capability leaves the fence.
 *
 * Owner-session (goal-less) reservations are never auto-released: a long
 * owner build is indistinguishable from a leaked one, so that case is left to
 * the explicit owner release path.
 */
export async function releaseAbsentSessionWorkspaceCalls(directory: string, host: LoopHost): Promise<number> {
  if (!host.sessionKnown) return 0
  const snapshot = await readState(directory)
  const orphaned = (snapshot.workspaceCalls ?? []).filter((call) =>
    Boolean(call.goalID) &&
    !snapshot.goals.some((goal) => goal.id === call.goalID && !isTerminal(goal.status)),
  )
  if (!orphaned.length) return 0
  const sessions = [...new Set(orphaned.map((call) => call.sessionID))]
  const known = new Map<string, boolean | undefined>()
  for (const sessionID of sessions) {
    try { known.set(sessionID, await host.sessionKnown(sessionID)) }
    catch { known.set(sessionID, undefined) }
  }
  const gone = new Set(sessions.filter((sessionID) => known.get(sessionID) === false))
  if (!gone.size) return 0
  let released = 0
  await mutateState(directory, "workspace.absent-session", async (state) => {
    state.workspaceCalls = (state.workspaceCalls ?? []).filter((call) => {
      if (!call.goalID || !gone.has(call.sessionID)) return true
      if (state.goals.some((goal) => goal.id === call.goalID && !isTerminal(goal.status))) return true
      released += 1
      return false
    })
    // A fence was the only thing holding a closing goal open; now that it is
    // gone the flag must not outlive it.
    for (const goal of state.goals) {
      if (!goal.scopeClosing) continue
      if ((state.workspaceCalls ?? []).some((call) => call.goalID === goal.id) || state.workspaceOperation?.goalID === goal.id) continue
      goal.scopeClosing = false
      goal.updatedAt = new Date().toISOString()
    }
    return state
  })
  if (released) {
    await logServerEvent(directory, "workspace.absent-session-released", {
      released,
      sessions: [...gone],
    }).catch(() => {})
  }
  return released
}

/** Supported v2 execution guard, independent of host handling of hook defects. */
export function guardV2ToolEditor(directory: string, editor: V2ToolEditor, lifecycle?: {
  before(input: { tool: string; sessionID: string; callID: string }, args: Record<string, unknown>): Promise<void>
  after(input: { tool: string; sessionID: string; callID: string }, args: Record<string, unknown>, result: unknown): Promise<void>
}): Set<string> {
  if (typeof editor.list !== "function" || typeof editor.update !== "function") throw new Error("Scoped execution requires the v2 tool editor list/update execution surface.")
  const guarded = new Set<string>()
  for (const entry of editor.list()) {
    guarded.add(entry.id)
    editor.update(entry.id, (definition) => {
      const execute = definition.execute
      definition.execute = async (args, context) => {
        // CodeMode reuses its host call ID for parallel nested calls. Reserve
        // each actual invocation independently; never change the host context.
        const input = { tool: entry.id, sessionID: context.sessionID, callID: `${context.id}:${randomUUID()}` }
        const values = args as Record<string, unknown>
        if (lifecycle) await lifecycle.before(input, values)
        else await beforeWorkspaceTool(directory, input, values)
        let result: unknown
        try { result = await execute(args, context); return result as Awaited<ReturnType<typeof execute>> }
        finally {
          if (lifecycle) await lifecycle.after(input, values, result)
          else await afterWorkspaceTool(directory, input.sessionID, input.callID, input.tool)
        }
      }
    })
  }
  return guarded
}

/** Trusted configured checks only. This is coordination, not a filesystem/OS sandbox. */
export async function withWorkspaceOperation<T>(
  directory: string,
  goalID: string,
  sessionID: string,
  run: () => Promise<T>,
  opts?: { authorize?: (state: StoreState) => void },
): Promise<T> {
  const id = randomUUID()
  await mutateState(directory, `workspace.operation:${id}`, async (state) => {
    // Authority is re-read inside the same transaction that takes the lock, so
    // a concurrent rotation/retirement cannot authorize a later execution.
    opts?.authorize?.(state)
    // Fail-tolerance: reclaim holders whose goal already terminal or gone (crash must not hold lock)
    if (state.writeTickets?.holders) {
      const kept: typeof state.writeTickets.holders = []
      for (const h of state.writeTickets.holders) {
        if (!h.goalID) { kept.push(h); continue }
        const g = state.goals.find((x) => x.id === h.goalID || (x as any).id === h.goalID)
        if (!g || isTerminal(g.status)) continue
        kept.push(h)
      }
      state.writeTickets.holders = kept
    }
    // Ticket per scope for checks: any in-flight write ticket blocks checks (quiescence).
    // Also block if any uncontrolled shell/command is live — its writes are unknown.
    // Legacy workspaceCalls with structured paths also fence checks until cleared.
    const holders = state.writeTickets?.holders ?? []
    const hasUncontrolled = (state.workspaceCalls ?? []).some((c) => c.uncontrolled)
    const hasLegacyWrite = (state.workspaceCalls ?? []).some((c) => (c.paths?.length ?? 0) > 0)
    if (state.workspaceOperation || holders.length > 0 || hasUncontrolled || hasLegacyWrite) throw new Error("Workspace is busy with an operation or in-flight writes; verification denied until quiescent.")
    state.workspaceOperation = { id, goalID, sessionID }
    return state
  })
  try { return await run() } finally {
    await mutateState(directory, `workspace.operation-end:${id}`, async (state) => {
      if (state.workspaceOperation?.id === id) state.workspaceOperation = undefined
      const now = Date.now()
      state.goals = state.goals.filter((goal) => {
        const live = (state.workspaceCalls ?? []).some((call) => call.goalID === goal.id && !isSyncStaleWorkspaceCall(state, call, now))
        if (!goal.scopeClearPending || live || state.workspaceOperation?.goalID === goal.id) return true
        retireWorker(state, goal)
        state.workspaceCalls = (state.workspaceCalls ?? []).filter((call) => !(call.goalID === goal.id && isSyncStaleWorkspaceCall(state, call, now)))
        state.runtimes = state.runtimes.filter((runtime) => runtime.goalID !== goal.id)
        return false
      })
      return state
    })
  }
}
