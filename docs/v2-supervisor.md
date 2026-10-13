# v2-first goal supervision

Loopd supervises objectives; OpenCode executes sessions. A finished execution
does not verify an objective. Goal checks, budgets, scheduling, owner decisions
and cross-goal workspace coordination remain loopd responsibilities.

## Native execution path

The audited contract is `@opencode/plugin` / `@opencode/schema` 2.0.11:

- `session.prompt` accepts an inbox item, not an assistant response.
- `delivery: "queue"` delegates busy-session delivery to OpenCode.
- `session.wait` observes the native coordinator reaching idle, including queued work.
- `session.get` exposes the last terminal `outcome` and `time.idle`.
- `session.context` exposes delivered user message IDs.
- Durable execution events carry a session ID, **not an execution ID**.

Execution events trigger reconciliation against these public projections.
Loopd requires the terminal time to belong to its current turn, the latest
delivered input to be owned by that turn, and all native queue receipts to be
delivered. Generation/session fences reject late observations. Workspace calls
and verification operations must drain before a turn can be released.

Successful execution advances goal policy once. Failed execution enters the
goal's bounded retry policy; a live provider retry is not a terminal failure.
Interrupted execution parks the goal as paused, requiring owner resume.
Interactive goals record terminal execution without automatic continuation.

Native running status is independent of the scheduling lease. Lease expiry
does not label a host-observed active execution as stale or permit a new turn.
Native tools retain workspace guards without duplicate runtime tool-call tracking.

## Message ownership

For an accepted active turn, steering and background notifications use the
native inbox. Loopd persists receipt IDs, not a second copy of queued contents.
Receipts are reserved before enqueue and reconciled after restart. Ambiguous
acceptance retains the fence and returns an unconfirmed result; it never
authorizes a blind retry. Paused goals retain words in the goal inbox until an
explicit owner transition. Retired workers are not notification targets.

## Restart and compatibility

Maintenance reconciles missed native terminal events using the same coordinator
and durable projections. It does not use transcript completion heuristics,
idle debounce, or expired-lease recovery on the native path. Transcripts remain
available for usage accounting, context and the native session view.

V1 and older v2 surfaces without `session.wait` use the explicit legacy
compatibility path. V2 plugin load diagnostics identify `native` versus
`legacy-compatibility`. Legacy message ancestry, idle confirmation and polling
remain fallbacks, not authorities for native execution.

Worker creation retains the native child bridge where required by the public
server/TUI API boundary. Goal persistence and file coordination are not a
replacement for OpenCode sessions or an OS/filesystem sandbox.
