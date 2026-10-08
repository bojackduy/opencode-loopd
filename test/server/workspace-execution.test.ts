import { afterEach, describe, expect, it } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import plugin from "../../src/server/plugin"
import { createGoal, type GoalID } from "../../src/domain/goal"
import { createRuntimeState } from "../../src/domain/runtime"
import { mutateState, readState } from "../../src/infrastructure/state-repository"
import { withWorkspaceOperation } from "../../src/application/workspace-execution"
import { guardV2ToolEditor } from "../../src/application/workspace-execution"
import { fromPromise } from "@opencode/plugin/promise/adapter"
// The SDK has its own Effect RC; use that exact runtime, not a hoisted RC.
const { Effect }: typeof import("effect") = await import(import.meta.resolve("effect", import.meta.resolve("@opencode/plugin/promise/adapter")))

const fixtures: Array<{ directory: string; hooks: any }> = []
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.hooks.dispose?.()
    await fs.rm(fixture.directory, { recursive: true, force: true })
  }
})

async function fixture(workspaceWrite = true) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "loopd-enforcement-"))
  await fs.writeFile(path.join(directory, "owned.ts"), "before")
  await fs.writeFile(path.join(directory, "other.ts"), "before")
  const artifactDir = path.join(directory, ".opencode/loopd/goals/one")
  await fs.mkdir(artifactDir, { recursive: true })
  await mutateState(directory, "fixture", async (state) => {
    state.goals.push(createGoal({ id: "one" as GoalID, name: "one", objective: "test", status: "active", ownerSessionID: "parent", workerSessionID: "worker", config: { workspaceWrite, write_scope: workspaceWrite ? ["owned.ts"] : [], artifactDir } }))
    state.runtimes.push(createRuntimeState("one" as GoalID))
    return state
  })
  const hooks = await plugin.server({ directory, client: {} } as any)
  fixtures.push({ directory, hooks })
  const before = (tool: string, args: any, sessionID = "worker", callID = crypto.randomUUID()) => hooks["tool.execute.before"]!({ tool, sessionID, callID }, { args })
  const after = (callID: string, sessionID = "worker") => hooks["tool.execute.after"]!({ tool: "edit", sessionID, callID, args: {} }, { title: "", output: "", metadata: {} })
  return { directory, artifactDir, hooks, before, after }
}

describe("real plugin scope enforcement", () => {
  it("installed SDK converts the guarded executor without running a denied original body", async () => {
    const { directory } = await fixture()
    let executed = false
    const definitions = new Map<string, any>([["edit", { id: "edit", name: "edit", description: "test", input: {}, execute: () => Effect.sync(() => { executed = true; return { content: "changed" } }) }]])
    // Unused API domains are lazy proxies; only the real SDK tool adapter runs.
    const unused: any = new Proxy(() => Effect.void, { get: (_target, key) => key === "then" ? undefined : unused })
    const host: any = new Proxy({
      location: { directory }, options: {},
      tool: {
        transform: (callback: any) => Effect.sync(() => {
          callback({ list: () => [...definitions.values()], update: (id: string, change: any) => change(definitions.get(id)) })
          return { dispose: Effect.void }
        }),
      },
    }, { get: (target: any, key) => key in target ? target[key] : unused })
    const adapted = fromPromise({ setup: async (context: any) => { await context.tool.transform((editor: any) => guardV2ToolEditor(directory, editor)) } } as any)
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      yield* adapted.effect(host)
      const outcome = yield* Effect.exit(definitions.get("edit").execute({ filePath: "other.ts" }, { sessionID: "worker", id: "sdk-call", progress: () => Effect.void }))
      expect(outcome._tag).toBe("Failure")
      expect(executed).toBe(false)
    })))
    expect(await fs.readFile(path.join(directory, "other.ts"), "utf8")).toBe("before")
  })

  it("v2 transformed executors veto writes even when the host ignores before-hook rejection", async () => {
    const { directory } = await fixture()
    let executed = false
    const tools = new Map<string, any>([["edit", {
      id: "edit", name: "edit", input: {}, description: "test",
      execute: async () => { executed = true; await fs.writeFile(path.join(directory, "other.ts"), "changed"); return { content: "done" } },
    }]])
    const cleanup = await plugin.setup({
      location: { directory }, options: {}, session: {},
      tool: {
        transform: async (callback: any) => {
          callback({ add: (tool: any) => tools.set(tool.name, { ...tool, id: tool.name }), list: () => [...tools.values()], update: (id: string, update: any) => update(tools.get(id)) })
          return { dispose: async () => {} }
        },
        hook: async () => ({ dispose: async () => {} }),
      },
      event: { subscribe: ({ signal }: any) => ({ async *[Symbol.asyncIterator]() { if (!signal.aborted) await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true })) } }) },
    } as any)
    try {
      await expect(tools.get("edit").execute({ filePath: "other.ts" }, { sessionID: "worker", id: "v2-call" })).rejects.toThrow("outside")
      expect(executed).toBe(false)
      expect(await fs.readFile(path.join(directory, "other.ts"), "utf8")).toBe("before")
    } finally { await cleanup?.() }
  })

  it("vetoes an entire multi-file patch before any file is changed", async () => {
    const { directory, before } = await fixture()
    let executed = false
    const execute = async () => {
      await before("apply_patch", { patchText: "*** Begin Patch\n*** Update File: owned.ts\n-before\n+after\n*** Delete File: other.ts\n*** End Patch" })
      executed = true
      await fs.writeFile(path.join(directory, "owned.ts"), "after")
      await fs.rm(path.join(directory, "other.ts"))
    }
    await expect(execute()).rejects.toThrow("other.ts")
    expect(executed).toBe(false)
    expect(await fs.readFile(path.join(directory, "owned.ts"), "utf8")).toBe("before")
    expect(await fs.readFile(path.join(directory, "other.ts"), "utf8")).toBe("before")
    expect((await readState(directory)).workspaceCalls ?? []).toEqual([])
  })

  it("reserves allowed paths through execution and releases only in the after hook", async () => {
    const { directory, before, after } = await fixture()
    await before("edit", { filePath: "owned.ts" }, "worker", "call")
    expect((await readState(directory)).workspaceCalls).toMatchObject([{ sessionID: "worker", callID: "call", paths: ["owned.ts"] }])
    await expect(before("write", { filePath: "owned.ts" }, "worker", "other-call")).rejects.toThrow("being written")
    await after("call")
    expect((await readState(directory)).workspaceCalls).toEqual([])
  })

  it("validates rename destinations, deletes, aliases and new file paths", async () => {
    const { directory, before, after } = await fixture()
    await fs.symlink("owned.ts", path.join(directory, "alias.ts"))
    await before("write", { filePath: "alias.ts" }, "worker", "alias")
    await after("alias")
    await expect(before("apply_patch", { patchText: "*** Begin Patch\n*** Update File: owned.ts\n*** Move to: renamed.ts\n*** End Patch" })).rejects.toThrow("renamed.ts")
    await expect(before("apply_patch", { patchText: "*** Begin Patch\n*** Add File: new.ts\n+x\n*** End Patch" })).rejects.toThrow("new.ts")
    await expect(before("write", { filePath: "../outside.ts" })).rejects.toThrow("outside")
  })

  it("allows parent edits of unclaimed files but denies claimed files and uncontrolled bypasses", async () => {
    const { before } = await fixture()
    await before("edit", { filePath: "other.ts" }, "parent")
    await expect(before("edit", { filePath: "owned.ts" }, "parent")).rejects.toThrow("owner")
    for (const session of ["worker", "parent", "unknown-child"]) {
      for (const tool of ["bash", "shell", "loopd_command_start", "loopd_command_write", "task", "batch", "custom_writer"]) {
        await expect(before(tool, { command: "true" }, session)).rejects.toThrow("uncontrolled")
      }
      await before("read", { filePath: "owned.ts" }, session)
    }
    await expect(before("write", { filePath: "new.ts" }, "unknown-child")).rejects.toThrow("unrecognized")
  })

  it("read-only goals can write their own artifacts, not shared source or arbitrary progress locations", async () => {
    const { before, artifactDir } = await fixture(false)
    await expect(before("write", { filePath: "owned.ts" })).rejects.toThrow("outside")
    await before("write", { filePath: path.join(artifactDir, "report.md") })
    await expect(before("write", { filePath: "custom-progress.md" })).rejects.toThrow("outside")
  })

  it("exclusive verification rejects concurrent writes and cannot start over in-flight edits", async () => {
    const { directory, before, after } = await fixture()
    await before("edit", { filePath: "owned.ts" }, "worker", "call")
    await expect(withWorkspaceOperation(directory, "one", "worker", async () => {})).rejects.toThrow("busy")
    await after("call")
    await withWorkspaceOperation(directory, "one", "worker", async () => {
      await expect(before("edit", { filePath: "owned.ts" })).rejects.toThrow("operation")
      await expect(withWorkspaceOperation(directory, "one", "worker", async () => {})).rejects.toThrow("busy")
      await before("get_goal", {})
    })
    expect((await readState(directory)).workspaceOperation).toBeUndefined()
  })
})

describe("installed host veto/error-path semantics", () => {
  // Mirrors the audited host execution shape (opencode packages/opencode
  // src/plugin/index.ts trigger has no catch; src/session/tools.ts yields the
  // before trigger ahead of item.execute): a rejecting before hook fails the
  // Effect, so the executor below it never runs. Uses the SDK-resolved Effect
  // runtime, the same one the promise adapter runs on.
  const hostTrigger = (run: () => Promise<unknown>) => Effect.promise(async () => run())

  it("v1-style trigger propagation: a denied before hook prevents execution", async () => {
    const { directory, hooks } = await fixture()
    let executed = false
    const denied = await Effect.runPromise(Effect.exit(Effect.gen(function* () {
      yield* hostTrigger(() => hooks["tool.execute.before"]!({ tool: "edit", sessionID: "worker", callID: "v1-deny" }, { args: { filePath: "other.ts" } }))
      executed = true
      return yield* Effect.void
    })))
    expect(denied._tag).toBe("Failure")
    expect(executed).toBe(false)
    expect(await fs.readFile(path.join(directory, "other.ts"), "utf8")).toBe("before")
    expect((await readState(directory)).workspaceCalls ?? []).toEqual([])

    let released = false
    await Effect.runPromise(Effect.gen(function* () {
      yield* hostTrigger(() => hooks["tool.execute.before"]!({ tool: "edit", sessionID: "worker", callID: "v1-allow" }, { args: { filePath: "owned.ts" } }))
      executed = true
      yield* Effect.promise(async () => hooks["tool.execute.after"]!({ tool: "edit", sessionID: "worker", callID: "v1-allow", args: {} }, { title: "", output: "", metadata: {} }))
      released = true
    }))
    expect(executed).toBe(true)
    expect(released).toBe(true)
    expect((await readState(directory)).workspaceCalls ?? []).toEqual([])
  })

  it("v1-style error path sticks fail-closed: a skipped after hook retains the reservation", async () => {
    // The audited v1 host skips its after trigger when item.execute fails, so
    // our release never runs. Pinned here as a known liveness limitation with
    // a safe (deny, never silently allow) direction. v2 is unaffected.
    const { before } = await fixture()
    await before("edit", { filePath: "owned.ts" }, "worker", "v1-crash")
    // Simulate the failed execution returning without an after hook.
    await expect(before("write", { filePath: "owned.ts" }, "worker", "v1-next")).rejects.toThrow("being written")
  })

  it("v2 wrapped executors release the reservation even when the original body throws", async () => {
    const { directory } = await fixture()
    const definitions = new Map<string, any>([["edit", {
      id: "edit", name: "edit", description: "test", input: {},
      execute: async () => { throw new Error("original exploded") },
    }]])
    const editor: any = {
      list: () => [...definitions.values()],
      update: (id: string, change: any) => change(definitions.get(id)),
    }
    guardV2ToolEditor(directory, editor)
    // The wrapped executor is promise-world (async): rejection surfaces as a
    // rejected promise, and the finally releases the reservation.
    await expect(definitions.get("edit").execute({ filePath: "owned.ts" }, { sessionID: "worker", id: "v2-throw" })).rejects.toThrow("original exploded")
    expect((await readState(directory)).workspaceCalls ?? []).toEqual([])
  })
})
