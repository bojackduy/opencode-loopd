// ─── Domain: Command Await ───────────────────────────────────────────────────
// Explicit opt-in await semantics: a goal wakes on a command's exit ONLY after
// an explicit await action. A merely linked command (goalID display metadata)
// never wakes its goal.
//
// An await is consumed exactly once when the awaited command reaches a
// terminal status (exited/terminated/missing). Output chunks never fire.
// Delivery is inbox + the existing idle-continuation path (same seam as
// send/nudge) — never a second parallel loop. Pausing/clearing a goal cancels
// its outstanding awaits; removing a command clears awaits pointing at it.
//
// State stores IDs only — never output bytes. Evidence (exit code/signal +
// bounded tail) is materialized at fire time from the retained command log.

import type { CommandSessionStatus } from "./command-session"

/** A goal's outstanding opt-in wait for one command's terminal status. IDs only. */
export interface CommandAwait {
  goalID: string
  commandID: string
  ownerSessionID: string
  createdAt: string
  /**
   * M2: when set, this await fires ONCE on the first output line matching the
   * pattern (regex source; ANSI-stripped lines) instead of on terminal status.
   * The command keeps running — unlike watch-until=stop, an until-await never
   * stops anything. A terminal exit still consumes an unmatched until-await
   * (with exit evidence) so awaits can never leak.
   */
  until?: string
  /** Case-insensitive until matching. */
  ignoreCase?: boolean
}

/** Terminal statuses that fire an await. Output chunks ("running") never fire. */
export const TERMINAL_COMMAND_STATUSES: readonly CommandSessionStatus[] = [
  "exited",
  "terminated",
  "missing",
]

export function isTerminalCommandStatus(status: CommandSessionStatus): boolean {
  return (TERMINAL_COMMAND_STATUSES as readonly string[]).includes(status)
}

/** Max evidence tail bytes delivered in a wake-up (last 4KB of retained log). */
export const MAX_AWAIT_TAIL_BYTES = 4 * 1024

/** Keep only the last `maxBytes` bytes (byte-precise, UTF-8 safe on decode). */
export function tailLastBytes(text: string, maxBytes: number = MAX_AWAIT_TAIL_BYTES): string {
  const buf = Buffer.from(text, "utf8")
  if (buf.length <= maxBytes) return text
  return buf.subarray(buf.length - maxBytes).toString("utf8")
}

export function awaitKey(a: Pick<CommandAwait, "goalID" | "commandID">): string {
  return `${a.goalID}:${a.commandID}`
}

/**
 * Format the one-shot wake-up evidence delivered to the goal inbox.
 * Bounded: the tail never exceeds MAX_AWAIT_TAIL_BYTES.
 */
export function formatAwaitEvidence(input: {
  title: string
  argv: string[]
  commandID: string
  status: CommandSessionStatus
  exitCode?: number
  signal?: string
  tail: string
}): string {
  const short = input.commandID.slice(0, 8)
  const header =
    `[command "${input.title}" (${input.argv.join(" ") || input.title}) ${input.status}` +
    ` ${short}... exitCode=${input.exitCode ?? "unknown"} signal=${input.signal ?? "none"}]`
  const tail = tailLastBytes(input.tail)
  return tail ? `${header}\n${tail}` : header
}
