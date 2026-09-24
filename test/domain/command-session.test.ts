import { describe, it, expect } from "bun:test"
import {
  createCommandSession,
  canTransitionCommand,
  isLiveCommand,
  shouldNotifyOwnerOnExit,
  MAX_COMMAND_OUTPUT_BYTES,
  NOTIFY_LONG_RUNNING_MS,
  type CommandSession,
} from "../../src/domain/command-session"

function terminalSession(overrides: Partial<CommandSession> = {}): CommandSession {
  const base = createCommandSession({
    id: "cmd-x",
    title: "t",
    command: "echo",
    cwd: "/tmp",
    ownerSessionID: "owner-1",
  })
  return {
    ...base,
    status: "exited",
    exitCode: 0,
    createdAt: "2024-01-01T00:00:00.000Z",
    endedAt: "2024-01-01T00:00:01.000Z", // 1s: well under the long-running threshold
    ...overrides,
  }
}

describe("CommandSession domain", () => {
  it("starts running with bounded-output defaults", () => {
    const c = createCommandSession({
      id: "cmd-1",
      title: "dev server",
      command: "bun",
      args: ["run", "dev"],
      cwd: "/tmp",
      ownerSessionID: "owner-1",
    })
    expect(c.status).toBe("running")
    expect(isLiveCommand(c.status)).toBe(true)
    expect(c.outputBytes).toBe(0)
    expect(c.truncated).toBe(false)
    expect(MAX_COMMAND_OUTPUT_BYTES).toBeGreaterThan(0)
  })

  it("allows running → exited/terminated/missing, nothing out of terminal states", () => {
    expect(canTransitionCommand("running", "exited")).toBe(true)
    expect(canTransitionCommand("running", "terminated")).toBe(true)
    expect(canTransitionCommand("running", "missing")).toBe(true)
    expect(canTransitionCommand("exited", "terminated")).toBe(false)
    expect(canTransitionCommand("terminated", "exited")).toBe(false)
    expect(canTransitionCommand("exited", "running")).toBe(false)
    expect(canTransitionCommand("missing", "running")).toBe(true)
  })

  it("detach is a domain no-op: viewing never changes status", () => {
    const c = createCommandSession({
      id: "cmd-2",
      title: "watch",
      command: "bun",
      cwd: "/tmp",
      ownerSessionID: "owner-1",
    })
    // No transition function for detach exists by design — assert the status
    // value survives a read-only round trip untouched.
    const snapshot = structuredClone(c)
    expect(snapshot.status).toBe("running")
    expect(canTransitionCommand(snapshot.status, snapshot.status)).toBe(false)
  })

  it("goal linkage is optional metadata only", () => {
    const linked = createCommandSession({
      id: "cmd-3",
      title: "linked",
      command: "echo",
      cwd: "/tmp",
      ownerSessionID: "owner-1",
      goalID: "goal-1",
    })
    const standalone = createCommandSession({
      id: "cmd-4",
      title: "plain",
      command: "echo",
      cwd: "/tmp",
      ownerSessionID: "owner-1",
    })
    expect(linked.goalID).toBe("goal-1")
    expect(standalone.goalID).toBeUndefined()
    expect(linked.status).toBe(standalone.status)
  })
})

describe("shouldNotifyOwnerOnExit (owner-exit-notification policy)", () => {
  it("explicit false always wins, even on failure or missing", () => {
    expect(shouldNotifyOwnerOnExit(terminalSession({ notifyOnExit: false, exitCode: 1 }))).toBe(false)
    expect(shouldNotifyOwnerOnExit(terminalSession({ notifyOnExit: false, status: "missing", exitCode: undefined }))).toBe(false)
  })

  it("explicit true always wins, even a quick zero-exit success", () => {
    expect(shouldNotifyOwnerOnExit(terminalSession({ notifyOnExit: true, exitCode: 0 }))).toBe(true)
  })

  it("auto: quick zero-exit success stays silent (no spam for fast commands)", () => {
    expect(shouldNotifyOwnerOnExit(terminalSession({ exitCode: 0 }))).toBe(false)
  })

  it("auto: non-zero exit always notifies regardless of duration", () => {
    expect(shouldNotifyOwnerOnExit(terminalSession({ exitCode: 1 }))).toBe(true)
  })

  it("auto: missing (lost host) always notifies — the surprising case", () => {
    expect(shouldNotifyOwnerOnExit(terminalSession({ status: "missing", exitCode: undefined }))).toBe(true)
  })

  it("auto: terminated (caller-initiated, synchronous result already returned) never notifies", () => {
    expect(shouldNotifyOwnerOnExit(terminalSession({ status: "terminated", exitCode: undefined, signal: "SIGTERM" }))).toBe(false)
  })

  it("auto: long-running success (the monitor/CI-watch case) notifies once past the threshold", () => {
    const started = new Date("2024-01-01T00:00:00.000Z")
    const justUnder = new Date(started.getTime() + NOTIFY_LONG_RUNNING_MS - 1000)
    const atOrOver = new Date(started.getTime() + NOTIFY_LONG_RUNNING_MS)
    expect(shouldNotifyOwnerOnExit(terminalSession({
      exitCode: 0,
      createdAt: started.toISOString(),
      endedAt: justUnder.toISOString(),
    }))).toBe(false)
    expect(shouldNotifyOwnerOnExit(terminalSession({
      exitCode: 0,
      createdAt: started.toISOString(),
      endedAt: atOrOver.toISOString(),
    }))).toBe(true)
  })
})
