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
  shouldNotifyOwnerOnExit,
  normalizeTimeoutSeconds,
  computeDeadlineAt,
  MAX_COMMAND_OUTPUT_BYTES,
  MAX_COMMAND_READ_LINES,
  type CommandSession,
  type CommandSessionID,
  type CommandSessionStatus,
} from "../domain/command-session"
import {
  CommandWatcher,
  compileWatchSpec,
  createLineAssembler,
  formatWatchBudgetMessage,
  formatWatchFloodMessage,
  formatWatchMessage,
  initialWatchState,
  WATCH_COALESCE_WINDOW_MS,
  type LineAssembler,
  type WatchFeedResult,
  type WatchState,
  type WatchUntilAction,
} from "../domain/command-watch"
import { isTerminalCommandStatus, formatAwaitEvidence } from "../domain/command-await"
import type { CommandHost, CommandProcessHandle } from "../server/command-host"
import { utf8ByteLength, type CommandStreamMessage } from "../domain/command-events"
import type { CommandEventBroker } from "./command-event-broker"
import { clearAwaitsForCommand, fireCommandAwaits, fireUntilAwaits, readBoundedTail, type FiredAwait } from "./command-await"
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
  /** Owner-exit-notification policy. Undefined = auto (see shouldNotifyOwnerOnExit). */
  notifyOnExit?: boolean
  cols?: number
  rows?: number
  /** Extra env vars for the child (passed to the host; only NAMES persisted in envKeys). */
  env?: Record<string, string>
  /** Per-command timeout in seconds (positive integer; in-memory timer kills via the terminate path). */
  timeoutSeconds?: number
  /**
   * When true, spawn via `/bin/sh -c` with command+args joined into one shell
   * string (POSIX single-quote escaping: `'` → `'\''`). Shell metacharacters
   * (pipes, globs, `&&`) are interpreted; quoting is the caller's job for
   * dynamic values — prefer argv form (shell:false) for untrusted input.
   */
  shell?: boolean
  // ─── M2 watch (line-level filter/until notifications) ────────────────────
  // Empty string counts as unset. Invalid regexes fail closed at start (throw
  // before spawning — same dangerous-pattern guard as pattern reads).
  /** Regex source: only matching lines buffer toward an owner push. */
  watchFilter?: string
  /** Regex source on the filter-surviving stream; first match fires the until path. */
  watchUntil?: string
  /** Case-insensitive watch matching. */
  watchIgnoreCase?: boolean
  /** "stop" (default) terminates on until-match; "keep" keeps running. */
  watchUntilAction?: WatchUntilAction
}

export interface CommandReadResult {
  session: CommandSession
  text: string
  totalBytes: number
  startByte: number
  /** Live/streaming truth: process still producing output. */
  live: boolean
  /** Pattern-mode only: echo of the filter + match counts. */
  pattern?: string
  totalMatches?: number
}

// ─── Pattern-read helpers (pty parity) ───────────────────────────────────────
// Lines are split on \n; matching runs against ANSI-stripped text (CSI/OSC
// sequences removed) while the ORIGINAL line (with escapes) is returned.

const ANSI_PATTERN = new RegExp(
  "\u001b\\[[0-9;?]*[ -/]*[@-~]|\u001b\\][^\u0007]*(?:\u0007|\u001b\\\\)|\u001b[()][0-9A-Z]",
  "g",
)

export function stripAnsiForMatch(line: string): string {
  return line.replace(ANSI_PATTERN, "")
}

const DANGEROUS_REGEXES: RegExp[] = [
  /\(\?:.*\)\*.*\(\?:.*\)\*/, // nested optional groups with repetition (pty)
  /.*\(\.\*\?\)\{2,\}.*/, // overlapping non-greedy quantifiers (pty)
  /.*\(.*\|.*\)\{3,\}.*/, // complex alternation with repetition (pty)
  /\([^()]*[+*][^()]*\)[+*]/, // nested quantifier: quantified group containing a quantifier, e.g. (a+)+
  /\([^()]*(\.\*.*\.\*|\.\+.*\.\+|\\w\+.*\\s\*|\\s\*.*\\w\+)[^()]*\)/, // overlapping classes inside one group, e.g. (.*.*)
]

export function validateReadPattern(pattern: string): RegExp | { error: string } {
  let compiled: RegExp
  try {
    compiled = new RegExp(pattern)
  } catch (e) {
    return { error: `Invalid regex pattern '${pattern}': ${e instanceof Error ? e.message : String(e)}` }
  }
  if (DANGEROUS_REGEXES.some((d) => d.test(pattern))) {
    return { error: `Potentially dangerous regex pattern rejected: '${pattern}'. Please use a safer pattern.` }
  }
  return compiled
}

/** Quote one argv word for POSIX sh -c joining. */
export function shellQuote(word: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(word)) return word
  return `'${word.replace(/'/g, `'\\''`)}'`
}

export function shellJoin(command: string, args: string[]): string {
  return [command, ...args].map(shellQuote).join(" ")
}

export interface CommandService {
  start(directory: string, input: CommandStartInput): Promise<CommandSession>
  list(directory: string, ownerSessionID: string): Promise<CommandSession[]>
  get(directory: string, id: string, ownerSessionID: string): Promise<CommandSession | undefined>
  read(
    directory: string,
    id: string,
    ownerSessionID: string,
    opts?: { offsetBytes?: number; limitBytes?: number; pattern?: string; ignoreCase?: boolean },
  ): Promise<CommandReadResult | undefined>
  write(directory: string, id: string, ownerSessionID: string, data: string): Promise<{ ok: boolean; message: string }>
  resize(directory: string, id: string, ownerSessionID: string, cols: number, rows: number): Promise<{ ok: boolean; message: string; unsupported?: boolean }>
  interrupt(directory: string, id: string, ownerSessionID: string): Promise<{ ok: boolean; message: string }>
  terminate(directory: string, id: string, ownerSessionID: string, opts?: { remove?: boolean }): Promise<{ ok: boolean; message: string; removed?: boolean }>
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
  opts?: {
    broker?: CommandEventBroker
    /**
     * Called with exactly-once fired awaits after a command reaches a
     * terminal status. The service itself never touches goals: the
     * composition root wires this to inbox+continuation (see
     * command-await.wakeGoalForAwait). Defaults to a no-op — firing still
     * consumes the await and queues evidence in pendingInbox.
     */
    onAwaitFired?: (directory: string, fired: FiredAwait[]) => Promise<void>
    /**
     * Called at most once per command with a ready-to-send message when a
     * terminal command's exit is worth pinging the OWNER session about
     * (see shouldNotifyOwnerOnExit) — independent of awaits: a command with
     * no linked goal and no await still reaches the owner here. Defaults to
     * a no-op — the exactly-once marker is still set either way.
     */
    onOwnerNotify?: (directory: string, ownerSessionID: string, message: string) => Promise<void>
    /**
     * M2 watch pushes: coalesced `[watch "<title>"]` matched-lines messages,
     * flood/budget suspension notices, and until-match notices. Same channel
     * as onOwnerNotify (the composition root wires both to host.notifyOwner).
     * Failures never break persistence.
     */
    onWatchNotify?: (directory: string, ownerSessionID: string, message: string) => Promise<void>
    /**
     * Coalescing window override (default WATCH_COALESCE_WINDOW_MS). Tests use
     * a small value; production keeps the 2000ms policy constant.
     */
    watchCoalesceMs?: number
  },
): CommandService {
  type LiveEntry = { handle: CommandProcessHandle; buffers: Buffer[]; bufferedBytes: number }
  const live = new Map<string, LiveEntry>()
  const operations = new Map<string, Promise<void>>()
  const broker = opts?.broker
  // commandID -> owning directory (service methods are directory-scoped but
  // the broker subscribe() contract is not; the resolver recovers the
  // directory from recent service activity — single-project assumption).
  const commandDirs = new Map<string, string>()
  // In-memory timeout timers only: never persisted, never resurrected across
  // restart. A fresh service instance starts with zero timers, so reconcile
  // honestly marks overdue commands missing instead of reviving a deadline.
  const timeouts = new Map<string, ReturnType<typeof setTimeout>>()
  const timeoutOwners = new Map<string, { directory: string; ownerSessionID: string }>()
  // ─── M2 watch runtime (in-memory only) ───────────────────────────────────
  // Watchers never survive restart (commands don't either); the persisted
  // watchFilter/watchUntil/watchState fields are the durable half. Coalesce
  // timers are unref'd like timeout timers. Bare assemblers give await-until
  // correct line splitting on commands without a configured watch.
  const watchers = new Map<string, CommandWatcher>()
  const watchTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const awaitAsm = new Map<string, LineAssembler>()
  const watchCoalesceMs = opts?.watchCoalesceMs ?? WATCH_COALESCE_WINDOW_MS

  function clearWatchTimer(id: string): void {
    const t = watchTimers.get(id)
    if (t) {
      try {
        globalThis.clearTimeout(t)
      } catch {
        // Timer already fired — harmless.
      }
    }
    watchTimers.delete(id)
  }

  function deleteWatch(id: string): void {
    clearWatchTimer(id)
    watchers.delete(id)
    awaitAsm.delete(id)
  }

  function scheduleWatchFlush(directory: string, id: string): void {
    if (watchTimers.has(id)) return
    const handle = setTimeout(() => {
      watchTimers.delete(id)
      void enqueue(id, () => flushWatch(directory, id)).catch(() => {})
    }, Math.max(0, watchCoalesceMs))
    try {
      ;(handle as unknown as { unref?: () => void }).unref?.()
    } catch {}
    watchTimers.set(id, handle)
  }

  async function persistWatchState(directory: string, id: string, state: WatchState): Promise<void> {
    await mutateState(directory, `cmd.watch:${id}`, async (s) => {
      const c = (s.commands ?? []).find((x) => x.id === id)
      if (c) {
        c.watchState = { ...state }
        c.updatedAt = new Date().toISOString()
      }
      return s
    })
  }

  function watchLedger(
    directory: string,
    commandID: string,
    type: "command.watch-matched" | "command.watch-suspended" | "command.until-stopped",
    extra?: Record<string, unknown>,
  ): Promise<void> {
    return appendEvent(directory, {
      version: 1,
      eventID: randomUUID(),
      commandID,
      type,
      timestamp: new Date().toISOString(),
      revision: 0,
      ...extra,
    }).catch(() => {})
  }

  function clearCommandTimeout(id: string): void {
    const t = timeouts.get(id)
    if (t) {
      try {
        globalThis.clearTimeout(t)
      } catch {
        // Timer already fired — harmless.
      }
    }
    timeouts.delete(id)
    timeoutOwners.delete(id)
  }

  function scheduleTimeout(directory: string, id: string, ownerSessionID: string, timeoutSeconds: number): void {
    clearCommandTimeout(id)
    const handle = setTimeout(() => {
      timeouts.delete(id)
      void fireTimeout(directory, id).catch(() => {})
    }, timeoutSeconds * 1000)
    // Don't hold the process open for a background deadline.
    try {
      ;(handle as unknown as { unref?: () => void }).unref?.()
    } catch {}
    timeouts.set(id, handle)
    timeoutOwners.set(id, { directory, ownerSessionID })
  }

  /**
   * Timeout path: run the existing terminate flow (SIGTERM → grace → SIGKILL),
   * then stamp endReason=timeout + endedAt over the "terminated" it produced.
   * Owner-notify fires once here (auto-policy always notifies on timeout);
   * the inner terminate's own notify stays silent for caller-initiated
   * "terminated", so no duplicate ping is possible.
   */
  async function fireTimeout(directory: string, id: string): Promise<void> {
    const owner = timeoutOwners.get(id)?.ownerSessionID
    timeoutOwners.delete(id)
    if (!owner) return
    const before = await readState(directory).then(
      (s) => (s.commands ?? []).find((x) => x.id === id),
    )
    if (!before || before.status !== "running") return
    await service.terminate(directory, id, owner).catch(() => {})
    await mutateState(directory, `cmd.timeout:${id}`, async (s) => {
      const c = (s.commands ?? []).find((x) => x.id === id)
      if (!c) return s
      c.endReason = "timeout"
      c.lastError = c.lastError ?? `Command timed out after ${c.timeoutSeconds ?? "?"}s (timeoutSeconds deadline reached; terminated via the standard SIGTERM→SIGKILL path).`
      if (!c.endedAt) {
        c.endedAt = new Date().toISOString()
        c.updatedAt = c.endedAt
      } else {
        c.updatedAt = new Date().toISOString()
      }
      return s
    }).catch(() => {})
    try {
      const fresh = await readState(directory).then(
        (st) => (st.commands ?? []).find((x) => x.id === id),
      )
      if (fresh) emitBroker(id, { type: "status", command: fresh })
    } catch {}
    await fireAwaits(directory, id)
    await notifyOwnerIfNeeded(directory, id)
  }

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

  /**
   * Fire outstanding opt-in awaits for a terminal command (exactly-once:
   * the await is consumed before delivery, so duplicate/late status events
   * are no-ops). Output chunks never reach here — callers are terminal
   * paths only (exit, terminate-finalize, reconcile-missing).
   */
  async function fireAwaits(directory: string, id: string): Promise<void> {
    try {
      const fired = await fireCommandAwaits(directory, id)
      if (fired.length === 0) return
      await opts?.onAwaitFired?.(directory, fired)
    } catch {
      // Await delivery never breaks command persistence.
    }
  }

  /**
   * Owner-exit notification: independent of awaits/goal-linkage. Claims the
   * exactly-once `ownerNotifiedAt` marker atomically (same terminal-claim
   * pattern as terminate()), then delivers a bounded-tail evidence message.
   * A command with zero awaits and no goal still reaches the owner here —
   * this is the edge that was previously silent (dashboard-only).
   */
  async function notifyOwnerIfNeeded(directory: string, id: string): Promise<void> {
    try {
      let target: CommandSession | undefined
      await mutateState(directory, `cmd.notify-claim:${id}`, async (s) => {
        const c = (s.commands ?? []).find((x) => x.id === id)
        if (!c) return s
        if (c.ownerNotifiedAt) return s
        if (!isTerminalCommandStatus(c.status)) return s
        if (!shouldNotifyOwnerOnExit(c)) return s
        c.ownerNotifiedAt = new Date().toISOString()
        target = { ...c }
        return s
      })
      if (!target) return
      const tail = await readBoundedTail(directory, id)
      const message = formatAwaitEvidence({
        title: target.title,
        argv: [target.command, ...target.args],
        commandID: target.id,
        status: target.status,
        exitCode: target.exitCode,
        signal: target.signal,
        tail,
      })
      await opts?.onOwnerNotify?.(directory, target.ownerSessionID, message)
    } catch {
      // Notify delivery never breaks command persistence.
    }
  }

  /**
   * M2 coalesce flush: deliver one bounded push for the buffered matches.
   * One push per flush cycle (overflow re-schedules); budget exhaustion emits
   * its one-shot notice here. Notify failures never break persistence.
   */
  async function flushWatch(directory: string, id: string): Promise<void> {
    const watcher = watchers.get(id)
    if (!watcher || watcher.pendingCount === 0) return
    let session: CommandSession | undefined
    try {
      session = await readState(directory).then(
        (s) => (s.commands ?? []).find((x) => x.id === id),
      )
    } catch {
      return
    }
    if (!session || session.status !== "running") return
    const push = watcher.takePush()
    await persistWatchState(directory, id, watcher.state).catch(() => {})
    if (!push) return
    if (push.exhaustedNow) {
      await watchLedger(directory, id, "command.watch-suspended", { reason: "budget", pushes: watcher.state.pushes })
      try {
        await opts?.onWatchNotify?.(directory, session.ownerSessionID, formatWatchBudgetMessage(session.title))
      } catch {
        // Notify delivery never breaks command persistence.
      }
      return
    }
    await watchLedger(directory, id, "command.watch-matched", {
      lines: push.lines.length,
      matches: watcher.state.matches,
      pushes: watcher.state.pushes,
    })
    try {
      await opts?.onWatchNotify?.(directory, session.ownerSessionID, formatWatchMessage(session.title, push.lines))
    } catch {
      // Notify delivery never breaks command persistence.
    }
    if (watcher.pendingCount > 0) scheduleWatchFlush(directory, id)
  }

  /**
   * M2 until-match: deliver pending+matching line immediately, claim the
   * exactly-once owner marker (suppressing the later standard exit ping),
   * then stop (terminate + endReason="until") or keep running.
   * Runs serialized per command (via enqueue) so it can't race persistence.
   */
  async function handleUntilMatch(directory: string, id: string): Promise<void> {
    const watcher = watchers.get(id)
    if (!watcher) return
    clearWatchTimer(id)
    let session: CommandSession | undefined
    try {
      session = await readState(directory).then(
        (s) => (s.commands ?? []).find((x) => x.id === id),
      )
    } catch {
      return
    }
    if (!session) return
    const action = watcher.untilAction
    const lines = watcher.takeUntilPush()
    const snapshot: WatchState = { ...watcher.state }
    const message = formatWatchMessage(
      session.title,
      lines,
      `-- until "${session.watchUntil ?? ""}" matched (action=${action})`,
    )
    // Claim the exactly-once owner marker NOW so the subsequent standard exit
    // notify (from terminate/persistExit below) skips: exactly one owner
    // message total for an until-stop. For keep the until notice is
    // ADDITIONAL — the later exit ping behaves normally, so leave the marker.
    await mutateState(directory, `cmd.until-claim:${id}`, async (s) => {
      const c = (s.commands ?? []).find((x) => x.id === id)
      if (!c) return s
      c.watchState = { ...snapshot }
      if (action === "stop" && !c.ownerNotifiedAt) c.ownerNotifiedAt = new Date().toISOString()
      c.updatedAt = new Date().toISOString()
      return s
    }).catch(() => {})
    await watchLedger(directory, id, "command.watch-matched", {
      until: session.watchUntil ?? "",
      lines: lines.length,
      pushes: snapshot.pushes,
    })
    try {
      await opts?.onWatchNotify?.(directory, session.ownerSessionID, message)
    } catch {
      // Notify delivery never breaks command persistence.
    }
    if (action !== "stop") return // keep: filter stream continues, until spent
    if (session.status !== "running") return // already terminal: nothing to stop
    await watchLedger(directory, id, "command.until-stopped", { until: session.watchUntil ?? "" })
    await service.terminate(directory, id, session.ownerSessionID).catch(() => {})
    // Stamp endReason=until over the "terminate" the standard path produced
    // (same overlay pattern as the timeout path).
    await mutateState(directory, `cmd.until:${id}`, async (s) => {
      const c = (s.commands ?? []).find((x) => x.id === id)
      if (!c) return s
      if (c.status === "terminated" && c.endReason !== "timeout") {
        c.endReason = "until"
        c.lastError = c.lastError ?? `Watch until pattern "${c.watchUntil ?? ""}" matched; command stopped (untilAction=stop).`
        c.updatedAt = new Date().toISOString()
      }
      return s
    }).catch(() => {})
    try {
      const fresh = await readState(directory).then(
        (st) => (st.commands ?? []).find((x) => x.id === id),
      )
      if (fresh) emitBroker(id, { type: "status", command: fresh })
    } catch {}
    await fireAwaits(directory, id)
    // Deliberately NO notifyOwnerIfNeeded: the until notice claimed the
    // marker, so the owner already got exactly one message.
  }

  async function readBrokerSnapshot(commandID: string, ownerSessionID: string) {    const directory = commandDirs.get(commandID)
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
    // M2 watch feed (in-memory only; never breaks persistence). Lazy-creates
    // the watcher from persisted spec when this instance doesn't have one yet.
    let watcher: CommandWatcher | undefined
    let feed: WatchFeedResult | undefined
    let bareLines: string[] = []
    try {
      watcher = watchers.get(id)
      if (!watcher) {
        const spec = await readState(directory).then(
          (s) => (s.commands ?? []).find((x) => x.id === id),
        ).catch(() => undefined)
        if (spec && spec.status === "running" && (spec.watchFilter !== undefined || spec.watchUntil !== undefined)) {
          try {
            watcher = new CommandWatcher({
              ...(spec.watchFilter !== undefined ? { filter: spec.watchFilter } : {}),
              ...(spec.watchUntil !== undefined ? { until: spec.watchUntil } : {}),
              ...(spec.watchIgnoreCase !== undefined ? { ignoreCase: spec.watchIgnoreCase } : {}),
              ...(spec.watchUntilAction !== undefined ? { untilAction: spec.watchUntilAction } : {}),
            })
            watchers.set(id, watcher)
          } catch {
            watcher = undefined
          }
        }
      }
      if (watcher) {
        feed = watcher.feedChunk(chunk, Date.now())
      } else {
        let asm = awaitAsm.get(id)
        if (!asm) {
          asm = createLineAssembler()
          awaitAsm.set(id, asm)
        }
        bareLines = asm.push(chunk).filter((l) => l.trim() !== "")
      }
    } catch {
      watcher = undefined
      feed = undefined
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
      // M2: watcher counters ride the same persisted write (no extra lock).
      if (watcher) c.watchState = { ...watcher.state }
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
    // M2 post-persistence watch actions (serialized per command; failures
    // never break the persistence above).
    try {
      if (watcher && feed) {
        if (feed.floodNow) {
          await persistWatchState(directory, id, watcher.state).catch(() => {})
          const dropped = watcher.state.droppedLines
          let owner: string | undefined
          let title = id
          try {
            const snap = await readState(directory).then(
              (s) => (s.commands ?? []).find((x) => x.id === id),
            )
            owner = snap?.ownerSessionID
            title = snap?.title ?? id
          } catch {}
          await watchLedger(directory, id, "command.watch-suspended", { reason: "flood", dropped })
          if (owner) {
            try {
              await opts?.onWatchNotify?.(directory, owner, formatWatchFloodMessage(title, dropped))
            } catch {}
          }
        }
        if (watcher.pendingCount > 0) scheduleWatchFlush(directory, id)
        if (feed.untilLine) {
          clearWatchTimer(id)
          // Enqueued behind this op: runs after persistence, never deadlocks
          // the terminate path it may trigger.
          void enqueue(id, () => handleUntilMatch(directory, id)).catch(() => {})
        }
      }
    } catch {
      // Watch actions never break command persistence.
    }
    // M2 await-until: completed stripped lines wake pattern awaits ONCE; the
    // command keeps running. Independent of the watch filter by design.
    try {
      const completed = feed ? feed.completed : bareLines
      if (completed.length > 0) {
        const fired = await fireUntilAwaits(directory, id, completed)
        if (fired.length > 0) {
          await opts?.onAwaitFired?.(directory, fired)
        }
      }
    } catch {
      // Await delivery never breaks command persistence.
    }
  }

  async function persistExit(directory: string, id: string, info: { exitCode: number; signal?: string }): Promise<void> {
    rememberDir(id, directory)
    live.delete(id)
    clearCommandTimeout(id)
    // M2 watch exit-finalize: assemble the trailing partial line, deliver one
    // final bounded push (unless an until-stop already delivered its notice —
    // exactly-once), then drop the in-memory watcher.
    const exitWatcher = watchers.get(id)
    if (exitWatcher) {
      try {
        // An until-stop handled while running already notified; anything the
        // trailing line newly matches still goes out once below (no terminate
        // — the process is already gone, endReason stays honest).
        const handledStop =
          exitWatcher.state.state === "until-matched" && exitWatcher.untilAction === "stop"
        exitWatcher.finish(Date.now())
        let snap: CommandSession | undefined
        try {
          snap = await readState(directory).then(
            (s) => (s.commands ?? []).find((x) => x.id === id),
          )
        } catch {
          snap = undefined
        }
        if (snap && !handledStop && exitWatcher.pendingCount > 0) {
          const push = exitWatcher.takePush()
          await persistWatchState(directory, id, exitWatcher.state).catch(() => {})
          if (push && !push.exhaustedNow && push.lines.length > 0) {
            await watchLedger(directory, id, "command.watch-matched", {
              lines: push.lines.length,
              atExit: true,
              pushes: exitWatcher.state.pushes,
            })
            try {
              await opts?.onWatchNotify?.(directory, snap.ownerSessionID, formatWatchMessage(snap.title, push.lines))
            } catch {}
          } else if (push?.exhaustedNow) {
            await watchLedger(directory, id, "command.watch-suspended", {
              reason: "budget",
              atExit: true,
              pushes: exitWatcher.state.pushes,
            })
            try {
              await opts?.onWatchNotify?.(directory, snap.ownerSessionID, formatWatchBudgetMessage(snap.title))
            } catch {}
          }
        } else {
          await persistWatchState(directory, id, exitWatcher.state).catch(() => {})
        }
      } catch {
        // Watch finalization never breaks exit persistence.
      }
    }
    deleteWatch(id)
    await mutateState(directory, `cmd.exit:${id}`, async (s) => {
      const c = (s.commands ?? []).find((x) => x.id === id)
      if (!c || c.status !== "running") return s
      // Honest outcome: a SIGINT/SIGTERM that the process converted into an
      // exit code is still "exited"; only an explicit terminate action (or a
      // signal recorded by the host kill path) marks "terminated". A timeout
      // claim already stamped by the timer path is never downgraded.
      if (c.endReason === "timeout") {
        if (!c.endedAt) {
          c.endedAt = new Date().toISOString()
          c.updatedAt = c.endedAt
        }
        return s
      }
      c.exitCode = info.exitCode
      if (info.signal && (c.signal === "SIGKILL" || c.signal === "SIGTERM")) {
        c.status = "terminated"
        c.endReason = "terminate"
      } else {
        c.status = "exited"
        c.endReason = "exit"
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
    // Terminal-only wake: fires outstanding opt-in awaits exactly once.
    await fireAwaits(directory, id)
    await notifyOwnerIfNeeded(directory, id)
  }

  function owned(cmd: CommandSession | undefined, ownerSessionID: string): cmd is CommandSession {
    return !!cmd && cmd.ownerSessionID === ownerSessionID
  }

  const service: CommandService = {
    async start(directory, input) {
      const title = input.title.trim()
      const command = input.command.trim()
      if (!title) throw new Error("title is required")
      if (!command) throw new Error("command is required")
      if (!input.ownerSessionID || input.ownerSessionID === "main") {
        throw new Error("A valid owner session is required. Run from an active OpenCode session.")
      }
      // Fail closed BEFORE spawning: an invalid timeout must never start a
      // process without its deadline.
      const timeoutSeconds = normalizeTimeoutSeconds(input.timeoutSeconds)
      // M2 watch: fail closed BEFORE spawning — an invalid regex must never
      // start a process it cannot watch. Empty string counts as unset.
      const watchFilter = input.watchFilter !== undefined && input.watchFilter !== "" ? input.watchFilter : undefined
      const watchUntil = input.watchUntil !== undefined && input.watchUntil !== "" ? input.watchUntil : undefined
      const hasWatch = watchFilter !== undefined || watchUntil !== undefined
      let watcher: CommandWatcher | undefined
      let watchState: WatchState | undefined
      if (hasWatch) {
        // Throws on invalid/dangerous patterns (same guard as pattern reads).
        watcher = new CommandWatcher({
          ...(watchFilter !== undefined ? { filter: watchFilter } : {}),
          ...(watchUntil !== undefined ? { until: watchUntil } : {}),
          ...(input.watchIgnoreCase !== undefined ? { ignoreCase: input.watchIgnoreCase } : {}),
          ...(input.watchUntilAction !== undefined ? { untilAction: input.watchUntilAction } : {}),
        })
        watchState = initialWatchState()
      }
      const startedAt = new Date()
      const id = randomUUID() as CommandSessionID
      const cwd = input.cwd || directory
      const useShell = input.shell === true
      const spawnOpts = useShell
        ? { command: "/bin/sh", args: ["-c", shellJoin(command, input.args ?? [])], cwd, cols: input.cols, rows: input.rows, env: input.env }
        : { command, args: input.args ?? [], cwd, cols: input.cols, rows: input.rows, env: input.env }
      type PendingEvent = { type: "output"; chunk: string } | { type: "exit"; info: { exitCode: number; signal?: string } }
      const pending: PendingEvent[] = []
      let ready = false
      const handle = host.spawn(
        spawnOpts,
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
        notifyOnExit: input.notifyOnExit,
        pid: handle.pid,
        cols: input.cols,
        rows: input.rows,
        shell: useShell ? true : undefined,
        timeoutSeconds,
        deadlineAt: timeoutSeconds !== undefined ? computeDeadlineAt(startedAt, timeoutSeconds) : undefined,
        envKeys: input.env ? Object.keys(input.env) : undefined,
        watchFilter,
        watchUntil,
        watchIgnoreCase: input.watchIgnoreCase,
        watchUntilAction: watcher?.untilAction,
        watchState,
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
      if (watcher) watchers.set(id, watcher)
      if (timeoutSeconds !== undefined) scheduleTimeout(directory, id, input.ownerSessionID, timeoutSeconds)
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
      return (await service.get(directory, id, input.ownerSessionID)) ?? session
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
      const session = await service.get(directory, id, ownerSessionID)
      if (!session) return undefined
      // Pattern mode (pty parity): filter retained-log LINES on ANSI-stripped
      // text, keep the original line in output, and page over MATCHES —
      // offsetBytes skips N matching lines, limitBytes caps matched lines
      // (default 500, hard cap MAX_COMMAND_READ_LINES). Byte snapshot paging
      // below is unchanged when no pattern is given.
      if (opts?.pattern !== undefined) {
        const flags = opts.ignoreCase ? "i" : ""
        const checked = validateReadPattern(opts.pattern)
        if (typeof checked !== "object" || !(checked instanceof RegExp)) {
          throw new Error((checked as { error: string }).error)
        }
        const regex = new RegExp(opts.pattern, flags)
        const full = await readCommandLog(directory, id, { offsetBytes: 0, limitBytes: MAX_COMMAND_OUTPUT_BYTES })
        const lines = full.text.length === 0 ? [] : full.text.split("\n")
        const matches: string[] = []
        for (const line of lines) {
          let stripped: string
          try {
            stripped = stripAnsiForMatch(line)
          } catch {
            stripped = line
          }
          let hit = false
          try {
            hit = regex.test(stripped)
          } catch {
            throw new Error(`Invalid regex pattern '${opts.pattern}'.`)
          }
          // Reset lastIndex for global patterns so every line tests from 0.
          regex.lastIndex = 0
          if (hit) matches.push(line)
        }
        const skip = Math.max(0, opts.offsetBytes ?? 0)
        const take = Math.min(opts.limitBytes ?? MAX_COMMAND_READ_LINES, MAX_COMMAND_READ_LINES)
        const page = matches.slice(skip, skip + Math.max(0, take))
        return {
          session,
          text: page.join("\n") + (page.length > 0 ? "\n" : ""),
          totalBytes: matches.length,
          startByte: skip,
          live: session.status === "running",
          pattern: opts.pattern,
          totalMatches: matches.length,
        }
      }
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
      const session = await service.get(directory, id, ownerSessionID)
      if (!session) return { ok: false, message: "Command not found." }
      if (session.status !== "running") return { ok: false, message: `Command is ${session.status}; only running commands accept input.` }
      const entry = live.get(id)
      const ok = entry ? entry.handle.write(data) : false
      if (!ok) return { ok: false, message: "Process input unavailable (no live handle — host may have restarted; reconcile marks it honestly)." }
      return { ok: true, message: `Sent ${Buffer.byteLength(data)} byte(s) to "${session.title}".` }
    },

    async resize(directory, id, ownerSessionID, cols, rows) {
      const session = await service.get(directory, id, ownerSessionID)
      if (!session) return { ok: false, message: "Command not found." }
      if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols <= 0 || rows <= 0) {
        return { ok: false, message: `Invalid size ${cols}x${rows}: cols and rows must be positive integers.` }
      }
      // Apply to the live handle when the active backend supports it (PTY
      // winsize); otherwise store the request and report honestly.
      const entry = live.get(id)
      let applied = false
      if (entry) {
        try {
          applied = entry.handle.resize(cols, rows)
        } catch {
          applied = false
        }
      }
      await mutateState(directory, `cmd.resize:${id}`, async (s) => {
        const c = (s.commands ?? []).find((x) => x.id === id)
        if (c && c.ownerSessionID === ownerSessionID) {
          c.cols = cols
          c.rows = rows
          c.updatedAt = new Date().toISOString()
        }
        return s
      })
      if (applied) return { ok: true, message: `Terminal resized to ${cols}x${rows} for "${session.title}".` }
      return { ok: false, unsupported: true, message: "Resize is not supported by the active pipe host (pipes have no tty winsize; the PTY backend was unavailable). Size stored; output remains a byte stream." }
    },

    async interrupt(directory, id, ownerSessionID) {
      const session = await service.get(directory, id, ownerSessionID)
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

    async terminate(directory, id, ownerSessionID, opts) {
      rememberDir(id, directory)
      const session = await service.get(directory, id, ownerSessionID)
      if (!session) return { ok: false, message: "Command not found." }
      if (session.status !== "running") {
        // Atomic terminate+remove: an already-terminal command still proceeds
        // to removal when remove:true (caller perspective: one call cleans up).
        if (opts?.remove) {
          const removed = await service.remove(directory, id, ownerSessionID)
          return removed.ok
            ? { ok: true, message: `Command was already ${session.status}; removed.`, removed: true }
            : { ok: false, message: `Command is ${session.status}; remove failed: ${removed.message}` }
        }
        return { ok: false, message: `Command is ${session.status}; nothing to terminate.` }
      }
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
      clearCommandTimeout(id)
      // M2: stop coalesce timers at terminate time; the exit event's
      // persistExit still delivers one final bounded push, then drops the
      // in-memory watcher. (Timer cleared here so it can't double-deliver.)
      clearWatchTimer(id)
      await mutateState(directory, `cmd.terminate:${id}`, async (s) => {
        const c = (s.commands ?? []).find((x) => x.id === id)
        if (!c || c.ownerSessionID !== ownerSessionID) return s
        if (c.status === "running") {
          // No exit event observed (e.g. no live handle): finalize here.
          c.status = status
          if (c.endReason !== "timeout") c.endReason = status === "terminated" ? "terminate" : "exit"
          if (exitCode !== undefined) c.exitCode = c.exitCode ?? exitCode
          c.signal = c.signal ?? "SIGTERM"
          c.endedAt = new Date().toISOString()
          c.updatedAt = c.endedAt
        } else if (c.status === "terminated" && !c.endedAt) {
          // onExit already marked terminated via the claimed signal: fill in
          // the terminal timestamps/defaults it could not know.
          if (c.endReason !== "timeout" && !c.endReason) c.endReason = "terminate"
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
      // Terminating a command a goal awaits is allowed and wakes normally.
      // Stopping a command otherwise never touches goals — no goal import
      // exists here by construction. Detach needs nothing: viewers stop reading.
      await fireAwaits(directory, id)
      // Auto policy stays silent for "terminated" (caller already has this
      // synchronous result) — notifyOwnerIfNeeded only fires here when the
      // command opted in with notifyOnExit: true, or the timer path already
      // stamped endReason=timeout (never caller-initiated: always notifies).
      await notifyOwnerIfNeeded(directory, id)
      if (opts?.remove) {
        const removed = await service.remove(directory, id, ownerSessionID)
        // The notify claim above already fired at most once (exactly-once
        // marker), so the combined call never double-pings.
        if (removed.ok) return { ok: true, message: `Command "${session.title}" ${status}; removed.`, removed: true }
        return { ok: true, message: `Command "${session.title}" ${status}; remove failed: ${removed.message}` }
      }
      return { ok: true, message: `Command "${session.title}" ${status}.` }
    },

    async remove(directory, id, ownerSessionID) {
      rememberDir(id, directory)
      const session = await service.get(directory, id, ownerSessionID)
      if (!session) return { ok: false, message: "Command not found." }
      if (session.status === "running") {
        return { ok: false, message: `Command "${session.title}" is still running — terminate it first (terminate ≠ remove).` }
      }
      deleteWatch(id)
      // Capture pre-delete metadata for the post-persistence status emit.
      const lastKnown = { ...session }
      await mutateState(directory, `cmd.remove:${id}`, async (s) => {
        s.commands = (s.commands ?? []).filter((x) => !(x.id === id && x.ownerSessionID === ownerSessionID))
        return s
      })
      await removeCommandLog(directory, id)
      emitBroker(id, { type: "status", command: lastKnown })
      // Removing a finished command clears awaits pointing at it.
      await clearAwaitsForCommand(directory, id, "command removed").catch(() => {})
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
            clearCommandTimeout(c.id)
            deleteWatch(c.id)
            await mutateState(directory, `cmd.reconcile-exit:${c.id}`, async (s) => {
              const x = (s.commands ?? []).find((y) => y.id === c.id)
              if (x && x.status === "running") {
                x.status = "exited"
                x.endReason = "exit"
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
            await fireAwaits(directory, c.id)
            await notifyOwnerIfNeeded(directory, c.id)
          }
          continue
        }
        // No live handle and no timer to revive (timers are in-memory only and
        // never resurrected across restart): honestly missing wins. When the
        // persisted deadlineAt already passed, record that the timeout elapsed
        // so a later start doesn't resurrect the deadline — status stays
        // missing, endReason stays missing, but lastError says timeout.
        // M2: in-memory watcher dropped (nothing can feed it); persisted watch
        // fields stay as-is by design.
        clearCommandTimeout(c.id)
        deleteWatch(c.id)
        const deadlinePassed = c.deadlineAt ? Date.parse(c.deadlineAt) <= Date.now() : false
        await mutateState(directory, `cmd.reconcile-missing:${c.id}`, async (s) => {
          const x = (s.commands ?? []).find((y) => y.id === c.id)
          if (x && x.status === "running") {
            x.status = "missing"
            x.endReason = "missing"
            x.lastError = deadlinePassed
              ? `Host restarted or handle lost — no live execution found (timeoutSeconds=${x.timeoutSeconds ?? "?"}s deadline ${x.deadlineAt} already passed; treated as missing, timeout elapsed). Output log retained; remove to clean up.`
              : "Host restarted or handle lost — no live execution found. Output log retained; remove to clean up."
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
        // "missing" is terminal: outstanding awaits fire once on recovery.
        await fireAwaits(directory, c.id)
        await notifyOwnerIfNeeded(directory, c.id)
      }
      return { markedMissing }
    },

    async dispose(directory) {
      for (const id of [...watchTimers.keys()]) clearWatchTimer(id)
      watchers.clear()
      awaitAsm.clear()
      const state = await readState(directory)
      const owned = new Map<string, string>((state.commands ?? []).map((command) => [command.id, command.ownerSessionID]))
      await Promise.all([...live.entries()].map(async ([id, entry]) => {
        const owner = owned.get(id)
        if (owner) {
          await service.terminate(directory, id, owner).catch(() => {})
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
      for (const id of [...timeouts.keys()]) clearCommandTimeout(id)
    },
  }

  return service
}
