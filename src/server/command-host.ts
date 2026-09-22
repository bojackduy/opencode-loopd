// ─── Server: Command Host ────────────────────────────────────────────────────
// Capability-oriented process host for CommandSession. Deliberately separate
// from LoopHost (AI worker sessions): different lifecycle, different failure
// modes, no shared methods.
//
// Capability evidence: docs/planning/command-session-capability-matrix.md.
// Summary: host-owned ordinary PTY lifecycle (create/list/get/update/remove)
// exists as HTTP in the v1 server client and both TUI clients, but NEITHER
// version offers HTTP write/stdin or HTTP output-read for ordinary PTYs — I/O
// is only via a WebSocket `connect` upgrade with zero in-repo plugin-process
// callers — and the v2 *server* context exposes terminal.read only (no
// lifecycle at all). So execution defaults to a real PTY via the `bun-pty`
// native package (same spawn/onData/onExit/write/resize/kill pattern as the
// proven reference in /Users/duytrinh/Code/opencode-pty
// src/plugin/pty/session-lifecycle.ts), with the pipe host below as an
// AUTOMATIC fallback when the native module cannot be loaded. The interface
// stays capability-oriented so callers never branch on the backend: they read
// `capabilities` (resize true on PTY, false on pipes) and `backend`.

import { createRequire } from "module"

export interface CommandSpawnOptions {
  command: string
  args?: string[]
  cwd: string
  env?: Record<string, string>
  cols?: number
  rows?: number
}

export interface CommandProcessHandle {
  pid?: number
  /** Delivery of raw stdin bytes. */
  write(data: string): boolean
  /** SIGINT — may be ignored by the process; never escalates by itself. */
  interrupt(): boolean
  /** SIGTERM. */
  terminate(): boolean
  /** SIGKILL. */
  kill(): boolean
  /** Terminal winsize. False when the backend has no tty (pipe fallback). */
  resize(cols: number, rows: number): boolean
  /** True while the OS process is alive. */
  isAlive(): boolean
  /** Resolves when the process exits. */
  exited(): Promise<{ exitCode: number; signal?: string }>
}

export interface CommandHostCapabilities {
  spawn: true
  write: true
  /** Ctrl+C as SIGINT delivery (not kill). */
  interruptSignal: true
  terminate: true
  /** True on the PTY backend (real winsize); false on pipes (stored, never applied). */
  resize: boolean
  /** Byte-stream capture, not terminal emulation. */
  terminalEmulation: false
}

export const COMMAND_HOST_CAPABILITIES: CommandHostCapabilities = {
  spawn: true,
  write: true,
  interruptSignal: true,
  terminate: true,
  resize: false,
  terminalEmulation: false,
}

/**
 * Capabilities of the real PTY backend. Output is real PTY bytes now
 * (cursor addressing and alt-screen sequences pass through untouched), but
 * there is still no screen emulator — that is Milestone 6 — so
 * terminalEmulation stays false.
 */
export const PTY_HOST_CAPABILITIES: CommandHostCapabilities = {
  spawn: true,
  write: true,
  interruptSignal: true,
  terminate: true,
  resize: true,
  terminalEmulation: false,
}

export interface CommandHost {
  capabilities: CommandHostCapabilities
  spawn(
    opts: CommandSpawnOptions,
    onOutput: (chunk: string) => void,
    onExit: (info: { exitCode: number; signal?: string }) => void,
  ): CommandProcessHandle
  /** Reconcile after restart: live pids the host still owns (always empty for
   * the local-process host — handles are in-memory only and never survive). */
  livePids(): Set<number>
}

// ─── Local process host (Bun.spawn, pipes) ───────────────────────────────────

export function createLocalProcessHost(): CommandHost {
  return {
    capabilities: COMMAND_HOST_CAPABILITIES,
    spawn(opts, onOutput, onExit) {
      const proc = Bun.spawn([opts.command, ...(opts.args ?? [])], {
        cwd: opts.cwd,
        env: { ...process.env, ...(opts.env ?? {}) } as Record<string, string>,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      })
      let settled = false
      let signal: string | undefined
      const exitPromise = (async () => {
        const pumps = [pumpStream(proc.stdout, onOutput), pumpStream(proc.stderr, onOutput)]
        const code = await proc.exited
        await Promise.allSettled(pumps)
        settled = true
        const info = { exitCode: code ?? 0, signal }
        onExit(info)
        return info
      })()
      return {
        pid: proc.pid,
        write(data) {
          try {
            proc.stdin.write(data)
            return true
          } catch {
            return false
          }
        },
        interrupt() {
          try {
            signal = "SIGINT"
            proc.kill("SIGINT")
            return true
          } catch {
            return false
          }
        },
        terminate() {
          try {
            if (!signal) signal = "SIGTERM"
            proc.kill("SIGTERM")
            return true
          } catch {
            return false
          }
        },
        kill() {
          try {
            signal = "SIGKILL"
            proc.kill("SIGKILL")
            return true
          } catch {
            return false
          }
        },
        resize() {
          // Pipes have no tty winsize: never applied. The service stores the
          // requested size and reports unsupported honestly.
          return false
        },
        isAlive() {
          if (settled) return false
          try {
            process.kill(proc.pid, 0)
            return true
          } catch {
            return false
          }
        },
        exited() {
          return exitPromise
        },
      }
    },
    livePids() {
      return new Set()
    },
  }
}

async function pumpStream(
  stream: ReadableStream<Uint8Array> | null | undefined,
  onOutput: (chunk: string) => void,
): Promise<void> {
  if (!stream) return
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value && value.length > 0) onOutput(decoder.decode(value, { stream: true }))
    }
    const rest = decoder.decode()
    if (rest) onOutput(rest)
  } catch {
    // Stream closed with the process — normal.
  } finally {
    try {
      reader.releaseLock()
    } catch {}
  }
}

// ─── PTY host (bun-pty, real tty) ────────────────────────────────────────────
// Mirrors the proven reference (/Users/duytrinh/Code/opencode-pty
// src/plugin/pty/session-lifecycle.ts): spawn(command, args,
// {name, cols, rows, cwd, env}) with onData/onExit wiring, write, resize,
// kill. The native module is loaded once at host-construction time — never
// per command — and any load failure falls back to pipes via
// createCommandHost() below.

export type CommandHostBackend = "pty" | "pipe"

/** Minimal structural surface used from `bun-pty` (no hard import, so a missing/broken native module degrades to pipes instead of crashing the plugin). */
export interface BunPtyInstance {
  readonly pid: number
  onData(listener: (data: string) => void): unknown
  onExit(listener: (event: { exitCode: number; signal?: number | string }) => void): unknown
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(signal?: string): void
}

export interface BunPtyModule {
  spawn(
    file: string,
    args: string[],
    opts: {
      name: string
      cols?: number
      rows?: number
      cwd?: string
      env?: Record<string, string>
    },
  ): BunPtyInstance
}

/** Loader for the native module. Injected in tests to force fallback. */
export type BunPtyLoader = () => unknown

function loadBunPty(): unknown {
  return createRequire(import.meta.url)("bun-pty")
}

function asBunPtyModule(loaded: unknown): BunPtyModule {
  const spawn = (loaded as Partial<BunPtyModule> | undefined)?.spawn
  if (typeof spawn !== "function") throw new Error("bun-pty module has no spawn() export")
  return { spawn: spawn as BunPtyModule["spawn"] }
}

/** Build the PTY host. Throws when the native module cannot be loaded — callers that want fallback use createCommandHost(). */
export function createPtyHost(load: BunPtyLoader = loadBunPty): CommandHost {
  const { spawn } = asBunPtyModule(load())
  return {
    capabilities: PTY_HOST_CAPABILITIES,
    spawn(opts, onOutput, onExit) {
      const pty = spawn(opts.command, opts.args ?? [], {
        name: "xterm-256color",
        cols: opts.cols ?? 80,
        rows: opts.rows ?? 24,
        cwd: opts.cwd,
        env: { ...process.env, ...(opts.env ?? {}), TERM: "xterm-256color" } as Record<string, string>,
      })
      let settled = false
      let killedSignal: string | undefined
      let resolveExit!: (v: { exitCode: number; signal?: string }) => void
      const exitPromise = new Promise<{ exitCode: number; signal?: string }>((r) => {
        resolveExit = r
      })
      // bun-pty can fire onExit more than once (e.g. kill() after a natural
      // exit reports again) — the first event wins, like the pipe host.
      pty.onData((data: string) => {
        onOutput(data)
      })
      pty.onExit((event) => {
        if (settled) return
        settled = true
        const raw = event?.signal
        const info = {
          exitCode: event?.exitCode ?? 0,
          signal: typeof raw === "string" ? raw : raw == null ? killedSignal : String(raw),
        }
        onExit(info)
        resolveExit(info)
      })
      return {
        pid: pty.pid,
        write(data) {
          if (settled) return false
          try {
            pty.write(data)
            return true
          } catch {
            return false
          }
        },
        interrupt() {
          // No signal-targeted API carries line-discipline semantics:
          // kill(sig) signals the session leader directly, bypassing the
          // foreground process group. Writing ETX (^C) lets the PTY line
          // discipline deliver SIGINT to the foreground group instead — the
          // ^C equivalent: trappable/ignorable by the child, never escalates.
          if (settled) return false
          try {
            pty.write("\x03")
            return true
          } catch {
            return false
          }
        },
        terminate() {
          // bun-pty kill() defaults to SIGTERM.
          if (settled) return false
          try {
            killedSignal ??= "SIGTERM"
            pty.kill()
            return true
          } catch {
            return false
          }
        },
        kill() {
          if (settled) return false
          try {
            killedSignal = "SIGKILL"
            pty.kill("SIGKILL")
            return true
          } catch {
            return false
          }
        },
        resize(cols, rows) {
          if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols <= 0 || rows <= 0) return false
          if (settled) return false
          try {
            pty.resize(cols, rows)
            return true
          } catch {
            return false
          }
        },
        isAlive() {
          if (settled) return false
          try {
            process.kill(pty.pid, 0)
            return true
          } catch {
            return false
          }
        },
        exited() {
          return exitPromise
        },
      }
    },
    livePids() {
      return new Set()
    },
  }
}

/**
 * Preferred constructor: tries the real PTY host first and falls back to the
 * pipe host automatically when the native module cannot be loaded. The active
 * backend is exposed on `.backend`; capabilities always describe the ACTIVE
 * backend, so callers branch on capabilities, never on backend.
 */
export function createCommandHost(opts?: { load?: BunPtyLoader }): CommandHost & { backend: CommandHostBackend } {
  try {
    return Object.assign(createPtyHost(opts?.load ?? loadBunPty), { backend: "pty" as const })
  } catch {
    return Object.assign(createLocalProcessHost(), { backend: "pipe" as const })
  }
}

// ─── Fake host (tests) ───────────────────────────────────────────────────────

export interface FakeCommandProcess {
  handle: CommandProcessHandle
  emitOutput(chunk: string): void
  emitExit(info: { exitCode: number; signal?: string }): void
  written: string[]
  signals: string[]
  alive: boolean
}

export function createFakeCommandHost() {
  const procs = new Map<number, FakeCommandProcess>()
  let nextPid = 1000
  const host: CommandHost & { procs: Map<number, FakeCommandProcess> } = {
    capabilities: COMMAND_HOST_CAPABILITIES,
    procs,
    spawn(opts, onOutput, onExit) {
      void opts
      const pid = nextPid++
      const written: string[] = []
      const signals: string[] = []
      let alive = true
      let exitInfo: { exitCode: number; signal?: string } | undefined
      let resolveExit!: (v: { exitCode: number; signal?: string }) => void
      const exitPromise = new Promise<{ exitCode: number; signal?: string }>((r) => {
        resolveExit = r
      })
      const p: FakeCommandProcess = {
        written,
        signals,
        get alive() {
          return alive
        },
        set alive(v: boolean) {
          alive = v
        },
        emitOutput(chunk) {
          onOutput(chunk)
        },
        emitExit(info) {
          if (!alive) return
          alive = false
          exitInfo = info
          onExit(info)
          resolveExit(info)
        },
        handle: null as unknown as CommandProcessHandle,
      }
      p.handle = {
        pid,
        write(data) {
          if (!alive) return false
          written.push(data)
          return true
        },
        interrupt() {
          if (!alive) return false
          signals.push("SIGINT")
          return true
        },
        terminate() {
          if (!alive) return false
          signals.push("SIGTERM")
          alive = false
          const info = { exitCode: 143, signal: "SIGTERM" }
          exitInfo = info
          onExit(info)
          resolveExit(info)
          return true
        },
        kill() {
          if (!alive) return false
          alive = false
          signals.push("SIGKILL")
          const info = { exitCode: 137, signal: "SIGKILL" }
          exitInfo = info
          onExit(info)
          resolveExit(info)
          return true
        },
        resize() {
          // The fake host models the pipe backend (no tty).
          return false
        },
        isAlive() {
          return alive
        },
        exited() {
          return exitPromise
        },
      }
      void exitInfo
      procs.set(pid, p)
      return p.handle
    },
    livePids() {
      const out = new Set<number>()
      for (const [pid, p] of procs) if (p.alive) out.add(pid)
      return out
    },
  }
  return host
}
