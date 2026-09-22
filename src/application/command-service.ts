// ─── Application: Command Service ────────────────────────────────────────────
// Owns CommandSession lifecycle. Independent from GoalService: no import, no
// shared state, no coupling. Goal linkage (goalID) is display metadata only —
// pausing/clearing a goal never touches commands, and stopping a command never
// touches goals. Detach (closing a UI view) is a client-side no-op: the server
// keeps running the command.

import { randomUUID } from "crypto"
import { promises as fs } from "fs"
import path from "path"
import {
  createCommandSession,
  MAX_COMMAND_OUTPUT_BYTES,
  type CommandSession,
  type CommandSessionID,
  type CommandSessionStatus,
} from "../domain/command-session"
import type { CommandHost, CommandProcessHandle } from "../server/command-host"
import { utf8ByteLength, type CommandStreamMessage } from "../domain/command-events"
import type { CommandEventBroker } from "./command-event-broker"
import {
  appendCommandLog,
  appendEvent,
  mutateState,
  readCommandLog,
  readState,
  removeCommandLog,
} from "../infrastructure/state-repository"

export interface CommandStartInput {
  title: string
  command: string
  args?: string[]
  cwd?: string
  ownerSessionID: string
  goalID?: string
  cols?: number
  rows?: number
}

export interface CommandReadResult {
  session: CommandSession
  text: string
  totalBytes: number
  startByte: number
  /** Live/streaming truth: process still producing output. */
  live: boolean
}

export interface CommandService {
  start(directory: string, input: CommandStartInput): Promise<CommandSession>
  list(directory: string, ownerSessionID: string): Promise<CommandSession[]>
  get(directory: string, id: string, ownerSessionID: string): Promise<CommandSession | undefined>
  read(
    directory: string,
    id: string,
    ownerSessionID: string,
    opts?: { offsetBytes?: number; limitBytes?: number },
  ): Promise<CommandReadResult | undefined>
  write(directory: string, id: string, ownerSessionID: string, data: string): Promise<{ ok: boolean; message: string }>
  resize(directory: string, id: string, ownerSessionID: string, cols: number, rows: number): Promise<{ ok: boolean; message: string; unsupported?: boolean }>
  interrupt(directory: string, id: string, ownerSessionID: string): Promise<{ ok: boolean; message: string }>
  terminate(directory: string, id: string, ownerSessionID: string): Promise<{ ok: boolean; message: string }>
  remove(directory: string, id: string, ownerSessionID: string): Promise<{ ok: boolean; message: string }>
  /** Reconcile persisted metadata against host truth after restart. */
  reconcile(directory: string): Promise<{ markedMissing: number }>
  /** Stop all live children before the plugin host unloads. */
  dispose(directory: string): Promise<void>
}

function loopCommandsDir(directory: string): string {
  return path.join(directory, ".opencode", "loopd", "commands")
}

export function createCommandService(
  host: CommandHost,
  opts?: { broker?: CommandEventBroker },
): CommandService {
  type LiveEntry = { handle: CommandProcessHandle; buffers: Buffer[]; bufferedBytes: number }
  const live = new Map<string, LiveEntry>()
  const operations = new Map<string, Promise<void>>()
  const broker = opts?.broker
  // commandID -> owning directory (service methods are directory-scoped but
  // the broker subscribe() contract is not; the resolver recovers the
  // directory from recent service activity — single-project assumption).
  const commandDirs = new Map<string, string>()

  function tailText(entry: LiveEntry, limitBytes = 64 * 1024): string {
    let want = limitBytes
    const parts: Buffer[] = []
    for (let i = entry.buffers.length - 1; i >= 0 && want > 0; i--) {
      const chunk = entry.buffers[i]
      if (!chunk) continue
      parts.unshift(chunk.subarray(Math.max(0, chunk.length - want)))
      want -= chunk.length
    }
    return Buffer.concat(parts).toString("utf8")
  }

  function enqueue(id: string, operation: () => Promise<void>): Promise<void> {
    const previous = operations.get(id) ?? Promise.resolve()
    const next = previous.then(operation, operation)
    operations.set(id, next)
    void next.finally(() => {
      if (operations.get(id) === next) operations.delete(id)
    }).catch(() => {})
    return next
  }

  async function waitForOperations(id: string): Promise<void> {
    await operations.get(id)?.catch(() => {})
  }

  /** Publish without ever throwing into the service (sink isolation lives in the broker). */
  function emitBroker(commandID: string, message: CommandStreamMessage): void {
    if (!broker) return
    try {
      broker.publish(commandID, message)
    } catch {
      // Broker never throws for sink errors by contract; defensive only.
    }
  }

  function rememberDir(id: string, directory: string): void {
    commandDirs.set(id, directory)
  }

  async function readBrokerSnapshot(commandID: string, ownerSessionID: string) {
    const directory = commandDirs.get(commandID)
    if (!directory) return undefined
    const state = await readState(directory)
    const session = (state.commands ?? []).find(
      (x) => x.id === commandID && x.ownerSessionID === ownerSessionID,
    )
    if (!session) return undefined
    const log = await readCommandLog(directory, commandID, {
      offsetBytes: 0,
      limitBytes: MAX_COMMAND_OUTPUT_BYTES,
    })
    const data = log.text
    const byteLen = utf8ByteLength(data)
    const lifetime = session.streamBytes ?? 0
    // Retained bytes map to absolute lifetime offsets via streamBytes.
    // Legacy records (streamBytes unset) fall back to retained-relative 0..len.
    const endOffset = lifetime >= byteLen ? lifetime : byteLen
    const startOffset = endOffset - byteLen
    return { command: session, data, startOffset, endOffset }
  }

  if (broker) {
    broker.setResolver({
      async getSession(commandID, ownerSessionID) {
        const directory = commandDirs.get(commandID)
        if (!directory) return undefined
        const s = await readState(directory)
        const c = (s.commands ?? []).find((x) => x.id === commandID)
        return c && c.ownerSessionID === ownerSessionID ? c : undefined
      },
      async waitForQuiesce(commandID) {
        await waitForOperations(commandID)
      },
      async readSnapshot(commandID, ownerSessionID) {
        return readBrokerSnapshot(commandID, ownerSessionID)
      },
    })
  }

  async function persistOutput(directory: string, id: string, chunk: string): Promise<void> {
    rememberDir(id, directory)
    const entry = live.get(id)
    if (entry) {
      const bytes = Buffer.from(chunk)
      entry.buffers.push(bytes)
      entry.bufferedBytes += bytes.length
      // Bound in-memory tail (keep ~128KB); the log file is the durable replay.
      while (entry.bufferedBytes > 128 * 1024 && entry.buffers.length > 1) {
        const dropped = entry.buffers.shift()!
        entry.bufferedBytes -= dropped.length
      }
    }
    await appendCommandLog(directory, id, chunk)
    // Output for one command is serialized, so append and truncation cannot
    // overwrite each other. outputBytes is the retained file size, not an
    // unbounded lifetime counter.
    let retainedBytes = 0
    let truncated = false
    const file = path.join(loopCommandsDir(directory), `${id}.log`)
    const stat = await fs.stat(file)
    retainedBytes = stat.size
    if (stat.size > MAX_COMMAND_OUTPUT_BYTES) {
      const fh = await fs.open(file, "r")
      try {
        const buf = Buffer.alloc(MAX_COMMAND_OUTPUT_BYTES)
        await fh.read(buf, 0, buf.length, stat.size - buf.length)
        await fs.writeFile(file, buf)
      } finally {
        await fh.close()
      }
      retainedBytes = MAX_COMMAND_OUTPUT_BYTES
      truncated = true
    }
    await mutateState(directory, `cmd.output:${id}`, async (s) => {
      const c = (s.commands ?? []).find((x) => x.id === id)
      if (!c) return s
      // Lifetime-monotonic streamBytes advances inside the same transaction
      // as the retained-size bookkeeping, so offsets and files stay in sync.
      const byteLen = utf8ByteLength(chunk)
      const startOffset = c.streamBytes ?? 0
      const endOffset = startOffset + byteLen
      c.streamBytes = endOffset
      c.outputBytes = retainedBytes
      if (truncated) c.truncated = true
      c.updatedAt = new Date().toISOString()
      return s
    })
    // Persist-first-then-emit: offsets are absolute lifetime bytes. Re-read
    // the fresh counter so a concurrent legacy record cannot skew math.
    try {
      const fresh = await readState(directory).then(
        (s) => (s.commands ?? []).find((x) => x.id === id),
      )
      const endOffset = fresh?.streamBytes ?? 0
      const startOffset = endOffset - utf8ByteLength(chunk)
      if (fresh && startOffset >= 0) {
        emitBroker(id, {
          type: "output",
          commandID: id,
          data: chunk,
          startOffset,
          endOffset,
        })
      }
    } catch {
      // Read-back is best-effort; persistence already succeeded.
    }
  }

  async function persistExit(directory: string, id: string, info: { exitCode: number; signal?: string }): Promise<void> {
    rememberDir(id, directory)
    live.delete(id)
    await mutateState(directory, `cmd.exit:${id}`, async (s) => {
      const c = (s.commands ?? []).find((x) => x.id === id)
      if (!c || c.status !== "running") return s
      // Honest outcome: a SIGINT/SIGTERM that the process converted into an
      // exit code is still "exited"; only an explicit terminate action (or a
      // signal recorded by the host kill path) marks "terminated".
      c.exitCode = info.exitCode
      if (info.signal && (c.signal === "SIGKILL" || c.signal === "SIGTERM")) {
        c.status = "terminated"
      } else {
        c.status = "exited"
        if (info.signal) c.signal = info.signal
      }
      c.endedAt = new Date().toISOString()
      c.updatedAt = c.endedAt
      return s
    }).catch(() => {})
    await appendEvent(directory, {
      version: 1,
      eventID: randomUUID(),
       commandID: id,
      type: "command.exited",
      exitCode: info.exitCode,
      timestamp: new Date().toISOString(),
      revision: 0,
    }).catch(() => {})
    // Ledger first (existing ordering), then broker status with fresh metadata.
    try {
      const fresh = await readState(directory).then(
        (s) => (s.commands ?? []).find((x) => x.id === id),
      )
      if (fresh) emitBroker(id, { type: "status", command: fresh })
    } catch {}
  }

  function owned(cmd: CommandSession | undefined, ownerSessionID: string): cmd is CommandSession {
    return !!cmd && cmd.ownerSessionID === ownerSessionID
  }

  return {
    async start(directory, input) {
      const title = input.title.trim()
      const command = input.command.trim()
      if (!title) throw new Error("title is required")
      if (!command) throw new Error("command is required")
      if (!input.ownerSessionID || input.ownerSessionID === "main") {
        throw new Error("A valid owner session is required. Run from an active OpenCode session.")
      }
      const id = randomUUID() as CommandSessionID
      const cwd = input.cwd || directory
      type PendingEvent = { type: "output"; chunk: string } | { type: "exit"; info: { exitCode: number; signal?: string } }
      const pending: PendingEvent[] = []
      let ready = false
      const handle = host.spawn(
        { command, args: input.args ?? [], cwd, cols: input.cols, rows: input.rows },
        (chunk) => {
          if (!ready) pending.push({ type: "output", chunk })
          else void enqueue(id, () => persistOutput(directory, id, chunk)).catch(() => {})
        },
        (info) => {
          if (!ready) pending.push({ type: "exit", info })
          else void enqueue(id, () => persistExit(directory, id, info)).catch(() => {})
        },
      )
      const session = createCommandSession({
        id,
        title,
        command,
        args: input.args ?? [],
        cwd,
        ownerSessionID: input.ownerSessionID,
        goalID: input.goalID,
        pid: handle.pid,
        cols: input.cols,
        rows: input.rows,
      })
      try {
        await mutateState(directory, `cmd.start:${id}`, async (s) => {
          s.commands = [...(s.commands ?? []), session]
          return s
        })
      } catch (error) {
        handle.terminate()
        const exited = await Promise.race([
          handle.exited().then(() => true, () => true),
          new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1000)),
        ])
        if (!exited && handle.isAlive()) handle.kill()
        throw error
      }
      live.set(id, { handle, buffers: [], bufferedBytes: 0 })
      rememberDir(id, directory)
      await appendEvent(directory, {
        version: 1,
        eventID: randomUUID(),
        ...(input.goalID ? { goalID: input.goalID } : {}),
        commandID: id,
        type: "command.started",
        title,
        timestamp: new Date().toISOString(),
        revision: 0,
      }).catch(() => {})
      // Ledger first (existing ordering), then broker status with fresh
      // metadata. Buffered pending[] replay flows through the same
      // persist-then-emit path, so immediate-exit ordering (started before
      // exited) holds for subscribers too.
      try {
        const fresh = await readState(directory).then(
          (s) => (s.commands ?? []).find((x) => x.id === id),
        )
        if (fresh) emitBroker(id, { type: "status", command: fresh })
      } catch {}
      // Release callbacks only after both metadata and the live handle exist.
      // Snapshot the pre-persistence events and switch new callbacks directly
      // to the queue first, so a chatty process cannot keep start() draining an
      // ever-growing pending array forever.
      const initialEvents = pending.splice(0)
      ready = true
      const initialOperations: Promise<void>[] = []
      for (const event of initialEvents) {
        initialOperations.push(event.type === "output"
          ? enqueue(id, () => persistOutput(directory, id, event.chunk))
          : enqueue(id, () => persistExit(directory, id, event.info)))
      }
      await Promise.all(initialOperations)
      return (await this.get(directory, id, input.ownerSessionID)) ?? session
    },

    async list(directory, ownerSessionID) {
      const s = await readState(directory)
      for (const c of s.commands ?? []) rememberDir(c.id, directory)
      return (s.commands ?? []).filter((c) => c.ownerSessionID === ownerSessionID)
    },

    async get(directory, id, ownerSessionID) {
      rememberDir(id, directory)
      const s = await readState(directory)
      const c = (s.commands ?? []).find((x) => x.id === id)
      return owned(c, ownerSessionID) ? c : undefined
    },

    async read(directory, id, ownerSessionID, opts) {
      await waitForOperations(id)
      const session = await this.get(directory, id, ownerSessionID)
      if (!session) return undefined
      const entry = live.get(id)
      const offset = opts?.offsetBytes ?? 0
      const limit = Math.min(opts?.limitBytes ?? 64 * 1024, 256 * 1024)
      if (entry && offset === 0) {
        // Fast path: serve recent in-memory tail merged with file when small.
        const mem = tailText(entry, limit)
        if (entry.bufferedBytes <= limit) {
          const file = await readCommandLog(directory, id, { offsetBytes: 0, limitBytes: 0 })
          void file
          const memBytes = Buffer.byteLength(mem)
          return { session, text: mem, totalBytes: session.outputBytes, startByte: Math.max(0, session.outputBytes - memBytes), live: session.status === "running" }
        }
      }
      const file = await readCommandLog(directory, id, { offsetBytes: offset, limitBytes: limit })
      return { session, text: file.text, totalBytes: session.outputBytes, startByte: file.startByte, live: session.status === "running" }
    },

    async write(directory, id, ownerSessionID, data) {
      const session = await this.get(directory, id, ownerSessionID)
      if (!session) return { ok: false, message: "Command not found." }
      if (session.status !== "running") return { ok: false, message: `Command is ${session.status}; only running commands accept input.` }
      const entry = live.get(id)
      const ok = entry ? entry.handle.write(data) : false
      if (!ok) return { ok: false, message: "Process input unavailable (no live handle — host may have restarted; reconcile marks it honestly)." }
      return { ok: true, message: `Sent ${Buffer.byteLength(data)} byte(s) to "${session.title}".` }
    },

    async resize(directory, id, ownerSessionID, cols, rows) {
      const session = await this.get(directory, id, ownerSessionID)
      if (!session) return { ok: false, message: "Command not found." }
      // Capability is honestly unsupported: store the request, do not claim it.
      await mutateState(directory, `cmd.resize:${id}`, async (s) => {
        const c = (s.commands ?? []).find((x) => x.id === id)
        if (c && c.ownerSessionID === ownerSessionID) {
          c.cols = cols
          c.rows = rows
          c.updatedAt = new Date().toISOString()
        }
        return s
      })
      return { ok: false, unsupported: true, message: "Resize is not supported by the local-process host (pipes have no tty winsize). Size stored for a future PTY host; output remains a byte stream." }
    },

    async interrupt(directory, id, ownerSessionID) {
      const session = await this.get(directory, id, ownerSessionID)
      if (!session) return { ok: false, message: "Command not found." }
      if (session.status !== "running") return { ok: false, message: `Command is ${session.status}; nothing to interrupt.` }
      const entry = live.get(id)
      if (!entry) return { ok: false, message: "No live handle (host restarted?). Reconcile will mark it missing; use terminate/remove to clean up." }
      // Ctrl+C semantics: deliver SIGINT, do NOT kill. The process may trap
      // and continue — that is correct behavior, not a failure.
      const delivered = entry.handle.interrupt()
      if (!delivered) return { ok: false, message: "Failed to deliver SIGINT." }
      await mutateState(directory, `cmd.interrupt:${id}`, async (s) => {
        const c = (s.commands ?? []).find((x) => x.id === id)
        if (c && c.ownerSessionID === ownerSessionID) {
          c.signal = "SIGINT"
          c.updatedAt = new Date().toISOString()
        }
        return s
      })
      return { ok: true, message: `SIGINT delivered to "${session.title}" (process may continue if it traps the signal).` }
    },

    async terminate(directory, id, ownerSessionID) {
      rememberDir(id, directory)
      const session = await this.get(directory, id, ownerSessionID)
      if (!session) return { ok: false, message: "Command not found." }
      if (session.status !== "running") return { ok: false, message: `Command is ${session.status}; nothing to terminate.` }
      // Claim termination BEFORE signaling: onExit honors a recorded
      // SIGTERM/SIGKILL and marks "terminated", so the exit event can never
      // win the race and misreport an explicit terminate as a natural exit.
      await mutateState(directory, `cmd.terminate-claim:${id}`, async (s) => {
        const c = (s.commands ?? []).find((x) => x.id === id)
        if (c && c.ownerSessionID === ownerSessionID && c.status === "running") {
          c.signal = "SIGTERM"
          c.updatedAt = new Date().toISOString()
        }
        return s
      }).catch(() => {})
      // Claim persisted: emit intermediate status so subscribers see the
      // SIGTERM claim even if the exit event races in.
      try {
        const claimed = await readState(directory).then(
          (st) => (st.commands ?? []).find((x) => x.id === id),
        )
        if (claimed) emitBroker(id, { type: "status", command: claimed })
      } catch {}
      const entry = live.get(id)
      let status: CommandSessionStatus = "terminated"
      if (entry) {
        const aliveBefore = entry.handle.isAlive()
        if (!aliveBefore) {
          status = "exited"
        } else {
          entry.handle.terminate()
          // Brief grace, then escalate honestly.
          const exited = await Promise.race([
            entry.handle.exited().then(() => true),
            new Promise<boolean>((r) => setTimeout(() => r(false), 3000)),
          ])
          if (!exited && entry.handle.isAlive()) entry.handle.kill()
          try {
            await entry.handle.exited()
          } catch {}
        }
        live.delete(id)
      }
      const exitCode = status === "terminated" ? 143 : undefined
      await mutateState(directory, `cmd.terminate:${id}`, async (s) => {
        const c = (s.commands ?? []).find((x) => x.id === id)
        if (!c || c.ownerSessionID !== ownerSessionID) return s
        if (c.status === "running") {
          // No exit event observed (e.g. no live handle): finalize here.
          c.status = status
          if (exitCode !== undefined) c.exitCode = c.exitCode ?? exitCode
          c.signal = c.signal ?? "SIGTERM"
          c.endedAt = new Date().toISOString()
          c.updatedAt = c.endedAt
        } else if (c.status === "terminated" && !c.endedAt) {
          // onExit already marked terminated via the claimed signal: fill in
          // the terminal timestamps/defaults it could not know.
          if (exitCode !== undefined) c.exitCode = c.exitCode ?? exitCode
          c.endedAt = new Date().toISOString()
          c.updatedAt = c.endedAt
        }
        // "exited" (natural death raced in) is left untouched — honest.
        return s
      })
      // Terminal persistence done: emit fresh status (terminated or honest exited).
      try {
        const fresh = await readState(directory).then(
          (st) => (st.commands ?? []).find((x) => x.id === id),
        )
        if (fresh) emitBroker(id, { type: "status", command: fresh })
      } catch {}
      // Stopping a command never touches goals — no goal import exists here
      // by construction. Detach needs nothing: viewers simply stop reading.
      return { ok: true, message: `Command "${session.title}" ${status}.` }
    },

    async remove(directory, id, ownerSessionID) {
      rememberDir(id, directory)
      const session = await this.get(directory, id, ownerSessionID)
      if (!session) return { ok: false, message: "Command not found." }
      if (session.status === "running") {
        return { ok: false, message: `Command "${session.title}" is still running — terminate it first (terminate ≠ remove).` }
      }
      // Capture pre-delete metadata for the post-persistence status emit.
      const lastKnown = { ...session }
      await mutateState(directory, `cmd.remove:${id}`, async (s) => {
        s.commands = (s.commands ?? []).filter((x) => !(x.id === id && x.ownerSessionID === ownerSessionID))
        return s
      })
      await removeCommandLog(directory, id)
      emitBroker(id, { type: "status", command: lastKnown })
      return { ok: true, message: `Command "${session.title}" removed.` }
    },

    async reconcile(directory) {
      // Local-process handles never survive restart: any persisted "running"
      // without a live handle is honestly missing. Live map entries whose
      // process died are exited via onExit already; belt-and-braces check here.
      const state = await readState(directory)
      const cmds = state.commands ?? []
      for (const c of cmds) rememberDir(c.id, directory)
      let markedMissing = 0
      for (const c of cmds) {
        if (c.status !== "running") continue
        const entry = live.get(c.id)
        if (entry) {
          if (!entry.handle.isAlive()) {
            live.delete(c.id)
            await mutateState(directory, `cmd.reconcile-exit:${c.id}`, async (s) => {
              const x = (s.commands ?? []).find((y) => y.id === c.id)
              if (x && x.status === "running") {
                x.status = "exited"
                x.endedAt = new Date().toISOString()
                x.updatedAt = x.endedAt
                x.lastError = x.lastError ?? "Process handle died without an exit event."
              }
              return s
            }).catch(() => {})
            try {
              const fresh = await readState(directory).then(
                (st) => (st.commands ?? []).find((y) => y.id === c.id),
              )
              if (fresh) emitBroker(c.id, { type: "status", command: fresh })
            } catch {}
          }
          continue
        }
        await mutateState(directory, `cmd.reconcile-missing:${c.id}`, async (s) => {
          const x = (s.commands ?? []).find((y) => y.id === c.id)
          if (x && x.status === "running") {
            x.status = "missing"
            x.lastError = "Host restarted or handle lost — no live execution found. Output log retained; remove to clean up."
            x.updatedAt = new Date().toISOString()
            markedMissing++
          }
          return s
        }).catch(() => {})
        try {
          const fresh = await readState(directory).then(
            (st) => (st.commands ?? []).find((y) => y.id === c.id),
          )
          if (fresh && fresh.status === "missing") emitBroker(c.id, { type: "status", command: fresh })
        } catch {}
      }
      return { markedMissing }
    },

    async dispose(directory) {
      const state = await readState(directory)
      const owned = new Map<string, string>((state.commands ?? []).map((command) => [command.id, command.ownerSessionID]))
      await Promise.all([...live.entries()].map(async ([id, entry]) => {
        const owner = owned.get(id)
        if (owner) {
          await this.terminate(directory, id, owner).catch(() => {})
          return
        }
        entry.handle.terminate()
        const exited = await Promise.race([
          entry.handle.exited().then(() => true, () => true),
          new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1000)),
        ])
        if (!exited && entry.handle.isAlive()) entry.handle.kill()
        live.delete(id)
      }))
    },
  }
}
