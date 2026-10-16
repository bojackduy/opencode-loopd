import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { createFakeHost, type LoopHost } from "../../src/server/host-adapter"
import { createGoalService } from "../../src/application/goal-service"
import { createLoopEngine } from "../../src/application/loop-engine"
import { mutateState, readEvents, readState } from "../../src/infrastructure/state-repository"
import { isOutputlessTurn } from "../../src/domain/message-turn"
import { workerActivityLabel } from "../../src/domain/status-labels"

/** Closed with no finish reason: the silent provider close. */
const DEAD = { time: { completed: 1791983716461 } }
/** Still running: no completed stamp, so never a dead turn. */
const LIVE = { time: { created: 1791983063688 } }
/** Real completion, including the tool-call step finish. */
const STOPPED = { time: { completed: 1791983716461 }, finish: "stop" }

let dir: string
let host: LoopHost
let goals: ReturnType<typeof createGoalService>
let engine: ReturnType<typeof createLoopEngine>
/** Legacy transport: no native projection, so transcript events are the path. */
function useLegacyHost() { delete (host as { readExecution?: unknown }).readExecution }
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "loopd-outputless-"))
  host = createFakeHost({ autoCompletePrompts: false })
  goals = createGoalService(host)
})
afterEach(async () => { engine?.stop(); await fs.rm(dir, { recursive: true, force: true }) })

async function start() {
  const { goal } = await goals.start(dir, {
    name: "quota-dead-turn",
    objective: "verify outputless turn handling",
    ownerSessionID: "parent",
    config: { workspaceWrite: false, maxFailures: 3 },
  })
  useLegacyHost()
  engine = createLoopEngine({ directory: dir, host, goalService: goals, pollIntervalMs: 60_000, confirmIdleMs: 0 })
  engine.start()
  return goal
}
/** Idle debounce: the first signals stage, activity vetoes, then it confirms. */
async function idleX(goal: any, times = 4) {
  for (let i = 0; i < times; i++) {
    await engine.handleEvent({ type: "session.idle", properties: { sessionID: goal.workerSessionID } })
  }
}
/** An assistant message correlated to the CURRENT turn of the goal. */
async function assistantEvent(goal: any, info: Record<string, unknown>) {
  const prompt = (await readState(dir)).runtimes.find((r) => r.goalID === goal.id)?.activePromptMessageID
  return {
    type: "message.updated",
    properties: { info: { role: "assistant", sessionID: goal.workerSessionID, parentID: prompt, ...info } },
  }
}
async function waitFor(test: () => Promise<boolean>) {
  const deadline = Date.now() + 3000
  while (!await test()) { if (Date.now() >= deadline) throw new Error("timed out"); await Bun.sleep(10) }
}

describe("isOutputlessTurn predicate", () => {
  it("matches only a closed turn that produced no output", () => {
    expect(isOutputlessTurn(DEAD)).toBe(true)
    expect(isOutputlessTurn({ completedAt: new Date(DEAD.time.completed).toISOString(), content: "" })).toBe(true)
    expect(isOutputlessTurn({ completedAt: new Date(DEAD.time.completed).toISOString(), content: "Actual response" })).toBe(false)
    expect(isOutputlessTurn({ ...DEAD, parts: [{ type: "tool" }] })).toBe(false)
    expect(isOutputlessTurn({ ...DEAD, error: { message: "provider error" } })).toBe(false)
    expect(isOutputlessTurn(LIVE)).toBe(false)
    expect(isOutputlessTurn(STOPPED)).toBe(false)
    expect(isOutputlessTurn(undefined)).toBe(false)
  })
})

describe("outputless turn recovery", () => {
  it("records a bounded failure instead of anchoring a silent turn as done", async () => {
    const goal = await start()
    const before = (await readState(dir)).runtimes[0]
    expect(await engine.handleEvent(await assistantEvent(goal, { id: "msg_dead", ...DEAD }))).toBe(true)
    const state = await readState(dir)
    expect(state.runtimes[0].consecutiveFailures).toBe(1)
    expect(state.runtimes[0].phase).toBe("waiting_retry")
    expect(state.runtimes[0].lastError).toContain("no output")
    expect(state.runtimes[0].activeAssistantCompletedAt).toBeUndefined()
    expect(state.runtimes[0].activePromptMessageID).toBeUndefined()
    expect(state.runtimes[0].activeRunID).toBeUndefined()
    expect(state.goals[0].status).toBe("active")
    expect(state.runtimes[0].retryAfter).toBeDefined()
    const failed = (await readEvents(dir, 50)).filter((e: any) => e.goalID === goal.id && e.type === "run.failed")
    expect(failed).toHaveLength(1)
    expect(failed[0].error).toContain("no output")
    expect(failed[0].consecutiveFailures).toBe(1)
  })

  it("blocks through the bounded retry policy after repeated dead turns", async () => {
    const goal = await start()
    for (let i = 0; i < 3; i++) {
      if (i > 0) await goals.continueTurn(dir, goal.id, { forceFinish: false })
      await engine.handleEvent(await assistantEvent(goal, { id: `msg_dead_${i}`, ...DEAD }))
    }
    const state = await readState(dir)
    expect(state.runtimes[0].consecutiveFailures).toBe(3)
    expect(state.goals[0].status).toBe("blocked")
    expect(state.goals[0].blocker?.reason).toContain("no output")
    expect(((host.sessions as any).notifications ?? [])).toHaveLength(1)
  })

  it("never treats an in-flight or genuinely completed turn as a failure", async () => {
    const goal = await start()
    expect(await engine.handleEvent(await assistantEvent(goal, { id: "msg_live", ...LIVE }))).toBe(true)
    expect((await readState(dir)).runtimes[0].consecutiveFailures).toBe(0)
    await engine.handleEvent(await assistantEvent(goal, { id: "msg_stop", ...STOPPED }))
    await idleX(goal)
    expect((await readState(dir)).runtimes[0].consecutiveFailures).toBe(0)
    expect(host.promptCalls).toHaveLength(2)
  })

  it("does not fire for a superseded turn that no longer owns the prompt", async () => {
    const goal = await start()
    const stalePrompt = (await readState(dir)).runtimes[0].activePromptMessageID
    await mutateState(dir, "supersede", async (s) => {
      const rt = s.runtimes[0]
      rt.runGeneration++
      rt.activePromptMessageID = "msg_newer_prompt"
      return s
    })
    expect(await engine.handleEvent({
      type: "message.updated",
      properties: { info: { role: "assistant", sessionID: goal.workerSessionID, id: "msg_stale", parentID: stalePrompt, ...DEAD } },
    })).toBe(false)
    expect((await readState(dir)).runtimes[0].consecutiveFailures).toBe(0)
  })

  it("labels a retrying worker as Retrying, not Unconfirmed", async () => {
    const goal = await start()
    await engine.handleEvent(await assistantEvent(goal, { id: "msg_dead", ...DEAD }))
    expect(workerActivityLabel({ phase: "running", lastWorkerStatus: "retry" } as never).short).toBe("Retrying")
    expect(workerActivityLabel({
      phase: "running", lastWorkerStatus: "busy", activePromptObservedAt: new Date().toISOString(),
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(), activeAssistantMessageID: "msg_busy",
    } as never).short).toBe("Running")
    expect(workerActivityLabel({ phase: "idle" } as never).short).not.toBe("Retrying")
  })
})

describe("outputless turns on a native host", () => {
  it("leaves the dead transcript to the native projection instead of double-counting it", async () => {
    const goal = await start()
    // Restore the native projection: message events are the host's authority.
    const native = createFakeHost({ autoCompletePrompts: false })
    host.readExecution = native.readExecution
    host.enqueueWorkerMessage = native.enqueueWorkerMessage
    await idleX(goal)
    const state = await readState(dir)
    expect(state.runtimes[0].consecutiveFailures).toBe(0)
    expect(host.promptCalls).toHaveLength(1)
  })
})

describe("outputless turn reconciliation when the live event is missed", () => {
  it("recovers a wedge from the public transcript instead of confirming a dead turn", async () => {
    const goal = await start()
    const prompt = (await readState(dir)).runtimes[0].activePromptMessageID!
    host.readMessages = async () => [
      { role: "user", messageID: prompt, timestamp: new Date().toISOString() },
      { role: "assistant", content: "", messageID: "msg_dead", parentMessageID: prompt, createdAt: new Date().toISOString(), completedAt: new Date(DEAD.time.completed).toISOString() },
    ]
    await idleX(goal)
    await waitFor(async () => (await readState(dir)).runtimes[0].consecutiveFailures === 1)
    const runtime = (await readState(dir)).runtimes[0]
    expect(runtime.phase).toBe("waiting_retry")
    expect(runtime.lastError).toContain("no output")
    expect(runtime.activePromptMessageID).toBeUndefined()
    expect(host.promptCalls).toHaveLength(1)
  })

  it("does not report an outputless close as work in progress", async () => {
    const goal = await start()
    const prompt = (await readState(dir)).runtimes[0].activePromptMessageID!
    host.readMessages = async () => [
      { role: "user", messageID: prompt, timestamp: new Date().toISOString() },
      { role: "assistant", content: "", messageID: "msg_dead", parentMessageID: prompt, createdAt: new Date().toISOString(), completedAt: new Date(DEAD.time.completed).toISOString() },
    ]
    await idleX(goal)
    await waitFor(async () => (await readState(dir)).runtimes[0].phase === "waiting_retry")
    expect(host.promptCalls).toHaveLength(1)
  })
})
