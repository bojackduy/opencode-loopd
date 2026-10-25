import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { promises as fs } from "fs"
import os from "os"
import path from "path"
import { createControlClient } from "../../src/infrastructure/control-client"
import { createControlWorker } from "../../src/application/control-worker"
import { mutateState, readState } from "../../src/infrastructure/state-repository"
import { createFakeHost } from "../../src/server/host-adapter"
import { createGoalService } from "../../src/application/goal-service"
import { createGoal, type GoalID } from "../../src/domain/goal"
import { createRuntimeState } from "../../src/domain/runtime"
import { beforeWorkspaceTool } from "../../src/application/workspace-execution"

const OWNER = "owner-main"
const WORKER = "worker-1"

/**
 * Real state fixture. `orphan-call` outlived its goal (releasable but still a
 * live fence), `own-call` belongs to the owner's own session, and `live-call`
 * belongs to a foreign goal whose worker may be mid-write (refused).
 */
async function seed(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "loopd-release-"))
  await mutateState(dir, "seed", async (state) => {
    state.goals = [
      createGoal({
        id: "goal-1" as GoalID,
        name: "scoped",
        objective: "test",
        status: "active",
        ownerSessionID: OWNER,
        workerSessionID: WORKER,
        config: { workspaceWrite: true, write_scope: ["src/a.ts"] },
      }),
      createGoal({
        id: "goal-2" as GoalID,
        name: "foreign",
        objective: "test",
        status: "active",
        ownerSessionID: "owner-2",
        workerSessionID: "worker-2",
        config: { workspaceWrite: true, write_scope: ["src/b.ts"] },
      }),
    ]
    state.runtimes = [createRuntimeState("goal-1" as GoalID), createRuntimeState("goal-2" as GoalID)]
    const now = new Date().toISOString()
    state.workspaceCalls = [
      { callID: "orphan-call", sessionID: "gone-session", goalID: "deleted-goal", generation: 1, paths: ["src/a.ts"], at: now },
      { callID: "own-call", sessionID: OWNER, paths: [], uncontrolled: true, at: now },
      { callID: "live-call", sessionID: "worker-2", goalID: "goal-2", generation: 1, paths: ["src/b.ts"], at: now },
    ]
    return state
  })
  return dir
}

describe("release_workspace control command", () => {
  let dir: string
  let client: ReturnType<typeof createControlClient>
  let worker: ReturnType<typeof createControlWorker>

  beforeEach(async () => {
    dir = await seed()
    client = createControlClient(dir)
    worker = createControlWorker({
      directory: dir,
      goalService: createGoalService(createFakeHost()),
      pollIntervalMs: 20,
    })
    worker.start()
  })

  afterEach(async () => {
    await worker.stop()
    await fs.rm(dir, { recursive: true, force: true })
  })

  const release = (args: Record<string, unknown>, goalID?: string) =>
    client.execute({
      version: 1,
      requestID: crypto.randomUUID(),
      requestedAt: new Date().toISOString(),
      command: "release_workspace",
      goalID,
      args: args as never,
    })

  it("no selector inspects and returns the agent tool's reservation report", async () => {
    const r = await release({ ownerSessionID: OWNER })
    expect(r.ok).toBe(true)
    expect(r.message).toContain("3 workspace reservation(s)")
    expect(r.message).toContain("orphan-call")
    expect(r.message).toContain("releasable")
    expect(r.message).toContain("refused")

    const data = (r as any).data
    expect(data.reservations.map((item: any) => item.callID)).toEqual(["orphan-call", "own-call", "live-call"])
    expect(data.reservations.find((item: any) => item.callID === "orphan-call")).toMatchObject({
      releasable: true,
      goalID: "deleted-goal",
      paths: ["src/a.ts"],
    })
    expect(data.reservations.find((item: any) => item.callID === "own-call")).toMatchObject({ releasable: true })
    expect(data.reservations.find((item: any) => item.callID === "live-call")).toMatchObject({ releasable: false })
    expect(data.reservations.find((item: any) => item.callID === "live-call").reason).toContain("still the worker")
  })

  it("releases only the named reservation", async () => {
    const r = await release({ ownerSessionID: OWNER, callID: "orphan-call" })
    expect(r.ok).toBe(true)
    expect(r.message).toContain("Released 1")

    const state = await readState(dir)
    expect(state.workspaceCalls?.map((call) => call.callID)).toEqual(["own-call", "live-call"])
    expect((r as any).data.remaining.reservations.map((item: any) => item.callID)).toEqual(["own-call", "live-call"])
  })

  it("refuses a live foreign goal's reservation and reports the reason", async () => {
    const r = await release({ ownerSessionID: OWNER, callID: "live-call" })
    expect(r.ok).toBe(false)
    expect(r.errorCode).toBe("release_refused")
    expect(r.message).toContain("Refusing to release")
    expect(r.message).toContain("still the worker of a non-terminal goal")

    expect((await readState(dir)).workspaceCalls?.map((call) => call.callID)).toContain("live-call")
  })

  it("fails closed without an owner session and on an unmatched selector", async () => {
    const noOwner = await release({})
    expect(noOwner.ok).toBe(false)
    expect(noOwner.errorCode).toBe("no_session")
    expect(noOwner.message).toContain("ownerSessionID")

    const noMatch = await release({ ownerSessionID: OWNER, callID: "nope" })
    expect(noMatch.ok).toBe(false)
    expect(noMatch.message).toContain("No workspace reservation matches")
  })

  it("release from the dashboard path clears the fence so a subsequent worker write passes", async () => {
    const write = () =>
      beforeWorkspaceTool(
        dir,
        { tool: "write", sessionID: WORKER, callID: "write-1" },
        { path: "src/a.ts", content: "x" },
      )

    // A foreign uncontrolled call fences every structured write first.
    await expect(write()).rejects.toThrow(/uncontrolled tool call own-call/)
    expect((await release({ ownerSessionID: OWNER, callID: "own-call" })).ok).toBe(true)

    // Then the dead session's path reservation is the remaining blocker.
    await expect(write()).rejects.toThrow(/being written by session gone-session, call orphan-call/)
    expect((await release({ ownerSessionID: OWNER, callID: "orphan-call" })).ok).toBe(true)

    await expect(write()).resolves.toBeUndefined()
  })
})
