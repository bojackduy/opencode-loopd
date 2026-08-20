import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { promises as fs } from "fs"
import path from "path"
import os from "os"
import { createGoalService } from "../../src/application/goal-service"
import { readState } from "../../src/infrastructure/state-repository"
import { createFakeHost } from "../../src/server/host-adapter"
import type { GoalID } from "../../src/domain/goal"

function tmpDir(): string {
  return path.join(os.tmpdir(), `loopd-goal-test-${crypto.randomUUID()}`)
}

describe("Goal Service", () => {
  let dir: string
  let host: ReturnType<typeof createFakeHost>
  let svc: ReturnType<typeof createGoalService>

  beforeEach(async () => {
    dir = tmpDir()
    await fs.mkdir(dir, { recursive: true })
    host = createFakeHost()
    svc = createGoalService(host)
  })

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  describe("start", () => {
    it("creates a goal and worker session", async () => {
      const { goal, worker } = await svc.start(dir, {
        name: "test",
        objective: "do something",
        ownerSessionID: "owner-1",
      })

      expect(goal.name).toBe("test")
      expect(goal.status).toBe("active")
      expect(goal.workerSessionID).toBeTruthy()
      expect(worker.workerSessionID).toBeTruthy()

      const state = await readState(dir)
      expect(state.goals).toHaveLength(1)
      expect(state.runtimes).toHaveLength(1)
    })

    it("sends first continuation to worker", async () => {
      const { worker } = await svc.start(dir, {
        name: "test",
        objective: "do something",
        ownerSessionID: "owner-1",
      })

      const msgs = host.sessions.get(worker.workerSessionID) || []
      expect(msgs.length).toBeGreaterThan(0)
      expect(msgs[0]).toContain("get_goal")
      expect(msgs[0]).toContain("complete_goal")
      expect(msgs[0]).toContain("block_goal")
    })

    it("records owner session ID", async () => {
      await svc.start(dir, {
        name: "test",
        objective: "do something",
        ownerSessionID: "owner-1",
      })

      const state = await readState(dir)
      expect(state.goals[0].ownerSessionID).toBe("owner-1")
    })

    it("blocks the goal and preserves the error when worker creation fails", async () => {
      host.createWorker = async () => {
        throw new Error("parent session not found")
      }

      await expect(svc.start(dir, {
        name: "broken",
        objective: "do something",
        ownerSessionID: "missing-parent",
      })).rejects.toThrow("parent session not found")

      const state = await readState(dir)
      expect(state.goals[0].status).toBe("blocked")
      expect(state.goals[0].blocker?.reason).toContain("parent session not found")
      expect(state.runtimes[0].phase).toBe("idle")
      expect(state.runtimes[0].lastError).toContain("parent session not found")
    })
  })

  describe("pause / resume", () => {
    it("pauses an active goal and aborts worker", async () => {
      const { goal } = await svc.start(dir, {
        name: "p",
        objective: "o",
        ownerSessionID: "owner-1",
      })

      await svc.pause(dir, goal.id)

      const state = await readState(dir)
      expect(state.goals[0].status).toBe("paused")
    })

    it("resumes a paused goal and recreates worker", async () => {
      const { goal } = await svc.start(dir, {
        name: "r",
        objective: "o",
        ownerSessionID: "owner-1",
      })

      await svc.pause(dir, goal.id)
      await svc.resume(dir, goal.id)

      const state = await readState(dir)
      expect(state.goals[0].status).toBe("active")
    })
  })

  describe("clear", () => {
    it("removes goal and aborts worker", async () => {
      const { goal, worker } = await svc.start(dir, {
        name: "c",
        objective: "o",
        ownerSessionID: "owner-1",
      })

      await svc.clear(dir, goal.id)

      const state = await readState(dir)
      expect(state.goals).toHaveLength(0)
      expect(host.sessions.has(worker.workerSessionID)).toBe(false)
    })
  })

  describe("getWorker", () => {
    it("returns worker for active goal", async () => {
      const { goal } = await svc.start(dir, {
        name: "w",
        objective: "o",
        ownerSessionID: "owner-1",
      })

      const worker = svc.getWorker(goal.id)
      expect(worker).toBeTruthy()
      expect(worker?.goalID).toBe(goal.id)
    })

    it("returns undefined for unknown goal", () => {
      expect(svc.getWorker("unknown" as GoalID)).toBeUndefined()
    })
  })

  describe("getActiveWorkers", () => {
    it("returns all active workers", async () => {
      const { goal: g1 } = await svc.start(dir, {
        name: "w1",
        objective: "o1",
        ownerSessionID: "owner-1",
      })
      const { goal: g2 } = await svc.start(dir, {
        name: "w2",
        objective: "o2",
        ownerSessionID: "owner-2",
      })

      const workers = svc.getActiveWorkers()
      expect(workers.size).toBe(2)
      expect(workers.has(g1.id)).toBe(true)
      expect(workers.has(g2.id)).toBe(true)
    })
  })
})
