import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { promises as fs } from "fs"
import path from "path"
import os from "os"
import { createGoalService } from "../../src/application/goal-service"
import { createControlClient } from "../../src/infrastructure/control-client"
import { createControlWorker } from "../../src/application/control-worker"
import {
  mutateState,
  readState,
  type WorkspaceCall,
} from "../../src/infrastructure/state-repository"
import {
  createFakeHost,
  createRealHost,
  createV2Host,
} from "../../src/server/host-adapter"

function tmpDir(): string {
  return path.join(os.tmpdir(), `loopd-resume-timeout-test-${crypto.randomUUID()}`)
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

describe("resume/nudge timeout and stalled delivery recovery", () => {
  let dir: string

  beforeEach(async () => {
    dir = tmpDir()
    await fs.mkdir(dir, { recursive: true })
  })

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it("unknown probe keeps reservations and reports stage evidence on resume", async () => {
    const host = createFakeHost()
    const svc = createGoalService(host)
    const { goal } = await svc.start(dir, {
      name: "scoped-unknown",
      objective: "do scoped work",
      ownerSessionID: "owner-1",
      config: { write_scope: ["a.txt"] },
    })
    await svc.pause(dir, goal.id)
    const pre = await readState(dir)
    const rt = pre.runtimes.find((r) => r.goalID === goal.id)!
    const workerSessionID = pre.goals.find((g) => g.id === goal.id)!.workerSessionID!
    await mutateState(dir, "test.seed-call", async (s) => {
      s.workspaceCalls = [...(s.workspaceCalls ?? []), {
        callID: "call-1",
        sessionID: workerSessionID,
        goalID: goal.id,
        generation: rt.runGeneration,
        paths: ["a.txt"],
        at: new Date().toISOString(),
      } satisfies WorkspaceCall]
      return s
    })
    // Unreachable probe: resolves "unknown" immediately (no 15s wait).
    host.sessionStatus = async () => "unknown"

    await expect(svc.resume(dir, goal.id)).rejects.toThrow("liveness unknown")

    // Nothing reaped, nothing rotated: the reservation survives, the goal
    // stays paused, and a later resume stays usable.
    const post = await readState(dir)
    expect(post.goals.find((g) => g.id === goal.id)!.status).toBe("paused")
    expect(post.workspaceCalls?.filter((c) => c.goalID === goal.id)).toHaveLength(1)
    expect(post.runtimes.find((r) => r.goalID === goal.id)!.runGeneration).toBe(rt.runGeneration)
  })

  it("unknown probe with no reservations still resumes with a fenced rotation", async () => {
    const host = createFakeHost()
    let creates = 0
    const innerCreate = host.createWorker.bind(host)
    host.createWorker = async (input) => { creates++; return innerCreate(input) }
    const svc = createGoalService(host)
    const { goal } = await svc.start(dir, {
      name: "scoped-unknown-clean",
      objective: "do scoped work",
      ownerSessionID: "owner-1",
      config: { write_scope: ["a.txt"] },
    })
    await svc.pause(dir, goal.id)
    host.sessionStatus = async () => "unknown"

    await svc.resume(dir, goal.id)

    const post = await readState(dir)
    const resumed = post.goals.find((g) => g.id === goal.id)!
    expect(resumed.status).toBe("active")
    expect(resumed.scopeClosing).toBe(false)
    // Exactly one fenced rotation: retire + single recreate, never a duplicate.
    expect(creates).toBe(2)
    expect(resumed.workerSessionID).toBeTruthy()
  })

  it("late-accepted prompt is not recorded as failure and not re-dispatched", async () => {
    const host = createFakeHost()
    const svc = createGoalService(host)
    const { goal } = await svc.start(dir, {
      name: "late-accept",
      objective: "legacy work",
      ownerSessionID: "owner-1",
      config: { workspaceWrite: false },
    })
    // First dispatch: enqueue succeeds (transcript records the exact
    // persisted prompt ID) but the acceptance reply is lost — the dispatch
    // throws like a lost Promise.race.
    let calls = 0
    const innerPrompt = host.promptWorker.bind(host)
    host.promptWorker = async (input) => {
      calls++
      if (calls === 1) {
        const transcript = host.messages.get(input.sessionID) ?? []
        transcript.push({
          role: "user",
          content: input.prompt,
          timestamp: new Date().toISOString(),
          messageID: input.messageID,
        })
        host.messages.set(input.sessionID, transcript)
        host.prompts.push(input.prompt)
        throw new Error("acceptance race lost (injected)")
      }
      return innerPrompt(input)
    }

    const nudged = await svc.nudge(dir, goal.id)
    expect(nudged.ok).toBe(true)

    // Turn dispatched, lease held, no failure consumed.
    const post = await readState(dir)
    const rt = post.runtimes.find((r) => r.goalID === goal.id)!
    expect(rt.phase).toBe("running")
    expect(rt.consecutiveFailures).toBe(0)
    expect(rt.activeRunID).toBeTruthy()
    expect(calls).toBe(1)

    // A second explicit nudge dispatches exactly once more — no hidden retry.
    await svc.nudge(dir, goal.id)
    expect(calls).toBe(2)
  })

  it("superseded failure does not release the newer lease", async () => {
    const host = createFakeHost()
    // Two service instances, one directory: models the restart/multi-driver
    // interleave the run fence exists for (the per-goal mutex cannot overlap
    // within a single instance).
    const svcA = createGoalService(host)
    const svcB = createGoalService(host)
    const { goal } = await svcA.start(dir, {
      name: "fence",
      objective: "legacy work",
      ownerSessionID: "owner-1",
      config: { workspaceWrite: false },
    })
    let calls = 0
    let enteredFirst = false
    let releaseFirst!: (error: unknown) => void
    const gate = new Promise<never>((_, reject) => { releaseFirst = reject })
    const innerPrompt = host.promptWorker.bind(host)
    host.promptWorker = async (input) => {
      calls++
      if (calls === 1) {
        enteredFirst = true
        await gate
      }
      return innerPrompt(input)
    }

    const pendingA = svcA.nudge(dir, goal.id)
    for (let i = 0; i < 100 && !enteredFirst; i++) await delay(25)
    expect(enteredFirst).toBe(true)
    // B clears A's run, acquires a newer run, and dispatches fine.
    const nudgedB = await svcB.nudge(dir, goal.id)
    expect(nudgedB.ok).toBe(true)
    // A's dispatch now fails late: its run no longer owns the lease.
    releaseFirst(new Error("injected late failure"))
    await expect(pendingA).rejects.toThrow("injected late failure")

    // B's lease is intact and no failure was consumed by A's late error.
    const post = await readState(dir)
    const rt = post.runtimes.find((r) => r.goalID === goal.id)!
    expect(rt.phase).toBe("running")
    expect(rt.consecutiveFailures).toBe(0)
    expect(calls).toBe(2)
  })

  it("nudge holds while the provider retry time is in the future", async () => {
    const host = createFakeHost()
    const svc = createGoalService(host)
    const { goal } = await svc.start(dir, {
      name: "quota",
      objective: "legacy work",
      ownerSessionID: "owner-1",
      config: { workspaceWrite: false },
    })
    const promptsBefore = host.prompts.length
    await mutateState(dir, "test.seed-limit", async (s) => {
      const g = s.goals.find((x) => x.id === goal.id)!
      g.lastProviderLimit = {
        kind: "rate-limit",
        source: "prompt-delivery",
        observedAt: new Date().toISOString(),
        retryAt: new Date(Date.now() + 60_000).toISOString(),
      }
      return s
    })

    const held = await svc.nudge(dir, goal.id)
    expect(held.ok).toBe(false)
    expect(held.message).toContain("retry after")
    expect(host.prompts.length).toBe(promptsBefore)

    // Past retry time: nudge proceeds.
    await mutateState(dir, "test.expire-limit", async (s) => {
      const g = s.goals.find((x) => x.id === goal.id)!
      g.lastProviderLimit = { ...g.lastProviderLimit!, retryAt: new Date(Date.now() - 1000).toISOString() }
      return s
    })
    const released = await svc.nudge(dir, goal.id)
    expect(released.ok).toBe(true)
    expect(host.prompts.length).toBe(promptsBefore + 1)

    // Observation for a model no longer configured: no hold.
    await mutateState(dir, "test.stale-model-limit", async (s) => {
      const g = s.goals.find((x) => x.id === goal.id)!
      g.lastProviderLimit = { ...g.lastProviderLimit!, model: "someone/else", retryAt: new Date(Date.now() + 60_000).toISOString() }
      return s
    })
    const other = await svc.nudge(dir, goal.id)
    expect(other.ok).toBe(true)
  })

  it("host acceptance bounds resolve instead of stalling (v1 hangs, v2 slow)", async () => {
    const hanging = () => new Promise<never>(() => {})
    const v1 = createRealHost(
      { session: { status: hanging, messages: hanging } },
      dir,
    )
    // Parallel: independent bounds share one ~10s window instead of three
    // sequential waits. v1 hangs must resolve unknown/[]; a slow-but-healthy
    // v2 acceptance must still succeed (bound is not hair-trigger).
    const statuses = new Map()
    const v2 = createV2Host(
      {
        location: { directory: dir },
        session: {
          prompt: async () => {
            await delay(1500)
            return { id: "msg_slow" }
          },
        },
      } as any,
      statuses as any,
    )
    const [status, messages, accepted] = await Promise.all([
      v1.sessionStatus("any-session"),
      v1.readMessages("any-session", 5),
      v2.promptWorker({ sessionID: "s-slow", prompt: "hello" }),
    ])
    expect(status).toBe("unknown")
    expect(messages).toEqual([])
    expect(accepted.messageID).toBe("msg_slow")
  }, 30_000)

  it("hung resume does not block unrelated controls and reports stage on timeout", async () => {
    const host = createFakeHost()
    const client = createControlClient(dir)
    const worker = createControlWorker({
      directory: dir,
      goalService: createGoalService(host),
      pollIntervalMs: 50,
      defaults: { defaultAgent: "smart-agent", defaultChecks: ["true"] },
    })
    worker.start()
    try {
      const mkCmd = (command: string, goalID?: string, args?: Record<string, unknown>) => ({
        version: 1 as const,
        requestID: crypto.randomUUID(),
        requestedAt: new Date().toISOString(),
        command,
        ...(goalID ? { goalID } : {}),
        ...(args ? { args } : {}),
      })
      const startA = await client.execute(mkCmd("start", undefined, {
        name: "stall-a", objective: "work a", config: { workspaceWrite: false }, ownerSessionID: "owner-1",
      }))
      const startB = await client.execute(mkCmd("start", undefined, {
        name: "free-b", objective: "work b", config: { workspaceWrite: false }, ownerSessionID: "owner-1",
      }))
      expect(startA.ok).toBe(true)
      expect(startB.ok).toBe(true)
      const state = await client.getState()
      const idA = state.goals.find((g) => g.name === "stall-a")!.id
      const idB = state.goals.find((g) => g.name === "free-b")!.id
      const workerA = state.goals.find((g) => g.name === "stall-a")!.workerSessionID!

      // Wedge ONLY A's prompt dispatch (never resolves): the resume handler
      // stays open past the client deadline.
      const innerPrompt = host.promptWorker.bind(host)
      host.promptWorker = async (input) => {
        if (input.sessionID === workerA) await new Promise<never>(() => {})
        return innerPrompt(input)
      }

      // Fire the wedged nudge without awaiting; once claimed (50ms poll —
      // 300ms here is a 6x margin), unrelated work must still proceed. The
      // 2.5s client cap is ~25x the expected claim latency; the timeout path
      // itself is what carries the stage assertion.
      const stalledPromise = client.execute(mkCmd("nudge", idA), 2500)
      for (let i = 0; i < 60; i++) {
        try {
          await fs.stat(path.join(dir, ".opencode", "loopd", "control", "processing"))
          const files = await fs.readdir(path.join(dir, ".opencode", "loopd", "control", "processing"))
          if (files.length > 0) break
        } catch {}
        await delay(50)
      }

      // Unrelated goal proceeds while A's handler is still wedged.
      const freed = await client.execute(mkCmd("pause", idB), 10000)
      expect(freed.ok).toBe(true)

      const stalled = await stalledPromise
      expect(stalled.ok).toBe(false)
      expect(stalled.errorCode).toBe("timeout")
      expect(stalled.message).toContain("accepted by the server")
      expect(stalled.message).toContain("still processing")
    } finally {
      await worker.stop()
    }
  }, 30_000)
})
