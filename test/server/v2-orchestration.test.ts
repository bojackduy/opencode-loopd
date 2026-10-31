import { afterEach, describe, expect, it } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import plugin from "../../src/server/plugin"
import { createGoalService } from "../../src/application/goal-service"
import { createFakeHost } from "../../src/server/host-adapter"
import { beforeWorkspaceTool, guardV2ToolEditor } from "../../src/application/workspace-execution"
import { readState } from "../../src/infrastructure/state-repository"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function fixture(edit?: (input: any) => Promise<any>) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "loopd-v2-orchestration-"))
  cleanups.push(() => fs.rm(directory, { recursive: true, force: true }))
  const service = createGoalService(createFakeHost())
  const tools = new Map<string, any>()
  const hooks = new Map<string, any>()
  tools.set("edit", { id: "edit", name: "edit", input: {}, description: "test", execute: edit ?? (async ({ filePath }: any) => {
    await fs.writeFile(path.join(directory, filePath), "changed")
    return { content: "changed" }
  }) })
  tools.set("bash", { id: "bash", name: "bash", input: {}, description: "test", execute: async () => ({ content: "shell executed" }) })
  const cleanup = await plugin.setup({
    location: { directory }, options: {}, session: {},
    tool: {
      transform: async (callback: any) => {
        callback({
          add: (tool: any) => tools.set(tool.name, { ...tool, id: tool.name,
            ...(tool.name === "loopd_create_goal" ? { execute: async ({ write_scope }: any) => {
              const { goal } = await service.start(directory, { name: "fixture", objective: "test", ownerSessionID: "parent",
                config: { workspaceWrite: true, ...(write_scope !== undefined ? { write_scope } : {}) } })
              return { content: goal.id }
            } } : {}),
          }),
          list: () => [...tools.values()],
          update: (id: string, update: any) => update(tools.get(id)),
        })
        return { dispose: async () => {} }
      },
      hook: async (name: string, callback: any) => { hooks.set(name, callback); return { dispose: async () => {} } },
    },
    event: { subscribe: ({ signal }: any) => ({ async *[Symbol.asyncIterator]() {
      if (!signal.aborted) await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))
    } }) },
  } as any)
  cleanups.push(async () => { await cleanup?.() })
  const context = { sessionID: "parent", agent: "build", messageID: "message", id: "outer-call" }
  async function call(name: string, input: any, ctx = context) {
    await hooks.get("execute.before")({ tool: name, ...ctx, input })
    try {
      const result = await tools.get(name).execute(input, ctx)
      await hooks.get("execute.after")({ tool: name, ...ctx, input, status: "completed", result })
      return result
    } catch (error) {
      await hooks.get("execute.after")({ tool: name, ...ctx, input, status: "error", error })
      throw error
    }
  }
  return { directory, service, tools, hooks, context, call }
}

describe("v2 CodeMode orchestration guards", () => {
  for (const write_scope of [undefined, []] as const) {
    it(`creates a ${write_scope === undefined ? "legacy" : "scoped"} goal inside the reserved built-in execute wrapper`, async () => {
      const f = await fixture()
      await f.hooks.get("execute.before")({ tool: "execute", ...f.context, input: { code: "return await tools.loopd_create_goal({})" } })
      expect((await readState(f.directory)).workspaceCalls ?? []).toEqual([])
      await f.call("loopd_create_goal", { write_scope })
      expect((await readState(f.directory)).goals).toHaveLength(1)
      expect(f.service.getActiveWorkers().size).toBe(1)
    })
  }

  it("allows the wrapper under a scoped goal; shells are prompt-aware, out-of-scope edits still fenced", async () => {
    const f = await fixture()
    const { goal } = await f.service.start(f.directory, { name: "scoped", objective: "test", ownerSessionID: "parent",
      config: { workspaceWrite: true, write_scope: ["owned.ts"] } })
    const context = { ...f.context, sessionID: goal.workerSessionID! }
    await f.hooks.get("execute.before")({ tool: "execute", ...context, input: { code: "return await tools.edit({})" } })
    // Worker shells are prompt-awareness only: allowed and recorded, never fenced.
    await expect(f.call("bash", {}, context)).resolves.toMatchObject({ content: "shell executed" })
    await expect(f.call("edit", { filePath: "other.ts" }, context)).rejects.toThrow("outside")
    await f.call("edit", { filePath: "owned.ts" }, context)
    expect(await fs.readFile(path.join(f.directory, "owned.ts"), "utf8")).toBe("changed")
    expect(await fs.stat(path.join(f.directory, "other.ts")).catch(() => undefined)).toBeUndefined()
    expect((await readState(f.directory)).workspaceCalls ?? []).toEqual([])
  })

  it("does not globally exempt a custom execute tool on the v1 guard", async () => {
    const f = await fixture()
    await beforeWorkspaceTool(f.directory, { tool: "execute", sessionID: "parent", callID: "custom" }, {})
    expect((await readState(f.directory)).workspaceCalls).toMatchObject([{ uncontrolled: true, callID: "custom" }])
  })

  for (const [id, name] of [["execute", "execute"], ["custom_edit", "edit"]] as const) {
    it(`routes the registered ${id} executor by display name: unstructured ids run prompt-aware, structured names stay fenced`, async () => {
      const f = await fixture()
      const { goal } = await f.service.start(f.directory, { name: "protected", objective: "test", ownerSessionID: "parent",
        config: { workspaceWrite: true, write_scope: [] } })
      let executed = false
      const definition = { id, name, description: "custom", input: {}, execute: async () => { executed = true; return { content: "unsafe" } } }
      guardV2ToolEditor(f.directory, { list: () => [definition], update: (_id: string, update: any) => update(definition) } as any)
      if (id === "execute") {
        // Genuinely unstructured tool id: prompt-awareness only — allowed, never fenced.
        await expect(definition.execute({ filePath: "outside.ts" }, { ...f.context, sessionID: goal.workerSessionID! })).resolves.toMatchObject({ content: "unsafe" })
        expect(executed).toBe(true)
      } else {
        // Display name is a structured tool: scope-checked like a native edit, denied outside the scope.
        await expect(definition.execute({ filePath: "outside.ts" }, { ...f.context, sessionID: goal.workerSessionID! })).rejects.toThrow(/outside/)
        expect(executed).toBe(false)
      }
      // Unknown sessions are still fenced: proves the call goes through the guard.
      executed = false
      await expect(definition.execute({ filePath: "outside.ts" }, { ...f.context, sessionID: "unknown-child" })).rejects.toThrow(/unrecognized/)
      expect(executed).toBe(false)
    })
  }

  it("keeps independent nested reservations when v2 reuses one host call ID", async () => {
    let releaseA!: () => void
    let releaseB!: () => void
    let entered = 0
    const gateA = new Promise<void>((resolve) => { releaseA = resolve })
    const gateB = new Promise<void>((resolve) => { releaseB = resolve })
    const f = await fixture(async ({ filePath }) => {
      entered++
      if (entered <= 2) await (filePath === "a.ts" ? gateA : gateB)
      return { content: "done" }
    })
    const { goal } = await f.service.start(f.directory, { name: "parallel calls", objective: "test", ownerSessionID: "parent",
      config: { workspaceWrite: true, write_scope: ["a.ts", "b.ts"] } })
    const context = { ...f.context, sessionID: goal.workerSessionID! }
    let a: Promise<any> | undefined
    let b: Promise<any> | undefined
    try {
      a = f.call("edit", { filePath: "a.ts" }, context)
      b = f.call("edit", { filePath: "b.ts" }, context)
      const deadline = Date.now() + 2000
      while (entered < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5))
      expect(entered).toBe(2)
      const reserved = (await readState(f.directory)).workspaceCalls!
      expect(reserved).toHaveLength(2)
      expect(new Set(reserved.map((call) => call.callID)).size).toBe(2)
      await expect(f.call("edit", { filePath: "b.ts" }, context)).rejects.toThrow(/being written|queued/)
      releaseA()
      await a
      await f.hooks.get("execute.after")({ tool: "execute", ...context, input: {}, status: "completed", result: { content: "done" } })
      expect((await readState(f.directory)).workspaceCalls).toMatchObject([{ paths: ["b.ts"] }])
      await expect(f.service.start(f.directory, { name: "conflict", objective: "test", ownerSessionID: "parent",
        config: { workspaceWrite: true, write_scope: ["b.ts"] } })).rejects.toThrow("conflict")
    } finally {
      releaseA()
      releaseB()
      await Promise.allSettled([a, b])
    }
    expect((await readState(f.directory)).workspaceCalls ?? []).toEqual([])
  })
})
