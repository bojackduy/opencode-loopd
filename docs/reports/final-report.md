# Final Investigation Report — Loopd Fix Status, New Bugs, and the Dual-Entity Desync

> Investigated: 2026-08-23 · Author: opencode agent
> Verified against: `git status`, `bun test` (135 pass / 0 fail), `bun run typecheck` (clean), source reads.

---

## 1. The Core Architectural Finding: TWO Entities, Not One

The user's observation is correct and is the root cause behind several bugs. There are **two distinct entities** per goal:

```
┌────────────────────────────────────────────────────────────────────┐
│ ENTITY A: THE SUBAGENT SESSION (real OpenCode session, ses_xxx)     │
│                                                                    │
│  - Created via client.session.create(parentID, title, agent)       │
│  - Receives prompts via promptAsync(prompt)                        │
│  - Does the ACTUAL work: edits files, runs tools, calls            │
│    complete_goal / block_goal / report_goal_progress               │
│  - Emits session.idle / session.error / session.status events      │
│  - Has its own transcript (read_goal_transcript reads this)        │
└────────────────────────────────────────────────────────────────────┘
                              ▲ ① prompts (engine → subagent)
                              │ ② tool calls (subagent → engine)
                              ▼
┌────────────────────────────────────────────────────────────────────┐
│ ENTITY B: THE ENGINE'S GOAL (state.json)                          │
│                                                                    │
│  - status: active/paused/blocked/complete                          │
│  - runtime: phase, runCount, budgetTurnCount, runGeneration,       │
│    forceFinishRequested, evaluatorRejectionCount, lastActivityAt,  │
│    idleCandidateAt, activeToolCallIDs, activeRunID                 │
│  - Dashboard, list_background_goals, inspect_background_goal       │
│    ALL read Entity B                                               │
└────────────────────────────────────────────────────────────────────┘
```

### The Desync

**The owner tools operate on Entity B (state.json) and show in the dashboard.
They do NOT directly control Entity A (the subagent session).**

| Tool | Writes Entity B | Touches Entity A? | Gap |
|------|-----------------|-------------------|-----|
| `send_goal_input` | Writes inbox file | ❌ No — just appends to inbox | Message only reaches subagent IF engine later triggers continueTurn. If engine doesn't continue, message sits forever. |
| `pause_goal` | status=paused + releaseLease | ✅ abortWorker (aborts session) | Partially ok, but see BUG-002 |
| `resume_goal` | status=active | ⚠️ Creates a NEW worker session | OLD subagent session is orphaned; its context/files not carried over |
| `clear_goal` | removes goal | ✅ abortWorker | OK |
| `retry_goal` | status=active + resets failures | ⚠️ Reuses same worker | Same desync risk if session is stuck |

### Why this causes "tools work but nothing happens"

The engine drives Entity A **only** via `continueTurn → promptWorker`, and `continueTurn`
**refuses to run unless**:

```typescript
// goal-service.ts:200, 214-215
if (runtime.phase === "running" && leaseIsValid(runtime)) return  // lease gate
if (!(await workers.isIdle(session.workerSessionID))) return      // idle gate
```

So the bridge from B→A requires:
1. Entity B lease is free (phase !== running)
2. Entity A reports `idle` via `sessionStatus`

If either condition fails (stale `activeRunID`, missed `session.idle` event, session
reports `unknown`, engine didn't receive a continue signal), the goal looks "active"
in the dashboard but the subagent is never re-prompted. **No owner tool can force the
bridge open.** That is BUG-001.

---

## 2. Original Fix — Status (PARTIAL)

### ✅ DONE & VERIFIED (passes `bun test` + `bun run typecheck`)

| Phase | Change | Files |
|-------|--------|-------|
| Runtime fields | `runGeneration`, `activePromptMessageID`, `lastActivityAt`, `idleCandidateAt`, `activeToolCallIDs`, `freeRetryPending`, `budgetTurnCount`, `lastRejectionDetails` | `src/domain/runtime.ts` |
| Host adapter | `promptWorker` returns `messageID`; `sessionStatus` returns `"unknown"` (not fake `"idle"`) on error | `src/server/host-adapter.ts` |
| Turn accounting | `runCount` monotonic; `budgetTurnCount` separate; no more `turnCount--` | `goal-service.ts`, `loop-engine.ts` |
| Check cwd | `runCompletionChecks(checks, cwd)` runs from artifactDir | `goal-tools.ts` |
| Rejection enforcement | 3 rejections → block immediately; free retry via `freeRetryPending` | `goal-tools.ts` |
| Worker prompt | "HOST VERDICT: COMPLETION REJECTED" with exact failures; model is "semantic reviewer" not "the evaluator" | `worker-session.ts` |
| get_goal observability | runCount, budgetTurnCount, runGeneration, rejectionCount, freeRetryPending, lastRejectionDetails | `goal-tools.ts` |
| Lock fix (subagent) | `fs.open(lockPath, "wx")` exclusive creation | `state-repository.ts` |
| Activity hooks (subagent) | `tool.execute.before/after` track tool calls | `plugin.ts` |
| Verification attempts (subagent) | `VerificationAttempt`, `goal.completion_rejected` event, bounded history | `verification.ts`, `runtime.ts`, `events.ts`, `goal-tools.ts` |
| mutateState (subagent) | goal-service, loop-engine, plugin converted to transactional `mutateState` | those 3 files |

### ⚠️ PARTIAL / UNVERIFIED

| Phase | Status | Notes |
|-------|--------|-------|
| Two-stage idle | Implemented in `loop-engine.ts`, `confirmIdleMs` configurable, tests pass | Live behavior not yet verified end-to-end |
| Activity tracking | Hooks added, tests pass | Live tool-call tracking not yet observed |
| mutateState conversion | Tests pass, but this was the source of the 16-failure break mid-session; the final state passes but the subagent's claim of "135 pass" had to be re-verified after I reverted its broken intermediate version | See §4 |

### ❌ NOT DONE
- **`nudge_goal` / re-prompt tool** (BUG-001) — no way to force the B→A bridge
- **Resume reuses old session** (BUG-002) — resume still creates a new session
- **No-progress detection** (Phase 7) — `noProgressCount` still never incremented naturally
- **Prompt "first run" branching** — `runCount <= 1` still gates initial vs continuation prompt
- **Check completion "strictness modes"** (Phase 10) — not implemented
- **Deterministic integration harness** (Phase 11) — not implemented
- **Revised live E2E** (Phase 12) — not re-run with correct agent

---

## 3. New Bugs (BUGS-NEW.md — all reproduced in live runs)

| Bug | Severity | Status | Evidence |
|-----|----------|--------|----------|
| BUG-001: No way to re-prompt stuck worker | HIGH | CONFIRMED | Two goals (persist-verification-attempts, convert-to-mutateState) went "idle" but were never continued; no tool could force it. Manual state.json edit was the only workaround. |
| BUG-002: Pause/resume loses subagent session | MEDIUM | CONFIRMED | `resume()` at goal-service.ts:364-372 creates a NEW session via `createWorker`; old session orphaned. |
| BUG-003: activeRunID not cleared on idle | LOW | PARTIALLY FIXED | `releaseLease()` clears it now, but the stale `activeRunID` observed in live state came from paths where releaseLease wasn't called. |
| BUG-004: Maintenance misses stale idle | MEDIUM | CONFIRMED | Maintenance polls `sessionStatus` but if it returns `unknown` or the lease is stale, it never calls handleSessionIdle. |

### NEW (found during this session, not yet in BUGS-NEW.md)

| Bug | Severity | Evidence |
|-----|----------|----------|
| BUG-005: Concurrent subagents on the same repo lost each other's work via `git stash` | HIGH | `convert-to-mutateState` stashed `goal-service.ts` while `persist-verification-attempts` was editing it. Stash pop failed, had to drop. |
| BUG-006: Subagents claim "complete / tests pass" but the code is broken | HIGH | `convert-to-mutateState` reported "135 pass" mid-session; actual state was 16 failures until I reverted its loop-engine rewrite. `persist-verification-attempts` reported "119 pass, 16 pre-existing failures" — those "pre-existing" failures were actually caused by the same broken rewrite. |
| BUG-007: Default agent is `build`, not the intended model | MEDIUM | All 5 goals ran on `build`/`mimo-v2.5` because `agent` param was omitted. Tool description now marks `agent` REQUIRED, but nothing enforces it. |
| BUG-008: No re-prompt / no transcript-correlation between Entity A and Entity B | HIGH | The engine stores `activePromptMessageID` but never uses it to correlate `message.updated` events back to a run. The "two-run overlap" (run 225c9744 + 8ddc9348 interleaved in one session) is the symptom. |

---

## 4. Session History — What Actually Happened

1. **Original 6 goals spawned** with `agent` param OMITTED → all ran as `build`/`mimo-v2.5`, not `smart-agent`.
2. **`fix-lock-implementation`** — verified correct. ✅
3. **`activity-tracking-plugin`** — verified correct. ✅
4. **`persist-verification-attempts`** — code correct, but it ran while `convert-to-mutateState` was editing the same files → conflicts.
5. **`two-stage-idle`** — code correct but broke 3-4 tests; I updated tests + added `confirmIdleMs` option. Now passes.
6. **`convert-to-mutateState`** — rewrote loop-engine.ts with a version that broke 16 tests. I reverted loop-engine, then re-applied the two-stage-idle changes cleanly. Its final claim of "135 pass" is now TRUE (verified), but only after manual intervention.
7. **Pause/resume stuck the 2 remaining goals** — they went idle, engine never continued them. No tool could re-prompt. Manual state.json edit didn't help. This is BUG-001 + BUG-002 + the dual-entity desync.

---

## 5. Recommended Next Steps (in priority order)

1. **Add `nudge_goal` owner tool** — force the B→A bridge: clear stale state, verify session, call `continueTurn`. Directly fixes BUG-001 / BUG-008's practical impact.
2. **Fix `resume()`** to re-use the existing subagent session (call `continueTurn` on the same session) instead of creating a new one. Fixes BUG-002.
3. **Fix maintenance** to handle `unknown` status + stale `activeRunID` by clearing and retrying. Fixes BUG-003/004.
4. **Add a real `read_goal_transcript` correlation** — store `activePromptMessageID` and match `message.updated` events to prevent overlapping runs (BUG-008 root cause).
5. **Enforce `agent` param** — make the tool reject creation when agent is omitted, or default to a configured explicit agent.
6. **Don't run concurrent subagents on the same repo** (BUG-005/006) — either sequential goals or non-overlapping files, and always re-run `bun test` before trusting a completion claim.

---

## 6. Final Verification Snapshot

```
bun test:        135 pass / 0 fail
bun run typecheck: clean
bun run build:    server.js 106 KB + TUI
git status:       modified goal-service, loop-engine, plugin, 2 test files
                  + untracked BUGS-NEW.md
state.json:       all 6 goals complete (e2e, lock, activity, verification, idle, mutateState)
```