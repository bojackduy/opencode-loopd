import { describe, it, expect, afterEach } from "bun:test"
import { promises as fs } from "fs"
import path from "path"
import os from "os"
import {
  COMMAND_HOST_CAPABILITIES,
  PTY_HOST_CAPABILITIES,
  createCommandHost,
  createLocalProcessHost,
  createPtyHost,
  type CommandHost,
  type CommandProcessHandle,
  type CommandSpawnOptions,
} from "../../src/server/command-host"
import { createCommandService } from "../../src/application/command-service"

function ptyAvailable(): boolean {
  try {
    createPtyHost()
    return true
  } catch {
    return false
  }
}

const PTY_AVAILABLE = ptyAvailable()

if (!PTY_AVAILABLE) {
  console.log(
    "SKIP command-pty-host: bun-pty native module unavailable — live PTY tests skipped (pipe fallback active).",
  )
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function waitFor(cond: () => boolean, timeoutMs = 10_000, stepMs = 25): Promise<boolean> {
  const start = Date.now()
  for (;;) {
    if (cond()) return true
    if (Date.now() - start > timeoutMs) return false
    await sleep(stepMs)
  }
}

async function exitedSoon(
  handle: CommandProcessHandle,
  ms = 10_000,
): Promise<{ exitCode: number; signal?: string } | undefined> {
  return Promise.race([handle.exited(), sleep(ms).then(() => undefined)])
}

// Live PTY handles are SIGKILLed after each test so no `sleep 30` survives the suite.
const live: CommandProcessHandle[] = []
afterEach(() => {
  for (const h of live.splice(0)) {
    try {
      h.kill()
    } catch {}
  }
})

function spawnCollector(host: CommandHost, opts: CommandSpawnOptions) {
  let out = ""
  const handle = host.spawn(
    opts,
    (chunk) => {
      out += chunk
    },
    () => {},
  )
  live.push(handle)
  return { handle, text: () => out }
}

describe("PTY host construction (no native module needed)", () => {
  it("fails fast at construction when the loader throws (never per command)", () => {
    expect(() => createPtyHost(() => { throw new Error("no native module") })).toThrow(/no native module/)
  })

  it("fails fast at construction when the loaded module has no spawn()", () => {
    expect(() => createPtyHost(() => ({}))).toThrow(/spawn/)
  })

  it("falls back to pipes when the native module is forced unavailable", () => {
    const host = createCommandHost({ load: () => { throw new Error("forced unavailable") } })
    expect(host.backend).toBe("pipe")
    expect(host.capabilities.resize).toBe(false)
    expect(host.capabilities.terminalEmulation).toBe(false)
  })

  it("pipe host handle resize() is honestly false", async () => {
    const host = createLocalProcessHost()
    const handle = host.spawn({ command: "true", cwd: process.cwd() }, () => {}, () => {})
    live.push(handle)
    expect(handle.resize(100, 40)).toBe(false)
    await handle.exited()
  })
})

describe.skipIf(!PTY_AVAILABLE)("PTY host via bun-pty (live)", () => {
  it("reports resize:true with terminalEmulation:false (bytes, no screen emulator)", () => {
    expect(createPtyHost().capabilities).toEqual({
      spawn: true,
      write: true,
      interruptSignal: true,
      terminate: true,
      resize: true,
      terminalEmulation: false,
    })
  })

  it("selects the PTY backend when the native module loads", () => {
    const host = createCommandHost()
    expect(host.backend).toBe("pty")
    expect(host.capabilities.resize).toBe(true)
  })

  it("echo round-trips through a real PTY", async () => {
    const host = createPtyHost()
    const { handle, text } = spawnCollector(host, { command: "echo", args: ["hello-pty"], cwd: process.cwd() })
    expect(await waitFor(() => text().includes("hello-pty"))).toBe(true)
    const info = await exitedSoon(handle)
    expect(info?.exitCode).toBe(0)
  })

  it("defaults to 80x24 when cols/rows are absent", async () => {
    const host = createPtyHost()
    const { handle, text } = spawnCollector(host, { command: "stty", args: ["size"], cwd: process.cwd() })
    const info = await exitedSoon(handle)
    expect(info?.exitCode).toBe(0)
    // stty prints "rows cols".
    expect(text()).toContain("24 80")
  })

  it("honors cols/rows at spawn (stty size reflects them)", async () => {
    const host = createPtyHost()
    const { handle, text } = spawnCollector(host, {
      command: "stty",
      args: ["size"],
      cwd: process.cwd(),
      cols: 100,
      rows: 40,
    })
    const info = await exitedSoon(handle)
    expect(info?.exitCode).toBe(0)
    expect(text()).toContain("40 100")
  })

  it("resize() applies to the live winsize (later stty sees it)", async () => {
    const host = createPtyHost()
    const { handle, text } = spawnCollector(host, {
      command: "bash",
      args: ["--noprofile", "--norc"],
      cwd: process.cwd(),
      cols: 80,
      rows: 24,
    })
    handle.write("stty size\n")
    expect(await waitFor(() => text().includes("24 80"))).toBe(true)
    expect(handle.resize(120, 50)).toBe(true)
    handle.write("stty size\n")
    expect(await waitFor(() => text().includes("50 120"))).toBe(true)
    expect(handle.resize(0, -1)).toBe(false)
  })

  it("interrupt() kills an untrapped sleeper via ^C", async () => {
    const host = createPtyHost()
    const { handle } = spawnCollector(host, { command: "sleep", args: ["30"], cwd: process.cwd() })
    await sleep(500)
    expect(handle.interrupt()).toBe(true)
    const info = await exitedSoon(handle)
    expect(info).toBeDefined()
  })

  it("interrupt() does NOT kill a process ignoring SIGINT (trap '' INT)", async () => {
    const host = createPtyHost()
    const { handle } = spawnCollector(host, {
      command: "bash",
      args: ["-c", "trap '' INT; sleep 30"],
      cwd: process.cwd(),
    })
    await sleep(500)
    expect(handle.interrupt()).toBe(true)
    const diedEarly = await Promise.race([handle.exited().then(() => true), sleep(1200).then(() => false)])
    expect(diedEarly).toBe(false)
    expect(handle.isAlive()).toBe(true)
  })

  it("alt-screen escape bytes pass through output untouched", async () => {
    const host = createPtyHost()
    const { handle, text } = spawnCollector(host, {
      command: "bash",
      args: ["-c", "printf '\\e[?1049hALTSCREEN\\n'"],
      cwd: process.cwd(),
    })
    const info = await exitedSoon(handle)
    expect(info?.exitCode).toBe(0)
    expect(text()).toContain("\u001b[?1049h")
    expect(text()).toContain("ALTSCREEN")
  })
})

describe("command-service resize() honors the active backend", () => {
  function tmpDir(): string {
    return path.join(os.tmpdir(), `loopd-cmdpty-test-${crypto.randomUUID()}`)
  }

  function stubHost(supportsResize: boolean) {
    const resized: Array<{ cols: number; rows: number }> = []
    const host: CommandHost = {
      capabilities: supportsResize ? PTY_HOST_CAPABILITIES : COMMAND_HOST_CAPABILITIES,
      livePids: () => new Set<number>(),
      spawn(
        _opts: CommandSpawnOptions,
        _onOutput: (chunk: string) => void,
        _onExit: (info: { exitCode: number; signal?: string }) => void,
      ): CommandProcessHandle {
        return {
          write: () => true,
          interrupt: () => true,
          terminate: () => true,
          kill: () => true,
          resize: (cols, rows) => {
            if (!supportsResize) return false
            resized.push({ cols, rows })
            return true
          },
          isAlive: () => true,
          exited: () => new Promise(() => {}),
        }
      },
    }
    return { host, resized }
  }

  it("applies resize on a PTY-capable host and stores the size", async () => {
    const dir = tmpDir()
    await fs.mkdir(dir, { recursive: true })
    try {
      const { host, resized } = stubHost(true)
      const service = createCommandService(host)
      const session = await service.start(dir, { title: "pty", command: "bash", ownerSessionID: "owner-1" })
      const r = await service.resize(dir, session.id, "owner-1", 100, 30)
      expect(r.ok).toBe(true)
      expect(r.message).toMatch(/100x30/)
      expect(resized).toEqual([{ cols: 100, rows: 30 }])
      const got = await service.get(dir, session.id, "owner-1")
      expect(got?.cols).toBe(100)
      expect(got?.rows).toBe(30)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it("stores size and reports unsupported on the pipe fallback", async () => {
    const dir = tmpDir()
    await fs.mkdir(dir, { recursive: true })
    try {
      const { host } = stubHost(false)
      const service = createCommandService(host)
      const session = await service.start(dir, { title: "pipes", command: "bash", ownerSessionID: "owner-1" })
      const r = await service.resize(dir, session.id, "owner-1", 100, 30)
      expect(r.ok).toBe(false)
      expect(r.unsupported).toBe(true)
      expect(r.message).toMatch(/not supported/i)
      const got = await service.get(dir, session.id, "owner-1")
      expect(got?.cols).toBe(100)
      expect(got?.rows).toBe(30)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it("rejects non-positive sizes without touching the handle", async () => {
    const dir = tmpDir()
    await fs.mkdir(dir, { recursive: true })
    try {
      const { host, resized } = stubHost(true)
      const service = createCommandService(host)
      const session = await service.start(dir, { title: "bad", command: "bash", ownerSessionID: "owner-1" })
      const r = await service.resize(dir, session.id, "owner-1", 0, -1)
      expect(r.ok).toBe(false)
      expect(resized).toEqual([])
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})
