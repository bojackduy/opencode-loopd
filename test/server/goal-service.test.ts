import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { promises as fs } from "fs"
import path from "path"
import os from "os"
import { createGoalService } from "../../src/application/goal-service"
import { readState } from "../../src/infrastructure/state-repository"
import { createFakeHost } from "../../src/server/host-adapter"
import type { GoalID } from "../../src/domain/goal"

function tmpDir(): string {
  return path.join(os.tmpdir(), `loopd-goal-test-${crypto.randomUUID()}`)
}

describe("Goal Service", () => {
  let dir: string
  let host: ReturnType<typeof createFakeHost>
  let svc: ReturnType<typeof createGoalService>

  beforeEach(async () => {
    dir = tmpDir()
    await fs.mkdir(dir, { recursive: true })
    host = createFakeHost()
    svc = createGoalService(host)
  })

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  describe("start", () => {
    it("creates a goal and worker session", async () => {
      const { goal, worker } = await svc.start(dir, {
        name: "test",
        objective: "do something",
        ownerSessionID: "owner-1",
      })

      expect(goal.name).toBe("test")
      expect(goal.status).toBe("active")
      expect(goal.workerSessionID).toBeTruthy()
      expect(worker.workerSessionID).toBeTruthy()

      const state = await readState(dir)
      expect(state.goals).toHaveLength(1)
      expect(state.runtimes).toHaveLength(1)
    })

    it("sends first continuation to worker", async () => {
      const { worker } = await svc.start(dir, {
        name: "test",
        objective: "do something",
        ownerSessionID: "owner-1",
      })

      const msgs = host.sessions.get(worker.workerSessionID) || []
      expect(msgs.length).toBeGreaterThan(0)
      expect(msgs[0]).toContain("get_goal")
      expect(msgs[0]).toContain("complete_goal")
      expect(msgs[0]).toContain("block_goal")
    })

    it("sends the goal agent and model on every worker prompt", async () => {
      const { goal } = await svc.start(dir, {
        name: "custom-worker",
        objective: "do something",
        ownerSessionID: "owner-1",
        config: { workspaceWrite: false, agent: "researcher", model: "ollama/qwen3.8:27b" },
      })

      expect(host.promptCalls.length).toBeGreaterThan(0)
      for (const call of host.promptCalls) {
        expect(call.agent).toBe("researcher")
        expect(call.model).toEqual({ providerID: "ollama", modelID: "qwen3.8:27b" })
      }
      const state = await readState(dir)
      expect(state.goals.find((g) => g.id === goal.id)?.config.model).toBe("ollama/qwen3.8:27b")
    })

    it("accumulates worker token usage into goal totals without double counting", async () => {
      const { goal } = await svc.start(dir, {
        name: "usage",
        objective: "do something",
        ownerSessionID: "owner-1",
        config: { workspaceWrite: false },
      })
      expect((await readState(dir)).goals[0].tokensUsed).toBe(0)

      // Seed a token-bearing completed assistant message in the worker transcript
      const workerID = goal.workerSessionID!
      const transcript = host.messages.get(workerID) || []
      transcript.push({
        role: "assistant",
        content: "billed work",
        timestamp: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        messageID: "asst-billed",
        tokens: { input: 100, output: 50, reasoning: 10, cacheRead: 999, cacheWrite: 999 },
        cost: 0.012,
        durationMs: 4000,
      })
      host.messages.set(workerID, transcript)

      async function forceIdleTurn() {
        const st = await readState(dir)
        st.runtimes[0].phase = "idle"
        st.runtimes[0].activeRunID = undefined
        st.runtimes[0].leaseExpiresAt = undefined
        st.runtimes[0].activePromptMessageID = undefined
        await fs.writeFile(
          path.join(dir, ".opencode", "loopd", "state.json"),
          JSON.stringify(st, null, 2),
        )
        await svc.continueTurn(dir, goal.id)
      }

      await forceIdleTurn()
      let after = await readState(dir)
      // all five token kinds counted, matching OpenCode's session ledger
      expect(after.goals[0].tokensUsed).toBe(2158)
      expect(after.goals[0].costUsed).toBe(0.012)
      expect(after.goals[0].timeUsedSeconds).toBe(4)
      expect(after.runtimes[0].turnTokensUsed).toBe(2158)

      // Overlapping transcript tail on the next turn must not double count
      await forceIdleTurn()
      after = await readState(dir)
      expect(after.goals[0].tokensUsed).toBe(2158)
      expect(after.goals[0].costUsed).toBe(0.012)
      expect(after.goals[0].timeUsedSeconds).toBe(4)
    })

    it("folds final-turn usage on demand without double counting", async () => {
      const { goal } = await svc.start(dir, {
        name: "final-usage",
        objective: "do something",
        ownerSessionID: "owner-1",
        config: { workspaceWrite: false },
      })
      const workerID = goal.workerSessionID!
      const transcript = host.messages.get(workerID) || []
      transcript.push({
        role: "assistant",
        content: "last turn",
        timestamp: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        messageID: "asst-final",
        tokens: { input: 10, output: 5, reasoning: 0, cacheRead: 100, cacheWrite: 50 },
        cost: 0.001,
        durationMs: 2000,
      })
      host.messages.set(workerID, transcript)

      const first = await svc.accountUsage(dir, goal.id)
      expect(first.tokenDelta).toBe(165)
      expect((await readState(dir)).goals[0].tokensUsed).toBe(165)
      expect((await readState(dir)).goals[0].costUsed).toBe(0.001)

      const second = await svc.accountUsage(dir, goal.id)
      expect(second.tokenDelta).toBe(0)
      expect((await readState(dir)).goals[0].tokensUsed).toBe(165)
    })

    it("records owner session ID", async () => {
      await svc.start(dir, {
        name: "test",
        objective: "do something",
        ownerSessionID: "owner-1",
      })

      const state = await readState(dir)
      expect(state.goals[0].ownerSessionID).toBe("owner-1")
    })

    it("blocks the goal and preserves the error when worker creation fails", async () => {
      host.createWorker = async () => {
        throw new Error("parent session not found")
      }

      await expect(svc.start(dir, {
        name: "broken",
        objective: "do something",
        ownerSessionID: "missing-parent",
      })).rejects.toThrow("parent session not found")

      const state = await readState(dir)
      expect(state.goals[0].status).toBe("blocked")
      expect(state.goals[0].blocker?.reason).toContain("parent session not found")
      expect(state.runtimes[0].phase).toBe("idle")
      expect(state.runtimes[0].lastError).toContain("parent session not found")
    })
  })

  describe("continueTurn", () => {
    it("does not prompt when the goal becomes non-active before lease acquisition", async () => {
      const { goal } = await svc.start(dir, {
        name: "acquire-race",
        objective: "do something",
        ownerSessionID: "owner-1",
      })
      const state = await readState(dir)
      state.runtimes[0].phase = "idle"
      state.runtimes[0].activeRunID = undefined
      state.runtimes[0].leaseExpiresAt = undefined
      state.runtimes[0].activePromptMessageID = undefined
      await fs.writeFile(
        path.join(dir, ".opencode", "loopd", "state.json"),
        JSON.stringify(state, null, 2),
      )

      host.sessionStatus = async () => {
        const changed = await readState(dir)
        changed.goals[0].status = "blocked"
        await fs.writeFile(
          path.join(dir, ".opencode", "loopd", "state.json"),
          JSON.stringify(changed, null, 2),
        )
        return "idle"
      }

      const promptCount = host.prompts.length
      await svc.continueTurn(dir, goal.id)

      expect(host.prompts).toHaveLength(promptCount)
      expect((await readState(dir)).goals[0].status).toBe("blocked")
    })

    it("serializes concurrent continuation attempts for one goal", async () => {
      host = createFakeHost({ workerDelay: 20 })
      svc = createGoalService(host)
      const { goal } = await svc.start(dir, {
        name: "concurrent-turns",
        objective: "do something",
        ownerSessionID: "owner-1",
      })
      const state = await readState(dir)
      state.runtimes[0].phase = "idle"
      state.runtimes[0].activeRunID = undefined
      state.runtimes[0].leaseExpiresAt = undefined
      state.runtimes[0].activePromptMessageID = undefined
      await fs.writeFile(
        path.join(dir, ".opencode", "loopd", "state.json"),
        JSON.stringify(state, null, 2),
      )

      await Promise.all([
        svc.continueTurn(dir, goal.id),
        svc.continueTurn(dir, goal.id),
      ])

      expect(host.prompts).toHaveLength(2)
      expect((await readState(dir)).runtimes[0].runCount).toBe(2)
    })

    it("orders pause after in-flight prompt dispatch", async () => {
      host = createFakeHost({ workerDelay: 20 })
      svc = createGoalService(host)
      const { goal } = await svc.start(dir, {
        name: "pause-fence",
        objective: "do something",
        ownerSessionID: "owner-1",
      })
      const state = await readState(dir)
      state.runtimes[0].phase = "idle"
      state.runtimes[0].activeRunID = undefined
      state.runtimes[0].leaseExpiresAt = undefined
      state.runtimes[0].activePromptMessageID = undefined
      await fs.writeFile(
        path.join(dir, ".opencode", "loopd", "state.json"),
        JSON.stringify(state, null, 2),
      )

      const continuation = svc.continueTurn(dir, goal.id)
      const pause = svc.pause(dir, goal.id)
      await Promise.all([continuation, pause])

      const after = await readState(dir)
      expect(after.goals[0].status).toBe("paused")
      expect(after.runtimes[0].phase).toBe("idle")
      expect(host.sessions.has(goal.workerSessionID!)).toBe(false)
    })
  })

  describe("pause / resume", () => {
    it("pauses an active goal and aborts worker", async () => {
      const { goal } = await svc.start(dir, {
        name: "p",
        objective: "o",
        ownerSessionID: "owner-1",
      })

      await svc.pause(dir, goal.id)

      const state = await readState(dir)
      expect(state.goals[0].status).toBe("paused")
    })

    it("pauses with no leaked run markers (no maintenance repair needed)", async () => {
      const { goal } = await svc.start(dir, {
        name: "clean-pause",
        objective: "o",
        ownerSessionID: "owner-1",
      })
      expect((await readState(dir)).runtimes[0].activeRunID).toBeDefined()

      await svc.pause(dir, goal.id)

      const runtime = (await readState(dir)).runtimes[0]
      expect(runtime.phase).toBe("idle")
      expect(runtime.activeRunID).toBeUndefined()
      expect(runtime.leaseExpiresAt).toBeUndefined()
      expect(runtime.activePromptMessageID).toBeUndefined()
    })

    it("resumes a paused goal and recreates worker", async () => {
      const { goal } = await svc.start(dir, {
        name: "r",
        objective: "o",
        ownerSessionID: "owner-1",
      })

      await svc.pause(dir, goal.id)
      await svc.resume(dir, goal.id)

      const state = await readState(dir)
      expect(state.goals[0].status).toBe("active")
    })

    it("resume reuses the existing worker session when it still exists", async () => {
      const { goal, worker } = await svc.start(dir, {
        name: "reuse",
        objective: "o",
        ownerSessionID: "owner-1",
      })
      const originalSession = worker.workerSessionID

      // Pause removes the session from cache; resume should re-attach to the
      // existing session (fake host keeps it alive) instead of creating a new one.
      await svc.pause(dir, goal.id)
      await svc.resume(dir, goal.id)

      const state = await readState(dir)
      expect(state.goals[0].status).toBe("active")
      expect(state.goals[0].workerSessionID).toBe(originalSession)
      expect(svc.getWorker(goal.id)?.workerSessionID).toBe(originalSession)
    })
  })

  describe("nudge", () => {
    it("forces a continuation for an active goal", async () => {
      const { goal } = await svc.start(dir, {
        name: "nudge",
        objective: "o",
        ownerSessionID: "owner-1",
      })

      const result = await svc.nudge(dir, goal.id)
      expect(result.ok).toBe(true)
      // Initial prompt + nudge continuation
      expect(host.prompts.length).toBeGreaterThanOrEqual(2)
    })

    it("rejects nudging a complete goal", async () => {
      const { goal } = await svc.start(dir, {
        name: "done",
        objective: "o",
        ownerSessionID: "owner-1",
      })
      const state = await readState(dir)
      state.goals[0].status = "complete"
      await fs.writeFile(
        path.join(dir, ".opencode", "loopd", "state.json"),
        JSON.stringify(state, null, 2),
      )

      const result = await svc.nudge(dir, goal.id)
      expect(result.ok).toBe(false)
    })

    it("releases the lease and schedules retry when prompt delivery fails", async () => {
      const { goal } = await svc.start(dir, {
        name: "prompt-retry",
        objective: "o",
        ownerSessionID: "owner-1",
      })
      host.promptWorker = async () => {
        throw new Error("prompt unavailable")
      }

      await expect(svc.nudge(dir, goal.id)).rejects.toThrow("prompt unavailable")
      const state = await readState(dir)
      expect(state.goals[0].status).toBe("active")
      expect(state.runtimes[0].phase).toBe("waiting_retry")
      expect(state.runtimes[0].activeRunID).toBeUndefined()
      expect(state.runtimes[0].lastError).toContain("prompt unavailable")
    })
  })

  describe("abortWorker", () => {
    it("aborts the worker session and detaches it without changing status", async () => {
      const { goal } = await svc.start(dir, {
        name: "abort-me",
        objective: "o",
        ownerSessionID: "owner-1",
        config: { workspaceWrite: false },
      })
      const workerID = goal.workerSessionID!
      expect(host.sessions.has(workerID)).toBe(true)

      const result = await svc.abortWorker(dir, goal.id)
      expect(result.ok).toBe(true)

      expect(host.sessions.has(workerID)).toBe(false)
      const state = await readState(dir)
      expect(state.goals[0].status).toBe("active")
      // Session link kept: abort stops the run, the OpenCode session and its
      // transcript stay browsable, and the next turn reuses the session.
      expect(state.goals[0].workerSessionID).toBe(workerID)
      expect(state.runtimes[0].workerAbortedAt).toBeTruthy()
      expect(state.runtimes[0].phase).toBe("idle")
      expect(state.runtimes[0].activeRunID).toBeUndefined()
      expect(state.runtimes[0].activePromptMessageID).toBeUndefined()
    })

    it("reports when there is no worker to abort", async () => {
      const missing = await svc.abortWorker(dir, "nope" as GoalID)
      expect(missing.ok).toBe(false)

      const { goal } = await svc.start(dir, {
        name: "abort-twice",
        objective: "o",
        ownerSessionID: "owner-1",
        config: { workspaceWrite: false },
      })
      expect((await svc.abortWorker(dir, goal.id)).ok).toBe(true)
      // Aborting twice is idempotent: the session link is kept for browsing,
      // so a repeated abort simply re-confirms instead of erroring.
      expect((await svc.abortWorker(dir, goal.id)).ok).toBe(true)
      expect((await readState(dir)).goals[0].workerSessionID).toBe(goal.workerSessionID)
    })
  })

  describe("sendUserMessage", () => {
    it("delivers bare words immediately without steering", async () => {
      const { goal } = await svc.start(dir, {
        name: "bare-direct",
        objective: "do something",
        ownerSessionID: "owner-1",
        config: { workspaceWrite: false },
      })
      const before = host.prompts.length
      const result = await svc.sendUserMessage(dir, goal.id, "just this")
      expect(result.ok).toBe(true)
      expect(host.prompts.length).toBe(before + 1)
      expect(host.prompts[host.prompts.length - 1]).toBe("[user] just this")
    })

    it("queues without turning when the goal is not active", async () => {
      const { goal } = await svc.start(dir, {
        name: "bare-paused",
        objective: "do something",
        ownerSessionID: "owner-1",
        config: { workspaceWrite: false },
      })
      await svc.pause(dir, goal.id)
      const before = host.prompts.length
      const result = await svc.sendUserMessage(dir, goal.id, "later words")
      expect(result.ok).toBe(true)
      expect(result.message).toContain("paused")
      expect(host.prompts.length).toBe(before)
    })

    it("rejects blank text", async () => {
      const { goal } = await svc.start(dir, {
        name: "bare-blank",
        objective: "do something",
        ownerSessionID: "owner-1",
        config: { workspaceWrite: false },
      })
      const result = await svc.sendUserMessage(dir, goal.id, "   ")
      expect(result.ok).toBe(false)
    })
  })

  describe("prompt startup failure", () => {
    it("blocks a newly created goal when its first prompt cannot be delivered", async () => {
      host.promptWorker = async () => {
        throw new Error("prompt unavailable")
      }

      await expect(svc.start(dir, {
        name: "prompt-start-failure",
        objective: "o",
        ownerSessionID: "owner-1",
      })).rejects.toThrow("prompt unavailable")

      const state = await readState(dir)
      expect(state.goals[0].status).toBe("blocked")
      expect(state.runtimes[0].phase).toBe("idle")
      expect(state.runtimes[0].activeRunID).toBeUndefined()
    })
  })

  describe("clear", () => {
    it("removes goal and aborts worker", async () => {
      const { goal, worker } = await svc.start(dir, {
        name: "c",
        objective: "o",
        ownerSessionID: "owner-1",
      })

      await svc.clear(dir, goal.id)

      const state = await readState(dir)
      expect(state.goals).toHaveLength(0)
      expect(host.sessions.has(worker.workerSessionID)).toBe(false)
    })
  })

  describe("workspace serialization", () => {
    it("allows only one active workspace-writing goal", async () => {
      const first = await svc.start(dir, {
        name: "writer-one",
        objective: "fix code",
        ownerSessionID: "owner-1",
        config: { workspaceWrite: true, checks: ["bun test"], agent: "smart-agent" },
      })

      await expect(svc.start(dir, {
        name: "writer-two",
        objective: "fix more code",
        ownerSessionID: "owner-1",
        config: { workspaceWrite: true, checks: ["bun test"], agent: "smart-agent" },
      })).rejects.toThrow("already active")

      await svc.pause(dir, first.goal.id)
      const replacement = await svc.start(dir, {
        name: "writer-after-pause",
        objective: "fix other code",
        ownerSessionID: "owner-1",
        config: { workspaceWrite: true, checks: ["bun test"], agent: "smart-agent" },
      })
      expect(replacement.goal.status).toBe("active")
      await expect(svc.resume(dir, first.goal.id)).rejects.toThrow("already active")
    })
  })

  describe("getWorker", () => {
    it("returns worker for active goal", async () => {
      const { goal } = await svc.start(dir, {
        name: "w",
        objective: "o",
        ownerSessionID: "owner-1",
      })

      const worker = svc.getWorker(goal.id)
      expect(worker).toBeTruthy()
      expect(worker?.goalID).toBe(goal.id)
    })

    it("returns undefined for unknown goal", () => {
      expect(svc.getWorker("unknown" as GoalID)).toBeUndefined()
    })
  })

  describe("getActiveWorkers", () => {
    it("returns all active workers", async () => {
      const { goal: g1 } = await svc.start(dir, {
        name: "w1",
        objective: "o1",
        ownerSessionID: "owner-1",
        config: { workspaceWrite: false },
      })
      const { goal: g2 } = await svc.start(dir, {
        name: "w2",
        objective: "o2",
        ownerSessionID: "owner-2",
        config: { workspaceWrite: false },
      })

      const workers = svc.getActiveWorkers()
      expect(workers.size).toBe(2)
      expect(workers.has(g1.id)).toBe(true)
      expect(workers.has(g2.id)).toBe(true)
    })
  })
})
