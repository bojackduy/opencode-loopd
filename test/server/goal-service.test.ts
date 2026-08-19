import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { promises as fs } from "fs"
import path from "path"
import os from "os"
import { createGoalService } from "../../src/application/goal-service"
import { readState } from "../../src/infrastructure/state-store"
import type { LoopHost, SessionMessage } from "../../src/server/host-adapter"
import type { GoalID } from "../../src/domain/goal"

function tmpDir(): string {
  return path.join(os.tmpdir(), `loopd-goal-test-${crypto.randomUUID()}`)
}

function createFakeHost(): LoopHost & { sessions: Map<string, string[]> } {
  const sessions = new Map<string, string[]>()
  return {
    sessions,
    async createWorker({ parentID, title }) {
      const id = `worker-${crypto.randomUUID().slice(0, 8)}`
      sessions.set(id, [])
      return id
    },
    async promptWorker({ sessionID, prompt }) {
      const msgs = sessions.get(sessionID) || []
      msgs.push(prompt)
      sessions.set(sessionID, msgs)
    },
    async sessionStatus(sessionID) {
      return "idle"
    },
    async abortSession(sessionID) {
      sessions.delete(sessionID)
    },
    async readMessages(sessionID) {
      return []
    },
  }
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
})
