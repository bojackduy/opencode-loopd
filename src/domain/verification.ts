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
    exitCode: number
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
