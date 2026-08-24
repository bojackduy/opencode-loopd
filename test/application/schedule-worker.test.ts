import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { promises as fs } from "fs"
import path from "path"
import os from "os"
import { randomUUID } from "crypto"
import { readState, mutateState, goalArtifactDir, ensureGoalArtifactDir, appendEvent } from "../../src/infrastructure/state-repository"
import { createGoal } from "../../src/domain/goal"
import { createRuntimeState } from "../../src/domain/runtime"
import { createScheduleWorker } from "../../src/application/schedule-worker"
import { createGoalService } from "../../src/application/goal-service"

function tmpDir() {
  return path.join(os.tmpdir(), `loopd-sched-test-${randomUUID()}`)
}

function mockHost() {
  return {
    createWorker: async () => { throw new Error("not needed") },
    promptWorker: async () => ({}),
    sessionStatus: async () => "idle" as const,
    abortSession: async () => {},
    readMessages: async () => [],
    compactSession: async () => {},
    notifyOwner: async () => {},
  }
}

describe("Schedule Worker — interval requeue", () => {
  let dir: string
  beforeEach(async () => {
    dir = tmpDir()
    await fs.mkdir(dir, { recursive: true })
  })
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  async function createScheduledGoal(opts: { everyMs: number, maxRuns?: number, status?: "complete" | "active", phase?: string, scheduleRunCount?: number, nextRunAt?: string }) {
    const id = randomUUID() as any
    const goal = createGoal({
      id,
      name: "sched-test",
      objective: "append tick",
      status: opts.status ?? "complete",
      ownerSessionID: "owner1",
      config: {
        maxTurns: 10,
        workspaceWrite: false,
        agent: "smart-agent",
        checks: ["test -f tick.txt"],
        schedule: { everyMs: opts.everyMs, ...(opts.maxRuns !== undefined ? { maxRuns: opts.maxRuns } : {}) },
        artifactDir: goalArtifactDir(dir, id),
        progressFile: path.join(goalArtifactDir(dir, id), "progress.md"),
        checkCwd: goalArtifactDir(dir, id),
      } as any,
    })
    await ensureGoalArtifactDir(dir, id)
    await mutateState(dir, "create", async (s) => {
      s.goals.push(goal)
      const rt = createRuntimeState(id)
      rt.phase = (opts.phase as any) ?? "idle"
      ;(rt as any).scheduleRunCount = opts.scheduleRunCount ?? 0
      ;(rt as any).nextRunAt = opts.nextRunAt
      s.runtimes.push(rt)
      return s
    })
    await appendEvent(dir, { version: 1, eventID: randomUUID(), goalID: id, type: "goal.created", name: goal.name, objective: goal.objective, ownerSessionID: "owner1", timestamp: new Date().toISOString(), revision: 0 } as any)
    // if status complete, also need to set completion via complete handler simulation — we set nextRunAt manually
    if (opts.status === "complete" && opts.nextRunAt === undefined && opts.scheduleRunCount !== undefined) {
      // mimic completion handler: set nextRunAt if not max
      await mutateState(dir, "complete", async (s) => {
        const r = s.runtimes.find(x => x.goalID === id)
        if (r) {
          const count = (r as any).scheduleRunCount ?? 0
          const max = opts.maxRuns
          const hasMore = typeof max === "number" ? count < max : true
          if (hasMore) (r as any).nextRunAt = new Date(Date.now() - 1000).toISOString() // due
        }
        return s
      })
    }
    return id
  }

  it("resurrects due completed scheduled goal and increments via complete", async () => {
    const host = mockHost()
    const svc = createGoalService(host as any)
    const worker = createScheduleWorker({ directory: dir, goalService: svc, intervalMs: 100 })
    let continued = 0
    svc.continueTurn = async () => { continued++ }

    const id = await createScheduledGoal({ everyMs: 10000, maxRuns: 3, status: "complete", scheduleRunCount: 1, nextRunAt: new Date(Date.now() - 2000).toISOString() })

    const res = await worker.tick()
    expect(res).toBe(1)
    expect(continued).toBe(1)
    const state = await readState(dir)
    const g = state.goals.find(x => x.id === id)!
    expect(g.status).toBe("active")
  })

  it("skip-if-running: does not resurrect while active", async () => {
    const host = mockHost()
    const svc = createGoalService(host as any)
    const worker = createScheduleWorker({ directory: dir, goalService: svc })
    svc.continueTurn = async () => { throw new Error("should not call") }

    const id = await createScheduledGoal({ everyMs: 1000, maxRuns: 3, status: "active", phase: "running", scheduleRunCount: 0, nextRunAt: new Date(Date.now() - 5000).toISOString() })
    // Manually set goal to active (not complete) — schedule should skip because only complete is resurrected
    const res = await worker.tick()
    expect(res).toBe(0)
  })

  it("respects maxRuns", async () => {
    const host = mockHost()
    const svc = createGoalService(host as any)
    const worker = createScheduleWorker({ directory: dir, goalService: svc })
    svc.continueTurn = async () => {}

    const id = await createScheduledGoal({ everyMs: 1000, maxRuns: 2, status: "complete", scheduleRunCount: 2, nextRunAt: new Date(Date.now() - 1000).toISOString() })
    const res = await worker.tick()
    expect(res).toBe(0)
    const state = await readState(dir)
    expect(state.goals.find(x=>x.id===id)!.status).toBe("complete")
  })

  it("skips when writer active and workspaceWrite true", async () => {
    const host = mockHost()
    const svc = createGoalService(host as any)
    const worker = createScheduleWorker({ directory: dir, goalService: svc })
    svc.continueTurn = async () => {}

    // active writer
    const writerId = randomUUID() as any
    const writerGoal = createGoal({ id: writerId, name: "writer", objective: "x", status: "active", ownerSessionID: "owner1", config: { workspaceWrite: true, agent: "smart-agent" } as any })
    await mutateState(dir, "writer", async (s) => {
      s.goals.push(writerGoal)
      const rt = createRuntimeState(writerId)
      rt.phase = "running"
      s.runtimes.push(rt)
      return s
    })

    const id = await createScheduledGoal({ everyMs: 1000, maxRuns: 3, status: "complete", scheduleRunCount: 1, nextRunAt: new Date(Date.now() - 1000).toISOString() })
    // make scheduled goal workspaceWrite true as well
    await mutateState(dir, "make-writer", async (s) => {
      const g = s.goals.find(x=>x.id===id)
      if (g) (g.config as any).workspaceWrite = true
      return s
    })

    const res = await worker.tick()
    expect(res).toBe(0)
  })

  it("allows concurrent artifact-only scheduled while writer active", async () => {
    const host = mockHost()
    const svc = createGoalService(host as any)
    const worker = createScheduleWorker({ directory: dir, goalService: svc })
    let continued = 0
    svc.continueTurn = async () => { continued++ }

    const writerId = randomUUID() as any
    const writerGoal = createGoal({ id: writerId, name: "writer", objective: "x", status: "active", ownerSessionID: "owner1", config: { workspaceWrite: true, agent: "smart-agent" } as any })
    await mutateState(dir, "writer2", async (s) => {
      s.goals.push(writerGoal)
      const rt = createRuntimeState(writerId)
      rt.phase = "running"
      s.runtimes.push(rt)
      return s
    })

    const id = await createScheduledGoal({ everyMs: 1000, maxRuns: 3, status: "complete", scheduleRunCount: 0, nextRunAt: new Date(Date.now() - 1000).toISOString() })
    // artifact-only (workspaceWrite false) is default in helper, so should run concurrently
    const res = await worker.tick()
    expect(res).toBe(1)
    expect(continued).toBe(1)
  })

  it("does not resurrect when nextRunAt in future", async () => {
    const host = mockHost()
    const svc = createGoalService(host as any)
    const worker = createScheduleWorker({ directory: dir, goalService: svc })
    svc.continueTurn = async () => {}

    const id = await createScheduledGoal({ everyMs: 10000, maxRuns: 3, status: "complete", scheduleRunCount: 0, nextRunAt: new Date(Date.now() + 60000).toISOString() })
    const res = await worker.tick()
    expect(res).toBe(0)
  })
})
