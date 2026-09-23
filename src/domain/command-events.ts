// ─── Domain: CommandStreamMessage (event protocol, Milestone 1) ───────────────
// Versioned, sequenced protocol for event-driven command output streaming.
// Protocol layer ONLY: no transport, no broker, no PTY. The broker
// (Milestone 2) will publish these; the TUI client (Milestone 4) consumes them.
//
// Offset contract: output/snapshot offsets are absolute UTF-8 byte offsets
// over the command lifetime. startOffset is inclusive, endOffset is exclusive,
// and endOffset === startOffset + byteLength(data). streamBytes on
// CommandSession is the lifetime counter these offsets index into; outputBytes
// is only the retained log-file size.

import type { CommandSession, CommandSessionStatus } from "./command-session"

/** Protocol version. Bump on any breaking change to the union shape. */
export const PROTOCOL_VERSION = 1

export interface SubscribeMessage {
  type: "subscribe"
  commandID: string
  ownerSessionID: string
}

export interface SnapshotMessage {
  type: "snapshot"
  /** Full CommandSession metadata at snapshot time. */
  command: CommandSession
  /** Retained output payload (may be truncated relative to lifetime). */
  data: string
  /** Absolute lifetime byte offset of the first byte in data. */
  startOffset: number
  /** Absolute lifetime byte offset one past the last byte in data. */
  endOffset: number
}

export interface OutputMessage {
  type: "output"
  commandID: string
  data: string
  startOffset: number
  endOffset: number
}

export interface StatusMessage {
  type: "status"
  command: CommandSession
}

export interface InputMessage {
  type: "input"
  commandID: string
  data: string
}

export interface InterruptMessage {
  type: "interrupt"
  commandID: string
}

export interface ResyncMessage {
  type: "resync"
  commandID: string
}

export interface UnsubscribeMessage {
  type: "unsubscribe"
  commandID: string
}

export interface ErrorMessage {
  type: "error"
  code: string
  message: string
}

export type CommandStreamMessage =
  | SubscribeMessage
  | SnapshotMessage
  | OutputMessage
  | StatusMessage
  | InputMessage
  | InterruptMessage
  | ResyncMessage
  | UnsubscribeMessage
  | ErrorMessage

export type ValidateResult =
  | { ok: true; message: CommandStreamMessage }
  | { ok: false; error: string }

// ─── Helpers ─────────────────────────────────────────────────────────────────

const _encoder = new TextEncoder()

/** UTF-8 byte length of a string (NOT string.length — multi-byte safe). */
export function utf8ByteLength(data: string): number {
  return _encoder.encode(data).length
}

/**
 * True when the next chunk continues exactly where the previous one ended.
 * Gap (nextStart > prevEnd) and duplicate/overlap (nextStart < prevEnd)
 * both return false — the client should send `resync` in those cases.
 */
export function offsetsContinuous(prevEnd: number, nextStart: number): boolean {
  return prevEnd === nextStart
}

/** Expected endOffset for a chunk starting at startOffset with payload data. */
export function expectedNextEnd(startOffset: number, data: string): number {
  return startOffset + utf8ByteLength(data)
}

// ─── Validation (fail-closed, never throws on untrusted data) ────────────────

const VALID_STATUSES: readonly CommandSessionStatus[] = [
  "running",
  "exited",
  "terminated",
  "missing",
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0
}

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
}

/** Loose structural check that `command` carries CommandSession metadata. */
function isCommandSessionLike(value: unknown): value is CommandSession {
  if (!isRecord(value)) return false
  if (typeof value["id"] !== "string" || value["id"].length === 0) return false
  if (typeof value["title"] !== "string") return false
  if (typeof value["command"] !== "string") return false
  if (typeof value["cwd"] !== "string") return false
  if (typeof value["ownerSessionID"] !== "string") return false
  if (typeof value["status"] !== "string") return false
  if (!(VALID_STATUSES as readonly string[]).includes(value["status"] as string))
    return false
  if (!isNonNegativeInt(value["outputBytes"])) return false
  if (typeof value["truncated"] !== "boolean") return false
  if (typeof value["createdAt"] !== "string") return false
  if (typeof value["updatedAt"] !== "string") return false
  if (value["args"] !== undefined && !Array.isArray(value["args"])) return false
  if (
    value["streamBytes"] !== undefined &&
    !isNonNegativeInt(value["streamBytes"])
  )
    return false
  return true
}

function checkOffsets(
  startOffset: unknown,
  endOffset: unknown,
  data: unknown,
): string | null {
  if (typeof data !== "string") return "data must be a string"
  if (!isNonNegativeInt(startOffset)) return "startOffset must be a non-negative integer"
  if (!isNonNegativeInt(endOffset)) return "endOffset must be a non-negative integer"
  if ((endOffset as number) < (startOffset as number))
    return "endOffset must be >= startOffset"
  const expected = expectedNextEnd(startOffset as number, data)
  if ((endOffset as number) !== expected)
    return `endOffset mismatch: expected ${expected} (startOffset + UTF-8 byte length ${expected - (startOffset as number)}), got ${endOffset}`
  return null
}

export function validateCommandStreamMessage(value: unknown): ValidateResult {
  try {
    if (!isRecord(value)) return { ok: false, error: "message must be an object" }
    const type = value["type"]
    if (typeof type !== "string") return { ok: false, error: "missing type field" }
    switch (type) {
      case "subscribe": {
        if (!isNonEmptyString(value["commandID"]))
          return { ok: false, error: "subscribe.commandID must be a non-empty string" }
        if (!isNonEmptyString(value["ownerSessionID"]))
          return { ok: false, error: "subscribe.ownerSessionID must be a non-empty string" }
        return {
          ok: true,
          message: {
            type: "subscribe",
            commandID: value["commandID"],
            ownerSessionID: value["ownerSessionID"],
          },
        }
      }
      case "snapshot": {
        if (!isCommandSessionLike(value["command"]))
          return { ok: false, error: "snapshot.command must be CommandSession metadata" }
        const offsetError = checkOffsets(value["startOffset"], value["endOffset"], value["data"])
        if (offsetError) return { ok: false, error: `snapshot.${offsetError}` }
        return {
          ok: true,
          message: {
            type: "snapshot",
            command: value["command"],
            data: value["data"] as string,
            startOffset: value["startOffset"] as number,
            endOffset: value["endOffset"] as number,
          },
        }
      }
      case "output": {
        if (!isNonEmptyString(value["commandID"]))
          return { ok: false, error: "output.commandID must be a non-empty string" }
        const offsetError = checkOffsets(value["startOffset"], value["endOffset"], value["data"])
        if (offsetError) return { ok: false, error: `output.${offsetError}` }
        return {
          ok: true,
          message: {
            type: "output",
            commandID: value["commandID"],
            data: value["data"] as string,
            startOffset: value["startOffset"] as number,
            endOffset: value["endOffset"] as number,
          },
        }
      }
      case "status": {
        if (!isCommandSessionLike(value["command"]))
          return { ok: false, error: "status.command must be CommandSession metadata" }
        return { ok: true, message: { type: "status", command: value["command"] } }
      }
      case "input": {
        if (!isNonEmptyString(value["commandID"]))
          return { ok: false, error: "input.commandID must be a non-empty string" }
        if (typeof value["data"] !== "string")
          return { ok: false, error: "input.data must be a string" }
        return {
          ok: true,
          message: { type: "input", commandID: value["commandID"], data: value["data"] },
        }
      }
      case "interrupt": {
        if (!isNonEmptyString(value["commandID"]))
          return { ok: false, error: "interrupt.commandID must be a non-empty string" }
        return { ok: true, message: { type: "interrupt", commandID: value["commandID"] } }
      }
      case "resync": {
        if (!isNonEmptyString(value["commandID"]))
          return { ok: false, error: "resync.commandID must be a non-empty string" }
        return { ok: true, message: { type: "resync", commandID: value["commandID"] } }
      }
      case "unsubscribe": {
        if (!isNonEmptyString(value["commandID"]))
          return { ok: false, error: "unsubscribe.commandID must be a non-empty string" }
        return { ok: true, message: { type: "unsubscribe", commandID: value["commandID"] } }
      }
      case "error": {
        if (!isNonEmptyString(value["code"]))
          return { ok: false, error: "error.code must be a non-empty string" }
        if (typeof value["message"] !== "string")
          return { ok: false, error: "error.message must be a string" }
        return {
          ok: true,
          message: { type: "error", code: value["code"], message: value["message"] },
        }
      }
      default:
        return { ok: false, error: `unknown message type: ${type}` }
    }
  } catch (err) {
    return { ok: false, error: `validation failed: ${String(err)}` }
  }
}
