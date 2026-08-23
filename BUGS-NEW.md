# New Bugs Found During Live Testing

## BUG-001: No way to re-prompt a stuck worker session

**Severity:** HIGH
**Discovered:** 2026-08-23 during E2E testing with 5 concurrent goals

**Problem:**
When a goal's worker session becomes idle but the engine doesn't pick it up (e.g., after pause/resume, stale activeRunID, or missed idle event), there is NO tool to manually re-prompt the worker.

Current owner tools:
- `list_background_goals` — read-only
- `inspect_background_goal` — read-only
- `read_goal_transcript` — read-only
- `send_goal_input` — sends message but does NOT trigger continuation
- `pause_goal` — sets state but doesn't stop the worker
- `resume_goal` — sets state but doesn't re-prompt the worker
- `clear_goal` — deletes the goal

**Missing tool:** `retry_goal_turn` or `nudge_goal` — should:
1. Verify the goal is active and worker is idle
2. Clear any stale state (activeRunID, idleCandidateAt)
3. Manually trigger `continueTurn` to re-prompt the worker

**Workaround (manual):**
```python
import json
path = '.opencode/loopd/state.json'
d = json.load(open(path))
for r in d.get('runtimes', []):
    if r['goalID'] == '<goal-id>':
        r['activeRunID'] = None
        r['idleCandidateAt'] = None
        r['phase'] = 'idle'
json.dump(d, open(path, 'w'), indent=2)
# Then restart OpenCode or wait for maintenance poll
```

**Fix:**
Add a new owner tool `nudge_goal` that:
1. Reads state
2. Finds the goal by ID
3. Clears stale runtime state
4. Calls `goalService.continueTurn(directory, goalID)`
5. Returns confirmation

**Files to modify:**
- `src/server/owner-tools.ts` — add `nudge_goal` tool
- `src/application/goal-service.ts` — ensure `continueTurn` works for idle goals

---

## BUG-002: Pause/resume doesn't persist worker session state

**Severity:** MEDIUM
**Discovered:** 2026-08-23

**Problem:**
When `pause_goal` is called, it sets `goal.status = "paused"` and calls `abortWorker`. But when `resume_goal` is called, it creates a NEW worker session and starts a new goal from scratch. The previous worker's context (file changes, progress) is lost.

**Expected behavior:**
- Pause should abort the worker but preserve the session ID
- Resume should re-prompt the existing worker session, not create a new one
- The worker should continue from where it left off

**Current code in goal-service.ts:**
```typescript
async function resume(directory, goalID) {
  // ... creates a NEW worker session
  session = await workers.createWorker(goal)
  sessions.set(goalID, session)
  goal.workerSessionID = session.workerSessionID
  // ... starts from scratch
  await continueTurn(directory, goalID)
}
```

**Fix:**
Resume should:
1. Check if the old worker session still exists (via `host.sessionStatus`)
2. If yes, re-use it and just send a continuation prompt
3. If no, create a new worker (current behavior)

---

## BUG-003: Active runID not cleared on idle

**Severity:** LOW
**Discovered:** 2026-08-23

**Problem:**
When a run completes and the session goes idle, `activeRunID` is sometimes not cleared. This confuses the engine into thinking a run is still active.

**Evidence:**
```
runtime: {
  phase: "idle",
  activeRunID: "388eb2e7-f5cb-4b23-ba86-1dcac14eaa36",  // stale!
  ...
}
```

**Fix:**
In `releaseLease()`, always clear `activeRunID`:
```typescript
export function releaseLease(rt: GoalRuntimeState): GoalRuntimeState {
  return {
    ...rt,
    phase: "idle",
    leaseExpiresAt: undefined,
    turnStartedAt: undefined,
    activeRunID: undefined,  // ← add this
    activePromptMessageID: undefined,
    activeToolCallIDs: [],
    updatedAt: new Date().toISOString(),
  }
}
```

Wait — this is already in the code. The issue must be that `releaseLease` isn't being called in all code paths. Check `handleSessionIdle` and `handleSessionError`.

---

## BUG-004: Engine maintenance doesn't detect idle goals with stale state

**Severity:** MEDIUM
**Discovered:** 2026-08-23

**Problem:**
The maintenance timer polls worker status every 30s. But if the runtime state is stale (e.g., `activeRunID` set but phase is idle), the maintenance doesn't pick it up.

Current maintenance code:
```typescript
if ((runtime.phase === "running" || runtime.phase === "idle") && goal.workerSessionID) {
  const status = await host.sessionStatus(goal.workerSessionID)
  if (status === "idle") {
    await handleSessionIdle(state, goal)
  }
}
```

This should work, but if `handleSessionIdle` fails (e.g., due to stale `activeRunID`), the goal gets stuck.

**Fix:**
Add a safety check in maintenance: if `runtime.phase === "idle"` and `runtime.activeRunID` is set, clear it before calling `handleSessionIdle`.
