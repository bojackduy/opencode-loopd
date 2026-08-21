# opencode-loopd

**Background goal engine for OpenCode** — run long-running tasks as autonomous child sessions while the main chat stays interactive.

## What it is

opencode-loopd is an OpenCode plugin that creates background goals with dedicated worker sessions. The parent chat stays interactive while work happens behind the scenes. You can observe, steer, pause, or stop goals at any time.

## Install

### Manual

Add to `~/.config/opencode/opencode.jsonc`:

```json
{
  "plugin": [
    "/Users/you/Code/opencode-loopd"
  ]
}
```

### npx (coming soon)

```bash
npx -y opencode-loopd
```

Then restart OpenCode.

## Usage

### Create a goal

From any session, tell the agent:

```
Create a background goal to fetch the latest AI news and save 10 items to ai-news.md
```

The agent will use `loopd_create_goal` to start the goal.

### Monitor with dashboard

Press `Ctrl+L` or open the command palette → "Loop Dashboard".

Dashboard shortcuts:
- `j/k` — move selection
- `g/G` — jump to top/bottom
- `o` — open child session (full transcript)
- `p/r/R/x` — pause / resume / retry / clear selected goal
- `?` — toggle help
- `:` — enter insert mode (send message, control commands)
- `Ctrl+N` — return to normal mode
- `q` — close

### Inspect from main agent

The main agent can use these tools:

```
list_background_goals()          — status snapshot
inspect_background_goal()        — full detail
read_goal_transcript()           — child session transcript
send_goal_input(goalID, msg)     — send instruction to child
pause_goal(goalID)               — pause
resume_goal(goalID)              — resume
clear_goal(goalID)               — stop and remove
```

### Worker tools (child session)

The child worker has these tools:

- `get_goal` — read objective, state, criteria
- `report_goal_progress` — report what was done
- `complete_goal` — mark done (must pass checks)
- `block_goal` — mark blocked (needs user)
- `question` (OpenCode builtin) — ask the user; appears in the TUI footer

## Architecture

```
Main session (parent)
  ↕ owner tools: inspect, steer, pause
Loopd engine
  ↕ continuation steering + accumulated context
Child worker session
  ↕ goal tools: progress, complete, block, ask
```

- **Engine-driven loop**: child works → idle detected → engine re-prompts with accumulated context
- **Parent visibility**: owner tools read child transcript, progress history, and current state
- **Bidirectional messaging**: inbox system for user↔child instructions
- **Safety defaults**: maxTurns=50, maxFailures=3

## Example

```
# Create a goal
goal: "Find all .ts files in src/, count lines, write summary to line-counts.md"

# Engine loops automatically
Turn 1: child counts files → reports progress
Turn 2: child sees "batch 1 done" → continues
Turn 3: child finishes → calls complete_goal

# Parent inspects at any time
inspect_background_goal()  → shows turn count, progress, status
read_goal_transcript()     → shows child's work
```

## Configuration

Goals accept these config options:

| Option | Default | Description |
|---|---|---|
| `maxTurns` | 50 | Max continuation turns |
| `maxFailures` | 3 | Max consecutive failures before block |
| `maxNoProgress` | 3 | Turns without progress before block |
| `timeoutMs` | 300000 | Per-turn timeout (5 min) |
| `compactEvery` | — | Compact child session every N turns |
| `checks` | [] | Shell commands that must pass for completion |
| `progressFile` | — | Markdown file for transaction state |

## License

MIT
