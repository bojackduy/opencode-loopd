// ─── Domain: CommandSession ──────────────────────────────────────────────────
// Standalone arbitrary interactive command sessions. Independent from
// Goal/Runtime/WorkerSession by design: lifecycle, ownership, and linkage are
// owned here. A goal MAY link to a command (goalID), but pausing/clearing a
// goal must never implicitly kill a command, and stopping a command must never
// implicitly pause/block a goal. Closing a UI view detaches; it never
// terminates — termination is an explicit action only.

export type CommandSessionID = string & { readonly __brand: "CommandSessionID" }

export type CommandSessionStatus =
  | "running"
  | "exited" // process ended on its own (exit code recorded)
  | "terminated" // stopped via terminate/interrupt-kill (signal recorded)
  | "missing" // host restart reconciliation: no live execution found

export interface CommandSession {
  id: CommandSessionID
  /** Short human label shown in lists/TUI. */
  title: string
  /** Executable that was spawned (argv[0]). */
  command: string
  /** Full argv that was spawned. */
  args: string[]
  /** Working directory the command runs in. */
  cwd: string
  /** Owner session that created the command (permission scope). */
  ownerSessionID: string
  /** Optional goal linkage (display only — no lifecycle coupling). */
  goalID?: string
  /**
   * Owner-exit-notification policy. Undefined = auto (notify on failure,
   * on "missing" after a lost host, or when the command ran long enough to
   * be the long-running/monitor case). true = always notify. false = never.
   */
  notifyOnExit?: boolean
  /** Set once the owner has been pinged for this command's terminal status (exactly-once marker). */
  ownerNotifiedAt?: string
  status: CommandSessionStatus
  /** Process exit code when known (exited or terminated-after-exit). */
  exitCode?: number
  /** Signal name that ended the process (e.g. "SIGINT", "SIGKILL"). */
  signal?: string
  /** Last known pid (observability only — never reused after restart). */
  pid?: number
  /** Requested terminal size (stored even when host cannot apply it). */
  cols?: number
  rows?: number
  /** Total output bytes retained (bounded). */
  outputBytes: number
  /** Lifetime output bytes ever produced (monotonic — never reset by truncation). */
  streamBytes: number
  /** True when oldest output was dropped to stay within bounds. */
  truncated: boolean
  createdAt: string
  updatedAt: string
  endedAt?: string
  lastError?: string
}

// ─── Transition rules ────────────────────────────────────────────────────────
// Live handle events (exit) move running → exited.
// Explicit terminate moves running → terminated (or exited when the process
// already gone — reconcile prefers the honest exited-with-code outcome).
// Reconciliation moves running → missing when the host has no such execution.
// remove/cleanup deletes the record (and its log file); it is not a status.
// detach is a no-op at the domain level: viewing never changes status.

export type CommandSessionEvent =
  | "spawned"
  | "exited"
  | "terminated"
  | "marked_missing"
  | "removed"

const TRANSITIONS: Record<CommandSessionStatus | "removed", CommandSessionStatus[]> = {
  running: ["exited", "terminated", "missing"],
  exited: [],
  terminated: [],
  missing: ["running"],
  removed: [],
}

export function canTransitionCommand(
  current: CommandSessionStatus,
  target: CommandSessionStatus,
): boolean {
  return TRANSITIONS[current]?.includes(target) ?? false
}

export function isLiveCommand(status: CommandSessionStatus): boolean {
  return status === "running"
}

export function createCommandSession(input: {
  id: string
  title: string
  command: string
  args?: string[]
  cwd: string
  ownerSessionID: string
  goalID?: string
  notifyOnExit?: boolean
  pid?: number
  cols?: number
  rows?: number
}): CommandSession {
  const now = new Date().toISOString()
  return {
    id: input.id as CommandSessionID,
    title: input.title,
    command: input.command,
    args: input.args ?? [],
    cwd: input.cwd,
    ownerSessionID: input.ownerSessionID,
    goalID: input.goalID,
    notifyOnExit: input.notifyOnExit,
    status: "running",
    pid: input.pid,
    cols: input.cols,
    rows: input.rows,
    outputBytes: 0,
    streamBytes: 0,
    truncated: false,
    createdAt: now,
    updatedAt: now,
  }
}

/** Max retained output per command (bytes). Oldest output drops first. */
export const MAX_COMMAND_OUTPUT_BYTES = 512 * 1024

/** Max output lines returned by a single read (bounded snapshot + paging). */
export const MAX_COMMAND_READ_LINES = 500

/**
 * Auto-policy threshold: an unset notifyOnExit notifies once the command
 * ran at least this long — the long-running build/watch/monitor case this
 * feature exists for. Quick commands stay silent by default.
 */
export const NOTIFY_LONG_RUNNING_MS = 2 * 60 * 1000

/**
 * Decide whether the owner should be pinged for a command that just reached
 * a terminal status. Pure/testable; callers still gate on terminal status.
 *
 * - notifyOnExit === false: never.
 * - notifyOnExit === true: always.
 * - unset (auto):
 *   - "missing" (host restart lost the process — owner asked for nothing,
 *     this is genuinely surprising): always.
 *   - "terminated" (owner's own terminate call already returned the result
 *     synchronously): never — avoid a redundant ping for a self-initiated
 *     action.
 *   - "exited": notify on non-zero exit (failure always worth knowing), or
 *     when total runtime reached NOTIFY_LONG_RUNNING_MS.
 */
export function shouldNotifyOwnerOnExit(session: CommandSession): boolean {
  if (session.notifyOnExit === false) return false
  if (session.notifyOnExit === true) return true
  if (session.status === "missing") return true
  if (session.status === "terminated") return false
  if (session.status !== "exited") return false
  if (session.exitCode !== undefined && session.exitCode !== 0) return true
  const started = Date.parse(session.createdAt)
  const ended = session.endedAt ? Date.parse(session.endedAt) : Date.now()
  if (!Number.isFinite(started) || !Number.isFinite(ended)) return false
  return ended - started >= NOTIFY_LONG_RUNNING_MS
}
