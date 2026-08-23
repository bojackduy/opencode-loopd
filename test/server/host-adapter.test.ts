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
})
