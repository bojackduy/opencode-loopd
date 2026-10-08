import { afterEach, describe, expect, it } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createGoal, type GoalID } from "../../src/domain/goal"
import { createRuntimeState } from "../../src/domain/runtime"
import { claimGoalScope, GoalScopeConflictError } from "../../src/application/goal-scope"
import { mutateState, readState } from "../../src/infrastructure/state-repository"
import { createGoalService } from "../../src/application/goal-service"
import { createFakeHost } from "../../src/server/host-adapter"
import { beforeWorkspaceTool, afterWorkspaceTool } from "../../src/application/workspace-execution"
import { goalTools } from "../../src/server/goal-tools"
import { createCommandService } from "../../src/application/command-service"
import { createFakeCommandHost } from "../../src/server/command-host"
import { createControlService } from "../../src/application/control-service"
import { createCommandSession } from "../../src/domain/command-session"

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))) })

async function fixture(scopes: string[][] = [[], []]) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "loopd-claim-"))
  roots.push(root)
  await mutateState(root, "fixture", async (state) => {
    scopes.forEach((write_scope, index) => {
      const id = `goal-${index}` as GoalID
      state.goals.push(createGoal({ id, name: id, objective: "test", ownerSessionID: `owner-${index}`, workerSessionID: `worker-${index}`, status: "active", config: { workspaceWrite: true, write_scope } }))
      const runtime = createRuntimeState(id)
      runtime.runGeneration = 1
      state.runtimes.push(runtime)
    })
    return state
  })
  return root
}
function claim(root: string, index: number, paths: string[]) {
  return claimGoalScope(root, `goal-${index}` as GoalID, `worker-${index}`, 1, paths)
}

describe("persisted scope claims", () => {
  it("unsupported v1-like hosts refuse scoped starts/claims and fence persisted scoped workers on restart", async () => {
    const root = await fixture([])
    const host = createFakeHost()
    host.scopedExecution = false
    const service = createGoalService(host)
    for (const write_scope of [[], ["a.ts"]]) await expect(service.start(root, { name: "unsupported", objective: "test", ownerSessionID: "parent", config: { write_scope } })).rejects.toThrow("unsupported")
    expect((await readState(root)).goals).toHaveLength(0)
    const persisted = await fixture([[]])
    await service.reconcile(persisted)
    const state = await readState(persisted)
    expect(state.goals[0]!.status).toBe("blocked")
    expect(state.goals[0]!.scopeClosing).toBe(true)
    expect(state.retiredWorkerSessions).toContain("worker-0")
    expect(host.prompts).toHaveLength(0)
    const result = JSON.parse((await goalTools(persisted, service).claim_goal_scope.execute({ paths: ["a.ts"], runGeneration: 1 }, { sessionID: "worker-0" })).output)
    expect(result.errorCode).toBe("unsupported_scope_host")
  })

  it("lost command handles keep an orphan process fence even after log removal", async () => {
    const root = await fixture([])
    const command = createCommandSession({ id: "orphan", title: "orphan", command: "test", cwd: root, ownerSessionID: "parent", pid: process.pid, notifyOnExit: false })
    await mutateState(root, "orphan", async (state) => { state.commands = [command]; return state })
    const commands = createCommandService(createFakeCommandHost())
    await commands.reconcile(root)
    expect((await readState(root)).orphanedCommandProcesses).toEqual([{ commandID: "orphan", pid: process.pid }])
    await commands.remove(root, command.id, "parent")
    const service = createGoalService(createFakeHost())
    await expect(service.start(root, { name: "protected", objective: "test", ownerSessionID: "parent", config: { write_scope: [] } })).rejects.toThrow("exit is unproved")
  })

  it("steers explicit scopes through explore-claim-edit-controlled verification without polling", async () => {
    const root = await fixture([])
    const host = createFakeHost()
    await createGoalService(host).start(root, { name: "explore", objective: "test", ownerSessionID: "parent", config: { write_scope: [] } })
    expect(host.prompts[0]).toContain("exploration-only")
    expect(host.prompts[0]).toContain("claim_goal_scope")
    expect(host.prompts[0]).toContain("run_goal_checks")
    expect(host.prompts[0]).toContain("never sleep, poll claims")
    expect(host.prompts[0]).toContain("no automatic queue")
  })

  it("existing uncontrolled tools and running commands fence protected activation without polling", async () => {
    const root = await fixture([])
    const service = createGoalService(createFakeHost())
    const start = () => service.start(root, { name: "protected", objective: "test", ownerSessionID: "parent", config: { write_scope: [] } })
    await beforeWorkspaceTool(root, { tool: "bash", sessionID: "parent", callID: "shell" }, { command: "anything" })
    await expect(start()).rejects.toThrow("uncontrolled")
    await afterWorkspaceTool(root, "parent", "shell")
    const commandHost = createFakeCommandHost()
    const commands = createCommandService(commandHost)
    const command = await commands.start(root, { title: "existing", command: "anything", ownerSessionID: "parent" })
    await expect(start()).rejects.toThrow("still running")
    await commands.terminate(root, command.id, "parent")
    await start()
    await expect(commands.start(root, { title: "bypass", command: "anything", ownerSessionID: "parent" })).rejects.toThrow("uncontrolled")
    expect(commandHost.procs.size).toBe(1)
    await expect(commands.write(root, command.id, "parent", "anything")).rejects.toThrow("uncontrolled")
    const result = await createControlService().execute(root, { command: "clear", requestID: "legacy", goalID: (await readState(root)).goals[0]!.id } as any)
    expect(result.errorCode).toBe("unsupported_scope")
    expect((await readState(root)).goals).toHaveLength(1)
  })

  it("simultaneous overlapping resumes cannot both reacquire, including across service instances", async () => {
    const root = await fixture([["same.ts"], ["same.ts"]])
    await mutateState(root, "park", async (state) => { state.goals.forEach((goal) => { goal.status = "paused" }); return state })
    const first = createGoalService(createFakeHost())
    const second = createGoalService(createFakeHost())
    const results = await Promise.allSettled([first.resume(root, "goal-0" as GoalID), second.resume(root, "goal-1" as GoalID)])
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
    expect((await readState(root)).goals.filter((goal) => goal.status === "active")).toHaveLength(1)
  })

  it("completion and block publish transactionally without dropping in-flight ownership", async () => {
    for (const terminal of ["complete_goal", "block_goal"] as const) {
      const root = await fixture([])
      const service = createGoalService(createFakeHost())
      const { goal } = await service.start(root, { name: "first", objective: "test", ownerSessionID: "parent", config: { write_scope: ["a.ts", "b.ts"] } })
      const worker = goal.workerSessionID!
      await beforeWorkspaceTool(root, { tool: "write", sessionID: worker, callID: "write" }, { filePath: "a.ts" })
      const tool = goalTools(root, service)[terminal]
      await tool.execute({ summary: "done", evidence: "test", reason: "external", needed: "input" } as any, { sessionID: worker })
      expect((await readState(root)).workspaceCalls).toHaveLength(1)
      await expect(service.start(root, { name: "overlap", objective: "test", ownerSessionID: "parent", config: { write_scope: ["b.ts"] } })).rejects.toThrow("b.ts")
      await afterWorkspaceTool(root, worker, "write")
      await service.start(root, { name: "new", objective: "test", ownerSessionID: "parent", config: { write_scope: ["b.ts"] } })
    }
  })

  it("real simultaneous starts allow disjoint scopes and overlapping starts have one winner", async () => {
    const root = await fixture([])
    const service = createGoalService(createFakeHost())
    const start = (name: string, write_scope: string[]) => service.start(root, { name, objective: "test", ownerSessionID: "parent", config: { write_scope } })
    await Promise.all([start("a", ["a.ts"]), start("b", ["b.ts"])])
    const results = await Promise.allSettled([start("c", ["same.ts"]), start("d", ["same.ts"])])
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
    expect((await readState(root)).goals).toHaveLength(3)
  })

  it("pause retains full ownership through in-flight writes, then resume rotates and fences the old session", async () => {
    const root = await fixture([])
    const service = createGoalService(createFakeHost())
    const { goal } = await service.start(root, { name: "first", objective: "test", ownerSessionID: "parent", config: { write_scope: ["a.ts", "b.ts"] } })
    const oldWorker = goal.workerSessionID!
    await beforeWorkspaceTool(root, { tool: "write", sessionID: oldWorker, callID: "write" }, { filePath: "a.ts" })
    await service.pause(root, goal.id)
    await expect(service.resume(root, goal.id)).rejects.toThrow("in-flight")
    await expect(service.start(root, { name: "overlap", objective: "test", ownerSessionID: "parent", config: { write_scope: ["b.ts"] } })).rejects.toThrow("b.ts")
    await afterWorkspaceTool(root, oldWorker, "write")
    await service.resume(root, goal.id)
    expect((await readState(root)).goals[0]!.workerSessionID).not.toBe(oldWorker)
    await expect(beforeWorkspaceTool(root, { tool: "write", sessionID: oldWorker, callID: "late" }, { filePath: "a.ts" })).rejects.toThrow("retired")
  })

  it("clear keeps an ownership tombstone across restart until the reserved tool finishes", async () => {
    const root = await fixture([])
    const service = createGoalService(createFakeHost())
    const { goal } = await service.start(root, { name: "first", objective: "test", ownerSessionID: "parent", config: { write_scope: ["a.ts", "b.ts"] } })
    const worker = goal.workerSessionID!
    await beforeWorkspaceTool(root, { tool: "write", sessionID: worker, callID: "write" }, { filePath: "a.ts" })
    await service.clear(root, goal.id)
    expect((await readState(root)).goals[0]!.scopeClearPending).toBe(true)
    const restarted = createGoalService(createFakeHost())
    await expect(restarted.start(root, { name: "overlap", objective: "test", ownerSessionID: "parent", config: { write_scope: ["b.ts"] } })).rejects.toThrow("b.ts")
    await afterWorkspaceTool(root, worker, "write")
    expect((await readState(root)).goals).toHaveLength(0)
    await expect(beforeWorkspaceTool(root, { tool: "write", sessionID: worker, callID: "late" }, { filePath: "a.ts" })).rejects.toThrow("retired")
    await restarted.start(root, { name: "new", objective: "test", ownerSessionID: "parent", config: { write_scope: ["b.ts"] } })
  })

  it("allows simultaneous disjoint claims and reconstructs them from disk", async () => {
    const root = await fixture()
    expect(await Promise.all([claim(root, 0, ["src/a.ts"]), claim(root, 1, ["src/b.ts"])]))
      .toEqual([["src/a.ts"], ["src/b.ts"]])
    expect((await readState(root)).goals.map((goal) => goal.config.write_scope)).toEqual([["src/a.ts"], ["src/b.ts"]])
  })

  it("simultaneous overlapping initial claims cannot both succeed", async () => {
    const root = await fixture()
    const results = await Promise.allSettled([claim(root, 0, ["same.ts", "a.ts"]), claim(root, 1, ["same.ts", "b.ts"])])
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
    const rejected = results.find((result) => result.status === "rejected") as PromiseRejectedResult
    expect(rejected.reason).toBeInstanceOf(GoalScopeConflictError)
    expect(rejected.reason.kind).toBe("initial")
    const scopes = (await readState(root)).goals.map((goal) => goal.config.write_scope!)
    expect(scopes.filter((scope) => scope.includes("same.ts"))).toHaveLength(1)
    expect(scopes.filter((scope) => scope.length === 0)).toHaveLength(1)
  })

  it("expansion conflict leaves the entire persisted scope and revision unchanged", async () => {
    const root = await fixture([["a.ts"], ["b.ts"]])
    const before = await readState(root)
    let error: GoalScopeConflictError | undefined
    try { await claim(root, 0, ["new.ts", "b.ts"]) } catch (caught) { error = caught as GoalScopeConflictError }
    expect(error?.kind).toBe("expansion")
    expect(error?.conflict).toMatchObject({ path: "b.ts", goalID: "goal-1", ownerSessionID: "owner-1" })
    expect(await readState(root)).toEqual(before)
  })

  it("fences stale sessions, generations, parked goals and read-only goals", async () => {
    const root = await fixture()
    await expect(claimGoalScope(root, "goal-0" as GoalID, "other-worker", 1, ["a.ts"])).rejects.toThrow("stale")
    await expect(claimGoalScope(root, "goal-0" as GoalID, "worker-0", 0, ["a.ts"])).rejects.toThrow("stale")
    await mutateState(root, "park", async (state) => { state.goals[0]!.status = "paused"; state.goals[1]!.config.workspaceWrite = false; return state })
    await expect(claim(root, 0, ["a.ts"])).rejects.toThrow("paused")
    await expect(claim(root, 1, ["b.ts"])).rejects.toThrow("Read-only")
    expect((await readState(root)).goals.every((goal) => goal.config.write_scope?.length === 0)).toBe(true)
  })

  it("canonical symlink aliases conflict transactionally and unsafe multi-claims do not partially persist", async () => {
    const root = await fixture()
    await fs.mkdir(path.join(root, "src"))
    await fs.symlink("src", path.join(root, "alias"))
    await claim(root, 0, ["src/new.ts"])
    await expect(claim(root, 1, ["alias/new.ts", "okay.ts"])).rejects.toThrow("src/new.ts")
    await expect(claim(root, 1, ["okay.ts", "../bad.ts"])).rejects.toThrow("outside")
    expect((await readState(root)).goals[1]!.config.write_scope).toEqual([])
  })

  it("legacy whole writer denies initial claim while legacy claimant cannot silently downgrade", async () => {
    const root = await fixture()
    await mutateState(root, "legacy", async (state) => { delete state.goals[0]!.config.write_scope; return state })
    await expect(claim(root, 1, ["a.ts"])).rejects.toThrow("goal-0")
    await expect(claim(root, 0, ["a.ts"])).rejects.toThrow("already own")
  })
})
