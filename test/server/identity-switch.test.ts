import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { promises as fs } from "fs"
import path from "path"
import { createGoalService } from "../../src/application/goal-service"
import { createFakeHost } from "../../src/server/host-adapter"
import { emptyAgentCatalog } from "../../src/server/agent-catalog"
import { emptyCatalog } from "../../src/server/model-catalog"
import { appendGoalInbox, mutateState, peekGoalInbox, readState } from "../../src/infrastructure/state-repository"
import type { GoalID } from "../../src/domain/goal"
import { ownerTools } from "../../src/server/owner-tools"

describe("unified identity switch", () => {
  let dir: string
  let host: ReturnType<typeof createFakeHost>
  let service: ReturnType<typeof createGoalService>
  let id: GoalID
  let calls: string[]
  beforeEach(async () => {
    const root = path.join(import.meta.dir, "../../.opencode/loopd/goals/56113752-db85-40dd-af85-3360d4e47457")
    await fs.mkdir(root, { recursive: true })
    dir = await fs.mkdtemp(path.join(root, "identity-test-"))
    host = createFakeHost()
    calls = []
    host.listAgents = async () => ({ ...emptyAgentCatalog("test", "session", "supported"), agents: ["old", "new"].map((name) => ({ name, mode: "primary" as const })) })
    host.listModels = async () => ({ ...emptyCatalog("test", "session", "supported"), models: ["old", "new"].map((modelID) => ({ providerID: "p", modelID, name: modelID, usable: true })) })
    host.switchSessionAgent = async (_session, agent) => { calls.push(`agent:${agent}`); return "applied" }
    host.switchSessionModel = async (_session, model) => { calls.push(`model:${model.modelID}`); return "applied" }
    service = createGoalService(host)
    const { goal } = await service.start(dir, { name: "identity", objective: "retain session", ownerSessionID: "owner", interactive: true, config: { agent: "old", model: "p/old", workspaceWrite: false } })
    id = goal.id
  })
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }) })
  async function idle() {
    await mutateState(dir, "idle", async (s) => { s.runtimes[0]!.phase = "idle"; s.runtimes[0]!.activeRunID = undefined; return s })
  }
  it("requires a model or agent", async () => {
    await expect(service.switchIdentity(dir, id, "owner", {})).rejects.toThrow("At least one")
    expect(calls).toEqual([])
  })
  it("switches both without a new worker or prompt", async () => {
    await idle()
    await appendGoalInbox(dir, id, "user", "keep")
    await mutateState(dir, "preserve", async (s) => {
      Object.assign(s.goals[0]!, { tokensUsed: 123, costUsed: 0.25, timeUsedSeconds: 42, costBudget: 1, workerTopology: "v2-native-child", nativeParentID: "owner", lastProgress: { summary: "keep", next: "keep", at: new Date().toISOString() } })
      s.goals[0]!.config.checks = ["true"]
      return s
    })
    const before = await readState(dir)
    const transcript = await host.readMessages(before.goals[0]!.workerSessionID!)
    expect(await service.switchIdentity(dir, id, "owner", { model: "p/new", agent: "new" })).toEqual({ outcome: "applied", model: "p/new", agent: "new" })
    const after = await readState(dir)
    expect(after.goals[0]!.workerSessionID).toBe(before.goals[0]!.workerSessionID)
    expect(after.runtimes).toEqual(before.runtimes)
    expect(host.promptCalls).toHaveLength(1)
    expect(calls).toEqual(["model:new", "agent:new"])
    expect(after.goals[0]).toEqual({ ...before.goals[0]!, config: { ...before.goals[0]!.config, model: "p/new", agent: "new" }, updatedAt: after.goals[0]!.updatedAt, modelSwitch: after.goals[0]!.modelSwitch, agentSwitch: after.goals[0]!.agentSwitch })
    expect(await peekGoalInbox(dir, id)).toEqual(["[user] keep"])
    expect(await host.readMessages(before.goals[0]!.workerSessionID!)).toEqual(transcript)
    expect(host.sessions.size).toBe(1)
  })
  it("rolls back a successful model change if agent switching rejects", async () => {
    await idle()
    const before = (await readState(dir)).goals[0]!
    host.switchSessionAgent = async () => { throw new Error("rejected") }
    await expect(service.switchIdentity(dir, id, "owner", { model: "p/new", agent: "new" })).rejects.toThrow("rejected")
    expect((await readState(dir)).goals[0]).toEqual(before)
    expect(calls).toEqual(["model:new", "model:old"])
    expect(host.promptCalls).toHaveLength(1)
  })
  it("defers the pair together across restart", async () => {
    expect((await service.switchIdentity(dir, id, "owner", { model: "p/new", agent: "new" })).outcome).toBe("deferred")
    expect(calls).toEqual([])
    await idle()
    service = createGoalService(host)
    await service.continueTurn(dir, id)
    expect(host.promptCalls.at(-1)?.agent).toBe("new")
    expect(host.promptCalls.at(-1)?.model).toEqual({ providerID: "p", modelID: "new" })
    expect((await readState(dir)).goals[0]!.pendingIdentity).toBeUndefined()
  })
  it("does not expose a partially persisted identity while the second host call is running", async () => {
    await idle()
    let entered!: () => void
    let release!: () => void
    const started = new Promise<void>((resolve) => { entered = resolve })
    const held = new Promise<void>((resolve) => { release = resolve })
    host.switchSessionAgent = async () => { entered(); await held; return "applied" }
    const switching = service.switchIdentity(dir, id, "owner", { model: "p/new", agent: "new" })
    await started
    const during = (await readState(dir)).goals[0]!
    release()
    await switching
    expect(during.config.model).toBe("p/old")
    expect(during.config.agent).toBe("old")
  })
  it("prevalidates both fields and ownership before any host change", async () => {
    await idle()
    await expect(service.switchIdentity(dir, id, "owner", { model: "p/new", agent: "missing" })).rejects.toThrow("unavailable")
    await expect(service.switchIdentity(dir, id, "owner", { model: "p/missing", agent: "new" })).rejects.toThrow("unavailable")
    host.listAgents = async () => { throw new Error("must not discover") }
    await expect(service.switchIdentity(dir, id, "stranger", { model: "p/new", agent: "new" })).rejects.toThrow("not owned")
    expect(calls).toEqual([])
  })
  it("retains state if the first host switch rejects or either capability is unsupported", async () => {
    await idle()
    const before = (await readState(dir)).goals[0]!
    host.switchSessionModel = async () => { throw new Error("model rejected") }
    await expect(service.switchIdentity(dir, id, "owner", { model: "p/new", agent: "new" })).rejects.toThrow("model rejected")
    expect((await readState(dir)).goals[0]).toEqual(before)
    host.listAgents = undefined
    expect((await service.switchIdentity(dir, id, "owner", { model: "p/new", agent: "new" })).outcome).toBe("unsupported")
    expect((await readState(dir)).goals[0]).toEqual(before)
    expect(calls).toEqual([])
  })
  it("rolls back pending partial failure, blocks once, and keeps the same worker", async () => {
    await service.switchIdentity(dir, id, "owner", { model: "p/new", agent: "new" })
    await idle()
    const before = (await readState(dir)).goals[0]!
    host.switchSessionAgent = async () => { throw new Error("SECRET") }
    await expect(service.continueTurn(dir, id)).rejects.toThrow("goal blocked")
    await service.continueTurn(dir, id)
    const after = (await readState(dir)).goals[0]!
    expect(after.config).toEqual(before.config)
    expect(after.workerSessionID).toBe(before.workerSessionID)
    expect(after.status).toBe("blocked")
    expect(after.pendingIdentity).toBeUndefined()
    expect(JSON.stringify(after)).not.toContain("SECRET")
    expect(calls).toEqual(["model:new", "model:old"])
    expect(host.promptCalls).toHaveLength(1)
  })
  it("supports next-prompt pair application without claiming immediate host application", async () => {
    await idle()
    host.switchSessionModel = async () => "next-prompt"
    host.switchSessionAgent = async () => "next-prompt"
    expect((await service.switchIdentity(dir, id, "owner", { model: "p/new", agent: "new" })).outcome).toBe("deferred")
    expect(host.promptCalls).toHaveLength(1)
    await service.sendUserMessage(dir, id, "go")
    expect(host.promptCalls.at(-1)?.agent).toBe("new")
    expect(host.promptCalls.at(-1)?.model).toEqual({ providerID: "p", modelID: "new" })
  })
  it("keeps blocked goals stopped unless explicitly resumed and preserves rejection counters", async () => {
    await idle()
    await mutateState(dir, "block", async (s) => {
      s.goals[0]!.status = "blocked"
      s.goals[0]!.blocker = { reason: "manual", needed: "identity", at: new Date().toISOString() }
      s.runtimes[0]!.evaluatorRejectionCount = 2
      return s
    })
    await service.switchIdentity(dir, id, "owner", { model: "p/new", agent: "new" })
    expect((await readState(dir)).goals[0]!.status).toBe("blocked")
    expect(host.promptCalls).toHaveLength(1)
    expect((await service.switchIdentity(dir, id, "owner", { model: "p/old", agent: "old", resume: true })).resumed).toBe(true)
    expect((await readState(dir)).goals[0]!.status).toBe("active")
    expect((await readState(dir)).runtimes[0]!.evaluatorRejectionCount).toBe(2)
    expect(host.promptCalls).toHaveLength(2)
  })
  it("owner tool requires a field and replaces both legacy tool names", async () => {
    await idle()
    const tools = ownerTools({ directory: dir, host, goalService: service })
    expect(Object.keys(tools)).not.toContain("switch_goal_model")
    expect(Object.keys(tools)).not.toContain("switch_goal_agent")
    const context = { sessionID: "owner" } as any
    const missing = JSON.parse((await tools.switch_goal_identity.execute({ goal_id: id }, context)).output)
    expect(missing.ok).toBe(false)
    expect(missing.message).toContain("At least one")
    const changed = JSON.parse((await tools.switch_goal_identity.execute({ goal_id: id, model: "p/new", agent: "new" }, context)).output)
    expect(changed).toMatchObject({ ok: true, outcome: "applied", model: "p/new", agent: "new" })
  })
  it("rolls back next-prompt model assignment if the agent host becomes unsupported", async () => {
    await idle()
    const before = (await readState(dir)).goals[0]!
    host.switchSessionModel = async (_session, model) => { calls.push(`model:${model.modelID}`); return "next-prompt" }
    host.switchSessionAgent = async () => "unsupported"
    await expect(service.switchIdentity(dir, id, "owner", { model: "p/new", agent: "new" })).rejects.toThrow("unsupported")
    expect(calls).toEqual(["model:new", "model:old"])
    expect((await readState(dir)).goals[0]).toEqual(before)
  })
  it("reports rollback failure without claiming success or replacing the worker", async () => {
    await idle()
    const before = (await readState(dir)).goals[0]!
    host.switchSessionModel = async (_session, model) => model.modelID === "old" ? "unsupported" : "applied"
    host.switchSessionAgent = async () => { throw new Error("rejected") }
    await expect(service.switchIdentity(dir, id, "owner", { model: "p/new", agent: "new" })).rejects.toThrow("host rollback failed")
    expect((await readState(dir)).goals[0]).toEqual(before)
    expect(host.promptCalls).toHaveLength(1)
  })
  it("updates a field of a pending pair even with an explicitly undefined omitted field", async () => {
    await service.switchIdentity(dir, id, "owner", { model: "p/new", agent: "new" })
    expect((await service.switchIdentity(dir, id, "owner", { model: undefined, agent: "old" })).outcome).toBe("deferred")
    expect((await readState(dir)).goals[0]!.pendingIdentity).toEqual({ model: "p/new", agent: "old" })
    await idle()
    await service.continueTurn(dir, id)
    expect(host.promptCalls.at(-1)?.agent).toBe("old")
    expect(host.promptCalls.at(-1)?.model).toEqual({ providerID: "p", modelID: "new" })
  })
  it("rejects combined resume for nonblocked goals and never implicitly resumes a busy blocked goal", async () => {
    await expect(service.switchIdentity(dir, id, "owner", { model: "p/new", agent: "new", resume: true })).rejects.toThrow("blocked goal")
    await mutateState(dir, "block-busy", async (s) => { s.goals[0]!.status = "blocked"; return s })
    const result = await service.switchIdentity(dir, id, "owner", { model: "p/new", agent: "new", resume: true })
    expect(result.outcome).toBe("deferred")
    expect(result.resumed).toBeUndefined()
    expect((await readState(dir)).goals[0]!.status).toBe("blocked")
    expect(host.promptCalls).toHaveLength(1)
    expect(calls).toEqual([])
  })
})
