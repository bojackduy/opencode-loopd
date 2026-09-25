import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { promises as fs } from "fs"
import path from "path"
import os from "os"
import {
  createCommandSession,
  normalizeTimeoutSeconds,
  computeDeadlineAt,
} from "../../src/domain/command-session"
import {
  createCommandService,
  shellJoin,
  stripAnsiForMatch,
  validateReadPattern,
  type CommandHost,
  type CommandProcessHandle,
} from "../../src/application/command-service"
import type { CommandHost as HostType } from "../../src/server/command-host"
import { createFakeCommandHost } from "../../src/server/command-host"
import { commandTools } from "../../src/server/command-tools"
import { mutateState } from "../../src/infrastructure/state-repository"

void (null as unknown as CommandHost)
void (null as unknown as CommandProcessHandle)
void (null as unknown as HostType)

function tmpDir(): string {
  return path.join(os.tmpdir(), `loopd-m1-test-${crypto.randomUUID()}`)
}

async function waitFor(
  cond: () => Promise<boolean>,
  timeoutMs = 6000,
): Promise<void> {
  const start = Date.now()
  for (;;) {
    if (await cond()) return
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition")
    await new Promise((r) => setTimeout(r, 25))
  }
}

describe("M1 domain: endReason / deadline / envKeys", () => {
  it("normalizeTimeoutSeconds accepts positive ints, rejects the rest (pty parity)", () => {
    expect(normalizeTimeoutSeconds(undefined)).toBeUndefined()
    expect(normalizeTimeoutSeconds(30)).toBe(30)
    expect(() => normalizeTimeoutSeconds(0)).toThrow(/positive integer/)
    expect(() => normalizeTimeoutSeconds(-5)).toThrow(/positive integer/)
    expect(() => normalizeTimeoutSeconds(1.5)).toThrow(/positive integer/)
    expect(() => normalizeTimeoutSeconds(NaN)).toThrow(/positive integer/)
  })

  it("createCommandSession computes deadlineAt = now + timeoutSeconds", () => {
    const before = Date.now()
    const c = createCommandSession({
      id: "cmd-dl",
      title: "t",
      command: "sleep",
      cwd: "/tmp",
      ownerSessionID: "owner-1",
      timeoutSeconds: 60,
    })
    expect(c.timeoutSeconds).toBe(60)
    expect(c.deadlineAt).toBeDefined()
    const deadline = Date.parse(c.deadlineAt!)
    expect(deadline - before).toBeGreaterThanOrEqual(59_000)
    expect(deadline - before).toBeLessThanOrEqual(61_000)
    expect(computeDeadlineAt(new Date("2024-01-01T00:00:00.000Z"), 10)).toBe("2024-01-01T00:00:10.000Z")
  })

  it("createCommandSession without timeout has no deadline", () => {
    const c = createCommandSession({
      id: "cmd-nodl",
      title: "t",
      command: "echo",
      cwd: "/tmp",
      ownerSessionID: "owner-1",
    })
    expect(c.timeoutSeconds).toBeUndefined()
    expect(c.deadlineAt).toBeUndefined()
    expect(c.endReason).toBeUndefined()
  })
})

describe("M1 service: endReason transitions + timeout engine + shell + env", () => {
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
    await svc.dispose(dir).catch(() => {})
    await fs.rm(dir, { recursive: true, force: true })
  })

  it("natural exit stamps endReason=exit", async () => {
    const s = await svc.start(dir, { title: "once", command: "true", ownerSessionID: "owner-1" })
    const proc = [...host.procs.values()].at(-1)!
    proc.emitExit({ exitCode: 0 })
    await waitFor(async () => (await svc.get(dir, s.id, "owner-1"))?.status === "exited")
    expect((await svc.get(dir, s.id, "owner-1"))?.endReason).toBe("exit")
  })

  it("explicit terminate stamps endReason=terminate", async () => {
    const s = await svc.start(dir, { title: "long", command: "sleep", ownerSessionID: "owner-1" })
    await svc.terminate(dir, s.id, "owner-1")
    const after = await svc.get(dir, s.id, "owner-1")
    expect(after!.status).toBe("terminated")
    expect(after!.endReason).toBe("terminate")
  })

  it("timeout fires -> terminated + endReason=timeout + owner notified exactly once", async () => {
    const calls: string[] = []
    const svc2 = createCommandService(host, {
      onOwnerNotify: async (_d, _o, message) => {
        calls.push(message)
      },
    })
    const s = await svc2.start(dir, {
      title: "hangs",
      command: "sleep",
      ownerSessionID: "owner-1",
      timeoutSeconds: 1,
    })
    expect(s.timeoutSeconds).toBe(1)
    expect(s.deadlineAt).toBeDefined()
    await waitFor(async () => (await svc2.get(dir, s.id, "owner-1"))?.endReason === "timeout")
    const after = await svc2.get(dir, s.id, "owner-1")
    expect(after!.status).toBe("terminated")
    expect(after!.endReason).toBe("timeout")
    expect(after!.endedAt).toBeDefined()
    expect(calls).toHaveLength(1)
    // No duplicate on a second pass: timer cleared, marker claimed.
    await new Promise((r) => setTimeout(r, 1200))
    expect(calls).toHaveLength(1)
    await svc2.dispose(dir).catch(() => {})
  })

  it("reconcile past deadline stays honestly missing with timeout noted in lastError", async () => {
    const s = await svc.start(dir, { title: "lost", command: "sleep", ownerSessionID: "owner-1" })
    // Simulate a persisted deadline that already passed (no timer involved).
    await mutateState(dir, "test.backdate-deadline", async (st) => {
      const c = (st.commands ?? []).find((x) => x.id === s.id)
      if (c) {
        c.timeoutSeconds = 60
        c.deadlineAt = new Date(Date.now() - 60_000).toISOString()
      }
      return st
    })
    const svc2 = createCommandService(createFakeCommandHost())
    const { markedMissing } = await svc2.reconcile(dir)
    expect(markedMissing).toBe(1)
    const after = await svc2.get(dir, s.id, "owner-1")
    expect(after!.status).toBe("missing")
    expect(after!.endReason).toBe("missing")
    expect(after!.lastError).toMatch(/timeout/i)
  })

  it("reconcile without a deadline keeps the plain missing message", async () => {
    const s = await svc.start(dir, { title: "lost2", command: "sleep", ownerSessionID: "owner-1" })
    const svc2 = createCommandService(createFakeCommandHost())
    await svc2.reconcile(dir)
    const after = await svc2.get(dir, s.id, "owner-1")
    expect(after!.status).toBe("missing")
    expect(after!.endReason).toBe("missing")
    expect(after!.lastError).toMatch(/no live execution/i)
  })

  it("shell:true spawns via /bin/sh -c with a quoted shell string", async () => {
    const seen: Array<{ command: string; args?: string[] }> = []
    const recording: HostType = {
      capabilities: host.capabilities,
      spawn(opts, onOutput, onExit) {
        seen.push({ command: opts.command, args: opts.args })
        void onOutput
        void onExit
        // Delegate to the fake host so lifecycle still works.
        return (host.spawn as HostType["spawn"])(opts, onOutput, onExit)
      },
      livePids: () => new Set<number>(),
    }
    const svc3 = createCommandService(recording)
    const s = await svc3.start(dir, {
      title: "piped",
      command: "echo",
      args: ["hi there", "a|b"],
      ownerSessionID: "owner-1",
      shell: true,
    })
    expect(seen).toHaveLength(1)
    expect(seen[0]!.command).toBe("/bin/sh")
    expect(seen[0]!.args?.[0]).toBe("-c")
    expect(seen[0]!.args?.[1]).toContain("echo")
    expect(seen[0]!.args?.[1]).toContain("'hi there'")
    expect(s.shell).toBe(true)
    // Original argv is what persists (honest summaries), not /bin/sh.
    expect(s.command).toBe("echo")
    expect(s.args).toEqual(["hi there", "a|b"])
    await svc3.dispose(dir).catch(() => {})
  })

  it("shellJoin quotes POSIX words (pure function)", () => {
    expect(shellJoin("echo", ["hi"])).toBe("echo hi")
    expect(shellJoin("echo", ["hi there"])).toBe("echo 'hi there'")
    expect(shellJoin("echo", ["it's"])).toBe("echo 'it'\\''s'")
    expect(shellJoin("npm", ["run", "dev"])).toBe("npm run dev")
  })

  it("env values pass through to the host but only NAMES persist (never values)", async () => {
    const seenEnvs: Array<Record<string, string> | undefined> = []
    const recording: HostType = {
      capabilities: host.capabilities,
      spawn(opts, onOutput, onExit) {
        seenEnvs.push(opts.env)
        return (host.spawn as HostType["spawn"])(opts, onOutput, onExit)
      },
      livePids: () => new Set<number>(),
    }
    const svc3 = createCommandService(recording)
    const s = await svc3.start(dir, {
      title: "envy",
      command: "env",
      ownerSessionID: "owner-1",
      env: { SECRET_TOKEN: "s3cr3t-value", PLAIN: "yes" },
    })
    expect(seenEnvs[0]?.["SECRET_TOKEN"]).toBe("s3cr3t-value")
    expect(s.envKeys).toEqual(expect.arrayContaining(["SECRET_TOKEN", "PLAIN"]))
    const raw = await fs.readFile(path.join(dir, ".opencode", "loopd", "state.json"), "utf8")
    expect(raw).not.toContain("s3cr3t-value")
    expect(raw).toContain("SECRET_TOKEN")
    await svc3.dispose(dir).catch(() => {})
  })

  it("terminate with remove:true removes in one call (atomic from caller perspective)", async () => {
    const s = await svc.start(dir, { title: "gone", command: "sleep", ownerSessionID: "owner-1" })
    const r = await svc.terminate(dir, s.id, "owner-1", { remove: true })
    expect(r.ok).toBe(true)
    expect(r.removed).toBe(true)
    expect(await svc.get(dir, s.id, "owner-1")).toBeUndefined()
  })

  it("terminate remove:true on an already-terminal command still proceeds to remove", async () => {
    const s = await svc.start(dir, { title: "done", command: "true", ownerSessionID: "owner-1" })
    const proc = [...host.procs.values()].at(-1)!
    proc.emitExit({ exitCode: 0 })
    await waitFor(async () => (await svc.get(dir, s.id, "owner-1"))?.status === "exited")
    const r = await svc.terminate(dir, s.id, "owner-1", { remove: true })
    expect(r.ok).toBe(true)
    expect(r.removed).toBe(true)
    expect(await svc.get(dir, s.id, "owner-1")).toBeUndefined()
  })
})

describe("M1 pattern read (pty parity)", () => {
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
    await svc.dispose(dir).catch(() => {})
    await fs.rm(dir, { recursive: true, force: true })
  })

  it("stripAnsiForMatch removes CSI/OSC escapes", () => {
    expect(stripAnsiForMatch("\u001b[31mERROR\u001b[0m boom")).toBe("ERROR boom")
    expect(stripAnsiForMatch("plain")).toBe("plain")
  })

  it("validateReadPattern rejects invalid and dangerous patterns, accepts safe ones", () => {
    expect(validateReadPattern("ERROR")).toBeInstanceOf(RegExp)
    expect(validateReadPattern("(foo|bar)+")).toBeInstanceOf(RegExp)
    const bad = validateReadPattern("(")
    expect((bad as { error: string }).error).toMatch(/Invalid regex/)
    for (const p of ["(a+)+", "(.*.*)", "(\\w+\\s*)+"]) {
      const r = validateReadPattern(p)
      expect((r as { error: string }).error, p).toMatch(/dangerous/)
    }
  })

  it("pattern filters on ANSI-stripped text but keeps original lines", async () => {
    const s = await svc.start(dir, { title: "logs", command: "echo", ownerSessionID: "owner-1" })
    const proc = [...host.procs.values()].at(-1)!
    proc.emitOutput("\u001b[31mERROR boom\u001b[0m\ninfo fine\n")
    const r = await svc.read(dir, s.id, "owner-1", { pattern: "ERROR" })
    expect(r).toBeDefined()
    expect(r!.totalMatches).toBe(1)
    expect(r!.text).toContain("\u001b[31mERROR boom\u001b[0m")
    expect(r!.text).not.toContain("info fine")
  })

  it("ignoreCase toggles case sensitivity", async () => {
    const s = await svc.start(dir, { title: "case", command: "echo", ownerSessionID: "owner-1" })
    const proc = [...host.procs.values()].at(-1)!
    proc.emitOutput("ERROR loud\nquiet line\n")
    const sensitive = await svc.read(dir, s.id, "owner-1", { pattern: "error" })
    expect(sensitive!.totalMatches).toBe(0)
    expect(sensitive!.text).toBe("")
    const folded = await svc.read(dir, s.id, "owner-1", { pattern: "error", ignoreCase: true })
    expect(folded!.totalMatches).toBe(1)
    expect(folded!.text).toContain("ERROR loud")
  })

  it("offset/limit page over MATCHES", async () => {
    const s = await svc.start(dir, { title: "page", command: "echo", ownerSessionID: "owner-1" })
    const proc = [...host.procs.values()].at(-1)!
    proc.emitOutput("match one\nnope\nmatch two\nmatch three\n")
    const r = await svc.read(dir, s.id, "owner-1", { pattern: "match", offsetBytes: 1, limitBytes: 2 })
    expect(r!.totalMatches).toBe(3)
    expect(r!.text).toContain("match two")
    expect(r!.text).toContain("match three")
    expect(r!.text).not.toContain("match one")
  })

  it("invalid and dangerous patterns throw (tool boundary turns them into ok:false)", async () => {
    const s = await svc.start(dir, { title: "bad", command: "echo", ownerSessionID: "owner-1" })
    await expect(svc.read(dir, s.id, "owner-1", { pattern: "(" })).rejects.toThrow(/Invalid regex/)
    await expect(svc.read(dir, s.id, "owner-1", { pattern: "(a+)+" })).rejects.toThrow(/dangerous/)
  })

  it("tools: invalid/dangerous pattern -> ok:false, terminate remove:true works end to end", async () => {
    const tools = commandTools({ directory: dir, commandService: svc })
    const ctx = { sessionID: "owner-1", ask: async () => {} } as never
    const started = JSON.parse(
      (await tools.loopd_command_start.execute({ title: "t", command: "echo" }, ctx)).output,
    )
    const id = started.command.id as string
    expect(started.command.endReason ?? null).toBeNull()
    const bad = JSON.parse(
      (await tools.loopd_command_get.execute({ command_id: id, pattern: "(a+)+" }, ctx)).output,
    )
    expect(bad.ok).toBe(false)
    expect(bad.message).toMatch(/dangerous/)
    const term = JSON.parse(
      (await tools.loopd_command_terminate.execute({ command_id: id, remove: true }, ctx)).output,
    )
    expect(term.ok).toBe(true)
    expect(term.removed).toBe(true)
    const gone = JSON.parse((await tools.loopd_command_get.execute({ command_id: id }, ctx)).output)
    expect(gone.ok).toBe(false)
  })
})
