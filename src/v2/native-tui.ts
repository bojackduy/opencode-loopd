// ─── v2 Native TUI Fork Handler ──────────────────────────────────────────────
// Runs in TUI plugin context (full OpenCodeClient available). Pure function
// over a minimal dependency interface so it is unit-testable with fakes and
// the exact fork input/output shapes are pinned by tests (Probe B spec).
//
// Flow for one workerCreateRequested event:
// 1. Knows-parent check: data.session.get(parentSessionID) must exist.
//    Unknown parent → silently ignore (never claim someone else's session).
// 2. Atomic claim via claimRequest. Lost race → return quietly.
// 3. Load first message ID; fork({sessionID: parent, before?: firstID}).
//    No messages → fork({sessionID: parent}) with no `before` (hosts that
//    reject empty-session forks throw → pre-creation failure, fallback safe).
// 4. Verify resolveNativeParentID(child) === parent (live hosts carry
//    fork.sessionID; parentID may be null); mismatch → failRequest
//    preCreation:false.
// 5. Configure agent/model/title through the supported SessionDomain surface.
// 6. completeWorkerCreate with the native child ID.
// Fork throws → failRequest preCreation:true (root fallback safe).

import type {
  NativeForkChild,
  WorkerCreateFailure,
  WorkerCreateRequest,
  WorkerCreateResult,
} from "./native-rpc"
import { resolveNativeParentID } from "./native-rpc"

export interface ForkClient {
  session: {
    fork: (input: { sessionID: string; before?: string }) => Promise<NativeForkChild>
    switchAgent?: (input: { sessionID: string; agent: string }) => Promise<unknown>
    switchModel?: (input: { sessionID: string; model: { id: string; providerID: string } }) => Promise<unknown>
    update?: (input: { sessionID: string; title?: string }) => Promise<unknown>
  }
}

export interface ForkData {
  session: {
    get: (sessionID: string) => { id: string } | undefined
    message: {
      list: (sessionID: string) => Array<{ id: string }>
    }
  }
}

/**
 * RPC call routing. Plugin RPC methods are location-scoped: the server
 * registers one bridge instance per project directory, and a TUI call
 * without `location` lands on the TUI client's default location (usually
 * the home directory) — NOT the bridge that emitted the request. Every
 * bridge call must therefore carry the emitting event's location, or the
 * claim reaches a bridge with no such pending request (won:false) and the
 * server times out unclaimed. See docs/planning/v2-native-probes.md.
 */
export interface RpcCallLocation {
  directory?: string
}

export type RpcCallOptions = { location?: RpcCallLocation }

export interface ForkHandlerDeps {
  client: ForkClient
  data: ForkData
  claimantID: string
  claim: (input: { requestID: string; claimantID: string }, options?: RpcCallOptions) => Promise<{ won: boolean }>
  complete: (result: WorkerCreateResult, options?: RpcCallOptions) => Promise<unknown>
  fail: (failure: WorkerCreateFailure, options?: RpcCallOptions) => Promise<unknown>
  /**
   * Extra knows-parent+location gate. When present the request is ignored
   * unless this returns true (in addition to data.session.get existing).
   * The TUI uses it to claim only parents in its own directory.
   */
  isKnownParent?: (parentSessionID: string) => boolean
  /**
   * Observability seam. Called once per handled request with the outcome
   * (never throws into the handler). The plugin wires it to a debug log so
   * a silently-ignored request leaves a trace instead of vanishing.
   */
  onOutcome?: (outcome: ForkHandleOutcome, requestID: string) => void
}

export type ForkHandleOutcome =
  | { handled: "ignored-unknown-parent" }
  | { handled: "claim-lost" }
  | { handled: "completed"; childSessionID: string; forkInput: { sessionID: string; before?: string } }
  | { handled: "failed"; reason: string; preCreation: boolean }

// ─── TUI subscriber ──────────────────────────────────────────────────────────
// Thin adapter from an RPC client (ctx.client.rpc(definition)) to the fork
// handler above. The plugin wires it once at setup and calls the returned
// unsubscribe on disposal.

export interface NativeRpcClient {
  claimRequest: (input: { requestID: string; claimantID: string }, options?: RpcCallOptions) => Promise<{ won?: boolean }>
  completeWorkerCreate: (result: WorkerCreateResult, options?: RpcCallOptions) => Promise<unknown>
  failRequest: (failure: WorkerCreateFailure, options?: RpcCallOptions) => Promise<unknown>
  events: {
    on: (
      name: string,
      handler: (event: { data?: unknown; location?: { directory?: string } }) => void,
    ) => () => void
  }
}

export function subscribeNativeRequests(
  rpcClient: NativeRpcClient,
  deps: Omit<ForkHandlerDeps, "claim" | "complete" | "fail">,
): () => void {
  return rpcClient.events.on("workerCreateRequested", (event) => {
    const request = event?.data as WorkerCreateRequest | undefined
    if (!request || typeof request.requestID !== "string") return
    // Route every call back to the location that emitted this event. Without
    // this the claim lands on the default location's bridge (usually home),
    // which has no such pending request → won:false → server unclaimed.
    const directory = event?.location?.directory
    const options: RpcCallOptions | undefined =
      typeof directory === "string" && directory.length > 0 ? { location: { directory } } : undefined
    void handleWorkerCreateRequest(request, {
      ...deps,
      claim: (input) =>
        rpcClient.claimRequest(input, options).then((ack) => ({ won: (ack as { won?: unknown })?.won === true })),
      complete: (result) => rpcClient.completeWorkerCreate(result, options),
      fail: (failure) => rpcClient.failRequest(failure, options),
    }).then(
      (outcome) => {
        try {
          deps.onOutcome?.(outcome, request.requestID)
        } catch {}
      },
      () => {
        // Best-effort from an event callback: a throw here would break the
        // subscriber loop. The bridge timeouts settle the server side.
      },
    )
  })
}

export async function handleWorkerCreateRequest(
  request: WorkerCreateRequest,
  deps: ForkHandlerDeps,
): Promise<ForkHandleOutcome> {
  // 1. Knows-parent (+location) check.
  const parent = deps.data.session.get(request.parentSessionID)
  if (!parent) return { handled: "ignored-unknown-parent" }
  if (deps.isKnownParent && !deps.isKnownParent(request.parentSessionID)) {
    return { handled: "ignored-unknown-parent" }
  }

  // 2. Atomic claim.
  const { won } = await deps.claim({ requestID: request.requestID, claimantID: deps.claimantID })
  if (!won) return { handled: "claim-lost" }

  const fail = (reason: string, preCreation: boolean, detail?: string): Promise<ForkHandleOutcome> =>
    deps.fail({ requestID: request.requestID, reason, preCreation, detail }).then(() => ({
      handled: "failed" as const,
      reason,
      preCreation,
    }))

  // 3. Fork before the first message (empty-history native child). No
  // messages → fork with no `before` boundary.
  let forkInput: { sessionID: string; before?: string }
  try {
    const messages = deps.data.session.message.list(request.parentSessionID)
    const firstID = messages[0]?.id
    forkInput = firstID ? { sessionID: request.parentSessionID, before: firstID } : { sessionID: request.parentSessionID }
  } catch (error) {
    return fail("message-list-failed", true, error instanceof Error ? error.message : String(error))
  }

  let child: NativeForkChild
  try {
    child = await deps.client.session.fork(forkInput)
  } catch (error) {
    return fail("fork-failed", true, error instanceof Error ? error.message : String(error))
  }

  // 4. Verify native parentage. A child whose resolved parent disagrees is a
  // real session that already exists → NEVER fall back (would duplicate).
  const actualParent = resolveNativeParentID(child)
  if (actualParent !== request.parentSessionID) {
    return fail(
      "parent-mismatch",
      false,
      `resolved-parent=${JSON.stringify(actualParent)} expected=${JSON.stringify(request.parentSessionID)}`,
    )
  }

  // 5. Configure through the supported SessionDomain surface. The child
  // already exists here, so any failure is post-creation (no fallback).
  try {
    if (request.agent && deps.client.session.switchAgent) {
      await deps.client.session.switchAgent({ sessionID: child.id, agent: request.agent })
    }
    if (request.model && deps.client.session.switchModel) {
      await deps.client.session.switchModel({ sessionID: child.id, model: request.model })
    }
    if (deps.client.session.update) {
      await deps.client.session.update({ sessionID: child.id, title: request.title })
    }
  } catch (error) {
    return fail("configure-failed", false, error instanceof Error ? error.message : String(error))
  }

  // 6. Report the native child.
  await deps.complete({
    requestID: request.requestID,
    childSessionID: child.id,
    parentSessionID: request.parentSessionID,
    topology: "v2-native-child",
  })
  return { handled: "completed", childSessionID: child.id, forkInput }
}
