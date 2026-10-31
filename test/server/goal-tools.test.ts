import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { promises as fs } from "fs"
import path from "path"
import os from "os"
import { createGoalService } from "../../src/application/goal-service"
import { createFakeHost } from "../../src/server/host-adapter"
import { readState, readEvents } from "../../src/infrastructure/state-repository"
import type { GoalID } from "../../src/domain/goal"
import { goalTools } from "../../src/server/goal-tools"
import { runCompletionChecks } from "../../src/server/goal-tools"
import { tool } from "@opencode-ai/plugin/tool"

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
    it("acknowledges a repeated block without changing its blocker or emitting another transition", async () => {
      const { goal } = await goalService.start(dir, { name: "blocked", objective: "test", ownerSessionID: "owner-1" })
      const tools = goalTools(dir, goalService)
      const context = { sessionID: goal.workerSessionID }
      await tools.block_goal.execute({ reason: "reference unavailable", needed: "approved export" }, context)
      const first = (await readState(dir)).goals[0]
      const repeated = JSON.parse((await tools.block_goal.execute({ reason: "replacement", needed: "replacement" }, context)).output)
      expect(repeated).toMatchObject({ status: "blocked", alreadyBlocked: true, reason: "reference unavailable", needed: "approved export" })
      const state = await readState(dir)
      expect(state.goals[0].blocker).toEqual(first.blocker)
      expect(state.runtimes[0].phase).toBe("idle")
      expect((await readEvents(dir, 100)).filter((event) => event.type === "goal.blocked")).toHaveLength(1)
      expect(host.promptCalls).toHaveLength(1)
    })

    it("runs configured checks through the controlled tool and releases its exclusive operation", async () => {
      const tools = goalTools(dir, goalService, "owner-1")
      const created = JSON.parse((await tools.loopd_create_goal.execute({ name: "checks", objective: "test", write_scope: [], checks: ["exit 0"] }, { sessionID: "owner-1" })).output)
      expect(created.ok).toBe(true)
      const result = JSON.parse((await tools.run_goal_checks.execute({}, { sessionID: created.workerSessionID })).output)
      expect(result).toMatchObject({ ok: true, passed: true, failures: [] })
      expect((await readState(dir)).workspaceOperation).toBeUndefined()
      const parent = JSON.parse((await tools.run_goal_checks.execute({}, { sessionID: "owner-1" })).output)
      expect(parent.ok).toBe(false)
    })

    it("persists explicit exploration scope and claims via the actual worker tool", async () => {
      const tools = goalTools(dir, goalService, "owner-1")
      const created = JSON.parse((await tools.loopd_create_goal.execute({ name: "scoped", objective: "test", write_scope: [] }, { sessionID: "owner-1" })).output)
      expect(created.ok).toBe(true)
      expect(created.write_scope).toEqual([])
      const state = await readState(dir)
      const generation = state.runtimes[0]!.runGeneration
      const claimed = JSON.parse((await tools.claim_goal_scope.execute({ paths: ["src/new.ts"], runGeneration: generation }, { sessionID: created.workerSessionID })).output)
      expect(claimed).toMatchObject({ ok: true, write_scope: ["src/new.ts"] })
      const inspected = JSON.parse((await tools.get_goal.execute({}, { sessionID: created.workerSessionID })).output)
      expect(inspected.config.write_scope).toEqual(["src/new.ts"])
      const stale = JSON.parse((await tools.claim_goal_scope.execute({ paths: ["other.ts"], runGeneration: generation - 1 }, { sessionID: created.workerSessionID })).output)
      expect(stale.ok).toBe(false)
      expect(stale.message).toContain("stale")
    })

    it("rejects unsafe creation scope and read-only claims before persisting a goal", async () => {
      const tools = goalTools(dir, goalService, "owner-1")
      for (const args of [{ write_scope: ["../outside.ts"] }, { workspaceWrite: false, write_scope: ["inside.ts"] }]) {
        const created = JSON.parse((await tools.loopd_create_goal.execute({ name: "unsafe", objective: "test", ...args }, { sessionID: "owner-1" })).output)
        expect(created.ok).toBe(false)
        expect((await readState(dir)).goals).toHaveLength(0)
      }
    })

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

    it("inherits the calling session's live agent/model when unset", async () => {
      const liveHost: any = {
        ...host,
        readSession: async (sessionID: string) => {
          expect(sessionID).toBe("owner-live")
          return { agent: "plan", model: { providerID: "openrouter", modelID: "meta/muse-spark-1.3-contributor" } }
        },
      }
      const create = goalTools(dir, goalService, "owner-live", {}, liveHost).loopd_create_goal
      const result = await create.execute({
        name: "inherit-live",
        objective: "Analyze the existing implementation without changing files.",
        workspaceWrite: false,
      }, { sessionID: "owner-live" })

      const output = JSON.parse(result.output)
      expect(output.ok).toBe(true)
      expect(output.agent).toBe("plan")
      expect(output.model).toBe("openrouter/meta/muse-spark-1.3-contributor")
      const goal = (await readState(dir)).goals[0]
      expect(goal.config.agent).toBe("plan")
      expect(goal.config.model).toBe("openrouter/meta/muse-spark-1.3-contributor")
      expect(goal.parentAgent).toBe("plan")
      expect(goal.parentModel).toBe("openrouter/meta/muse-spark-1.3-contributor")
      // Worker prompts carry the inherited identity
      expect(host.promptCalls[host.promptCalls.length - 1]).toMatchObject({
        agent: "plan",
        model: { providerID: "openrouter", modelID: "meta/muse-spark-1.3-contributor" },
      })
    })

    it("falls back to static defaults when the parent session is unreadable", async () => {
      const deadHost: any = { ...host, readSession: async () => undefined }
      const create = goalTools(dir, goalService, "owner-dead", { defaultAgent: "smart-agent" }, deadHost).loopd_create_goal
      const result = await create.execute({
        name: "inherit-fallback",
        objective: "Analyze the existing implementation without changing files.",
        workspaceWrite: false,
      }, { sessionID: "owner-dead" })

      const output = JSON.parse(result.output)
      expect(output.ok).toBe(true)
      expect(output.agent).toBe("smart-agent")
      expect(output.defaultsApplied).toEqual({ agent: true, model: false, checks: false })
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
    it("report_goal_progress accepts summary+next without evidence", async () => {
      const tools = goalTools(dir, goalService)
      const schema = tool.schema.object(tools.report_goal_progress.args as any)
      expect(schema.safeParse({ summary: "did x", next: "do y" }).success).toBe(true)
      expect(schema.safeParse({ summary: "did x" }).success).toBe(false)
    })

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

  describe("cross-directory goal creation", () => {
    async function otherProject(): Promise<{ dir: string; target: string }> {
      const dir = tmpDir()
      await fs.mkdir(dir, { recursive: true })
      // Canonicalize (/tmp -> /private/tmp on macOS) to match the tool.
      return { dir, target: await fs.realpath(dir) }
    }

    it("rejects a relative directory", async () => {
      const tools = goalTools(dir, goalService, "owner-1")
      const created = JSON.parse((await tools.loopd_create_goal.execute({ name: "x", objective: "test", workspaceWrite: false, directory: "relative/path" }, { sessionID: "owner-1" })).output)
      expect(created.ok).toBe(false)
      expect(created.errorCode).toBe("invalid_directory")
      expect((await readState(dir)).goals).toHaveLength(0)
    })

    it("rejects a nonexistent directory", async () => {
      const tools = goalTools(dir, goalService, "owner-1")
      const missing = path.join(dir, "does-not-exist")
      const created = JSON.parse((await tools.loopd_create_goal.execute({ name: "x", objective: "test", workspaceWrite: false, directory: missing }, { sessionID: "owner-1" })).output)
      expect(created.ok).toBe(false)
      expect(created.errorCode).toBe("invalid_directory")
      expect((await readState(dir)).goals).toHaveLength(0)
    })

    it("rejects a file that is not a directory", async () => {
      const file = path.join(dir, "note.txt")
      await fs.writeFile(file, "x")
      const tools = goalTools(dir, goalService, "owner-1")
      const created = JSON.parse((await tools.loopd_create_goal.execute({ name: "x", objective: "test", workspaceWrite: false, directory: path.join(dir, "note.txt") }, { sessionID: "owner-1" })).output)
      expect(created.ok).toBe(false)
      expect(created.errorCode).toBe("invalid_directory")
      expect((await readState(dir)).goals).toHaveLength(0)
    })

    it("creates state, artifacts, and the worker in the target project, not the caller's", async () => {
      const other = await otherProject()
      try {
        const tools = goalTools(dir, goalService, "owner-1")
        const created = JSON.parse((await tools.loopd_create_goal.execute({
          name: "scoped",
          objective: "test",
          write_scope: ["src/a.ts"],
          checks: ["true"],
          directory: other.dir,
        }, { sessionID: "owner-1" })).output)
        expect(created.ok).toBe(true)
        expect(created.directory).toBe(other.target)
        // Caller's own store is untouched.
        expect((await readState(dir)).goals).toHaveLength(0)
        // Target store owns goal, runtime, and artifacts.
        const state = await readState(other.target)
        expect(state.goals).toHaveLength(1)
        expect(state.goals[0].name).toBe("scoped")
        expect(state.goals[0].workerSessionID).toBeTruthy()
        expect(state.goals[0].config.artifactDir!.startsWith(other.target)).toBe(true)
        // Worker creation carried the target project.
        expect(host.workerCreations).toHaveLength(1)
        expect(host.workerCreations[0].directory).toBe(other.target)
        expect(state.goals[0].ownerSessionID).toBe("owner-1")
        // Artifact dir exists on disk in the target project.
        const stat = await fs.stat(state.goals[0].config.artifactDir!)
        expect(stat.isDirectory()).toBe(true)
      } finally {
        await fs.rm(other.dir, { recursive: true, force: true })
      }
    })

    it("runs interactive goals in the target project without forcing completion", async () => {
      const other = await otherProject()
      try {
        const tools = goalTools(dir, goalService, "owner-1")
        const created = JSON.parse((await tools.loopd_create_goal.execute({
          name: "manual",
          objective: "wait for steering",
          workspaceWrite: false,
          interactive: true,
          directory: other.dir,
        }, { sessionID: "owner-1" })).output)
        expect(created.ok).toBe(true)
        expect(created.interactive).toBe(true)
        const state = await readState(other.target)
        expect(state.goals[0].interactive).toBe(true)
        expect(state.goals[0].workerSessionID).toBeTruthy()
        // No auto-completion or forced finish at creation; the worker waits.
        expect(state.goals[0].status).toBe("active")
        expect(state.runtimes[0].phase).not.toBe("idle")
        expect(host.workerCreations).toHaveLength(1)
        expect(host.workerCreations[0].directory).toBe(other.target)
      } finally {
        await fs.rm(other.dir, { recursive: true, force: true })
      }
    })

    it("passes query.directory to v1 session.create, omitting it for same-project workers", async () => {
      const { createRealHost } = await import("../../src/server/host-adapter")
      const calls: unknown[] = []
      const host = createRealHost({ session: { create: async (input: unknown) => { calls.push(input); return { data: { id: "worker-9" } }; } } }, "/tmp/proj-a")
      await host.createWorker({ parentID: "owner-1", title: "loopd: cross", directory: "/tmp/proj-b" })
      expect(calls).toHaveLength(1)
      expect((calls[0] as any).query).toEqual({ directory: "/tmp/proj-b" })
      await host.createWorker({ parentID: "owner-1", title: "loopd: home" })
      expect(calls).toHaveLength(2)
      expect((calls[1] as any).query).toBeUndefined()
    })
  })
})

describe("runCompletionChecks", () => {
  it("reports a killed check as a timeout, never as an ordinary failure", async () => {
    const result = await runCompletionChecks(["sleep 30"], undefined, 300)

    expect(result.passed).toBe(false)
    expect(result.failures).toHaveLength(1)
    expect(result.failures[0].timedOut).toBe(true)
    // A killed child has no exit code. Reporting one is what made a timeout
    // indistinguishable from a real test failure.
    expect(result.failures[0].exitCode).toBeNull()
    expect(result.failures[0].stderr).toContain("exceeded its")
    expect(result.failures[0].stderr).toContain("not a failure report")
  })

  it("still reports a genuine failure with its real exit code", async () => {
    const result = await runCompletionChecks(["exit 7"])

    expect(result.passed).toBe(false)
    expect(result.failures[0].timedOut).toBe(false)
    expect(result.failures[0].exitCode).toBe(7)
  })

  it("passes a check that succeeds", async () => {
    const result = await runCompletionChecks(["true"])

    expect(result.passed).toBe(true)
    expect(result.failures).toHaveLength(0)
  })
})
