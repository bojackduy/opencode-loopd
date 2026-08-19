import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { promises as fs } from "fs"
import path from "path"
import os from "os"
import { randomUUID } from "crypto"
import { createControlService } from "../../src/application/control-service"
import { readState } from "../../src/infrastructure/state-store"

function tmpDir(): string {
  return path.join(os.tmpdir(), `loopd-ctrl-test-${randomUUID()}`)
}

describe("Control Service", () => {
  let dir: string
  let svc: ReturnType<typeof createControlService>

  beforeEach(async () => {
    dir = tmpDir()
    await fs.mkdir(dir, { recursive: true })
    svc = createControlService()
  })

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  async function startGoal(name: string) {
    await svc.execute(dir, {
      version: 1,
      requestID: randomUUID(),
      requestedAt: new Date().toISOString(),
      command: "start",
      args: { name, objective: `${name} objective`, config: {} },
    })
    const state = await readState(dir)
    return state.goals[0].id
  }

  describe("start", () => {
    it("creates a goal and persists it", async () => {
      const result = await svc.execute(dir, {
        version: 1,
        requestID: randomUUID(),
        requestedAt: new Date().toISOString(),
        command: "start",
        args: { name: "test-goal", objective: "test objective", config: {} },
      })

      expect(result.ok).toBe(true)
      expect(result.message).toContain("test-goal")

      const state = await readState(dir)
      expect(state.goals).toHaveLength(1)
      expect(state.goals[0].name).toBe("test-goal")
      expect(state.goals[0].status).toBe("active")
      expect(state.runtimes).toHaveLength(1)
    })

    it("rejects duplicate goal names", async () => {
      await startGoal("dup")
      const result = await svc.execute(dir, {
        version: 1,
        requestID: randomUUID(),
        requestedAt: new Date().toISOString(),
        command: "start",
        args: { name: "dup", objective: "second", config: {} },
      })
      expect(result.ok).toBe(false)
      expect(result.errorCode).toBe("goal_exists")
    })
  })

  describe("pause / resume", () => {
    it("pauses an active goal", async () => {
      const goalID = await startGoal("p")
      const result = await svc.execute(dir, {
        version: 1,
        requestID: randomUUID(),
        requestedAt: new Date().toISOString(),
        command: "pause",
        goalID,
      })
      expect(result.ok).toBe(true)
      const state = await readState(dir)
      expect(state.goals[0].status).toBe("paused")
    })

    it("resumes a paused goal", async () => {
      const goalID = await startGoal("r")
      await svc.execute(dir, {
        version: 1, requestID: randomUUID(), requestedAt: new Date().toISOString(),
        command: "pause", goalID,
      })
      const result = await svc.execute(dir, {
        version: 1, requestID: randomUUID(), requestedAt: new Date().toISOString(),
        command: "resume", goalID,
      })
      expect(result.ok).toBe(true)
      const state = await readState(dir)
      expect(state.goals[0].status).toBe("active")
    })

    it("rejects double-pause", async () => {
      const goalID = await startGoal("dp")
      await svc.execute(dir, {
        version: 1, requestID: randomUUID(), requestedAt: new Date().toISOString(),
        command: "pause", goalID,
      })
      const result = await svc.execute(dir, {
        version: 1, requestID: randomUUID(), requestedAt: new Date().toISOString(),
        command: "pause", goalID,
      })
      expect(result.ok).toBe(false)
      expect(result.errorCode).toBe("invalid_transition")
    })
  })

  describe("retry", () => {
    it("retries a blocked goal", async () => {
      const goalID = await startGoal("b")
      // Manually block it
      const state = await readState(dir)
      state.goals[0].status = "blocked"
      const { writeState } = await import("../../src/infrastructure/state-store")
      await writeState(dir, state)

      const result = await svc.execute(dir, {
        version: 1, requestID: randomUUID(), requestedAt: new Date().toISOString(),
        command: "retry", goalID,
      })
      expect(result.ok).toBe(true)
      const state2 = await readState(dir)
      expect(state2.goals[0].status).toBe("active")
      expect(state2.runtimes[0].consecutiveFailures).toBe(0)
    })

    it("rejects retry on active goal", async () => {
      const goalID = await startGoal("a")
      const result = await svc.execute(dir, {
        version: 1, requestID: randomUUID(), requestedAt: new Date().toISOString(),
        command: "retry", goalID,
      })
      expect(result.ok).toBe(false)
      expect(result.errorCode).toBe("invalid_transition")
    })
  })

  describe("clear", () => {
    it("removes a goal and its runtime", async () => {
      const goalID = await startGoal("c")
      const result = await svc.execute(dir, {
        version: 1, requestID: randomUUID(), requestedAt: new Date().toISOString(),
        command: "clear", goalID,
      })
      expect(result.ok).toBe(true)
      const state = await readState(dir)
      expect(state.goals).toHaveLength(0)
      expect(state.runtimes).toHaveLength(0)
    })
  })

  describe("unknown command", () => {
    it("rejects unknown commands", async () => {
      const result = await svc.execute(dir, {
        version: 1, requestID: randomUUID(), requestedAt: new Date().toISOString(),
        command: "nonexistent" as any,
      })
      expect(result.ok).toBe(false)
      expect(result.errorCode).toBe("unknown_command")
    })
  })
})
