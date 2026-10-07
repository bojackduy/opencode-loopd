import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { promises as fs } from "fs"
import path from "path"
import { createGoalService } from "../../src/application/goal-service"
import { createFakeHost } from "../../src/server/host-adapter"
import { emptyAgentCatalog } from "../../src/server/agent-catalog"
import { appendGoalInbox, mutateState, peekGoalInbox, readState } from "../../src/infrastructure/state-repository"
import type { GoalID } from "../../src/domain/goal"
import { ownerTools } from "../../src/server/owner-tools"

describe("same-goal agent switching", () => {
  let dir: string
  let host: ReturnType<typeof createFakeHost>
  let service: ReturnType<typeof createGoalService>
  let id: GoalID
  let switched: string[]

  beforeEach(async () => {
    const root = path.join(import.meta.dir, "../../.opencode/loopd/goals/3d2b6465-eae7-4eab-9c1c-73ee9b462642")
    await fs.mkdir(root, { recursive: true })
    dir = path.relative(process.cwd(), await fs.mkdtemp(path.join(root, "agent-test-")))
    host = createFakeHost()
    switched = []
    host.listAgents = async () => ({ ...emptyAgentCatalog("test", "session", "supported"), agents: ["old", "new", "last"].map((name) => ({ name, mode: "primary" as const })) })
    host.switchSessionAgent = async (sessionID, agent) => { switched.push(`${sessionID}:${agent}`); return "applied" }
    service = createGoalService(host)
    const { goal } = await service.start(dir, { name: "switch", objective: "same goal", ownerSessionID: "owner", interactive: true, costBudget: 1, config: { agent: "old", model: "p/m", workspaceWrite: false, checks: ["true"], maxTurns: 7 } })
    id = goal.id
  })
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }) })
  async function idle() {
    await mutateState(dir, "test-idle", async (s) => { s.runtimes[0]!.phase = "idle"; s.runtimes[0]!.activeRunID = undefined; return s })
  }

  it("denies nonowners before discovery and rejects blank or unknown agents", async () => {
    for (const agent of ["", "   ", "missing"]) await expect(service.switchAgent(dir, id, "owner", agent)).rejects.toThrow()
    host.listAgents = async () => { throw new Error("must not call") }
    await expect(service.switchAgent(dir, id, "stranger", "new")).rejects.toThrow("not owned")
    expect(switched).toEqual([])
  })

  it("discovers available and owner-assigned agents, switches and inspects the same goal", async () => {
    await idle()
    const tools = ownerTools({ directory: dir, host, goalService: service })
    const context = { sessionID: "owner" } as any
    const inventory = JSON.parse((await tools.loopd_list_models.execute({}, context)).output)
    expect(inventory.agents.map((a: any) => a.name)).toEqual(["old", "new", "last"])
    expect(inventory.agentCatalog.capability).toBe("supported")
    expect(inventory.assignedGoals[0].agent).toBe("old")
    const changed = JSON.parse((await tools.switch_goal_agent.execute({ goal_id: id, agent: "new" }, context)).output)
    expect(changed.outcome).toBe("applied")
    const inspected = JSON.parse((await tools.inspect_background_goal.execute({ goal_id: id, includeTranscript: false }, context)).output)
    expect(inspected.config.agent).toBe("new")
    expect(inspected.agentSwitch.last.from).toBe("old")
    expect(inspected.workerSessionID).toBe((await readState(dir)).goals[0]!.workerSessionID)
  })

  it("owner tools deny foreign workers and missing context, invalid names and secret host failures", async () => {
    await idle()
    const tools = ownerTools({ directory: dir, host, goalService: service })
    for (const sessionID of ["stranger", (await readState(dir)).goals[0]!.workerSessionID, undefined]) {
      const context = { sessionID } as any
      expect(JSON.parse((await tools.switch_goal_agent.execute({ goal_id: id, agent: "new" }, context)).output).ok).toBe(false)
      const catalog = JSON.parse((await tools.loopd_list_models.execute({}, context)).output)
      if (sessionID) expect(catalog.assignedGoals).toEqual([])
      else expect(catalog.ok).toBe(false)
    }
    expect(JSON.parse((await tools.switch_goal_agent.execute({ goal_id: id, agent: "missing" }, { sessionID: "owner" } as any)).output).ok).toBe(false)
    host.switchSessionAgent = async () => { throw new Error("SUPER-SECRET") }
    const result = await tools.switch_goal_agent.execute({ goal_id: id, agent: "new" }, { sessionID: "owner" } as any)
    expect(result.output).not.toContain("SUPER-SECRET")
    expect(JSON.parse(result.output).ok).toBe(false)
  })

  it("preserves session, transcript, progress, inbox, budgets, runtime and topology without waking", async () => {
    await idle()
    await mutateState(dir, "preserved", async (s) => {
      Object.assign(s.goals[0]!, { tokensUsed: 123, costUsed: 0.25, timeUsedSeconds: 42, workerTopology: "v2-native-child", nativeParentID: "owner", lastProgress: { summary: "keep", next: "keep", at: new Date().toISOString() } })
      return s
    })
    await appendGoalInbox(dir, id, "user", "keep instruction")
    const before = await readState(dir)
    const transcript = await host.readMessages(before.goals[0]!.workerSessionID!)
    expect(await service.switchAgent(dir, id, "owner", "new")).toEqual({ outcome: "applied", agent: "new" })
    const after = await readState(dir)
    expect(after.runtimes).toEqual(before.runtimes)
    expect(after.goals[0]).toEqual({ ...before.goals[0]!, updatedAt: after.goals[0]!.updatedAt, config: { ...before.goals[0]!.config, agent: "new" }, agentSwitch: after.goals[0]!.agentSwitch })
    expect(await host.readMessages(before.goals[0]!.workerSessionID!)).toEqual(transcript)
    expect(await peekGoalInbox(dir, id)).toEqual(["[user] keep instruction"])
    expect(host.sessions.size).toBe(1)
    expect(host.promptCalls).toHaveLength(1)
  })

  it("persists busy deferral across restart and sends the new agent on next turn", async () => {
    const workerID = (await readState(dir)).goals[0]!.workerSessionID
    expect((await service.switchAgent(dir, id, "owner", "new")).outcome).toBe("deferred")
    expect(switched).toEqual([])
    expect((await readState(dir)).goals[0]!.config.agent).toBe("old")
    await idle()
    service = createGoalService(host)
    await service.continueTurn(dir, id)
    const after = await readState(dir)
    expect(after.goals[0]!.workerSessionID).toBe(workerID)
    expect(after.goals[0]!.agentSwitch?.pending).toBeUndefined()
    expect(host.promptCalls.at(-1)?.agent).toBe("new")
    expect(host.sessions.size).toBe(1)
  })

  it("uses next-prompt fallback without claiming immediate application", async () => {
    await idle()
    host.switchSessionAgent = async () => "next-prompt"
    expect((await service.switchAgent(dir, id, "owner", "new")).outcome).toBe("deferred")
    expect(host.promptCalls).toHaveLength(1)
    await service.sendUserMessage(dir, id, "go")
    expect(host.promptCalls.at(-1)?.agent).toBe("new")
  })

  it("does not mutate assignment on rejected host or unsupported/unavailable discovery", async () => {
    await idle()
    const before = await readState(dir)
    host.switchSessionAgent = async () => { throw new Error("rejected") }
    await expect(service.switchAgent(dir, id, "owner", "new")).rejects.toThrow("rejected")
    expect(await readState(dir)).toEqual(before)
    for (const capability of ["unsupported", "unavailable"] as const) {
      host.listAgents = async () => emptyAgentCatalog("test", "session", capability)
      expect((await service.switchAgent(dir, id, "owner", "new")).outcome).toBe("unsupported")
      expect(await readState(dir)).toEqual(before)
    }
  })

  it("keeps paused and blocked goals stopped unless explicit blocked resume", async () => {
    await service.pause(dir, id)
    await service.switchAgent(dir, id, "owner", "new")
    expect((await readState(dir)).goals[0]!.status).toBe("paused")
    await expect(service.switchAgent(dir, id, "owner", "old", { resume: true })).rejects.toThrow("blocked goal")
    await mutateState(dir, "block", async (s) => {
      s.goals[0]!.status = "blocked"
      s.goals[0]!.blocker = { reason: "manual", needed: "switch", at: new Date().toISOString() }
      s.runtimes[0]!.evaluatorRejectionCount = 2
      s.runtimes[0]!.consecutiveFailures = 3
      return s
    })
    await service.switchAgent(dir, id, "owner", "old")
    expect(host.promptCalls).toHaveLength(1)
    const before = (await readState(dir)).runtimes[0]!
    expect((await service.switchAgent(dir, id, "owner", "new", { resume: true })).resumed).toBe(true)
    const after = await readState(dir)
    expect(after.goals[0]!.status).toBe("active")
    expect(after.runtimes[0]!.evaluatorRejectionCount).toBe(before.evaluatorRejectionCount)
    expect(after.runtimes[0]!.consecutiveFailures).toBe(before.consecutiveFailures)
    expect(after.runtimes[0]!.budgetTurnCount).toBe(before.budgetTurnCount + 1)
  })

  it("blocks a failed pending switch once without secrets or replacement", async () => {
    await service.switchAgent(dir, id, "owner", "new")
    await idle()
    let calls = 0
    host.switchSessionAgent = async () => { calls++; throw new Error("Authorization SECRET") }
    await expect(service.continueTurn(dir, id)).rejects.toThrow("goal blocked")
    await service.continueTurn(dir, id)
    const goal = (await readState(dir)).goals[0]!
    expect(goal.status).toBe("blocked")
    expect(goal.config.agent).toBe("old")
    expect(goal.agentSwitch?.lastFailure?.reason).toBe("host-rejected")
    expect(JSON.stringify(goal)).not.toContain("SECRET")
    expect(calls).toBe(1)
    expect(host.sessions.size).toBe(1)
  })

  it("serializes agent switch with continuation and another switch", async () => {
    await idle()
    let release!: () => void
    let entered!: () => void
    const started = new Promise<void>((resolve) => { entered = resolve })
    const held = new Promise<void>((resolve) => { release = resolve })
    host.switchSessionAgent = async () => { entered(); await held; return "applied" }
    const first = service.switchAgent(dir, id, "owner", "new")
    await started
    const turn = service.continueTurn(dir, id)
    const second = service.switchAgent(dir, id, "owner", "last")
    release()
    await first
    await turn
    expect((await second).outcome).toBe("deferred")
    expect(host.promptCalls.at(-1)?.agent).toBe("new")
    expect((await readState(dir)).goals[0]!.agentSwitch?.pending?.agent).toBe("last")
  })
})
