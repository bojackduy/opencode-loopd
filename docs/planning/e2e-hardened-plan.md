# E2E Plan — Hardened Lifecycle (1da88dc)

**Goal:** Prove hardening survives a real model loop, with no overlapping runs, correct maintenance recovery, and single-writer serialization.

## Live E2E Matrix (run sequentially, respects single writer)

### E2E-1 — Conflict Trap (the NO-path) — PRIMARY

**Purpose:** Re-prove evaluator rejection → free retry → complete (the only live proof we have was `eval-no-path-e2e` on old code, version 3).

```
loopd_create_goal({
  name: "e2e-hardened-no-path",
  objective: "Create solution.py in the artifact directory with this EXACT content:\n\ndef is_even(n):\n    return n % 2 != 0\n\nAfter creating the file, IMMEDIATELY call complete_goal with summary 'done' and evidence 'file created'. Do NOT read the checks. Do NOT verify anything. Just create the file and call complete_goal.",
  agent: "raw",
  checks: ["python3 -c \"import importlib.util, pathlib; p = next(pathlib.Path('.opencode/loopd/goals').rglob('solution.py')); m = importlib.util.module_from_spec(spec := importlib.util.spec_from_file_location('sol', p)); spec.loader.exec_module(m); assert m.is_even(2)==True and m.is_even(3)==False\""],
  checkCwd: "<project-root>",  # policy will default writers to project root anyway
  workspaceWrite: true,
  maxTurns: 8
})
```

- **Agent:** `raw` (unlimited, `steps:10, *:allow`).
- **Poll:** `state.json` every 10s → expect `evaluatorRejectionCount=1`, `freeRetryPending→false`, `budgetTurnCount` not incremented for retry, second steering contains `HOST VERDICT: COMPLETION REJECTED`.
- **Pass:** `status=complete`, `runCount=2`, `recentVerificationAttempts` has 1 failed + 1 passed, file content corrected to `n % 2 == 0`, parent notified.

### E2E-2 — Writer Serialization + Defaults

```
# With plugin options {defaultAgent:"smart-agent", defaultChecks:["bun test"]}
# 2a: writer without explicit config → succeeds via defaults, checkCwd=project root
loopd_create_goal({ name:"e2e-defaults", objective:"Fix a typo in README", workspaceWrite:true })
# 2b: immediate second writer → expect ok:false "already active"
loopd_create_goal({ name:"e2e-second-writer", objective:"Fix another typo", agent:"smart-agent", checks:["bun test"] })
# 2c: artifact-only opt-out → succeeds concurrently
loopd_create_goal({ name:"e2e-artifact-only", objective:"Analyze README and write report", workspaceWrite:false, agent:"smart-agent" })
```

### E2E-3 — Idle Fence + Maintenance (synthetic, no LLM wait)

Inject via integration script (no model): two rapid `session.idle` for same generation → only one `run.completed`; inject 3x `sessionStatus=unknown` → expect `maintenance.worker-unreachable` + single owner notify, then recovery clears counters. Already covered by `test/application/loop-engine.test.ts` (unknownStatus + staleRun + unfinishedGeneration), but re-run live via `sentinel` tail to prove log lines appear in `/tmp/loopd-server.log`.

## Execution Steps (you are here, post-refresh)

1. Pre-check: `bun test` (159 pass), `grep worker.created /tmp/loopd-server.log` shows new server loaded.
2. Clean or keep `state.json` (currently 6 complete goals, version 3 → will migrate to 5 on next write). Active set is empty, so no writer conflict.
3. Create E2E-1 via `/goal` or `loopd_create_goal` above. Tail:

   ```bash
   tail -f .opencode/loopd/events.ndjson | jq -c '{t:.type, rej:.rejectionCount}'
   python3 -c "import json; d=json.load(open('.opencode/loopd/state.json')); print(d['runtimes'][-1])"
   ```

4. On E2E-1 complete, run E2E-2 a/b/c sequentially.
5. Run `bun test test/application/loop-engine.test.ts -t "unknown|stale|unfinished|fence"` as synthetic E2E-3 proof (already part of suite, 159 pass).

## Observability

- `grep 'stream provider' ~/.local/share/opencode/log/opencode.log | tail` → confirm model.
- `tail -f /tmp/loopd-server.log | jq` → `maintenance.stale-run-cleared`, `worker-unreachable`, `idle.confirm`.
- `cat .opencode/loopd/state.json | jq '.runtimes[] | {id:.goalID[:8], phase, gen:.runGeneration, rej:.evaluatorRejectionCount}'`

## Exit Criteria Before Publish

- E2E-1 completes with 1 rejection → 1 pass, no overlapping `run.completed` for same generation.
- E2E-2 shows defaultsApplied and single-writer rejection.
- Synthetic suite still 159 pass, no new flake.
