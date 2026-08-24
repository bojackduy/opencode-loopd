# Final Investigation Report — loopd Engine & Subagent Desync

> Investigated: 2026-08-23. Source: `src/application/goal-service.ts`,
> `src/application/loop-engine.ts`, `src/server/owner-tools.ts`,
> `src/server/plugin.ts`, live E2E run with 5 concurrent goals.

---

## 1. Current Build State (verified)

```
bun test      135 pass / 0 fail
bun typecheck clean
bun build     server.js 106KB + TUI
```

All 5 spawned goals report `complete` in engine state. Each has a unique worker
session. Git diff contains changes to: goal-service.ts, loop-engine.ts, plugin.ts,
state-store.test.ts, loop-engine.test.ts. No remaining `writeState()` in
goal-service/loop-engine/plugin — all converted to `mutateState()`.

---

## 2. THE CORE BUG YOU IDENTIFIED — confirmed

**Tools update the engine's goal state (and the dashboard reflects that), but do
NOT reliably reach the real OpenCode subagent session.**

There are TWO separate entities per goal:

```
ENTITY A: OpenCode subagent session       ENTITY B: loopd engine goal
─────────────────────────────             ─────────────────────────
  ses_fd2a5dd8...  (real LLM session)       state.json entry
  does the actual work                      status/phase/turnCount/runGeneration
  talks to provider via SDK                 reads/writes .opencode/loopd/*
  gets prompts via promptAsync              driven by session.idle events
```

The **only** bridge between them:

| Direction | Mechanism | Fragile point |
|-----------|-----------|---------------|
| Engine → Session | `continueTurn()` → `promptWorker()` → `client.session.promptAsync` | Gated by `workers.isIdle()`; skipped if lease valid |
| Session → Engine | tool calls (`complete_goal`, `block_goal`, `report_goal_progress`) | Works, verified |
| Session → Engine | `session.idle` / `session.status` events | **NOT reliable** — caused the overlap bug |

### Evidence of desync (from this session)

1. **`pause_goal`** sets `status=paused` in state.json + calls `abortSession`.
   Dashboard shows "PAUSED". But if the subagent session was already mid-turn,
   abort is best-effort — the real session may still be streaming.

2. **`resume_goal`** sets `status=active` then calls `continueTurn()`. But
   `continueTurn()` FIRST checks `workers.isIdle(workerSessionID)`:
   ```
   if (!(await workers.isIdle(session.workerSessionID))) return
   ```
   - If the subagent session is NOT idle (still busy, or status returns
     `unknown`), `continueTurn` returns silently. State says "ACTIVE" but NO
     prompt was ever injected. **This is the exact "resume doesn't actually
     resume" you observed.**
   - `sessionStatus()` returns `"unknown"` on missing data (my Phase 1 fix).
     With `unknown`, `isIdle()` is `false` → never continues.

3. **`send_goal_input`** writes to the goal inbox file only:
   ```
   await appendGoalInbox(directory, goal.id, "user", args.message)
   ```
   It does NOT trigger `continueTurn`. The message sits in the inbox until the
   ENGINE independently decides to continue. If the subagent is stuck/idle and
   no idle event fires, the message never reaches the worker. Dashboard says
   "Message delivered" — but the subagent never sees it.

4. **`read_goal_transcript`** reads the REAL session via `host.readMessages()`
   — this one DOES reach Entity A. So you can see the subagent's actual state
   while the dashboard (Entity B) disagrees. This is the observable symptom of
   the split.

5. **`resume` recreates a NEW worker session** on every resume:
   ```
   if (!session) {
     session = await workers.createWorker(goal)   // NEW session
     sessions.set(goalID, session)
     goal.workerSessionID = session.workerSessionID  // replaced
   }
   ```
   The OLD subagent session (with all its context/file changes) is orphaned.
   Progress is NOT carried over. This is BUG-002.

### Root cause

The engine drives continuation from `session.idle` events + maintenance polling.
It never tracks whether the subagent session ACTUALLY received the last prompt
(it records `activePromptMessageID` but doesn't verify delivery). Owner tools
operate on Entity B (state.json) and only *indirectly* affect Entity A via
`continueTurn` — which silently no-ops when the session isn't confirmed idle.

---

## 3. Original Fix — What's DONE vs PARTIAL

### DONE (verified working, tests pass)

| Phase | Item |
|-------|------|
| Phase 1 | Runtime fields: `runGeneration`, `activePromptMessageID`, `lastActivityAt`, `idleCandidateAt`, `activeToolCallIDs` |
| Phase 1 | Host-adapter: `promptWorker` returns `messageID`; `sessionStatus` returns `"unknown"` not fake `"idle"` |
| Phase 2 | Lock fix: `fs.open(lockPath, "wx")` exclusive creation (subagent) |
| Phase 3 | Turn accounting: `runCount` (monotonic) + `budgetTurnCount` + `freeRetryPending`; removed `turnCount` |
| Phase 4 | Verification attempts: `src/domain/verification.ts`, `goal.completion_rejected` event, persisted in runtime (subagent) |
| Phase 5 | Check execution with `cwd`; `checkCwd: "artifact"|"workspace"` |
| Phase 6 | Rejection enforcement: `maxEvaluatorRejections` (default 3) → immediate block |
| Phase 8 | Worker instructions: "HOST VERDICT: COMPLETION REJECTED" replaces "weak evidence" |
| Phase 9 | `get_goal` observability: runCount, budgetTurnCount, rejection count, lastRejectionDetails |
| Phase 1+2 | Two-stage idle + `mutateState` **merged correctly** (final state verified) |

### PARTIAL / NOT actually done

| Item | Status | Why |
|------|--------|-----|
| Activity tracking in plugin | Code present (`addToolCall`/`removeToolCall` in plugin.ts) | Verified grep count=3, but **no test asserts the hook fires** |
| `nudge_goal` / re-prompt tool (BUG-001) | **NOT implemented** | Owner tools still can't force a stuck worker to continue |
| Pause/resume session preservation (BUG-002) | **NOT fixed** | `resume` still creates a NEW session, orphaning context |
| Maintenance stale-state guard (BUG-004) | **NOT implemented** | No check for `activeRunID` set while phase=idle |
| `maxNoProgress` repair (Phase 7) | **NOT done** | `noProgressCount` never incremented in engine |

---

## 4. Bugs Found During This Session (`bugs/bugs-new.md` + new)

| Bug | Severity | Status |
|-----|----------|--------|
| **BUG-001** No tool to re-prompt a stuck worker | HIGH | OPEN — no `nudge_goal` |
| **BUG-002** Pause/resume orphane the subagent session | MEDIUM | OPEN — resume creates new session |
| **BUG-003** Stale `activeRunID` on idle | LOW | Partially fixed in `releaseLease`; engine paths need audit |
| **BUG-004** Maintenance misses stale-state goals | MEDIUM | OPEN |
| **BUG-005 (NEW)** Owner tools update Entity B only, never verify Entity A received the prompt | HIGH | ROOT CAUSE of all stuck-goal symptoms |
| **BUG-006 (NEW)** `continueTurn` silently no-ops on non-idle/unknown session — no error, no retry, no parent notification | HIGH | Makes desync invisible |

---

## 5. Recommended Fix (one coherent change, not more subagents)

1. **Track prompt delivery, not idle events**: after `promptWorker()`, record
   the returned `messageID`. Treat "message exists in session transcript" as
   the run-liveness signal, not `session.idle`.

2. **Make owner tools session-aware**:
   - `send_goal_input`: after writing inbox, call `continueTurn()` if session is
     idle OR `unknown` (attempt a prompt — worst case it's a no-op).
   - `pause_goal`: remember the workerSessionID; do NOT delete it from sessions
     map (only abort).
   - `resume_goal`: REUSE the existing workerSessionID if the session still
     exists (`host.sessionStatus` not error). Only create new if truly gone.

3. **Add `nudge_goal`** owner tool (BUG-001): clears stale state, forces
   `continueTurn` regardless of idle status (bypass the `isIdle` gate).

4. **Never silently no-op**: `continueTurn` should return a result
   `{ sent: boolean, reason?: string }`. Engine + owner tools log + surface it.
   No more "state says active but nothing happened."

5. **Dashboard**: show `lastPromptMessageID` + `lastContinueResult` so the UI
   reflects Entity A, not just Entity B.

---

## 6. The test-fix rabbit hole (context for the report)

During this session the 5 concurrent goals **stomped each other's work**:
- `two-stage-idle` and `convert-to-mutateState` both edited loop-engine.ts →
  `git stash` conflicts → one lost the other's changes.
- The `mutateState` rewrite initially broke 16 tests (subagent claimed "all
  pass" while 16 were red). I reverted loop-engine.ts, fixed the idle-debounce
  tests, then re-merged both features by hand. Final state: 135/135.

**Lesson**: never spawn multiple goals editing the same file concurrently, and
never trust a subagent's "all tests pass" claim without running `bun test`
yourself.