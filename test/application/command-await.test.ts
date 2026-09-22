import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { promises as fs } from "fs"
import path from "path"
import os from "os"
import { createGoalService } from "../../src/application/goal-service"
import { createCommandService } from "../../src/application/command-service"
import {
  fireCommandAwaits,
  reconcileCommandAwaits,
  requestCommandAwait,
  wakeGoalForAwait,
  type FiredAwait,
} from "../../src/application/command-await"
import { MAX_AWAIT_TAIL_BYTES } from "../../src/domain/command-await"
import {
  mutateState,
  peekGoalInbox,
  readEvents,
  readState,
} from "../../src/infrastructure/state-repository"
import { createFakeHost } from "../../src/server/host-adapter"
import { createFakeCommandHost } from "../../src/server/command-host"

function tmpDir(): string {
  return path.join(os.tmpdir(), `loopd-await-test-${crypto.randomUUID()}`)
}

async function waitFor(cond: () => Promise<boolean> | boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now()
  for (;;) {
    if (await cond()) return
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out")
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe("Command await (opt-in goal wake on exit)", () => {
  let dir: string
  let host: ReturnType<typeof createFakeHost>
  let cmdHost: ReturnType<typeof createFakeCommandHost>
  let goals: ReturnType<typeof createGoalService>
  let cmds: ReturnType<typeof createCommandService>
  let fired: FiredAwait[]
  let wakes: string[]

  beforeEach(async () => {
    dir = tmpDir()
    await fs.mkdir(dir, { recursive: true })
    host = createFakeHost()
    cmdHost = createFakeCommandHost()
    goals = createGoalService(host)
    fired = []
    wakes = []
    // Production-like wiring: terminal exits fire awaits, active goals wake
    // through the existing idle-continuation path.
    cmds = createCommandService(cmdHost, {
      onAwaitFired: async (d, f) => {
        fired.push(...f)
        for (const item of f) {
          if (!item.active) continue
          const r = await wakeGoalForAwait(d, goals, item.goalID as never)
          if (r.woke) wakes.push(item.goalID)
        }
      },
    })
  })

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  async function startGoal(owner = "owner-1") {
    const { goal } = await goals.start(dir, {
      name: "await-goal",
      objective: "wait for a command",
      ownerSessionID: owner,
    })
    return goal
  }

  async function startCommand(owner = "owner-1") {
    return cmds.start(dir, { title: "job", command: "sleep", ownerSessionID: owner })
  }

  function lastProc() {
    return [...cmdHost.procs.values()].at(-1)!
  }

  it("await → terminal exit fires exactly one wake with exit code + bounded tail, even with duplicate status events", async () => {
    const goal = await startGoal()
    const basePrompts = host.prompts.length
    const cmd = await startCommand()
    const req = await requestCommandAwait(dir, {
      goalID: goal.id,
      commandID: cmd.id,
      ownerSessionID: "owner-1",
    })
    expect(req.ok).toBe(true)
    expect(req.fired).toBeUndefined()

    lastProc().emitOutput("hello\n")
    lastProc().emitExit({ exitCode: 3 })
    // The hook wakes the active goal through the idle-continuation path: the
    // wake turn drains the evidence inbox into steering context.
    await waitFor(() => fired.filter((f) => f.goalID === goal.id).length === 1)
    await waitFor(() => host.prompts.length === basePrompts + 1)
    await waitFor(async () => (await peekGoalInbox(dir, goal.id)).length === 0)

    // Evidence carries the exit code and the output tail.
    const again = await fireCommandAwaits(dir, cmd.id)
    expect(again).toEqual([])
    // Duplicate/late status events can never fire twice: await was consumed.
    lastProc().emitExit({ exitCode: 3 })
    await fireCommandAwaits(dir, cmd.id)
    await new Promise((r) => setTimeout(r, 50))
    expect(fired.filter((f) => f.goalID === goal.id)).toHaveLength(1)
    expect(wakes).toEqual([goal.id])
    expect((await readState(dir)).commandAwaits).toEqual([])
  })

  it("concurrent terminal fires deliver exactly one wake (exit racing terminate)", async () => {
    const goal = await startGoal()
    const cmd = await startCommand()
    const req = await requestCommandAwait(dir, {
      goalID: goal.id,
      commandID: cmd.id,
      ownerSessionID: "owner-1",
    })
    expect(req.ok).toBe(true)
    // Transition to terminal WITHOUT going through the service fire path,
    // then hammer the fire path the way a natural exit racing a concurrent
    // terminate-finalize (or reconcile, or immediate-fire request) would:
    // exactly one delivery must survive no matter the interleave.
    await mutateState(dir, "test:exit", async (s) => {
      const c = (s.commands ?? []).find((x) => x.id === cmd.id)
      if (c) {
        c.status = "exited"
        c.exitCode = 0
        c.endedAt = new Date().toISOString()
        c.updatedAt = c.endedAt
      }
      return s
    })
    const results = await Promise.all(
      Array.from({ length: 10 }, () => fireCommandAwaits(dir, cmd.id)),
    )
    expect(results.flat().filter((f) => f.goalID === goal.id)).toHaveLength(1)
    expect(await peekGoalInbox(dir, goal.id)).toHaveLength(1)
    expect((await readState(dir)).commandAwaits).toEqual([])
  })

  it("inbox evidence carries exit code, signal, and output tail", async () => {
    // Blocked goal: no wake turn drains the inbox, so the evidence text is
    // directly inspectable.
    const goal = await startGoal()
    const cmd = await startCommand()
    await mutateState(dir, `test.block:${goal.id}`, async (s) => {
      const g = s.goals.find((x) => x.id === goal.id)!
      g.status = "blocked"
      return s
    })
    await requestCommandAwait(dir, { goalID: goal.id, commandID: cmd.id, ownerSessionID: "owner-1" })
    lastProc().emitOutput("tail-bytes-here\n")
    lastProc().emitExit({ exitCode: 7, signal: "SIGTERM" })
    await waitFor(async () => (await peekGoalInbox(dir, goal.id)).length === 1)
    const inbox = await peekGoalInbox(dir, goal.id)
    expect(inbox[0]).toMatch(/exitCode=7/)
    expect(inbox[0]).toMatch(/SIGTERM/)
    expect(inbox[0]).toMatch(/tail-bytes-here/)
    expect(inbox[0]).toMatch(/terminated|exited/)
  })

  it("a 200-chunk output storm against an awaited running command fires zero wakes", async () => {
    const goal = await startGoal()
    const basePrompts = host.prompts.length
    const cmd = await startCommand()
    await requestCommandAwait(dir, { goalID: goal.id, commandID: cmd.id, ownerSessionID: "owner-1" })
    const proc = lastProc()
    for (let i = 0; i < 200; i++) proc.emitOutput(`line ${i}\n`)
    await waitFor(async () => {
      const s = await cmds.get(dir, cmd.id, "owner-1")
      return (s?.outputBytes ?? 0) >= 200 * "line 0\n".length
    })
    await new Promise((r) => setTimeout(r, 100))
    expect(fired).toEqual([])
    expect(wakes).toEqual([])
    expect(await peekGoalInbox(dir, goal.id)).toEqual([])
    expect(host.prompts.length).toBe(basePrompts)
    // The await is still outstanding.
    expect((await readState(dir)).commandAwaits).toHaveLength(1)
  })

  it("pause cancels awaits (exit afterwards fires nothing)", async () => {
    const goal = await startGoal()
    const basePrompts = host.prompts.length
    const cmd = await startCommand()
    await requestCommandAwait(dir, { goalID: goal.id, commandID: cmd.id, ownerSessionID: "owner-1" })
    await goals.pause(dir, goal.id)
    expect((await readState(dir)).commandAwaits).toEqual([])
    lastProc().emitExit({ exitCode: 0 })
    await waitFor(async () => (await cmds.get(dir, cmd.id, "owner-1"))?.status === "exited")
    await new Promise((r) => setTimeout(r, 100))
    expect(fired).toEqual([])
    expect(await peekGoalInbox(dir, goal.id)).toEqual([])
    expect(host.prompts.length).toBe(basePrompts)
  })

  it("clear cancels awaits", async () => {
    const goal = await startGoal()
    const cmd = await startCommand()
    await requestCommandAwait(dir, { goalID: goal.id, commandID: cmd.id, ownerSessionID: "owner-1" })
    expect((await readState(dir)).commandAwaits).toHaveLength(1)
    await goals.clear(dir, goal.id)
    expect((await readState(dir)).commandAwaits).toEqual([])
    // Exit afterwards fires nothing (goal is gone; no orphan wakes).
    lastProc().emitExit({ exitCode: 0 })
    await waitFor(async () => (await cmds.get(dir, cmd.id, "owner-1"))?.status === "exited")
    await new Promise((r) => setTimeout(r, 50))
    expect(fired).toEqual([])
  })

  it("remove-command clears awaits pointing at it", async () => {
    const goal = await startGoal()
    const cmd = await startCommand()
    // Seed an outstanding await on a finished command (race window the live
    // fire path normally closes): remove must still clear it.
    lastProc().emitExit({ exitCode: 0 })
    await waitFor(async () => (await cmds.get(dir, cmd.id, "owner-1"))?.status === "exited")
    await mutateState(dir, "test.seed-await", async (s) => {
      s.commandAwaits = [...(s.commandAwaits ?? []), {
        goalID: goal.id,
        commandID: cmd.id,
        ownerSessionID: "owner-1",
        createdAt: new Date().toISOString(),
      }]
      return s
    })
    const removed = await cmds.remove(dir, cmd.id, "owner-1")
    expect(removed.ok).toBe(true)
    expect((await readState(dir)).commandAwaits).toEqual([])
  })

  it("cross-owner await is rejected fail-closed", async () => {
    const goal = await startGoal("owner-1")
    const cmd = await startCommand("owner-2")
    const r1 = await requestCommandAwait(dir, {
      goalID: goal.id,
      commandID: cmd.id,
      ownerSessionID: "owner-1",
    })
    expect(r1.ok).toBe(false)
    expect(r1.message).toMatch(/mismatch/i)
    // Requester owning neither side is also rejected.
    const r2 = await requestCommandAwait(dir, {
      goalID: goal.id,
      commandID: cmd.id,
      ownerSessionID: "owner-3",
    })
    expect(r2.ok).toBe(false)
    expect((await readState(dir)).commandAwaits ?? []).toEqual([])
    expect(fired).toEqual([])
  })

  it("terminating an awaited command wakes normally", async () => {
    const goal = await startGoal()
    const basePrompts = host.prompts.length
    const cmd = await startCommand()
    await requestCommandAwait(dir, { goalID: goal.id, commandID: cmd.id, ownerSessionID: "owner-1" })
    const t = await cmds.terminate(dir, cmd.id, "owner-1")
    expect(t.ok).toBe(true)
    await waitFor(() => fired.length === 1)
    await waitFor(() => host.prompts.length === basePrompts + 1)
    expect(fired[0]!.active).toBe(true)
    expect((await cmds.get(dir, cmd.id, "owner-1"))?.status).toBe("terminated")
  })

  it("blocked goal: evidence waits in pendingInbox without auto-activating", async () => {
    const goal = await startGoal()
    const basePrompts = host.prompts.length
    const cmd = await startCommand()
    await requestCommandAwait(dir, { goalID: goal.id, commandID: cmd.id, ownerSessionID: "owner-1" })
    await mutateState(dir, `test.block:${goal.id}`, async (s) => {
      const g = s.goals.find((x) => x.id === goal.id)!
      g.status = "blocked"
      g.blocker = { reason: "test", needed: "test", at: new Date().toISOString() }
      return s
    })
    lastProc().emitExit({ exitCode: 5 })
    await waitFor(async () => (await peekGoalInbox(dir, goal.id)).length === 1)
    await new Promise((r) => setTimeout(r, 100))
    // Queued but not delivered: no wake turn on a non-active goal.
    expect(fired).toHaveLength(1)
    expect(fired[0]!.active).toBe(false)
    expect(wakes).toEqual([])
    expect(host.prompts.length).toBe(basePrompts)
    // Explicit retry delivers the waiting evidence as a real turn.
    await goals.retry(dir, goal.id)
    await waitFor(() => host.prompts.length === basePrompts + 1)
    expect(await peekGoalInbox(dir, goal.id)).toEqual([])
  })

  it("reconcile with an already-terminal awaited command fires exactly once", async () => {
    const goal = await startGoal()
    const cmd = await startCommand()
    lastProc().emitExit({ exitCode: 9 })
    await waitFor(async () => (await cmds.get(dir, cmd.id, "owner-1"))?.status === "exited")
    // Simulate a crash between persistence and fire: terminal command + an
    // outstanding await surviving in durable state.
    await mutateState(dir, "test.seed-await", async (s) => {
      s.commandAwaits = [...(s.commandAwaits ?? []), {
        goalID: goal.id,
        commandID: cmd.id,
        ownerSessionID: "owner-1",
        createdAt: new Date().toISOString(),
      }]
      return s
    })
    const first = await reconcileCommandAwaits(dir)
    expect(first.filter((f) => f.goalID === goal.id)).toHaveLength(1)
    const second = await reconcileCommandAwaits(dir)
    expect(second).toEqual([])
    expect((await readState(dir)).commandAwaits).toEqual([])
  })

  it("reconcile discards awaits whose command record is gone, with a ledger note", async () => {
    const goal = await startGoal()
    await mutateState(dir, "test.seed-await", async (s) => {
      s.commandAwaits = [...(s.commandAwaits ?? []), {
        goalID: goal.id,
        commandID: "cmd-gone",
        ownerSessionID: "owner-1",
        createdAt: new Date().toISOString(),
      }]
      return s
    })
    const firedNow = await reconcileCommandAwaits(dir)
    expect(firedNow).toEqual([])
    expect((await readState(dir)).commandAwaits).toEqual([])
    const events = await readEvents(dir, 50)
    expect(events.some((e) => e.type === "command.await-discarded" && e.commandID === "cmd-gone")).toBe(true)
  })

  it("wake evidence never exceeds the 4KB bound", async () => {
    const goal = await startGoal()
    const cmd = await startCommand()
    await mutateState(dir, `test.block:${goal.id}`, async (s) => {
      const g = s.goals.find((x) => x.id === goal.id)!
      g.status = "blocked"
      return s
    })
    await requestCommandAwait(dir, { goalID: goal.id, commandID: cmd.id, ownerSessionID: "owner-1" })
    const proc = lastProc()
    for (let i = 0; i < 20; i++) proc.emitOutput(`${"x".repeat(5000)}chunk-${i}\n`)
    proc.emitOutput("ENDMARKER\n")
    proc.emitExit({ exitCode: 0 })
    await waitFor(async () => (await peekGoalInbox(dir, goal.id)).length === 1)
    const inbox = await peekGoalInbox(dir, goal.id)
    const line = inbox[0]!
    const nl = line.indexOf("\n")
    const tail = nl >= 0 ? line.slice(nl + 1) : ""
    expect(Buffer.byteLength(tail, "utf8")).toBeLessThanOrEqual(MAX_AWAIT_TAIL_BYTES)
    expect(tail).toContain("ENDMARKER")
    expect(tail).not.toContain("chunk-0")
  })

  it("requesting an await on an already-terminal command fires immediately", async () => {
    const goal = await startGoal()
    const basePrompts = host.prompts.length
    const cmd = await startCommand()
    lastProc().emitExit({ exitCode: 2 })
    await waitFor(async () => (await cmds.get(dir, cmd.id, "owner-1"))?.status === "exited")
    const req = await requestCommandAwait(dir, {
      goalID: goal.id,
      commandID: cmd.id,
      ownerSessionID: "owner-1",
    })
    expect(req.ok).toBe(true)
    expect(req.fired).toBe(true)
    await waitFor(async () => (await peekGoalInbox(dir, goal.id)).length === 1)
    const inbox = await peekGoalInbox(dir, goal.id)
    expect(inbox[0]).toMatch(/exitCode=2/)
    expect(host.prompts.length).toBe(basePrompts)
    // The immediate fire went through the same consume path (no dupes).
    expect((await readState(dir)).commandAwaits).toEqual([])
  })

  it("awaits persist only IDs in state (never output bytes)", async () => {
    const goal = await startGoal()
    const cmd = await startCommand()
    lastProc().emitOutput("some output that must never land in state\n")
    await requestCommandAwait(dir, { goalID: goal.id, commandID: cmd.id, ownerSessionID: "owner-1" })
    const raw = await fs.readFile(path.join(dir, ".opencode", "loopd", "state.json"), "utf8")
    const stored = JSON.parse(raw).commandAwaits as unknown[]
    expect(stored).toHaveLength(1)
    const blob = JSON.stringify(stored)
    expect(blob).not.toMatch(/some output/)
    expect(Object.keys(stored[0] as object).sort()).toEqual(
      ["commandID", "createdAt", "goalID", "ownerSessionID"].sort(),
    )
  })
})
