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
         paused (user-initiated, can resume)
```

## Creating a Goal

Use `loopd_create_goal` after clarifying the objective with the user:

```
loopd_create_goal({
  name: "short-name",
  objective: "Detailed description of what the goal should accomplish.",
  checks: ["npm test"],                    // optional: shell commands for completion verification
  progressFile: ".opencode/loopd/progress.md", // optional: worker reads/writes this
  maxTurns: 50,                            // optional: safety budget
  maxNoProgress: 5,                        // optional: auto-block without progress
  maxFailures: 3,                          // optional: auto-block on failures
  compactEvery: 3,                         // optional: compact worker session every N turns
})
```

The goal starts immediately. The user can monitor it via `/loop` (<leader>d).

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

These tools are available in the parent chat that created the goal:

### list_background_goals

Lists all active goals owned by this session. Shows status and progress.

### inspect_background_goal

Shows detailed info: objective, config, progress, blocker, runtime state.

### read_goal_transcript

Reads the last N messages from the worker session. Useful for debugging what the worker is doing.

### send_goal_input

Sends a message to the worker's next turn. See table above.

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

1. **Always call `get_goal` first** — Read the objective before doing any work.
2. **Progress after durable changes** — Call `report_goal_progress` after file writes or verifications, not after thinking.
3. **Complete with evidence** — Never call `complete_goal` without concrete proof (test output, file checks passing).
4. **Block for real blockers only** — Don't block for things you can figure out. Block when you genuinely need user input.
5. **Use checks for verification** — Set `checks` on goal creation to auto-verify completion (e.g., `["npm test", "test -f README.md"]`).
6. **Set safety budgets** — Use `maxTurns`, `maxNoProgress`, and `maxFailures` to prevent runaway goals.
7. **Compact periodically** — Use `compactEvery` to keep the worker session's context manageable.

## Example: Creating and Monitoring a Goal

**Parent chat:**
```
User: Write a README for this project and create a changelog.

Agent: I'll set up a background goal for this.

loopd_create_goal({
  name: "docs-write",
  objective: "Write a README.md covering: what it is, install, usage, architecture, and examples. Then create CHANGELOG.md with a v1.0.0 entry.",
  checks: ["test -f README.md", "test -f CHANGELOG.md"],
  progressFile: ".opencode/loopd/docs-progress.md",
  maxTurns: 20
})

# Goal starts. User can monitor with /loop.
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
