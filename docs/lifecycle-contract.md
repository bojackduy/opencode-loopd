# Lifecycle contract

Every promise loopd makes about a background goal is either enforced in code and
covered by a test, or it is not claimed. This document is the human-readable
half; `scripts/smoke-v2-lifecycle.ts` is the executable half.

## What a goal guarantees

1. **Separate worker.** A goal never runs in the owner session. It gets its own
   child session, so the owner stays responsive while the worker turns.
2. **Explicit completion.** A worker cannot mark itself complete on its say-so.
   `complete_goal` runs the configured `checks` under the same lock that guards
   writes. Failed checks return `completion_rejected` with the failing output
   and the worker continues.
3. **One owner notification.** The owner session is told once when a goal
   finishes, with the worker's summary and evidence.
4. **Ordered steering.** Owner input for a busy worker is queued, not raced
   against the in-flight turn. It is delivered on the next permitted turn.
5. **Manual means manual.** `interactive: true` never auto-continues. No idle
   recovery, no retries, no tick-forced turns. Every turn comes from
   `send_goal_input`, `nudge_goal`, `resume_goal`, or `retry`.
6. **Pause is durable.** Pause fences new writes, persists, and survives host
   restart. A paused goal stays paused after the process that created it dies.
7. **Clear is final.** Clear aborts the worker and removes goal, runtime, and
   ledger. A late turn from a cleared worker cannot resurrect it, and a
   subsequent `nudge_goal` with that ID fails as unknown.
8. **Scoped writes are exact.** Under `write_scope`/`claim_goal_scope` a
   structured write outside the claim is denied *before* execution, and a denied
   or failed call releases its reservation.

## The release gate

`bun run smoke:v2-lifecycle` starts a real `opencode serve` on loopback with:

- private `XDG_CONFIG_HOME` / `XDG_DATA_HOME` / `XDG_STATE_HOME` / `XDG_CACHE_HOME`
- a private OpenCode database, so no session or config of the developer's is read
- the built `dist/server.js` loaded as a real plugin
- a local OpenAI-compatible fixture model with no network or provider quota
- the tested host version pinned via `LOOPD_SMOKE_HOST_VERSION` (default `2.0.32`)

It then drives the plugin the way an agent would — over HTTP prompts and
`loopd_*` tools, through CodeMode — and asserts each guarantee above. It also
kills and respawns the host mid-goal to prove pause durability.

What it asserts, by name:

| Coverage | Asserts |
| --- | --- |
| `plugin-activation` | The plugin loads in a real host process |
| `CodeMode-create` | Goal creation works through `execute`/CodeMode, not just direct tools |
| `separate-worker` | The worker is a different session from the owner |
| `automatic-continuation` | The loop engine continues the worker without owner input |
| `reject-failed-check` | A premature `complete_goal` is rejected exactly once, with failing output |
| `native-write` | The worker writes through the host's native `write` tool |
| `host-checked-completion` | Completion is host-checked, not self-reported |
| `owner-notification` | Exactly one completion notification reaches the owner |
| `busy-native-steering` | Steering a busy worker queues instead of racing |
| `manual-no-auto-continue` | An interactive goal never turns on its own |
| `pause` / `restart-preserves-paused-goal` | Pause persists across a real host restart |
| `resume` | Resume restarts turns on the retained goal |
| `clear-during-execution` / `cleared-ID-nudge` | Clear during a live turn is final |
| `scoped-claim` / `out-of-scope-write-denied` / `owned-write` | Scope claims hold on a real host, and unclaimed writes are denied pre-execution |
| `failed-tool-fence-cleanup` | A rejected tool call releases its reservation |

The run writes `result.json` with the coverage list, and a `notCovered` list for
what it deliberately does not assert.

## Not covered

Stated plainly so the gate is not read as broader than it is:

- Real provider quota exhaustion and retry budgets. The fixture cannot spend
  money or hit rate limits.
- The interactive TUI. The gate drives tools and HTTP, not a terminal.
- Native child-bridge topology. The gate runs where the host falls back to a
  root worker; it asserts `workerTopology` in `result.json` rather than assuming.
- Power loss. The gate kills the host gracefully; it does not simulate a
  corrupted write or a torn transaction.
- Main-session behavior while a workspace reservation is held under lock
  contention.

These need their own suites. Until then, do not claim them.

## Running it

```bash
bun run build:server          # the gate loads dist/server.js
bun run smoke:v2-lifecycle    # real OpenCode v2 host, disposable state
```

To test a specific host build:

```bash
OPENCODE_V2_BIN=/path/to/opencode \
LOOPD_SMOKE_HOST_VERSION=2.0.32 \
bun run smoke:v2-lifecycle
```

CI runs this gate before `npm publish`, with `@opencode/cli` pinned to the tested
version. Failures upload the private artifact directory, including per-model-call
request dumps, so a red gate is diagnosable without reproducing it locally.

## Adding a guarantee

If you add a promise to the table above, add the assertion to
`scripts/smoke-v2-lifecycle.ts` in the same change. A promise that only exists in
the fixture is a promise nobody gets.
