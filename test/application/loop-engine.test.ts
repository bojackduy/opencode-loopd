import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { promises as fs } from "fs"
import path from "path"
import os from "os"
import { createLoopEngine } from "../../src/application/loop-engine"
import { createGoalService } from "../../src/application/goal-service"
import { createFakeHost } from "../../src/server/host-adapter"
import { readState } from "../../src/infrastructure/state-repository"
import type { GoalID } from "../../src/domain/goal"

function tmpDir(): string {
  return path.join(os.tmpdir(), `loopd-engine-test-${crypto.randomUUID()}`)
}

describe("Loop Engine", () => {
  let dir: string
  let host: ReturnType<typeof createFakeHost>
  let goalService: ReturnType<typeof createGoalService>
  let engine: ReturnType<typeof createLoopEngine>

  beforeEach(async () => {
    dir = tmpDir()
    await fs.mkdir(dir, { recursive: true })
    host = createFakeHost()
    goalService = createGoalService(host)
    engine = createLoopEngine({
      directory: dir,
      host,
      goalService,
      pollIntervalMs: 100,
    })
    engine.start()
  })

  afterEach(async () => {
    engine.stop()
    await fs.rm(dir, { recursive: true, force: true })
  })

  describe("handleEvent", () => {
    it("ignores events without session ID", async () => {
      const result = await engine.handleEvent({ type: "session.idle" })
      expect(result).toBe(false)
    })

    it("ignores events for unknown sessions", async () => {
      const result = await engine.handleEvent({
        type: "session.idle",
        properties: { sessionID: "unknown-session" },
      })
      expect(result).toBe(false)
    })

    it("handles session.idle for active goal", async () => {
      // Create a goal with a worker
      const { goal } = await goalService.start(dir, {
        name: "test",
        objective: "do something",
        ownerSessionID: "owner-1",
      })

      // Preload worker sessions into engine cache
      await engine.preloadWorkerSessions()

      // Simulate session.idle event
      const result = await engine.handleEvent({
        type: "session.idle",
        properties: { sessionID: goal.workerSessionID },
      })

      expect(result).toBe(true)
    })

    it("ignores session.idle for paused goal", async () => {
      const { goal } = await goalService.start(dir, {
        name: "test",
        objective: "do something",
        ownerSessionID: "owner-1",
      })

      await goalService.pause(dir, goal.id)

      const result = await engine.handleEvent({
        type: "session.idle",
        properties: { sessionID: goal.workerSessionID },
      })

      expect(result).toBe(false)
    })

    it("handles session.error and increments failures", async () => {
      const { goal } = await goalService.start(dir, {
        name: "test",
        objective: "do something",
        ownerSessionID: "owner-1",
      })

      const result = await engine.handleEvent({
        type: "session.error",
        properties: {
          sessionID: goal.workerSessionID,
          error: { message: "test error" },
        },
      })

      expect(result).toBe(true)

      const state = await readState(dir)
      const runtime = state.runtimes.find((r) => r.goalID === goal.id)
      expect(runtime?.consecutiveFailures).toBe(1)
      expect(runtime?.lastError).toBe("test error")
    })

    it("blocks goal after max failures", async () => {
      const { goal } = await goalService.start(dir, {
        name: "test",
        objective: "do something",
        ownerSessionID: "owner-1",
        config: { maxFailures: 2 },
      })

      // First failure
      await engine.handleEvent({
        type: "session.error",
        properties: {
          sessionID: goal.workerSessionID,
          error: { message: "error 1" },
        },
      })

      // Second failure
      await engine.handleEvent({
        type: "session.error",
        properties: {
          sessionID: goal.workerSessionID,
          error: { message: "error 2" },
        },
      })

      const state = await readState(dir)
      expect(state.goals[0].status).toBe("blocked")
    })

    it("handles session.compacted", async () => {
      const { goal } = await goalService.start(dir, {
        name: "test",
        objective: "do something",
        ownerSessionID: "owner-1",
      })

      const result = await engine.handleEvent({
        type: "session.compacted",
        properties: { sessionID: goal.workerSessionID },
      })

      expect(result).toBe(true)

      const state = await readState(dir)
      const runtime = state.runtimes.find((r) => r.goalID === goal.id)
      expect(runtime?.lastCompactAt).toBeTruthy()
    })

    it("handles session.status updates", async () => {
      const { goal } = await goalService.start(dir, {
        name: "test",
        objective: "do something",
        ownerSessionID: "owner-1",
      })

      const result = await engine.handleEvent({
        type: "session.status",
        properties: {
          sessionID: goal.workerSessionID,
          status: { type: "busy" },
        },
      })

      expect(result).toBe(true)

      const state = await readState(dir)
      const runtime = state.runtimes.find((r) => r.goalID === goal.id)
      expect(runtime?.lastWorkerStatus).toBe("busy")
    })

    it("continues immediately when session.status reports idle", async () => {
      const { goal } = await goalService.start(dir, {
        name: "idle-status",
        objective: "do something",
        ownerSessionID: "owner-1",
      })

      await engine.preloadWorkerSessions()
      const result = await engine.handleEvent({
        type: "session.status",
        properties: {
          sessionID: goal.workerSessionID,
          status: { type: "idle" },
        },
      })

      expect(result).toBe(true)
      expect(host.prompts).toHaveLength(2)
      const runtime = (await readState(dir)).runtimes[0]
      expect(runtime.turnCount).toBe(2)
      expect(runtime.runCount).toBe(2)
    })
  })

  describe("maintenance", () => {
    it("polls an idle worker before its lease expires", async () => {
      engine.stop()
      engine = createLoopEngine({ directory: dir, host, goalService, pollIntervalMs: 20 })
      engine.start()

      await goalService.start(dir, {
        name: "poll-idle",
        objective: "do something",
        ownerSessionID: "owner-1",
      })

      await new Promise((resolve) => setTimeout(resolve, 60))
      expect(host.prompts.length).toBeGreaterThan(1)
    })
  })

  describe("limits", () => {
    it("force-finish then blocks on max turns", async () => {
      const { goal } = await goalService.start(dir, {
        name: "test",
        objective: "do something",
        ownerSessionID: "owner-1",
        config: { maxTurns: 1 },
      })

      // Exceed maxTurns
      const state = await readState(dir)
      const runtime = state.runtimes.find((r) => r.goalID === goal.id)
      if (runtime) {
        runtime.turnCount = 2
        await fs.writeFile(
          path.join(dir, ".opencode", "loopd", "state.json"),
          JSON.stringify(state, null, 2),
        )
      }

      // 1st idle → force-finish requested, still active, prompt contains FINAL REPORT
      await engine.handleEvent({
        type: "session.idle",
        properties: { sessionID: goal.workerSessionID },
      })
      let updatedState = await readState(dir)
      expect(updatedState.goals[0].status).toBe("active")
      expect(updatedState.runtimes[0].forceFinishRequested).toBe(true)
      expect(host.prompts[host.prompts.length - 1]).toContain("FINAL REPORT REQUIRED")

      // 2nd idle → child ignored → blocked + parent notified
      await engine.handleEvent({
        type: "session.idle",
        properties: { sessionID: goal.workerSessionID },
      })
      updatedState = await readState(dir)
      expect(updatedState.goals[0].status).toBe("blocked")
    })

    it("dedupes parent notification within 60s", async () => {
      const { goal } = await goalService.start(dir, {
        name: "dedupe",
        objective: "do something",
        ownerSessionID: "owner-1",
        config: { maxFailures: 1 },
      })
      await engine.handleEvent({
        type: "session.error",
        properties: { sessionID: goal.workerSessionID, error: { message: "boom" } },
      })
      const notifications = (host.sessions as any).notifications as Array<any> | undefined
      expect(notifications?.length).toBe(1)
      // Second error would re-block but should be deduped by engine's failed guard (status already blocked → no event)
      await engine.handleEvent({
        type: "session.error",
        properties: { sessionID: goal.workerSessionID, error: { message: "boom again" } },
      })
      expect((host.sessions as any).notifications?.length).toBe(1)
    })
  })

  describe("lifecycle", () => {
    it("starts and stops cleanly", () => {
      expect(engine.isRunning()).toBe(true)
      engine.stop()
      expect(engine.isRunning()).toBe(false)
    })

    it("can be restarted", () => {
      engine.stop()
      expect(engine.isRunning()).toBe(false)
      engine.start()
      expect(engine.isRunning()).toBe(true)
    })
  })
})
