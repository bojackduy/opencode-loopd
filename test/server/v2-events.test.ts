import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { promises as fs } from "fs"
import path from "path"
import os from "os"
import { normalizeV2Event } from "../../src/server/plugin"
import { createLoopEngine } from "../../src/application/loop-engine"
import { createGoalService } from "../../src/application/goal-service"
import { createFakeHost } from "../../src/server/host-adapter"
import { readState } from "../../src/infrastructure/state-repository"

function tmpDir(): string {
  return path.join(os.tmpdir(), `loopd-v2events-test-${crypto.randomUUID()}`)
}

describe("v2 event normalization", () => {
  it("maps inbox.delivered to an observed user prompt with the prompt ID", () => {
    const normalized = normalizeV2Event({
      type: "session.inbox.delivered",
      data: { sessionID: "worker-1", inboxID: "msg_abc" },
    })
    expect(normalized).toEqual({
      type: "message.updated",
      properties: { sessionID: "worker-1", info: { role: "user", id: "msg_abc" } },
    })
  })

  it("passes execution.succeeded through with the session ID", () => {
    const normalized = normalizeV2Event({
      type: "session.execution.succeeded",
      data: { sessionID: "worker-1" },
    })
    expect(normalized).toEqual({
      type: "session.execution.succeeded",
      properties: { sessionID: "worker-1" },
    })
  })
})

describe("v2 delivery/completion correlation", () => {
  let dir: string
  let host: ReturnType<typeof createFakeHost>
  let goalService: ReturnType<typeof createGoalService>
  let engine: ReturnType<typeof createLoopEngine>

  beforeEach(async () => {
    dir = tmpDir()
    await fs.mkdir(dir, { recursive: true })
    host = createFakeHost()
    goalService = createGoalService(host)
    engine = createLoopEngine({ directory: dir, host, goalService, pollIntervalMs: 100, confirmIdleMs: 0 })
    engine.start()
  })

  afterEach(async () => {
    engine.stop()
    await fs.rm(dir, { recursive: true, force: true })
  })

  it("delivery confirmation observes the active prompt", async () => {
    const { goal } = await goalService.start(dir, {
      name: "delivery",
      objective: "do something",
      ownerSessionID: "owner-1",
      config: { workspaceWrite: false },
    })
    await engine.preloadWorkerSessions()
    const promptID = (await readState(dir)).runtimes[0].activePromptMessageID!

    const result = await engine.handleEvent(
      normalizeV2Event({ type: "session.inbox.delivered", data: { sessionID: goal.workerSessionID, inboxID: promptID } }),
    )
    expect(result).toBe(true)
    const runtime = (await readState(dir)).runtimes[0]
    expect(runtime.activePromptObservedAt).toBeTruthy()
  })

  it("execution.succeeded stamps the turn completion anchor", async () => {
    const { goal } = await goalService.start(dir, {
      name: "completion",
      objective: "do something",
      ownerSessionID: "owner-1",
      config: { workspaceWrite: false },
    })
    await engine.preloadWorkerSessions()

    const result = await engine.handleEvent({
      type: "session.execution.succeeded",
      properties: { sessionID: goal.workerSessionID },
    })
    expect(result).toBe(true)
    const runtime = (await readState(dir)).runtimes[0]
    expect(runtime.activeAssistantCompletedAt).toBeTruthy()
  })

  it("full turn correlates: persisted ID == delivered ID == transcript IDs", async () => {
    const { goal } = await goalService.start(dir, {
      name: "correlation",
      objective: "do something",
      ownerSessionID: "owner-1",
      config: { workspaceWrite: false },
    })
    const state = await readState(dir)
    const promptID = state.runtimes[0].activePromptMessageID!
    expect(promptID.startsWith("msg_")).toBe(true)

    const transcript = await host.readMessages(goal.workerSessionID!, 10)
    const userPrompt = transcript.find((m) => m.role === "user")
    expect(userPrompt?.messageID).toBe(promptID)
    const assistant = transcript.find((m) => m.role === "assistant" && m.parentMessageID === promptID)
    expect(assistant).toBeTruthy()
    expect(assistant?.completedAt).toBeTruthy()
  })
})
