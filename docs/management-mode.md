# Management Mode — one manager, many projects

Run loopd goals in OTHER projects from one manager session. Standing goals per project keep developing; manager watches and steers.

## Setup

1. Target project needs the plugin loaded (its own instance drives its goals: engine + control-worker + schedule-worker are per-directory, started lazily on first event/goal).
2. Manager registers targets in `.opencode/loopd/managed.json` (absolute paths) or via env `LOOPD_MANAGED_DIRS` (colon-separated, like PATH).
3. Create cross-dir goal: `loopd_create_goal({..., directory: "/abs/target"})`. State, artifacts, checks, worker session live in target. Turn 1 is prompted directly by `start()` — no manager engine needed.

## Daily use

- List across projects: `loopd_status_all({})` → per-dir totals + blocked items with `directory` field.
- Inspect foreign goal: `inspect_background_goal({goal_id, directory: "/abs/target"})` or `list_background_goals({directory})`. Omit `directory` for current project.
- Steer: `send_goal_input` / `nudge_goal` by goal ID (engines route via global session IDs; notifications reach manager).
- TUI: header shows managed count + store path; `:projects` lists managed dirs with counts.

## Rules

- Checks run from target root (`checkCwd` defaults there). Fences are per-dir stores — no cross-talk.
- Scope inference already takes `directory`.
- Goal IDs are UUIDs — always display directory alongside goal.
- Target dir needs its own `opencode.jsonc` (model, permissions). Manager cannot grant what target denies.
- Standing goals: `scheduleEveryMs` without `scheduleMaxRuns` = infinite dev loop; `interactive:true` where human-gated.

## Why no manager engine trio

P1 investigation showed `goalService.start(directory,...)` keys everything off the passed dir, and v1 `session.create query.directory` / v2 root fallback `location.directory` pin the worker in target. Per-directory plugin instances (one per open project) own the 30s/5s/1s timers for their dir. A manager trio would double-drive. So P2 = verified not-needed; aggregation (P3/P4) is the whole feature.
