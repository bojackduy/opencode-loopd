import { describe, expect, it } from "bun:test"
import { createRealHost, createV2Host } from "../../src/server/host-adapter"
import { normalizeAgentCatalog } from "../../src/server/agent-catalog"

describe("host agent capabilities", () => {
  const agents = [{ name: "build", description: "Build things", mode: "primary", prompt: "SECRET" }, { name: "explore", mode: "subagent" }, { name: "both", mode: "all" }]

  it("projects public metadata and rejects malformed payloads", () => {
    const catalog = normalizeAgentCatalog(agents, "test", "session")
    expect(catalog.agents).toEqual([{ name: "build", description: "Build things", mode: "primary" }, { name: "explore", mode: "subagent" }, { name: "both", mode: "all" }])
    expect(JSON.stringify(catalog)).not.toContain("SECRET")
    expect(normalizeAgentCatalog({}, "test", "session").capability).toBe("unavailable")
    expect(normalizeAgentCatalog([{ name: "bad", mode: "unknown" }], "test", "session").agents).toEqual([])
  })

  it("lists v1 agents in the workspace and defers legacy identity to next prompt", async () => {
    let input: unknown
    const host = createRealHost({ agent: { list: async (args: unknown) => { input = args; return { data: agents } } } }, "/workspace")
    expect((await host.listAgents!()).agents).toHaveLength(3)
    expect(input).toEqual({ query: { directory: "/workspace" } })
    expect(await host.switchSessionAgent!("worker", "build")).toBe("next-prompt")
    expect((await createRealHost({}, "/workspace").listAgents!()).capability).toBe("unsupported")
  })

  it("uses a v1 switch API when available and propagates rejections", async () => {
    let input: unknown
    const host = createRealHost({ session: { switchAgent: async (args: unknown) => { input = args; return {} } } }, "/workspace")
    expect(await host.switchSessionAgent!("worker", "build")).toBe("applied")
    expect(input).toEqual({ path: { id: "worker" }, body: { agent: "build" } })
    const failed = createRealHost({ session: { switchAgent: async () => ({ error: "SECRET" }) } }, "/workspace")
    await expect(failed.switchSessionAgent!("worker", "build")).rejects.toThrow("rejected")
  })

  it("lists v2 location agents and switches exactly the existing session", async () => {
    const calls: unknown[] = []
    const host = createV2Host({ location: { directory: "/workspace" }, agent: { list: async (args: unknown) => { calls.push(args); return { data: agents } } }, session: { switchAgent: async (args: unknown) => { calls.push(args) } } } as any, new Map())
    expect((await host.listAgents!()).capability).toBe("supported")
    expect(await host.switchSessionAgent!("worker", "explore")).toBe("applied")
    expect(calls).toEqual([{ location: { directory: "/workspace" } }, { sessionID: "worker", agent: "explore" }])
  })

  it("reports missing and failed v2 capabilities without leaking errors", async () => {
    const missing = createV2Host({ location: { directory: "/workspace" }, session: {} } as any, new Map())
    expect((await missing.listAgents!()).capability).toBe("unsupported")
    expect(await missing.switchSessionAgent!("worker", "build")).toBe("unsupported")
    const failed = createV2Host({ location: { directory: "/workspace" }, agent: { list: async () => { throw new Error("SECRET") } }, session: {} } as any, new Map())
    const result = await failed.listAgents!()
    expect(result.capability).toBe("unavailable")
    expect(JSON.stringify(result)).not.toContain("SECRET")
  })
})
