import { describe, expect, it } from "bun:test"
import { createRealHost, parseModelRef } from "../../src/server/host-adapter"

describe("Real Host Adapter", () => {
  it("returns the created worker session ID", async () => {
    const host = createRealHost({
      session: {
        create: async () => ({ data: { id: "worker-1" } }),
      },
    }, "/tmp/loopd-host-test")

    await expect(host.createWorker({ parentID: "owner-1", title: "loopd: test" })).resolves.toBe("worker-1")
  })

  it("preserves the SDK error when worker creation fails", async () => {
    const host = createRealHost({
      session: {
        create: async () => ({ error: { name: "BadRequest", message: "parent session not found" } }),
      },
    }, "/tmp/loopd-host-test")

    await expect(host.createWorker({ parentID: "missing", title: "loopd: test" }))
      .rejects.toThrow('OpenCode session.create failed for parent "missing": parent session not found')
  })

  it("treats a missing session entry as idle (sparse status map)", async () => {
    const host = createRealHost({
      session: {
        status: async () => ({ data: { "other-session": { type: "busy" } } }),
      },
    }, "/tmp/loopd-host-test")

    await expect(host.sessionStatus("worker-1")).resolves.toBe("idle")
  })

  it("treats an explicitly idle entry as idle", async () => {
    const host = createRealHost({
      session: {
        status: async () => ({ data: { "worker-1": { type: "idle" } } }),
      },
    }, "/tmp/loopd-host-test")

    await expect(host.sessionStatus("worker-1")).resolves.toBe("idle")
  })

  it("preserves busy and retry statuses", async () => {
    const busyHost = createRealHost({
      session: {
        status: async () => ({ data: { "worker-1": { type: "busy" } } }),
      },
    }, "/tmp/loopd-host-test")
    const retryHost = createRealHost({
      session: {
        status: async () => ({ data: { "worker-1": { type: "retry" } } }),
      },
    }, "/tmp/loopd-host-test")

    await expect(busyHost.sessionStatus("worker-1")).resolves.toBe("busy")
    await expect(retryHost.sessionStatus("worker-1")).resolves.toBe("retry")
  })

  it("returns unknown for request failures or malformed payloads", async () => {
    const failingHost = createRealHost({
      session: {
        status: async () => { throw new Error("network down") },
      },
    }, "/tmp/loopd-host-test")
    const errorHost = createRealHost({
      session: {
        status: async () => ({ error: { name: "ServerError", message: "boom" } }),
      },
    }, "/tmp/loopd-host-test")
    const malformedHost = createRealHost({
      session: {
        status: async () => ({ data: null }),
      },
    }, "/tmp/loopd-host-test")
    const badEntryHost = createRealHost({
      session: {
        status: async () => ({ data: { "worker-1": "busy" } }),
      },
    }, "/tmp/loopd-host-test")

    await expect(failingHost.sessionStatus("worker-1")).resolves.toBe("unknown")
    await expect(errorHost.sessionStatus("worker-1")).resolves.toBe("unknown")
    await expect(malformedHost.sessionStatus("worker-1")).resolves.toBe("unknown")
    await expect(badEntryHost.sessionStatus("worker-1")).resolves.toBe("unknown")
  })

  it("parses provider/model strings into SDK model refs", async () => {
    expect(parseModelRef("openai/gpt-5.6-sol")).toEqual({ providerID: "openai", modelID: "gpt-5.6-sol" })
    expect(parseModelRef("ollama/qwen3.8:27b")).toEqual({ providerID: "ollama", modelID: "qwen3.8:27b" })
    expect(parseModelRef(undefined)).toBeUndefined()
    expect(parseModelRef("  ")).toBeUndefined()
    expect(() => parseModelRef("no-slash")).toThrow('Invalid model "no-slash"')
    expect(() => parseModelRef("openai/")).toThrow("Invalid model")
  })

  it("forwards agent and model on worker create and prompt", async () => {
    const calls: any[] = []
    const prompts: any[] = []
    const host = createRealHost({
      session: {
        create: async ({ body }: any) => {
          calls.push(body)
          return { data: { id: "worker-9" } }
        },
        promptAsync: async ({ body }: any) => {
          prompts.push(body)
          return { data: {} }
        },
      },
    }, "/tmp/loopd-host-test")

    await host.createWorker({
      parentID: "owner-1",
      title: "loopd: test",
      agent: "researcher",
      model: { providerID: "ollama", modelID: "qwen3.8:27b" },
    })
    expect(calls[0].agent).toBe("researcher")
    expect(calls[0].model).toEqual({ id: "qwen3.8:27b", providerID: "ollama" })

    await host.promptWorker({
      sessionID: "worker-9",
      prompt: "hello",
      agent: "researcher",
      model: { providerID: "ollama", modelID: "qwen3.8:27b" },
    })
    expect(prompts[0].agent).toBe("researcher")
    expect(prompts[0].model).toEqual({ providerID: "ollama", modelID: "qwen3.8:27b" })
  })

  it("maps token usage, cost, and timing from worker messages", async () => {
    const host = createRealHost({
      session: {
        messages: async () => ({ data: [
          {
            info: {
              role: "assistant", id: "asst-1", parentID: "msg-1",
              time: { created: 1000, completed: 6000 },
              tokens: { input: 100, output: 50, reasoning: 10, cache: { read: 1000, write: 200 } },
              cost: 0.012,
            },
            parts: [{ type: "text", text: "done" }],
          },
          {
            info: { role: "user", id: "msg-1", time: { created: 500 } },
            parts: [{ type: "text", text: "go" }],
          },
        ] }),
      },
    }, "/tmp/loopd-host-test")

    const msgs = await host.readMessages("worker-1", 10)
    expect(msgs[0].tokens).toEqual({ input: 100, output: 50, reasoning: 10, cacheRead: 1000, cacheWrite: 200 })
    expect(msgs[0].cost).toBe(0.012)
    expect(msgs[0].durationMs).toBe(5000)
    expect(msgs[0].completedAt).toBe(new Date(6000).toISOString())
    expect(msgs[1].tokens).toBeUndefined()
    expect(msgs[1].durationMs).toBeUndefined()
  })

  it("reads session identity via session.get", async () => {
    const host = createRealHost({
      session: {
        get: async ({ path }: any) => {
          expect(path.id).toBe("owner-9")
          return { data: { id: "owner-9", agent: "plan", model: { id: "meta/muse-spark-1.3-contributor", providerID: "openrouter" } } }
        },
      },
    }, "/tmp/loopd-host-test")

    await expect(host.readSession("owner-9")).resolves.toEqual({
      agent: "plan",
      model: { providerID: "openrouter", modelID: "meta/muse-spark-1.3-contributor" },
    })
  })

  it("returns undefined identity when session.get fails or is empty", async () => {
    const failing = createRealHost({ session: { get: async () => { throw new Error("gone") } } }, "/tmp/loopd-host-test")
    const empty = createRealHost({ session: { get: async () => ({ data: { id: "x" } }) } }, "/tmp/loopd-host-test")
    await expect(failing.readSession("x")).resolves.toBeUndefined()
    await expect(empty.readSession("x")).resolves.toBeUndefined()
  })
})
