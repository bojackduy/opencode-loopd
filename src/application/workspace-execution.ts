import { randomUUID } from "node:crypto"
import path from "node:path"
import type { ToolEditor as V2ToolEditor } from "@opencode/plugin/promise/tool"
import type { Goal } from "../domain/goal"
import { mutateState, type StoreState } from "../infrastructure/state-repository"
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
])
const ownerTools = new Set(["loopd_create_goal", "switch_goal_identity", "pause_goal", "resume_goal", "clear_goal", "abort_goal_worker", "nudge_goal", "send_goal_input", "force_block_goal", "force_complete_goal"])

/** Only known structured formats are trusted; shell/custom/batch cannot be inferred safe. */
export function structuredWritePaths(tool: string, args: Record<string, unknown>): string[] | undefined {
  if (tool === "write" || tool === "edit") {
    if (typeof args.filePath !== "string") throw new Error(`Scope denied: ${tool} requires filePath.`)
    return [args.filePath]
  }
  if (tool !== "apply_patch") return undefined
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
// The sweeper below reaps what can no longer complete and resets/finalizes
// the orphaned flags. It runs in maintenance (with worker liveness), in
// reconcile (sync, restart-safe), and inline in resume/retry/clear.
//
// TTL justification (conservative — a healthy reservation lasts seconds, a
// slow structured edit at most ~1-2 min; the host lock stale window is 10s
// and the tool-call TTL is 30s):
// - STALE_WORKSPACE_CALL_TTL_MS (10 min): >5x any healthy reservation.
//   A call older than this with no live worker backing cannot still complete.
// - CLEAR_PENDING_FORCE_TTL_MS (30 min): deferred clear gives reserved tools
//   ample drain; past this the goal is force-finalized with an event log.
// - OWNER_CALL_TTL_MS (30 min): owner-session (goalID None) reservations such
//   as long builds must NOT be reaped while plausibly live, so they are only
//   eligible after a longer window — and never while fresh.
// NEVER reap a call that could still complete: same-generation + live worker
// + fresh activity is always kept.
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
}

function callAgeMs(call: { at?: string }, now: number): number {
  if (!call.at) return Number.POSITIVE_INFINITY
  const age = now - Date.parse(call.at)
  return Number.isFinite(age) ? age : Number.POSITIVE_INFINITY
}

function runtimeActivityFresh(state: StoreState, goalID: string | undefined, now: number): boolean {
  if (!goalID) return false
  const rt = state.runtimes.find((r) => r.goalID === goalID)
  if (!rt?.lastActivityAt) return false
  const age = now - Date.parse(rt.lastActivityAt)
  return Number.isFinite(age) && age < STALE_WORKSPACE_CALL_TTL_MS
}

/** Generation-superseded: the goal rotated generation (resume/retry fence), so this reservation belongs to a retired session. */
export function isGenerationSuperseded(
  state: StoreState,
  call: { goalID?: string; generation?: number },
): boolean {
  if (call.generation === undefined || !call.goalID) return false
  const rt = state.runtimes.find((r) => r.goalID === call.goalID)
  return !!rt && call.generation < rt.runGeneration
}

/**
 * Sync stale check — usable inside transactions WITHOUT host liveness proof.
 * Deliberately narrow: only what is provably dead from state alone
 * (superseded generation, goal gone, or age past the force TTL).
 * Fresh/ambiguous calls are kept; the async sweeper (with liveness) reaps more.
 */
export function isSyncStaleWorkspaceCall(
  state: StoreState,
  call: { goalID?: string; generation?: number; at?: string },
  now = Date.now(),
): boolean {
  if (isGenerationSuperseded(state, call)) return true
  if (call.goalID && !state.goals.some((g) => g.id === call.goalID)) return true
  return callAgeMs(call, now) > CLEAR_PENDING_FORCE_TTL_MS
}

/**
 * Full liveness-aware stale check. A call is stale when it is sync-stale, or
 * when it is older than the call TTL with no live worker backing it, or (for
 * owner-session reservations with no goal) older than the longer owner TTL.
 * Same-generation + live worker + fresh activity is NEVER stale.
 */
export function isStaleWorkspaceCall(
  state: StoreState,
  call: { goalID?: string; generation?: number; at?: string; sessionID: string },
  liveness: SweepLiveness = {},
): boolean {
  if (isSyncStaleWorkspaceCall(state, call, liveness.now ?? Date.now())) return true
  const now = liveness.now ?? Date.now()
  const age = callAgeMs(call, now)
  if (!call.goalID) return age > OWNER_CALL_TTL_MS
  const goal = state.goals.find((g) => g.id === call.goalID)
  if (!goal) return true
  if (age <= STALE_WORKSPACE_CALL_TTL_MS) return false
  const live = liveness.isWorkerLive?.(goal.id, goal.workerSessionID) ?? false
  if (live && runtimeActivityFresh(state, goal.id, now)) return false
  if (live) {
    // Live worker but the reservation AND the runtime are both quiet past the
    // TTL: the before-hook reservation leaked (missed after-hook). The worker
    // session itself is unaffected — only the dead reservation is reaped, and
    // late completions stay fenced via retiredWorkerSessions after rotation.
    // Still, require the longer force window before reaping under a live
    // worker, so a slow-but-genuine tool is never cut early.
    return age > CLEAR_PENDING_FORCE_TTL_MS
  }
  return true
}

/** Live (non-stale) calls only — what genuinely fences activation and checks. */
export function liveWorkspaceCalls(
  state: StoreState,
  liveness: SweepLiveness = {},
): NonNullable<StoreState["workspaceCalls"]> {
  return (state.workspaceCalls ?? []).filter((call) => !isStaleWorkspaceCall(state, call, liveness))
}

/**
 * Mutates state in place (call inside mutateState): reaps stale calls,
 * resets orphaned scopeClosing (no calls reference the goal, no operation,
 * no live worker), and finalizes scopeClearPending deletions once calls are
 * gone (force after the longer TTL, with the caller logging the event).
 */
export function sweepStaleWorkspaceState(
  state: StoreState,
  liveness: SweepLiveness = {},
): WorkspaceSweepSummary {
  const now = liveness.now ?? Date.now()
  const summary: WorkspaceSweepSummary = { reapedCalls: [], resetClosing: [], finalizedClears: [], forceCleared: [] }
  const clearPendingGoals = new Set<string>(
    state.goals.filter((g) => g.scopeClearPending).map((g) => g.id),
  )
  const before = state.workspaceCalls ?? []
  const kept = before.filter((call) => {
    // Reservations of deferred-clear tombstones drain naturally via their
    // after-hooks while fresh; the force path below reaps them past the
    // longer TTL. (Only generation-superseded / goal-gone reservations are
    // provably dead without any age argument.)
    if (
      call.goalID &&
      clearPendingGoals.has(call.goalID) &&
      !isGenerationSuperseded(state, call) &&
      state.goals.some((g) => g.id === call.goalID)
    ) {
      return true
    }
    if (!isStaleWorkspaceCall(state, call, { ...liveness, now })) return true
    summary.reapedCalls.push({
      callID: call.callID,
      sessionID: call.sessionID,
      goalID: call.goalID,
      reason: isGenerationSuperseded(state, call)
        ? "generation-superseded"
        : call.goalID && !state.goals.some((g) => g.id === call.goalID)
          ? "goal-gone"
          : "age-ttl-no-live-backing",
    })
    return false
  })
  state.workspaceCalls = kept
  for (const goal of state.goals) {
    const referenced = kept.some((call) => call.goalID === goal.id) || state.workspaceOperation?.goalID === goal.id
    if (goal.scopeClosing && !referenced && !(liveness.isWorkerLive?.(goal.id, goal.workerSessionID) ?? false)) {
      goal.scopeClosing = false
      goal.updatedAt = new Date(now).toISOString()
      summary.resetClosing.push(goal.id)
    }
    if (goal.scopeClearPending && !referenced) {
      state.goals = state.goals.filter((g) => g.id !== goal.id)
      state.runtimes = state.runtimes.filter((r) => r.goalID !== goal.id)
      state.commandAwaits = (state.commandAwaits ?? []).filter((a) => a.goalID !== goal.id)
      summary.finalizedClears.push(goal.id)
    }
  }
  // Force path: scopeClearPending stuck WITH referencing calls past the force
  // TTL — reap those calls and finalize. Recorded as forceCleared so the
  // caller emits an event log (terminal deletion must stay auditable).
  for (const goal of [...state.goals]) {
    if (!goal.scopeClearPending) continue
    const refs = (state.workspaceCalls ?? []).filter((call) => call.goalID === goal.id)
    if (!refs.length) continue
    if (refs.every((call) => callAgeMs(call, now) > CLEAR_PENDING_FORCE_TTL_MS)) {
      for (const call of refs) {
        summary.reapedCalls.push({ callID: call.callID, sessionID: call.sessionID, goalID: call.goalID, reason: "clear-pending-force" })
      }
      state.workspaceCalls = (state.workspaceCalls ?? []).filter((call) => call.goalID !== goal.id)
      if (!(state.workspaceCalls ?? []).some((call) => call.goalID === goal.id) && state.workspaceOperation?.goalID !== goal.id) {
        state.goals = state.goals.filter((g) => g.id !== goal.id)
        state.runtimes = state.runtimes.filter((r) => r.goalID !== goal.id)
        state.commandAwaits = (state.commandAwaits ?? []).filter((a) => a.goalID !== goal.id)
        summary.forceCleared.push(goal.id)
      }
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
  // Provably-dead reservations (superseded, goal-less, age past force TTL)
  // retain no ownership — otherwise file locks survive the reap. Live calls
  // (fresh or ambiguous) still hold the goal.
  const now = Date.now()
  return state.goals.filter((goal) => goal.status === "active" || goal.scopeClosing || (state.workspaceCalls ?? []).some((call) => call.goalID === goal.id && !isSyncStaleWorkspaceCall(state, call, now)) || state.workspaceOperation?.goalID === goal.id)
}

function mayBeAlive(pid?: number): boolean {
  if (!pid || pid < 1) return true
  try { process.kill(pid, 0); return true } catch (error: any) { return error?.code !== "ESRCH" }
}

export function assertScopeAvailable(state: StoreState, goal: Goal): void {
  // Stale (provably dead) reservations never fence: only live same-goal calls
  // and scopeClosing block reacquisition. The async sweeper (with liveness)
  // reaps more; this sync check covers what state alone proves.
  const now = Date.now()
  const liveCalls = (state.workspaceCalls ?? []).filter(
    (call) => call.goalID === goal.id && !isSyncStaleWorkspaceCall(state, call, now),
  )
  if (goal.scopeClosing || liveCalls.length) {
    throw new Error("Goal still has closing/in-flight writes; ownership cannot be reacquired before quiescence.")
  }
  if (state.workspaceOperation) throw new Error(`Workspace operation ${state.workspaceOperation.id} is active.`)
  if (goal.config.write_scope !== undefined || goal.config.workspaceWrite === false) {
    const orphan = [...(state.orphanedCommandProcesses || []), ...(state.commands || []).filter((command) => command.status === "missing").map((command) => ({ commandID: command.id, pid: command.pid }))].find((process) => mayBeAlive(process.pid))
    if (orphan) throw new Error(`Protected activation denied: command ${orphan.commandID} lost its handle and process exit is unproved. Stop/verify the orphan process externally; removing its log does not release this fence.`)
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
  if (goal.config.workspaceWrite !== false && goal.config.write_scope?.length !== 0) {
    const now2 = Date.now()
    const call = state.workspaceCalls?.find((call) => call.goalID !== goal.id && !isSyncStaleWorkspaceCall(state, call, now2) && (goal.config.write_scope === undefined || call.paths.some((file) => goal.config.write_scope!.includes(file))))
    if (call) throw new Error(`Scope conflict with in-flight call ${call.callID}, session ${call.sessionID}, path ${call.paths[0]}.`)
  }
}

export function retireWorker(state: StoreState, goal: Goal): void {
  if (!goal.workerSessionID) return
  state.retiredWorkerSessions = [...new Set([...(state.retiredWorkerSessions || []), goal.workerSessionID])]
}

export async function beforeWorkspaceTool(directory: string, input: { tool: string; sessionID: string; callID: string }, args: Record<string, unknown>): Promise<void> {
  // These tools were already unconditionally exempt, including retired
  // sessions. No shared-state decision or reservation needs a transaction.
  if (readTools.has(input.tool)) return
  await mutateState(directory, `workspace.before:${input.callID}`, async (state) => {
    const goal = state.goals.find((item) => item.workerSessionID === input.sessionID)
    if (state.retiredWorkerSessions?.includes(input.sessionID)) throw new Error("Scope denied: retired worker session; late executions are fenced.")
    const held = heldGoals(state)
    const protectedGoals = held.filter((item) => item.config.write_scope !== undefined || item.config.workspaceWrite === false)
    // Preserve legacy operation when no scoped/read-only contract is present.
    if (!goal && ownerTools.has(input.tool) && (!protectedGoals.length || state.goals.some((item) => item.ownerSessionID === input.sessionID))) return state
    if (!state.workspaceOperation && !protectedGoals.length && (!goal || goal.config.write_scope === undefined && goal.config.workspaceWrite !== false)) {
      // Preserve unscoped executors, but reserve them BEFORE execution so a
      // protected goal cannot activate in the middle of an existing shell/tool.
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
    if (!writes) throw new Error(`Scope denied: uncontrolled tool "${input.tool}". Shell, commands, custom tools, batch and subagents are not allowed while protected goals exist. Use structured edits or run_goal_checks.`)
    if (state.workspaceOperation) throw new Error(`Workspace operation ${state.workspaceOperation.id} is active; source writes are denied until it finishes.`)
    if (goal && (goal.status !== "active" || goal.scopeClosing)) throw new Error(`Scope denied: worker goal is ${goal.scopeClosing ? "closing" : goal.status}.`)
    // Unknown child sessions fail closed; only explicitly persisted workers and owners may write.
    if (!goal && !state.goals.some((item) => item.ownerSessionID === input.sessionID)) {
      throw new Error("Scope denied: unrecognized session/child. Subagent writes are unsupported.")
    }
    const paths = await Promise.all(writes.map((file) => canonicalScopePath(directory, file)))
    const artifact = goal?.config.artifactDir ? path.relative(directory, goal.config.artifactDir).split(path.sep).join("/") : undefined
    for (const file of paths) {
      const inArtifact = artifact && file.startsWith(`${artifact}/`)
      if (goal && !inArtifact && (goal.config.workspaceWrite === false || goal.config.write_scope !== undefined && !goal.config.write_scope.includes(file))) {
        throw new Error(`Scope denied: "${file}" is outside this goal's write_scope. Claim it before editing.`)
      }
      const owner = !inArtifact && held.find((item) => item.id !== goal?.id && item.config.workspaceWrite !== false && (item.config.write_scope === undefined || item.config.write_scope.includes(file)))
      if (owner) throw new Error(scopeConflictMessage({ goalID: owner.id, ownerSessionID: owner.ownerSessionID, name: owner.name, path: file }))
      const now3 = Date.now()
      const call = state.workspaceCalls?.find((item) => !isSyncStaleWorkspaceCall(state, item, now3) && item.paths.includes(file) && !(item.callID === input.callID && item.sessionID === input.sessionID))
      if (call) throw new Error(`Scope denied: "${file}" is being written by session ${call.sessionID}, call ${call.callID}.`)
    }
    if (!state.workspaceCalls) state.workspaceCalls = []
    if (!state.workspaceCalls.some((call) => call.callID === input.callID && call.sessionID === input.sessionID)) {
      // Always stamp a generation for goal calls (fallback 0 when the runtime
      // lookup misses) so generation-fencing covers every reservation.
      // Owner-session (goal-less) reservations keep generation undefined.
      state.workspaceCalls.push({ callID: input.callID, sessionID: input.sessionID, goalID: goal?.id, generation: stampCallGeneration(state, goal?.id), paths, at: new Date().toISOString() })
    }
    return state
  })
}

export async function afterWorkspaceTool(directory: string, sessionID: string, callID: string): Promise<void> {
  await mutateState(directory, `workspace.after:${callID}`, async (state) => {
    state.workspaceCalls = state.workspaceCalls?.filter((call) => call.sessionID !== sessionID || call.callID !== callID)
    const now = Date.now()
    state.goals = state.goals.filter((goal) => {
      const live = (state.workspaceCalls ?? []).some((call) => call.goalID === goal.id && !isSyncStaleWorkspaceCall(state, call, now))
      if (!goal.scopeClearPending || live || state.workspaceOperation?.goalID === goal.id) return true
      state.workspaceCalls = (state.workspaceCalls ?? []).filter((call) => !(call.goalID === goal.id && isSyncStaleWorkspaceCall(state, call, now)))
      state.runtimes = state.runtimes.filter((runtime) => runtime.goalID !== goal.id)
      return false
    })
    return state
  })
}

/** Supported v2 execution guard, independent of host handling of hook defects. */
export function guardV2ToolEditor(directory: string, editor: V2ToolEditor): void {
  if (typeof editor.list !== "function" || typeof editor.update !== "function") throw new Error("Scoped execution requires the v2 tool editor list/update execution surface.")
  for (const entry of editor.list()) {
    editor.update(entry.id, (definition) => {
      const execute = definition.execute
      definition.execute = async (args, context) => {
        await beforeWorkspaceTool(directory, { tool: entry.name, sessionID: context.sessionID, callID: context.id }, args as Record<string, unknown>)
        try { return await execute(args, context) } finally { await afterWorkspaceTool(directory, context.sessionID, context.id) }
      }
    })
  }
}

/** Trusted configured checks only. This is coordination, not a filesystem/OS sandbox. */
export async function withWorkspaceOperation<T>(directory: string, goalID: string, sessionID: string, run: () => Promise<T>): Promise<T> {
  const id = randomUUID()
  await mutateState(directory, `workspace.operation:${id}`, async (state) => {
    // Live in-flight writes still fence checks; provably-dead reservations
    // (superseded generation, goal gone, age past force TTL) do not — the
    // sweeper reaps them, and gating checks on corpses was part of the limbo.
    const now = Date.now()
    const live = (state.workspaceCalls ?? []).filter((call) => !isSyncStaleWorkspaceCall(state, call, now))
    if (state.workspaceOperation || live.length) throw new Error("Workspace is busy with an operation or in-flight writes; verification denied until quiescent.")
    state.workspaceOperation = { id, goalID, sessionID }
    return state
  })
  try { return await run() } finally {
    await mutateState(directory, `workspace.operation-end:${id}`, async (state) => {
      if (state.workspaceOperation?.id === id) state.workspaceOperation = undefined
      const now = Date.now()
      state.goals = state.goals.filter((goal) => {
        const live = (state.workspaceCalls ?? []).some((call) => call.goalID === goal.id && !isSyncStaleWorkspaceCall(state, call, now))
        if (!goal.scopeClearPending || live) return true
        state.workspaceCalls = (state.workspaceCalls ?? []).filter((call) => !(call.goalID === goal.id && isSyncStaleWorkspaceCall(state, call, now)))
        state.runtimes = state.runtimes.filter((runtime) => runtime.goalID !== goal.id)
        return false
      })
      return state
    })
  }
}
