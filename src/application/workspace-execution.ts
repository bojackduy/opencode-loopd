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

export function heldGoals(state: StoreState): Goal[] {
  return state.goals.filter((goal) => goal.status === "active" || goal.scopeClosing || state.workspaceCalls?.some((call) => call.goalID === goal.id) || state.workspaceOperation?.goalID === goal.id)
}

function mayBeAlive(pid?: number): boolean {
  if (!pid || pid < 1) return true
  try { process.kill(pid, 0); return true } catch (error: any) { return error?.code !== "ESRCH" }
}

export function assertScopeAvailable(state: StoreState, goal: Goal): void {
  if (goal.scopeClosing || state.workspaceCalls?.some((call) => call.goalID === goal.id)) {
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
    const call = state.workspaceCalls?.find((call) => call.goalID !== goal.id && (goal.config.write_scope === undefined || call.paths.some((file) => goal.config.write_scope!.includes(file))))
    if (call) throw new Error(`Scope conflict with in-flight call ${call.callID}, session ${call.sessionID}, path ${call.paths[0]}.`)
  }
}

export function retireWorker(state: StoreState, goal: Goal): void {
  if (!goal.workerSessionID) return
  state.retiredWorkerSessions = [...new Set([...(state.retiredWorkerSessions || []), goal.workerSessionID])]
}

export async function beforeWorkspaceTool(directory: string, input: { tool: string; sessionID: string; callID: string }, args: Record<string, unknown>): Promise<void> {
  await mutateState(directory, `workspace.before:${input.callID}`, async (state) => {
    const goal = state.goals.find((item) => item.workerSessionID === input.sessionID)
    if (state.retiredWorkerSessions?.includes(input.sessionID) && !readTools.has(input.tool)) throw new Error("Scope denied: retired worker session; late executions are fenced.")
    const held = heldGoals(state)
    const protectedGoals = held.filter((item) => item.config.write_scope !== undefined || item.config.workspaceWrite === false)
    // Preserve legacy operation when no scoped/read-only contract is present.
    if (readTools.has(input.tool)) return state
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
        state.workspaceCalls.push({ callID: input.callID, sessionID: input.sessionID, goalID: goal?.id, paths, uncontrolled, at: new Date().toISOString() })
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
      const call = state.workspaceCalls?.find((item) => item.paths.includes(file) && !(item.callID === input.callID && item.sessionID === input.sessionID))
      if (call) throw new Error(`Scope denied: "${file}" is being written by session ${call.sessionID}, call ${call.callID}.`)
    }
    if (!state.workspaceCalls) state.workspaceCalls = []
    if (!state.workspaceCalls.some((call) => call.callID === input.callID && call.sessionID === input.sessionID)) {
      state.workspaceCalls.push({ callID: input.callID, sessionID: input.sessionID, goalID: goal?.id, generation: state.runtimes.find((runtime) => runtime.goalID === goal?.id)?.runGeneration, paths, at: new Date().toISOString() })
    }
    return state
  })
}

export async function afterWorkspaceTool(directory: string, sessionID: string, callID: string): Promise<void> {
  await mutateState(directory, `workspace.after:${callID}`, async (state) => {
    state.workspaceCalls = state.workspaceCalls?.filter((call) => call.sessionID !== sessionID || call.callID !== callID)
    state.goals = state.goals.filter((goal) => {
      if (!goal.scopeClearPending || state.workspaceCalls?.some((call) => call.goalID === goal.id) || state.workspaceOperation?.goalID === goal.id) return true
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
    if (state.workspaceOperation || state.workspaceCalls?.length) throw new Error("Workspace is busy with an operation or in-flight writes; verification denied until quiescent.")
    state.workspaceOperation = { id, goalID, sessionID }
    return state
  })
  try { return await run() } finally {
    await mutateState(directory, `workspace.operation-end:${id}`, async (state) => {
      if (state.workspaceOperation?.id === id) state.workspaceOperation = undefined
      state.goals = state.goals.filter((goal) => {
        if (!goal.scopeClearPending || state.workspaceCalls?.some((call) => call.goalID === goal.id)) return true
        state.runtimes = state.runtimes.filter((runtime) => runtime.goalID !== goal.id)
        return false
      })
      return state
    })
  }
}
