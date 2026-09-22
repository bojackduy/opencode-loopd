import { describe, it, expect } from "bun:test"
import {
  createCommandSession,
  canTransitionCommand,
  isLiveCommand,
  MAX_COMMAND_OUTPUT_BYTES,
} from "../../src/domain/command-session"

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
