// ─── Domain: Approved Server Linkage ─────────────────────────────────────────
// A managed dev server is a CommandSession started from owner-configured
// authority. This record is the durable linkage between that process and the
// goal/worker generation that started it. It is deliberately separate from the
// command's display-only goalID: only command IDs recorded here are ever owned
// by goal lifecycle cleanup, so standalone commands stay untouched.

export interface ApprovedServerRecord {
  /** CommandSession id. Empty while a start is reserved but not yet spawned. */
  commandID: string
  goalID: string
  workerSessionID: string
  runGeneration: number
  /** Approved command name from goal.config.approvedCommands. */
  name: string
  startedAt: string
}
