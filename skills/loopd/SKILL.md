---
name: loopd
description: "Agent skill for loopd: background AI goals (multi-turn autonomous workers with checks) AND standalone command sessions (raw interactive processes with a fullscreen terminal UI). Teaches which one to use, how to create/inspect/steer them, and the dashboard that shows both."
metadata:
  version: "1.3.0"
  status: active
  tags: [opencode, loop, goal, background, automation, command, terminal, pty]
---

# Loopd: Background Goals & Command Sessions

Loopd gives OpenCode two independent background primitives that share one dashboard:

| | **Goal** | **Command Session** |
|---|---|---|
| What it is | An autonomous AI worker looping turns | A raw OS process (no AI) |
| Use for | Multi-step AI work: implement, fix, research, write | Run/watch/type into one process: dev server, `test --watch`, REPL, log tail, build, script |
| Created with | `loopd_create_goal` | `loopd_command_start` |
| Finishes via | `complete_goal` after deterministic `checks` pass | Process exits, or `loopd_command_terminate` |
| Has | objective, checks, agent, model, budgets, turns | argv, cwd, stdin/stdout, exit code |
| Monitor in | `/loop` dashboard, **Goals** tab | `/loop` or `/commands`, **Commands** tab → `o` for fullscreen terminal |
| Link between them | — | optional `goal_id` (display only) + `loopd_command_await` (explicit wake) |

**Pick a Goal** when the user wants something *figured out or built* across many turns with a definition of done.
**Pick a Command Session** when the user wants to *run and watch/interact with a process* — no AI reasoning loop needed, just stdin/stdout.

## When to Use Loopd (Goals)

Use a goal when:

- A task takes many turns and would block the main chat
- You want autonomous AI work that continues while the user does other things
- A task needs progress tracking, completion checks, or blocking
- You want a dashboard to monitor and steer background work

Do not use a goal when:

- The task is trivial (1-3 turns)
- The user needs to answer questions at every step
- The task modifies production systems without review gates
- The user just wants to run/watch/type into a process — use a **Command Session** (below) instead; it has no agent overhead

## Goal Lifecycle

```
created → active → complete
                  → blocked (needs user intervention)
                  → budget_limited / usage_limited (engine limits)
         paused (user-initiated, can resume)
         retry (blocked → active, clears failures)
```

Only `active` goals own live worker runs. `blocked`/`paused`/`budget_limited` wait for an explicit owner transition (`resume`/`retry`/`nudge`). The loop is engine-driven, not parent-driven.

**Manual (`interactive`) mode:** pass `interactive: true` to `loopd_create_goal` (or `:interactive` on the dashboard) for tasks where the worker stops and waits for the next input — the engine then never starts turns on its own (no idle recovery, no retry-due turns). Every turn comes from explicit steering (`:send`, nudge, resume, retry). Budget enforcement still runs. Dashboard shows `✋ MANUAL`. Toggle back with `:interactive` to re-enable auto.

`abort_goal_worker` (TUI `A` / `abort_goal_worker` tool) aborts the worker *session only* — status stays the same, transcript remains browsable, the next active turn reuses the same session. Use it for compaction-spin or stuck runs that keep burning tokens without progress.

## Contract & Evaluation Semantics

Every goal has a **completion contract** at creation — the source of truth for completion. Model identity can be changed safely via owner tools without resetting that contract or its budgets:

* **Objective** — semantic requirements (free text, self-contained). The worker derives concrete requirements from it.
* **Checks** — deterministic shell commands that **must pass** for `complete_goal` to be accepted. For `workspaceWrite:true` goals they are **mandatory** (explicit `checks` or plugin `defaultChecks`), and they run from `checkCwd` (writers default to project root; artifact-only jobs run from their `artifactDir`).
* **Agent** — any OpenCode agent name: built-in (`build`, `plan`, `explore`, `general`), file `~/.config/opencode/agents/*.md`, or `opencode.jsonc` `agent.*`. Discover with `opencode agent list`. Prefer `subagent`-mode agents for workers; `primary`-mode agents work but may expect user interaction. Resolution: explicit arg → **calling session's live agent** (read at creation) → `defaultAgent` → OpenCode global default. So a parent in Plan spawns a Plan worker unless told otherwise. **Omit by default — inherit.** Do NOT pass `agent` unless the caller explicitly requests a different identity or the task needs it; explicit values freeze identity and break session upgrades.
* **Model** — any model as `"providerID/modelID"` (e.g. `openai/gpt-5.6-sol`, `ollama/qwen3.8:27b`, `openrouter/google/gemma-4-31b-it:free`). Discover with `opencode models [provider]`. Sent on every worker prompt. Resolution: explicit arg → **calling session's live model** → `defaultModel` → agent config → session history → global default. Caveat: OpenCode exposes no live-model field for history-derived models, so those fall through to agent config. **Omit by default — inherit.** Do NOT pass `model` unless explicitly requested.
* **WorkspaceWrite** — `true` (default) = may touch the shared repo; **only one active writer at a time** is allowed (enforced on `start`/`resume`/`retry` with rollback). Set `false` explicitly for artifact-only/read-only work to allow concurrency.
* **Budgets** — `tokenBudget` (tokens) and `costBudget` (dollars, e.g. `0.5`). When either is exceeded the engine aborts the worker mid-turn and sets `budget_limited`. The worker is stopped immediately, not just at the next turn boundary.
* **Limits** — `maxTurns` (default 50), `maxNoProgress`, `maxFailures`, `maxEvaluatorRejections` (default 3), `timeoutMs`, `compactEvery`, `progressFile`.

**Who decides completion:**
* **Host is the acceptance authority** — it runs `checks` deterministically. If any check fails, `complete_goal` is **rejected** (`ok:false`, `rejectionCount++`, `freeRetryPending=true` for <3 rejections, `blocked` after 3). The worker gets the exact failure in the next steering.
* **Model is the proposer** — it must self-audit via `## COMPLETION REVIEW` (derive requirements → locate evidence → judge `proves|contradicts|incomplete|missing`) and only call `complete_goal` when every requirement is proved. If objective and checks conflict, it must `block_goal`, not silently violate either.

**Hardened loop guarantees:**
* **Prompt correlation** — each turn’s prompt gets a `msg-` UUID (`activePromptMessageID`); the engine correlates `message.updated`/`message.part.updated` by that ID and by `runGeneration`. Stale events never release a newer lease. After an assistant message completes, trailing `part.updated` events no longer reset activity (they are rendering echoes, not work).
* **Generation fencing** — `idleCandidateAt` is tied to `idleCandidateGeneration`; a new prompt clears the candidate. Finalization also requires the transcript anchor: the latest user prompt must be the engine’s prompt **and** its assistant response must be completed — unless the event anchor (`activeAssistantCompletedAt`) already proved completion, which covers long turns whose prompt aged out of the tail window.
* **Idle-unconfirmed & stuck watchdogs** — `idle.confirm-failed` emits once per generation when a turn cannot confirm. If an idle-but-unconfirmable turn stays quiet for `idleUnconfirmedMs` (default 5m), the engine emits `run.stuck` and notifies once. If a `busy`/`retry` turn stays quiet past `stuckRunningMs` (default 10m) with an expired lease, it also notifies once. Both are notify-only; a separate auto-recovery path self-heals `running`-phase stalls on idle workers after `idleRecoverMs` (default 3m) by generation-fenced lease release and continuation (same as a manual `nudge`).
* **Maintenance (30s)** — continuously folds live worker usage (tokens/cost/time) into goal totals, enforces budgets mid-turn (abort + `budget_limited`), auto-repairs `phase=idle + activeRunID` (stale lease), bounds `unknown` status polls (`unknownStatusCount` threshold 3 → one `notifyOwner` per episode, `workerUnreachableNotifiedAt` deduped), and recovers counters on success. `active`-only polling; `blocked`/`paused` never auto-continue.
* **Per-goal mutex** — `withGoalOperation(goalID)` serializes `continueTurn`/`pause`/`resume`/`retry`/`clear`/`nudge`/`abortWorker`/`sendUserMessage` per goal, and `turn.acquire` re-checks `leaseIsValid` inside the transaction for exclusivity.
* **Lease** — `acquireLease`/`releaseLease` + `timeoutMs` (default 5 min); prompt failures release the lease and schedule `waiting_retry` with exponential backoff. Terminal-class prompt errors (context overflow, unknown model/agent, auth) block immediately and abort the session instead of retrying.
* **Interaction registry** — `src/domain/interaction-registry.ts` is the single source of truth. Every TUI key/slash and every agent tool for the same `LoopCommand` is defined once; `test/domain/parity.test.ts` fails CI if they drift.

## Creating a Goal

Use `loopd_create_goal` **after** clarifying the objective with the user (what / where / how to verify). The tool validates the contract before spawning:

```
loopd_create_goal({
  name: "short-name",
  objective: "Detailed description of what the goal should accomplish.",
  // agent/model: omit by default to inherit calling session — only pass when explicitly requested
  // agent: "researcher",
  // model: "openai/gpt-5.6-sol",
  costBudget: 0.5,                         // optional dollars; aborts worker when exceeded
  checks: ["npm test"],                    // mandatory if workspaceWrite:true (or configure defaultChecks)
  checkCwd: "/project/root",               // optional; writers default to project root, readers to artifactDir
  workspaceWrite: true,                    // default true; set false explicitly for artifact-only/read-only
  write_scope: ["src/a.ts"],               // optional; OMIT to let loopd infer it from file names in the objective
  progressFile: ".opencode/loopd/progress.md", // optional; defaults to <artifactDir>/progress.md
  maxTurns: 50,                            // optional; ≥50 enforces FINAL REPORT REQUIRED
  maxNoProgress: 5,                        // optional; auto-block without progress
  maxFailures: 3,                          // optional; auto-block on failures
  maxEvaluatorRejections: 3,               // optional; block after N check failures (default 3)
  compactEvery: 3,                         // optional; compact worker session every N turns
  timeoutMs: 300000,                       // optional; per-turn lease
})
```

Returns `ok:true` with `goalID`, `workerSessionID`, `artifactDir`, `agent`, `model`, `costBudget`, `checks`, `workspaceWrite`, `defaultsApplied:{agent,model,checks}`. On contract violation you get `ok:false` with `errorCode: "missing_agent"` or `"missing_checks"` or `"already active"` (writer serialization) or `"invalid_cost_budget"`.

**Scope is inferred by default.** On scoped hosts, when the objective names files and you do not pass `write_scope`/`workspaceWrite`, loopd sets `write_scope` to those exact paths. That is what lets independent goals run at once instead of serializing on the whole workspace. Pass `write_scope` explicitly when the objective is vague or the real file set differs from the names in the objective, and `workspaceWrite:false` for artifact-only work (which never contends at all).

The goal starts immediately. The user can monitor it via `/loop` (<leader>o). Plugin options `defaultAgent` / `defaultModel` / `defaultChecks` in `opencode.jsonc` can supply defaults so callers don’t have to repeat them.

## Owner Agent: Discover Models and Recover the Same Goal

### Agent listing and same-goal switching

`loopd_list_models({})` also returns `agents` (public name, description, mode: `primary`, `subagent`, or OpenCode's `all`) and independent `agentCatalog` capability/source/switching metadata. `assignedGoals` includes this owner's assigned agents and `agentSwitch` pending/last/failure state. Missing v1 `client.agent.list` reports an empty inventory with capability `unsupported`; failed discovery reports `unavailable`. Neither permits an unvalidated switch.

```text
loopd_list_models({})
switch_goal_identity({goal_id:"existing-goal", agent:"researcher"})
# Only when explicitly resuming a blocked goal:
switch_goal_identity({goal_id:"existing-goal", agent:"researcher", resume:true})
```

Agent switching is owner-only and validates the exact available name. It retains goal ID, worker session, transcript, progress, inbox, checks, budgets, counters, interactive mode and topology. Busy/unknown workers queue a persisted request until the next permitted confirmed-idle turn. v2 switches the idle session via `session.switchAgent`; v1 uses that SDK API if present, otherwise reports `deferred` and sends the assignment on the next prompt. Switching alone never wakes an interactive goal, unpauses or resumes. `resume:true` is valid only for blocked goals; if still busy, it remains deferred and blocked until an explicit retry/resume when safe. Completed goals cannot switch. Pending failures block once without creating a replacement worker.

On the dashboard **Goals tab**, `:agents` lists names/modes and `:agent <name>` changes the selected goal's agent. Both are refused on the Commands tab (never forwarded as process stdin). Goal rows display `🤖 agent-name` alongside the model.

Use agent tools, not a new goal or a human dashboard action, to change a worker's provider/model:

1. `loopd_list_models({})` returns public provider/model IDs, names, usable/connected status, context/output limits, host switching capability, and identities of **this owner session's** goals.
2. `inspect_background_goal({goal_id, includeTranscript:false})` shows assigned model, `modelSwitch` (pending/last/failure), `modelFallback` (attempted/status), and `lastProviderLimit` (local observation source/time/model/status/retryAt).
3. Select a positively usable catalog model and call `switch_goal_identity({goal_id, model:"provider/model"})`. Keep the existing goal ID and worker session. **Never spawn a duplicate goal to switch providers.**

**Quota caveat:** the inspected v1/v2 host catalogs do not expose remaining provider quota or reset times. Results explicitly say `quota.status:"unknown"` and `quota.capability:"unsupported"`, with source and observation time. Connected/enabled credentials do **not** establish balance. `lastProviderLimit` is an observed 429/quota failure, not live balance data; `retryAt` is derived only from a supplied Retry-After value, not a fabricated quota reset. Request headers, auth tokens, keys, and raw provider records are not returned. Older/missing host APIs report unsupported; failed catalog requests report unavailable and cannot validate switches.

### Manual recovery through tools

```text
loopd_list_models({})
inspect_background_goal({goal_id:"existing-goal", includeTranscript:false})
switch_goal_identity({goal_id:"existing-goal", model:"connected-provider/usable-model"})
# If and only if the goal is blocked by a provider quota/rate limit:
switch_goal_identity({goal_id:"existing-goal", model:"connected-provider/usable-model", resume:true})
```

Switch results distinguish `applied`, `deferred`, and `unsupported`. Busy/retrying/unconfirmable workers defer until a confirmed-idle continuation; there is no implicit abort. v1 supports explicit model identity on the **next prompt** (reported deferred); v2 supports an idle-session model switch. Future prompts and compaction use the switched assignment. Default switching does not unpause, resume, or wake interactive goals. `resume:true` explicitly starts a permitted turn only for a provider-limit-blocked goal, never paused, budget-limited, or unrelated-blocked goals. If the worker is still busy, the switch remains deferred and resume must be requested again when safe. Budgets, failure/rejection counters, checks, progress, inbox, topology, transcript, and session ID are preserved.

### Combined identity switching

`switch_goal_identity` replaces the separate model/agent tools. Provide at least one of `model` or `agent`; omitted fields stay unchanged. To change both together:

```text
switch_goal_identity({goal_id:"existing-goal", model:"connected-provider/usable-model", agent:"researcher"})
```

Combined switches validate both catalogs before touching the host, serialize with all goal operations, and persist both assignments in one state mutation. If the second host change fails, the first is rolled back, including next-prompt assignments. If the host itself rejects rollback, the operation reports failure: inspect the existing live session before retrying; do not create a replacement. Hosts cannot expose a single atomic two-field API, so live host changes are sequential under the goal lock, with no intervening worker prompt. Busy workers persist the pair as `pendingIdentity` and apply it together at the next permitted idle turn. Discovery exposes `assignedGoals[].pendingIdentity`. A later single-field request updates that field of the pending pair. Combined `resume:true` is explicit and valid only for blocked goals; model-only resume retains the provider-limit requirement. No switch resets budgets or failure counters, replaces a worker, or implicitly wakes an interactive goal. Dashboard `:model` and `:agent` both dispatch the unified bus operation.

### Opt-in ordered fallback

```text
loopd_create_goal({
  name:"research", objective:"Research and verify the report", workspaceWrite:false,
  fallbackModels:["provider-b/usable-model", "provider-c/usable-model"],
  interactive:true
})
```

First discover and validate the desired alternatives. `fallbackModels` defaults empty; at most 16 entries, deduplicated in order. No arbitrary paid/provider switch is made. Only positively classified provider quota/rate-limit failures prepare an alternative; network/authentication/context errors, loop turn/cost limits, and user pauses do not. Each configured alternative is considered once across restarts, avoiding depleted-provider cycles. Unsupported/unavailable/exhausted fallback status is visible in inspection. Normal active goals apply a prepared alternative on the next permitted retry; blocked goals still require explicit retry/resume. Interactive goals may record/prepare fallback but **never automatically start another turn**: the owner must send input, nudge, retry, or explicitly resume. A rejected pending switch blocks safely rather than endlessly retrying or creating a replacement worker; inspect, select a usable model, switch, and retry the same goal.

## Worker Tools (Running Inside the Goal)

These tools are available to the worker session doing the actual work:

### get_goal

Call at the start of every turn to read the objective, config, and current state. Always call this first.

File writes must come from the worker session itself — never from a nested subagent (it runs under its own session ID, which the fence does not recognize, so every write fails closed). Steer subagents toward read-only recon; do the edits yourself.

### report_goal_progress

Call after durable state changes (file writes, verifications). Resets failure and no-progress counters.

```
report_goal_progress({
  summary: "What was accomplished this turn.",
  next: "The next concrete step.",
  evidence: "Optional proof (file path, test output, etc.)."
})
```

### complete_goal

Call only when ALL acceptance criteria pass with concrete evidence. Runs configured completion checks before accepting.

```
complete_goal({
  summary: "What was completed.",
  evidence: "Concrete evidence (test output, file existence, etc.)."
})
```

### block_goal

Call only for a real external blocker requiring user intervention (e.g., missing credentials, ambiguous requirements).

```
block_goal({
  reason: "Why the goal is blocked.",
  needed: "What is needed to unblock."
})
```

### Approved Commands and Managed Servers

Workers cannot use arbitrary shell. Owners can grant **named, immutable commands** at goal creation (`approvedCommands`). Authority is persisted on the goal and re-read on every call; it is never inferred from objective text.

```ts
// Owner: grant authority once, at creation (all fields are fixed forever).
loopd_create_goal({
  name: "web",
  objective: "keep the dev server healthy and fix build failures",
  config: {
    workspaceWrite: true,
    write_scope: ["src/web/**"],
    approvedCommands: [
      { name: "test", command: "bun", args: ["test"], cwd: ".", kind: "finite", timeoutSeconds: 180 },
      { name: "dev", command: "bun", args: ["run", "dev"], cwd: "web", kind: "server" },
    ],
  },
})

// Worker: finite command by NAME only (executable/args/cwd/env/shell are rejected).
run_approved_command({ name: "test" })
// → { ok, exitCode, stdout, stderr, timedOut, durationMs, cwd, command, args }

// Worker: managed server by NAME only.
start_approved_server({ name: "dev" })
// → { ok, commandID, status: "running", live, pid, command, args, cwd, output }
read_approved_server({ name: "dev" })
// → status/liveness/pid/exitCode + output tail
stop_approved_server({ name: "dev" })
// → stopped only after the real process exit is proved
```

Rules and limitations:

- **Mid-goal grants.** A goal created without the commands it needs is not doomed: the owner calls `grant_approved_command({ goal_id, name, command, args, cwd, kind, timeoutSeconds? })` (same strict validation as creation, owner-only, active goals only). The worker picks it up on its next turn. Append-only: no revoke, no overwrite; clearing the goal removes everything.
- **Owner workaround.** Owners may run ordinary shell/tools themselves while their worker is idle (no live calls): the fence only blocks *concurrent* sessions. If the worker is stuck waiting on a command, run it in the owner session and tell the worker the result via `send_goal_input`.
- **Scope too narrow is fixable by the worker.** `write_scope` that omits needed files is not fatal: the worker claims more paths mid-run with `claim_goal_scope` (same turn, no owner needed) instead of blocking.

- **Name-only surface.** `run_approved_command`, `start_approved_server`, `read_approved_server` and `stop_approved_server` accept only `name`. Any `command`, `args`, `cwd`, `env`, `shell`, `kind` or `timeoutSeconds` key is refused with `override_denied`. `run_approved_command` refuses `kind: "server"` specs (and vice versa) with `kind_mismatch`.
- **Finite commands hold the workspace lock.** `run_approved_command` runs `executable + args` without a shell under the workspace-wide operation lock; concurrent source writes, checks and other approved commands are denied until the actual process exits. Output is bounded; the result carries the real exit code, duration and timeout outcome.
- **Not a filesystem sandbox.** These are owner-trusted executables. The lock is coordination, not isolation: a command can write anything its OS user can write.
- **Managed servers are not lock-held.** A dev server must keep running while the worker edits, so only finite commands take the operation lock. Servers are refused while a workspace operation *is* active.
- **Atomic duplicate prevention.** One managed server per `goal + name`. A second start returns `duplicate_server` with the live `command_id`; a fire-and-forget retry can never spawn a twin.
- **Lifecycle ownership.** Managed servers are cleaned up when their goal pauses, blocks, completes, is cleared, aborts, or when the worker rotates/generation changes. Cleanup stops the process and releases the linkage only after a proved exit; it never relies on tool return, log deletion or age. Ordinary standalone commands keep their display-only `goalID` linkage and are never touched by goal lifecycle.
- **Fail closed on lost handles.** After a host restart, or when a handle disappears, start/stop/read return `recovery_required` or `stop_unproven` and keep the linkage until exit is proved. Verify/terminate the PID externally, then retry.

### Main session vs worker authority

Protected (scoped or read-only) goals fence the workspace for their **workers**, not for the session that owns them.

- **Owner/main sessions keep ordinary tools.** The session persisted as `ownerSessionID` of a goal, and a session the host proves is a root session (no parent), may run `shell`/`bash`, custom tools, `task`/`batch`, and `loopd_command_start` while protected goals exist. No read-only parsing of the command is attempted; ownership is the authority.
- **Coordination, not silence.** An owner uncontrolled call takes a workspace-wide reservation (`uncontrolled: true`, no path claim). While it is live, worker structured writes, `run_goal_checks`, approved finite commands and protected-goal activation are refused with a `Workspace busy` message naming the call and session. A second owner call from the *same* session is allowed (parallel diagnostics); a different live session's call is not.
- **Verification wins.** An owner shell is refused while completion checks hold the operation lock, and checks are refused while an owner shell reservation is live. Wait for the reported event; do not poll.
- **Commands retain lifetime fences.** Running commands and lost processes without exit proof block protected workspace writes, new shell calls, and checks. `goalID` remains display-only. Command input and stop controls remain available so the owner can finish or stop the process.
- **Parking does not prove exit.** Paused, blocked, completed, or cleared goals retain unfinished tool reservations. An after-hook or matching terminal execution evidence releases them; goal status and elapsed time do not. Dormant goals without unfinished calls do not block owner diagnostics. Use the existing recovery controls for missed hooks rather than discarding execution fences.
- **Workers stay fenced.** A session that is the current worker of a goal keeps scoped authority even if it also owns other goals; retired workers, unknown child sessions, and host-unproven sessions remain denied (fail-closed). Subagent sessions are not owners.
- **Limit.** Identity is read from persisted goals plus the host's session projection; a host without parentage support (`isMainSession` unproven) cannot admit a main session that has no goal record at all. That session gets the normal scope denial.
- **Readiness is owner-defined.** The tools never sleep or poll. `start_approved_server` returns the persisted `running` status plus the output snapshot; use `read_approved_server` to observe the owner's readiness lines, and treat an exited status as an honest early failure with its exit code.

### Worker questions vs owner steering

| Tool | Who calls it | Direction | Turns | When to use |
|------|-------------|-----------|-------|-------------|
| `question` (OpenCode builtin) | Worker (inside goal) | Worker → User | — | Worker needs info only the user can provide. Question appears in the TUI footer as a blocker tab. |
| `send_goal_input` | Owner (parent chat) | User → Worker | **Bare, immediate** | Owner sends short words as their own turn — no steering wrapper, delivered now if active, queued if paused/blocked. For lightweight redirects. |
| `nudge_goal` | Owner (parent chat) | User → Worker | **Full steering** | Owner forces a re-prompt with the full continuation prompt (contract + progress + verification). Use when the worker is stuck but healthy. |

**Two prompt kinds:** engine/nudge turns carry full steering (contract, history, verification); `:send` / `send_goal_input` turns carry *only* your words. Short directives therefore fit small-context models where a 100k steering bundle would overflow.

## Owner Tools (Parent Chat)

All are filtered by `ownerSessionID` (only the session that created the goal sees it). They are the **parity surface** for TUI — every TUI action has an equivalent tool here, enforced by the interaction registry.

### list_background_goals

Lists all `active` goals owned by this session (name, status, phase, turn, last progress, blocker).

### inspect_background_goal

Shows detailed contract + runtime: `objective`, `config{agent,model,checks,checkCwd,workspaceWrite,limits,artifactDir,costBudget}`, `lastProgress`, `completionEvidence`, `blocker`, `runtime{phase,runCount,budgetTurnCount,runGeneration,evaluatorRejectionCount,lastActivityAt,activePromptMessageID,unknownStatusCount,workerAbortedAt}`. Plus live `transcriptTail`, `activeToolCallIDs`, `progressHistory`, `artifactSummary`, `pendingInbox`.

### read_goal_transcript

Reads the last N messages from the worker session (`role`, `content`, `timestamp`, `messageID`). Use to see if the worker’s steering contained `HOST VERDICT`.

### send_goal_input

Sends bare words as their own turn (no steering wrapper). Delivers immediately if the goal is active, otherwise queues for the next active turn.

```
send_goal_input({ goal_id: "…", message: "use X, not Y" })
```

### nudge_goal

Force re-prompts a stuck active worker with **full steering** even if `sessionStatus` is not `idle`. Clears stale `activeRunID`/`idleCandidateAt`/`activePromptMessageID`/lease, sets `phase=idle`, and calls `continueTurn({force:true})`. Use when the worker is `running` with no activity or the dashboard shows a stuck/worker-aborted state. Returns `{ok, message}`.

### abort_goal_worker

Abort the worker *session only* (`A` / `:abort` in TUI). Keeps goal+transcript+session browsable, clears the run lease. Use for compaction-spin or stuck runs that keep burning tokens without progress. Status unchanged; active goals resume next turn in the same session.

### pause_goal / resume_goal / retry / clear

* `pause_goal` — `active → paused`, `releaseLease`, `abortWorker`. Frees the writer slot.
* `resume_goal` — `paused → active`, reuses the existing worker session if `sessionStatus` is still `idle`/`busy` (preserves transcript), otherwise creates a new one. Fails with `already active` if another writer is active.
* `retry` (via `resume` on `blocked`) — `blocked → active`, resets `consecutiveFailures`/`forceFinishRequested`.
* `clear_goal` — aborts worker and removes `goal` + `runtime` + ledger entry (cannot be undone).

### loopd_release_workspace

The escape hatch for a **stuck write fence** — the state where every write, check and goal start fails with `Workspace is busy…`. Call it with no arguments to list every live reservation (`callID`, session, goal, paths, whether it is `releasable`), then call again with `call_id` (or `goal_id`/`session_id`) to release.

It is deliberately narrow:

* A reservation is releasable when you own its goal, **your own session made it**, or its goal no longer exists (nobody could ever free those). Anything else is refused by name. The own-session case is the common shape of a leak: the writing session *is* the chat session, so there is no goal to match through.
* Refused while the owning session is still the live worker of a non-terminal goal — that write may genuinely be in flight.
* Refused while a workspace operation is mid-flight.

Automatic self-heal covers the rest: a goal-owned reservation whose owning session the host positively cannot resolve (404 / never seen) is released on the next reconcile. Goal deletion alone is *not* proof the write finished, and an unproven probe (timeout, auth error) never releases. Goal-less owner reservations are never auto-released, however old — a nine-day owner build looks identical to a leak.

From the `/loop` dashboard a human has the same escape hatch without an agent: the header shows the live fence count, `W` releases the selected goal's reservations, and `:release` inspects with no arguments or releases with `--call <id>`, `--goal <id>` or `--session <id>`. The concrete result or refusal appears in the status line, then the dashboard refreshes. These go through the same `goalService` path and every refusal rule above still applies; `:release` on the Commands tab is not a goal verb.

### force_complete_goal / force_block_goal

Owner-side equivalents of TUI `:force` / `:block`. Bypass checks — use only when you have verified manually that the artifact is correct or that the blocker is real.

### Diagnostics (global flow trace)

Every step appends JSONL to `/tmp/loopd-server.log` (one line per event, `tail -f` it live). Agent tool calls: `tool.call.started` → `tool.call.finished` (or `tool.call.denied` with the reason — this is where scope denials land). Spawning: `worker.created` / `worker.prompted` (failures: `worker.create.failed`, `worker.prompt.failed`). Commands: `command.started` / `command.terminated` / `command.killed`, plus `command.dispose.preserved`, `command.reconcile.adopted`, `command.reconcile.missing` across host reloads. Args are summarized as keys + sizes, never values — no prompt text or secrets in the log.

## Command Sessions (Standalone Interactive Processes)

A **command session** is a raw OS process (spawned via `bun-pty`, falling back to a plain pipe) — no agent, no turns, no checks. It is completely independent from goals: starting/stopping one never pauses, blocks, or completes any goal, and vice versa. Use it whenever the request is "run X and let me watch/type into it" rather than "figure out/build X". By default, natural exits (including code 0), timeouts, and missing processes notify the owner; manual termination stays silent. Notification tails are sanitized for chat, while the retained terminal log remains raw. A finished command can still be opened to read its saved output; Ctrl+C/input cannot affect it.

Typical uses: dev servers (`npm run dev`), watch mode (`npm test -- --watch`), REPLs (`python3`, `node`), log tails (`tail -f`), one-off scripts, interactive shells.

### Prefer commands over the built-in shell

**Rule: if it might take a while or never return, start it as a command — never run it in the built-in shell/bash tool.** The built-in shell blocks your entire turn until the process exits: a 5-minute `npm install` freezes you mid-turn (and can hit tool timeouts, losing the output). `loopd_command_start` returns immediately with a `command_id` and pushes you on exit or pattern match, so you stay responsive.

Use a command (not the built-in shell) for: installs (`npm/pip/brew/cargo install`, downloads), builds, full test suites, migrations, dev servers, watchers, log tails, REPLs, anything interactive, or anything whose duration you can't guarantee is seconds. The built-in shell is only for quick one-shots (`ls`, `git status`, a single fast test).

```
User: install the dependencies and set up the project.
# WRONG: built-in shell `npm install` — blocks your turn for minutes.
# RIGHT:
Agent: loopd_command_start({ title: "npm install", command: "npm", args: ["install"], notify_on_exit: true })
# → returns immediately; you keep working, and get pushed when it finishes.
```

### Calling convention (read before every start)

`command` is the executable **only** — never a shell string. Script/flags go in `args` (one element each). Directory goes in `cwd` (the only directory field).

```
# WRONG — two errors: "bash pull2.sh" is not an executable, and `workdir` is not a parameter:
loopd_command_start({ title: "pull", command: "bash pull2.sh", workdir: "/Users/duytrinh/Archives/staging" })
# RIGHT:
loopd_command_start({ title: "pull", command: "bash", args: ["pull2.sh"], cwd: "/Users/duytrinh/Archives/staging" })
# Shell syntax (pipes, redirects, &&, globs) needs shell:true instead of argv splitting:
loopd_command_start({ title: "tail", command: "tail -f app.log | grep ERROR", shell: true })
```

### Agent Tools

| Tool | Purpose |
|------|---------|
| `loopd_command_start` | Spawn `{title, command, args, cwd?, goal_id?, cols?, rows?, env?, timeout_seconds?, shell?, watch_filter?, watch_until?, watch_ignore_case?, watch_until_action?}`. Requests OpenCode's `bash` permission first. Returns `command_id` + host `capabilities` (`spawn`/`write`/`interruptSignal`/`terminate`/`resize`/`terminalEmulation`). `env` passes values to the child but persists names only (`envKeys`); `timeout_seconds` (positive integer) kills via SIGTERM→SIGKILL with `endReason: timeout` + owner notify; `shell:true` spawns via `/bin/sh -c` (POSIX-quoted join; prefer argv form for untrusted input). `watch_filter`/`watch_until` arm line-level notifications at spawn (see Watching below); invalid `watch_until_action` (anything but `"stop"`/`"keep"`) or bad regexes fail the start before spawning. |
| `loopd_command_list` | List commands owned by the calling session. Summaries include the watch spec (`watchFilter`/`watchUntil`/`watchIgnoreCase`/`watchUntilAction`) plus the live `watchState` snapshot (`state`/`matches`/`pushes`/`droppedLines`). |
| `loopd_command_watch` | Set, replace, or clear a watch on an ALREADY-RUNNING command (`{command_id, watch_filter?, watch_until?, watch_ignore_case?, watch_until_action?, clear?}`). Replacing resets counters/state to `active`. Fails closed on bad regexes (previous watch untouched) and returns `ok:false` for terminal commands (watch is meaningless after exit) or another session's commands. |
| `loopd_command_get` | Read status + a bounded output snapshot (`offset_bytes` to page, default 64KB/cap 256KB) — pages the unfiltered retained console log (watch filters never remove bytes), with absolute lifetime offsets. For never-exiting processes prefer a watch + `loopd_command_await` (pushes come to you; no repeated reads). With `pattern` (+`ignore_case`), only regex-matching lines return (ANSI-stripped for matching, originals kept; dangerous nested-quantifier patterns are rejected) and `offset_bytes`/`limit_bytes` page over matches. |
| `loopd_command_write` | Send raw stdin bytes (include your own trailing `\n` for line-buffered programs). |
| `loopd_command_interrupt` | Deliver SIGINT (Ctrl+C as a signal). A process that traps it may keep running — that's correct, not a failure. |
| `loopd_command_terminate` | SIGTERM, escalating to SIGKILL. The only way a command actually stops (closing a view never does). With `remove:true`, deletes the record+log in the same call (works even when already terminal). |
| `loopd_command_remove` | Delete a finished command's record + log. Refuses while `running` (terminate first). |
| `loopd_command_resize` | Set terminal size. Applied live to the real PTY winsize when the host supports it; stored-only (never applied) on the pipe fallback — check `capabilities.resize`. |
| `loopd_command_await` | **The only command→goal edge.** Explicit opt-in: makes `goal_id` wake up exactly once when `command_id` reaches a terminal state (`exited`/`terminated`/`missing`), with exit code/signal/last-4KB output as evidence. With `until` (+`ignore_case`), the goal instead wakes ONCE on the first output line matching the regex (matched lines + bounded tail as evidence) and the command keeps running — for "wait until the dev server prints ready" without repeated reads. Invalid/dangerous `until` patterns are rejected; an `until` already present in the log fires immediately. Merely passing `goal_id` to `loopd_command_start` links for *display only* — it never wakes anything by itself. |

### Lifecycle

```
running → exited      (process ended on its own; exit code kept; endReason: exit)
running → terminated  (explicit terminate/kill; signal kept; endReason: terminate)
running → terminated  (timeout_seconds deadline; endReason: timeout — always notifies the owner)
running → missing     (plugin restart found no live execution — log retained; endReason: missing)
```

- **Detach ≠ terminate.** Closing the fullscreen terminal page, switching tabs, or the TUI restarting never stops the process. Only `loopd_command_terminate` (or the process exiting on its own) does.
- **`terminate ≠ remove`.** `remove` deletes the record + log and refuses while `running`.
- **Orphan commands (`missing`).** A restart that finds no live handle marks the record `missing` (log retained) and fences protected-goal activation until the process exit is proved. `loopd_command_terminate`/`kill`/`interrupt` also work on `missing` records — they signal the pid directly when it is provably still ours. `remove` clears the fence once the process is provably dead (or pid-less), and refuses while the pid is provably alive — terminate first. A pid recycled by the OS to an unrelated executable never fences (identity-checked).
- **Commands and protected goals are mutually exclusive.** While a protected goal is active, any running command freezes all writes/shells/checks, and a new protected goal cannot start while any command runs. To keep a dev server up beside scoped work, use a managed server (approved `kind: "server"`, auto-stopped with the goal) — never a plain command.
- Every response carries the active backend's `capabilities` so you never have to guess (`terminalEmulation` is always `false` — the host captures a byte stream; the TUI's terminal page emulates a screen client-side from it).

### Monitoring in the Dashboard

`/loop` and `/commands` open the **same** shared dashboard — `/loop` focuses the Goals tab, `/commands` focuses Commands. Switch with `Tab` (toggle) or directionally `h` (Goals) / `l` (Commands); `j`/`k`/`g`/`G` select within the active tab. The Commands tab is owner-scoped (only the current session's commands).

On the Commands tab, `o` **never** opens a chat session or a dialog — it closes the popup and navigates to a dedicated fullscreen terminal page inside OpenCode (route `opencode.loopd.terminal`). There:

- Keystrokes forward immediately as raw input — no line-submit box.
- `Ctrl+C` is interrupt input to the *process* (never closes OpenCode).
- `Ctrl+]` detaches back to where you came from — the process keeps running.
- Paste forwards raw bytes immediately.
- The viewport is measured and resizes both the emulator and the real PTY.
- Scrollback: the emulator keeps 1000 lines. Mouse wheel or `Shift+PgUp/PgDn` scrolls history (`↑N` in the footer); new output pins your position until you return to the bottom. Refused on alt-screen apps (vim/less/htop).
- Detached servers (survived a host restart, marked `detached`) show a banner: output is frozen at the detach point and typing cannot reach them, but terminate/kill/interrupt still stop the pid.

Single-key helpers on the Commands tab: `X` force-kill (SIGKILL now, no grace — for hung processes), `R` restart with the same spec (new ID, old record kept; env values are never persisted so restarted env commands lose their env), `x` remove finished (running commands get a hint, never a kill). Colon commands (before opening fullscreen): `:new <command> [args...]` (quoted args preserved, e.g. `:new bash -c "echo hi"`), `:interrupt`, `:terminate`, `:kill`, `:restart`, `:remove`, `:await <goalID>`, and bare text + Enter writes stdin to the selected command. Goal-only keys (`p`/`r`/`A`/`N`) never fire on the Commands tab; `R`/`x` are tab-scoped (retry/clear on Goals, restart/remove-done on Commands).

### Example: Watching a Dev Server

```
User: Start the dev server and let me see the logs.

Agent: loopd_command_start({ title: "dev-server", command: "npm", args: ["run", "dev"] })
# → {ok:true, command:{id:"...", status:"running", ...}, capabilities:{...}}
Agent: "Started — open /loop, Tab to Commands, press o to watch live, or I can set a watch so it pings you on interesting lines."

# Later, to check on it without opening the TUI:
loopd_command_get({ command_id: "..." })
# → status + latest output
```

### Watching Long-Running Commands

For never-exiting processes (dev servers, `test --watch`, log tails), **watch instead of re-reading**: the owner gets pushed on match/exit with no repeated `loopd_command_get` calls.

```
# Arm at spawn…
loopd_command_start({ title: "dev", command: "npm", args: ["run", "dev"],
  watch_filter: "ERROR|WARN", watch_until: "ready in",
  watch_until_action: "keep" })
# …or attach to an already-running command:
loopd_command_watch({ command_id: "...", watch_filter: "ERROR|WARN" })
loopd_command_watch({ command_id: "...", watch_until: "ready in", watch_until_action: "keep" })
loopd_command_watch({ command_id: "...", clear: true })  # drop the watch
```

- **`watch_filter`** (regex on ANSI-stripped lines): only matching lines buffer toward an owner push. No filter = every non-blank line counts.
- **`watch_until`** (regex on the filter-surviving stream — filter first, then until): first match notifies the owner immediately with the matched lines.
- **`watch_until_action`**: `"stop"` (default) terminates the command on first until-match (`endReason: until`, exactly one owner message total — the later exit ping is suppressed); `"keep"` notifies once but keeps running (until fires once, the filter stream continues, a later exit still notifies normally).
- **Replacing** a watch (calling `loopd_command_watch` again) resets counters/state to `active`. **Clearing** drops spec + counters + the in-memory watcher. Watching a terminal command returns `ok:false`. Bad regexes fail closed — the previous watch is left untouched.
- **Notifications are bounded** (so chatty processes can't spam you): matched lines coalesce into one push per ~2s window (≤20 lines / ≤4KB each); at most 30 pushes per command (`budget-exhausted`, one notice, process keeps running); over 100 lines/sec suspends the watch (`flood-suspended`, one notice with dropped count, process keeps running). Every push is prefixed `[watch "<title>"]`.
- **Dashboard**: the Commands tab shows a badge per command — `watch:filter`, `until:stop-armed` / `until:keep-armed`, `until-matched`, `flood-suspended`, `budget-exhausted` — plus the `endReason` (`timeout`/`until`/…) on terminal rows; the detail panel shows the watch spec with `matches`/`pushes`/`dropped` counters.

#### Two channels: console log vs agent events

- **Console = source of truth.** Raw output is retained unfiltered for every command (last 512KB ring, absolute UTF-8 lifetime offsets that never reset). `loopd_command_get`, `:log`, and the Commands panel `o` view page that same log. `watch_filter` never removes anything from it — a filter matching 1 of N lines still leaves all N readable.
- **Agent events = derived and bounded.** Each owner-facing delivery (watch match, until match, exit, timeout, flood, budget) is one sequenced event carrying the command id, trigger, timestamp, status/`exitCode`/signal/duration, retained vs lifetime bytes, `truncated`, and the exact console range `[startOffset,endOffset)` its payload came from. Exit/timeout notifications use the same ≤20 lines / ≤4KB bound — the whole log is never posted to chat.
- **Paging hint.** Every event ends with `-- console is the source of truth; page raw output with loopd_command_get id=<id> offsetBytes=<start>`.
- **Truncation is explicit.** After the 512KB ring drops its head, every event carries `truncated:true` with absolute offsets, and the panel shows `earlier output not retained: keeping the last N of M bytes`. Missing old bytes are never implied by silence.
- **No watch required to be woken.** `watch_filter` is optional live filtering only. `notify_on_exit` already follows the auto policy — non-zero exit, `missing`, `timeout`, or a success that ran ≥ ~2 minutes. Do not invent a keyword just to get an exit ping.
- **Human view of the agent channel.** The panel header shows `console: … · agent events: N (last #seq trigger …)` or `agent events: none (filtered output stays console-only)`.

### Migrating from PTY Sessions (`pty_*` tools)

| Before (`pty_*`) | After (`loopd_command_*`) | Notes |
|---|---|---|
| `pty_spawn({cmd, args, cwd})` | `loopd_command_start({title, command, args, cwd, env?, timeout_seconds?, shell?, notify_on_exit?, watch_filter?, watch_until?, watch_ignore_case?, watch_until_action?})` | `env` passes values but persists names only (`envKeys`); `timeout_seconds` kills via SIGTERM→SIGKILL with `endReason: timeout` and always notifies the owner (in-memory timer, never resurrected across restarts); `shell:true` joins via `/bin/sh -c`; `notify_on_exit` overrides the auto policy (auto = notify on non-zero exit, `missing`, `timeout`, or runs ≥ ~2min; quick successes stay silent) |
| `pty_write({id, data})` | `loopd_command_write({command_id, input})` | Same raw-stdin bytes; include your own trailing `\n` |
| `pty_read({id, pattern?})` | `loopd_command_get({command_id, pattern?, ignore_case?, offset_bytes?, limit_bytes?})` | `pattern` matches ANSI-stripped text, originals returned; pages over matches; dangerous patterns rejected. For continuous monitoring prefer a watch over repeated reads |
| `pty_list()` | `loopd_command_list()` | Owner-scoped (your session's commands only — same set as the TUI Commands tab); summaries carry `watchState` + `endReason` |
| `pty_kill({id, cleanup})` | `loopd_command_terminate({command_id, remove?})` | `remove:true` deletes record+log atomically (even when already terminal); plain `terminate` keeps the record for `loopd_command_remove` later |
| `notifyOnExit` / `timeoutSeconds` spawn opts | `notify_on_exit` / `timeout_seconds` args | Same shape, two loopd differences: the auto-notify policy above (not plain true/false), and timeout stamps `endReason: timeout` instead of a generic kill |

### Migrating from Sentinel Watches (`sentinel_monitor`)

| Sentinel | Loopd | Notes |
|---|---|---|
| `filter` / `until` patterns | `watch_filter` / `watch_until` (+`watch_ignore_case`) | Same filter-first-then-until pipeline; same dangerous-regex guard; attach at start or later via `loopd_command_watch` |
| Steer delivery (message routed back into the agent turn) | Owner prompt push (`[watch "<title>"] …`) | Loopd notifies the owning session directly; a goal that must *act* on output should use `loopd_command_await` (`until` variant) instead |
| Flood/batch limits | Coalesce (~2s) + per-push bounds + 30-push budget + 100-lines/sec flood suspend | All bounded, all one-notice, process always keeps running (sentinel SIGTERMs on flood — loopd deliberately doesn't) |
| Until auto-stop | `watch_until_action: "stop"` (default) → `endReason: until` | `"keep"` is the explicit opt-out; `until-matched` shows as a dashboard badge either way |
| Shell-string spawn | `shell:true` (`command`+`args` joined POSIX-quoted via `/bin/sh -c`) | Prefer argv form for untrusted input |

### Example: A Goal That Waits On a Background Build

```
# Inside a goal worker:
loopd_command_start({ title: "full-build", command: "npm", args: ["run", "build"] })
# → command_id: "abc123"
loopd_command_await({ command_id: "abc123", goal_id: <this goal's id> })
# The worker can now idle; the engine wakes it exactly once when the build
# finishes, with exit code + last 4KB of output as evidence — no polling.
```

## Dashboard Commands

Open the shared dashboard with `/loop` (or `<leader>o`) — focuses the **Goals** tab — or `/commands` — focuses the **Commands** tab. Same popup, same component, two entry points.

### Switching Tabs

| Key | Action |
|-----|--------|
| `Tab` | Toggle Goals ↔ Commands |
| `h` | Select Goals directionally |
| `l` | Select Commands directionally |

`j`/`k`/`g`/`G` select within whichever tab is active. Goal controls (`p`/`r`/`A`/`N`) only fire on the Goals tab and are refused with a hint on Commands; `R`/`x` are tab-scoped (retry/clear on Goals, restart/remove-done on Commands).

### Commands Tab — Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `X` | Force-kill selected command (SIGKILL now, no grace) |
| `R` | Restart selected command with the same spec (new ID) |
| `x` | Remove selected command — finished only (running gets a hint) |
| `o` | Open fullscreen terminal page |
| `Ctrl+C` | Interrupt selected command (SIGINT delivery, never a kill) |

### Goals Tab — Keyboard Shortcuts (Normal Mode)

| Key | Action | Agent equivalent |
|-----|--------|-----------------|
| `j` / `k` | Move selection down / up | — (UI only) |
| `g` / `G` | Jump to top / bottom | — |
| `o` | Open the selected goal's native worker session | `read_goal_transcript` / `inspect_background_goal` |
| `L` | Toggle log view | — |
| `?` | Toggle help | — |
| `c` | Toggle done (show/hide completed) | — |
| `p` / `r` / `R` / `x` | Pause / resume / retry / clear | `pause_goal` / `resume_goal` / `clear_goal` |
| `A` | Abort worker only (N / :abort) | `abort_goal_worker` |
| `N` | Nudge with full steering | `nudge_goal` |
| `Ctrl+N` | Switch to normal mode | — |
| `:` | Enter command mode | — |

### Goals Tab — Command Mode (`:` prefix)

| Command | Description | Agent equivalent |
|---------|-------------|-----------------|
| `:send <message>` | Send bare words now as their own turn (no steering) | `send_goal_input` |
| `:nudge` | Force re-prompt now with full steering | `nudge_goal` |
| `:open` | Open the selected goal's child session | — |
| `:force <summary> --evidence <text>` | Force-complete (bypass verification checks) | `force_complete_goal` |
| `:block <reason> --needed <text>` | Force-block the selected goal | `force_block_goal` |
| `:abort` | Abort worker session now (status unchanged; A) | `abort_goal_worker` |
| `:pause` / `:resume` / `:retry` / `:clear` | Quick controls (also p/r/R/x) | `pause_goal` / `resume_goal` / `clear_goal` |
| `:interactive` | Toggle manual mode (engine never starts turns) | `interactive: true` at creation |
| `:model <provider/model>` | Switch this goal's model (same worker/session) | `switch_goal_identity` |
| `:models` | Show provider/model inventory + quota status | `loopd_list_models` |
| `:agent <name>` | Switch this goal's agent (same worker/session; Goals tab only) | `switch_goal_identity` |
| `:agents` | List available agent names/modes and host capabilities (Goals tab only) | `loopd_list_models` |
| `:logs` / `:help` / `:q` | Toggle logs / help / close | — |

> Goal creation (`:goal start`) was removed from the dashboard — create goals via `/goal` in the parent chat so the agent can clarify the objective first.

### Commands Tab — Keyboard & Command Mode

| Key / Command | Action | Agent equivalent |
|-----|--------|-----------------|
| `j` / `k` / `g` / `G` | Select a command session | — |
| `o` | Close the popup, open the selected command in the **fullscreen terminal page** | — |
| `Ctrl+C` | Interrupt (SIGINT) the selected command | `loopd_command_interrupt` |
| `:new <command> [args...]` | Start a new command (quoted args preserved) | `loopd_command_start` |
| `:interrupt` | SIGINT the selected command | `loopd_command_interrupt` |
| `:terminate` | SIGTERM→SIGKILL the selected command | `loopd_command_terminate` |
| `:kill` | SIGKILL now, no grace (same as `X`) | — (no agent equivalent; agents use `loopd_command_terminate`) |
| `:restart` | Stop + respawn same spec, new ID (same as `R`) | — (no agent equivalent) |
| `:remove` | Delete a finished command's record + log | `loopd_command_remove` |
| bare text + Enter | Write that line as stdin to the selected command | `loopd_command_write` |
| `q` | Detach (view closes; command keeps running) | — |

Inside the **fullscreen terminal page** (reached via `o`): every keystroke forwards immediately as raw input (no line-submit box), `Ctrl+C` is interrupt input to the process, `Ctrl+]` detaches back to where you came from without stopping the process. Press `?` on the Commands tab to see force-kill, restart, and removal shortcuts before opening the terminal.

**Scrolling:** both lists are a `<scrollbox>` capped at 10 rows — short lists sit compact with no gap, long lists scroll and follow `j`/`k`/`g`/`G` via `scrollChildIntoView`. Detail + input stay pinned below in both cases. Empty list shows the fallback tip.

## Safety Patterns

1. **Always call `get_goal` first** — Read the full contract (objective + checks + limits + budgets) before doing any work. The `COMPLETION REVIEW` and `HOST VERDICT` in steering are authoritative.
2. **Progress after durable changes** — Call `report_goal_progress` after file writes or verifications (resets `consecutiveFailures`/`noProgressCount`), not after thinking.
3. **Complete with evidence — host decides** — Never call `complete_goal` without concrete proof. The host will reject it if `checks` fail; you’ll get `Rejection #N` with exact `stderr` and a **free retry** (`budgetTurnCount` not charged for N<3). After 3 rejections the goal is `blocked`.
4. **Block for real blockers only** — Don’t block for things you can figure out. If objective and `checks` appear contradictory, `block_goal` — don’t silently violate either.
5. **Use checks for verification — mandatory for writers** — `workspaceWrite:true` goals **require** `checks` (explicit or `defaultChecks`). Checks run from `checkCwd` (writers → project root by default). `["npm test","bun run typecheck"]` is a good default.
6. **Serialize workspace edits** — Keep `workspaceWrite:true` (the default) for code/repo changes. The engine allows **only one active writer**; a second `start`/`resume`/`retry` fails with `already active`. Use `workspaceWrite:false` explicitly for artifact-only research to allow concurrency.
7. **Set safety budgets** — `maxTurns` (default 50), `costBudget` (dollars), `tokenBudget` (tokens), `maxNoProgress`, `maxFailures` prevent runaways. Budgets are enforced **continuously** in maintenance, not just at turn boundaries — the worker is aborted mid-turn when exceeded. On `maxTurns`/`maxNoProgress` the engine injects `FINAL REPORT REQUIRED`; if ignored, it `blocked (force-finish ignored)` after the next idle.
8. **Compact periodically** — `compactEvery` keeps the worker session’s context manageable.
9. **Recover stuck workers explicitly** — If `inspect` shows `phase=running` with `unknownStatusCount ≥3` or `lastActivityAt` far in the past, use `nudge_goal` (full steering) for a healthy-but-stuck worker or `abort_goal_worker` for a spinning/burning one. `send_goal_input` alone is now immediate for active goals, but it is still bare words, not steering.
10. **One writer, one check suite** — Don’t run concurrent `start` calls that touch the same files from parallel chats; chain them sequentially or mark the second as `workspaceWrite:false`.
11. **Registry is the source of truth** — `src/domain/interaction-registry.ts` lists every `LoopCommand` with its TUI and agent bindings. `test/domain/parity.test.ts` fails CI if they drift. When adding an interaction: add one row to `INTERACTIONS`, one handler in `control-worker.ts`, and both surfaces light up.
12. **Goal vs Command Session — pick by shape of the task, not by habit** — "Run/watch/type into a process" (dev server, test watch, REPL, log tail, one-off script) is a `loopd_command_start` job with zero agent overhead, even if it will run a long time. Reach for `loopd_create_goal` only when the task genuinely needs multi-turn AI reasoning against a checkable definition of done. Don't spin up a goal just to babysit a process — use `loopd_command_await` if a goal needs to *wait* on one.

## Example: Creating and Monitoring a Goal

**Parent chat:**
```
User: Write a README for this project and create a changelog.

Agent: I'll set up a background goal for this. What's the verification?

User: Just that both files exist.

Agent: Got it — creating with a contract.

loopd_create_goal({
  name: "docs-write",
  objective: "Write a README.md covering: what it is, install, usage, architecture, and examples. Then create CHANGELOG.md with a v1.0.0 entry.",
  // omit agent/model to inherit calling session — only pass when explicitly requested
  costBudget: 0.5,
  checks: ["test -f README.md", "test -f CHANGELOG.md"],
  checkCwd: "/Users/you/project",           // explicit for writers; defaults to project root
  workspaceWrite: true,                     // default true — serialized
  progressFile: ".opencode/loopd/docs-progress.md",
  maxTurns: 20
})
# → {ok:true, artifactDir: ".opencode/loopd/goals/<id>", defaultsApplied:{...}}
# Goal starts. User can monitor with /loop. If checks fail, the worker gets HOST VERDICT with exact stderr and a free retry.
```

**Worker session (automatic):**
```
# Turn 1
get_goal()  → reads objective
# ... explores codebase, writes README.md
report_goal_progress({ summary: "README.md written", next: "Create CHANGELOG.md" })

# Turn 2
get_goal()  → reads objective
# ... writes CHANGELOG.md
complete_goal({ summary: "Docs complete", evidence: "README.md and CHANGELOG.md exist" })
```

**Owner steering mid-run (either transport):**
```
# TUI:  :send use pnpm, not npm
# Agent: send_goal_input({ message: "use pnpm, not npm" })
# → bare turn, delivered now, no steering wrapper — fits small contexts

# TUI:  N  or  :nudge        ↔  Agent: nudge_goal()
# → full steering turn, forced even if not idle

# TUI:  A  or  :abort        ↔  Agent: abort_goal_worker()
# → kill the session only, keep transcript, next active turn reuses it
```
