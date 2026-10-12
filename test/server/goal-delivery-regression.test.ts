import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { promises as fs } from "fs"
import path from "path"
import os from "os"
import { createGoalService } from "../../src/application/goal-service"
import { acknowledgeGoalInbox, appendGoalInbox, mutateState, peekGoalInbox, readEvents, readState, snapshotGoalInbox } from "../../src/infrastructure/state-repository"
import { createFakeHost, createRealHost } from "../../src/server/host-adapter"
import { ownerTools } from "../../src/server/owner-tools"
import { createControlWorker } from "../../src/application/control-worker"
import { createControlClient } from "../../src/infrastructure/control-client"
import { goalTools } from "../../src/server/goal-tools"
import { createLoopEngine } from "../../src/application/loop-engine"
import { wakeGoalForAwait } from "../../src/application/command-await"
import { afterWorkspaceTool, beforeWorkspaceTool, withWorkspaceOperation } from "../../src/application/workspace-execution"

async function waitFor(condition: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 6000
  while (!await condition()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for delivery regression")
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe("truthful goal delivery regressions", () => {
  let dir: string
  let host: ReturnType<typeof createFakeHost>
  let service: ReturnType<typeof createGoalService>
  const engines: ReturnType<typeof createLoopEngine>[] = []

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "loopd-delivery-test-"))
    host = createFakeHost({ autoCompletePrompts: false })
    service = createGoalService(host)
  })

  afterEach(async () => {
    for (const engine of engines.splice(0)) engine.stop()
    await fs.rm(dir, { recursive: true, force: true })
  })

  async function start() {
    return service.start(dir, {
      name: "delivery fixture",
      objective: "test delivery without a real host",
      ownerSessionID: "owner",
      config: { workspaceWrite: false },
    })
  }

  it("nudge reports a live reservation instead of claiming a prompt was sent", async () => {
    const { goal } = await start()
    await mutateState(dir, "test.reserve", async (state) => {
      state.workspaceCalls = [{
        callID: "live-write",
        goalID: goal.id,
        sessionID: goal.workerSessionID!,
        generation: state.runtimes[0].runGeneration,
        paths: ["source.ts"],
        at: new Date().toISOString(),
      }]
      return state
    })
    const calls = host.promptCalls.length
    const result = await service.nudge(dir, goal.id)
    expect(host.promptCalls).toHaveLength(calls)
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/in-flight|reservation|write/i)
    expect((await readState(dir)).workspaceCalls).toHaveLength(1)
  })

  it("nudge reports a workspace operation instead of claiming a prompt was sent", async () => {
    const { goal } = await start()
    await mutateState(dir, "test.operation", async (state) => {
      state.workspaceOperation = { id: "verification", goalID: goal.id, sessionID: "owner" }
      return state
    })
    const calls = host.promptCalls.length
    const result = await service.nudge(dir, goal.id)
    expect(host.promptCalls).toHaveLength(calls)
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/workspace|verification|operation/i)
  })

  it("nudge reports a pending identity on a busy worker without discarding it", async () => {
    const { goal } = await start()
    await mutateState(dir, "test.pending-identity", async (state) => {
      state.goals[0].pendingIdentity = { model: "openai/next", agent: "researcher" }
      return state
    })
    host.sessionStatus = async () => "busy"
    const calls = host.promptCalls.length
    const result = await service.nudge(dir, goal.id)
    expect(host.promptCalls).toHaveLength(calls)
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/identity|idle|busy/i)
    expect((await readState(dir)).goals[0].pendingIdentity).toEqual({ model: "openai/next", agent: "researcher" })
  })

  it("a genuinely busy worker keeps its lease and prompt correlation after rejected nudge", async () => {
    const { goal } = await start()
    const before = (await readState(dir)).runtimes[0]
    host.sessionStatus = async () => "busy"
    const result = await service.nudge(dir, goal.id)
    expect(result).toMatchObject({ ok: false, outcome: "blocked" })
    expect(host.promptCalls).toHaveLength(1)
    const after = (await readState(dir)).runtimes[0]
    expect(after.activeRunID).toBe(before.activeRunID)
    expect(after.activePromptMessageID).toBe(before.activePromptMessageID)
    expect(after.leaseExpiresAt).toBe(before.leaseExpiresAt)
  })

  it("host submission is reported as sent, not confirmed worker activity", async () => {
    const { goal } = await start()
    host.promptWorker = async ({ messageID }) => ({ messageID: messageID! })
    const result = await service.nudge(dir, goal.id)
    expect(result).toMatchObject({ ok: true, outcome: "sent", goalID: goal.id, workerSessionID: goal.workerSessionID })
    expect(result.message).toContain("not yet confirmed")
    expect(result.promptMessageID).toBeTruthy()
    expect(result.runGeneration).toBeGreaterThan(0)
    expect(host.messages.get(goal.workerSessionID!)!.some((message) => message.messageID === result.promptMessageID)).toBe(false)
    const runtime = (await readState(dir)).runtimes[0]
    expect(runtime.activePromptDispatchAt).toBeTruthy()
    expect(runtime.activePromptAcceptedAt).toBeTruthy()
    expect(runtime.activePromptObservedAt).toBeUndefined()
  })

  it("unknown worker status cannot overwrite a possibly accepted outstanding prompt", async () => {
    const { goal } = await start()
    const before = (await readState(dir)).runtimes[0]
    host.sessionStatus = async () => "unknown"
    const result = await service.nudge(dir, goal.id)
    expect(result).toMatchObject({ ok: false, outcome: "blocked" })
    expect(result.message).toMatch(/unknown|unconfirmed/i)
    expect(host.promptCalls).toHaveLength(1)
    expect((await readState(dir)).runtimes[0].activePromptMessageID).toBe(before.activePromptMessageID)
  })

  it("inbox acknowledgement is idempotent and retains identical words appended later", async () => {
    const { goal } = await start()
    await appendGoalInbox(dir, goal.id, "user", "same words")
    const snapshot = await snapshotGoalInbox(dir, goal.id)
    await appendGoalInbox(dir, goal.id, "user", "same words")
    await acknowledgeGoalInbox(dir, goal.id, snapshot.lines)
    await acknowledgeGoalInbox(dir, goal.id, snapshot.lines)
    expect(await peekGoalInbox(dir, goal.id)).toEqual(["[user] same words"])
  })

  it("resume of a cleared ID returns not_found and never recreates a worker", async () => {
    const { goal } = await start()
    await service.clear(dir, goal.id)
    const calls = host.promptCalls.length
    const result = await service.resume(dir, goal.id)
    expect(result).toMatchObject({ ok: false, outcome: "not_found" })
    expect(await service.nudge(dir, goal.id)).toMatchObject({ ok: false })
    expect(await service.sendUserMessage(dir, goal.id, "remembered ID")).toMatchObject({ ok: false })
    expect(host.promptCalls).toHaveLength(calls)
    expect((await readState(dir)).goals).toHaveLength(0)
    expect((await readState(dir)).runtimes).toHaveLength(0)
    expect(service.getWorker(goal.id)).toBeUndefined()
  })

  it("context preparation failure releases the lease and retains owner inbox", async () => {
    const { goal } = await start()
    await appendGoalInbox(dir, goal.id, "user", "keep these words")
    host.readMessages = async () => [{
      role: "assistant", content: "bad host usage", messageID: "bad-usage", completedAt: new Date().toISOString(),
      get tokens(): never { throw new Error("usage preparation rejected") },
    }]
    await expect(service.nudge(dir, goal.id)).rejects.toThrow("usage preparation rejected")
    const runtime = (await readState(dir)).runtimes[0]
    expect(runtime.phase).not.toBe("running")
    expect(runtime.activeRunID).toBeUndefined()
    expect(await peekGoalInbox(dir, goal.id)).toEqual(["[user] keep these words"])
    expect(host.promptCalls).toHaveLength(1)
  })

  it("bare delivery failure retains owner words for a later safe turn", async () => {
    const { goal } = await start()
    host.promptWorker = async () => { throw new Error("offline") }
    await expect(service.sendUserMessage(dir, goal.id, "do not lose me")).rejects.toThrow("offline")
    expect(await peekGoalInbox(dir, goal.id)).toEqual(["[user] do not lose me"])
  })

  it("a reservation appearing during context preparation prevents dispatch", async () => {
    const { goal } = await start()
    host.readMessages = async () => {
      await mutateState(dir, "test.late-reservation", async (state) => {
        state.workspaceCalls = [{ callID: "late", sessionID: goal.workerSessionID!, goalID: goal.id,
          generation: state.runtimes[0].runGeneration, paths: ["source.ts"], at: new Date().toISOString() }]
        return state
      })
      return []
    }
    const result = await service.nudge(dir, goal.id)
    expect(result).toMatchObject({ ok: false, outcome: "blocked" })
    expect(host.promptCalls).toHaveLength(1)
    expect((await readState(dir)).workspaceCalls).toHaveLength(1)
  })

  it("clear during context preparation prevents dispatch and removes the stale cache link", async () => {
    const { goal } = await start()
    const otherService = createGoalService(host)
    host.readMessages = async () => {
      await otherService.clear(dir, goal.id)
      return []
    }
    const result = await service.nudge(dir, goal.id)
    expect(result).toMatchObject({ ok: false, outcome: "not_found" })
    expect(host.promptCalls).toHaveLength(1)
    expect(service.getWorker(goal.id)).toBeUndefined()
    expect((await readState(dir)).goals).toHaveLength(0)
  })

  for (const action of ["resume_goal", "nudge_goal", "send_goal_input"] as const) {
    it(`owner ${action} distinguishes cleared ID from unauthorized without targeting another goal`, async () => {
      const { goal } = await start()
      await service.clear(dir, goal.id)
      const other = await start()
      const tools = ownerTools({ directory: dir, host, goalService: service })
      const args = { goal_id: goal.id, message: "remembered ID" }
      const result = await tools[action].execute(args, { sessionID: "owner" } as never)
      expect(JSON.parse(result.output)).toMatchObject({ ok: false, outcome: "not_found" })
      const unauthorized = await tools[action].execute({ ...args, goal_id: other.goal.id }, { sessionID: "intruder" } as never)
      expect(JSON.parse(unauthorized.output)).toMatchObject({ ok: false, outcome: "unauthorized" })
      expect(unauthorized.output).not.toContain(other.goal.name)
      expect(host.promptCalls).toHaveLength(2)
      expect((await readState(dir)).goals).toHaveLength(1)
    })
  }

  for (const command of ["resume", "retry", "nudge", "send"]) {
    it(`real control ${command} returns not_found for a cleared explicit ID`, async () => {
      const { goal } = await start()
      await service.clear(dir, goal.id)
      await start()
      const control = createControlWorker({ directory: dir, goalService: service, pollIntervalMs: 10 })
      control.start()
      try {
        const result = await createControlClient(dir).executeRaw({ command, goalID: goal.id, args: { message: "remembered ID" } })
        expect(result).toMatchObject({ ok: false, errorCode: "not_found" })
        expect(host.promptCalls).toHaveLength(2)
        expect((await readState(dir)).goals).toHaveLength(1)
      } finally { await control.stop() }
    })
  }

  it("clear during session creation retires the orphan instead of caching it", async () => {
    const { goal } = await start()
    await service.pause(dir, goal.id)
    await mutateState(dir, "test.detach", async (state) => { state.goals[0].workerSessionID = undefined; return state })
    service = createGoalService(host)
    const otherService = createGoalService(host)
    const create = host.createWorker.bind(host)
    let orphanID: string | undefined
    host.createWorker = async (input) => {
      await otherService.clear(dir, goal.id)
      const created = await create(input)
      orphanID = typeof created === "string" ? created : created.sessionID
      return created
    }
    const result = await service.resume(dir, goal.id)
    expect(result).toMatchObject({ ok: false, outcome: "not_found" })
    expect(service.getWorker(goal.id)).toBeUndefined()
    expect(host.sessions.has(orphanID!)).toBe(false)
    expect((await readState(dir)).goals).toHaveLength(0)
  })

  it("retired worker tools deny authority with an actionable cleared/retired reason", async () => {
    const { goal } = await start()
    await service.clear(dir, goal.id)
    const tools = goalTools(dir, service)
    await expect(tools.get_goal.execute({}, { sessionID: goal.workerSessionID! } as never)).rejects.toThrow(/cleared|retired/i)
    await expect(tools.report_goal_progress.execute({ summary: "late", next: "none", evidence: "late" }, { sessionID: goal.workerSessionID! } as never)).rejects.toThrow(/cleared|retired/i)
    expect((await readState(dir)).goals).toHaveLength(0)
  })

  for (const action of ["nudge", "send"] as const) {
    it(`clear during ${action} status probe is terminal, with no orphan inbox/cache`, async () => {
      const { goal } = await start()
      const other = createGoalService(host)
      host.sessionStatus = async () => { await other.clear(dir, goal.id); return "idle" }
      const result = action === "nudge" ? await service.nudge(dir, goal.id) : await service.sendUserMessage(dir, goal.id, "late words")
      expect(result).toMatchObject({ ok: false, outcome: "not_found" })
      expect(await peekGoalInbox(dir, goal.id)).toEqual([])
      expect(service.getWorker(goal.id)).toBeUndefined()
      expect(host.promptCalls).toHaveLength(1)
    })
  }

  for (const delivery of ["success", "failure"] as const) {
    it(`late host ${delivery} after clear cannot claim delivery, recreate runtime, or retain cache`, async () => {
      const { goal } = await start()
      const other = createGoalService(host)
      host.promptWorker = async ({ messageID }) => {
        await other.clear(dir, goal.id)
        if (delivery === "failure") throw new Error("late host error")
        return { messageID: messageID! }
      }
      const result = await service.nudge(dir, goal.id)
      expect(result).toMatchObject({ ok: false, outcome: "not_found" })
      expect(service.getWorker(goal.id)).toBeUndefined()
      const state = await readState(dir)
      expect(state.goals).toHaveLength(0)
      expect(state.runtimes).toHaveLength(0)
      expect(state.retiredWorkerSessions).toContain(goal.workerSessionID!)
    })
  }

  it("a concurrent valid lease wins acquisition without an extra host prompt", async () => {
    const { goal } = await start()
    await mutateState(dir, "test.idle", async (state) => { state.runtimes[0].phase = "idle"; state.runtimes[0].leaseExpiresAt = undefined; return state })
    host.sessionStatus = async () => {
      await mutateState(dir, "test.racing-lease", async (state) => {
        state.runtimes[0].phase = "running"
        state.runtimes[0].activeRunID = "winning-run" as never
        state.runtimes[0].leaseExpiresAt = new Date(Date.now() + 60_000).toISOString()
        return state
      })
      return "idle"
    }
    const result = await service.continueTurn(dir, goal.id)
    expect(result).toMatchObject({ ok: false, outcome: "blocked" })
    expect(host.promptCalls).toHaveLength(1)
    expect((await readState(dir)).runtimes[0].activeRunID).toBe("winning-run" as never)
  })

  it("a superseded late host success cannot report a current delivered turn or acknowledge its inbox", async () => {
    const { goal } = await start()
    await appendGoalInbox(dir, goal.id, "user", "preserve superseded words")
    host.promptWorker = async ({ messageID }) => {
      await mutateState(dir, "test.superseded-success", async (state) => {
        const rt = state.runtimes[0]
        rt.runGeneration++
        rt.activeRunID = "newer-run" as never
        rt.activePromptMessageID = "msg_newer_prompt"
        rt.activePromptAcceptedAt = undefined
        return state
      })
      return { messageID: messageID! }
    }
    expect(await service.nudge(dir, goal.id)).toMatchObject({ ok: false, outcome: "blocked" })
    const runtime = (await readState(dir)).runtimes[0]
    expect(runtime.activeRunID).toBe("newer-run" as never)
    expect(runtime.activePromptMessageID).toBe("msg_newer_prompt")
    expect(runtime.activePromptAcceptedAt).toBeUndefined()
    expect(await peekGoalInbox(dir, goal.id)).toEqual(["[user] preserve superseded words"])
  })

  for (const blocker of ["busy", "reservation"] as const) {
    it(`command-await recovery reports ${blocker} instead of wiping a live turn and claiming wake`, async () => {
      const { goal } = await start()
      await appendGoalInbox(dir, goal.id, "user", "command exited")
      const before = (await readState(dir)).runtimes[0]
      if (blocker === "busy") host.sessionStatus = async () => "busy"
      else await mutateState(dir, "test.await-reservation", async (state) => {
        state.workspaceCalls = [{ callID: "await-write", sessionID: goal.workerSessionID!, goalID: goal.id,
          paths: ["source.ts"], at: new Date().toISOString() }]
        return state
      })
      expect((await wakeGoalForAwait(dir, service, goal.id)).woke).toBe(false)
      const runtime = (await readState(dir)).runtimes[0]
      expect(runtime.activeRunID).toBe(before.activeRunID)
      expect(runtime.activePromptMessageID).toBe(before.activePromptMessageID)
      expect(runtime.leaseExpiresAt).toBe(before.leaseExpiresAt)
      expect(await peekGoalInbox(dir, goal.id)).toEqual(["[user] command exited"])
      expect(host.promptCalls).toHaveLength(1)
    })
  }

  it("late engine completion and status events for a cleared worker cannot resurrect state", async () => {
    const { goal } = await start()
    const runtime = (await readState(dir)).runtimes[0]
    const engine = createLoopEngine({ directory: dir, host, goalService: service })
    engines.push(engine)
    engine.start()
    await engine.preloadWorkerSessions()
    await service.clear(dir, goal.id)
    await engine.handleEvent({ type: "message.updated", properties: { info: { id: "late-assistant", sessionID: goal.workerSessionID,
      parentID: runtime.activePromptMessageID, role: "assistant", time: { completed: Date.now() } } } })
    await engine.handleEvent({ type: "session.status", properties: { sessionID: goal.workerSessionID, status: { type: "busy" } } })
    await engine.handleEvent({ type: "session.idle", properties: { sessionID: goal.workerSessionID } })
    const state = await readState(dir)
    expect(state.goals).toHaveLength(0)
    expect(state.runtimes).toHaveLength(0)
    expect(service.getWorker(goal.id)).toBeUndefined()
    expect(host.promptCalls).toHaveLength(1)
    expect(await appendGoalInbox(dir, goal.id, "host", "late callback")).toBe(false)
    expect(await peekGoalInbox(dir, goal.id)).toEqual([])
  })

  it("terminal clear retains old/superseded write fences until actual after-hook completion", async () => {
    const { goal } = await start()
    await mutateState(dir, "test.old-live-call", async (state) => {
      state.workspaceCalls = [{ callID: "still-writing", sessionID: goal.workerSessionID!, goalID: goal.id,
        generation: 0, paths: ["source.ts"], at: new Date(Date.now() - 24 * 3600_000).toISOString() }]
      return state
    })
    expect(await service.nudge(dir, goal.id)).toMatchObject({ ok: false, outcome: "blocked" })
    await service.clear(dir, goal.id)
    await service.reconcile(dir)
    const state = await readState(dir)
    expect(state.goals).toHaveLength(0)
    expect(state.runtimes).toHaveLength(0)
    expect(state.workspaceCalls).toHaveLength(1)
    await expect(service.start(dir, { name: "new writer", objective: "test", ownerSessionID: "owner", config: { workspaceWrite: true, checks: ["true"] } })).rejects.toThrow(/in-flight|call/i)
    await expect(withWorkspaceOperation(dir, "any", "owner", async () => {})).rejects.toThrow("busy")
    await expect(beforeWorkspaceTool(dir, { tool: "write", sessionID: goal.workerSessionID!, callID: "new-late" }, { filePath: "source.ts" })).rejects.toThrow(/retired/i)
    await afterWorkspaceTool(dir, goal.workerSessionID!, "still-writing")
    expect((await readState(dir)).workspaceCalls).toHaveLength(0)
  })

  it("terminal clear preserves an in-flight verification operation until its finally completes", async () => {
    const { goal } = await start()
    let release!: () => void
    let entered!: () => void
    const started = new Promise<void>((resolve) => { entered = resolve })
    const wait = new Promise<void>((resolve) => { release = resolve })
    const operation = withWorkspaceOperation(dir, goal.id, goal.workerSessionID!, async () => { entered(); await wait })
    await started
    try {
      await service.clear(dir, goal.id)
      expect((await readState(dir)).goals).toHaveLength(0)
      expect((await readState(dir)).workspaceOperation?.goalID).toBe(goal.id)
      await expect(withWorkspaceOperation(dir, "any", "owner", async () => {})).rejects.toThrow("busy")
    } finally { release(); await operation }
    expect((await readState(dir)).workspaceOperation).toBeUndefined()
  })

  it("v1 throwing apply_patch with missed after-hook drains exact terminal error evidence once", async () => {
    const { goal } = await start()
    const at = Date.now()
    await mutateState(dir, "test.missed-error-after", async (state) => {
      state.workspaceCalls = [{ callID: "patch-error", sessionID: goal.workerSessionID!, goalID: goal.id,
        generation: state.runtimes[0].runGeneration, paths: ["source.ts"], at: new Date(at).toISOString() }]
      return state
    })
    const engine = createLoopEngine({ directory: dir, host, goalService: service })
    engines.push(engine)
    engine.start()
    const part = { type: "tool", tool: "apply_patch", sessionID: goal.workerSessionID, callID: "patch-error", messageID: "assistant-patch",
      state: { status: "error", error: "apply_patch verification failed: expected lines", time: { start: at, end: at + 1 } } }
    await engine.handleEvent({ type: "message.part.updated", properties: { part } })
    expect((await readState(dir)).workspaceCalls).toHaveLength(0)
    expect(await service.nudge(dir, goal.id)).toMatchObject({ ok: true, outcome: "sent" })
    await engine.handleEvent({ type: "message.part.updated", properties: { part } })
    expect((await readState(dir)).workspaceCalls).toHaveLength(0)
  })

  it("terminal event never releases a running/unknown/different-session or newer reservation", async () => {
    const { goal } = await start()
    const at = Date.now()
    await mutateState(dir, "test.unproved-call", async (state) => {
      state.workspaceCalls = [{ callID: "patch-unknown", sessionID: goal.workerSessionID!, goalID: goal.id, paths: ["source.ts"], at: new Date(at).toISOString() }]
      return state
    })
    const engine = createLoopEngine({ directory: dir, host, goalService: service })
    engines.push(engine)
    engine.start()
    for (const part of [
      { type: "tool", sessionID: goal.workerSessionID, callID: "patch-unknown", state: { status: "running", time: { start: at } } },
      { type: "tool", sessionID: goal.workerSessionID, callID: "patch-unknown", state: { status: "error" } },
      { type: "tool", sessionID: "other-session", callID: "patch-unknown", state: { status: "error", time: { end: at + 1 } } },
      { type: "tool", sessionID: goal.workerSessionID, callID: "patch-unknown", state: { status: "error", time: { end: at - 1 } } },
    ]) {
      await engine.handleEvent({ type: "message.part.updated", properties: { part } })
      expect((await readState(dir)).workspaceCalls).toHaveLength(1)
    }
  })

  it("v1 public transcript recovery drains missed terminal parts but retains running/unknown calls", async () => {
    const { goal } = await start()
    const at = Date.now()
    await mutateState(dir, "test.transcript-error", async (state) => {
      state.workspaceCalls = ["failed-patch", "running-patch", "unknown-patch"].map((callID) => ({ callID, sessionID: goal.workerSessionID!, goalID: goal.id,
        paths: ["source.ts"], at: new Date(at).toISOString() }))
      return state
    })
    const real = createRealHost({ session: { messages: async (args: any) => {
      expect(args.path.id).toBe(goal.workerSessionID)
      expect(args.query?.limit).toBeUndefined()
      return { data: [{ parts: [
        { type: "tool", sessionID: goal.workerSessionID, callID: "failed-patch", state: { status: "error", error: "patch verification failed", time: { start: at, end: at + 1 } } },
        { type: "tool", sessionID: goal.workerSessionID, callID: "running-patch", state: { status: "running", time: { start: at } } },
        { type: "tool", sessionID: "other-session", callID: "unknown-patch", state: { status: "completed", time: { end: at + 1 } } },
      ] }] }
    } } }, dir)
    host.readToolExecutions = real.readToolExecutions
    await service.reconcile(dir)
    expect((await readState(dir)).workspaceCalls?.map((call) => call.callID)).toEqual(["running-patch", "unknown-patch"])
    await service.reconcile(dir)
    expect((await readState(dir)).workspaceCalls).toHaveLength(2)
    expect(await service.nudge(dir, goal.id)).toMatchObject({ ok: false, outcome: "blocked" })
  })

  it("terminal error after goal clear releases only its exact retired-session fence", async () => {
    const { goal } = await start()
    const at = Date.now()
    await mutateState(dir, "test.retired-error", async (state) => {
      state.workspaceCalls = [{ callID: "retired-patch", sessionID: goal.workerSessionID!, goalID: goal.id, paths: ["source.ts"], at: new Date(at).toISOString() }]
      return state
    })
    await service.clear(dir, goal.id)
    const engine = createLoopEngine({ directory: dir, host, goalService: service })
    engines.push(engine)
    engine.start()
    await engine.handleEvent({ type: "message.part.updated", properties: { part: { type: "tool", sessionID: goal.workerSessionID, callID: "retired-patch",
      state: { status: "error", time: { end: at + 1 } } } } })
    const state = await readState(dir)
    expect(state.workspaceCalls).toHaveLength(0)
    expect(state.goals).toHaveLength(0)
    expect(state.runtimes).toHaveLength(0)
    expect(state.retiredWorkerSessions).toContain(goal.workerSessionID!)
  })

  it("maintenance recovers a missed error after-hook and automatically sends exactly one turn", async () => {
    const { goal } = await start()
    const at = Date.now() - 600_000
    await mutateState(dir, "test.auto-terminal-recovery", async (state) => {
      const rt = state.runtimes[0]
      rt.lastActivityAt = rt.lastRunAt = rt.turnStartedAt = new Date(at).toISOString()
      rt.activeToolCallIDs = ["failed-auto-patch"]
      state.workspaceCalls = [{ callID: "failed-auto-patch", sessionID: goal.workerSessionID!, goalID: goal.id,
        generation: rt.runGeneration, paths: ["source.ts"], at: new Date(at).toISOString() }]
      return state
    })
    const real = createRealHost({ session: { messages: async () => ({ data: [{ parts: [
      { type: "tool", sessionID: goal.workerSessionID, callID: "failed-auto-patch", state: { status: "error", time: { end: at + 1 } } },
    ] }] }) } }, dir)
    host.readToolExecutions = real.readToolExecutions
    const prompt = host.promptWorker.bind(host)
    host.promptWorker = async (input) => {
      const result = await prompt(input)
      host.sessionStatus = async () => "busy"
      return result
    }
    const engine = createLoopEngine({ directory: dir, host, goalService: service, pollIntervalMs: 20, confirmIdleMs: 0, idleRecoverMs: 1 })
    engines.push(engine)
    engine.start()
    await waitFor(async () => (await readState(dir)).runtimes[0]?.activePromptAcceptedAt !== undefined && host.promptCalls.length === 2)
    engine.stop()
    const state = await readState(dir)
    expect(state.workspaceCalls).toHaveLength(0)
    expect(state.runtimes[0].activeToolCallIDs).toHaveLength(0)
    expect(state.runtimes[0].runGeneration).toBe(2)
    expect(host.promptCalls).toHaveLength(2)
    expect((await readEvents(dir, 100)).filter((event) => event.type === "run.started")).toHaveLength(2)
  })

  it("maintenance recovers a terminal read error in an idle runtime from session-bound message metadata", async () => {
    const { goal } = await start()
    const at = Date.now() - 600_000
    await mutateState(dir, "test.idle-missed-read", async (state) => {
      const rt = state.runtimes[0]
      rt.phase = "idle"
      rt.turnStartedAt = undefined
      rt.lastRunAt = new Date(at).toISOString()
      rt.activeToolCallIDs = ["failed-glob", "foreign-read", "older-read"]
      return state
    })
    let allowForeign = false
    const real = createRealHost({ session: { messages: async () => ({ data: [
      { info: { sessionID: goal.workerSessionID }, parts: [
        { type: "tool", callID: "failed-glob", state: { status: "error", time: { end: at + 1 } } },
        { type: "tool", callID: "older-read", state: { status: "completed", time: { end: at - 1 } } },
        { type: "tool", sessionID: "other-session", callID: "foreign-read", state: { status: "completed", time: { end: at + 1 } } },
        ...(allowForeign ? ["foreign-read", "older-read"].map((callID) => ({ type: "tool", callID, state: { status: "completed", time: { end: at + 2 } } })) : []),
      ] },
      { info: { sessionID: "other-session" }, parts: [
        { type: "tool", callID: "foreign-read", state: { status: "completed", time: { end: at + 1 } } },
      ] },
    ] }) } }, dir)
    host.readToolExecutions = real.readToolExecutions
    await service.reconcile(dir)
    expect((await readState(dir)).runtimes[0].activeToolCallIDs).toEqual(["foreign-read", "older-read"])
    expect(host.promptCalls).toHaveLength(1)
    allowForeign = true
    const prompt = host.promptWorker.bind(host)
    host.promptWorker = async (input) => {
      const result = await prompt(input)
      host.sessionStatus = async () => "busy"
      return result
    }
    const engine = createLoopEngine({ directory: dir, host, goalService: service, pollIntervalMs: 20, confirmIdleMs: 0 })
    engines.push(engine)
    engine.start()
    await waitFor(async () => host.promptCalls.length === 2 && (await readState(dir)).runtimes[0].activePromptAcceptedAt !== undefined)
    engine.stop()
    expect((await readState(dir)).runtimes[0].activeToolCallIDs).toEqual([])
    expect(host.promptCalls).toHaveLength(2)
  })

  it("a completed tool-call step cannot authorize idle continuation while another assistant step is running", async () => {
    const { goal } = await start()
    const promptID = (await readState(dir)).runtimes[0].activePromptMessageID!
    const at = Date.now()
    const real = createRealHost({ session: { messages: async () => ({ data: [
      { info: { id: promptID, role: "user", time: { created: at - 1 } }, parts: [] },
      { info: { id: "step-done", role: "assistant", parentID: promptID, finish: "tool-calls", time: { created: at, completed: at + 1 } }, parts: [] },
      { info: { id: "step-running", role: "assistant", parentID: promptID, time: { created: at + 2 } }, parts: [] },
    ] }) } }, dir)
    host.readMessages = real.readMessages
    const engine = createLoopEngine({ directory: dir, host, goalService: service, pollIntervalMs: 60_000, confirmIdleMs: 0 })
    engines.push(engine)
    engine.start()
    await engine.handleEvent({ type: "message.updated", properties: { info: { sessionID: goal.workerSessionID, id: "step-done", role: "assistant", parentID: promptID,
      finish: "tool-calls", time: { completed: at + 1 } } } })
    expect((await readState(dir)).runtimes[0].activeAssistantCompletedAt).toBeUndefined()
    await engine.handleEvent({ type: "session.idle", properties: { sessionID: goal.workerSessionID } })
    await engine.handleEvent({ type: "session.idle", properties: { sessionID: goal.workerSessionID } })
    expect(host.promptCalls).toHaveLength(1)
  })

  it("a new assistant step invalidates an older completed-message anchor", async () => {
    const { goal } = await start()
    const promptID = (await readState(dir)).runtimes[0].activePromptMessageID!
    const engine = createLoopEngine({ directory: dir, host, goalService: service, pollIntervalMs: 60_000 })
    engines.push(engine)
    engine.start()
    const info = { sessionID: goal.workerSessionID, role: "assistant", parentID: promptID }
    await engine.handleEvent({ type: "message.updated", properties: { info: { ...info, id: "older-finished", finish: "stop", time: { completed: Date.now() } } } })
    expect((await readState(dir)).runtimes[0].activeAssistantCompletedAt).toBeDefined()
    await engine.handleEvent({ type: "message.updated", properties: { info: { ...info, id: "newer-running", time: { created: Date.now() } } } })
    expect((await readState(dir)).runtimes[0].activeAssistantCompletedAt).toBeUndefined()
  })

  it("an unfinished newer transcript step vetoes a delayed older completion event", async () => {
    const { goal } = await start()
    const promptID = (await readState(dir)).runtimes[0].activePromptMessageID!
    const at = Date.now() - 100
    const real = createRealHost({ session: { messages: async () => ({ data: [
      { info: { id: promptID, role: "user", time: { created: at - 1 } }, parts: [] },
      { info: { id: "older-finished", role: "assistant", parentID: promptID, finish: "stop", time: { created: at, completed: at + 50 } }, parts: [] },
      { info: { id: "newer-running", role: "assistant", parentID: promptID, time: { created: at + 1 } }, parts: [] },
    ] }) } }, dir)
    host.readMessages = real.readMessages
    const engine = createLoopEngine({ directory: dir, host, goalService: service, pollIntervalMs: 60_000, confirmIdleMs: 0 })
    engines.push(engine)
    engine.start()
    await engine.handleEvent({ type: "message.updated", properties: { info: { sessionID: goal.workerSessionID, id: "older-finished", role: "assistant", parentID: promptID,
      finish: "stop", time: { completed: at + 50 } } } })
    await engine.handleEvent({ type: "session.idle", properties: { sessionID: goal.workerSessionID } })
    await engine.handleEvent({ type: "session.idle", properties: { sessionID: goal.workerSessionID } })
    expect(host.promptCalls).toHaveLength(1)
    expect((await readState(dir)).runtimes[0].activeRunID).toBeDefined()
  })

  for (const status of ["idle", "unknown"] as const) {
    it(`maintenance retains live tool correlation and writes when host status is ${status}`, async () => {
      const { goal } = await start()
      const before = (await readState(dir)).runtimes[0]
      const at = Date.now() - 600_000
      await mutateState(dir, "test.auto-unproved-call", async (state) => {
        state.runtimes[0].lastActivityAt = state.runtimes[0].lastRunAt = state.runtimes[0].turnStartedAt = new Date(at).toISOString()
        state.runtimes[0].activeToolCallIDs = ["still-running"]
        state.workspaceCalls = [{ callID: "still-running", sessionID: goal.workerSessionID!, goalID: goal.id,
          generation: state.runtimes[0].runGeneration, paths: ["source.ts"], at: new Date(at).toISOString() }]
        return state
      })
      host.readToolExecutions = async () => []
      let probes = 0
      host.sessionStatus = async () => { probes++; return status }
      const engine = createLoopEngine({ directory: dir, host, goalService: service, pollIntervalMs: 20, confirmIdleMs: 0, idleRecoverMs: 1 })
      engines.push(engine)
      engine.start()
      await waitFor(() => probes >= 2)
      engine.stop()
      const state = await readState(dir)
      expect(state.workspaceCalls).toHaveLength(1)
      expect(state.runtimes[0].activeToolCallIDs).toEqual(["still-running"])
      expect(state.runtimes[0].activeRunID).toBe(before.activeRunID)
      expect(host.promptCalls).toHaveLength(1)
      expect((await readEvents(dir, 100)).some((event) => event.type === "run.recovered")).toBe(false)
    })
  }

  it("terminal cleanup never automatically restarts an interactive goal", async () => {
    const { goal } = await start()
    const at = Date.now() - 600_000
    await mutateState(dir, "test.manual-terminal", async (state) => {
      state.goals[0].interactive = true
      state.runtimes[0].lastActivityAt = state.runtimes[0].lastRunAt = state.runtimes[0].turnStartedAt = new Date(at).toISOString()
      state.workspaceCalls = [{ callID: "manual-error", sessionID: goal.workerSessionID!, goalID: goal.id, paths: ["source.ts"], at: new Date(at).toISOString() }]
      return state
    })
    host.readToolExecutions = async () => [{ sessionID: goal.workerSessionID!, callID: "manual-error", status: "error", endedAt: at + 1 }]
    const engine = createLoopEngine({ directory: dir, host, goalService: service, pollIntervalMs: 20, confirmIdleMs: 0, idleRecoverMs: 1 })
    engines.push(engine)
    engine.start()
    await waitFor(async () => (await readState(dir)).workspaceCalls?.length === 0)
    engine.stop()
    expect(host.promptCalls).toHaveLength(1)
    expect((await readState(dir)).goals[0].interactive).toBe(true)
  })

  it("a denied force-finish turn is not marked delivered or silently replaced with a normal turn", async () => {
    const { goal } = await start()
    host.messages.get(goal.workerSessionID!)!.push({ role: "assistant", content: "done", parentMessageID: (await readState(dir)).runtimes[0].activePromptMessageID, completedAt: new Date().toISOString() })
    await mutateState(dir, "test.force-finish-blocked", async (state) => {
      state.goals[0].config.maxTurns = 1
      state.workspaceOperation = { id: "checks", goalID: goal.id, sessionID: "owner" }
      return state
    })
    const engine = createLoopEngine({ directory: dir, host, goalService: service, confirmIdleMs: 0 })
    engines.push(engine)
    engine.start()
    await engine.preloadWorkerSessions()
    const idle = { type: "session.idle", properties: { sessionID: goal.workerSessionID } }
    await engine.handleEvent(idle)
    await engine.handleEvent(idle)
    expect(host.promptCalls).toHaveLength(1)
    expect((await readState(dir)).runtimes[0].forceFinishRequested).not.toBe(true)
    await mutateState(dir, "test.finish-checks", async (state) => { state.workspaceOperation = undefined; return state })
    engine.stop()
    const maintenance = createLoopEngine({ directory: dir, host, goalService: service, pollIntervalMs: 20 })
    engines.push(maintenance)
    maintenance.start()
    await waitFor(async () => host.promptCalls.length === 2 && (await readState(dir)).runtimes[0].activePromptAcceptedAt !== undefined)
    maintenance.stop()
    expect(host.prompts[1]).toContain("## FINAL REPORT REQUIRED — STOPPING SOON")
    expect((await readState(dir)).runtimes[0].forceFinishRequested).toBe(true)
  })
})
