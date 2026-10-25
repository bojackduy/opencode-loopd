// ─── Domain: Command agent events ────────────────────────────────────────────
// Two-channel contract for background commands:
//
//   console channel = SOURCE OF TRUTH. Raw output is durably appended to the
//   command log and retained (bounded ring) regardless of watch filters,
//   notification policy, or agent delivery. Offsets are absolute lifetime
//   UTF-8 byte offsets (CommandSession.streamBytes).
//
//   agent channel = DERIVED. Every owner-facing delivery is one bounded,
//   sequenced event carrying an explicit envelope: which command, which
//   trigger, when, terminal facts when known, how much console is retained,
//   and the exact console byte range the included lines came from.
//
// A filtered-out line is absent from the agent channel and fully present in
// the console channel. Nothing here ever fabricates or replays output.

import type { CommandSession, CommandSessionStatus } from "./command-session"
import { tailLastBytes } from "./command-await"

/** Absolute console byte range: start inclusive, end exclusive. */
export interface ConsoleByteRange {
  startOffset: number
  endOffset: number
}

/** Why the owner/agent is being spoken to. */
export type AgentEventTrigger =
  | "watch-match" // coalesced filter/until match flush
  | "until-match" // until pattern matched (stop or keep)
  | "exit" // process reached terminal status, auto policy paged the owner
  | "timeout" // timeoutSeconds deadline fired
  | "flood" // watch flood suspension notice (one-shot)
  | "budget" // watch push budget exhausted notice (one-shot)

export interface AgentEventEnvelope {
  commandID: string
  title: string
  trigger: AgentEventTrigger
  /** 1-based, monotonic per command. */
  sequence: number
  /** ISO timestamp of delivery. */
  timestamp: string
  /** Session status at delivery time. */
  status: CommandSessionStatus
  exitCode?: number
  signal?: string
  /** Runtime in ms when the end is known (else time so far). */
  durationMs?: number
  /** Bytes retained in the console log at delivery time. */
  retainedBytes: number
  /** Lifetime console bytes (absolute end offset of the console). */
  streamBytes: number
  /** True once the console ring dropped oldest bytes. */
  truncated: boolean
  /** Console bytes that produced the included lines. */
  range: ConsoleByteRange
  /** Number of payload lines included. */
  lines: number
  /** Lines dropped by flood/budget/window, when the trigger says so. */
  dropped?: number
}

/** Compact, persisted record of one delivery (human inspect path). */
export interface AgentEventSummary {
  sequence: number
  trigger: AgentEventTrigger
  timestamp: string
  status: CommandSessionStatus
  lines: number
  startOffset: number
  endOffset: number
  dropped?: number
}

/** Keep the persisted event log bounded; the console log stays the record. */
export const MAX_AGENT_EVENT_SUMMARIES = 20
/** Same bound as a watch push message. */
export const MAX_AGENT_EVENT_BYTES = 4 * 1024
/** Max payload lines per agent event (parity with the watch push budget). */
export const AGENT_EVENT_MAX_LINES = 20
/** Max payload bytes per agent event (parity with the watch push budget). */
export const AGENT_EVENT_MAX_PAYLOAD_BYTES = 4 * 1024

function byteLen(s: string): number {
  return Buffer.byteLength(s, "utf8")
}

/**
 * Bound a raw tail excerpt to one agent event: newest ≤20 non-empty lines that
 * fit in 4KB. `bytes` is the exact UTF-8 size of the returned suffix, so the
 * event range can never imply more console bytes than were sent.
 */
export function boundTailPayload(text: string): { lines: string[]; bytes: number } {
  const normalized = text.replace(/\n+$/, "")
  if (!normalized) return { lines: [], bytes: 0 }
  const all = normalized.split("\n")
  let start = Math.max(0, all.length - AGENT_EVENT_MAX_LINES)
  const joined = () => all.slice(start).join("\n")
  while (start < all.length - 1 && byteLen(joined()) > AGENT_EVENT_MAX_PAYLOAD_BYTES) start++
  let body = joined()
  if (byteLen(body) > AGENT_EVENT_MAX_PAYLOAD_BYTES) body = tailLastBytes(body, AGENT_EVENT_MAX_PAYLOAD_BYTES)
  return { lines: body.split("\n"), bytes: byteLen(body) }
}

/** Sequence the next delivery for this command (1-based, monotonic). */
export function nextAgentEventSequence(session: Pick<CommandSession, "agentEventSeq">): number {
  return (session.agentEventSeq ?? 0) + 1
}

/** Exact console range for a bounded tail of `bytes` ending at the stream end. */
export function tailRange(streamBytes: number, bytes: number): ConsoleByteRange {
  const end = Math.max(0, streamBytes)
  const start = Math.max(0, end - Math.max(0, bytes))
  return { startOffset: start, endOffset: end }
}

export function buildAgentEventEnvelope(input: {
  session: Pick<
    CommandSession,
    "id" | "title" | "status" | "exitCode" | "signal" | "outputBytes" | "streamBytes" | "truncated" | "createdAt" | "endedAt"
  >
  trigger: AgentEventTrigger
  sequence: number
  timestamp?: string
  range: ConsoleByteRange
  lines: number
  dropped?: number
}): AgentEventEnvelope {
  const { session } = input
  const started = Date.parse(session.createdAt)
  const ended = session.endedAt ? Date.parse(session.endedAt) : Date.now()
  const durationMs = Number.isFinite(started) && Number.isFinite(ended) ? Math.max(0, ended - started) : undefined
  const range = input.range
  return {
    commandID: input.session.id,
    title: session.title,
    trigger: input.trigger,
    sequence: input.sequence,
    timestamp: input.timestamp ?? new Date().toISOString(),
    status: session.status,
    ...(session.exitCode !== undefined ? { exitCode: session.exitCode } : {}),
    ...(session.signal !== undefined ? { signal: session.signal } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    retainedBytes: session.outputBytes,
    streamBytes: session.streamBytes,
    truncated: session.truncated,
    range: { startOffset: Math.max(0, range.startOffset), endOffset: Math.max(0, range.endOffset) },
    lines: input.lines,
    ...(input.dropped !== undefined ? { dropped: input.dropped } : {}),
  }
}

export function summarizeAgentEvent(event: AgentEventEnvelope): AgentEventSummary {
  return {
    sequence: event.sequence,
    trigger: event.trigger,
    timestamp: event.timestamp,
    status: event.status,
    lines: event.lines,
    startOffset: event.range.startOffset,
    endOffset: event.range.endOffset,
    ...(event.dropped !== undefined ? { dropped: event.dropped } : {}),
  }
}

/** Append one summary, keeping the newest MAX_AGENT_EVENT_SUMMARIES. */
export function appendAgentEventSummary(
  log: AgentEventSummary[] | undefined,
  summary: AgentEventSummary,
): AgentEventSummary[] {
  return [...(log ?? []), summary].slice(-MAX_AGENT_EVENT_SUMMARIES)
}

function describeTerminal(event: AgentEventEnvelope): string {
  const parts: string[] = [event.status]
  if (event.exitCode !== undefined) parts.push(`exitCode=${event.exitCode}`)
  if (event.signal) parts.push(`signal=${event.signal}`)
  if (event.durationMs !== undefined) parts.push(`${Math.round(event.durationMs / 1000)}s`)
  return parts.join(" · ")
}

/** Watch-family deliveries keep their familiar `[watch "title"]` first line. */
function watchLine(event: AgentEventEnvelope): string {
  if (event.trigger === "exit" || event.trigger === "timeout") return ""
  return `[watch "${event.title}"]\n`
}

/**
 * Render one agent event: envelope header, bounded payload, explicit console
 * range, and the paging hint. Never exceeds MAX_AGENT_EVENT_BYTES.
 */
export function formatAgentEventEnvelope(
  event: AgentEventEnvelope,
  payloadLines: string[],
  note?: string,
): string {
  const terminal = describeTerminal(event)
  const retained = event.truncated
    ? `${event.retainedBytes}B retained of ${event.streamBytes}B (truncated)`
    : `${event.retainedBytes}B retained`
  const header =
    `${watchLine(event)}[command "${event.title}"] event #${event.sequence} ${event.trigger} · ${terminal} · ${retained} · ` +
    `console [${event.range.startOffset},${event.range.endOffset}) · ${event.lines} line(s)` +
    (event.dropped !== undefined ? ` · ${event.dropped} dropped` : "")
  const hint =
    `-- console is the source of truth; page raw output with loopd_command_get ` +
    `id=${event.commandID} offsetBytes=${event.range.startOffset}`
  const body = (() => {
    const bounded = payloadLines.slice(-AGENT_EVENT_MAX_LINES)
    const withNote = note ? [...bounded, note] : bounded
    return withNote.join("\n")
  })()
  const tail = body ? `${body}\n${hint}` : hint
  const room = Math.max(0, MAX_AGENT_EVENT_BYTES - byteLen(header) - 1)
  return `${header}\n${tailLastBytes(tail, room)}`
}

/**
 * Human-facing channel state. Distinguishes the durable console from what the
 * agent actually received, and says so explicitly when nothing was delivered.
 */
export function formatAgentChannelStatus(
  session: Pick<CommandSession, "outputBytes" | "streamBytes" | "truncated" | "agentEvents">,
): string {
  const retained = session.truncated
    ? `${session.outputBytes}B retained of ${session.streamBytes}B (truncated)`
    : `${session.outputBytes}B retained`
  const events = session.agentEvents ?? []
  if (events.length === 0) {
    return `console: ${retained} · agent events: none (filtered output stays console-only)`
  }
  const last = events[events.length - 1]!
  return (
    `console: ${retained} · agent events: ${events.length} (last #${last.sequence} ${last.trigger} ` +
    `${last.lines} line(s) [${last.startOffset},${last.endOffset}))`
  )
}
