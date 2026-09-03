# Remaining Work — Phase 1-2 & 4

> **Status:** Infrastructure changes completed (turn accounting, rejection enforcement,
> worker instructions, get_goal observability). All 135 tests pass, typecheck clean,
> build passes. These items are deferred for separate focused implementation.
>
> **Roadmap note (2026-09-03):** These items are retained as implementation
> history. [Trust-First Product Spec](./trust-first-product-spec.md) governs
> current priority where the documents differ.

---

## 1. Two-Stage Idle (Concurrency Fix)

**Priority:** CRITICAL — this is the root cause of overlapping worker runs
**Files:** `src/application/loop-engine.ts`, `src/domain/runtime.ts`
**Depends on:** Activity tracking (item 2)

### Problem

The current `handleSessionIdle` immediately continues the goal when it receives a
`session.idle` event. But the idle event is not correlated with the active run ID,
so a stale idle event from a still-running prompt triggers a second prompt.

```
Current (broken):
  session.idle → release lease → continueTurn → prompt #2
  (prompt #1 still running → two runs in same session)

Fixed:
  session.idle → record idleCandidateAt
  no activity for N ms → verify runGeneration matches → finalize
  finalize → release lease → continueTurn → prompt #2
```

### Implementation

1. In `handleSessionIdle`, instead of immediately finalizing:
   - If `runtime.idleCandidateAt` is undefined, set it to now and return.
   - If `runtime.idleCandidateAt` is set, check elapsed time (e.g., 2s debounce).
   - If debounce elapsed AND `runtime.lastActivityAt < runtime.idleCandidateAt`:
     - The run is truly idle → finalize.
   - If activity occurred after idle candidate, clear `idleCandidateAt` and return.

2. Add a `confirmIdleDurationMs` constant (default: 2000ms).

3. In `handleSessionStatus` for `idle` type: same two-stage logic.

4. In maintenance: same two-stage logic for poll-based idle detection.

5. On `session.error`: clear `idleCandidateAt` immediately.

### Test Cases

- Idle event followed by activity → no continuation
- Idle event + 2s debounce + no activity → continuation starts
- Stale idle from generation N cannot finalize generation N+1
- Error during debounce clears idle candidate

---

## 2. Activity Tracking in Plugin

**Priority:** HIGH — pairs with two-stage idle
**Files:** `src/server/plugin.ts`
**Depends on:** Runtime fields from item 1

### Problem

The plugin has no way to know when the worker is actively processing tool calls.
The `tool.execute.before` and `tool.execute.after` hooks are available but unused.

### Implementation

1. Add a new hook type for tracking worker activity:

```typescript
// In plugin.ts, add to the Hooks returned from server:
"tool.execute.before": async (input, output) => {
  // Track tool call start
  const state = await readState(directory)
  const goal = state.goals.find(g => g.workerSessionID === input.sessionID)
  if (!goal) return
  const runtime = state.runtimes.find(r => r.goalID === goal.id)
  if (!runtime) return
  Object.assign(runtime, addToolCall(runtime, input.callID))
  await writeState(directory, state)
},

"tool.execute.after": async (input, output) => {
  // Track tool call end
  const state = await readState(directory)
  const goal = state.goals.find(g => g.workerSessionID === input.sessionID)
  if (!goal) return
  const runtime = state.runtimes.find(r => r.goalID === goal.id)
  if (!runtime) return
  Object.assign(runtime, removeToolCall(runtime, input.callID))
  await writeState(directory, state)
},
```

2. Only track tools from worker sessions (not the main session).

3. Add a dedup/guard to avoid excessive state writes during rapid tool calls.

### Test Cases

- Tool call start → `activeToolCallIDs` contains callID
- Tool call end → `activeToolCallIDs` does not contain callID
- Main session tool calls are ignored
- Multiple concurrent tool calls tracked independently

---

## 3. Fix Lock Implementation

**Priority:** MEDIUM — correctness issue, race condition in lock acquisition
**Files:** `src/infrastructure/state-repository.ts`

### Problem

The current lock uses `rename(temp, lockPath)` which has a POSIX race:

```typescript
// Current (broken):
const temp = lockPath + `.${lockID}.tmp`
await fs.writeFile(temp, JSON.stringify(meta))
await fs.rename(temp, lockPath) // CAN REPLACE EXISTING LOCK
```

On POSIX, `rename()` replaces the target if it exists. This means two processes
can both "acquire" the same lock simultaneously.

### Implementation

1. Replace `rename()` with exclusive creation:

```typescript
async function acquireLock(directory: string, key: string, operation: string): Promise<void> {
  const lockPath = lockFile(directory, key)
  const lockID = randomUUID()

  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      // Try exclusive creation (fails if exists)
      const fd = await fs.open(lockPath, "wx")
      await fd.write(JSON.stringify({ pid: process.pid, operation, acquiredAt: new Date().toISOString() }))
      await fd.close()
      return
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error

      // Lock exists — check for stale
      try {
        const raw = await fs.readFile(lockPath, "utf8")
        const meta: LockMeta = JSON.parse(raw)
        const age = Date.now() - Date.parse(meta.acquiredAt)
        if (age > LOCK_STALE_MS) {
          await fs.rm(lockPath, { force: true })
          continue // retry
        }
      } catch {
        // Lock file unreadable — might be stale
        await fs.rm(lockPath, { force: true })
        continue
      }
    }
    await delay(25 * (attempt + 1))
  }
  throw new Error(`failed to acquire lock "${key}" after retries`)
}
```

2. Ensure release is idempotent:

```typescript
async function releaseLock(directory: string, key: string): Promise<void> {
  try {
    const raw = await fs.readFile(lockFile(directory, key), "utf8")
    const meta: LockMeta = JSON.parse(raw)
    if (meta.pid === process.pid) {
      await fs.rm(lockFile(directory, key), { force: true })
    }
  } catch {}
}
```

3. Add a test for concurrent lock acquisition.

### Test Cases

- Two processes cannot hold the same lock simultaneously
- Stale lock is reclaimed after LOCK_STALE_MS
- Release is idempotent
- Lock file contains correct metadata

---

## 4. Persist Verification Attempts

**Priority:** MEDIUM — data completeness, observable rejection history
**Files:** `src/domain/goal.ts`, `src/domain/runtime.ts`, `src/domain/events.ts`,
         `src/server/goal-tools.ts`, `src/infrastructure/state-repository.ts`

### Problem

When `complete_goal` is rejected, the failure details are returned in the tool
response but not persisted. They disappear on restart, are not visible in the
dashboard, and cannot be used for diagnostics.

### Implementation

1. Add a new domain model:

```typescript
// src/domain/verification.ts
export interface VerificationAttempt {
  id: string
  sequence: number
  runGeneration: number
  claimedSummary: string
  claimedEvidence: string
  startedAt: string
  completedAt?: string
  status: "running" | "passed" | "failed"
  cwd: string
  checks: Array<{
    command: string
    exitCode: number
    stdout?: string
    stderr?: string
    timedOut?: boolean
    durationMs?: number
  }>
}
```

2. Add to `GoalRuntimeState`:

```typescript
lastVerificationAttempt?: VerificationAttempt
recentVerificationAttempts?: VerificationAttempt[] // bounded to last 10
```

3. Add to `LoopEvent`:

```typescript
export interface GoalCompletionRejectedEvent extends BaseEvent {
  type: "goal.completion_rejected"
  attemptID: string
  rejectionCount: number
  failedCheckCount: number
  failureSummary: string
}
```

4. In `complete_goal` tool, before returning rejection:

```typescript
const attempt: VerificationAttempt = {
  id: randomUUID(),
  sequence: (runtime.evaluatorRejectionCount || 0) + 1,
  runGeneration: runtime.runGeneration,
  claimedSummary: args.summary,
  claimedEvidence: args.evidence,
  startedAt: new Date().toISOString(),
  completedAt: new Date().toISOString(),
  status: "failed",
  cwd,
  checks: checkResults.failures.map(f => ({
    command: f.command,
    exitCode: f.exitCode,
    stderr: f.stderr,
  })),
}

// Persist attempt
runtime.lastVerificationAttempt = attempt
if (!runtime.recentVerificationAttempts) runtime.recentVerificationAttempts = []
runtime.recentVerificationAttempts.push(attempt)
if (runtime.recentVerificationAttempts.length > 10) {
  runtime.recentVerificationAttempts = runtime.recentVerificationAttempts.slice(-10)
}

// Emit event
await appendEvent(dir, {
  version: 1,
  eventID: randomUUID(),
  goalID: goal.id,
  type: "goal.completion_rejected",
  attemptID: attempt.id,
  rejectionCount: runtime.evaluatorRejectionCount || 0,
  failedCheckCount: checkResults.failures.length,
  failureSummary: checkResults.failures.map(f => f.command).join("; "),
  timestamp: new Date().toISOString(),
  revision: state.revision,
} satisfies LoopEvent)
```

5. On successful completion, persist the passing attempt:

```typescript
const attempt: VerificationAttempt = {
  // ... same structure but status: "passed"
}
runtime.lastVerificationAttempt = attempt
// Add to recent attempts
```

6. Update state migration to handle the new fields.

7. Update `get_goal` to include verification attempts.

8. Update dashboard to show last verification attempt status.

### Test Cases

- Failed attempt is persisted with command details
- Passing attempt is persisted
- Recent attempts bounded to 10
- Attempt survives restart
- Event is emitted on rejection
- Dashboard shows verification history

---

## 5. Convert to Transactional State (mutateState)

**Priority:** MEDIUM — prevents state corruption from concurrent writes
**Files:** `src/application/goal-service.ts`, `src/application/loop-engine.ts`,
         `src/server/plugin.ts`, `src/infrastructure/state-repository.ts`

### Problem

The codebase has `mutateState()` (a transactional wrapper with locking) but
nothing uses it. All state mutations follow the unsafe pattern:

```typescript
const state = await readState(dir)
// ... modify state ...
await writeState(dir, state)
```

If two handlers run concurrently, one can overwrite the other's changes.

### Implementation

1. Convert every read-modify-write in `goal-service.ts`:

```typescript
// Before:
const state = await readState(directory)
const goal = state.goals.find(g => g.id === goalID)
goal.status = "complete"
await writeState(directory, state)

// After:
await mutateState(directory, `complete-goal:${goalID}`, async (state) => {
  const goal = state.goals.find(g => g.id === goalID)
  if (!goal) return state
  goal.status = "complete"
  return state
})
```

2. Convert in `loop-engine.ts`:

```typescript
// handleSessionIdle
await mutateState(directory, `idle:${goal.id}`, async (state) => {
  const runtime = state.runtimes.find(r => r.goalID === goal.id)
  if (!runtime) return state
  Object.assign(runtime, releaseLease(runtime))
  // ... etc
  return state
})
```

3. Convert in `plugin.ts`:

```typescript
// tool.execute.after for complete_goal/block_goal
await mutateState(directory, `notify:${goalID}`, async (state) => {
  const runtime = state.runtimes.find(r => r.goalID === goalID)
  if (runtime) markParentNotified(runtime, notifyType)
  return state
})
```

4. **Do NOT hold locks during external calls** (OpenCode API, shell exec).
   Use claim/finalize pattern:

```typescript
// Claim the attempt
await mutateState(dir, `claim-attempt:${goalID}`, async (state) => {
  const runtime = state.runtimes.find(r => r.goalID === goalID)
  runtime!.activeAttemptID = attemptID
  return state
})

// Run checks (outside lock)
const results = await runExecutionChecks(checks, cwd)

// Finalize results
await mutateState(dir, `finalize-attempt:${goalID}`, async (state) => {
  const runtime = state.runtimes.find(r => r.goalID === goalID)
  if (runtime!.activeAttemptID !== attemptID) return state // stale
  // ... apply results
  return state
})
```

5. Consider adding a `worker-state` lock key separate from `state` to avoid
   serializing tool executions across goals.

### Test Cases

- Concurrent completions cannot both succeed
- Pause during verification prevents stale completion
- State mutations are atomic
- No deadlocks between goal operations

---

## Implementation Order

```
1. Lock fix (item 3)
   └─ standalone, no dependencies
   └─ estimate: 1-2 hours

2. Activity tracking (item 2)
   └─ depends on runtime fields (already done)
   └─ estimate: 30 min

3. Two-stage idle (item 1)
   └─ depends on item 2
   └─ estimate: 2-3 hours

4. Persist verification attempts (item 4)
   └─ standalone
   └─ estimate: 2-3 hours

5. Convert to mutateState (item 5)
   └─ depends on items 1-4
   └─ estimate: 3-4 hours
```

**Total estimated effort:** 9-13 hours

---

## Quick Reference

### Runtime Fields (already implemented)
```typescript
runGeneration: number
activePromptMessageID?: string
lastActivityAt?: string
idleCandidateAt?: string
activeToolCallIDs?: string[]
budgetTurnCount: number
freeRetryPending?: boolean
lastRejectionDetails?: string
evaluatorRejectionCount?: number
```

### State Version
Current: `3` (migrated from v1/v2 with turnCount → budgetTurnCount)

### Test Count
135 passing (5 new activity tracking tests added)
