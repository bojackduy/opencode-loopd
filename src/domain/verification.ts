// ─── Domain: Verification ────────────────────────────────────────────────────
// Tracks verification attempts for goal completion.

export interface VerificationAttempt {
  id: string
  sequence: number
  runGeneration: number
  claimedSummary: string
  claimedEvidence: string
  startedAt: string
  completedAt?: string
  status: "running" | "passed" | "failed"
  cwd: string
  checks: Array<{
    command: string
    /** null when the check was killed before it could exit (e.g. timeout). */
    exitCode: number | null
    /** The check exceeded its time limit; this is not a test failure report. */
    timedOut?: boolean
    stderr?: string
    stdout?: string
  }>
}

const MAX_RECENT_ATTEMPTS = 10

export function appendVerificationAttempt(
  recent: VerificationAttempt[],
  attempt: VerificationAttempt,
): VerificationAttempt[] {
  const next = [...recent, attempt]
  if (next.length > MAX_RECENT_ATTEMPTS) {
    return next.slice(next.length - MAX_RECENT_ATTEMPTS)
  }
  return next
}
