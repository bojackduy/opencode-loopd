import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { promises as fs } from "fs"
import path from "path"
import os from "os"
import { createGoalService } from "../../src/application/goal-service"
import { createFakeHost } from "../../src/server/host-adapter"
import { ownerTools } from "../../src/server/owner-tools"

function tmpDir(): string {
  return path.join(os.tmpdir(), `loopd-inspect-test-${crypto.randomUUID()}`)
}

describe("inspect_background_goal fallback", () => {
  let dir: string

  beforeEach(async () => {
    dir = tmpDir()
    await fs.mkdir(dir, { recursive: true })
  })

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it("says goals live under other sessions instead of a bare no-match", async () => {
    const host = createFakeHost()
    const goalService = createGoalService(host)
    const { goal } = await goalService.start(dir, {
      name: "owned-elsewhere",
      objective: "do something",
      ownerSessionID: "owner-1",
      config: { workspaceWrite: false },
    })
    const tools = ownerTools({ directory: dir, host, goalService })

    const result = await tools.inspect_background_goal.execute({}, { sessionID: "owner-2" } as any)
    const output = JSON.parse(result.output)
    expect(output.ok).toBe(false)
    expect(output.message).toContain("all owned by other sessions")
    expect(output.ownedElsewhereActive).toBe(1)
    expect(output.ownedGoals).toEqual([])
    expect(goal.id).toBeTruthy()
  })

  it("distinguishes an empty workspace from completed goals", async () => {
    const host = createFakeHost()
    const goalService = createGoalService(host)
    const tools = ownerTools({ directory: dir, host, goalService })

    const empty = await tools.inspect_background_goal.execute({}, { sessionID: "owner-9" } as any)
    expect(JSON.parse(empty.output).message).toContain("No goals exist yet")
  })

  it("points at an explicit goal_id when the session owns goals but the ID is wrong", async () => {
    const host = createFakeHost()
    const goalService = createGoalService(host)
    await goalService.start(dir, {
      name: "mine",
      objective: "do something",
      ownerSessionID: "owner-1",
      config: { workspaceWrite: false },
    })
    const tools = ownerTools({ directory: dir, host, goalService })

    const result = await tools.inspect_background_goal.execute(
      { goal_id: "does-not-exist" },
      { sessionID: "owner-1" } as any,
    )
    const output = JSON.parse(result.output)
    expect(output.ok).toBe(false)
    expect(output.message).toContain("pass its goal_id explicitly")
    expect(output.ownedGoals).toHaveLength(1)
  })
})
