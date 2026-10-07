import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { promises as fs } from "fs"
import path from "path"
import { createControlClient } from "../../src/infrastructure/control-client"
import { createControlWorker } from "../../src/application/control-worker"
import { createGoalService } from "../../src/application/goal-service"
import { createFakeHost } from "../../src/server/host-adapter"
import { emptyAgentCatalog } from "../../src/server/agent-catalog"
import { mutateState, readState } from "../../src/infrastructure/state-repository"
import { commandHelp, parseCommand } from "../../src/tui/command-parser"

describe("agent dashboard/control integration", () => {
  let dir: string
  let host: ReturnType<typeof createFakeHost>
  let service: ReturnType<typeof createGoalService>
  let worker: ReturnType<typeof createControlWorker>
  let client: ReturnType<typeof createControlClient>

  beforeEach(async () => {
    const root = path.join(import.meta.dir, "../../.opencode/loopd/goals/3d2b6465-eae7-4eab-9c1c-73ee9b462642")
    await fs.mkdir(root, { recursive: true })
    dir = path.relative(process.cwd(), await fs.mkdtemp(path.join(root, "agent-control-")))
    host = createFakeHost()
    host.listAgents = async () => ({ ...emptyAgentCatalog("test", "session", "supported"), agents: [{ name: "Research Agent", mode: "subagent" }] })
    host.switchSessionAgent = async () => "applied"
    service = createGoalService(host)
    worker = createControlWorker({ directory: dir, goalService: service, pollIntervalMs: 10 })
    client = createControlClient(dir)
    worker.start()
  })
  afterEach(async () => { await worker.stop(); await fs.rm(dir, { recursive: true, force: true }) })

  it("lists real names/modes and switches the selected same-session goal through the control bus", async () => {
    const catalog = await client.execute({ version: 1, requestID: crypto.randomUUID(), requestedAt: new Date().toISOString(), command: "list_agents" })
    expect(catalog.ok).toBe(true)
    expect(catalog.message).toContain("Research Agent (subagent)")
    const { goal } = await service.start(dir, { name: "control", objective: "test", ownerSessionID: "owner", interactive: true, config: { agent: "old", workspaceWrite: false } })
    await mutateState(dir, "idle", async (s) => { s.runtimes[0]!.phase = "idle"; s.runtimes[0]!.activeRunID = undefined; return s })
    const changed = await client.execute({ version: 1, requestID: crypto.randomUUID(), requestedAt: new Date().toISOString(), command: "switch_goal_agent", goalID: goal.id, args: { agent: "Research Agent" } })
    expect(changed.ok).toBe(true)
    expect(changed.message).toContain("same worker/session")
    const after = (await readState(dir)).goals[0]!
    expect(after.config.agent).toBe("Research Agent")
    expect(after.workerSessionID).toBe(goal.workerSessionID)
    expect(host.promptCalls).toHaveLength(1)
  })

  it("rejects missing targets and exposes unsupported agent inventory", async () => {
    const changed = await client.executeRaw({ command: "switch_goal_agent", args: { agent: "Research Agent" } })
    expect(changed.ok).toBe(false)
    expect(changed.errorCode).toBe("bad_request")
    host.listAgents = undefined
    const catalog = await client.execute({ version: 1, requestID: crypto.randomUUID(), requestedAt: new Date().toISOString(), command: "list_agents" })
    expect(catalog.ok).toBe(false)
    expect(catalog.message).toContain("unsupported")
  })

  it("wires parser/help, Goals-tab-only commands and agent row identity", async () => {
    expect(parseCommand('agent "Research Agent"')?.positional).toEqual(["Research Agent"])
    expect(commandHelp()).toContain(":agents")
    const source = await fs.readFile(path.join(import.meta.dir, "../../src/tui/dashboard.tsx"), "utf8")
    const commandTab = source.slice(source.indexOf("async function executeCommandTabCommand"), source.indexOf("async function executeCommand(cmd"))
    expect(commandTab).toContain('case "agent": case "agents":')
    expect(commandTab).toContain("only available on the Goals tab")
    expect(source).toContain('command: "switch_goal_agent"')
    expect(source).toContain('command: "list_agents"')
    expect(source).toContain("🤖 {goal.config.agent}")
  })
})
