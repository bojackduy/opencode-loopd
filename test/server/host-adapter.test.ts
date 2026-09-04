import { describe, expect, it } from "bun:test"
import { createRealHost } from "../../src/server/host-adapter"

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
})
