// ─── Application: Command Await Bridge ───────────────────────────────────────
// Explicit opt-in await semantics for command sessions (Milestone 7).
//
// A goal wakes on a command's exit ONLY after an explicit await. The display-
// only goalID linkage is untouched: a merely linked command never wakes.
//
// Decoupling: this module operates purely on persisted state (StoreState +
// command logs + goal inboxes). It imports NEITHER goal-service NOR
// command-service — both services import these helpers, never each other
// (lifecycle independence enforced by construction, as before). Continuation
// is triggered through the caller's GoalService via the minimal
// AwaitContinuation interface (the same idle-continuation seam send/nudge use).

import { randomUUID } from "crypto"
import type { GoalID } from "../domain/goal"
import type { CommandSession } from "../domain/command-session"
import {
  MAX_AWAIT_TAIL_BYTES,
  formatAwaitEvidence,
  isTerminalCommandStatus,
  type CommandAwait,
} from "../domain/command-await"
import {
  appendEvent,
  appendGoalInbox,
  mutateState,
  readCommandLog,
  readState,
} from "../infrastructure/state-repository"

/** Minimal continuation seam: the caller's GoalService.continueTurn. */
export interface AwaitContinuation {
  continueTurn(directory: string, goalID: GoalID, opts?: { force?: boolean }): Promise<void>
}

export interface AwaitRequest {
  goalID: string
  commandID: string
  ownerSessionID: string
}

export interface AwaitResult {
  ok: boolean
  message: string
  /** True when the await fired immediately (command already terminal). */
  fired?: boolean
  /** True when the goal was active at fire time (caller should wake it). */
  active?: boolean
}

export interface FiredAwait {
  goalID: string
  commandID: string
  /** True when the goal was active (caller should wake it; otherwise the
   * evidence waits in pendingInbox for the next explicit resume/retry). */
  active: boolean
}

function ledgerEvent(base: Record<string, unknown>): Record<string, unknown> {
  return {
    version: 1,
    eventID: randomUUID(),
    timestamp: new Date().toISOString(),
    revision: 0,
    ...base,
  }
}

/**
 * Request an opt-in await. Fail-closed on any ownership mismatch: the
 * requester must own BOTH the goal and the command, and both must agree.
 * Idempotent: a duplicate request while one is outstanding is a no-op.
 * When the command is already terminal, the await fires immediately (once).
 */
export async function requestCommandAwait(
  directory: string,
  input: AwaitRequest,
): Promise<AwaitResult> {
  const snapshot = await readState(directory)
  const goal = snapshot.goals.find((g) => g.id === input.goalID)
  if (!goal) return { ok: false, message: "Goal not found." }
  const command = (snapshot.commands ?? []).find((c) => c.id === input.commandID)
  if (!command) return { ok: false, message: "Command not found." }
  if (input.ownerSessionID !== goal.ownerSessionID || input.ownerSessionID !== command.ownerSessionID) {
    return { ok: false, message: "Owner mismatch: the await requester must own both the goal and the command." }
  }
  if (goal.ownerSessionID !== command.ownerSessionID) {
    return { ok: false, message: "Owner mismatch: goal and command are owned by different sessions." }
  }

  const existing = (snapshot.commandAwaits ?? []).some(
    (a) => a.goalID === input.goalID && a.commandID === input.commandID,
  )
  if (existing) {
    return { ok: true, message: `Already awaiting "${command.title}" for goal "${goal.name}".` }
  }

  if (isTerminalCommandStatus(command.status)) {
    // Already terminal: persist-then-fire through the same exactly-once path
    // so a duplicate/late status event can never fire twice.
    await mutateState(directory, `cmd.await-request:${input.goalID}:${input.commandID}`, async (s) => {
      s.commandAwaits = [...(s.commandAwaits ?? []), {
        goalID: input.goalID,
        commandID: input.commandID,
        ownerSessionID: input.ownerSessionID,
        createdAt: new Date().toISOString(),
      }]
      return s
    })
    const fired = await fireCommandAwaits(directory, input.commandID)
    const mine = fired.find((f) => f.goalID === input.goalID)
    return {
      ok: true,
      message: `Command "${command.title}" already ${command.status}; wake-up delivered to goal "${goal.name}".`,
      fired: true,
      active: mine?.active ?? goal.status === "active",
    }
  }

  // Subscribe-then-recheck: the command may have exited between our initial
  // read and this persist. Re-check terminal status inside the SAME locked
  // transaction; if terminal now, fire immediately below. Either the exit
  // path's fire saw our await, or we see its terminal status here — with the
  // atomic consume in fireCommandAwaits, exactly one of the two delivers, so
  // the wake can neither be missed nor doubled.
  let becameTerminal = false
  await mutateState(directory, `cmd.await-request:${input.goalID}:${input.commandID}`, async (s) => {
    const dup = (s.commandAwaits ?? []).some(
      (a) => a.goalID === input.goalID && a.commandID === input.commandID,
    )
    if (!dup) {
      s.commandAwaits = [...(s.commandAwaits ?? []), {
        goalID: input.goalID,
        commandID: input.commandID,
        ownerSessionID: input.ownerSessionID,
        createdAt: new Date().toISOString(),
      }]
    }
    const current = (s.commands ?? []).find((c) => c.id === input.commandID)
    if (current && isTerminalCommandStatus(current.status as CommandSession["status"])) {
      becameTerminal = true
    }
    return s
  })
  if (becameTerminal) {
    const fired = await fireCommandAwaits(directory, input.commandID)
    const mine = fired.find((f) => f.goalID === input.goalID)
    return {
      ok: true,
      message: `Command "${command.title}" exited while registering; wake-up delivered to goal "${goal.name}".`,
      fired: true,
      active: mine?.active ?? goal.status === "active",
    }
  }
  await appendEvent(directory, ledgerEvent({
    goalID: input.goalID,
    commandID: input.commandID,
    type: "command.await-requested",
  })).catch(() => {})
  return { ok: true, message: `Goal "${goal.name}" now awaits "${command.title}" (fires once on exit).` }
}

/** Exported for command-service's owner-exit-notification path (same bounded-tail contract). */
export async function readBoundedTail(directory: string, commandID: string): Promise<string> {
  try {
    // Probe total size first (zero-byte read), then fetch only the last 4KB —
    // never pull the whole retained log for evidence.
    const probe = await readCommandLog(directory, commandID, { offsetBytes: 0, limitBytes: 0 })
    if (probe.totalBytes <= MAX_AWAIT_TAIL_BYTES) {
      const full = await readCommandLog(directory, commandID, {
        offsetBytes: 0,
        limitBytes: MAX_AWAIT_TAIL_BYTES,
      })
      return full.text
    }
    const tail = await readCommandLog(directory, commandID, {
      offsetBytes: Math.max(0, probe.totalBytes - MAX_AWAIT_TAIL_BYTES),
      limitBytes: MAX_AWAIT_TAIL_BYTES,
    })
    return tail.text
  } catch {
    return ""
  }
}

/**
 * Fire all outstanding awaits for a terminal command. Consumes each await
 * BEFORE delivering (remove-then-inbox) so a duplicate/late status event can
 * never fire twice. Non-terminal commands and unknown commands fire nothing
 * (output chunks never wake). Awaits whose command record is gone are
 * discarded with a ledger note.
 *
 * Returns the fired awaits with their active flag; the caller wakes active
 * goals via wakeGoalForAwait and leaves the rest in pendingInbox.
 */
export async function fireCommandAwaits(
  directory: string,
  commandID: string,
): Promise<FiredAwait[]> {
  // Atomic check+consume inside ONE locked transaction: overlapping fires
  // (natural exit vs concurrent terminate-finalize vs reconcile vs an
  // immediate-fire request) serialize on the state lock, so exactly one of
  // them observes + consumes the awaits. A fire that consumed nothing
  // delivers nothing. Sequential duplicate/late status events are no-ops.
  let consumed: CommandAwait[] = []
  let command: CommandSession | undefined
  let commandGone = false
  await mutateState(directory, `cmd.await-consume:${commandID}`, async (s) => {
    const outstanding = (s.commandAwaits ?? []).filter((a) => a.commandID === commandID)
    if (outstanding.length === 0) return s
    const current = (s.commands ?? []).find((c) => c.id === commandID) as CommandSession | undefined
    if (!current) {
      // Command record gone: discard with a ledger note (delivered below).
      commandGone = true
      consumed = outstanding
      s.commandAwaits = (s.commandAwaits ?? []).filter((a) => a.commandID !== commandID)
      return s
    }
    // Non-terminal (e.g. a stray fire on a running command) leaves awaits
    // untouched — output chunks never wake.
    if (!isTerminalCommandStatus(current.status)) return s
    command = current
    consumed = outstanding
    s.commandAwaits = (s.commandAwaits ?? []).filter((a) => a.commandID !== commandID)
    return s
  })
  if (consumed.length === 0) return []
  if (commandGone || !command) {
    for (const a of consumed) {
      await appendEvent(directory, ledgerEvent({
        goalID: a.goalID,
        commandID,
        type: "command.await-discarded",
        reason: "command record gone",
      })).catch(() => {})
    }
    return []
  }

  const tail = await readBoundedTail(directory, commandID)
  const fired: FiredAwait[] = []
  for (const a of consumed) {
    const fresh = await readState(directory)
    const goal = fresh.goals.find((g) => g.id === a.goalID)
    if (!goal) {
      await appendEvent(directory, ledgerEvent({
        goalID: a.goalID,
        commandID,
        type: "command.await-discarded",
        reason: "goal gone",
      })).catch(() => {})
      continue
    }
    const evidence = formatAwaitEvidence({
      title: command.title,
      argv: [command.command, ...command.args],
      commandID: command.id,
      status: command.status,
      exitCode: command.exitCode,
      signal: command.signal,
      tail,
    })
    await appendGoalInbox(directory, a.goalID, "worker", evidence)
    await appendEvent(directory, ledgerEvent({
      goalID: a.goalID,
      commandID,
      type: "command.await-fired",
      status: command.status,
      exitCode: command.exitCode,
      signal: command.signal,
    })).catch(() => {})
    fired.push({ goalID: a.goalID, commandID, active: goal.status === "active" })
  }
  return fired
}

/** Cancel a goal's outstanding awaits (pause/clear). Exit afterwards fires nothing. */
export async function cancelAwaitsForGoal(
  directory: string,
  goalID: string,
  reason: string,
): Promise<number> {
  const snapshot = await readState(directory)
  const doomed = (snapshot.commandAwaits ?? []).filter((a) => a.goalID === goalID)
  if (doomed.length === 0) return 0
  await mutateState(directory, `cmd.await-cancel-goal:${goalID}`, async (s) => {
    s.commandAwaits = (s.commandAwaits ?? []).filter((a) => a.goalID !== goalID)
    return s
  })
  await appendEvent(directory, ledgerEvent({
    goalID,
    type: "command.await-cancelled",
    reason,
    count: doomed.length,
  })).catch(() => {})
  return doomed.length
}

/** Clear awaits pointing at a removed command. */
export async function clearAwaitsForCommand(
  directory: string,
  commandID: string,
  reason: string,
): Promise<number> {
  const snapshot = await readState(directory)
  const doomed = (snapshot.commandAwaits ?? []).filter((a) => a.commandID === commandID)
  if (doomed.length === 0) return 0
  await mutateState(directory, `cmd.await-clear-command:${commandID}`, async (s) => {
    s.commandAwaits = (s.commandAwaits ?? []).filter((a) => a.commandID !== commandID)
    return s
  })
  for (const a of doomed) {
    await appendEvent(directory, ledgerEvent({
      goalID: a.goalID,
      commandID,
      type: "command.await-cancelled",
      reason,
    })).catch(() => {})
  }
  return doomed.length
}

/**
 * Reconcile awaits after restart (durable state survives via the state repo).
 * An await whose command is already terminal fires once on recovery; an await
 * whose command record is gone is discarded with a ledger note; running
 * commands keep their awaits. Returns fired awaits (caller wakes active ones).
 */
export async function reconcileCommandAwaits(directory: string): Promise<FiredAwait[]> {
  const snapshot = await readState(directory)
  const outstanding = [...(snapshot.commandAwaits ?? [])]
  const fired: FiredAwait[] = []
  for (const a of outstanding) {
    const fresh = await readState(directory)
    const still = (fresh.commandAwaits ?? []).some(
      (x) => x.goalID === a.goalID && x.commandID === a.commandID,
    )
    if (!still) continue // already consumed/cancelled by an earlier step
    const command = (fresh.commands ?? []).find((c) => c.id === a.commandID)
    if (!command) {
      await mutateState(directory, `cmd.await-reconcile-discard:${a.commandID}`, async (s) => {
        s.commandAwaits = (s.commandAwaits ?? []).filter(
          (x) => !(x.goalID === a.goalID && x.commandID === a.commandID),
        )
        return s
      })
      await appendEvent(directory, ledgerEvent({
        goalID: a.goalID,
        commandID: a.commandID,
        type: "command.await-discarded",
        reason: "command record gone at reconcile",
      })).catch(() => {})
      continue
    }
    if (!isTerminalCommandStatus(command.status)) continue
    const now = await fireCommandAwaits(directory, a.commandID)
    fired.push(...now.filter((f) => f.goalID === a.goalID))
  }
  return fired
}

/**
 * Wake a goal for a fired await through the EXISTING idle-continuation path:
 * clear stale run state (same fields send/nudge reset) then force one
 * steering turn, which drains the evidence from pendingInbox as normal
 * steering context. Non-active goals are never auto-activated — their
 * evidence waits in pendingInbox for the next explicit resume/retry.
 */
export async function wakeGoalForAwait(
  directory: string,
  continuation: AwaitContinuation,
  goalID: string,
): Promise<{ woke: boolean; message: string }> {
  const snapshot = await readState(directory)
  const goal = snapshot.goals.find((g) => g.id === goalID)
  if (!goal) return { woke: false, message: "Goal gone; wake skipped." }
  if (goal.status !== "active") {
    return { woke: false, message: `Goal is ${goal.status}; evidence waits in pendingInbox.` }
  }
  await mutateState(directory, `cmd.await-wake:${goalID}`, async (s) => {
    const rt = s.runtimes.find((r) => r.goalID === (goalID as GoalID))
    if (!rt) return s
    rt.phase = "idle"
    rt.activeRunID = undefined
    rt.idleCandidateAt = undefined
    rt.activePromptMessageID = undefined
    rt.activeToolCallIDs = []
    rt.updatedAt = new Date().toISOString()
    return s
  })
  await continuation.continueTurn(directory, goalID as GoalID, { force: true })
  return { woke: true, message: `Woke goal "${goal.name}" for command exit.` }
}
