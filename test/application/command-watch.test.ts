import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { promises as fs } from "fs"
import path from "path"
import os from "os"
import { createCommandService } from "../../src/application/command-service"
import { createGoalService } from "../../src/application/goal-service"
import {
  requestCommandAwait,
  wakeGoalForAwait,
  type FiredAwait,
} from "../../src/application/command-await"
import {
  peekGoalInbox,
  readEvents,
  readState,
} from "../../src/infrastructure/state-repository"
import { createFakeHost } from "../../src/server/host-adapter"
import { createFakeCommandHost } from "../../src/server/command-host"

function tmpDir(): string {
  return path.join(os.tmpdir(), `loopd-watch-test-${crypto.randomUUID()}`)
}

async function waitFor(cond: () => Promise<boolean> | boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now()
  for (;;) {
    if (await cond()) return
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out")
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe("Command watch (M2 line-level filter/until)", () => {
  let dir: string
  let cmdHost: ReturnType<typeof createFakeCommandHost>
  let svc: ReturnType<typeof createCommandService>
  let watchNotifies: Array<{ owner: string; message: string }>
  let ownerNotifies: Array<{ owner: string; message: string }>
  let fired: FiredAwait[]

  beforeEach(async () => {
    dir = tmpDir()
    await fs.mkdir(dir, { recursive: true })
    cmdHost = createFakeCommandHost()
    watchNotifies = []
    ownerNotifies = []
    fired = []
    svc = createCommandService(cmdHost, {
      onWatchNotify: async (_d, owner, message) => {
        watchNotifies.push({ owner, message })
      },
      onOwnerNotify: async (_d, owner, message) => {
        ownerNotifies.push({ owner, message })
      },
      onAwaitFired: async (_d, f) => {
        fired.push(...f)
      },
      watchCoalesceMs: 15,
    })
  })

  afterEach(async () => {
    await svc.dispose(dir).catch(() => {})
    await fs.rm(dir, { recursive: true, force: true })
  })

  function lastProc() {
    return [...cmdHost.procs.values()].at(-1)!
  }

  it("delivers a coalesced [watch title]-prefixed bounded push (one push for rapid lines)", async () => {
    const s = await svc.start(dir, {
      title: "dev",
      command: "npm",
      args: ["run", "dev"],
      ownerSessionID: "owner-1",
      watchFilter: "ERROR",
    })
    const proc = lastProc()
    proc.emitOutput("starting up\n")
    proc.emitOutput("ERROR one\n")
    proc.emitOutput("ERROR two\n")
    await waitFor(() => watchNotifies.length >= 1)
    await new Promise((r) => setTimeout(r, 80)) // let any second flush land
    expect(watchNotifies).toHaveLength(1)
    const msg = watchNotifies[0]!.message
    expect(watchNotifies[0]!.owner).toBe("owner-1")
    expect(msg.startsWith('[watch "dev"]')).toBe(true)
    expect(msg).toContain("ERROR one")
    expect(msg).toContain("ERROR two")
    expect(msg).not.toContain("starting up")
    expect(Buffer.byteLength(msg)).toBeLessThanOrEqual(4 * 1024)
    const after = await svc.get(dir, s.id, "owner-1")
    expect(after!.watchState).toMatchObject({ state: "active", pushes: 1 })
    expect(after!.watchFilter).toBe("ERROR")
    const types = (await readEvents(dir)).filter((e) => e.commandID === s.id).map((e) => e.type)
    expect(types).toContain("command.watch-matched")
  })

  it("until-stop terminates with endReason=until and exactly one owner message total", async () => {
    const s = await svc.start(dir, {
      title: "server",
      command: "sleep",
      ownerSessionID: "owner-1",
      notifyOnExit: true, // would ping on exit — suppression must still hold
      watchUntil: "READY",
    })
    lastProc().emitOutput("booting\nREADY player one\n")
    await waitFor(async () => (await svc.get(dir, s.id, "owner-1"))?.status === "terminated")
    const after = await svc.get(dir, s.id, "owner-1")
    expect(after!.endReason).toBe("until")
    expect(after!.watchState?.state).toBe("until-matched")
    await new Promise((r) => setTimeout(r, 80))
    expect(watchNotifies).toHaveLength(1)
    expect(watchNotifies[0]!.message).toContain("READY player one")
    expect(watchNotifies[0]!.message).toContain("action=stop")
    expect(ownerNotifies).toHaveLength(0) // exactly one owner message total
    const types = (await readEvents(dir)).filter((e) => e.commandID === s.id).map((e) => e.type)
    expect(types).toContain("command.watch-matched")
    expect(types).toContain("command.until-stopped")
  })

  it("until-keep notifies once but keeps running; filter stream continues; exit still notifies", async () => {
    const s = await svc.start(dir, {
      title: "keeper",
      command: "sleep",
      ownerSessionID: "owner-1",
      notifyOnExit: true,
      watchFilter: "o",
      watchUntil: "READY",
      watchUntilAction: "keep",
    })
    const proc = lastProc()
    proc.emitOutput("READY go\n")
    await waitFor(() => watchNotifies.length >= 1)
    let after = await svc.get(dir, s.id, "owner-1")
    expect(after!.status).toBe("running")
    expect(after!.watchState?.state).toBe("until-matched")
    expect(proc.alive).toBe(true)
    // Filter stream continues after the spent until
    proc.emitOutput("foo\n")
    await waitFor(() => watchNotifies.length >= 2)
    expect(watchNotifies[1]!.message).toContain("foo")
    // A later natural exit still pings (no over-suppression for keep)
    proc.emitExit({ exitCode: 0 })
    await waitFor(async () => (await svc.get(dir, s.id, "owner-1"))?.status === "exited")
    await waitFor(() => ownerNotifies.length >= 1)
    expect((await svc.get(dir, s.id, "owner-1"))!.endReason).toBe("exit")
  })

  it("flood suspends the watch with a dropped-count notice; the process keeps running", async () => {
    const s = await svc.start(dir, {
      title: "spam",
      command: "yes",
      ownerSessionID: "owner-1",
      watchFilter: "ZZZ-never-matches",
    })
    const proc = lastProc()
    proc.emitOutput(Array.from({ length: 101 }, (_, i) => `spam-${i}`).join("\n") + "\n")
    await waitFor(() => watchNotifies.length >= 1)
    expect(watchNotifies).toHaveLength(1)
    expect(watchNotifies[0]!.message).toMatch(/FLOOD/)
    expect(watchNotifies[0]!.message).toMatch(/dropped/)
    expect(proc.alive).toBe(true) // never killed for flood — deliberate
    expect((await svc.get(dir, s.id, "owner-1"))?.status).toBe("running")
    expect((await svc.get(dir, s.id, "owner-1"))?.watchState?.state).toBe("flood-suspended")
    // Further output stays silent
    proc.emitOutput("spam-more\n")
    await new Promise((r) => setTimeout(r, 80))
    expect(watchNotifies).toHaveLength(1)
    const types = (await readEvents(dir)).filter((e) => e.commandID === s.id).map((e) => e.type)
    expect(types).toContain("command.watch-suspended")
  })

  it("commands without a watch are unaffected (no watch traffic)", async () => {
    const s = await svc.start(dir, { title: "plain", command: "echo", ownerSessionID: "owner-1" })
    lastProc().emitOutput("hello\n".repeat(150)) // over the flood rate, no watcher
    await new Promise((r) => setTimeout(r, 80))
    expect(watchNotifies).toHaveLength(0)
    expect((await svc.get(dir, s.id, "owner-1"))?.watchState).toBeUndefined()
  })

  it("invalid or dangerous watch regexes fail closed at start (before spawn)", async () => {
    const before = cmdHost.procs.size
    await expect(
      svc.start(dir, { title: "bad", command: "echo", ownerSessionID: "owner-1", watchFilter: "(unclosed" }),
    ).rejects.toThrow(/Invalid watch filter/)
    await expect(
      svc.start(dir, { title: "bad", command: "echo", ownerSessionID: "owner-1", watchUntil: "(a+)+" }),
    ).rejects.toThrow(/dangerous/)
    await expect(
      svc.start(dir, {
        title: "bad", command: "echo", ownerSessionID: "owner-1",
        watchUntil: "x", watchUntilAction: "bogus" as never,
      }),
    ).rejects.toThrow(/untilAction/)
    expect(cmdHost.procs.size).toBe(before) // nothing spawned
  })

  it("reconcile leaves persisted watch fields as-is on missing", async () => {
    const s = await svc.start(dir, {
      title: "watched",
      command: "sleep",
      ownerSessionID: "owner-1",
      watchFilter: "ERROR",
      watchUntil: "READY",
    })
    const svc2 = createCommandService(createFakeCommandHost())
    await svc2.reconcile(dir)
    const after = await svc2.get(dir, s.id, "owner-1")
    expect(after!.status).toBe("missing")
    expect(after!.watchFilter).toBe("ERROR")
    expect(after!.watchUntil).toBe("READY")
  })

  it("await-until wakes the goal once on first match without stopping the command", async () => {
    const host = createFakeHost()
    const goals = createGoalService(host)
    const { goal } = await goals.start(dir, {
      name: "until-goal",
      objective: "wait for READY",
      ownerSessionID: "owner-1",
    })
    const cmd = await svc.start(dir, { title: "job", command: "sleep", ownerSessionID: "owner-1" })
    const req = await requestCommandAwait(dir, {
      goalID: goal.id,
      commandID: cmd.id,
      ownerSessionID: "owner-1",
      until: "READY",
    })
    expect(req.ok).toBe(true)
    expect(req.fired).toBeUndefined()
    const proc = lastProc()
    proc.emitOutput("booting\nREADY player one\n")
    await waitFor(() => fired.length >= 1)
    expect(fired).toHaveLength(1)
    expect(fired[0]).toMatchObject({ goalID: goal.id, commandID: cmd.id })
    const inbox = await peekGoalInbox(dir, goal.id)
    expect(inbox.length).toBeGreaterThan(0)
    expect(inbox.join("\n")).toContain("READY")
    expect((await svc.get(dir, cmd.id, "owner-1"))?.status).toBe("running")
    expect(proc.alive).toBe(true)
    // Second match does not re-fire (consumed exactly once)
    proc.emitOutput("READY again\n")
    await new Promise((r) => setTimeout(r, 80))
    expect(fired).toHaveLength(1)
    // Waking an active goal works through the existing continuation seam
    const wake = await wakeGoalForAwait(dir, goals, goal.id as never)
    expect(wake.woke).toBe(true)
  })

  it("await-until rejects invalid patterns and fires immediately when already present", async () => {
    const host = createFakeHost()
    const goals = createGoalService(host)
    const { goal } = await goals.start(dir, {
      name: "until-goal-2",
      objective: "wait",
      ownerSessionID: "owner-1",
    })
    const cmd = await svc.start(dir, { title: "job2", command: "sleep", ownerSessionID: "owner-1" })
    const bad = await requestCommandAwait(dir, {
      goalID: goal.id,
      commandID: cmd.id,
      ownerSessionID: "owner-1",
      until: "(a+)+",
    })
    expect(bad.ok).toBe(false)
    expect(bad.message).toMatch(/dangerous/)
    lastProc().emitOutput("already READY here\n")
    await waitFor(async () => (await readState(dir)).commands?.find((c) => c.id === cmd.id)?.streamBytes! > 0)
    const late = await requestCommandAwait(dir, {
      goalID: goal.id,
      commandID: cmd.id,
      ownerSessionID: "owner-1",
      until: "READY",
    })
    expect(late.ok).toBe(true)
    expect(late.fired).toBe(true) // pattern already in the log — no missed wake
    // Immediate fires go through the tool's wake path (not the service hook),
    // so assert inbox delivery, not the hook capture.
    const inbox = await peekGoalInbox(dir, goal.id)
    expect(inbox.length).toBeGreaterThan(0)
    expect(inbox.join("\n")).toContain("READY")
  })
})
