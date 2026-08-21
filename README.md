# opencode-loopd

**Codex-inspired background goal engine for OpenCode — autonomous subagents, engine-driven loop, and modal TUI dashboard. Like Claude Code's loop, for OpenCode.**

> Run long-running tasks as **autonomous child sessions** (subagents) while the main chat stays interactive. Create a goal with `/goal`, watch it loop in the background, and monitor everything from a keyboard-driven TUI — without blocking the parent conversation.

[![npm version](https://img.shields.io/npm/v/@bojackduy/opencode-loopd?style=flat-square&color=blue)](https://www.npmjs.com/package/@bojackduy/opencode-loopd)
[![license](https://img.shields.io/badge/license-AGPL--3.0--only-blue?style=flat-square)](LICENSE)
[![opencode plugin](https://img.shields.io/badge/opencode-plugin-9cf?style=flat-square)](https://opencode.ai)
[![TUI](https://img.shields.io/badge/TUI-OpenTUI-purple?style=flat-square)](https://github.com/anomalyco/opentui)

![Loop Dashboard — modal TUI with goals, running indicator, and insert mode](assets/demo.png)

*Modal dashboard (`/loop` / `<leader>d`): zero chat pollution — keys are trapped inside the dialog, NORMAL vs INSERT modes, vivid per-status coloring.*

## Why opencode-loopd

- **Background agents, not blocked chats** — an OpenCode plugin that spawns a dedicated **worker (child) session** per goal. The parent stays free to keep chatting.
- **Codex-style engine-driven loop** — idle detection → continuation steering with accumulated context (progress history, transcript tail, inbox). No prompt spam in the parent.
- **Parent ↔ child visibility** — `list/inspect/read_transcript/send_input` give the parent full observability. Bidirectional inbox lets you steer mid-run.
- **Safe by default** — per-goal artifact isolation (`.opencode/loopd/goals/<id>/`), `maxTurns`/`maxFailures`/`maxNoProgress`, force-finish → semantic `complete_goal` summary → parent notification via wake-up injection.
- **Modal TUI dashboard** — `<leader>d` or `/loop` opens a focused dialog (no leak to chat prompt). Vim-style navigation, live running indicator, per-status borders.

Keywords: `opencode` `opencode-plugin` `background-agent` `autonomous` `subagent` `loop` `goal` `tui` `codex` `claude-code` `worker`

## What it is

opencode-loopd is an **OpenCode plugin** (server + TUI) that adds **background goals** to OpenCode. Each goal owns a **worker (child) subagent** that loops autonomously; the **loop engine** drives continuations; the **dashboard** and **owner tools** keep the parent in control. Think *Codex goals* or *Claude Code loop*, but native to OpenCode's session model.

## Install

### Plugin — simple (no installer, just the plugin)

Add the package to **both** configs.

**`~/.config/opencode/opencode.jsonc`** — server engine:

```jsonc
{
  "plugin": ["@bojackduy/opencode-loopd"]
}
```

**`~/.config/opencode/tui.json`** — dashboard (modal TUI):

```jsonc
{
  "plugin": ["@bojackduy/opencode-loopd"]
}
```

Then restart OpenCode. Verify with `/loop` (palette → Loop Dashboard) or `<leader>d`.

For a local checkout:

```jsonc
// opencode.jsonc
{ "plugin": ["./path/to/opencode-loopd"] }
// tui.json
{ "plugin": ["./path/to/opencode-loopd"] }
```

### Installer — also installs `/goal` + skill

```bash
npx -y @bojackduy/opencode-loopd@latest
```

Registers the plugin, installs the `/goal` slash command and the `loopd` skill into `~/.config/opencode/`. Run again to update. Then **restart OpenCode**.

Uninstall:

```bash
npx -y @bojackduy/opencode-loopd@latest --uninstall
```

Or via global npm:

```bash
npm install -g @bojackduy/opencode-loopd@latest
opencode-loopd            # install
opencode-loopd --uninstall # remove
```

Then restart OpenCode.

### Manual (local dev)

Add to `~/.config/opencode/opencode.jsonc`:

```json
{
  "plugin": ["@bojackduy/opencode-loopd"]
}
```

Or for local checkout:

```json
{
  "plugin": ["/Users/you/Code/opencode-loopd"]
}
```

`opencode-loopd` exposes:
- `opencode-loopd/server` → engine plugin
- `opencode-loopd/tui` → dashboard plugin

## Usage

### 1. Create a goal — `/goal`

From any session, tell the agent:

```
/goal fetch the latest AI news and save 10 items to ai-news.md
```

Or be explicit:

```
Create a background goal to find all .ts files in src/, count lines, and write the summary to line-counts.md — verify with grep -c.
```

The agent will clarify (what/where/how to verify) and then call `loopd_create_goal`. The worker starts immediately in a hidden child session.

### 2. Monitor with dashboard — `/loop`

Press **`<leader>d`** or open the command palette → **"Loop Dashboard"** (also `/loop`).

Dashboard (NORMAL / INSERT `:`):

- `j/k` — move selection
- `g/G` — top / bottom
- `o` — open child session (full transcript, native OpenCode view)
- `p/r/R/x` — pause / resume / retry / clear selected goal
- `:` — insert mode → `:send <message>` to steer, `:force` / `:block` to finish manually
- `?` — toggle help — help stays open while you type
- `Ctrl+N` — back to NORMAL
- `q` — close

> The dashboard traps all keys — even when open via the palette, the chat input cursor won't blink underneath.

### 3. Inspect from the main agent (owner tools)

The parent never needs the dashboard — it can ask:

```
list_background_goals()          — status snapshot
inspect_background_goal()        — full detail: objective, progress, blocker, runtime
read_goal_transcript()           — last N worker messages (what it's doing)
send_goal_input(goalID, msg)     — steer: "skip appendix PDFs"
pause_goal(goalID) / resume / clear
```

### 4. Worker tools (child session)

The child sees:

- `get_goal` — read objective, contract, progress, failures
- `report_goal_progress` — after durable writes
- `complete_goal` — only when checks pass, with evidence
- `block_goal` — real blocker needing user
- `question` (OpenCode builtin) — clarification → TUI blocker tab

Completion is semantic: the child writes the summary; the plugin forwards it to the parent via wake-up injection. If limits are hit, the engine first force-asks the child to `complete_goal`; only if ignored does it auto-block with a generic message.

## Architecture

```
                        ┌─────────────────────────┐
                        │  Main session (parent)  │
                        │  owner tools            │
                        │  inspect / steer / pause│
                        └────────────┬────────────┘
                                     │  inbox → child
                                     │  wake-up ← engine
             ┌───────────────────────┼───────────────────────┐
             ▼                       ▼                       ▼
        ┌─────────┐           ┌──────────┐            ┌─────────┐
        │  Goal A │           │  Goal B  │            │  Goal C │
        │ active  │           │ blocked  │            │  paused │
        └────┬────┘           └────┬─────┘            └────┬────┘
             │                     │                       │
             └─────────────────────┼───────────────────────┘
                                   │
                     ┌─────────────┴─────────────┐
                     ▼                           ▼
              Loopd engine  ──────────►   Child worker (subagent)
              (plugin server)  steering   get_goal / report / complete
                 │  lease / retry / polling       │  block / question
                 │  force-finish / notify         ▼
                 │                         .opencode/loopd/goals/<id>/
                 │                           progress.md / artifacts
                 └─────────────────────────────────┘
```

- **Engine-driven loop** (like Codex): `session.idle` → lease + retry + polling → re-prompt child. Not a parent-driven re-prompt machine.
- **Accumulated context**: each continuation includes progress history, transcript tail, inbox messages, and artifact dir (unless objective names another dir).
- **Parent wake-up**: when the child calls `complete_goal`/`block_goal`, `tool.execute.after` injects the child's semantic summary into the owner's session — you see "Loop goal … completed: …" without polling.

## Artifacts

Every goal writes under its own directory (`.opencode/loopd/goals/<goal-id>/`); `progressFile` defaults there. The dashboard and transcript never pollute the project root. If your objective says `save to ./reports/`, that wins.

## Example — multi-turn with force-finish

```
# Parent: /goal
goal: "Generate 5 files file1..5.md under artifacts/, 2 lines each — verify with glob."
maxTurns: 1

# Turn 1: child writes file1..3, reports progress
# → engine hits maxTurns, injects FINAL REPORT REQUIRED
# Turn 2 (forced): child wraps up, calls complete_goal(summary="created 5 files…", evidence="glob confirmed…")
# → engine forwards to parent: "Loop goal … completed: created 5 files…"
# → Artifacts: .opencode/loopd/goals/<id>/file*.md
```

See `assets/demo.png` above for the dashboard at rest (0 active, 7 done) with vivid status colors, running spinner, and `INSERT` badge.

## Configuration

Goals accept:

| Option | Default | Description |
|---|---|---|
| `maxTurns` | `50` | Max continuation turns before force-finish |
| `maxFailures` | `3` | Consecutive failures before block |
| `maxNoProgress` | `3` | Turns without progress before force-finish |
| `timeoutMs` | `300000` | Per-turn lease (5 min) |
| `compactEvery` | — | Compact child every N turns |
| `checks` | `[]` | Shell commands that must pass for `complete_goal` |
| `progressFile` | `<artifactDir>/progress.md` | Transaction state file |
| `artifactDir` | `goals/<id>/` | Auto — override only if objective names another dir |

Artifacts, logs, and state live under `.opencode/loopd/` (project-local). Locks live in `/tmp/loopd-locks/<project-hash>/` to avoid snapshot noise.

## Dashboard tips

- Press `:` then type bare text → sent as `send_goal_input` to the selected goal.
- Bare `:force my summary --evidence "glob ok"` bypasses verification when the child is stuck.
- `o` jumps to the native OpenCode child session — full transcript, diffs, tool calls.

## Related / SEO

OpenCode plugin for **background agents**, **autonomous subagents**, **loop**, **goal**, **TUI dashboard**, **Codex**-style continuation, **Claude Code** loop alternative, **opencode-tui**, **worker sessions**. Pairs well with `opencode-telescope` (search) and `lazyjira`/`lazyconfluence` (ATUI) from the same author.

## License

AGPL-3.0-only — see [LICENSE](./LICENSE).
