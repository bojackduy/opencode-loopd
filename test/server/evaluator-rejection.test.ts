import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { promises as fs } from "fs"
import path from "path"
import os from "os"
import { createGoalService } from "../../src/application/goal-service"
import { createFakeHost } from "../../src/server/host-adapter"
import { readState } from "../../src/infrastructure/state-repository"
import { goalTools } from "../../src/server/goal-tools"
import type { GoalID } from "../../src/domain/goal"

function tmpDir(): string {
  return path.join(os.tmpdir(), `loopd-eval-reject-test-${crypto.randomUUID()}`)
}

describe("Evaluator Rejection Path", () => {
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

  it("increments evaluatorRejectionCount on check failure", async () => {
    // Create a goal with a failing check
    const { goal } = await goalService.start(dir, {
      name: "test",
      objective: "do something",
      ownerSessionID: "owner-1",
      config: {
        checks: ["false"], // always fails
      },
    })

    // Get the tools for this goal
    const tools = goalTools(dir, goalService, "owner-1")
    const completeTool = tools.complete_goal

    // Simulate the child calling complete_goal
    const context = { sessionID: goal.workerSessionID }
    const result = await completeTool.execute(
      { summary: "done", evidence: "evidence" },
      context,
    )

    // Check that evaluatorRejectionCount was incremented
    const state = await readState(dir)
    const runtime = state.runtimes.find((r) => r.goalID === goal.id)
    expect(runtime?.evaluatorRejectionCount).toBe(1)
    expect(runtime?.forceFinishRequested).toBeFalsy()
  })

  it("sets freeRetryPending on rejection and resets forceFinishRequested", async () => {
    // Create a goal with a failing check
    const { goal } = await goalService.start(dir, {
      name: "test",
      objective: "do something",
      ownerSessionID: "owner-1",
      config: {
        checks: ["false"], // always fails
      },
    })

    // Manually set forceFinishRequested
    const state = await readState(dir)
    const runtime = state.runtimes.find((r) => r.goalID === goal.id)
    if (runtime) {
      runtime.forceFinishRequested = true
      runtime.budgetTurnCount = 5
    }
    await fs.writeFile(
      path.join(dir, ".opencode", "loopd", "state.json"),
      JSON.stringify(state, null, 2),
    )

    // Get the tools for this goal
    const tools = goalTools(dir, goalService, "owner-1")
    const completeTool = tools.complete_goal

    // Simulate the child calling complete_goal
    const context = { sessionID: goal.workerSessionID }
    await completeTool.execute(
      { summary: "done", evidence: "evidence" },
      context,
    )

    // Check that forceFinishRequested was reset and freeRetryPending set
    const newState = await readState(dir)
    const newRuntime = newState.runtimes.find((r) => r.goalID === goal.id)
    expect(newRuntime?.forceFinishRequested).toBe(false)
    expect(newRuntime?.freeRetryPending).toBe(true)
    expect(newRuntime?.budgetTurnCount).toBe(5) // not decremented
  })

  it("blocks goal after 3 rejections", async () => {
    // Create a goal with a failing check
    const { goal } = await goalService.start(dir, {
      name: "test",
      objective: "do something",
      ownerSessionID: "owner-1",
      config: {
        checks: ["false"], // always fails
      },
    })

    // Get the tools for this goal
    const tools = goalTools(dir, goalService, "owner-1")
    const completeTool = tools.complete_goal
    const context = { sessionID: goal.workerSessionID }

    // Simulate 3 rejections
    let finalResult
    for (let i = 0; i < 3; i++) {
      finalResult = await completeTool.execute(
        { summary: "done", evidence: "evidence" },
        context,
      )
    }

    // Check that goal is blocked after 3 rejections
    const state = await readState(dir)
    const runtime = state.runtimes.find((r) => r.goalID === goal.id)
    expect(runtime?.evaluatorRejectionCount).toBe(3)
    expect(state.goals[0].status).toBe("blocked")
    expect(state.goals[0].blocker?.reason).toContain("rejected")
    expect(runtime?.phase).toBe("idle")
    expect(runtime?.activeRunID).toBeUndefined()
    expect(runtime?.leaseExpiresAt).toBeUndefined()
    expect(runtime?.activePromptMessageID).toBeUndefined()
    expect(runtime?.activeToolCallIDs).toEqual([])
    expect(runtime?.freeRetryPending).toBe(false)

    const output = JSON.parse(finalResult!.output)
    expect(finalResult!.title).toBe("Completion rejected — goal blocked")
    expect(output.goalID).toBe(goal.id)
    expect(output.status).toBe("blocked")
    expect(output.message).toContain("owner retry required")
  })

  it("starts a fresh rejection episode when the owner retries", async () => {
    const { goal } = await goalService.start(dir, {
      name: "test",
      objective: "do something",
      ownerSessionID: "owner-1",
      config: { checks: ["false"] },
    })
    const completeTool = goalTools(dir, goalService, "owner-1").complete_goal
    const context = { sessionID: goal.workerSessionID }

    for (let i = 0; i < 3; i++) {
      await completeTool.execute({ summary: "done", evidence: "evidence" }, context)
    }
    await goalService.retry(dir, goal.id)

    const state = await readState(dir)
    const runtime = state.runtimes.find((r) => r.goalID === goal.id)
    expect(state.goals[0].status).toBe("active")
    expect(runtime?.evaluatorRejectionCount).toBe(0)
    expect(runtime?.lastRejectionDetails).toBeUndefined()
    expect(runtime?.freeRetryPending).toBe(false)
    expect(runtime?.recentVerificationAttempts).toHaveLength(3)
  })

  it("does not decrement budgetTurnCount on rejection", async () => {
    // Create a goal with a failing check
    const { goal } = await goalService.start(dir, {
      name: "test",
      objective: "do something",
      ownerSessionID: "owner-1",
      config: {
        checks: ["false"], // always fails
      },
    })

    // Set budgetTurnCount to 1
    const state = await readState(dir)
    const runtime = state.runtimes.find((r) => r.goalID === goal.id)
    if (runtime) {
      runtime.budgetTurnCount = 1
    }
    await fs.writeFile(
      path.join(dir, ".opencode", "loopd", "state.json"),
      JSON.stringify(state, null, 2),
    )

    // Get the tools for this goal
    const tools = goalTools(dir, goalService, "owner-1")
    const completeTool = tools.complete_goal
    const context = { sessionID: goal.workerSessionID }

    // Simulate the child calling complete_goal
    await completeTool.execute(
      { summary: "done", evidence: "evidence" },
      context,
    )

    // Check that budgetTurnCount is not decremented
    const newState = await readState(dir)
    const newRuntime = newState.runtimes.find((r) => r.goalID === goal.id)
    expect(newRuntime?.budgetTurnCount).toBe(1) // not decremented
    expect(newRuntime?.freeRetryPending).toBe(true) // but free retry is granted
  })

  it("returns rejection count in output", async () => {
    // Create a goal with a failing check
    const { goal } = await goalService.start(dir, {
      name: "test",
      objective: "do something",
      ownerSessionID: "owner-1",
      config: {
        checks: ["false"], // always fails
      },
    })

    // Get the tools for this goal
    const tools = goalTools(dir, goalService, "owner-1")
    const completeTool = tools.complete_goal
    const context = { sessionID: goal.workerSessionID }

    // Simulate the child calling complete_goal
    const result = await completeTool.execute(
      { summary: "done", evidence: "evidence" },
      context,
    )

    // Check that the output includes rejection count
    const output = JSON.parse(result.output)
    expect(output.rejectionCount).toBe(1)
    expect(output.passed).toBe(false)
    expect(output.message).toContain("rejected")
  })
})
