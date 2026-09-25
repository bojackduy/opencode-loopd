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

## Command Sessions (Standalone Interactive Processes)

A **command session** is a raw OS process (spawned via `bun-pty`, falling back to a plain pipe) — no agent, no turns, no checks. It is completely independent from goals: starting/stopping one never pauses, blocks, or completes any goal, and vice versa. Use it whenever the request is "run X and let me watch/type into it" rather than "figure out/build X".

Typical uses: dev servers (`npm run dev`), watch mode (`npm test -- --watch`), REPLs (`python3`, `node`), log tails (`tail -f`), one-off scripts, interactive shells.

### Agent Tools

| Tool | Purpose |
|------|---------|
| `loopd_command_start` | Spawn `{title, command, args, cwd?, goal_id?, cols?, rows?, env?, timeout_seconds?, shell?}`. Requests OpenCode's `bash` permission first. Returns `command_id` + host `capabilities` (`spawn`/`write`/`interruptSignal`/`terminate`/`resize`/`terminalEmulation`). `env` passes values to the child but persists names only (`envKeys`); `timeout_seconds` (positive integer) kills via SIGTERM→SIGKILL with `endReason: timeout` + owner notify; `shell:true` spawns via `/bin/sh -c` (POSIX-quoted join; prefer argv form for untrusted input). |
| `loopd_command_list` | List commands owned by the calling session. |
| `loopd_command_get` | Read status + a bounded output snapshot (`offset_bytes` to page, default 64KB/cap 256KB). With `pattern` (+`ignore_case`), only regex-matching lines return (ANSI-stripped for matching, originals kept) and `offset_bytes`/`limit_bytes` page over matches. |
| `loopd_command_write` | Send raw stdin bytes (include your own trailing `\n` for line-buffered programs). |
| `loopd_command_interrupt` | Deliver SIGINT (Ctrl+C as a signal). A process that traps it may keep running — that's correct, not a failure. |
| `loopd_command_terminate` | SIGTERM, escalating to SIGKILL. The only way a command actually stops (closing a view never does). With `remove:true`, deletes the record+log in the same call (works even when already terminal). |
| `loopd_command_remove` | Delete a finished command's record + log. Refuses while `running` (terminate first). |
| `loopd_command_resize` | Set terminal size. Applied live to the real PTY winsize when the host supports it; stored-only (never applied) on the pipe fallback — check `capabilities.resize`. |
| `loopd_command_await` | **The only command→goal edge.** Explicit opt-in: makes `goal_id` wake up exactly once when `command_id` reaches a terminal state (`exited`/`terminated`/`missing`), with exit code/signal/last-4KB output as evidence. Merely passing `goal_id` to `loopd_command_start` links for *display only* — it never wakes anything by itself. |

### Lifecycle

```
running → exited      (process ended on its own; exit code kept; endReason: exit)
running → terminated  (explicit terminate/kill; signal kept; endReason: terminate)
running → terminated  (timeout_seconds deadline; endReason: timeout — always notifies the owner)
running → missing     (plugin restart found no live execution — log retained; endReason: missing)
```

- **Detach ≠ terminate.** Closing the fullscreen terminal page, switching tabs, or the TUI restarting never stops the process. Only `loopd_command_terminate` (or the process exiting on its own) does.
- **`terminate ≠ remove`.** `remove` deletes the record + log and refuses while `running`.
- Every response carries the active backend's `capabilities` so you never have to guess (`terminalEmulation` is always `false` — the host captures a byte stream; the TUI's terminal page emulates a screen client-side from it).

### Monitoring in the Dashboard

`/loop` and `/commands` open the **same** shared dashboard — `/loop` focuses the Goals tab, `/commands` focuses Commands. Switch with `Tab` (toggle) or directionally `h` (Goals) / `l` (Commands); `j`/`k`/`g`/`G` select within the active tab. The Commands tab is owner-scoped (only the current session's commands).

On the Commands tab, `o` **never** opens a chat session or a dialog — it closes the popup and navigates to a dedicated fullscreen terminal page inside OpenCode (route `opencode.loopd.terminal`). There:

- Keystrokes forward immediately as raw input — no line-submit box.
- `Ctrl+C` is interrupt input to the *process* (never closes OpenCode).
- `Ctrl+]` detaches back to where you came from — the process keeps running.
- Paste forwards raw bytes immediately.
- The viewport is measured and resizes both the emulator and the real PTY.

Colon commands available directly on the Commands tab (before opening fullscreen): `:new <command> [args...]` (quoted args preserved, e.g. `:new bash -c "echo hi"`), `:interrupt`, `:terminate`, `:remove`, and bare text + Enter writes stdin to the selected command. Goal controls (`p`/`r`/`R`/`x`/`A`/`N`) never fire on the Commands tab.

### Example: Watching a Dev Server

```
User: Start the dev server and let me see the logs.

Agent: loopd_command_start({ title: "dev-server", command: "npm", args: ["run", "dev"] })
# → {ok:true, command:{id:"...", status:"running", ...}, capabilities:{...}}
Agent: "Started — open /loop, Tab to Commands, press o to watch live, or I can poll it for you."

# Later, to check on it without opening the TUI:
loopd_command_get({ command_id: "..." })
# → status + latest output
```

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

`j`/`k`/`g`/`G` select within whichever tab is active. Goal controls (`p`/`r`/`R`/`x`/`A`/`N`) only fire on the Goals tab and are refused with a hint on Commands.

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
| `:remove` | Delete a finished command's record + log | `loopd_command_remove` |
| bare text + Enter | Write that line as stdin to the selected command | `loopd_command_write` |
| `q` | Detach (view closes; command keeps running) | — |

Inside the **fullscreen terminal page** (reached via `o`): every keystroke forwards immediately as raw input (no line-submit box), `Ctrl+C` is interrupt input to the process, `Ctrl+]` detaches back to where you came from without stopping the process.

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
