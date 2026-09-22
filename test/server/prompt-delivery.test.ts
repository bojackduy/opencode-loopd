import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { promises as fs } from "fs"
import path from "path"
import os from "os"
import { createGoalService, GoalStartError } from "../../src/application/goal-service"
import { readState } from "../../src/infrastructure/state-repository"
import { createFakeHost, createRealHost, createV2Host } from "../../src/server/host-adapter"

function tmpDir(): string {
  return path.join(os.tmpdir(), `loopd-delivery-test-${crypto.randomUUID()}`)
}

describe("prompt delivery failure and recovery", () => {
  let dir: string

  beforeEach(async () => {
    dir = tmpDir()
    await fs.mkdir(dir, { recursive: true })
  })

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it("startup prompt failure persists a blocked goal with IDs and reuses the worker on retry", async () => {
    const host = createFakeHost()
    let creates = 0
    const innerCreate = host.createWorker.bind(host)
    host.createWorker = async (input) => { creates++; return innerCreate(input) }
    let prompts = 0
    const innerPrompt = host.promptWorker.bind(host)
    host.promptWorker = async (input) => {
      prompts++
      if (prompts === 1) throw new Error("simulated delivery outage")
      return innerPrompt(input)
    }
    const svc = createGoalService(host)

    let caught: unknown
    try {
      await svc.start(dir, {
        name: "flaky-start",
        objective: "do something",
        ownerSessionID: "owner-1",
        config: { workspaceWrite: false },
      })
    } catch (error) { caught = error }

    // Structured failure carries the persisted goal — resume it, don't duplicate it.
    expect(caught).toBeInstanceOf(GoalStartError)
    const failure = caught as GoalStartError
    expect(failure.failedStage).toBe("prompt_delivery")
    expect(failure.workerSessionID).toBeTruthy()

    const blocked = (await readState(dir)).goals.find((g) => g.id === failure.goalID)
    expect(blocked?.status).toBe("blocked")
    expect(blocked?.workerSessionID).toBe(failure.workerSessionID)
    expect(blocked?.blocker?.reason).toContain("Worker prompt delivery failed")
    // Lease released so retry can proceed.
    expect((await readState(dir)).runtimes.find((r) => r.goalID === failure.goalID)?.phase).not.toBe("running")

    await svc.retry(dir, failure.goalID)
    const recovered = (await readState(dir)).goals.find((g) => g.id === failure.goalID)
    expect(recovered?.status).toBe("active")
    // Same worker session reused — no duplicate worker created.
    expect(creates).toBe(1)
    expect(recovered?.workerSessionID).toBe(failure.workerSessionID)
  })

  it("worker creation failure reports the persisted goal ID and stage", async () => {
    const host = createFakeHost()
    host.createWorker = async () => { throw new Error("session store down") }
    const svc = createGoalService(host)

    let caught: unknown
    try {
      await svc.start(dir, {
        name: "no-worker",
        objective: "do something",
        ownerSessionID: "owner-1",
        config: { workspaceWrite: false },
      })
    } catch (error) { caught = error }

    expect(caught).toBeInstanceOf(GoalStartError)
    const failure = caught as GoalStartError
    expect(failure.failedStage).toBe("worker_create")
    expect(failure.workerSessionID).toBeUndefined()
    expect((await readState(dir)).goals.find((g) => g.id === failure.goalID)?.status).toBe("blocked")
  })

  it("startup prompt IDs use the dual-host msg_ spelling", async () => {
    const host = createFakeHost()
    const svc = createGoalService(host)
    await svc.start(dir, {
      name: "id-spelling",
      objective: "do something",
      ownerSessionID: "owner-1",
      config: { workspaceWrite: false },
    })
    const runtime = (await readState(dir)).runtimes[0]
    expect(runtime.activePromptMessageID!.startsWith("msg_")).toBe(true)
    const transcript = await host.readMessages((await readState(dir)).goals[0].workerSessionID!, 10)
    expect(transcript[0].messageID).toBe(runtime.activePromptMessageID)
  })

  it("starts end-to-end on the v2 adapter (the failing session's path)", async () => {
    const prompted: any[] = []
    const context = {
      location: { directory: dir },
      session: {
        create: async (input: any) => ({ id: "worker-v2-smoke", ...input }),
        switchAgent: async () => {},
        switchModel: async () => {},
        // Enforce the real v2 SessionMessage.ID contract.
        prompt: async (input: any) => {
          prompted.push(input)
          if (input.id !== undefined && !String(input.id).startsWith("msg_")) {
            throw new Error(`Expected a string starting with "msg_"\n  at ["id"]`)
          }
          return { id: input.id ?? "msg_generated" }
        },
        get: async () => { throw new Error("not found") },
        context: async () => [],
        command: async () => {},
        interrupt: async () => {},
      },
    } as any
    const svc = createGoalService(createV2Host(context, new Map()))

    const { goal, worker } = await svc.start(dir, {
      name: "v2-smoke",
      objective: "Write /tmp/loopd-smoke.txt containing 'Hello from loopd subagent test!'",
      ownerSessionID: "owner-v2",
      config: { workspaceWrite: false, checks: ["true"] },
    })

    expect(goal.status).toBe("active")
    expect(worker.workerSessionID).toBe("worker-v2-smoke")
    // The delivered prompt ID is the persisted one, with v2 spelling.
    const promptID = (await readState(dir)).runtimes[0].activePromptMessageID!
    expect(prompted).toHaveLength(1)
    expect(prompted[0].id).toBe(promptID)
  })

  it("starts end-to-end on the v1 adapter with the same msg_ spelling", async () => {
    const bodies: any[] = []
    const host = createRealHost({
      session: {
        create: async ({ body }: any) => ({ data: { id: "worker-v1-smoke" } }),
        // Enforce the real v1 MessageID contract ("msg" prefix).
        promptAsync: async ({ body }: any) => {
          bodies.push(body)
          if (body.messageID !== undefined && !String(body.messageID).startsWith("msg")) {
            return { error: { name: "BadRequest", message: "invalid messageID" } }
          }
          return { data: {} }
        },
        get: async () => ({ error: { name: "NotFound", message: "no" } }),
      },
    }, dir)
    const svc = createGoalService(host)

    const { goal } = await svc.start(dir, {
      name: "v1-smoke",
      objective: "do something",
      ownerSessionID: "owner-v1",
      config: { workspaceWrite: false, checks: ["true"] },
    })

    expect(goal.status).toBe("active")
    const promptID = (await readState(dir)).runtimes[0].activePromptMessageID!
    expect(bodies).toHaveLength(1)
    expect(bodies[0].messageID).toBe(promptID)
  })

  it("writer conflict names the owning session and the list scope", async () => {
    const host = createFakeHost()
    const svc = createGoalService(host)
    await svc.start(dir, {
      name: "writer-a",
      objective: "do something",
      ownerSessionID: "ses_owner",
    })

    let message = ""
    try {
      await svc.start(dir, {
        name: "writer-b",
        objective: "do something else",
        ownerSessionID: "ses_other",
      })
    } catch (error) { message = error instanceof Error ? error.message : String(error) }

    expect(message).toContain('"writer-a"')
    expect(message).toContain("ses_owner")
    expect(message).toContain("list_background_goals shows only this session's goals")
  })
})
