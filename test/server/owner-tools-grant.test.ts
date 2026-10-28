import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createGoal, type GoalID } from "../../src/domain/goal"
import { createRuntimeState } from "../../src/domain/runtime"
import { mutateState, readState } from "../../src/infrastructure/state-repository"
import { createGoalService } from "../../src/application/goal-service"
import { createFakeHost } from "../../src/server/host-adapter"
import { ownerTools } from "../../src/server/owner-tools"

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))) })

async function seedGoal(root: string, opts: { owner?: string; worker?: string; status?: "active" | "paused" } = {}) {
  await mutateState(root, "fixture", async (state) => {
    const id = "goal-1" as GoalID
    state.goals.push(createGoal({
      id,
      name: "scoped",
      objective: "test",
      status: opts.status ?? "active",
      ownerSessionID: opts.owner ?? "owner-1",
      workerSessionID: opts.worker ?? "worker-1",
      config: { workspaceWrite: true, write_scope: [] },
    }))
    const runtime = createRuntimeState(id)
    runtime.runGeneration = 1
    state.runtimes.push(runtime)
    return state
  })
}

function tar(root: string) {
  return {
    directory: root,
    host: createFakeHost(),
    goalService: createGoalService(createFakeHost()),
  }
}

const spec = (overrides: Record<string, unknown> = {}) => ({
  name: "pack",
  command: "tar",
  args: ["-czf", "out.tar.zst", "."],
  cwd: ".",
  kind: "finite",
  ...overrides,
})

describe("grant_approved_command (mid-goal owner grant)", () => {
  let root: string
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "loopd-grant-"))
    roots.push(root)
    await seedGoal(root)
  })

  it("owner grants a finite command; worker sees it in config", async () => {
    const { directory, host, goalService } = tar(root)
    const r = await goalService.grantApprovedCommand(directory, "owner-1", "goal-1" as GoalID, spec())
    expect(r.ok).toBe(true)
    expect(r.spec).toMatchObject({ name: "pack", kind: "finite" })
    const state = await readState(root)
    expect(state.goals[0]!.config.approvedCommands).toHaveLength(1)
  })

  it("non-owner and worker sessions cannot self-grant", async () => {
    const { directory, host, goalService } = tar(root)
    expect((await goalService.grantApprovedCommand(directory, "owner-2", "goal-1" as GoalID, spec())).ok).toBe(false)
    expect((await goalService.grantApprovedCommand(directory, "worker-1", "goal-1" as GoalID, spec())).ok).toBe(false)
    expect((await readState(root)).goals[0]!.config.approvedCommands ?? []).toHaveLength(0)
  })

  it("duplicate names and invalid specs are refused", async () => {
    const { directory, host, goalService } = tar(root)
    expect((await goalService.grantApprovedCommand(directory, "owner-1", "goal-1" as GoalID, spec())).ok).toBe(true)
    const dup = await goalService.grantApprovedCommand(directory, "owner-1", "goal-1" as GoalID, spec())
    expect(dup.ok).toBe(false)
    expect(dup.message).toMatch(/already exists/)
    const bad = await goalService.grantApprovedCommand(directory, "owner-1", "goal-1" as GoalID, spec({ cwd: "/abs" }))
    expect(bad.ok).toBe(false)
    expect((await readState(root)).goals[0]!.config.approvedCommands).toHaveLength(1)
  })

  it("refuses on non-active goals and missing goals", async () => {
    const { directory, host, goalService } = tar(root)
    await mutateState(root, "pause", async (s) => {
      s.goals[0]!.status = "paused"
      return s
    })
    expect((await goalService.grantApprovedCommand(directory, "owner-1", "goal-1" as GoalID, spec())).ok).toBe(false)
    expect((await goalService.grantApprovedCommand(directory, "owner-1", "nope" as GoalID, spec())).ok).toBe(false)
  })

  it("owner tool path grants with session ownership", async () => {
    const { directory, host, goalService } = tar(root)
    const tools = ownerTools({ directory, host, goalService })
    const ok = JSON.parse((await tools.grant_approved_command.execute(
      { goal_id: "goal-1", ...spec() },
      { sessionID: "owner-1" } as never,
    )).output)
    expect(ok.ok).toBe(true)
    const denied = JSON.parse((await tools.grant_approved_command.execute(
      { goal_id: "goal-1", ...spec({ name: "pack2" }) },
      { sessionID: "intruder" } as never,
    )).output)
    expect(denied.ok).toBe(false)
  })
})
