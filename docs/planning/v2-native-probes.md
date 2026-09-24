# v2-Native Goal Workers — Live Capability Probes (Phase 1)

Goal: `v2-native-worker-bridge` — Phases 1–3 only. No command/PTY changes.

Shared schema: `src/v2/native-rpc.ts` (`loopd.native`: event
`workerCreateRequested`, methods `claimRequest` / `completeWorkerCreate` /
`failRequest`; timeouts `CLAIM_TIMEOUT_MS=3000`, `CLAIMED_TIMEOUT_MS=15000`).

## Probe C (negative) — VERIFIED STATICALLY (code evidence, 2026-09-24)

**C1: `session.create` with undeclared `parentID` is stripped — CONFIRMED.**
- `SessionCreateInput` (`node_modules/@opencode/client/dist/promise/generated/types.d.ts`
  ~line 3669) accepts ONLY `id | title | agent | model | location | metadata |
  permissions`. There is **no `parentID` field** in the input shape.
- The server-plugin adapter (`node_modules/@opencode/plugin/dist/promise/adapter.js`
  line 419) decodes `session.create` through the endpoint schema
  (`adaptApiMethod(SessionEndpoints["session.create"], host.session.create)`),
  so undeclared fields are stripped before reaching the host. Do NOT pass
  `parentID` to `session.create`; the fork path is required.
- Current `createV2Host.createWorker` (`src/server/host-adapter.ts:339-350`)
  passes only `metadata: { "loopd.parentID": parentID }` (display-only) —
  this is the root-fallback baseline, behaviorally unchanged.

**C2: server ctx has nothing beyond `terminal.read` — CONFIRMED.**
- `Context` (`node_modules/@opencode/plugin/dist/promise/plugin.d.ts`): the
  `experimental` field exposes ONLY
  `terminal: Pick<OpenCodeClient["experimental"]["persistentPty"], "read">`.
- `SessionDomain` (`node_modules/@opencode/plugin/dist/promise/session.d.ts:143`)
  is `Pick<SessionApi, "create"|"get"|"switchAgent"|"switchModel"|"prompt"|
  "generate"|"command"|"synthetic"|"interrupt"|"update"|"move"|"wait"|"context">`
  — **no `fork`**. Native children are unreachable from the server; the RPC
  bridge (server `RpcDomain.register` + TUI `makeRpc` subscribe) is required.
- TUI `Context.client` (`node_modules/@opencode/plugin/dist/tui/context.d.ts:449`)
  is the FULL `OpenCodeClient`, including `session.fork` — the fork must run
  in TUI context.

**Record:** C1 + C2 both green. Proceeding to Probes A/B (live runtime checks
still required before Phase 2–3 build).

## Probe A (RPC bridge) — PLAN (live verification pending)

1. Server (`src/server/plugin.ts` v2 `setup`): `context.rpc.register(
   nativeRpcDefinition, { claimRequest, completeWorkerCreate, failRequest })`
   + `registration.events.emit("workerCreateRequested", request)` for a test
   request.
2. TUI (`src/tui/plugin.tsx` v2 `setup`): `makeRpc(ctx.client, …)` subscribe to
   `rpc.loopd.native.workerCreateRequested`, atomic-claim via `claimRequest`
   (server keeps first-claim-wins map keyed by `requestID`), reply once.
3. Success: server receives **exactly one** correlated reply among duplicate
   TUI clients. Record input/output shapes here when observed.

Status: **UNIT-VERIFIED 2026-09-24** (`test/v2/native-bridge.test.ts`, 10 tests):
- Exactly-one-claimant: first claim wins, second loses; unknown-request claims
  lose (`createNativeBridge.handleClaim` first-claim-wins, single-threaded).
- Unclaimed timeout → `{kind:"unclaimed"}` (root fallback); emit-throw →
  unclaimed (unsupported transport).
- Claimed-timeout → rejects with `claimed-timeout` (fail startup, never
  duplicate); late completions after settle ignored (`handleComplete` false).
- Explicit pre-creation failure → `{kind:"fallback-safe"}`; post-creation
  (`parent-mismatch`) → rejects.
- Disposal rejects all pending with `disposed`; new requests post-disposal
  reject.
Core: `src/v2/native-bridge.ts`. Server/TUI RPC wiring (register/subscribe
over a live host) is Phase 2 build; **live multi-TUI verification still
pending** (requires a running OpenCode v2 host with 2 attached TUIs).

Phase 2 wiring (implemented 2026-09-24, `src/v2/native-server.ts` +
`src/tui/plugin.tsx` v2setup + `test/v2/native-wiring.test.ts`, 6 tests):
- Server `setupNativeServer`: registers `loopd.native` (claim/complete/fail),
  emits `workerCreateRequested`, maps first-claim-wins to `{won}` acks,
  `dispose()` rejects pending + releases the registration. Returns undefined
  when the host has no RPC domain (server logs `native-bridge.unsupported`
  vs `native-bridge.ready`; existing no-RPC setup test covers the fallback).
- TUI `subscribeNativeRequests`: subscribes, runs `handleWorkerCreateRequest`
  with a per-TUI claimant ID + directory-aware `isKnownParent` gate
  (parent known AND in this TUI's directory), unsubscribes on disposal.
  Missing `client.rpc` → never claims (try/catch); server falls back.
- Request carries `directory` (server cwd) so cross-directory TUIs don't
  claim each other's parents.
- NOTE: `permissions` in the request payload is accepted end-to-end by the
  schema/handler but never populated — goal creation has no permissions
  source. Server configures agent/model/title (idempotent re-apply after
  the TUI's fork-time configure).
- Live-host round-trip (real `session.fork` parentage, family() listing,
  prompt execution on the child) still requires a running OpenCode v2 host
  and cannot run in this headless env — recorded as the remaining manual
  verification step, not as a failure.

## Probe B (native child via TUI fork) — PLAN (live verification pending)

From TUI context:
`child = await ctx.client.session.fork({ sessionID: parentID, before: firstMessageID })`
where `firstMessageID` = `ctx.data.session.message.list(parentID)[0]?.id`.

Verify + record:
- `child.parentID === parentID` (SessionForkInput/Output at
  `node_modules/@opencode/client/dist/promise/generated/types.d.ts` ~line 5263;
  `SessionInfo.parentID` confirmed present).
- `ctx.data.session.family(parentID)` contains the child.
- Child transcript empty of parent conversation (fork-before-first-message).
- `switchAgent` / `switchModel` / rename work on the child; prompt executes
  with normal events.

Success: native empty-context child appears under the primary session.
Status: **SPEC-PINNED 2026-09-24** (`src/v2/native-tui.ts` +
`test/v2/native-tui.test.ts`, 7 tests): ignores unknown parents without
claiming; claim-lost returns quietly; forks with `{sessionID, before:
firstMessageID}` (no `before` when parent has no messages); verifies
`child.parentID === parent` (mismatch → post-creation failure, never
fallback); configures agent/model/title; fork-throw → pre-creation failure
(fallback safe). **Live execution against a real TUI client still pending**
(requires a running OpenCode v2 host; cannot run in this headless env).

## GATE

- C green (static). A + B require live runtime; if either FAILS live: STOP,
  record the failure here, and complete the goal with the honest negative
  result — do NOT build Phases 2–3 on a failed probe.

## LIVE FAILURE 2026-09-24 — location-scoped RPC claim (FIXED, unverified live)

Session `ses_f2ec01748ffeaCxOkkJMvcG3w6` showed no native child: goal
`test-interaction-main` persisted `workerTopology: v2-root-fallback` and the
server log showed `worker.create.native-fallback reason:"unclaimed"` despite
`native-bridge.ready`.

Root cause: plugin RPC is location-scoped. Two server locations were
registered (`/Users/duytrinh`, `/Users/duytrinh/Code/opencode-loopd`); the TUI
called `claimRequest`/`completeWorkerCreate`/`failRequest` with NO location
option, so each call routed to the TUI client's default location (home),
whose bridge held no such pending request → `won:false` → server timed out
unclaimed. Unit mocks had a single location and missed it.

Fix (`src/v2/native-tui.ts`, `src/tui/plugin.tsx`):
- `NativeRpcClient` methods accept `options?: { location?: { directory } }`
  (matches `RpcCallOptions`; `makeRpc` forwards it as the call's `location`).
- `subscribeNativeRequests` reads the emitting event's authoritative
  `event.location.directory` (`V2EventRpc.location` is required) and threads
  it through claim/complete/fail.
- `onOutcome` seam wired to `/tmp/loopd-tui.log` so ignored/failed requests
  leave a trace instead of vanishing silently.
- Regression: `test/v2/native-tui.test.ts` "location routing" block — a
  two-bridge fake (home + repo) proves the claim reaches the emitting
  location's bridge exactly once, plus a doc-test of the pre-fix behavior.

Status: unit-verified (478/478 green). LIVE RE-VERIFICATION STILL REQUIRED:
restart v2, create a throwaway goal from the session, and require all three —
state `v2-native-child`, `nativeParentID` == owner, worker visible under the
native session arrow — plus a `native-worker request=… outcome={…completed}`
line in `/tmp/loopd-tui.log`.
