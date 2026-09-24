// ─── v2 Native Bridge (server-side coordinator) ──────────────────────────────
// Pure pending-request coordinator for the loopd.native RPC bridge. No
// OpenCode imports: the plugin wires `emit` + RPC handlers to this core so
// the claim/timeout/disposal semantics are unit-testable.
//
// Policy (from the objective):
// - unclaimed after claim timeout → caller uses the current root fallback.
// - claimed-but-TUI-vanished (claimed timeout) → REJECT startup, never
//   duplicate, never silently fall back.
// - explicit TUI failure pre-creation → fallback-safe outcome.
// - explicit TUI failure post-creation (or parent mismatch) → reject.
// - disposal rejects all pending requests.

import {
  CLAIM_TIMEOUT_MS,
  CLAIMED_TIMEOUT_MS,
  type WorkerClaimResult,
  type WorkerCreateFailure,
  type WorkerCreateRequest,
  type WorkerCreateResult,
} from "./native-rpc"

export type BridgeOutcome =
  | { kind: "native-child"; childSessionID: string; parentSessionID: string; topology: "v2-native-child" }
  | { kind: "unclaimed" }
  | { kind: "fallback-safe"; reason: string; detail?: string }

export type BridgeErrorCode = "claimed-timeout" | "parent-mismatch" | "fork-failed" | "disposed"

export class NativeBridgeError extends Error {
  readonly code: BridgeErrorCode
  readonly requestID: string
  constructor(code: BridgeErrorCode, requestID: string, message: string) {
    super(message)
    this.name = "NativeBridgeError"
    this.code = code
    this.requestID = requestID
  }
}

export interface BridgeOptions {
  claimTimeoutMs?: number
  claimedTimeoutMs?: number
}

interface PendingEntry {
  state: "awaiting-claim" | "claimed" | "settled"
  claimantID?: string
  resolve: (outcome: BridgeOutcome) => void
  reject: (error: NativeBridgeError) => void
  claimTimer?: ReturnType<typeof setTimeout>
  claimedTimer?: ReturnType<typeof setTimeout>
}

export interface NativeBridge {
  readonly pendingCount: () => number
  readonly isDisposed: () => boolean
  requestWorker: (request: WorkerCreateRequest, emit: (request: WorkerCreateRequest) => unknown) => Promise<BridgeOutcome>
  /** Returns {won:true} for exactly one claimant; all others get {won:false}. */
  handleClaim: (claim: WorkerClaimResult) => { won: boolean }
  /** Returns true when the completion settled a live claimed request. */
  handleComplete: (result: WorkerCreateResult) => boolean
  /** Returns true when the failure settled a live claimed request. */
  handleFailure: (failure: WorkerCreateFailure) => boolean
  dispose: () => void
}

export function createNativeBridge(options: BridgeOptions = {}): NativeBridge {
  const claimTimeoutMs = options.claimTimeoutMs ?? CLAIM_TIMEOUT_MS
  const claimedTimeoutMs = options.claimedTimeoutMs ?? CLAIMED_TIMEOUT_MS
  const pending = new Map<string, PendingEntry>()
  let disposed = false

  function settle(requestID: string, settleFn: (entry: PendingEntry) => void): boolean {
    const entry = pending.get(requestID)
    if (!entry || entry.state === "settled") return false
    entry.state = "settled"
    if (entry.claimTimer) clearTimeout(entry.claimTimer)
    if (entry.claimedTimer) clearTimeout(entry.claimedTimer)
    pending.delete(requestID)
    settleFn(entry)
    return true
  }

  return {
    pendingCount: () => pending.size,
    isDisposed: () => disposed,

    requestWorker(request, emit) {
      if (disposed) {
        return Promise.reject(new NativeBridgeError("disposed", request.requestID, "native bridge is disposed"))
      }
      return new Promise<BridgeOutcome>((resolve, reject) => {
        const entry: PendingEntry = { state: "awaiting-claim", resolve, reject }
        pending.set(request.requestID, entry)
        let emitResult: unknown
        try {
          emitResult = emit(request)
        } catch {
          // Bridge unsupported (no TUI transport): behave as unclaimed so the
          // caller takes the flagged root fallback.
          settle(request.requestID, (e) => e.resolve({ kind: "unclaimed" }))
          return
        }
        const afterEmit = () => {
          const live = pending.get(request.requestID)
          if (!live || live.state !== "awaiting-claim") return
          live.claimTimer = setTimeout(() => {
            settle(request.requestID, (e) => e.resolve({ kind: "unclaimed" }))
          }, claimTimeoutMs)
          // setTimeout with 0 must still fire; unref in bun/node is harmless.
          if (typeof (live.claimTimer as any)?.unref === "function") (live.claimTimer as any).unref()
        }
        if (emitResult && typeof (emitResult as Promise<unknown>).then === "function") {
          ;(emitResult as Promise<unknown>).then(afterEmit, () => {
            settle(request.requestID, (e) => e.resolve({ kind: "unclaimed" }))
          })
        } else {
          afterEmit()
        }
      })
    },

    handleClaim(claim) {
      const entry = pending.get(claim.requestID)
      // Atomic first-claim-wins: single-threaded check-and-set. Only an
      // awaiting-claim entry can be claimed; claimed/settled/unknown claims
      // lose (covers duplicate TUIs racing on the same request).
      if (!entry || entry.state !== "awaiting-claim") return { won: false }
      entry.state = "claimed"
      entry.claimantID = claim.claimantID
      if (entry.claimTimer) clearTimeout(entry.claimTimer)
      entry.claimedTimer = setTimeout(() => {
        settle(claim.requestID, (e) =>
          e.reject(new NativeBridgeError(
            "claimed-timeout",
            claim.requestID,
            `claimant "${claim.claimantID}" vanished before completing worker creation; failing startup rather than duplicating`,
          )),
        )
      }, claimedTimeoutMs)
      if (typeof (entry.claimedTimer as any)?.unref === "function") (entry.claimedTimer as any).unref()
      return { won: true }
    },

    handleComplete(result) {
      return settle(result.requestID, (entry) =>
        entry.resolve({
          kind: "native-child",
          childSessionID: result.childSessionID,
          parentSessionID: result.parentSessionID,
          topology: "v2-native-child",
        }),
      )
    },

    handleFailure(failure) {
      if (failure.preCreation) {
        return settle(failure.requestID, (entry) =>
          entry.resolve({ kind: "fallback-safe", reason: failure.reason, detail: failure.detail }),
        )
      }
      return settle(failure.requestID, (entry) =>
        entry.reject(new NativeBridgeError(
          failure.reason === "parent-mismatch" ? "parent-mismatch" : "fork-failed",
          failure.requestID,
          `native worker creation failed post-creation (${failure.reason}): ${failure.detail ?? "no detail"}`,
        )),
      )
    },

    dispose() {
      disposed = true
      const ids = [...pending.keys()]
      for (const id of ids) {
        settle(id, (entry) =>
          entry.reject(new NativeBridgeError("disposed", id, "native bridge disposed with request pending")),
        )
      }
    },
  }
}
