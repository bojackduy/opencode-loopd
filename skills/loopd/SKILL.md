---
name: loopd
description: "Agent skill for loopd background goals. Teaches when to create goals, how to inspect/steer/pause them, and how to send instructions to workers."
metadata:
  version: "1.0.0"
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

## Contract & Evaluation Semantics

Every goal has an **immutable contract** at creation — the source of truth for completion:

* **Objective** — semantic requirements (free text, self-contained). The worker derives concrete requirements from it.
* **Checks** — deterministic shell commands that **must pass** for `complete_goal` to be accepted. For `workspaceWrite:true` goals they are **mandatory** (explicit `checks` or plugin `defaultChecks`), and they run from `checkCwd` (writers default to project root; artifact-only jobs run from their `artifactDir`).
* **Agent** — which subagent model runs the worker (`sloppy-agent`, `smart-agent`, …). Required unless `defaultAgent` is configured in `opencode.jsonc` plugin options.
* **WorkspaceWrite** — `true` (default) = may touch the shared repo; **only one active writer at a time** is allowed (enforced on `start`/`resume`/`retry` with rollback). Set `false` explicitly for artifact-only/read-only work to allow concurrency.
 * **Limits** — `maxTurns` (default 50), `maxNoProgress`, `maxFailures`, `maxEvaluatorRejections` (default 3), `timeoutMs`, `compactEvery`, `progressFile`.

**Who decides completion:**
* **Host is the acceptance authority** — it runs `checks` deterministically. If any check fails, `complete_goal` is **rejected** (`ok:false`, `rejectionCount++`, `freeRetryPending=true` for <3 rejections, `blocked` after 3). The worker gets the exact failure in the next steering.
* **Model is the proposer** — it must self-audit via `## COMPLETION REVIEW` (derive requirements → locate evidence → judge `proves|contradicts|incomplete|missing`) and only call `complete_goal` when every requirement is proved. If objective and checks conflict, it must `block_goal`, not silently violate either.

**Hardened loop guarantees (1da88dc):**
* **Prompt correlation** — each turn’s prompt gets a `msg-` UUID (`activePromptMessageID`); the engine correlates `message.updated`/`message.part.updated` by that ID and by `runGeneration`. Stale events never release a newer lease.
* **Generation fencing** — `idleCandidateAt` is tied to `idleCandidateGeneration`; a new prompt clears the candidate. Finalization also requires the transcript anchor: the latest user prompt must be the engine’s prompt **and** its assistant response must be completed.
* **Maintenance (30s)** — auto-repairs `phase=idle + activeRunID` (stale lease), bounds `unknown` status polls (`unknownStatusCount` threshold 3 → one `notifyOwner` per episode, `workerUnreachableNotifiedAt` deduped), and recovers counters on success. `active`-only polling; `blocked`/`paused` never auto-continue.
* **Per-goal mutex** — `withGoalOperation(goalID)` serializes `continueTurn`/`pause`/`resume`/`retry`/`clear`/`nudge` per goal, and `turn.acquire` re-checks `leaseIsValid` inside the transaction for exclusivity.
* **Lease** — `acquireLease`/`releaseLease` + `timeoutMs` (default 5 min); prompt failures release the lease and schedule `waiting_retry` with exponential backoff.

## Creating a Goal

Use `loopd_create_goal` **after** clarifying the objective with the user (what / where / how to verify). The tool validates the contract before spawning:

```
loopd_create_goal({
  name: "short-name",
  objective: "Detailed description of what the goal should accomplish.",
  agent: "smart-agent",                    // required unless plugin defaultAgent is configured
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

Returns `ok:true` with `goalID`, `workerSessionID`, `artifactDir`, `agent`, `checks`, `workspaceWrite`, `defaultsApplied:{agent,checks}`. On contract violation you get `ok:false` with `errorCode: "missing_agent"` or `"missing_checks"` or `"already active"` (writer serialization).

The goal starts immediately. The user can monitor it via `/loop` (<leader>d). Plugin options `defaultAgent` / `defaultChecks` in `opencode.jsonc` can supply defaults so callers don’t have to repeat them.

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

### Worker questions vs send_goal_input

| Tool | Who calls it | Direction | When to use |
|------|-------------|-----------|-------------|
| `question` (OpenCode builtin) | Worker (inside goal) | Worker → User | Worker needs info only the user can provide. Question appears in the TUI footer as a blocker tab. |
| `send_goal_input` | Owner (parent chat) | User → Worker | Owner sends an instruction, answer, or redirect to the worker. |

**question** — The worker uses OpenCode's built-in `question` tool when it's genuinely stuck or ambiguous. The question appears in the TUI footer (blocker tab) and the user answers there. No goal status change needed — the worker stays busy until answered.

**send_goal_input** — The owner calls this to steer the worker. Messages are injected into the worker's next continuation prompt. Use it to:
- Redirect the worker to a different approach
- Refine scope or add constraints
- Provide missing context

## Owner Tools (Parent Chat)

All are filtered by `ownerSessionID` (only the session that created the goal sees it). They are the **only** way to recover a stuck worker — they mutate the engine state (Entity B) and, when needed, force the bridge to the real subagent session (Entity A).

### list_background_goals

Lists all `active` goals owned by this session (name, status, phase, turn, last progress, blocker).

### inspect_background_goal

Shows detailed contract + runtime: `objective`, `config{agent,checks,checkCwd,workspaceWrite,limits,artifactDir}`, `lastProgress`, `completionEvidence`, `blocker`, `runtime{phase,runCount,budgetTurnCount,runGeneration,evaluatorRejectionCount,lastActivityAt,activePromptMessageID,unknownStatusCount}`.

### read_goal_transcript

Reads the last N messages from the worker session (`role`, `content`, `timestamp`, `messageID`). Use to see if the worker’s steering contained `HOST VERDICT`.

### send_goal_input

Appends to the goal’s inbox file; the next `continueTurn` injects it as `## USER INSTRUCTIONS`. **Does not itself re-prompt** — the engine does on next idle/maintenance.

### nudge_goal

Force re-prompts a stuck worker even if `sessionStatus` is not `idle`. Clears stale `activeRunID`/`idleCandidateAt`/`activePromptMessageID`/lease, sets `phase=idle`, and calls `continueTurn({force:true})`. Use when `unknownStatusCount` ≥3 or the worker is `running` with no activity. Returns `{ok, message}`.

### pause_goal / resume_goal / retry / clear

* `pause_goal` — `active → paused`, `releaseLease`, `abortWorker`. Frees the writer slot.
* `resume_goal` — `paused → active`, reuses the existing worker session if `sessionStatus` is still `idle`/`busy` (preserves transcript), otherwise creates a new one. Fails with `already active` if another writer is active.
* `retry` (via `resume` on `blocked`) — `blocked → active`, resets `consecutiveFailures`/`forceFinishRequested`.
* `clear_goal` — aborts worker and removes `goal` + `runtime` + ledger entry (cannot be undone).

## Dashboard Commands

Open the dashboard with `/loop` or <leader>d.

### Keyboard Shortcuts (Normal Mode)

| Key | Action |
|-----|--------|
| `j` / `k` | Move selection down / up |
| `g` / `G` | Jump to top / bottom |
| `o` | Open child (view details) |
| `L` | Toggle log view |
| `?` | Toggle help |
| `Ctrl+N` | Switch to normal mode |
| `:` | Enter command mode |

### Command Mode (`:` prefix)

| Command | Description |
|---------|-------------|
| `:send <message>` | Send instruction to the selected goal's worker |
| `:open` | Open the selected goal's child session |
| `:force <summary> --evidence <text>` | Force-complete (bypass verification checks) |
| `:block <reason> --needed <text>` | Force-block the selected goal |
| `:pause` | Pause the selected goal |
| `:resume` | Resume the paused goal |
| `:retry` | Retry the blocked goal |
| `:clear` | Clear the selected goal |
| `:logs` | Toggle log view |
| `:help` | Show help |
| `:q` / `:close` | Close dashboard |

> Goal creation (`:goal start`) was removed from the dashboard — create goals via `/goal` in the parent chat so the agent can clarify the objective first.

## Safety Patterns

1. **Always call `get_goal` first** — Read the full contract (objective + checks + limits) before doing any work. The `COMPLETION REVIEW` and `HOST VERDICT` in steering are authoritative.
2. **Progress after durable changes** — Call `report_goal_progress` after file writes or verifications (resets `consecutiveFailures`/`noProgressCount`), not after thinking.
3. **Complete with evidence — host decides** — Never call `complete_goal` without concrete proof. The host will reject it if `checks` fail; you’ll get `Rejection #N` with exact `stderr` and a **free retry** (`budgetTurnCount` not charged for N<3). After 3 rejections the goal is `blocked`.
4. **Block for real blockers only** — Don’t block for things you can figure out. If objective and `checks` appear contradictory, `block_goal` — don’t silently violate either.
5. **Use checks for verification — mandatory for writers** — `workspaceWrite:true` goals **require** `checks` (explicit or `defaultChecks`). Checks run from `checkCwd` (writers → project root by default). `["npm test","bun run typecheck"]` is a good default.
6. **Serialize workspace edits** — Keep `workspaceWrite:true` (the default) for code/repo changes. The engine allows **only one active writer**; a second `start`/`resume`/`retry` fails with `already active`. Use `workspaceWrite:false` explicitly for artifact-only research to allow concurrency.
7. **Set safety budgets** — `maxTurns` (default 50), `maxNoProgress`, `maxFailures` prevent runaways. On `maxTurns`/`maxNoProgress` the engine injects `FINAL REPORT REQUIRED`; if ignored, it `blocked (force-finish ignored)` after the next idle.
8. **Compact periodically** — `compactEvery` keeps the worker session’s context manageable.
9. **Recover stuck workers explicitly** — If `inspect` shows `phase=running` with `unknownStatusCount ≥3` or `lastActivityAt` far in the past, use `nudge_goal` (force re-prompt) or `pause`/`resume`. `send_goal_input` alone does not re-prompt.
10. **One writer, one check suite** — Don’t run concurrent `start` calls that touch the same files from parallel chats; chain them sequentially or mark the second as `workspaceWrite:false`.

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
  agent: "smart-agent",
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
