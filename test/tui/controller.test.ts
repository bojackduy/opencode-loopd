import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { promises as fs } from "fs"
import path from "path"
import os from "os"
import { createDashboardController } from "../../src/tui/controller"
import { createControlClient } from "../../src/infrastructure/control-client"
import { createControlWorker } from "../../src/application/control-worker"
import { readState } from "../../src/infrastructure/state-repository"
import { createFakeHost } from "../../src/server/host-adapter"

function tmpDir(): string {
  return path.join(os.tmpdir(), `loopd-controller-test-${crypto.randomUUID()}`)
}

describe("Dashboard Controller", () => {
  let dir: string
  let host: ReturnType<typeof createFakeHost>
  let client: ReturnType<typeof createControlClient>
  let worker: ReturnType<typeof createControlWorker>
  let ctrl: ReturnType<typeof createDashboardController>

  beforeEach(async () => {
    dir = tmpDir()
    await fs.mkdir(dir, { recursive: true })
    host = createFakeHost()
    client = createControlClient(dir)
    worker = createControlWorker({ directory: dir, host, pollIntervalMs: 50 })
    worker.start()
    ctrl = createDashboardController(client)
  })

  afterEach(async () => {
    await worker.stop()
    await fs.rm(dir, { recursive: true, force: true })
  })

  describe("refresh", () => {
    it("returns empty state initially", async () => {
      const state = await ctrl.refresh()
      expect(state.goals).toHaveLength(0)
      expect(state.activeGoals).toHaveLength(0)
      expect(state.selectedGoal).toBeNull()
    })
  })

  describe("moveDown / moveUp", () => {
    it("does not move when no goals", async () => {
      const state = await ctrl.refresh()
      const down = ctrl.moveDown(state)
      expect(down.selected).toBe(0)
      const up = ctrl.moveUp(state)
      expect(up.selected).toBe(0)
    })

    it("moves through goals", async () => {
      // Create two goals
      await ctrl.startGoal("owner-1", "g1", "objective 1")
      await ctrl.startGoal("owner-2", "g2", "objective 2")

      const state = await ctrl.refresh()
      expect(state.activeGoals).toHaveLength(2)

      const down = ctrl.moveDown(state)
      expect(down.selected).toBe(1)
      expect(down.selectedGoal?.name).toBe("g2")

      const downAgain = ctrl.moveDown(down)
      expect(downAgain.selected).toBe(1) // clamped

      const up = ctrl.moveUp(downAgain)
      expect(up.selected).toBe(0)
      expect(up.selectedGoal?.name).toBe("g1")
    })
  })

  describe("moveFirst / moveLast", () => {
    it("moves to first and last", async () => {
      await ctrl.startGoal("owner-1", "g1", "objective 1")
      await ctrl.startGoal("owner-2", "g2", "objective 2")
      await ctrl.startGoal("owner-3", "g3", "objective 3")

      const state = await ctrl.refresh()
      const last = ctrl.moveLast(state)
      expect(last.selected).toBe(2)
      expect(last.selectedGoal?.name).toBe("g3")

      const first = ctrl.moveFirst(last)
      expect(first.selected).toBe(0)
      expect(first.selectedGoal?.name).toBe("g1")
    })
  })

  describe("startGoal", () => {
    it("creates a goal", async () => {
      const result = await ctrl.startGoal("owner-1", "test", "do something")
      expect(result.statusText).toContain("test")

      const state = await client.getState()
      expect(state.goals).toHaveLength(1)
      expect(state.goals[0].name).toBe("test")
    })
  })

  describe("pauseGoal / resumeGoal", () => {
    it("pauses and resumes a goal", async () => {
      await ctrl.startGoal("owner-1", "test", "do something")
      const state = await ctrl.refresh()
      const goal = state.activeGoals[0]!

      const pauseResult = await ctrl.pauseGoal(goal)
      expect(pauseResult.statusText).toContain("paused")

      const state2 = await ctrl.refresh()
      const pausedGoal = state2.goals.find((g) => g.name === "test")!
      const resumeResult = await ctrl.resumeGoal(pausedGoal)
      expect(resumeResult.statusText).toContain("resumed")
    })
  })

  describe("clearGoal", () => {
    it("clears a goal", async () => {
      await ctrl.startGoal("owner-1", "test", "do something")
      const state = await ctrl.refresh()
      const goal = state.activeGoals[0]!

      const result = await ctrl.clearGoal(goal)
      expect(result.statusText).toContain("cleared")

      const state2 = await ctrl.refresh()
      expect(state2.goals).toHaveLength(0)
    })
  })

  describe("toggleLogs", () => {
    it("toggles logs state", async () => {
      const state = await ctrl.refresh()
      expect(state.showLogs).toBe(false)

      const toggled = ctrl.toggleLogs(state)
      expect(toggled.showLogs).toBe(true)

      const toggledAgain = ctrl.toggleLogs(toggled)
      expect(toggledAgain.showLogs).toBe(false)
    })
  })

  describe("executeCommand", () => {
    it("handles goal start command", async () => {
      const state = await ctrl.refresh()
      const result = await ctrl.executeCommand(
        "goal",
        { objective: "do things" },
        ["start", "my-goal"],
        state,
        "owner-1",
      )
      expect(result.statusText).toContain("my-goal")
    })

    it("handles pause command", async () => {
      await ctrl.startGoal("owner-1", "test", "do something")
      const state = await ctrl.refresh()
      const goal = state.activeGoals[0]!

      const result = await ctrl.executeCommand("pause", {}, [], { ...state, selectedGoal: goal }, "owner-1")
      expect(result.statusText).toContain("paused")
    })

    it("handles unknown command", async () => {
      const state = await ctrl.refresh()
      const result = await ctrl.executeCommand("unknown", {}, [], state, "owner-1")
      expect(result.statusText).toContain("Unknown command")
    })

    it("returns close signal for q command", async () => {
      const state = await ctrl.refresh()
      const result = await ctrl.executeCommand("q", {}, [], state, "owner-1")
      expect(result.statusText).toBe("close")
    })
  })
})
