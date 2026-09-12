import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { promises as fs } from "fs"
import path from "path"
import os from "os"
import { createGoalService } from "../../src/application/goal-service"
import { createFakeHost } from "../../src/server/host-adapter"
import { readState } from "../../src/infrastructure/state-repository"
import type { GoalID } from "../../src/domain/goal"
import { goalTools } from "../../src/server/goal-tools"

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

    it("allows creating a goal without agent (SDK uses parent session)", async () => {
      const create = goalTools(dir, goalService, "owner-1").loopd_create_goal
      const result = await create.execute({
        name: "no-agent",
        objective: "Analyze the existing implementation without changing files.",
        workspaceWrite: false,
      }, { sessionID: "owner-1" })

      const output = JSON.parse(result.output)
      expect(output.ok).toBe(true)
      expect(output.agent).toBeUndefined()
      expect((await readState(dir)).goals).toHaveLength(1)
    })

    it("applies configured agent and checks to a workspace-writing goal", async () => {
      const create = goalTools(dir, goalService, "owner-1", {
        defaultAgent: "smart-agent",
        defaultChecks: ["bun test", "bun run typecheck"],
      }).loopd_create_goal
      const result = await create.execute({
        name: "safe-code-change",
        objective: "Fix the bug in the TypeScript source code.",
      }, { sessionID: "owner-1" })

      const output = JSON.parse(result.output)
      expect(output.ok).toBe(true)
      expect(output.defaultsApplied).toEqual({ agent: true, model: false, checks: true })
      const goal = (await readState(dir)).goals[0]
      expect(goal.config.agent).toBe("smart-agent")
      expect(goal.config.checks).toEqual(["bun test", "bun run typecheck"])
      expect(goal.config.checkCwd).toBe(dir)
      expect(goal.config.workspaceWrite).toBe(true)
    })

    it("applies hardcoded bun test default when no checks provided", async () => {
      const create = goalTools(dir, goalService, "owner-1").loopd_create_goal
      const result = await create.execute({
        name: "with-hardcoded-default",
        objective: "Fix a typo",
        agent: "smart-agent",
      }, { sessionID: "owner-1" })

      expect(JSON.parse(result.output).ok).toBe(true)
      const goal = (await readState(dir)).goals[0]
      expect(goal.config.checks).toEqual(["bun test"])
    })

    it("does not apply project default checks to artifact-only goals", async () => {
      const create = goalTools(dir, goalService, "owner-1", {
        defaultAgent: "smart-agent",
        defaultChecks: ["bun test"],
      }).loopd_create_goal
      const result = await create.execute({
        name: "artifact-research",
        objective: "Analyze behavior and save a report in the goal artifact directory.",
        workspaceWrite: false,
      }, { sessionID: "owner-1" })

      expect(JSON.parse(result.output).ok).toBe(true)
      const goal = (await readState(dir)).goals[0]
      expect(goal.config.workspaceWrite).toBe(false)
      expect(goal.config.checks).toBeUndefined()
      expect(goal.config.checkCwd).toBeUndefined()
    })

    it("passes explicit agent and model through to the worker config", async () => {
      const create = goalTools(dir, goalService, "owner-1").loopd_create_goal
      const result = await create.execute({
        name: "custom-worker",
        objective: "Analyze behavior and save a report in the goal artifact directory.",
        workspaceWrite: false,
        agent: "researcher",
        model: "ollama/qwen3.8:27b",
      }, { sessionID: "owner-1" })

      const output = JSON.parse(result.output)
      expect(output.ok).toBe(true)
      expect(output.agent).toBe("researcher")
      expect(output.model).toBe("ollama/qwen3.8:27b")
      const goal = (await readState(dir)).goals[0]
      expect(goal.config.agent).toBe("researcher")
      expect(goal.config.model).toBe("ollama/qwen3.8:27b")
    })

    it("rejects malformed model strings", async () => {
      const create = goalTools(dir, goalService, "owner-1").loopd_create_goal
      const result = await create.execute({
        name: "bad-model",
        objective: "Analyze behavior.",
        workspaceWrite: false,
        model: "gpt-5",
      }, { sessionID: "owner-1" })

      const output = JSON.parse(result.output)
      expect(output.ok).toBe(false)
      expect(output.errorCode).toBe("invalid_model")
      expect((await readState(dir)).goals).toHaveLength(0)
    })

    it("persists an explicit cost budget on the goal", async () => {
      const create = goalTools(dir, goalService, "owner-1").loopd_create_goal
      const result = await create.execute({
        name: "capped-spend",
        objective: "Analyze behavior and save a report in the goal artifact directory.",
        workspaceWrite: false,
        model: "opencode-go/glm-5.2",
        costBudget: 0.5,
      }, { sessionID: "owner-1" })

      const output = JSON.parse(result.output)
      expect(output.ok).toBe(true)
      expect(output.costBudget).toBe(0.5)
      const goal = (await readState(dir)).goals[0]
      expect(goal.costBudget).toBe(0.5)
    })

    it("rejects non-positive cost budgets", async () => {
      const create = goalTools(dir, goalService, "owner-1").loopd_create_goal
      for (const costBudget of [0, -1, Number.NaN]) {
        const result = await create.execute({
          name: "bad-budget",
          objective: "Analyze behavior.",
          workspaceWrite: false,
          costBudget,
        }, { sessionID: "owner-1" })
        const output = JSON.parse(result.output)
        expect(output.ok).toBe(false)
        expect(output.errorCode).toBe("invalid_cost_budget")
      }
      expect((await readState(dir)).goals).toHaveLength(0)
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
