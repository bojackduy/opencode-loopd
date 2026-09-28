import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { promises as fs } from "fs"
import path from "path"
import os from "os"
import { createCommandService } from "../../src/application/command-service"
import { createFakeCommandHost } from "../../src/server/command-host"
import type { CommandHost, CommandProcessHandle } from "../../src/server/command-host"
import { readEvents, readState } from "../../src/infrastructure/state-repository"

function tmpDir(): string {
  return path.join(os.tmpdir(), `loopd-cmd-test-${crypto.randomUUID()}`)
}

describe("CommandService", () => {
  let dir: string
  let host: ReturnType<typeof createFakeCommandHost>
  let svc: ReturnType<typeof createCommandService>

  beforeEach(async () => {
    dir = tmpDir()
    await fs.mkdir(dir, { recursive: true })
    host = createFakeCommandHost()
    svc = createCommandService(host)
  })

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it("starts, lists, and scopes by owner", async () => {
    const a = await svc.start(dir, { title: "a", command: "echo", ownerSessionID: "owner-1" })
    await svc.start(dir, { title: "b", command: "echo", ownerSessionID: "owner-2" })
    expect(a.status).toBe("running")
    expect((await svc.list(dir, "owner-1")).map((c) => c.title)).toEqual(["a"])
    expect(await svc.get(dir, a.id, "owner-2")).toBeUndefined()
  })

  it("writes raw input to the live handle", async () => {
    const s = await svc.start(dir, { title: "repl", command: "cat", ownerSessionID: "owner-1" })
    const r = await svc.write(dir, s.id, "owner-1", "hello\n")
    expect(r.ok).toBe(true)
    const proc = [...host.procs.values()].at(-1)!
    expect(proc.written).toEqual(["hello\n"])
  })

  it("reads back emitted output with live flag", async () => {
    const s = await svc.start(dir, { title: "out", command: "echo", ownerSessionID: "owner-1" })
    const proc = [...host.procs.values()].at(-1)!
    proc.emitOutput("hello world\n")
    const r = await svc.read(dir, s.id, "owner-1")
    expect(r).toBeDefined()
    expect(r!.text).toContain("hello world")
    expect(r!.live).toBe(true)
  })

  it("interrupt delivers SIGINT without killing (Ctrl+C semantics)", async () => {
    const s = await svc.start(dir, { title: "trap", command: "sh", ownerSessionID: "owner-1" })
    const r = await svc.interrupt(dir, s.id, "owner-1")
    expect(r.ok).toBe(true)
    const proc = [...host.procs.values()].at(-1)!
    expect(proc.signals).toEqual(["SIGINT"])
    expect(proc.alive).toBe(true) // trapping process continues — correct
    const after = await svc.get(dir, s.id, "owner-1")
    expect(after!.status).toBe("running") // still running, not terminated
    expect(after!.signal).toBe("SIGINT")
  })

  it("natural exit marks exited (not terminated)", async () => {
    const s = await svc.start(dir, { title: "once", command: "true", ownerSessionID: "owner-1" })
    const proc = [...host.procs.values()].at(-1)!
    proc.emitExit({ exitCode: 0 })
    await new Promise((r) => setTimeout(r, 25))
    const after = await svc.get(dir, s.id, "owner-1")
    expect(after!.status).toBe("exited")
    expect(after!.exitCode).toBe(0)
  })

  it("retains synchronous output and exit emitted during spawn", async () => {
    const exited = Promise.resolve({ exitCode: 0 })
    const immediateHost: CommandHost = {
      capabilities: host.capabilities,
      spawn(_opts, onOutput, onExit) {
        onOutput("héllo\n")
        onExit({ exitCode: 0 })
        return {
          pid: 42,
          write: () => false,
          interrupt: () => false,
          terminate: () => true,
          kill: () => true,
          isAlive: () => false,
          exited: () => exited,
        } satisfies CommandProcessHandle
      },
      livePids: () => new Set(),
    }
    const immediate = createCommandService(immediateHost)
    const started = await immediate.start(dir, { title: "fast", command: "true", ownerSessionID: "owner-1" })
    expect(started.status).toBe("exited")
    expect(started.outputBytes).toBe(Buffer.byteLength("héllo\n"))
    const result = await immediate.read(dir, started.id, "owner-1")
    expect(result?.text).toBe("héllo\n")
    expect((await readEvents(dir)).filter((event) => event.commandID === started.id).map((event) => event.type)).toEqual([
      "command.started",
      "command.exited",
    ])
  })

  it("terminates live children when the command service is disposed", async () => {
    const session = await svc.start(dir, { title: "server", command: "sleep", ownerSessionID: "owner-1" })
    await svc.dispose(dir)
    expect((await svc.get(dir, session.id, "owner-1"))?.status).toBe("terminated")
    expect([...host.procs.values()].at(-1)?.signals).toContain("SIGTERM")
  })

  it("terminate stops a running command; remove refuses while running (terminate ≠ remove)", async () => {
    const s = await svc.start(dir, { title: "long", command: "sleep", ownerSessionID: "owner-1" })
    const refused = await svc.remove(dir, s.id, "owner-1")
    expect(refused.ok).toBe(false)
    expect(refused.message).toMatch(/terminate/i)
    const t = await svc.terminate(dir, s.id, "owner-1")
    expect(t.ok).toBe(true)
    const after = await svc.get(dir, s.id, "owner-1")
    expect(after!.status).toBe("terminated")
    const removed = await svc.remove(dir, s.id, "owner-1")
    expect(removed.ok).toBe(true)
    expect(await svc.get(dir, s.id, "owner-1")).toBeUndefined()
  })

  it("resize is honestly unsupported but stores the request", async () => {
    const s = await svc.start(dir, { title: "s", command: "echo", ownerSessionID: "owner-1" })
    const r = await svc.resize(dir, s.id, "owner-1", 120, 40)
    expect(r.ok).toBe(false)
    expect(r.unsupported).toBe(true)
    const after = await svc.get(dir, s.id, "owner-1")
    expect(after!.cols).toBe(120)
    expect(after!.rows).toBe(40)
  })

  it("reconcile marks handle-less running commands missing (honest, log retained)", async () => {
    const s = await svc.start(dir, { title: "lost", command: "sleep", ownerSessionID: "owner-1" })
    // Simulate restart: fresh service with no live handles, same directory.
    const svc2 = createCommandService(createFakeCommandHost())
    const { markedMissing } = await svc2.reconcile(dir)
    expect(markedMissing).toBe(1)
    const after = await svc2.get(dir, s.id, "owner-1")
    expect(after!.status).toBe("missing")
    expect(after!.lastError).toMatch(/no live execution/i)
  })

  it("goal linkage never couples lifecycles", async () => {
    const s = await svc.start(dir, {
      title: "linked",
      command: "sleep",
      ownerSessionID: "owner-1",
      goalID: "goal-1",
    })
    expect(s.goalID).toBe("goal-1")
    await svc.terminate(dir, s.id, "owner-1")
    // CommandService has no goal import: goals array untouched by construction.
    const state = await readState(dir)
    expect(state.goals).toEqual([])
  })

  it("persists only metadata (no handles/screens) across reads", async () => {
    const s = await svc.start(dir, { title: "meta", command: "echo", ownerSessionID: "owner-1" })
    const raw = JSON.parse(await fs.readFile(path.join(dir, ".opencode", "loopd", "state.json"), "utf8"))
    const stored = raw.commands.find((c: { id: string }) => c.id === s.id)
    expect(stored).toBeDefined()
    const blob = JSON.stringify(stored)
    expect(blob).not.toMatch(/handle|screen|stdin|stdout/i)
  })
})

describe("CommandService owner-exit notification (the missing hop: no goal/await needed)", () => {
  let dir: string
  let host: ReturnType<typeof createFakeCommandHost>

  beforeEach(async () => {
    dir = tmpDir()
    await fs.mkdir(dir, { recursive: true })
    host = createFakeCommandHost()
  })

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  function svcWithNotify() {
    const calls: Array<{ ownerSessionID: string; message: string }> = []
    const svc = createCommandService(host, {
      onOwnerNotify: async (_dir, ownerSessionID, message) => {
        calls.push({ ownerSessionID, message })
      },
    })
    return { svc, calls }
  }

  it("auto: a failing command with NO goal and NO await still reaches the owner", async () => {
    const { svc, calls } = svcWithNotify()
    const s = await svc.start(dir, { title: "build", command: "false", ownerSessionID: "owner-1" })
    const proc = [...host.procs.values()].at(-1)!
    proc.emitExit({ exitCode: 1 })
    await new Promise((r) => setTimeout(r, 25))
    expect(calls).toHaveLength(1)
    expect(calls[0]!.ownerSessionID).toBe("owner-1")
    expect(calls[0]!.message).toContain("build")
    expect(calls[0]!.message).toContain("exitCode=1")
    const after = await svc.get(dir, s.id, "owner-1")
    expect(after!.ownerNotifiedAt).toBeDefined()
  })

  it("auto: a quick zero-exit success stays silent", async () => {
    const { svc, calls } = svcWithNotify()
    await svc.start(dir, { title: "quick", command: "true", ownerSessionID: "owner-1" })
    const proc = [...host.procs.values()].at(-1)!
    proc.emitExit({ exitCode: 0 })
    await new Promise((r) => setTimeout(r, 25))
    expect(calls).toHaveLength(0)
  })

  it("notify_on_exit: true overrides auto and always notifies, even a quick success", async () => {
    const { svc, calls } = svcWithNotify()
    await svc.start(dir, { title: "opt-in", command: "true", ownerSessionID: "owner-1", notifyOnExit: true })
    const proc = [...host.procs.values()].at(-1)!
    proc.emitExit({ exitCode: 0 })
    await new Promise((r) => setTimeout(r, 25))
    expect(calls).toHaveLength(1)
  })

  it("notify_on_exit: false overrides auto and suppresses even a failure", async () => {
    const { svc, calls } = svcWithNotify()
    await svc.start(dir, { title: "silenced", command: "false", ownerSessionID: "owner-1", notifyOnExit: false })
    const proc = [...host.procs.values()].at(-1)!
    proc.emitExit({ exitCode: 1 })
    await new Promise((r) => setTimeout(r, 25))
    expect(calls).toHaveLength(0)
  })

  it("auto: explicit terminate never notifies (owner already has the synchronous result)", async () => {
    const { svc, calls } = svcWithNotify()
    const s = await svc.start(dir, { title: "server", command: "sleep", ownerSessionID: "owner-1" })
    await svc.terminate(dir, s.id, "owner-1")
    expect(calls).toHaveLength(0)
  })

  it("auto: reconcile-missing (lost host — genuinely surprising) always notifies", async () => {
    const { svc: svc1 } = svcWithNotify()
    await svc1.start(dir, { title: "orphan", command: "sleep", ownerSessionID: "owner-1" })
    const { svc: svc2, calls } = svcWithNotify()
    const { markedMissing } = await svc2.reconcile(dir)
    expect(markedMissing).toBe(1)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.message).toContain("missing")
  })

  it("exactly-once: a redundant reconcile pass never double-notifies", async () => {
    const { svc: svc1 } = svcWithNotify()
    await svc1.start(dir, { title: "orphan", command: "sleep", ownerSessionID: "owner-1" })
    const { svc: svc2, calls } = svcWithNotify()
    await svc2.reconcile(dir)
    await svc2.reconcile(dir) // second pass: status is already "missing", not "running" — no-op by construction
    expect(calls).toHaveLength(1)
  })
})

describe("CommandService force kill + restart (Commands-tab helpers)", () => {
  let dir: string
  let host: ReturnType<typeof createFakeCommandHost>
  let svc: ReturnType<typeof createCommandService>

  beforeEach(async () => {
    dir = tmpDir()
    await fs.mkdir(dir, { recursive: true })
    host = createFakeCommandHost()
    svc = createCommandService(host)
  })

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it("kill SIGKILLs immediately with no SIGTERM grace", async () => {
    const s = await svc.start(dir, { title: "hung", command: "sleep", ownerSessionID: "owner-1" })
    const proc = [...host.procs.values()].at(-1)!
    const r = await svc.kill(dir, s.id, "owner-1")
    expect(r.ok).toBe(true)
    expect(r.message).toMatch(/SIGKILL/)
    // No grace: the ONLY signal is SIGKILL (terminate would send SIGTERM first).
    expect(proc.signals).toEqual(["SIGKILL"])
    const after = await svc.get(dir, s.id, "owner-1")
    expect(after!.status).toBe("terminated")
    expect(after!.signal).toBe("SIGKILL")
    expect(after!.exitCode).toBe(137)
    expect(after!.endReason).toBe("terminate")
  })

  it("kill refuses terminal and unknown commands", async () => {
    const s = await svc.start(dir, { title: "once", command: "true", ownerSessionID: "owner-1" })
    const proc = [...host.procs.values()].at(-1)!
    proc.emitExit({ exitCode: 0 })
    await new Promise((r) => setTimeout(r, 25))
    expect((await svc.kill(dir, s.id, "owner-1")).ok).toBe(false)
    expect((await svc.kill(dir, "nope", "owner-1")).ok).toBe(false)
    expect((await svc.kill(dir, s.id, "owner-2")).ok).toBe(false)
  })

  it("kill stays silent under the auto policy, notifies with notifyOnExit:true", async () => {
    const calls: unknown[] = []
    const svc2 = createCommandService(host, { onOwnerNotify: async () => { calls.push(1) } })
    const quiet = await svc2.start(dir, { title: "q", command: "sleep", ownerSessionID: "owner-1" })
    await svc2.kill(dir, quiet.id, "owner-1")
    expect(calls).toHaveLength(0)
    const loud = await svc2.start(dir, { title: "l", command: "sleep", ownerSessionID: "owner-1", notifyOnExit: true })
    await svc2.kill(dir, loud.id, "owner-1")
    expect(calls).toHaveLength(1)
  })

  it("restart stops the running command and respawns the same spec under a new ID", async () => {
    const s = await svc.start(dir, {
      title: "dev", command: "npm", args: ["run", "dev"], cwd: "/tmp",
      ownerSessionID: "owner-1", watchFilter: "ERROR",
    })
    const r = await svc.restart(dir, s.id, "owner-1")
    expect(r.ok).toBe(true)
    expect(r.command).toBeDefined()
    expect(r.command!.id).not.toBe(s.id)
    expect(r.message).toContain(r.command!.id.slice(0, 8))
    // Old record kept, terminal, for log access.
    const old = await svc.get(dir, s.id, "owner-1")
    expect(old!.status).toBe("terminated")
    // New command carries the spec (incl. the watch).
    const next = await svc.get(dir, r.command!.id, "owner-1")
    expect(next!.status).toBe("running")
    expect(next!.title).toBe("dev")
    expect([next!.command, ...next!.args]).toEqual(["npm", "run", "dev"])
    expect(next!.cwd).toBe("/tmp")
    expect(next!.watchFilter).toBe("ERROR")
  })

  it("restart on a terminal command just respawns (old record untouched)", async () => {
    const s = await svc.start(dir, { title: "once", command: "true", ownerSessionID: "owner-1" })
    const proc = [...host.procs.values()].at(-1)!
    proc.emitExit({ exitCode: 0 })
    await new Promise((r) => setTimeout(r, 25))
    const r = await svc.restart(dir, s.id, "owner-1")
    expect(r.ok).toBe(true)
    expect(r.command!.status).toBe("running")
    expect((await svc.get(dir, s.id, "owner-1"))!.status).toBe("exited")
  })

  it("restart says plainly when env values are dropped", async () => {
    const s = await svc.start(dir, {
      title: "envy", command: "sh", ownerSessionID: "owner-1", env: { SMOKE_SECRET: "s3cr3t" },
    })
    const r = await svc.restart(dir, s.id, "owner-1")
    expect(r.ok).toBe(true)
    expect(r.message).toMatch(/NOT restored/)
    expect(r.message).toMatch(/SMOKE_SECRET/)
  })

  it("restart refuses unknown and foreign commands", async () => {
    const s = await svc.start(dir, { title: "mine", command: "sleep", ownerSessionID: "owner-1" })
    expect((await svc.restart(dir, "nope", "owner-1")).ok).toBe(false)
    expect((await svc.restart(dir, s.id, "owner-2")).ok).toBe(false)
  })
})
