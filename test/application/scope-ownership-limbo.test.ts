import { afterEach, describe, expect, it } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { GoalID } from "../../src/domain/goal"
import { mutateState, readState } from "../../src/infrastructure/state-repository"
import { createGoalService } from "../../src/application/goal-service"
import { createFakeHost } from "../../src/server/host-adapter"
import {
  beforeWorkspaceTool,
  afterWorkspaceTool,
  withWorkspaceOperation,
  STALE_WORKSPACE_CALL_TTL_MS,
  CLEAR_PENDING_FORCE_TTL_MS,
} from "../../src/application/workspace-execution"

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))) })

async function emptyRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "loopd-limbo-"))
  roots.push(root)
  return root
}

const HOUR = 60 * 60_000
const oldAt = (ms: number) => new Date(Date.now() - ms).toISOString()

/** A host whose worker sessions are all dead (poweroff simulation). */
function deadHost() {
  return createFakeHost({ sessionStatus: () => "unknown" })
}

async function startScoped(root: string, service: ReturnType<typeof createGoalService>, scope = ["a.ts", "b.ts"]) {
  const { goal } = await service.start(root, {
    name: "scoped",
    objective: "test",
    ownerSessionID: "parent",
    config: { write_scope: scope },
  })
  return goal
}

/** Plant the exact poweroff corpse: paused + scopeClosing + dead old calls. */
async function plantCorpse(root: string, goalID: GoalID, worker: string, callAgeMs: number, calls = 2) {
  await mutateState(root, "plant-corpse", async (state) => {
    const g = state.goals.find((item) => item.id === goalID)!
    g.status = "paused"
    g.scopeClosing = true
    const rt = state.runtimes.find((r) => r.goalID === goalID)
    const gen = rt?.runGeneration ?? 0
    state.workspaceCalls = Array.from({ length: calls }, (_, i) => ({
      callID: `dead-call-${i}`,
      sessionID: worker,
      goalID,
      generation: gen,
      paths: ["a.ts"],
      at: oldAt(callAgeMs),
    }))
    return state
  })
}

describe("scope-ownership limbo (poweroff corpse)", () => {
  it("stale scopeClosing + dead old calls → resume succeeds, fences the old session, rotates generation", async () => {
    const root = await emptyRoot()
    const service = createGoalService(deadHost())
    const goal = await startScoped(root, service)
    const oldWorker = goal.workerSessionID!
    const genBefore = (await readState(root)).runtimes.find((r) => r.goalID === goal.id)!.runGeneration
    await plantCorpse(root, goal.id, oldWorker, 2 * HOUR)

    await service.resume(root, goal.id)

    const state = await readState(root)
    const fresh = state.goals.find((g) => g.id === goal.id)!
    expect(fresh.status).toBe("active")
    expect(fresh.scopeClosing).toBe(false)
    expect(state.workspaceCalls ?? []).toEqual([])
    expect(state.runtimes.find((r) => r.goalID === goal.id)!.runGeneration).toBeGreaterThan(genBefore)
    expect(fresh.workerSessionID).not.toBe(oldWorker)
    // Late executions of the dead session stay fenced.
    await expect(
      beforeWorkspaceTool(root, { tool: "write", sessionID: oldWorker, callID: "late" }, { filePath: "a.ts" }),
    ).rejects.toThrow("retired")
  })

  it("the same stuck corpse → clear succeeds terminally", async () => {
    const root = await emptyRoot()
    const service = createGoalService(deadHost())
    const goal = await startScoped(root, service)
    const oldWorker = goal.workerSessionID!
    await plantCorpse(root, goal.id, oldWorker, 2 * HOUR)

    await service.clear(root, goal.id)

    const state = await readState(root)
    expect(state.goals).toHaveLength(0)
    expect(state.workspaceCalls ?? []).toEqual([])
    expect(state.runtimes).toHaveLength(0)
    await expect(
      beforeWorkspaceTool(root, { tool: "write", sessionID: oldWorker, callID: "late" }, { filePath: "a.ts" }),
    ).rejects.toThrow("retired")
  })

  it("live same-generation call still blocks resume and checks", async () => {
    const root = await emptyRoot()
    const service = createGoalService(createFakeHost())
    const goal = await startScoped(root, service)
    const worker = goal.workerSessionID!
    await beforeWorkspaceTool(root, { tool: "write", sessionID: worker, callID: "live" }, { filePath: "a.ts" })
    await service.pause(root, goal.id)

    await expect(service.resume(root, goal.id)).rejects.toThrow("quiescence")
    await expect(withWorkspaceOperation(root, goal.id, worker, async () => {})).rejects.toThrow("busy")

    await afterWorkspaceTool(root, worker, "live")
    await service.resume(root, goal.id)
    expect((await readState(root)).goals.find((g) => g.id === goal.id)!.status).toBe("active")
  })

  it("retry on a blocked corpse fences and proceeds", async () => {
    const root = await emptyRoot()
    const service = createGoalService(deadHost())
    const goal = await startScoped(root, service)
    const oldWorker = goal.workerSessionID!
    await mutateState(root, "block", async (state) => {
      const g = state.goals.find((item) => item.id === goal.id)!
      g.status = "blocked"
      g.scopeClosing = true
      state.workspaceCalls = [{
        callID: "dead-retry-call",
        sessionID: oldWorker,
        goalID: goal.id,
        generation: state.runtimes.find((r) => r.goalID === goal.id)?.runGeneration ?? 0,
        paths: ["a.ts"],
        at: oldAt(2 * HOUR),
      }]
      return state
    })

    await service.retry(root, goal.id)

    const state = await readState(root)
    expect(state.goals.find((g) => g.id === goal.id)!.status).toBe("active")
    expect(state.workspaceCalls ?? []).toEqual([])
  })

  it("deferred clear tombstone finalizes via sweep once calls are gone; force after the longer TTL", async () => {
    const root = await emptyRoot()
    const service = createGoalService(deadHost())
    const goal = await startScoped(root, service)
    // Legacy tombstone shape (pre-terminal-clear state): paused + clear-pending, no calls.
    await mutateState(root, "plant-tombstone", async (state) => {
      const g = state.goals.find((item) => item.id === goal.id)!
      g.status = "paused"
      g.scopeClearPending = true
      state.workspaceCalls = []
      return state
    })
    await service.reconcile(root)
    expect((await readState(root)).goals).toHaveLength(0)

    // Tombstone WITH a fresh reserved call drains naturally — it is kept.
    const goal2 = await startScoped(root, service)
    const worker2 = goal2.workerSessionID!
    await beforeWorkspaceTool(root, { tool: "write", sessionID: worker2, callID: "drain" }, { filePath: "a.ts" })
    await mutateState(root, "plant-tombstone-2", async (state) => {
      state.goals.find((item) => item.id === goal2.id)!.scopeClearPending = true
      return state
    })
    await service.reconcile(root)
    expect((await readState(root)).goals.map((g) => g.id)).toContain(goal2.id)

    // Past the longer force TTL the tombstone is force-finalized with the calls.
    await mutateState(root, "age-tombstone", async (state) => {
      state.workspaceCalls = (state.workspaceCalls ?? []).map((call) => ({
        ...call,
        at: oldAt(CLEAR_PENDING_FORCE_TTL_MS + HOUR),
      }))
      return state
    })
    await service.reconcile(root)
    const after = await readState(root)
    expect(after.goals.map((g) => g.id)).not.toContain(goal2.id)
    expect((after.workspaceCalls ?? []).filter((c) => c.goalID === goal2.id)).toEqual([])
  })

  it("file locks release after reap: overlapping scope becomes startable", async () => {
    const root = await emptyRoot()
    const service = createGoalService(deadHost())
    const goal = await startScoped(root, service, ["b.ts"])
    const oldWorker = goal.workerSessionID!
    await plantCorpse(root, goal.id, oldWorker, 2 * HOUR)

    // Before the sweep the dead reservation still holds the file.
    await expect(service.start(root, {
      name: "overlap",
      objective: "test",
      ownerSessionID: "parent",
      config: { write_scope: ["b.ts"] },
    })).rejects.toThrow("b.ts")

    await service.reconcile(root)

    const created = await service.start(root, {
      name: "overlap",
      objective: "test",
      ownerSessionID: "parent",
      config: { write_scope: ["b.ts"] },
    })
    expect(created.goal.config.write_scope).toEqual(["b.ts"])
  })

  it("owner long-build reservation preserved while fresh, reaped when ancient", async () => {
    const root = await emptyRoot()
    // No goals: owner shell reserves as an uncontrolled owner-session call.
    await beforeWorkspaceTool(root, { tool: "bash", sessionID: "owner", callID: "build" }, { command: "sleep 3600" })
    const fresh = await readState(root)
    expect(fresh.workspaceCalls).toHaveLength(1)
    expect(fresh.workspaceCalls![0]!.goalID).toBeUndefined()

    // Sweep keeps it while fresh — checks stay fenced.
    await createGoalService(deadHost()).reconcile(root)
    expect((await readState(root)).workspaceCalls).toHaveLength(1)
    await expect(withWorkspaceOperation(root, "any" as GoalID, "owner", async () => {})).rejects.toThrow("busy")

    // Ancient owner reservation is reaped; checks proceed.
    await mutateState(root, "age-owner-call", async (state) => {
      state.workspaceCalls = (state.workspaceCalls ?? []).map((call) => ({ ...call, at: oldAt(2 * HOUR) }))
      return state
    })
    await createGoalService(deadHost()).reconcile(root)
    expect((await readState(root)).workspaceCalls ?? []).toEqual([])
    await withWorkspaceOperation(root, "any" as GoalID, "owner", async () => {})
  })

  it("restart reconstruction is safe: reconcile heals the corpse, then resume works", async () => {
    const root = await emptyRoot()
    const first = createGoalService(deadHost())
    const goal = await startScoped(root, first)
    const oldWorker = goal.workerSessionID!
    await plantCorpse(root, goal.id, oldWorker, 2 * HOUR)

    // "Restart": a brand-new service instance reconciles from disk.
    const restarted = createGoalService(deadHost())
    await restarted.reconcile(root)
    const healed = await readState(root)
    expect(healed.goals.find((g) => g.id === goal.id)!.scopeClosing).toBe(false)
    expect(healed.workspaceCalls ?? []).toEqual([])

    await restarted.resume(root, goal.id)
    expect((await readState(root)).goals.find((g) => g.id === goal.id)!.status).toBe("active")
  })

  it("reservations stamp generation whenever a runtime exists; superseded generations reap even when fresh", async () => {
    const root = await emptyRoot()
    const service = createGoalService(createFakeHost())
    const goal = await startScoped(root, service)
    const worker = goal.workerSessionID!
    const gen = (await readState(root)).runtimes.find((r) => r.goalID === goal.id)!.runGeneration

    await beforeWorkspaceTool(root, { tool: "write", sessionID: worker, callID: "stamped" }, { filePath: "a.ts" })
    const stamped = (await readState(root)).workspaceCalls!.find((c) => c.callID === "stamped")!
    expect(typeof stamped.generation).toBe("number")
    expect(stamped.generation).toBe(gen)
    await afterWorkspaceTool(root, worker, "stamped")

    // A fresh call from a superseded generation is dead on arrival.
    await mutateState(root, "bump", async (state) => {
      state.runtimes.find((r) => r.goalID === goal.id)!.runGeneration = gen + 1
      state.workspaceCalls = [{
        callID: "superseded",
        sessionID: worker,
        goalID: goal.id,
        generation: gen,
        paths: ["a.ts"],
        at: new Date().toISOString(),
      }]
      return state
    })
    await service.reconcile(root)
    expect((await readState(root)).workspaceCalls ?? []).toEqual([])
  })

  it("call TTL is conservative: a reservation just under the TTL with a live worker is kept", async () => {
    const root = await emptyRoot()
    const service = createGoalService(createFakeHost())
    const goal = await startScoped(root, service)
    const worker = goal.workerSessionID!
    await beforeWorkspaceTool(root, { tool: "write", sessionID: worker, callID: "fresh" }, { filePath: "a.ts" })
    await mutateState(root, "near-ttl", async (state) => {
      state.workspaceCalls = (state.workspaceCalls ?? []).map((call) => ({
        ...call,
        at: oldAt(STALE_WORKSPACE_CALL_TTL_MS - 60_000),
      }))
      return state
    })
    await service.reconcile(root)
    // Sync reconcile has no liveness proof and must not reap near-TTL calls.
    expect((await readState(root)).workspaceCalls).toHaveLength(1)
    await afterWorkspaceTool(root, worker, "fresh")
  })
})
