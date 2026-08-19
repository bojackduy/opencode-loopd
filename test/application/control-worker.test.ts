import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { promises as fs } from "fs"
import path from "path"
import os from "os"
import { randomUUID } from "crypto"
import { createControlClient } from "../../src/infrastructure/control-client"
import { createControlWorker } from "../../src/application/control-worker"
import { readState } from "../../src/infrastructure/state-store"
import type { LoopHost } from "../../src/server/host-adapter"

function tmpDir(): string {
  return path.join(os.tmpdir(), `loopd-bus-test-${randomUUID()}`)
}

function createFakeHost(): LoopHost & { sessions: Map<string, string[]> } {
  const sessions = new Map<string, string[]>()
  return {
    sessions,
    async createWorker({ parentID, title }) {
      const id = `worker-${randomUUID().slice(0, 8)}`
      sessions.set(id, [])
      return id
    },
    async promptWorker({ sessionID, prompt }) {
      const msgs = sessions.get(sessionID) || []
      msgs.push(prompt)
      sessions.set(sessionID, msgs)
    },
    async sessionStatus() { return "idle" },
    async abortSession(sessionID) { sessions.delete(sessionID) },
    async readMessages() { return [] },
  }
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
    worker = createControlWorker({ directory: dir, host, pollIntervalMs: 50 })
    worker.start()
  })

  afterEach(async () => {
    worker.stop()
    await fs.rm(dir, { recursive: true, force: true })
  })

  it("executes a start command through the bus", async () => {
    const result = await client.execute({
      version: 1,
      requestID: randomUUID(),
      requestedAt: new Date().toISOString(),
      command: "start",
      args: { name: "bus-test", objective: "test objective", config: {} },
    })

    expect(result.ok).toBe(true)
    expect(result.message).toContain("bus-test")

    const state = await client.getState()
    expect(state.goals).toHaveLength(1)
    expect(state.goals[0].name).toBe("bus-test")
  })

  it("creates a worker session for start", async () => {
    await client.execute({
      version: 1,
      requestID: randomUUID(),
      requestedAt: new Date().toISOString(),
      command: "start",
      args: { name: "w", objective: "o", config: {} },
    })

    const state = await client.getState()
    expect(state.goals[0].workerSessionID).toBeTruthy()
    expect(host.sessions.size).toBe(1)
  })

  it("sends continuation prompt on start", async () => {
    await client.execute({
      version: 1,
      requestID: randomUUID(),
      requestedAt: new Date().toISOString(),
      command: "start",
      args: { name: "w", objective: "o", config: {} },
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
      requestID: randomUUID(),
      requestedAt: new Date().toISOString(),
      command: "start",
      args: { name: "p", objective: "o", config: {} },
    })

    const state = await readState(dir)
    const goalID = state.goals[0].id

    const result = await client.execute({
      version: 1,
      requestID: randomUUID(),
      requestedAt: new Date().toISOString(),
      command: "pause",
      goalID,
    })

    expect(result.ok).toBe(true)
    const state2 = await client.getState()
    expect(state2.goals[0].status).toBe("paused")
  })

  it("receives events through the bus", async () => {
    await client.execute({
      version: 1,
      requestID: randomUUID(),
      requestedAt: new Date().toISOString(),
      command: "start",
      args: { name: "ev", objective: "o", config: {} },
    })

    const events = await client.getEvents()
    expect(events.length).toBeGreaterThan(0)
    expect(events.some((e) => e.type === "goal.created")).toBe(true)
  })
})
