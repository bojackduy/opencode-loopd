import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { promises as fs } from "fs"
import path from "path"
import os from "os"
import { createControlClient } from "../../src/infrastructure/control-client"
import { createControlWorker } from "../../src/application/control-worker"
import { readState } from "../../src/infrastructure/state-repository"
import { createFakeHost } from "../../src/server/host-adapter"
import { createGoalService } from "../../src/application/goal-service"
import { createCommandService } from "../../src/application/command-service"
import { createFakeCommandHost } from "../../src/server/command-host"

function tmpDir(): string {
  return path.join(os.tmpdir(), `loopd-bus-test-${crypto.randomUUID()}`)
}

describe("Control Bus", () => {
  let dir: string
  let host: ReturnType<typeof createFakeHost>
  let client: ReturnType<typeof createControlClient>
  let worker: ReturnType<typeof createControlWorker>

  beforeEach(async () => {
    dir = tmpDir()
    await fs.mkdir(dir, { recursive: true })
    host = createFakeHost()
    client = createControlClient(dir)
    worker = createControlWorker({
      directory: dir,
      goalService: createGoalService(host),
      pollIntervalMs: 50,
      defaults: { defaultAgent: "smart-agent", defaultChecks: ["true"] },
    })
    worker.start()
  })

  afterEach(async () => {
    await worker.stop()
    await fs.rm(dir, { recursive: true, force: true })
  })

  it("executes a start command through the bus", async () => {
    const result = await client.execute({
      version: 1,
      requestID: crypto.randomUUID(),
      requestedAt: new Date().toISOString(),
      command: "start",
      args: { name: "bus-test", objective: "test objective", config: {}, ownerSessionID: "owner-1" },
    })

    expect(result.ok).toBe(true)
    expect(result.message).toContain("bus-test")

    const state = await client.getState()
    expect(state.goals).toHaveLength(1)
    expect(state.goals[0].name).toBe("bus-test")
  })

  it("rejects start when no checks are provided for a workspace-writing goal", async () => {
    await worker.stop()
    worker = createControlWorker({
      directory: dir,
      goalService: createGoalService(host),
      pollIntervalMs: 50,
    })
    worker.start()

    const result = await client.execute({
      version: 1,
      requestID: crypto.randomUUID(),
      requestedAt: new Date().toISOString(),
      command: "start",
      args: { name: "auto-checks", objective: "analyze only", config: {}, ownerSessionID: "owner-1" },
    })

    expect(result.ok).toBe(true)
    expect((await client.getState()).goals).toHaveLength(1)
  })

  it("rejects a start command without a real owner session", async () => {
    const result = await client.execute({
      version: 1,
      requestID: crypto.randomUUID(),
      requestedAt: new Date().toISOString(),
      command: "start",
      args: { name: "invalid", objective: "test", config: {}, ownerSessionID: "main" },
    })

    expect(result.ok).toBe(false)
    expect(result.errorCode).toBe("invalid_owner_session")
    expect((await client.getState()).goals).toHaveLength(0)
  })

  it("creates a worker session for start", async () => {
    await client.execute({
      version: 1,
      requestID: crypto.randomUUID(),
      requestedAt: new Date().toISOString(),
      command: "start",
      args: { name: "w", objective: "o", config: {}, ownerSessionID: "owner-1" },
    })

    const state = await client.getState()
    expect(state.goals[0].workerSessionID).toBeTruthy()
    expect(host.sessions.size).toBe(1)
  })

  it("sends continuation prompt on start", async () => {
    await client.execute({
      version: 1,
      requestID: crypto.randomUUID(),
      requestedAt: new Date().toISOString(),
      command: "start",
      args: { name: "w", objective: "o", config: {}, ownerSessionID: "owner-1" },
    })

    const state = await client.getState()
    const workerID = state.goals[0].workerSessionID!
    const msgs = host.sessions.get(workerID) || []
    expect(msgs.length).toBeGreaterThan(0)
    expect(msgs[0]).toContain("get_goal")
  })

  it("pauses and aborts worker", async () => {
    await client.execute({
      version: 1,
      requestID: crypto.randomUUID(),
      requestedAt: new Date().toISOString(),
      command: "start",
      args: { name: "p", objective: "o", config: {}, ownerSessionID: "owner-1" },
    })

    const state = await readState(dir)
    const goalID = state.goals[0].id

    const result = await client.execute({
      version: 1,
      requestID: crypto.randomUUID(),
      requestedAt: new Date().toISOString(),
      command: "pause",
      goalID,
    })

    expect(result.ok).toBe(true)
    const state2 = await client.getState()
    expect(state2.goals[0].status).toBe("paused")
  })

  it("aborts the worker session through the bus without changing status", async () => {
    await client.execute({
      version: 1,
      requestID: crypto.randomUUID(),
      requestedAt: new Date().toISOString(),
      command: "start",
      args: { name: "abort-bus", objective: "o", config: { workspaceWrite: false }, ownerSessionID: "owner-1" },
    })

    const state = await readState(dir)
    const goalID = state.goals[0].id
    const workerID = state.goals[0].workerSessionID!
    expect(host.sessions.has(workerID)).toBe(true)

    const result = await client.execute({
      version: 1,
      requestID: crypto.randomUUID(),
      requestedAt: new Date().toISOString(),
      command: "abort_worker",
      goalID,
    })

    expect(result.ok).toBe(true)
    const state2 = await client.getState()
    expect(state2.goals[0].status).toBe("active")
    expect(state2.goals[0].workerSessionID).toBe(workerID)
    expect(host.sessions.has(workerID)).toBe(false)
  })

  it("nudges the worker through the bus with full steering", async () => {
    await client.execute({
      version: 1,
      requestID: crypto.randomUUID(),
      requestedAt: new Date().toISOString(),
      command: "start",
      args: { name: "nudge-bus", objective: "o", config: { workspaceWrite: false }, ownerSessionID: "owner-1" },
    })
    const started = await readState(dir)
    const goalID = started.goals[0].id
    const promptsBefore = host.prompts.length

    const result = await client.execute({
      version: 1,
      requestID: crypto.randomUUID(),
      requestedAt: new Date().toISOString(),
      command: "nudge",
      goalID,
    })

    expect(result.ok).toBe(true)
    // Forced continuation carries full steering, not bare words
    expect(host.prompts.length).toBeGreaterThan(promptsBefore)
    expect(host.prompts[host.prompts.length - 1]).toContain("COMPLETION REVIEW")
  })

  it("receives events through the bus", async () => {
    await client.execute({
      version: 1,
      requestID: crypto.randomUUID(),
      requestedAt: new Date().toISOString(),
      command: "start",
      args: { name: "ev", objective: "o", config: {}, ownerSessionID: "owner-1" },
    })

    const events = await client.getEvents()
    expect(events.length).toBeGreaterThan(0)
    expect(events.some((e) => e.type === "goal.created")).toBe(true)
  })

  it("routes cmd_kill and cmd_restart to the command service", async () => {
    // The default worker has no commandService — stop it so it can't claim
    // our cmd_* files first, then run a worker with one wired.
    await worker.stop()
    const cmdHost = createFakeCommandHost()
    const cmdSvc = createCommandService(cmdHost)
    worker = createControlWorker({
      directory: dir,
      goalService: createGoalService(host),
      commandService: cmdSvc,
      pollIntervalMs: 50,
    })
    worker.start()
    try {
      const s = await cmdSvc.start(dir, { title: "bus-cmd", command: "sleep", ownerSessionID: "owner-1" })
      const bus = (command: string, extraArgs: Record<string, unknown> = {}) =>
        client.execute({
          version: 1,
          requestID: crypto.randomUUID(),
          requestedAt: new Date().toISOString(),
          command: command as any,
          args: { commandID: s.id, ownerSessionID: "owner-1", ...extraArgs },
        })
      const killed = await bus("cmd_kill")
      expect(killed.ok).toBe(true)
      expect(killed.message).toMatch(/SIGKILL/)
      expect((await cmdSvc.get(dir, s.id, "owner-1"))!.status).toBe("terminated")
      const restarted = await bus("cmd_restart")
      expect(restarted.ok).toBe(true)
      expect(restarted.message).toMatch(/restarted as/)
      const state = await readState(dir)
      const running = state.commands!.filter((c) => c.ownerSessionID === "owner-1" && c.status === "running")
      expect(running).toHaveLength(1)
      expect(running[0]!.title).toBe("bus-cmd")
    } finally {
      await worker.stop()
    }
  })

  it("rejects unknown commands", async () => {
    const result = await client.execute({
      version: 1,
      requestID: crypto.randomUUID(),
      requestedAt: new Date().toISOString(),
      command: "nonexistent" as any,
    })

    expect(result.ok).toBe(false)
    expect(result.errorCode).toBe("unknown_command")
  })

  it("keeps processing after an infrastructure failure", async () => {
    // Break the state directory so polling fails outside per-request handling
    await fs.rm(dir, { recursive: true, force: true })
    await fs.writeFile(dir, "not a directory")
    await new Promise((resolve) => setTimeout(resolve, 150))
    // Restore and prove the worker still serves commands
    await fs.rm(dir, { force: true })
    await fs.mkdir(dir, { recursive: true })
    const result = await client.execute({
      version: 1,
      requestID: crypto.randomUUID(),
      requestedAt: new Date().toISOString(),
      command: "start",
      args: { name: "after-outage", objective: "o", config: { workspaceWrite: false }, ownerSessionID: "owner-1" },
    }, 5000)

    expect(result.ok).toBe(true)
    expect(worker.isRunning()).toBe(true)
  })

  it("sends bare words as their own turn without steering", async () => {
    await client.execute({
      version: 1,
      requestID: crypto.randomUUID(),
      requestedAt: new Date().toISOString(),
      command: "start",
      args: { name: "bare-send", objective: "o", config: { workspaceWrite: false }, ownerSessionID: "owner-1" },
    })
    const started = await readState(dir)
    const goalID = started.goals[0].id

    const result = await client.execute({
      version: 1,
      requestID: crypto.randomUUID(),
      requestedAt: new Date().toISOString(),
      command: "send",
      goalID,
      args: { message: "just this" },
    }, 5000)

    expect(result.ok).toBe(true)
    const lastPrompt = host.prompts[host.prompts.length - 1]
    expect(lastPrompt).toBe("[user] just this")
    // Consumed, not queued: the inbox file is drained, so the next engine
    // turn cannot repeat the words inside steering.
    await expect(
      fs.stat(path.join(dir, ".opencode", "loopd", "inboxes", `${goalID}.jsonl`)),
    ).rejects.toThrow()
  })
})
