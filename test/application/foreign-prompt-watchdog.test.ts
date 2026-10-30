import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createLoopEngine } from "../../src/application/loop-engine"
import { createGoalService } from "../../src/application/goal-service"
import { createFakeHost } from "../../src/server/host-adapter"
import { createGoal, type GoalID } from "../../src/domain/goal"
import { createRuntimeState } from "../../src/domain/runtime"
import { mutateState, readState } from "../../src/infrastructure/state-repository"

function tmpDir(): string {
  return path.join(os.tmpdir(), `loopd-foreign-prompt-${crypto.randomUUID()}`)
}

async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 8000): Promise<void> {
  const start = Date.now()
  for (;;) {
    if (await cond()) return
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition")
    await new Promise((r) => setTimeout(r, 25))
  }
}

const QUIET_AGO = new Date(Date.now() - 20 * 60_000).toISOString()

async function seedStalledGoal(dir: string, name: string): Promise<GoalID> {
  const id = `goal-${crypto.randomUUID().slice(0, 8)}` as GoalID
  await mutateState(dir, "test.seed", async (state) => {
    state.goals.push(
      createGoal({
        id,
        name,
        objective: "test",
        status: "active",
        ownerSessionID: "owner-1",
        workerSessionID: "worker-1",
        config: { workspaceWrite: false },
      }),
    )
    const rt = createRuntimeState(id)
    rt.phase = "running"
    rt.runCount = 1
    rt.activeRunID = "run-1"
    rt.activePromptMessageID = "msg_ours"
    rt.turnStartedAt = QUIET_AGO
    rt.lastActivityAt = QUIET_AGO
    rt.leaseExpiresAt = new Date(Date.now() - 60_000).toISOString()
    state.runtimes.push(rt)
    return state
  })
  return id
}

describe("foreign-prompt watchdog (native maintenance path)", () => {
  let dir: string
  let engine: ReturnType<typeof createLoopEngine> | undefined
  const notified: Array<{ owner: string; message: string }> = []

  async function startEngine(readExecution: () => Promise<any>): Promise<void> {
    const fake = createFakeHost()
    const origNotify = fake.notifyOwner.bind(fake)
    const host: any = {
      ...fake,
      notifyOwner: async (ownerSessionID: string, message: string, agent?: string) => {
        notified.push({ owner: ownerSessionID, message })
        return origNotify(ownerSessionID, message, agent)
      },
      readExecution,
    }
    const goalService = createGoalService(host)
    engine = createLoopEngine({ directory: dir, host, goalService, pollIntervalMs: 20, confirmIdleMs: 0 })
    engine.start()
  }

  beforeEach(async () => {
    dir = tmpDir()
    await fs.mkdir(dir, { recursive: true })
    notified.length = 0
  })

  afterEach(async () => {
    engine?.stop()
    engine = undefined
    await fs.rm(dir, { recursive: true, force: true })
  })

  it("notifies once when a running turn is foreign-prompt-blocked past the stuck threshold", async () => {
    const id = await seedStalledGoal(dir, "stalled")
    await startEngine(async () => ({
      status: "idle",
      idleAt: new Date().toISOString(),
      latestUserMessageID: "msg_someone-else",
      deliveredMessageIDs: [],
    }))
    await waitFor(() => notified.some((n) => /not this turn's prompt/.test(n.message)))
    expect(notified.filter((n) => /not this turn's prompt/.test(n.message))).toHaveLength(1)
    const state = await readState(dir)
    expect(state.runtimes.find((r) => r.goalID === id)?.foreignPromptNotifiedRunID).toBe("run-1")
    // No duplicate on subsequent passes.
    await new Promise((r) => setTimeout(r, 300))
    expect(notified.filter((n) => /not this turn's prompt/.test(n.message))).toHaveLength(1)
    // Goal stays active — notify-only, never auto re-prompt or block.
    expect(state.goals.find((g) => g.id === id)?.status).toBe("active")
  })

  it("stays silent while the worker is legitimately busy", async () => {
    await seedStalledGoal(dir, "busy-worker")
    await startEngine(async () => ({ status: "busy" }))
    await new Promise((r) => setTimeout(r, 400))
    expect(notified).toHaveLength(0)
    const state = await readState(dir)
    expect(state.runtimes[0]?.foreignPromptNotifiedRunID).toBeUndefined()
  })
})
