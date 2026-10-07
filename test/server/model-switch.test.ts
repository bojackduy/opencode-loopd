import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { promises as fs } from "fs"
import path from "path"
import { createGoalService } from "../../src/application/goal-service"
import { createFakeHost } from "../../src/server/host-adapter"
import { emptyCatalog } from "../../src/server/model-catalog"
import { appendGoalInbox, mutateState, peekGoalInbox, readState } from "../../src/infrastructure/state-repository"
import type { GoalID } from "../../src/domain/goal"
import { ownerTools } from "../../src/server/owner-tools"
import { createLoopEngine } from "../../src/application/loop-engine"

describe("same-goal model switching", () => {
  let dir: string
  let host: ReturnType<typeof createFakeHost>
  let service: ReturnType<typeof createGoalService>
  let id: GoalID
  let switched: string[]

  beforeEach(async () => {
    const root = path.join(import.meta.dir, "../../.opencode/loopd/goals/943fc8d8-6d51-41fc-a99d-efc4d5f1662a")
    await fs.mkdir(root, { recursive: true })
    dir = path.relative(process.cwd(), await fs.mkdtemp(path.join(root, "model-test-")))
    host = createFakeHost()
    switched = []
    host.listModels = async () => ({
      ...emptyCatalog("test", "session", "supported"),
      providers: [{ providerID: "p", name: "Provider", connected: true }],
      models: ["old", "new", "last"].map((modelID) => ({ providerID: "p", modelID, name: modelID, usable: true })),
    })
    host.switchSessionModel = async (sessionID, model) => { switched.push(`${sessionID}:${model.modelID}`); return "applied" }
    service = createGoalService(host)
    const { goal } = await service.start(dir, {
      name: "switch", objective: "same goal", ownerSessionID: "owner", interactive: true,
      costBudget: 1,
      config: { model: "p/old", workspaceWrite: false, checks: ["true"], maxTurns: 7 },
    })
    id = goal.id
  })

  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }) })

  async function idle() {
    await mutateState(dir, "test-idle", async (s) => {
      s.runtimes[0]!.phase = "idle"
      s.runtimes[0]!.activeRunID = undefined
      return s
    })
  }

  it("denies nonowners before catalog or host mutation", async () => {
    host.listModels = async () => { throw new Error("must not call") }
    await expect(service.switchModel(dir, id, "stranger", "p/new")).rejects.toThrow("not owned")
    expect(switched).toEqual([])
  })

  it("rejects malformed, missing and unavailable models", async () => {
    for (const model of ["", "bad", "p/missing"]) {
      await expect(service.switchModel(dir, id, "owner", model)).rejects.toThrow()
    }
    expect(switched).toEqual([])
    expect((await readState(dir)).goals[0]!.config.model).toBe("p/old")
  })

  it("switches without waking interactive goal or changing budget/session/checks/progress", async () => {
    await idle()
    await mutateState(dir, "test-preserved-fields", async (s) => {
      const goal = s.goals[0]!
      goal.lastProgress = { summary: "durable progress", next: "retain transaction", at: new Date().toISOString() }
      goal.tokensUsed = 1234
      goal.costUsed = 0.25
      goal.timeUsedSeconds = 42
      goal.workerTopology = "v2-native-child"
      goal.nativeParentID = "owner"
      return s
    })
    await appendGoalInbox(dir, id, "user", "preserve this instruction")
    const before = await readState(dir)
    const result = await service.switchModel(dir, id, "owner", "p/new")
    const after = await readState(dir)
    expect(result.outcome).toBe("applied")
    expect(after.runtimes).toEqual(before.runtimes)
    expect(after.goals[0]).toEqual({
      ...before.goals[0]!, updatedAt: after.goals[0]!.updatedAt,
      config: { ...before.goals[0]!.config, model: "p/new" }, modelSwitch: after.goals[0]!.modelSwitch,
    })
    expect(host.promptCalls).toHaveLength(1)
    expect(host.sessions.size).toBe(1)
    expect(switched).toEqual([`${before.goals[0]!.workerSessionID}:new`])
    expect(await peekGoalInbox(dir, id)).toEqual(["[user] preserve this instruction"])
  })

  it("defers a leased/busy worker and applies before the next prompt after restart", async () => {
    const workerID = (await readState(dir)).goals[0]!.workerSessionID
    expect((await service.switchModel(dir, id, "owner", "p/new")).outcome).toBe("deferred")
    expect(switched).toEqual([])
    expect((await readState(dir)).goals[0]!.config.model).toBe("p/old")
    await idle()
    service = createGoalService(host)
    await service.continueTurn(dir, id)
    const after = await readState(dir)
    expect(after.goals[0]!.workerSessionID).toBe(workerID)
    expect(after.goals[0]!.modelSwitch?.pending).toBeUndefined()
    expect(host.sessions.size).toBe(1)
    expect(host.promptCalls.at(-1)?.model).toEqual({ providerID: "p", modelID: "new" })
    expect(after.runtimes[0]!.budgetTurnCount).toBe(2)
  })

  it("does not change state when host rejects switch", async () => {
    await idle()
    host.switchSessionModel = async () => { throw new Error("host rejected") }
    const before = await readState(dir)
    await expect(service.switchModel(dir, id, "owner", "p/new")).rejects.toThrow("host rejected")
    expect(await readState(dir)).toEqual(before)
  })

  it("does not change state when catalog capability is unsupported", async () => {
    host.listModels = undefined
    const before = await readState(dir)
    expect((await service.switchModel(dir, id, "owner", "p/new")).outcome).toBe("unsupported")
    expect(await readState(dir)).toEqual(before)
    expect(switched).toEqual([])
  })

  it("does not unpause a paused goal", async () => {
    await service.pause(dir, id)
    expect((await service.switchModel(dir, id, "owner", "p/new")).outcome).toBe("applied")
    expect((await readState(dir)).goals[0]!.status).toBe("paused")
    expect(host.promptCalls).toHaveLength(1)
  })

  it("supports the agent discover -> inspect -> switch -> inspect same-goal workflow", async () => {
    await idle()
    const tools = ownerTools({ directory: dir, host, goalService: service })
    const context = { sessionID: "owner" } as any
    const inventory = JSON.parse((await tools.loopd_list_models.execute({}, context)).output)
    expect(inventory.quota.status).toBe("unknown")
    expect(inventory.assignedGoals[0].id).toBe(id)
    expect(inventory.assignedGoals[0].model).toBe("p/old")
    const before = JSON.parse((await tools.inspect_background_goal.execute({ goal_id: id, includeTranscript: false }, context)).output)
    const changed = JSON.parse((await tools.switch_goal_model.execute({ goal_id: id, model: "p/new", resume: false }, context)).output)
    expect(changed.outcome).toBe("applied")
    const after = JSON.parse((await tools.inspect_background_goal.execute({ goal_id: id, includeTranscript: false }, context)).output)
    expect(after.workerSessionID).toBe(before.workerSessionID)
    expect(after.config.model).toBe("p/new")
    expect(after.modelSwitch.last.from).toBe("p/old")
    const listed = JSON.parse((await tools.list_background_goals.execute({}, context)).output)
    expect(listed.goals[0].modelSwitch.last.to).toBe("p/new")
  })

  it("tools deny foreign goal/worker access and missing session context", async () => {
    const tools = ownerTools({ directory: dir, host, goalService: service })
    for (const sessionID of ["stranger", (await readState(dir)).goals[0]!.workerSessionID]) {
      expect(JSON.parse((await tools.switch_goal_model.execute({ goal_id: id, model: "p/new", resume: false }, { sessionID } as any)).output).ok).toBe(false)
      expect(JSON.parse((await tools.loopd_list_models.execute({}, { sessionID } as any)).output).assignedGoals).toEqual([])
    }
    expect(JSON.parse((await tools.loopd_list_models.execute({}, {} as any)).output).ok).toBe(false)
    expect(JSON.parse((await tools.switch_goal_model.execute({ goal_id: id, model: "p/new", resume: false }, {} as any)).output).ok).toBe(false)
    expect(switched).toEqual([])
  })

  it("does not echo secret host failures through the switch tool", async () => {
    await idle()
    host.switchSessionModel = async () => { throw new Error("Authorization: SUPER-SECRET") }
    const tools = ownerTools({ directory: dir, host, goalService: service })
    const result = await tools.switch_goal_model.execute({ goal_id: id, model: "p/new", resume: false }, { sessionID: "owner" } as any)
    expect(result.output).not.toContain("SUPER-SECRET")
    expect(JSON.parse(result.output).ok).toBe(false)
  })

  async function fallbacks() {
    await mutateState(dir, "test-fallback", async (s) => {
      s.goals[0]!.config.fallbackModels = ["p/new", "p/last", "p/old"]
      return s
    })
  }

  it("prepares ordered quota-only alternatives once each with no interactive wake or loops", async () => {
    await fallbacks()
    const workerID = (await readState(dir)).goals[0]!.workerSessionID
    for (const target of ["p/new", "p/last"]) {
      await service.observeProviderError(dir, id, { statusCode: 429 }, "session-error")
      // Duplicate event must not consume the next alternative before this one runs.
      await service.observeProviderError(dir, id, { statusCode: 429 }, "session-error")
      const prepared = (await readState(dir)).goals[0]!
      expect(prepared.modelSwitch?.pending?.model).toBe(target)
      expect(prepared.lastProviderLimit?.kind).toBe("rate-limit")
      expect(host.promptCalls).toHaveLength(target === "p/new" ? 1 : 2)
      await idle()
      await service.continueTurn(dir, id)
      expect((await readState(dir)).goals[0]!.config.model).toBe(target)
    }
    await service.observeProviderError(dir, id, { code: "insufficient_quota" }, "session-error")
    const exhausted = (await readState(dir)).goals[0]!
    expect(exhausted.modelFallback?.status).toBe("exhausted")
    expect(exhausted.modelSwitch?.pending).toBeUndefined()
    expect(exhausted.workerSessionID).toBe(workerID)
    expect(exhausted.modelFallback?.attempted).toEqual(["p/old", "p/new", "p/last"])
    expect(host.sessions.size).toBe(1)
  })

  it("ignores non-quota errors and does not prepare fallback for a paused goal", async () => {
    await fallbacks()
    for (const error of [new Error("network down"), new Error("maximum context length"), { statusCode: 401, message: "quota exceeded" }]) {
      await service.observeProviderError(dir, id, error, "session-error")
      expect((await readState(dir)).goals[0]!.modelSwitch).toBeUndefined()
    }
    await service.pause(dir, id)
    await service.observeProviderError(dir, id, { statusCode: 429 }, "session-error")
    expect((await readState(dir)).goals[0]!.modelSwitch).toBeUndefined()
    expect((await readState(dir)).goals[0]!.status).toBe("paused")
  })

  it("exposes unsupported automatic fallback rather than silently picking a provider", async () => {
    await fallbacks()
    host.listModels = undefined
    await service.observeProviderError(dir, id, { statusCode: 429 }, "session-error")
    const goal = (await readState(dir)).goals[0]!
    expect(goal.modelFallback?.status).toBe("unsupported")
    expect(goal.modelSwitch?.pending).toBeUndefined()
    expect(host.promptCalls).toHaveLength(1)
  })

  it("observes structured prompt-delivery quota failure and prepares fallback", async () => {
    await fallbacks()
    await idle()
    host.promptWorker = async () => { throw new Error("quota delivery failure", { cause: { statusCode: 429 } }) }
    await expect(service.continueTurn(dir, id)).rejects.toThrow("quota delivery failure")
    const goal = (await readState(dir)).goals[0]!
    expect(goal.lastProviderLimit?.source).toBe("prompt-delivery")
    expect(goal.modelSwitch?.pending?.model).toBe("p/new")
    expect((await readState(dir)).runtimes[0]!.phase).toBe("waiting_retry")
  })

  it("only explicit quota-blocked resume starts a turn and never resets counters", async () => {
    await idle()
    await mutateState(dir, "test-blocked", async (s) => {
      s.goals[0]!.status = "blocked"
      s.goals[0]!.blocker = { kind: "provider-limit", reason: "quota", needed: "switch", at: new Date().toISOString() }
      s.runtimes[0]!.evaluatorRejectionCount = 2
      s.runtimes[0]!.consecutiveFailures = 3
      return s
    })
    const before = (await readState(dir)).runtimes[0]!
    const result = await service.switchModel(dir, id, "owner", "p/new", { resume: true })
    expect(result.resumed).toBe(true)
    const after = await readState(dir)
    expect(after.goals[0]!.status).toBe("active")
    expect(after.runtimes[0]!.evaluatorRejectionCount).toBe(before.evaluatorRejectionCount)
    expect(after.runtimes[0]!.consecutiveFailures).toBe(before.consecutiveFailures)
    expect(after.runtimes[0]!.budgetTurnCount).toBe(before.budgetTurnCount + 1)
    expect(host.promptCalls).toHaveLength(2)
  })

  it("rejects resume on active/paused/unrelated-blocked goals before switching", async () => {
    for (const status of ["active", "paused", "blocked"] as const) {
      await mutateState(dir, "test-status", async (s) => { s.goals[0]!.status = status; return s })
      await expect(service.switchModel(dir, id, "owner", "p/new", { resume: true })).rejects.toThrow("provider-limit-blocked")
    }
    expect(switched).toEqual([])
  })

  it("compacts the same worker with pending switched identity rather than cached old model", async () => {
    await service.switchModel(dir, id, "owner", "p/new")
    await idle()
    let compacted: unknown
    host.compactSession = async (sessionID, model) => { compacted = { sessionID, model } }
    await service.compact(dir, id)
    expect(compacted).toEqual({ sessionID: (await readState(dir)).goals[0]!.workerSessionID, model: { providerID: "p", modelID: "new" } })
    expect(host.promptCalls).toHaveLength(1)
  })

  it("blocks rejected pending switches once, preserving old assignment and avoiding maintenance loops", async () => {
    await service.switchModel(dir, id, "owner", "p/new")
    await idle()
    let calls = 0
    host.switchSessionModel = async () => { calls++; throw new Error("Authorization SECRET") }
    await expect(service.continueTurn(dir, id)).rejects.toThrow("goal blocked")
    await service.continueTurn(dir, id)
    const goal = (await readState(dir)).goals[0]!
    expect(calls).toBe(1)
    expect(goal.status).toBe("blocked")
    expect(goal.config.model).toBe("p/old")
    expect(goal.modelSwitch?.lastFailure?.reason).toBe("host-rejected")
    expect(JSON.stringify(goal)).not.toContain("SECRET")
    expect(host.sessions.size).toBe(1)
  })

  it("engine async quota errors prepare fallback without an interactive auto-turn", async () => {
    await fallbacks()
    const engine = createLoopEngine({ directory: dir, host, goalService: service, pollIntervalMs: 60_000 })
    engine.start()
    try {
      await engine.preloadWorkerSessions()
      const workerSessionID = (await readState(dir)).goals[0]!.workerSessionID
      expect(await engine.handleEvent({ type: "session.error", properties: { sessionID: workerSessionID, error: { data: { statusCode: 429, message: "rate limited" } } } })).toBe(true)
      const after = await readState(dir)
      expect(after.goals[0]!.lastProviderLimit?.source).toBe("session-error")
      expect(after.goals[0]!.modelSwitch?.pending?.model).toBe("p/new")
      expect(after.runtimes[0]!.phase).toBe("waiting_retry")
      expect(host.promptCalls).toHaveLength(1)
      expect(switched).toEqual([])
    } finally { engine.stop() }
  })

  it("does not deplete newly assigned model from a delayed old-model observation", async () => {
    await fallbacks()
    await idle()
    await service.switchModel(dir, id, "owner", "p/new")
    await service.observeProviderError(dir, id, { statusCode: 429 }, "session-error", "p/old")
    const goal = (await readState(dir)).goals[0]!
    expect(goal.lastProviderLimit?.model).toBe("p/old")
    expect(goal.modelSwitch?.pending).toBeUndefined()
    expect(goal.config.model).toBe("p/new")
  })

  it("validates fallback creation before spawning any replacement worker", async () => {
    for (const fallbackModels of [["bad"], ["p/missing"], Array(17).fill("p/new")]) {
      await expect(service.start(dir, { name: "invalid", objective: "no spawn", ownerSessionID: "owner", config: { workspaceWrite: false, fallbackModels } })).rejects.toThrow()
    }
    expect(host.sessions.size).toBe(1)
    expect((await readState(dir)).goals).toHaveLength(1)
  })

  it("serializes host switch, continuation and a concurrent second switch without overlapping turns", async () => {
    await idle()
    let release!: () => void
    let entered!: () => void
    const enteredHost = new Promise<void>((resolve) => { entered = resolve })
    const holdHost = new Promise<void>((resolve) => { release = resolve })
    let calls = 0
    host.switchSessionModel = async () => { calls++; entered(); await holdHost; return "applied" }
    const first = service.switchModel(dir, id, "owner", "p/new")
    await enteredHost
    const turn = service.continueTurn(dir, id)
    const second = service.switchModel(dir, id, "owner", "p/last")
    expect(host.promptCalls).toHaveLength(1)
    release()
    expect((await first).outcome).toBe("applied")
    await turn
    expect((await second).outcome).toBe("deferred")
    expect(calls).toBe(1)
    expect(host.promptCalls).toHaveLength(2)
    expect(host.promptCalls.at(-1)?.model).toEqual({ providerID: "p", modelID: "new" })
    const after = await readState(dir)
    expect(after.goals[0]!.modelSwitch?.pending?.model).toBe("p/last")
    expect(after.runtimes[0]!.budgetTurnCount).toBe(2)
    expect(host.sessions.size).toBe(1)
  })
})
