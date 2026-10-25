import { afterEach, describe, expect, it } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createGoal, type GoalID, type GoalStatus } from "../../src/domain/goal"
import { createRuntimeState } from "../../src/domain/runtime"
import { mutateState, readState } from "../../src/infrastructure/state-repository"
import {
  assertScopeAvailable,
  afterWorkspaceTool,
  beforeWorkspaceTool,
  withWorkspaceOperation,
} from "../../src/application/workspace-execution"
import { createFakeHost } from "../../src/server/host-adapter"
import { createCommandSession } from "../../src/domain/command-session"

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))) })

/** Persisted active scoped goal owned by "main" and worked by "worker-1". */
async function fixture(opts: { status?: GoalStatus; writeScope?: string[]; owner?: string; worker?: string } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "loopd-owner-exec-"))
  roots.push(root)
  await mutateState(root, "fixture", async (state) => {
    const id = "goal-1" as GoalID
    state.goals.push(createGoal({
      id,
      name: "scoped",
      objective: "test",
      status: opts.status ?? "active",
      ownerSessionID: opts.owner ?? "main",
      workerSessionID: opts.worker ?? "worker-1",
      config: { workspaceWrite: true, write_scope: opts.writeScope ?? [] },
    }))
    const runtime = createRuntimeState(id)
    runtime.runGeneration = 1
    state.runtimes.push(runtime)
    return state
  })
  return root
}

const shell = (root: string, sessionID: string, callID = "call-1", identity?: Parameters<typeof beforeWorkspaceTool>[3]) =>
  beforeWorkspaceTool(root, { tool: "shell", sessionID, callID }, { command: "python3", args: ["-c", "print('diag')"] }, identity)

describe("main/owner session execution under protected goals", () => {
  it("fences shell, writes and checks for a command's full lifetime, independent of goal linkage", async () => {
    const root = await fixture({ writeScope: ["src/a.ts"] })
    const command = createCommandSession({ id: "live-command" as any, title: "diagnostic", command: "python3", args: [], cwd: root, ownerSessionID: "main", goalID: "display-only" })
    await mutateState(root, "running-command", async (state) => {
      state.commands = [command]
      return state
    })
    await expect(shell(root, "main")).rejects.toThrow(/Workspace busy.*live-command/)
    await expect(beforeWorkspaceTool(root, { tool: "write", sessionID: "worker-1", callID: "write" }, { path: "src/a.ts", content: "x" })).rejects.toThrow(/Workspace busy.*live-command/)
    await expect(withWorkspaceOperation(root, "goal-1", "worker-1", async () => "ran")).rejects.toThrow(/Workspace busy.*live-command/)
    await mutateState(root, "command-exited", async (state) => {
      state.commands![0]!.status = "exited"
      return state
    })
    await shell(root, "main")
    await afterWorkspaceTool(root, "main", "call-1")
    expect(await withWorkspaceOperation(root, "goal-1", "worker-1", async () => "ran")).toBe("ran")
  })
  it("lets a persisted owner run an ordinary diagnostic shell and releases the reservation on exit", async () => {
    const root = await fixture()
    await shell(root, "main", "owner-call")

    const calls = (await readState(root)).workspaceCalls ?? []
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ callID: "owner-call", sessionID: "main", uncontrolled: true, paths: [] })

    await afterWorkspaceTool(root, "main", "owner-call", "shell")
    expect((await readState(root)).workspaceCalls ?? []).toHaveLength(0)
  })

  it("rejects an owner shell with an actionable busy error while another session's call is live", async () => {
    const root = await fixture()
    await mutateState(root, "seed", async (state) => {
      state.workspaceCalls = [{ callID: "worker-call", sessionID: "worker-1", goalID: "goal-1", generation: 1, paths: [], uncontrolled: true, at: new Date().toISOString() }]
      return state
    })

    const failure = shell(root, "main", "owner-call")
    await expect(failure).rejects.toThrow(/Workspace busy/)
    await expect(failure).rejects.toThrow(/worker-call/)
    await expect(failure).rejects.not.toThrow(/Scope denied/)
    expect((await readState(root)).workspaceCalls ?? []).toHaveLength(1)
  })

  it("rejects an owner shell while completion checks own the workspace", async () => {
    const root = await fixture()
    await mutateState(root, "seed", async (state) => {
      state.workspaceOperation = { id: "checks-1", goalID: "goal-1", sessionID: "worker-1" }
      return state
    })
    await expect(shell(root, "main", "owner-call")).rejects.toThrow(/Workspace busy/)
    await expect(shell(root, "main", "owner-call")).rejects.toThrow(/checks/)
  })

  for (const status of ["paused", "blocked"] as const) {
  it(`retains a ${status} goal's unfinished call until its after-hook proves exit`, async () => {
    const root = await fixture({ status })
    await mutateState(root, "leak", async (state) => {
      state.workspaceCalls = [{ callID: "leaked-write", sessionID: "worker-1", goalID: "goal-1", generation: 1, paths: ["src/a.ts"], at: new Date().toISOString() }]
      return state
    })

    await expect(shell(root, "main", "owner-call")).rejects.toThrow(/Workspace busy/)
    expect((await readState(root)).workspaceCalls?.map((call) => call.callID)).toEqual(["leaked-write"])
    await afterWorkspaceTool(root, "worker-1", "leaked-write")
    await shell(root, "main", "owner-call")

    const calls = (await readState(root)).workspaceCalls ?? []
    expect(calls.map((call) => call.callID)).toEqual(["owner-call"])
  })
  }

  it("keeps a worker's structured write out while an owner shell reservation is live", async () => {
    const root = await fixture({ writeScope: ["src/a.ts"] })
    await mutateState(root, "seed", async (state) => {
      state.workspaceCalls = [{ callID: "owner-shell", sessionID: "main", paths: [], uncontrolled: true, at: new Date().toISOString() }]
      return state
    })

    await expect(beforeWorkspaceTool(
      root,
      { tool: "write", sessionID: "worker-1", callID: "worker-write" },
      { path: "src/a.ts", content: "x" },
    )).rejects.toThrow(/Workspace busy/)
  })

  it("keeps checks and activation out while an owner shell reservation is live", async () => {
    const root = await fixture()
    await mutateState(root, "seed", async (state) => {
      state.workspaceCalls = [{ callID: "owner-shell", sessionID: "main", paths: [], uncontrolled: true, at: new Date().toISOString() }]
      return state
    })

    await expect(withWorkspaceOperation(root, "goal-1", "worker-1", async () => "ran")).rejects.toThrow(/busy/i)
    const state = await readState(root)
    expect(() => assertScopeAvailable(state, state.goals[0]!)).toThrow(/uncontrolled/i)
  })

  it("still denies an unrecognized child session with no host proof", async () => {
    const root = await fixture()
    await expect(shell(root, "child-9")).rejects.toThrow(/Scope denied/)
    await expect(shell(root, "child-9", "call-2", { isMainSession: async () => false })).rejects.toThrow(/Scope denied/)
    await expect(shell(root, "child-9", "call-3", { isMainSession: async () => undefined })).rejects.toThrow(/Scope denied/)
    expect((await readState(root)).workspaceCalls ?? []).toHaveLength(0)
  })

  it("admits a main session with no owned goals only on authoritative host proof", async () => {
    const root = await fixture({ owner: "someone-else" })
    await expect(shell(root, "root-main")).rejects.toThrow(/Scope denied/)
    expect((await readState(root)).workspaceCalls ?? []).toHaveLength(0)

    let asked: string[] = []
    await shell(root, "root-main", "proved", {
      isMainSession: async (sessionID) => { asked.push(sessionID); return true },
    })
    expect(asked).toEqual(["root-main"])
    expect((await readState(root)).workspaceCalls ?? []).toHaveLength(1)
  })

  it("gives worker restrictions precedence when a session is also an owner", async () => {
    const root = await fixture({ owner: "nested", worker: "worker-a" })
    await mutateState(root, "second-goal", async (state) => {
      state.goals.push(createGoal({
        id: "goal-2" as GoalID,
        name: "second",
        objective: "test",
        status: "active",
        ownerSessionID: "main",
        workerSessionID: "nested",
        config: { workspaceWrite: true, write_scope: ["src/b.ts"] },
      }))
      const runtime = createRuntimeState("goal-2" as GoalID)
      runtime.runGeneration = 1
      state.runtimes.push(runtime)
      return state
    })

    await expect(shell(root, "nested")).rejects.toThrow(/Scope denied: uncontrolled tool/)
  })

  it("still fences retired workers", async () => {
    const root = await fixture()
    await mutateState(root, "retire", async (state) => {
      state.retiredWorkerSessions = ["worker-1"]
      return state
    })
    await expect(shell(root, "worker-1")).rejects.toThrow(/retired worker session/)
  })

  it("leaves ordinary scoped worker writes working", async () => {
    const root = await fixture({ writeScope: ["src/a.ts"] })
    await beforeWorkspaceTool(root, { tool: "write", sessionID: "worker-1", callID: "worker-write" }, { path: "src/a.ts", content: "x" })
    expect((await readState(root)).workspaceCalls?.[0]).toMatchObject({ callID: "worker-write", goalID: "goal-1", paths: ["src/a.ts"] })
  })
})

describe("host main-session proof", () => {
  it("is absent on a fake host by default and honored when configured", async () => {
    expect(await createFakeHost().isMainSession?.("main")).toBeUndefined()
    const host = createFakeHost({ isMainSession: (sessionID) => (sessionID === "main" ? true : undefined) })
    expect(await host.isMainSession?.("main")).toBe(true)
    expect(await host.isMainSession?.("child")).toBeUndefined()
  })
})
