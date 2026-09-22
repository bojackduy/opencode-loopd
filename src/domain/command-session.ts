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
