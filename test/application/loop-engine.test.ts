import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { promises as fs } from "fs"
import path from "path"
import os from "os"
import { createLoopEngine } from "../../src/application/loop-engine"
import { createGoalService } from "../../src/application/goal-service"
import { createFakeHost } from "../../src/server/host-adapter"
import { readState, readEvents } from "../../src/infrastructure/state-repository"
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
      confirmIdleMs: 0,
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

    it("continues on session.idle event", async () => {
      const { goal } = await goalService.start(dir, {
        name: "idle-status",
        objective: "do something",
        ownerSessionID: "owner-1",
      })

      await engine.preloadWorkerSessions()

      // 1st idle → records idle candidate
      await engine.handleEvent({
        type: "session.idle",
        properties: { sessionID: goal.workerSessionID },
      })

      // 2nd idle → confirms idle, triggers continuation
      const result = await engine.handleEvent({
        type: "session.idle",
        properties: { sessionID: goal.workerSessionID },
      })

      expect(result).toBe(true)
      expect(host.prompts).toHaveLength(2)
      const runtime = (await readState(dir)).runtimes[0]
      expect(runtime.budgetTurnCount).toBe(2)
      expect(runtime.runCount).toBe(2)
    })

    it("tracks only message activity related to the active prompt", async () => {
      const { goal } = await goalService.start(dir, {
        name: "message-correlation",
        objective: "do something",
        ownerSessionID: "owner-1",
      })
      await engine.preloadWorkerSessions()

      const before = (await readState(dir)).runtimes[0]
      const promptID = before.activePromptMessageID!

      expect(await engine.handleEvent({
        type: "message.updated",
        properties: {
          info: {
            id: "assistant-current",
            sessionID: goal.workerSessionID,
            role: "assistant",
            parentID: promptID,
            time: { created: Date.now() },
          },
        },
      })).toBe(true)

      const matched = (await readState(dir)).runtimes[0]
      expect(matched.activeAssistantMessageID).toBe("assistant-current")

      expect(await engine.handleEvent({
        type: "message.updated",
        properties: {
          info: {
            id: "assistant-stale",
            sessionID: goal.workerSessionID,
            role: "assistant",
            parentID: "older-prompt",
            time: { created: Date.now() },
          },
        },
      })).toBe(false)

      expect((await readState(dir)).runtimes[0].activeAssistantMessageID).toBe("assistant-current")
    })

    it("does not let a stale idle candidate release a newer generation", async () => {
      const { goal } = await goalService.start(dir, {
        name: "generation-fence",
        objective: "do something",
        ownerSessionID: "owner-1",
      })
      await engine.preloadWorkerSessions()

      await engine.handleEvent({
        type: "session.idle",
        properties: { sessionID: goal.workerSessionID },
      })
      expect((await readState(dir)).runtimes[0].idleCandidateGeneration).toBe(1)

      await goalService.nudge(dir, goal.id)
      expect(host.prompts).toHaveLength(2)

      // This can be a delayed idle event from generation 1. It may establish a
      // candidate for generation 2, but it cannot release generation 2.
      await engine.handleEvent({
        type: "session.idle",
        properties: { sessionID: goal.workerSessionID },
      })

      const runtime = (await readState(dir)).runtimes[0]
      expect(runtime.phase).toBe("running")
      expect(runtime.runGeneration).toBe(2)
      expect(runtime.idleCandidateGeneration).toBe(2)
      expect(host.prompts).toHaveLength(2)
    })

    it("does not finalize a newer run until its assistant response completes", async () => {
      engine.stop()
      host = createFakeHost({ autoCompletePrompts: false })
      goalService = createGoalService(host)
      engine = createLoopEngine({ directory: dir, host, goalService, pollIntervalMs: 10_000, confirmIdleMs: 0 })
      engine.start()

      const { goal } = await goalService.start(dir, {
        name: "unfinished-generation",
        objective: "do something",
        ownerSessionID: "owner-1",
      })
      await engine.preloadWorkerSessions()

      // Candidate for generation 1, followed by a forced generation 2 prompt.
      await engine.handleEvent({ type: "session.idle", properties: { sessionID: goal.workerSessionID } })
      await goalService.nudge(dir, goal.id)

      // Two delayed idle signals cannot complete generation 2 because its
      // assistant response has not completed.
      await engine.handleEvent({ type: "session.idle", properties: { sessionID: goal.workerSessionID } })
      await engine.handleEvent({ type: "session.idle", properties: { sessionID: goal.workerSessionID } })

      expect(host.prompts).toHaveLength(2)
      expect((await readState(dir)).runtimes[0].phase).toBe("running")
    })

    it("does not finalize when a newer user prompt owns the transcript", async () => {
      const { goal } = await goalService.start(dir, {
        name: "transcript-anchor",
        objective: "do something",
        ownerSessionID: "owner-1",
      })
      await engine.preloadWorkerSessions()
      host.messages.get(goal.workerSessionID!)?.push({
        role: "user",
        content: "unrelated newer prompt",
        timestamp: new Date(Date.now() + 1_000).toISOString(),
        messageID: "newer-unrelated-message",
      })

      await engine.handleEvent({
        type: "session.idle",
        properties: { sessionID: goal.workerSessionID },
      })
      await engine.handleEvent({
        type: "session.idle",
        properties: { sessionID: goal.workerSessionID },
      })

      expect(host.prompts).toHaveLength(1)
      expect((await readState(dir)).runtimes[0].phase).toBe("running")
    })
  })

  describe("maintenance", () => {
    it("polls an idle worker before its lease expires", async () => {
      engine.stop()
      engine = createLoopEngine({ directory: dir, host, goalService, pollIntervalMs: 20, confirmIdleMs: 0 })
      engine.start()

      await goalService.start(dir, {
        name: "poll-idle",
        objective: "do something",
        ownerSessionID: "owner-1",
      })

      // Two-stage idle needs debounce time + maintenance interval
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(host.prompts.length).toBeGreaterThan(1)
    })

    it("bounds unknown status polls and warns the owner once", async () => {
      engine.stop()
      host = createFakeHost({ sessionStatus: "unknown" })
      goalService = createGoalService(host)
      engine = createLoopEngine({
        directory: dir,
        host,
        goalService,
        pollIntervalMs: 10,
        confirmIdleMs: 0,
        unknownStatusThreshold: 2,
      })
      engine.start()

      await goalService.start(dir, {
        name: "unknown-worker",
        objective: "do something",
        ownerSessionID: "owner-1",
      })

      await new Promise((resolve) => setTimeout(resolve, 60))
      const runtime = (await readState(dir)).runtimes[0]
      expect(runtime.unknownStatusCount).toBe(2)
      expect(runtime.workerUnreachableNotifiedAt).toBeTruthy()
      expect((host.sessions as any).notifications).toHaveLength(1)
    })

    it("treats a sparse-map absent worker as idle without unreachable alert", async () => {
      engine.stop()
      // Mimics the real host sparse map: missing entry resolves to idle.
      host = createFakeHost({ sessionStatus: async () => "idle" as const })
      goalService = createGoalService(host)
      engine = createLoopEngine({
        directory: dir,
        host,
        goalService,
        pollIntervalMs: 10,
        confirmIdleMs: 0,
        unknownStatusThreshold: 2,
      })
      engine.start()

      await goalService.start(dir, {
        name: "sparse-idle-worker",
        objective: "do something",
        ownerSessionID: "owner-1",
      })

      await new Promise((resolve) => setTimeout(resolve, 60))
      const runtime = (await readState(dir)).runtimes[0]
      expect(runtime.unknownStatusCount ?? 0).toBe(0)
      expect(runtime.workerUnreachableNotifiedAt).toBeFalsy()
      expect((host.sessions as any).notifications ?? []).toHaveLength(0)
      // Idle maintenance should keep driving the goal forward.
      expect(host.prompts.length).toBeGreaterThan(1)
    })

    it("stops a goal as budget_limited when costUsed reaches costBudget", async () => {
      engine.stop()
      host = createFakeHost()
      goalService = createGoalService(host)
      engine = createLoopEngine({ directory: dir, host, goalService, pollIntervalMs: 10, confirmIdleMs: 0 })
      engine.start()

      const { goal } = await goalService.start(dir, {
        name: "capped",
        objective: "do something",
        ownerSessionID: "owner-1",
        config: { workspaceWrite: false },
        costBudget: 0.5,
      })
      // Seed spend past the budget before the engine completes the first run
      const seeded = await readState(dir)
      seeded.goals.find((g) => g.id === goal.id)!.costBudget = 0.5
      seeded.goals.find((g) => g.id === goal.id)!.costUsed = 10
      await fs.writeFile(
        path.join(dir, ".opencode", "loopd", "state.json"),
        JSON.stringify(seeded, null, 2),
      )

      await new Promise((resolve) => setTimeout(resolve, 150))
      const after = await readState(dir)
      expect(after.goals[0].status).toBe("budget_limited")
      // No continuation prompt after the budget trip — only the initial one
      expect(host.prompts.length).toBe(1)
    })

    it("confirms an idle turn whose prompt fell outside the transcript tail", async () => {
      engine.stop()
      host = createFakeHost()
      goalService = createGoalService(host)
      engine = createLoopEngine({ directory: dir, host, goalService, pollIntervalMs: 100, confirmIdleMs: 0 })
      engine.start()

      const { goal } = await goalService.start(dir, {
        name: "long-turn",
        objective: "do something",
        ownerSessionID: "owner-1",
        config: { workspaceWrite: false },
      })
      await engine.preloadWorkerSessions()
      const promptID = (await readState(dir)).runtimes[0].activePromptMessageID!
      // Bury the prompt under 60 completions — beyond any fixed tail window
      const transcript = host.messages.get(goal.workerSessionID!) || []
      for (let i = 0; i < 60; i++) {
        transcript.push({
          role: "assistant",
          content: `chunk ${i}`,
          timestamp: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          messageID: `asst-long-${i}`,
          parentMessageID: promptID,
        })
      }
      host.messages.set(goal.workerSessionID!, transcript)

      await engine.handleEvent({ type: "session.idle", properties: { sessionID: goal.workerSessionID } })
      await engine.handleEvent({ type: "session.idle", properties: { sessionID: goal.workerSessionID } })

      const completed = (await readEvents(dir, 50)).filter(
        (e: any) => e.goalID === goal.id && e.type === "run.completed",
      )
      expect(completed.length).toBeGreaterThan(0)
      expect(host.prompts.length).toBeGreaterThan(1)
      const failed = (await readEvents(dir, 50)).filter(
        (e: any) => e.goalID === goal.id && e.type === "idle.confirm-failed",
      )
      expect(failed).toHaveLength(0)
    })

    it("confirms via the event anchor when the transcript cannot prove completion", async () => {
      engine.stop()
      host = createFakeHost()
      goalService = createGoalService(host)
      engine = createLoopEngine({ directory: dir, host, goalService, pollIntervalMs: 100, confirmIdleMs: 0 })
      engine.start()

      const { goal } = await goalService.start(dir, {
        name: "anchor-turn",
        objective: "do something",
        ownerSessionID: "owner-1",
        config: { workspaceWrite: false },
      })
      await engine.preloadWorkerSessions()
      // 210 completions linked elsewhere + a recorded completion stamp:
      // transcript alone cannot confirm, the event anchor can.
      const transcript = host.messages.get(goal.workerSessionID!) || []
      for (let i = 0; i < 210; i++) {
        transcript.push({
          role: "assistant",
          content: `chunk ${i}`,
          timestamp: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          messageID: `asst-anchor-${i}`,
          parentMessageID: "some-other-prompt",
        })
      }
      host.messages.set(goal.workerSessionID!, transcript)
      const seeded = await readState(dir)
      const rt = seeded.runtimes.find((r) => r.goalID === goal.id)!
      rt.activeAssistantCompletedAt = new Date().toISOString()
      await fs.writeFile(
        path.join(dir, ".opencode", "loopd", "state.json"),
        JSON.stringify(seeded, null, 2),
      )

      await engine.handleEvent({ type: "session.idle", properties: { sessionID: goal.workerSessionID } })
      await engine.handleEvent({ type: "session.idle", properties: { sessionID: goal.workerSessionID } })

      const completed = (await readEvents(dir, 50)).filter(
        (e: any) => e.goalID === goal.id && e.type === "run.completed",
      )
      expect(completed.length).toBeGreaterThan(0)
      expect(host.prompts.length).toBeGreaterThan(1)
    })

    async function svc_start_idle_goal() {
      return goalService.start(dir, {
        name: "anchor-turn",
        objective: "do something",
        ownerSessionID: "owner-1",
        config: { workspaceWrite: false },
      })
    }

    it("emits idle.confirm-failed when the assistant never completed", async () => {
      engine.stop()
      host = createFakeHost({ autoCompletePrompts: false })
      goalService = createGoalService(host)
      engine = createLoopEngine({ directory: dir, host, goalService, pollIntervalMs: 100, confirmIdleMs: 0 })
      engine.start()

      const { goal } = await goalService.start(dir, {
        name: "incomplete-turn",
        objective: "do something",
        ownerSessionID: "owner-1",
        config: { workspaceWrite: false },
      })
      await engine.preloadWorkerSessions()

      await engine.handleEvent({ type: "session.idle", properties: { sessionID: goal.workerSessionID } })
      await engine.handleEvent({ type: "session.idle", properties: { sessionID: goal.workerSessionID } })

      const failed = (await readEvents(dir, 50)).filter(
        (e: any) => e.goalID === goal.id && e.type === "idle.confirm-failed",
      )
      expect(failed.length).toBeGreaterThan(0)
      expect(failed[0].reason).toBe("assistant-incomplete")
      expect(host.prompts.length).toBe(1)
    })

    it("reports a lease-expired running turn with no activity as stuck, once", async () => {
      engine.stop()
      host = createFakeHost({ sessionStatus: "busy" })
      goalService = createGoalService(host)
      engine = createLoopEngine({
        directory: dir,
        host,
        goalService,
        pollIntervalMs: 10,
        confirmIdleMs: 0,
        stuckRunningMs: 50,
      })
      engine.start()

      const { goal } = await goalService.start(dir, {
        name: "stuck-turn",
        objective: "do something",
        ownerSessionID: "owner-1",
        config: { workspaceWrite: false },
      })
      const seeded = await readState(dir)
      const rt = seeded.runtimes.find((r) => r.goalID === goal.id)!
      rt.leaseExpiresAt = new Date(Date.now() - 60_000).toISOString()
      rt.lastActivityAt = new Date(Date.now() - 3_600_000).toISOString()
      await fs.writeFile(
        path.join(dir, ".opencode", "loopd", "state.json"),
        JSON.stringify(seeded, null, 2),
      )

      await new Promise((resolve) => setTimeout(resolve, 150))
      const stuck = (await readEvents(dir, 50)).filter(
        (e: any) => e.goalID === goal.id && e.type === "run.stuck",
      )
      expect(stuck.length).toBeGreaterThan(0)
      expect((host.sessions as any).notifications).toHaveLength(1)
      expect((await readState(dir)).goals[0].status).toBe("active")

      await new Promise((resolve) => setTimeout(resolve, 100))
      expect((host.sessions as any).notifications).toHaveLength(1)
    })

    it("escalates an idle turn that will not confirm, once, without prompting", async () => {
      engine.stop()
      host = createFakeHost({ autoCompletePrompts: false })
      goalService = createGoalService(host)
      engine = createLoopEngine({
        directory: dir,
        host,
        goalService,
        pollIntervalMs: 10,
        confirmIdleMs: 0,
        idleUnconfirmedMs: 50,
      })
      engine.start()

      const { goal } = await goalService.start(dir, {
        name: "unconfirmed-idle",
        objective: "do something",
        ownerSessionID: "owner-1",
        config: { workspaceWrite: false },
      })
      await engine.preloadWorkerSessions()

      await engine.handleEvent({ type: "session.idle", properties: { sessionID: goal.workerSessionID } })
      await engine.handleEvent({ type: "session.idle", properties: { sessionID: goal.workerSessionID } })
      await engine.handleEvent({ type: "session.idle", properties: { sessionID: goal.workerSessionID } })

      // Stamped once — repeated polls stay silent in the ledger
      const failed = (await readEvents(dir, 50)).filter(
        (e: any) => e.goalID === goal.id && e.type === "idle.confirm-failed",
      )
      expect(failed).toHaveLength(1)
      expect(failed[0].reason).toBe("assistant-incomplete")

      await new Promise((resolve) => setTimeout(resolve, 200))
      const stuck = (await readEvents(dir, 50)).filter(
        (e: any) => e.goalID === goal.id && e.type === "run.stuck",
      )
      expect(stuck.length).toBeGreaterThan(0)
      expect((host.sessions as any).notifications).toHaveLength(1)
      // Never auto re-prompts a possibly-live worker: only the initial prompt
      expect(host.prompts.length).toBe(1)
      expect((await readState(dir)).goals[0].status).toBe("active")

      await new Promise((resolve) => setTimeout(resolve, 100))
      expect((host.sessions as any).notifications).toHaveLength(1)
      const failedAgain = (await readEvents(dir, 100)).filter(
        (e: any) => e.goalID === goal.id && e.type === "idle.confirm-failed",
      )
      expect(failedAgain).toHaveLength(1)
    })

    it("never flags a healthy confirming turn as stuck", async () => {
      engine.stop()
      host = createFakeHost()
      goalService = createGoalService(host)
      engine = createLoopEngine({
        directory: dir,
        host,
        goalService,
        pollIntervalMs: 10,
        confirmIdleMs: 0,
        idleUnconfirmedMs: 50,
        stuckRunningMs: 50,
      })
      engine.start()

      const { goal } = await goalService.start(dir, {
        name: "healthy-turn",
        objective: "do something",
        ownerSessionID: "owner-1",
        config: { workspaceWrite: false },
      })
      await engine.preloadWorkerSessions()
      await engine.handleEvent({ type: "session.idle", properties: { sessionID: goal.workerSessionID } })
      await engine.handleEvent({ type: "session.idle", properties: { sessionID: goal.workerSessionID } })

      await new Promise((resolve) => setTimeout(resolve, 150))
      const evs = await readEvents(dir, 100)
      expect(evs.filter((e: any) => e.goalID === goal.id && e.type === "run.stuck")).toHaveLength(0)
      expect(evs.filter((e: any) => e.goalID === goal.id && e.type === "idle.confirm-failed")).toHaveLength(0)
      expect((host.sessions as any).notifications ?? []).toHaveLength(0)
    })

    it("clears a stale active run from an idle runtime", async () => {
      engine.stop()
      host = createFakeHost({ sessionStatus: "busy" })
      goalService = createGoalService(host)
      engine = createLoopEngine({ directory: dir, host, goalService, pollIntervalMs: 10, confirmIdleMs: 0 })
      engine.start()

      const { goal } = await goalService.start(dir, {
        name: "stale-runtime",
        objective: "do something",
        ownerSessionID: "owner-1",
      })
      const state = await readState(dir)
      const runtime = state.runtimes.find((item) => item.goalID === goal.id)!
      runtime.phase = "idle"
      runtime.activeRunID = "stale-run" as any
      await fs.writeFile(
        path.join(dir, ".opencode", "loopd", "state.json"),
        JSON.stringify(state, null, 2),
      )

      await new Promise((resolve) => setTimeout(resolve, 40))
      const repaired = (await readState(dir)).runtimes[0]
      expect(repaired.phase).toBe("idle")
      expect(repaired.activeRunID).toBeUndefined()
      expect(repaired.activePromptMessageID).toBeUndefined()
    })

    it("does not restart blocked goals during maintenance", async () => {
      const { goal } = await goalService.start(dir, {
        name: "blocked-maintenance",
        objective: "do something",
        ownerSessionID: "owner-1",
      })
      const state = await readState(dir)
      state.goals[0].status = "blocked"
      state.runtimes[0].phase = "idle"
      state.runtimes[0].activeRunID = undefined
      await fs.writeFile(
        path.join(dir, ".opencode", "loopd", "state.json"),
        JSON.stringify(state, null, 2),
      )

      await new Promise((resolve) => setTimeout(resolve, 150))
      expect(host.prompts).toHaveLength(1)
      expect((await readState(dir)).goals[0].status).toBe("blocked")
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
        runtime.budgetTurnCount = 2
        await fs.writeFile(
          path.join(dir, ".opencode", "loopd", "state.json"),
          JSON.stringify(state, null, 2),
        )
      }

      // 1st idle → records idle candidate, returns early
      await engine.handleEvent({
        type: "session.idle",
        properties: { sessionID: goal.workerSessionID },
      })

      // 2nd idle → confirms idle, enforceLimits fires → force-finish requested
      await engine.handleEvent({
        type: "session.idle",
        properties: { sessionID: goal.workerSessionID },
      })
      let updatedState = await readState(dir)
      expect(updatedState.goals[0].status).toBe("active")
      expect(updatedState.runtimes[0].forceFinishRequested).toBe(true)

      // 3rd idle → records idle candidate
      await engine.handleEvent({
        type: "session.idle",
        properties: { sessionID: goal.workerSessionID },
      })

      // 4th idle → confirms idle, child ignored → blocked
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
