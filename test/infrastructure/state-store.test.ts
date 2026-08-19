import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { promises as fs } from "fs"
import path from "path"
import os from "os"
import { randomUUID } from "crypto"
import {
  readState,
  writeState,
  appendEvent,
  readEvents,
  writeControlRequest,
  readControlRequest,
  claimControlRequest,
  writeControlResponse,
  readControlResponse,
  listPendingRequests,
  recoverStaleProcessing,
  type StoreState,
  type ControlRequest,
} from "../../src/infrastructure/state-store"

function tmpDir(): string {
  return path.join(os.tmpdir(), `loopd-test-${randomUUID()}`)
}

describe("State Store", () => {
  let dir: string

  beforeEach(async () => {
    dir = tmpDir()
    await fs.mkdir(dir, { recursive: true })
  })

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  describe("readState / writeState", () => {
    it("returns empty state for nonexistent directory", async () => {
      const state = await readState(path.join(dir, "nonexistent"))
      expect(state.version).toBe(1)
      expect(state.revision).toBe(0)
      expect(state.goals).toEqual([])
      expect(state.runtimes).toEqual([])
    })

    it("round-trips state through write/read", async () => {
      const initial = await readState(dir)
      initial.goals.push({
        id: "g1" as any,
        name: "test",
        objective: "objective",
        status: "active",
        ownerSessionID: "s1",
        tokensUsed: 0,
        timeUsedSeconds: 0,
        config: {},
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })

      await writeState(dir, initial)
      const loaded = await readState(dir)

      expect(loaded.goals).toHaveLength(1)
      expect(loaded.goals[0].name).toBe("test")
      expect(loaded.revision).toBe(1)
    })

    it("increments revision on each write", async () => {
      const state = await readState(dir)
      await writeState(dir, state)
      const s2 = await readState(dir)
      await writeState(dir, s2)
      const s3 = await readState(dir)

      expect(s3.revision).toBe(2)
    })
  })

  describe("Event Log", () => {
    it("appends and reads events", async () => {
      await appendEvent(dir, { type: "test", data: 1 })
      await appendEvent(dir, { type: "test", data: 2 })

      const events = await readEvents(dir)
      expect(events).toHaveLength(2)
      expect(events[0]).toEqual({ type: "test", data: 1 })
      expect(events[1]).toEqual({ type: "test", data: 2 })
    })

    it("respects limit", async () => {
      for (let i = 0; i < 10; i++) {
        await appendEvent(dir, { type: "test", i })
      }
      const events = await readEvents(dir, 3)
      expect(events).toHaveLength(3)
      expect(events[0]).toEqual({ type: "test", i: 7 })
    })

    it("returns empty for nonexistent file", async () => {
      const events = await readEvents(path.join(dir, "empty"))
      expect(events).toEqual([])
    })
  })

  describe("Control Mailbox", () => {
    it("writes and reads a control request", async () => {
      const req: ControlRequest = {
        requestID: "req-1",
        command: "start",
        args: { name: "test" },
        requestedAt: new Date().toISOString(),
      }
      await writeControlRequest(dir, req)
      const loaded = await readControlRequest(dir, "req-1")
      expect(loaded).toBeTruthy()
      expect(loaded!.command).toBe("start")
    })

    it("claims a request atomically", async () => {
      const req: ControlRequest = {
        requestID: "req-1",
        command: "start",
        requestedAt: new Date().toISOString(),
      }
      await writeControlRequest(dir, req)

      const claimed = await claimControlRequest(dir, "req-1")
      expect(claimed).toBe(true)

      // Original should be gone
      const original = await readControlRequest(dir, "req-1")
      expect(original).toBeUndefined()
    })

    it("writes and reads a control response", async () => {
      const resp = {
        requestID: "req-1",
        ok: true,
        message: "done",
        completedAt: new Date().toISOString(),
      }
      await writeControlResponse(dir, resp)
      const loaded = await readControlResponse(dir, "req-1")
      expect(loaded).toBeTruthy()
      expect(loaded!.ok).toBe(true)
    })

    it("lists pending requests sorted by time", async () => {
      await writeControlRequest(dir, {
        requestID: "req-2",
        command: "pause",
        requestedAt: "2026-01-02T00:00:00Z",
      })
      await writeControlRequest(dir, {
        requestID: "req-1",
        command: "start",
        requestedAt: "2026-01-01T00:00:00Z",
      })

      const pending = await listPendingRequests(dir)
      expect(pending).toHaveLength(2)
      expect(pending[0].requestID).toBe("req-1")
      expect(pending[1].requestID).toBe("req-2")
    })

    it("recovers stale processing files", async () => {
      const req: ControlRequest = {
        requestID: "req-1",
        command: "start",
        requestedAt: new Date().toISOString(),
      }
      await writeControlRequest(dir, req)
      await claimControlRequest(dir, "req-1")

      const recovered = await recoverStaleProcessing(dir)
      expect(recovered).toHaveLength(1)
      expect(recovered[0].requestID).toBe("req-1")

      // Should be back in requests
      const loaded = await readControlRequest(dir, "req-1")
      expect(loaded).toBeTruthy()
    })
  })
})
