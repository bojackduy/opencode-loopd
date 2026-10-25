// ─── Domain: Command Watch ───────────────────────────────────────────────────
// Line-level filter/until notifications for never-exiting processes (M2).
//
// Pure/testable: no I/O, no timers, no imports beyond the sibling await domain.
// The service owns scheduling (coalesce timers) and delivery (owner notify,
// terminate); this module owns line assembly, matching, and policy.
//
// Pipeline (sentinel parity): filter FIRST, then until on the filter-surviving
// stream — filter+until compose, they never race.
//
// Deliberate departures from sentinel (lib/watcher.ts):
// - Flood (100 lines/sec) SUSPENDS the watch with one notice; the process keeps
//   running. Sentinel SIGTERMs the process group — wrong for a feature whose
//   whole point is watching never-exiting processes.
// - Coalescing window is 2000ms (not 200ms) with per-push bounds, plus a
//   per-command push budget — owner notifications stay bounded on chatty
//   processes.

import { tailLastBytes } from "./command-await"
import type { ConsoleByteRange } from "./command-agent-event"

// ─── Spec ────────────────────────────────────────────────────────────────────

export type WatchUntilAction = "stop" | "keep"

export interface WatchSpec {
  filter?: string
  until?: string
  ignoreCase?: boolean
  /** Default "stop": until-match terminates the command. "keep" keeps running. */
  untilAction?: WatchUntilAction
}

export interface CompiledWatch {
  filterRe?: RegExp
  untilRe?: RegExp
  ignoreCase: boolean
  untilAction: WatchUntilAction
}

/** Live watch lifecycle for one command. Persisted as a snapshot on the session. */
export type WatchRuntimeStatus = "active" | "until-matched" | "flood-suspended" | "budget-exhausted"

export interface WatchState {
  state: WatchRuntimeStatus
  /** Filter-passed lines seen (includes the until line). */
  matches: number
  /** Owner pushes delivered (flushes). */
  pushes: number
  /** Lines dropped after suspension/exhaustion (flood trip line counts). */
  droppedLines: number
}

export function initialWatchState(): WatchState {
  return { state: "active", matches: 0, pushes: 0, droppedLines: 0 }
}

// ─── Policy constants ────────────────────────────────────────────────────────

/** Coalescing window: matched lines buffer this long before one owner push. */
export const WATCH_COALESCE_WINDOW_MS = 2000
/** Max matched lines per push. */
export const WATCH_MAX_LINES_PER_PUSH = 20
/** Max matched-bytes per push (owner messages stay bounded). */
export const WATCH_MAX_BYTES_PER_PUSH = 4 * 1024
/** Max pushes per command; afterwards budget-exhausted with one notice. */
export const WATCH_MAX_PUSHES_PER_COMMAND = 30
/** Flood rule: more than this many lines in a sliding 1s window suspends. */
export const WATCH_FLOOD_LINES_PER_SEC = 100
/** Every owner-facing watch message is bounded to this. */
export const MAX_WATCH_MESSAGE_BYTES = 4 * 1024

// ─── Regex guard (M1 parity) ─────────────────────────────────────────────────
// Same dangerous-pattern guard as the M1 pattern read (command-service
// validateReadPattern): validate at the boundary, throw with a clear message.

const DANGEROUS_REGEXES: RegExp[] = [
  /\(\?:.*\)\*.*\(\?:.*\)\*/, // nested optional groups with repetition (pty)
  /.*\(\.\*\?\)\{2,\}.*/, // overlapping non-greedy quantifiers (pty)
  /.*\(.*\|.*\)\{3,\}.*/, // complex alternation with repetition (pty)
  /\([^()]*[+*][^()]*\)[+*]/, // nested quantifier: quantified group containing a quantifier, e.g. (a+)+
  /\([^()]*(\.\*.*\.\*|\.\+.*\.\+|\\w\+.*\\s\*|\\s\*.*\\w\+)[^()]*\)/, // overlapping classes inside one group, e.g. (.*.*)
]

/** Compile one pattern or throw with a clear message (never returns error objects). */
export function compileWatchPattern(kind: "filter" | "until", pattern: string, ignoreCase = false): RegExp {
  let compiled: RegExp
  try {
    compiled = new RegExp(pattern, ignoreCase ? "i" : "")
  } catch (e) {
    throw new Error(`Invalid watch ${kind} regex '${pattern}': ${e instanceof Error ? e.message : String(e)}`)
  }
  if (DANGEROUS_REGEXES.some((d) => d.test(pattern))) {
    throw new Error(`Potentially dangerous watch ${kind} regex rejected: '${pattern}'. Please use a safer pattern.`)
  }
  return compiled
}

/** Validate + compile a full spec at the boundary (start/await). Throws on any bad regex. */
export function compileWatchSpec(spec: WatchSpec): CompiledWatch {
  const ignoreCase = spec.ignoreCase === true
  const untilAction: WatchUntilAction = spec.untilAction ?? "stop"
  if (untilAction !== "stop" && untilAction !== "keep") {
    throw new Error(`Invalid watch untilAction '${spec.untilAction}': must be "stop" or "keep".`)
  }
  return {
    ...(spec.filter !== undefined ? { filterRe: compileWatchPattern("filter", spec.filter, ignoreCase) } : {}),
    ...(spec.until !== undefined ? { untilRe: compileWatchPattern("until", spec.until, ignoreCase) } : {}),
    ignoreCase,
    untilAction,
  }
}

// ─── Line assembler ──────────────────────────────────────────────────────────
// Partial-line carry across chunks; splits on \r?\n; strips ANSI CSI/OSC so
// progress bars and colored output match as visible text; a bare \r overwrites
// the current line (so `progress 10%\rprogress 20%\n` yields one line).

const ANSI_PATTERN = new RegExp(
  "\\[[0-9;?]*[ -/]*[@-~]|\\][^\u0007]*(?:\u0007|\\\\)|[()][0-9A-Z]",
  "g",
)

export function stripAnsiForWatch(line: string): string {
  return line.replace(ANSI_PATTERN, "")
}

function cleanRawLine(raw: string): string {
  const stripped = stripAnsiForWatch(raw)
  if (!stripped.includes("\r")) return stripped
  const parts = stripped.split("\r")
  return parts[parts.length - 1] ?? ""
}

export interface AssembledLine {
  line: string
  /** Present only when the caller supplied absolute console chunk offsets. */
  range?: ConsoleByteRange
}

export interface SpanAssembler {
  /** Feed a chunk beginning at `chunkStartOffset` (absolute console bytes). */
  push(chunk: string, chunkStartOffset?: number): AssembledLine[]
  /** Treat the trailing partial line as complete (call at process exit). */
  flush(endOffset?: number): AssembledLine[]
}

export interface LineAssembler {
  /** Feed a chunk; returns newly completed cleaned lines (blank lines included). */
  push(chunk: string): string[]
  /** Treat the trailing partial line as complete (call at process exit). */
  flush(): string[]
}

/**
 * Line assembly with optional absolute byte ranges. `\r\n` counts as one
 * newline even when the pair straddles a chunk boundary; a bare `\r` overwrites
 * the current line (so `progress 10%\rprogress 20%\n` is one console span).
 * Ranges stay exact because the carry's absolute start is tracked across chunks.
 */
export function createSpanAssembler(): SpanAssembler {
  let carry = ""
  let carryStart = 0
  let tracking = false
  return {
    push(chunk: string, chunkStartOffset?: number): AssembledLine[] {
      if (chunkStartOffset !== undefined) {
        tracking = true
        // Offsets are absolute: the carry began this many bytes before the chunk.
        carryStart = chunkStartOffset - byteLen(carry)
      }
      const combined = carry + chunk
      const out: AssembledLine[] = []
      let segStart = 0
      let segBytes = 0
      for (let i = 0; i < combined.length; i++) {
        if (combined[i] !== "\n") continue
        let textEnd = i
        if (textEnd > segStart && combined[textEnd - 1] === "\r") textEnd--
        const span = byteLen(combined.slice(segStart, i + 1))
        out.push({
          line: cleanRawLine(combined.slice(segStart, textEnd)),
          ...(tracking
            ? { range: { startOffset: carryStart + segBytes, endOffset: carryStart + segBytes + span } }
            : {}),
        })
        segBytes += span
        segStart = i + 1
      }
      carry = combined.slice(segStart)
      carryStart += segBytes
      return out
    },
    flush(endOffset?: number): AssembledLine[] {
      if (!carry) return []
      const line = cleanRawLine(carry)
      const range = tracking && endOffset !== undefined ? { startOffset: carryStart, endOffset } : undefined
      carry = ""
      return [range ? { line, range } : { line }]
    },
  }
}

export function createLineAssembler(): LineAssembler {
  const spans = createSpanAssembler()
  return {
    push(chunk: string): string[] {
      return spans.push(chunk).map((part) => part.line)
    },
    flush(): string[] {
      return spans.flush().map((part) => part.line)
    },
  }
}

// ─── Matching ────────────────────────────────────────────────────────────────

export interface LineMatch {
  /** Passed the filter (or no filter configured). */
  pass: boolean
  /** Matched the until pattern (only meaningful when pass is true). */
  until: boolean
}

function testFresh(re: RegExp, line: string): boolean {
  const hit = re.test(line)
  re.lastIndex = 0 // defensive: our flags never set /g, but callers may reuse
  return hit
}

/** Filter first, then until on the filter-surviving stream (sentinel pipeline). */
export function matchLine(compiled: CompiledWatch, line: string): LineMatch {
  if (compiled.filterRe && !testFresh(compiled.filterRe, line)) return { pass: false, until: false }
  if (compiled.untilRe && testFresh(compiled.untilRe, line)) return { pass: true, until: true }
  return { pass: true, until: false }
}

// ─── Watcher runtime ─────────────────────────────────────────────────────────
// Feeds on assembled lines; owns flood tracking, pending buffer, push budget,
// and the until state machine. Timer scheduling lives in the service.

export interface WatchFeedResult {
  /** Cleaned non-empty lines completed by this chunk (for await-until reuse). */
  completed: string[]
  /** Filter-passed lines buffered by this call. */
  matched: string[]
  /** First until-matching line this call (null when none or until spent). */
  untilLine: string | null
  /** True on the call that tripped the flood rule (notice exactly once). */
  floodNow: boolean
}

export interface WatchPush {
  lines: string[]
  /** True when this push IS the one-shot budget-exhausted notice (lines empty). */
  exhaustedNow: boolean
  /** Console byte range covering `lines` (absent when offsets were unknown). */
  range?: ConsoleByteRange
}

function byteLen(s: string): number {
  return Buffer.byteLength(s, "utf8")
}

export class CommandWatcher {
  readonly compiled: CompiledWatch
  readonly state: WatchState = initialWatchState()
  private assembler = createSpanAssembler()
  private pending: string[] = []
  private pendingSpans: (ConsoleByteRange | undefined)[] = []
  private pendingBytes = 0
  private stamps: number[] = []

  constructor(spec: WatchSpec) {
    this.compiled = compileWatchSpec(spec)
  }

  get untilAction(): WatchUntilAction {
    return this.compiled.untilAction
  }

  get pendingCount(): number {
    return this.pending.length
  }

  feedChunk(chunk: string, now: number, chunkStartOffset?: number): WatchFeedResult {
    return this.feedParts(this.assembler.push(chunk, chunkStartOffset), now)
  }

  private feedParts(parts: AssembledLine[], now: number): WatchFeedResult {
    const completed: string[] = []
    const matched: string[] = []
    let untilLine: string | null = null
    let floodNow = false
    const suspended =
      this.state.state === "flood-suspended" || this.state.state === "budget-exhausted"
    for (const part of parts) {
      const line = part.line
      if (line.trim() === "") continue
      if (suspended) {
        this.state.droppedLines++
        continue
      }
      completed.push(line)
      // Flood track (non-blank lines only, sentinel parity).
      this.stamps.push(now)
      while (this.stamps.length > 0 && (this.stamps[0] ?? now) < now - 1000) this.stamps.shift()
      if (this.stamps.length > WATCH_FLOOD_LINES_PER_SEC) {
        this.state.state = "flood-suspended"
        this.state.droppedLines++ // the tripping line is dropped
        floodNow = true
        continue // remaining lines in this chunk fall into the suspended branch below
      }
      const m = matchLine(this.compiled, line)
      if (!m.pass) continue
      if (m.until && this.state.state === "active") {
        this.state.state = "until-matched"
        this.state.matches++
        this.buffer(line, part.range)
        untilLine = line
        continue
      }
      if (this.state.state === "until-matched" && this.untilAction === "stop") {
        // Process is about to be stopped; post-until lines are dropped.
        this.state.droppedLines++
        continue
      }
      this.state.matches++
      this.buffer(line, part.range)
      matched.push(line)
    }
    return { completed, matched, untilLine, floodNow }
  }

  /** Assemble the trailing partial line through the same pipeline (call at exit). */
  finish(now: number, endOffset?: number): WatchFeedResult {
    const trailing = this.assembler.flush(endOffset)
    if (trailing.length === 0) return { completed: [], matched: [], untilLine: null, floodNow: false }
    return this.feedParts(trailing, now)
  }

  private buffer(line: string, range?: ConsoleByteRange): void {
    this.pending.push(line)
    this.pendingSpans.push(range)
    this.pendingBytes += byteLen(line)
  }

  private mergeRange(
    a: ConsoleByteRange | undefined,
    b: ConsoleByteRange | undefined,
  ): ConsoleByteRange | undefined {
    if (!a) return b
    if (!b) return a
    return {
      startOffset: Math.min(a.startOffset, b.startOffset),
      endOffset: Math.max(a.endOffset, b.endOffset),
    }
  }

  /**
   * Take one bounded push (≤20 lines / ≤4KB). Leftover stays pending for the
   * next window. When the budget is spent, transitions to budget-exhausted and
   * returns the one-shot notice (exactly once by construction).
   */
  takePush(): WatchPush | null {
    if (this.pending.length === 0) return null
    if (this.state.state === "budget-exhausted") {
      this.state.droppedLines += this.pending.length
      this.pending = []
      this.pendingSpans = []
      this.pendingBytes = 0
      return null
    }
    if (this.state.pushes >= WATCH_MAX_PUSHES_PER_COMMAND) {
      this.state.state = "budget-exhausted"
      this.state.droppedLines += this.pending.length
      this.pending = []
      this.pendingSpans = []
      this.pendingBytes = 0
      return { lines: [], exhaustedNow: true }
    }
    const lines: string[] = []
    let range: ConsoleByteRange | undefined
    let bytes = 0
    while (this.pending.length > 0 && lines.length < WATCH_MAX_LINES_PER_PUSH) {
      const next = this.pending[0]!
      const nextBytes = byteLen(next) + (lines.length > 0 ? 1 : 0) // +1 for \n join
      if (bytes + nextBytes > WATCH_MAX_BYTES_PER_PUSH && lines.length > 0) break
      // A single line larger than the byte cap still goes out alone (bounded
      // by the message formatter's tail cut) rather than wedging the queue.
      this.pending.shift()
      range = this.mergeRange(range, this.pendingSpans.shift())
      this.pendingBytes -= byteLen(next)
      lines.push(next)
      bytes += nextBytes
    }
    this.state.pushes++
    return { lines, exhaustedNow: false, ...(range ? { range } : {}) }
  }

  /**
   * Until delivery: take up to the newest bounded window (tail — the matching
   * line is last and must survive the cut). Older overflow counts as dropped.
   * Always delivers (until outranks the push budget); counts one push.
   */
  takeUntilPush(): string[] {
    return this.takeUntilPushWithRange().lines
  }

  /** Until delivery plus the console range of the window actually sent. */
  takeUntilPushWithRange(): WatchPush {
    const lines: string[] = []
    const spans: (ConsoleByteRange | undefined)[] = []
    let bytes = 0
    while (this.pending.length > 0 && lines.length < WATCH_MAX_LINES_PER_PUSH) {
      const next = this.pending.pop()!
      const span = this.pendingSpans.pop()
      this.pendingBytes -= byteLen(next)
      const nextBytes = byteLen(next) + (lines.length > 0 ? 1 : 0)
      if (bytes + nextBytes > WATCH_MAX_BYTES_PER_PUSH && lines.length > 0) {
        this.pending.push(next)
        this.pendingSpans.push(span)
        this.pendingBytes += byteLen(next)
        break
      }
      lines.unshift(next)
      spans.unshift(span)
      bytes += nextBytes
    }
    // Anything older than the window is dropped, not re-queued.
    this.state.droppedLines += this.pending.length
    this.pending = []
    this.pendingSpans = []
    this.pendingBytes = 0
    this.state.pushes++
    const range = spans.reduce<ConsoleByteRange | undefined>((acc, s) => this.mergeRange(acc, s), undefined)
    return { lines, exhaustedNow: false, ...(range ? { range } : {}) }
  }
}

// ─── Owner message formatting (all bounded) ──────────────────────────────────

export function formatWatchMessage(title: string, lines: string[], note?: string): string {
  const header = `[watch "${title}"]`
  const tail = note ? [...lines, note].join("\n") : lines.join("\n")
  if (!tail) return header
  const room = Math.max(0, MAX_WATCH_MESSAGE_BYTES - byteLen(header) - 1)
  return `${header}\n${tailLastBytes(tail, room)}`
}

export function formatWatchFloodMessage(title: string, dropped: number): string {
  return (
    `[watch "${title}"] FLOOD: ${WATCH_FLOOD_LINES_PER_SEC}+ lines/sec exceeds the limit. ` +
    `Watch suspended (${dropped} line(s) dropped so far); the process keeps running.`
  )
}

export function formatWatchBudgetMessage(title: string): string {
  return (
    `[watch "${title}"] BUDGET: push limit (${WATCH_MAX_PUSHES_PER_COMMAND}) reached. ` +
    `Watch exhausted; further matches are dropped. The process keeps running.`
  )
}
