---
name: loopd
description: "Agent skill for loopd background goals. Teaches when to create goals, how to inspect/steer/pause them, and how to send instructions to workers."
metadata:
  version: "1.2.0"
  status: active
  tags: [opencode, loop, goal, background, automation]
---

# Loopd Background Goals

Loopd runs long-running or autonomous tasks as background goals, each with a dedicated worker session. The parent chat stays interactive while work happens behind the scenes.

## When to Use Loopd

Use loopd when:

- A task takes many turns and would block the main chat
- You want autonomous work that continues while the user does other things
- A task needs progress tracking, completion checks, or blocking
- You want a dashboard to monitor and steer background work

Do not use loopd when:

- The task is trivial (1-3 turns)
- The user needs to answer questions at every step
- The task modifies production systems without review gates

## Goal Lifecycle

```
created → active → complete
                  → blocked (needs user intervention)
                  → budget_limited / usage_limited (engine limits)
         paused (user-initiated, can resume)
         retry (blocked → active, clears failures)
```

Only `active` goals own live worker runs. `blocked`/`paused`/`budget_limited` wait for an explicit owner transition (`resume`/`retry`/`nudge`). The loop is engine-driven, not parent-driven.

`abort_goal_worker` (TUI `A` / `abort_goal_worker` tool) aborts the worker *session only* — status stays the same, transcript remains browsable, the next active turn reuses the same session. Use it for compaction-spin or stuck runs that keep burning tokens without progress.

## Contract & Evaluation Semantics

Every goal has an **immutable contract** at creation — the source of truth for completion:

* **Objective** — semantic requirements (free text, self-contained). The worker derives concrete requirements from it.
* **Checks** — deterministic shell commands that **must pass** for `complete_goal` to be accepted. For `workspaceWrite:true` goals they are **mandatory** (explicit `checks` or plugin `defaultChecks`), and they run from `checkCwd` (writers default to project root; artifact-only jobs run from their `artifactDir`).
* **Agent** — any OpenCode agent name: built-in (`build`, `plan`, `explore`, `general`), file `~/.config/opencode/agents/*.md`, or `opencode.jsonc` `agent.*`. Discover with `opencode agent list`. Prefer `subagent`-mode agents for workers; `primary`-mode agents work but may expect user interaction. Resolution: explicit arg → **calling session's live agent** (read at creation) → `defaultAgent` → OpenCode global default. So a parent in Plan spawns a Plan worker unless told otherwise.
* **Model** — any model as `"providerID/modelID"` (e.g. `openai/gpt-5.6-sol`, `ollama/qwen3.8:27b`, `openrouter/google/gemma-4-31b-it:free`). Discover with `opencode models [provider]`. Sent on every worker prompt. Resolution: explicit arg → **calling session's live model** → `defaultModel` → agent config → session history → global default. Caveat: OpenCode exposes no live-model field for history-derived models, so those fall through to agent config.
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
  agent: "researcher",                    // any agent name; optional, inherits calling session then defaultAgent
  model: "openai/gpt-5.6-sol",            // any provider/model; optional, inherits calling session then defaultModel
  costBudget: 0.5,                         // optional dollars; aborts worker when exceeded
  checks: ["npm test"],                    // mandatory if workspaceWrite:true (or configure defaultChecks)
  checkCwd: "/project/root",               // optional; writers default to project root, readers to artifactDir
  workspaceWrite: true,                    // default true; set false explicitly for artifact-only/read-only
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

The goal starts immediately. The user can monitor it via `/loop` (<leader>o). Plugin options `defaultAgent` / `defaultModel` / `defaultChecks` in `opencode.jsonc` can supply defaults so callers don’t have to repeat them.

## Worker Tools (Running Inside the Goal)

These tools are available to the worker session doing the actual work:

### get_goal

Call at the start of every turn to read the objective, config, and current state. Always call this first.

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

### force_complete_goal / force_block_goal

Owner-side equivalents of TUI `:force` / `:block`. Bypass checks — use only when you have verified manually that the artifact is correct or that the blocker is real.

## Dashboard Commands

Open the dashboard with `/loop` or <leader>o.

### Keyboard Shortcuts (Normal Mode)

| Key | Action | Agent equivalent |
|-----|--------|-----------------|
| `j` / `k` | Move selection down / up | — (UI only) |
| `g` / `G` | Jump to top / bottom | — |
| `o` | Open child (view details) | `read_goal_transcript` / `inspect_background_goal` |
| `L` | Toggle log view | — |
| `?` | Toggle help | — |
| `c` | Toggle done (show/hide completed) | — |
| `p` / `r` / `R` / `x` | Pause / resume / retry / clear | `pause_goal` / `resume_goal` / `clear_goal` |
| `A` | Abort worker only (N / :abort) | `abort_goal_worker` |
| `N` | Nudge with full steering | `nudge_goal` |
| `Ctrl+N` | Switch to normal mode | — |
| `:` | Enter command mode | — |

### Command Mode (`:` prefix)

| Command | Description | Agent equivalent |
|---------|-------------|-----------------|
| `:send <message>` | Send bare words now as their own turn (no steering) | `send_goal_input` |
| `:nudge` | Force re-prompt now with full steering | `nudge_goal` |
| `:open` | Open the selected goal's child session | — |
| `:force <summary> --evidence <text>` | Force-complete (bypass verification checks) | `force_complete_goal` |
| `:block <reason> --needed <text>` | Force-block the selected goal | `force_block_goal` |
| `:abort` | Abort worker session now (status unchanged; A) | `abort_goal_worker` |
| `:pause` / `:resume` / `:retry` / `:clear` | Quick controls (also p/r/R/x) | `pause_goal` / `resume_goal` / `clear_goal` |
| `:logs` / `:help` / `:q` | Toggle logs / help / close | — |

> Goal creation (`:goal start`) was removed from the dashboard — create goals via `/goal` in the parent chat so the agent can clarify the objective first.

**Scrolling:** the goal list is a `<scrollbox>` capped at 10 rows — short lists sit compact with no gap, long lists scroll and follow `j`/`k`/`g`/`G` via `scrollChildIntoView`. Detail + input stay pinned below in both cases. Empty list shows the fallback tip.

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
  agent: "researcher",
  model: "openai/gpt-5.6-sol",
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
