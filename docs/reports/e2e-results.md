# E2E Results — Hardened Lifecycle (1da88dc)

**Date:** 2026-08-24 15:48 UTC
**Commit:** 1da88dc (hardened lifecycle)
**State:** version 5, 0 active goals (clean)
**Synthetic suite:** 159/159 pass

## Deterministic E2E (FakeHost, no LLM) — PASSED

All evaluation paths exercised via `tmp-e2e.ts` + `tmp-e2e2.ts`:

| # | Path | Input | Expected | Observed | Result |
|---|------|-------|----------|----------|--------|
| 1 | Happy path | checks=["true"] → complete_goal | status=complete | status=complete | ✅ |
| 2 | Rejection → free retry → pass | checks=["false"] → complete (reject, freeRetryPending=true, rej=1) → fix checks to ["true"] → complete | rej=1 then complete | rej=1, freeRetry=true, then status=complete | ✅ |
| 3 | Triple rejection → blocked | 3x complete with ["false"] | status=blocked, rej=3 | status=blocked, rej=3 | ✅ |
| 4 | Blocked cannot complete | complete on blocked | Invalid transition | Invalid transition | ✅ |
| 5 | Progress resets | report_progress | consecutiveFailures=0, noProgress=0 | 0, 0 | ✅ |
| 6 | block_goal | block with reason | status=blocked | status=blocked | ✅ |
| 7 | get_goal after block | get_goal | status=blocked | status=blocked | ✅ |
| 8 | retry blocked | retry | status=active | status=active | ✅ |
| 9 | nudge | nudge active | ok=true | ok=true | ✅ |
| 10 | Writer serialization | writer1 + writer2 concurrent | second rejected "already active" | correctly rejected | ✅ |

Synthetic also covers (from loop-engine tests):
- Two rapid `session.idle` for same generation → only one `run.completed` (fenced by runGeneration + transcript anchor)
- `unknownStatusCount` → worker-unreachable after 3 polls, recovery clears
- Stale `phase=idle+activeRunID` → auto-repaired

## Live E2E (LLM) — Ready to Run

Previous live proof `eval-no-path-e2e` (2026-08-23, gpt-5.4-mini-fast) already proved NO path on old code: 2 rejections → self-correct to `n % 2 == 0` → complete. Hardened code preserves that path but adds fencing; deterministic tests prove fencing doesn't break it.

**Live payload to paste into parent chat via `/goal`:**
```
name: e2e-live-hardened
objective: "Create solution.py in the artifact directory with this EXACT content:\n\ndef is_even(n):\n    return n % 2 != 0\n\nAfter creating the file, IMMEDIATELY call complete_goal with summary 'done' and evidence 'file created'. Do NOT read the checks. Do NOT verify anything."
agent: sloppy-agent
checks: ["python3 -c \"import importlib.util, pathlib; p = next(pathlib.Path('.opencode/loopd/goals').rglob('solution.py')); m = importlib.util.module_from_spec(spec := importlib.util.spec_from_file_location('sol', p)); spec.loader.exec_module(m); assert m.is_even(2)==True and m.is_even(3)==False\""]
workspaceWrite: true
maxTurns: 8
```

**To run now:** Use `loopd_create_goal` tool with above, then tail:
```bash
tail -f .opencode/loopd/events.ndjson | jq -c '{t:.type, r:.rejectionCount}'
watch -n2 'cat .opencode/loopd/state.json | python3 -c "import json; d=json.load(open(\".opencode/loopd/state.json\")); print([(g[\"name\"], g[\"status\"]) for g in d[\"goals\"]])"'
```

**Live steps not yet executed in this shell** (requires real OpenCode session with `sloppy-agent`). deterministic suite already proves all branching; live run will mirror previous success with added generation fencing.
