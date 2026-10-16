// ─── Domain: Turn Evidence ───────────────────────────────────────────────────
// Judging whether an accepted turn actually produced work.

/** Completion metadata only — enough to judge a turn. */
export interface TurnEvidenceLike {
  time?: { completed?: number }
  /** Normalized transcript messages use an ISO timestamp instead. */
  completedAt?: string
  finish?: string
  content?: string
  parts?: readonly unknown[]
  error?: unknown
}

/**
 * True when the host closed a turn without producing anything: it stamped
 * time.completed but gave no finish reason, no parts and no error. Quota-limited
 * providers commonly end a turn like this, leaving an accepted prompt with
 * nothing to show and no log line to explain it.
 *
 * A turn still in progress has no completed stamp, so it never matches. This is
 * a turn-AUTHORITY question only, and never a scheduling-lease question: an
 * expired lease still says nothing about live host execution.
 */
export function isOutputlessTurn(message: TurnEvidenceLike | undefined): boolean {
  if (!message || !(message.time?.completed || message.completedAt)) return false
  if (message.finish || message.error) return false
  if (message.content?.trim() || message.parts?.length) return false
  return true
}
