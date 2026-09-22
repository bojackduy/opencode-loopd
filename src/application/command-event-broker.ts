// ─── Application: Command Event Broker ─────────────────────────────────────────
// Broker layer ONLY: no transport, no TUI, no PTY. Publishes validated
// CommandStreamMessage events to per-command subscribers.
//
// Durability story: persist-first-then-emit. The service persists every event
// (log + metadata) BEFORE calling publish(), so a resync replay can always
// reconstruct from disk. The broker itself never buffers unboundedly: when a
// command has zero subscribers, publish() drops. During subscribe() the broker
// buffers briefly (snapshot race window), dedups by absolute offsets, then
// goes live.
//
// Snapshot race handling (subscribe):
//   1. Verify ownership against stored CommandSession (reject cross-owner).
//   2. Buffer live events arriving during subscribe.
//   3. Wait for the command's in-flight operations to quiesce.
//   4. Read a snapshot ending at offset N (retained bytes mapped to absolute
//      lifetime offsets via streamBytes).
//   5. Send snapshot, discard buffered events ending at or before N, deliver
//      the rest in order.
// Sinks are plain callbacks; per-sink try/catch isolates failures so one
// throwing sink never breaks the service or other sinks.

import { randomUUID } from "crypto"
import type { CommandSession } from "../domain/command-session"
import {
  validateCommandStreamMessage,
  type CommandStreamMessage,
  type OutputMessage,
  type SnapshotMessage,
  type StatusMessage,
} from "../domain/command-events"

export type CommandEventSink = (msg: CommandStreamMessage) => void

export interface BrokerSnapshot {
  command: CommandSession
  data: string
  startOffset: number
  endOffset: number
}

/** Storage access the broker needs. Provided by CommandService (no import cycle). */
export interface CommandEventBrokerResolver {
  getSession(commandID: string, ownerSessionID: string): Promise<CommandSession | undefined>
  waitForQuiesce(commandID: string): Promise<void>
  readSnapshot(commandID: string, ownerSessionID: string): Promise<BrokerSnapshot | undefined>
}

type EntryState = "subscribing" | "live"

interface SinkEntry {
  sinkID: string
  sink: CommandEventSink
  state: EntryState
  buffer: CommandStreamMessage[]
}

export interface CommandEventBroker {
  /** Register/replace the storage resolver (called once by CommandService). */
  setResolver(resolver: CommandEventBrokerResolver | undefined): void
  /**
   * Subscribe to a command. Verifies ownership, handles the snapshot race,
   * sends snapshot then replays non-duplicate buffered events in order.
   * Returns the sinkID for unsubscribe(). Rejects (throws) on cross-owner
   * or missing command/snapshot.
   */
  subscribe(commandID: string, ownerSessionID: string, sink: CommandEventSink): Promise<string>
  /** Remove a subscriber. No-op when unknown. */
  unsubscribe(commandID: string, sinkID: string): void
  /**
   * Deliver a validated message to live subscribers in publish order.
   * Buffers for `subscribing` entries (snapshot race). Drops when there are
   * no subscribers. Never throws for sink errors (isolated per sink).
   * Returns true when delivered to ≥1 live subscriber or buffered for ≥1
   * subscribing entry; false when dropped or message invalid.
   */
  publish(commandID: string, message: CommandStreamMessage): boolean
  /** Subscriber count for a command (live + subscribing). */
  subscriberCount(commandID: string): number
}

function safeDeliver(sink: CommandEventSink, msg: CommandStreamMessage): void {
  try {
    sink(msg)
  } catch {
    // Isolate: a chatty/throwing sink never breaks the service or peers.
  }
}

/** True when a buffered event is already covered by the snapshot. */
function isCoveredBySnapshot(msg: CommandStreamMessage, snapshot: SnapshotMessage): boolean {
  if (msg.type === "output") {
    const out = msg as OutputMessage
    return out.endOffset <= snapshot.endOffset
  }
  if (msg.type === "status") {
    const st = msg as StatusMessage
    // Snapshot was read after quiesce, so it supersedes any buffered status
    // at or before its updatedAt. Post-snapshot statuses (newer updatedAt)
    // are still delivered.
    const bufferedAt = st.command.updatedAt ?? ""
    const snapshotAt = snapshot.command.updatedAt ?? ""
    return bufferedAt <= snapshotAt
  }
  // Non-byte-ranged control messages buffered during subscribe are stale
  // relative to the fresh snapshot — drop them. Future live messages flow
  // directly once the entry goes live.
  return true
}

export function createCommandEventBroker(
  resolver?: CommandEventBrokerResolver,
): CommandEventBroker {
  let currentResolver = resolver
  // commandID -> sinkID -> entry (insertion order = subscribe order)
  const subscribers = new Map<string, Map<string, SinkEntry>>()

  function entriesFor(commandID: string): Map<string, SinkEntry> {
    let m = subscribers.get(commandID)
    if (!m) {
      m = new Map()
      subscribers.set(commandID, m)
    }
    return m
  }

  return {
    setResolver(next) {
      currentResolver = next
    },

    async subscribe(commandID, ownerSessionID, sink): Promise<string> {
      if (!currentResolver) throw new Error("Command event broker has no resolver (service not wired).")
      if (!commandID) throw new Error("commandID is required.")
      if (!ownerSessionID) throw new Error("ownerSessionID is required.")
      if (typeof sink !== "function") throw new Error("sink must be a function.")

      const sinkID = randomUUID()
      const entry: SinkEntry = { sinkID, sink, state: "subscribing", buffer: [] }
      entriesFor(commandID).set(sinkID, entry)

      try {
        // 1. Ownership check against stored metadata (reject cross-owner).
        const session = await currentResolver.getSession(commandID, ownerSessionID)
        if (!session) {
          throw new Error("Command not found or not owned by this session (cross-owner subscribe rejected).")
        }
        // 2-3. Buffering is already active (entry added before awaits);
        // wait for in-flight service operations to quiesce.
        await currentResolver.waitForQuiesce(commandID)
        // 4. Snapshot ending at absolute offset N.
        const snap = await currentResolver.readSnapshot(commandID, ownerSessionID)
        if (!snap) {
          throw new Error("Command snapshot unavailable (removed or unreadable).")
        }
        const snapshotMsg: SnapshotMessage = {
          type: "snapshot",
          command: snap.command,
          data: snap.data,
          startOffset: snap.startOffset,
          endOffset: snap.endOffset,
        }
        const validated = validateCommandStreamMessage(snapshotMsg)
        if (!validated.ok) {
          throw new Error(`Invalid snapshot: ${validated.error}`)
        }
        // 5. Send snapshot, then replay buffered events in order, dropping
        // those already covered (output endOffset <= N, stale statuses).
        // This replay loop is synchronous: publish() calls interleave only
        // before or after it (single-threaded), never mid-loop, so ordering
        // is preserved without additional locking.
        const stillThere = subscribers.get(commandID)?.get(sinkID)
        if (!stillThere) throw new Error("Subscription cancelled during handshake.")
        const buffered = entry.buffer.splice(0)
        safeDeliver(entry.sink, validated.message)
        for (const msg of buffered) {
          if (isCoveredBySnapshot(msg, snapshotMsg)) continue
          safeDeliver(entry.sink, msg)
        }
        // Drain arrivals that buffered during the synchronous replay window
        // boundary (defensive: normally empty since replay is sync).
        const extra = entry.buffer.splice(0)
        for (const msg of extra) {
          if (isCoveredBySnapshot(msg, snapshotMsg)) continue
          safeDeliver(entry.sink, msg)
        }
        entry.state = "live"
        return sinkID
      } catch (error) {
        // Failed handshake must not leak a half-open entry.
        subscribers.get(commandID)?.delete(sinkID)
        if (subscribers.get(commandID)?.size === 0) subscribers.delete(commandID)
        throw error
      }
    },

    unsubscribe(commandID, sinkID) {
      const m = subscribers.get(commandID)
      if (!m) return
      m.delete(sinkID)
      if (m.size === 0) subscribers.delete(commandID)
    },

    publish(commandID, message) {
      // Fail-closed: never emit invalid messages, never throw into service.
      let valid: CommandStreamMessage
      try {
        const result = validateCommandStreamMessage(message)
        if (!result.ok) return false
        valid = result.message
      } catch {
        return false
      }
      const m = subscribers.get(commandID)
      if (!m || m.size === 0) return false // drop: persistence is durability
      let handled = false
      for (const entry of m.values()) {
        if (entry.state === "subscribing") {
          entry.buffer.push(valid)
          handled = true
          continue
        }
        safeDeliver(entry.sink, valid)
        handled = true
      }
      return handled
    },

    subscriberCount(commandID) {
      return subscribers.get(commandID)?.size ?? 0
    },
  }
}
