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
// lifecycle at all). So the first slice executes on a local child process
// (Bun.spawn with pipes, no new native deps): complete spawn/write/paged-read/
// interrupt-as-SIGINT/terminate-escalating/remove semantics with two labeled
// gaps below. The interface stays capability-oriented so a proven host-owned
// PTY backend can replace the spawner per version without touching callers.

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
  /** Pipes have no tty: resize is stored, never applied. */
  resize: false
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
