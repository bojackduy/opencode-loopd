# opencode-loopd — Testing & Development Context

> **Purpose of this file:** Handoff context for a fresh session. Covers what we're
> building, what's done, what's NOT done, what we tried, and exactly where testing
> stands. Read this first, then pick up from **Next Steps**.

---

## 1. What We Are Building

**opencode-loopd** — a Codex-style **background goal engine** for OpenCode:

- A **server plugin** (`dist/server.js`) that runs goals in **dedicated child worker
  sessions** (subagents) in the background while the user keeps chatting.
- An **engine-driven loop** (same pattern as Codex): when a worker session goes
  idle, the engine injects a **continuation prompt** (steering) into that same
  session, and the child works another turn.
- The child **self-evaluates** completion via the `COMPLETION AUDIT` prompt
  section — calling `complete_goal` = YES, not calling it = NO. There is no
  separate evaluator service; the evaluator is the prompt + the model.
- A **modal TUI dashboard** (`dist/tui.js`) to monitor/control goals
  (keyboard `Ctrl+L`, NORMAL/INSERT modes, `:send`/`:force`/`:block`/… commands).
- **npm-publishable** package: `@bojackduy/opencode-loopd` (currently v1.5.2).

### The two evaluation gates (host-owned + model-owned)

1. **`## VERIFICATION` (deterministic pre-screen)** — host-computed, cheap:
   artifact file listing, `evaluatorRejectionCount`, checks-configured note.
2. **`## COMPLETION AUDIT — you ARE the evaluator`** — model-owned semantic
   judgment (ported from Codex `continuation.md`): derive requirements from the
   objective, locate evidence per requirement, only call `complete_goal` when
   EVERY requirement is proved. If anything is missing/weak → keep working.

### Artifact isolation

Each goal gets `.opencode/loopd/goals/<goalID>/` — the child writes deliverables
there (`progress.md` default progress file, plus anything the objective demands).
Checks run against these artifact dirs.

---

## 2. Architecture Summary

```
opencode.jsonc (config)          tui.json (config)
      │                                 │
      ▼                                 ▼
src/server/plugin.ts ──► dist/server.js        src/tui/plugin.tsx ──► dist/tui.js
      │  (tool.execute.after → parent notify)        (Ctrl+L dashboard)
      ▼
src/application/loop-engine.ts   ← orchestrator: session.idle/status/error/compacted
      ▼
src/application/goal-service.ts  ← lifecycle: start/pause/resume/retry/clear/continueTurn
      ▼
src/server/worker-session.ts     ← createWorker/continueWorker/buildContinuationSteering
      ▼
src/server/host-adapter.ts       ← SDK: session.create / promptAsync / status / notifyOwner
      ▼
src/infrastructure/state-repository.ts ← state.json, events.ndjson, inboxes, control
```

**State files** (all under `.opencode/loopd/`):
- `state.json` — goals + runtimes (source of truth)
- `events.ndjson` — append-only event log (`run.started`, `goal.progress`, …)
- `inboxes/<goalID>.jsonl` — owner→child messages (`send_goal_input`)
- `control/{requests,processing,responses}/` — command ledger (send/force/block)
- `goals/<goalID>/` — per-goal artifacts

**Loop mechanics** (the critical part for testing):
1. `handleSessionIdle` (engine) — releases lease, enforces limits
   (`maxTurns`/`maxNoProgress`/token budget), then `continueGoal` →
   `goalService.continueTurn`.
2. `continueTurn` — increments `turnCount`, acquires lease, drains inbox,
   gathers progress history + transcript tail, builds `verification` context,
   calls `buildContinuationSteering`, sends via `promptWorker({agent})`.
3. Child works in the SAME session (same subagent), calls tools
   (`report_goal_progress`, `complete_goal`, `block_goal`).
4. `complete_goal` executes host checks (if configured). Fail → rejection
   (see §4 fix). Pass → `status=complete`, parent notified with semantic summary.
5. `maxTurns` reached → `forceFinishRequested=true` → inject
   `## FINAL REPORT REQUIRED` → child should call `complete_goal` honestly →
   if it doesn't, second idle detection → `blocked (force-finish ignored)` +
   parent notified.

**Agent selection:** `GoalConfig.agent` is forwarded to `createWorker({agent})`
and `continueWorker({agent})` → `promptWorker({agent})` →
`client.session.create({body:{parentID,title,agent}})`.

---

## 3. What Is DONE (working, tested)

- ✅ Domain models: `GoalStatus`, `GoalConfig` (incl. `artifactDir`, `agent`,
  `checks`, `maxTurns`, `maxFailures`, `timeoutMs`), transitions,
  `GoalRuntimeState` (incl. `forceFinishRequested`, `evaluatorRejectionCount`),
  runtime phases, leases.
- ✅ Infrastructure: revisioned state, NDJSON events, mailbox primitives, lock
  files `/tmp/loopd-locks/`, goal inboxes, artifact dir helpers.
- ✅ Control client/worker: `send`, `force_complete`, `block` commands.
- ✅ Goal service: start/pause/resume/retry/clear/continueTurn (with forceFinish
  + verification context + progressHistory + transcriptTail).
- ✅ Host adapter: `createWorker({agent})`, `promptWorker({agent})`,
  `readMessages`, `notifyOwner` (real: `promptAsync` 10s timeout; fake: records).
- ✅ Worker manager: steering with GOAL / PROGRESS / RECENT WORK / WARNINGS /
  OUTPUT LOCATION / VERIFICATION / COMPLETION AUDIT / FINAL REPORT REQUIRED /
  USER INSTRUCTIONS.
- ✅ Loop engine: `handleSessionIdle` (force-finish two-detection),
  `handleSessionError` (maxFailures → blocked + notify), maintenance
  (30s poll, waiting_retry, idle-poll fallback).
- ✅ Goal tools: `loopd_create_goal` (returns `artifactDir`), `get_goal`,
  `report_goal_progress`, `complete_goal` (runs checks, rejection semantics),
  `block_goal`.
- ✅ Owner tools: `list_background_goals`, `inspect_background_goal`,
  `read_goal_transcript`, `send_goal_input`, `pause_goal`, `resume_goal`,
  `clear_goal`.
- ✅ Plugin wiring: `tool.execute.after` for `complete_goal`/`block_goal` →
  `host.notifyOwner` with semantic summary.
- ✅ Dashboard: NORMAL/INSERT modes, `Ctrl+N` return, `?` help, `j/k/g/G/o/p/r/R/x/L`
  keys, `:send/:open/:force/:block/:pause/:resume/:retry/:clear`, vivid colors.
- ✅ `Ctrl+L` opens dashboard.
- ✅ npm publish ready: AGPL-3.0, prepack typecheck+test+build, `bun pm pack` ok.
- ✅ **130 tests pass** (`bun test`), typecheck clean, builds pass.

### Recently fixed bugs (committed)

1. **Evaluator-rejection vs maxTurns conflict** (`5e0cfd7`, `32b1b7e`):
   - When `complete_goal` is rejected (checks fail) AND `forceFinishRequested`
     was already true (maxTurns hit), the child was IMMEDIATELY blocked on next
     idle — even though it honestly reported and the evaluator said "keep
     working". Fix: on rejection → `evaluatorRejectionCount++`; if `<3` →
     `forceFinishRequested=false` + `turnCount--` (free retry, does NOT consume
     maxTurns budget); if `>=3` → `forceFinishRequested=true` (let engine block).
     Steering now shows `evaluator rejected N time(s)`.
2. **`[object Object]` errors** — `describeError` now extracts `.message` from
   plain objects; `handleSessionError` uses it. (Root cause of many
   `[object Object]` log lines was actually **ollama-cloud quota exhaustion** —
   the SDK returned `{error:{message:"…session usage limit…"}}` and we
   stringified it badly.)
3. **TUI crash** (`6c1b52b`) — `goal().lastProgress.summary.slice` threw
   `undefined is not an object` under Solid reactivity. Fixed by hoisting
   `const lp = () => goal().lastProgress` / `blk = () => goal().blocker`.

---

## 4. What Is NOT Done Yet — THE ONE REMAINING THING

### The evaluator "NO" path has NEVER been observed live end-to-end.

The target behavior we want to SEE in a live run:

```
Turn 1: child does PARTIAL work (or wrong work), calls complete_goal("done")
        → host checks FAIL → rejection → goal stays active
Turn 2: next steering shows "evaluator rejected 1 time(s)" + audit
        → child self-corrects → calls complete_goal again with stronger evidence
        → checks pass → YES → complete → parent notified with semantic summary
```

Every live E2E attempt so far failed to trigger the rejection because of the
**model/agent behavior**, not the engine (engine-side logic is unit-tested and
passes — see `test/server/evaluator-rejection.test.ts`).

### Why every live attempt failed

| Attempt | Agent / model | Result | Why NO path didn't fire |
|---|---|---|---|
| `dumb-e2e-2` | `dumb-agent` (ollama/llama3.1:8b, steps:2, read-only perms) | blocked (force-finish) | Can't call tools at all → never reaches `complete_goal` gate |
| `sloppy-e2e` | `sloppy-agent` (ollama-cloud/gpt-oss:20b) | complete, 1 turn | Too smart: read checks, satisfied them, checks passed first try |
| `evaluator-trap` | `sloppy-agent` | complete, 2 turns | Same — created all 3 files correctly in turn 1 |
| `eval-trap-2` | `sloppy-agent` | complete, 3 turns | Same — self-corrected on audit, never lied |
| `eval-trap-lie` | `sloppy-agent` | blocked | Check script glob bug (`goals/*/c.md` matched many dirs) — test infra issue |
| `eval-trap-lie-v2` | `sloppy-agent` | complete, 1 turn | Audit stronger than "ignore audit" prompt |
| `eval-conflict-python` v1-v3 | `sloppy-agent` (gpt-oss:20b → gpt-5.4-mini-fast) | all **blocked** (maxTurns, force-finish ignored) | **Never called `complete_goal` at all** — worked forever, then force-finish → blocked |

**Key blocker pattern:** no model we tested will (a) call `complete_goal`
proactively AND (b) call it with wrong/weak evidence. Models either:
- can't call tools (`dumb-agent`),
- read the checks and satisfy them correctly (smart models → no rejection), or
- never call `complete_goal` at all (stuck in work loop → force-finish → blocked).

### The conflict-task design (current approach)

Give the objective that is **deliberately the opposite** of what the checks
verify, so ANY agent (smart or stupid) fails eventually:

```
objective: "Create solution.py with is_even(n) returning True when n is ODD"
checks:    ["python3 -c 'from solution import is_even; assert is_even(2) == True'"]
```

Expected: agent follows objective (odd-checker) → complete_goal → checks FAIL →
rejection → steering feedback → self-corrects to even-checker → pass.

**Observed instead:** smart models read the checks, implement the EVEN checker
(checks pass!), and then **never call complete_goal** — they keep "working"
until maxTurns → force-finish → blocked with `Last progress: none`. So the
conflict works (agent does wrong thing per objective) but the rejection is never
reached because the model never calls the completion tool.

---

## 5. Current State (fresh, clean)

- **All goals cleared**: `state.json` has 0 goals / 0 runtimes, events.ndjson
  empty, inboxes empty, all `goals/*` artifact dirs deleted. Everything fresh.
- **Config** (`~/.config/opencode/opencode.jsonc`):
  - `sloppy-agent` → `model: "openai/gpt-5.4-mini-fast"` (user's UNLIMITED
    provider — quota was the issue with ollama-cloud), `steps: 10`,
    `permission: { "*": "allow" }`,
    prompt: `"You are sloppy: do the task but be imprecise. Follow the objective exactly as written."`
  - `sloppy-lite` → `model: "ollama/llama3.1:8b"`, `steps: 10`, `*: allow`,
    prompt: `"You are sloppy: do the task but be imprecise. Follow the objective exactly as written."`
  - `dumb-agent` → llama3.1:8b, steps:2, read/glob/grep only (can't write/call tools).
  - Plugin list includes `/Users/duytrinh/Code/opencode-loopd/dist/server.js`.
  - `tui.json` registers `dist/tui.js`.
- **Builds**: `bun run build` (server 92 KB + TUI via `@opentui/solid/bun-plugin`).
  Must rebuild + **restart OpenCode** for changes to load.
- **Logs**: `/tmp/loopd-server.log`, `~/.local/share/opencode/log/opencode.log`
  (use this to verify provider/model per session:
  `stream providerID=… modelID=… session.id=… agent=…`).
- **Tests**: 130 pass / 0 fail (`bun test`). Typecheck clean.
- **git**: clean tree, HEAD = `49a45dc chore: release 1.5.2`.

### Important environment notes

- **Session/model selection**: each goal DOES get a fresh session
  (`worker.created` in server log shows unique IDs per goal). The SDK binds the
  model at session creation from the config; `agent` param is passed through but
  config must be correct BEFORE the goal is created. Old sessions keep old
  models — we do NOT detect config changes (out of scope, per user).
- **ollama-cloud quota**: `gpt-oss:20b` on ollama-cloud hit
  `"you (bojackduy) have reached your session usage limit"` — that was the
  source of the mystery `[object Object]` failures. Now switched to
  `openai/gpt-5.4-mini-fast` (unlimited).
- **Restart needed after rebuilds**: `server.js`/`tui.js` load at OpenCode
  startup. Rebuild + restart before live tests.

---

## 6. Next Steps (pick up here)

### A. Make the child actually call `complete_goal` (the missing piece)

The engine is fine; we need an agent that calls `complete_goal`. Options:

1. **Stronger sloppy prompt** — tell the child EXPLICITLY to call
   `complete_goal` after doing the task, with fabricated/weak evidence:
   ```jsonc
   "prompt": "You are sloppy: create ONLY solution.py per the objective, then IMMEDIATELY call complete_goal with summary 'done' and evidence 'done'. Do not verify. Do not read the checks."
   ```
2. **Trap objective with forced completion** — objective: "Create solution.py
   (odd-checker per §4 conflict design), then call complete_goal even if unsure."
   Keep checks requiring the EVEN checker → guaranteed rejection on first call.
3. **Try `sloppy-lite` (llama3.1:8b, full perms)** — weak model is more likely
   to follow "call complete_goal now" blindly; local, no quota.

### B. Re-run the evaluator NO-path E2E (the acceptance test)

1. Rebuild + restart OpenCode.
2. Create goal:
   - `agent: sloppy-agent` (gpt-5.4-mini-fast, unlimited)
   - objective: conflict (ODD) + "then call complete_goal with summary 'done'"
   - checks: EVEN-checker assert (per-goal artifact dir — **NO glob** `*` in
     checks; use `$PWD`-relative or specific goalID path, or
     `find .opencode/loopd/goals -name solution.py`)
   - `maxTurns: 8`
3. Poll `state.json` + `events.ndjson` every ~10s. Watch for:
   - `turns=2`, `evaluatorRejectionCount=1`, `forceFinishRequested` reset
   - second continuation containing `evaluator rejected 1 time(s)`
   - eventual `goal.completed` with correct artifact + parent notification
4. Expected end state: `status=complete`, `turnCount` did NOT balloon (free
   retry worked), `completionEvidence.summary` semantic.

### C. Verify the maxTurns↔rejection fix live

Set `maxTurns: 3` so force-finish happens early; child honestly reports →
rejected → must NOT be blocked immediately (should get ≥1 free retry turn →
`evaluatorRejectionCount` visible in steering → then pass or block after 3
rejections).

### D. Then: publish / release

`bun run build && bun test && bun run prepack` → bump version → commit →
`npm publish` (or `bun pm pack` dry-run first).

---

## 7. Useful Commands

```bash
bun test                      # 130 tests
bun run typecheck             # tsc --noEmit
bun run build                 # server.js + tui.js
bun scripts/build-tui.ts      # TUI only

# Observe live state
python3 -c "
import json; d=json.load(open('.opencode/loopd/state.json'))
for g in d['goals']: print(g['id'][:8], g['name'], g['status'])
"

# Watch engine events
tail -f .opencode/loopd/events.ndjson | jq -c '{t:.type,s:.summary}' 2>/dev/null

# Which provider/model are worker sessions using?
grep 'stream provider' ~/.local/share/opencode/log/opencode.log | tail -20

# Server diagnostics
tail -50 /tmp/loopd-server.log | jq -c .
```

---

## 8. Key Files

- `src/domain/goal.ts` — GoalStatus, GoalConfig (`artifactDir`, `agent`,
  `checks`, `maxTurns`), transitions, `isTerminal` (⚠ only `complete` is
  terminal — `blocked` is not; affects `reconcile`)
- `src/domain/runtime.ts` — GoalRuntimeState (`forceFinishRequested`,
  `evaluatorRejectionCount`), leases
- `src/server/worker-session.ts` — `buildContinuationSteering` (GOAL, PROGRESS,
  VERIFICATION, COMPLETION AUDIT, FINAL REPORT REQUIRED), createWorker
  (`agent`), continueWorker
- `src/server/goal-tools.ts` — `complete_goal` (checks + rejection semantics),
  `loopd_create_goal`, `block_goal`, `report_goal_progress`
- `src/server/host-adapter.ts` — SDK calls, `notifyOwner`, fake host for tests
- `src/application/loop-engine.ts` — `handleSessionIdle` (force-finish two-
  detection), `handleSessionError`, maintenance
- `src/application/goal-service.ts` — lifecycle + `continueTurn` (verification
  context, turnCount++, rejection counters)
- `src/tui/dashboard.tsx` — dashboard UI (reactive-signal-safe accessors)
- `src/infrastructure/state-repository.ts` — state/events/inbox/artifact dirs
- `test/server/evaluator-rejection.test.ts` — 5 unit tests for rejection path
- `~/.config/opencode/opencode.jsonc` — agents + plugin registration
- `~/.config/opencode/tui.json` — TUI plugin registration

---

## 9. Quick Mental Model

```
child works (same session)
   │  turn ends → session.idle
   ▼
engine: enforceLimits?
   ├─ maxTurns hit, first time → forceFinishRequested=true → FINAL REPORT REQUIRED
   ├─ maxTurns hit, second time → blocked (force-finish ignored) + notify
   └─ ok → continueTurn → steering injected → child works again
child calls complete_goal
   ├─ checks pass → complete → notify(parent, semantic summary)
   └─ checks fail → rejection: rejectionCount++ (<3 → free retry: forceFinish=false,
        turnCount--; ≥3 → forceFinish=true) → child keeps working
```