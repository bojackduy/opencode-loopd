import { describe, expect, it } from "bun:test"
import { createRealHost, createV2Host } from "../../src/server/host-adapter"
import { normalizeV1Catalog, normalizeV2Catalog } from "../../src/server/model-catalog"

describe("host model catalog", () => {
  const secret = "DO-NOT-EXPOSE-SECRET"
  const providers = { data: [
    { id: "p", name: "Provider", activation: "enabled", headers: { authorization: secret }, settings: { apiKey: secret } },
    { id: "off", activation: "disabled" },
  ] }
  const models = { data: [
    { id: "alias", modelID: "upstream", providerID: "p", name: "Model", enabled: true, limit: { context: 100, output: 20 }, headers: { authorization: secret }, body: { token: secret } },
    { id: "disabled", providerID: "p", enabled: false },
    { id: "off-model", providerID: "off", enabled: true },
    { id: "unknown", providerID: "p" },
  ] }

  it("projects v1 public inventory and never interprets connected as remaining quota", () => {
    const result = normalizeV1Catalog({
      all: [{ id: "p", name: "Provider", apiKey: secret, models: {
        m: { id: "m", name: "Model", headers: { authorization: secret }, options: { token: secret }, limit: { context: 100, output: 20 } },
      } }, { id: "off", models: { x: { id: "x" } } }],
      connected: ["p"], default: { secret },
    })
    expect(result.capability).toBe("supported")
    expect(result.models[0]).toEqual({ providerID: "p", modelID: "m", name: "Model", usable: true, contextLimit: 100, outputLimit: 20 })
    expect(result.models[1]?.usable).toBe(false)
    expect(result.quota.status).toBe("unknown")
    expect(result.quota.capability).toBe("unsupported")
    expect(result.quota.observedAt).toBe(result.observedAt)
    expect(JSON.stringify(result)).not.toContain(secret)
    expect(result.switching).toBe("next-prompt")
  })

  it("projects v2 enabled models without pretending provider activation means connected", () => {
    const result = normalizeV2Catalog(providers, models)
    expect(result.capability).toBe("supported")
    expect(result.providers.every((p) => p.connected === "unknown")).toBe(true)
    expect(result.models.map((m) => m.usable)).toEqual([true, false, false, "unknown"])
    expect(result.models[0]?.modelID).toBe("alias")
    expect(result.quota.status).toBe("unknown")
    expect(JSON.stringify(result)).not.toContain(secret)
  })

  it("fails closed on malformed catalog payloads", () => {
    expect(normalizeV1Catalog({ all: [], connected: null }).capability).toBe("unavailable")
    expect(normalizeV2Catalog({ data: [] }, null).capability).toBe("unavailable")
  })

  it("uses the supported v1 provider list with workspace directory", async () => {
    let input: unknown
    const host = createRealHost({ provider: { list: async (args: unknown) => {
      input = args
      return { data: { all: [], connected: [] } }
    } } }, "/workspace")
    expect((await host.listModels!()).capability).toBe("supported")
    expect(input).toEqual({ query: { directory: "/workspace" } })
    expect(await host.switchSessionModel!("same-worker", { providerID: "p", modelID: "m" })).toBe("next-prompt")
  })

  it("reports v1 missing API and transport failures honestly without raw error secrets", async () => {
    const unsupported = createRealHost({}, "/workspace")
    expect((await unsupported.listModels!()).capability).toBe("unsupported")
    const failed = createRealHost({ provider: { list: async () => { throw new Error(secret) } } }, "/workspace")
    const result = await failed.listModels!()
    expect(result.capability).toBe("unavailable")
    expect(JSON.stringify(result)).not.toContain(secret)
  })

  it("uses supported v2 domains and updates exactly the existing session model", async () => {
    const calls: unknown[] = []
    const host = createV2Host({
      location: { directory: "/workspace" },
      provider: { list: async (args: unknown) => { calls.push(args); return providers } },
      model: { list: async (args: unknown) => { calls.push(args); return models } },
      session: { switchModel: async (args: unknown) => { calls.push(args) } },
    } as any, new Map())
    expect((await host.listModels!()).capability).toBe("supported")
    expect(await host.switchSessionModel!("same-worker", { providerID: "p", modelID: "alias" })).toBe("applied")
    expect(calls).toEqual([
      { location: { directory: "/workspace" } }, { location: { directory: "/workspace" } },
      { sessionID: "same-worker", model: { id: "alias", providerID: "p" } },
    ])
  })

  it("reports missing v2 catalog/switch APIs rather than inventing server client access", async () => {
    const host = createV2Host({ location: { directory: "/workspace" }, session: {} } as any, new Map())
    const result = await host.listModels!()
    expect(result.capability).toBe("unsupported")
    expect(result.switching).toBe("unsupported")
    expect(await host.switchSessionModel!("same-worker", { providerID: "p", modelID: "m" })).toBe("unsupported")
  })

  it("propagates v2 switch rejection for service rollback", async () => {
    const host = createV2Host({ location: { directory: "/workspace" }, session: {
      switchModel: async () => { throw new Error("model unavailable") },
    } } as any, new Map())
    await expect(host.switchSessionModel!("same-worker", { providerID: "p", modelID: "m" })).rejects.toThrow("model unavailable")
  })

  it("uses supported legacy summarize with explicit switched model", async () => {
    let args: unknown
    const host = createRealHost({ session: { summarize: async (input: unknown) => { args = input } } }, "/workspace")
    await host.compactSession("same-worker", { providerID: "p", modelID: "new" })
    expect(args).toEqual({ path: { id: "same-worker" }, body: { providerID: "p", modelID: "new" } })
  })

  it("switches v2 compaction identity before issuing compact command", async () => {
    const calls: unknown[] = []
    const host = createV2Host({ location: { directory: "/workspace" }, session: {
      switchModel: async (input: unknown) => { calls.push(input) },
      command: async (input: unknown) => { calls.push(input) },
    } } as any, new Map())
    await host.compactSession("same-worker", { providerID: "p", modelID: "new" })
    expect(calls).toEqual([
      { sessionID: "same-worker", model: { providerID: "p", id: "new" } },
      { sessionID: "same-worker", name: "compact", text: "" },
    ])
  })
})
