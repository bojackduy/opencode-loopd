import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { promises as fs } from "fs"
import path from "path"
import os from "os"
import { createGoalService } from "../../src/application/goal-service"
import { createFakeHost } from "../../src/server/host-adapter"
import { readState } from "../../src/infrastructure/state-repository"
import type { GoalID } from "../../src/domain/goal"

function tmpDir(): string {
  return path.join(os.tmpdir(), `loopd-tools-test-${crypto.randomUUID()}`)
}

describe("Goal Tools", () => {
  let dir: string
  let host: ReturnType<typeof createFakeHost>
  let goalService: ReturnType<typeof createGoalService>

  beforeEach(async () => {
    dir = tmpDir()
    await fs.mkdir(dir, { recursive: true })
    host = createFakeHost()
    goalService = createGoalService(host)
  })

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  describe("createGoal", () => {
    it("creates goal with progress fields", async () => {
      const { goal } = await goalService.start(dir, {
        name: "test",
        objective: "do something",
        ownerSessionID: "owner-1",
      })

      expect(goal.lastProgress).toBeUndefined()
      expect(goal.completionEvidence).toBeUndefined()
      expect(goal.blocker).toBeUndefined()
    })

    it("records owner session ID", async () => {
      const { goal } = await goalService.start(dir, {
        name: "test",
        objective: "do something",
        ownerSessionID: "owner-1",
      })

      expect(goal.ownerSessionID).toBe("owner-1")
    })
  })

  describe("goal transitions", () => {
    it("creates goal in queued phase then running", async () => {
      const { goal } = await goalService.start(dir, {
        name: "test",
        objective: "do something",
        ownerSessionID: "owner-1",
      })

      const state = await readState(dir)
      const runtime = state.runtimes.find((r) => r.goalID === goal.id)
      expect(runtime?.phase).toBe("running")
    })

    it("pause releases lease", async () => {
      const { goal } = await goalService.start(dir, {
        name: "test",
        objective: "do something",
        ownerSessionID: "owner-1",
      })

      await goalService.pause(dir, goal.id)

      const state = await readState(dir)
      const runtime = state.runtimes.find((r) => r.goalID === goal.id)
      expect(runtime?.phase).toBe("idle")
      expect(runtime?.leaseExpiresAt).toBeUndefined()
    })

    it("resume recreates worker and starts turn", async () => {
      const { goal } = await goalService.start(dir, {
        name: "test",
        objective: "do something",
        ownerSessionID: "owner-1",
      })

      await goalService.pause(dir, goal.id)
      await goalService.resume(dir, goal.id)

      const state = await readState(dir)
      expect(state.goals[0].status).toBe("active")
      expect(state.goals[0].workerSessionID).toBeTruthy()
    })

    it("retry clears failures and resumes", async () => {
      const { goal } = await goalService.start(dir, {
        name: "test",
        objective: "do something",
        ownerSessionID: "owner-1",
      })

      // Manually block the goal
      const state = await readState(dir)
      state.goals[0].status = "blocked"
      const runtime = state.runtimes.find((r) => r.goalID === goal.id)
      if (runtime) {
        runtime.consecutiveFailures = 3
        runtime.lastError = "test error"
      }
      await fs.writeFile(
        path.join(dir, ".opencode", "loopd", "state.json"),
        JSON.stringify(state, null, 2),
      )

      await goalService.retry(dir, goal.id)

      const newState = await readState(dir)
      expect(newState.goals[0].status).toBe("active")
      const newRuntime = newState.runtimes.find((r) => r.goalID === goal.id)
      expect(newRuntime?.consecutiveFailures).toBe(0)
      expect(newRuntime?.lastError).toBeUndefined()
    })

    it("clear removes goal and runtime", async () => {
      const { goal } = await goalService.start(dir, {
        name: "test",
        objective: "do something",
        ownerSessionID: "owner-1",
      })

      await goalService.clear(dir, goal.id)

      const state = await readState(dir)
      expect(state.goals).toHaveLength(0)
      expect(state.runtimes).toHaveLength(0)
    })
  })

  describe("reconcile", () => {
    it("recreates missing worker for active goal", async () => {
      const { goal } = await goalService.start(dir, {
        name: "test",
        objective: "do something",
        ownerSessionID: "owner-1",
      })

      // Simulate restart: clear sessions cache
      const goalService2 = createGoalService(host)

      // Reconcile should recreate the worker
      await goalService2.reconcile(dir)

      const state = await readState(dir)
      expect(state.goals[0].workerSessionID).toBeTruthy()
    })
  })
})
