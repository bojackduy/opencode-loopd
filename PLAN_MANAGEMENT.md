# Loopd Management Mode — cross-project goals + continuous development

## Goal
Run loopd goals in OTHER projects from one manager session. No "done":
standing goals per project that keep developing indefinitely, manager
watches and steers across projects.

## Investigation (2026-10-30, code + live API)

### API support: YES
- `session.create` accepts `query: { directory }` (SDK `SessionCreateData`,
  `node_modules/@opencode-ai/sdk/dist/gen/types.gen.d.ts:1811`). Workers can
  live in another project today at the protocol level.
- `opencode run <directory>`, `session_move` prove the server is multi-dir.

### Loopd is already directory-parameterized
- `goalService.start(directory, ...)` — state, artifacts, checks, fences all
  key off the passed dir. Nothing pins a goal to the plugin's own dir except
  the tool wiring (`loopd_create_goal` passes its own `dir`).
- v2 native worker path already forwards `directory` to `requestWorker`
  (`host-adapter.ts:604-619`). Only the v1 path
  (`client.session.create({ body: { parentID, title } })`, line 209-237)
  omits it — workers inherit the parent's dir (fork semantics).

### Gaps to close, in build order
1. **`directory` param on `loopd_create_goal`** (validate: absolute, exists,
   init `.opencode/loopd` if missing). Thread through
   `start(dir)` → `createWorker(goal, dir)` → v1 `session.create` adds
   `query: { directory }`; verify v2 native fork honors it. Live test: goal
   in B from session in A → worker session dir == B, write + checks pass.
2. **Engine per managed dir.** Plugin starts
   engine/control-worker/schedule-worker lazily for ITS directory only
   (`plugin.ts:100-133`). Manager's instance must spin the same trio per
   foreign dir on first use (cheap: 30s/5s/1s timers). Do NOT rely on the
   target project being opened.
3. **Owner tools are single-dir** (`readState(directory)` everywhere in
   `owner-tools.ts`, `goal-tools.ts`). Add `directory` or goalID-routed
   lookup + aggregated list across registered dirs. `list_background_goals`
   ownerSessionID filter works unchanged across stores.
4. **No new semantics needed**: checks (checkCwd defaults to target root),
   fences (per-dir stores, no cross-talk), notifications/liveness (global
   session IDs), scope inference (already takes `directory`).
5. **TUI dashboard is single-dir.** Management wants a multi-project view —
   new UI, or CLI-first `loopd_status_all`.

### Suggested shape
- Manager session anywhere + project registry (config list or convention).
- Standing scheduled goals per project (`scheduleEveryMs` without
  `maxRuns` = infinite dev loop; `interactive:true` where human-gated).
- Manager steers via `send_goal_input`/`nudge_goal` on engine notifications.
- No engine redesign, no new primitives — cross-dir plumbing + aggregation.

### Risks / open questions
- `session.create` with `parentID` in A + `directory` B: does the server
  accept cross-dir parentage? Needs live test (P1).
- Native v2 fork: TUI forks the parent session — verify child actually lands
  in the requested directory, not the parent's (parentage check uses
  parentID, dir is a separate param).
- Goal-ID uniqueness across dirs: IDs are UUIDs, fine. Dashboard/CLI must
  always display the directory alongside the goal.
- Permissions: target dir needs its own `opencode.jsonc` (model,
  permissions). Manager cannot grant what the target host denies.

## Status
- [x] Investigation (this file)
- [x] P1: cross-dir create path + tests (worker session pinned via
      `session.create query.directory` (v1) / root fallback `location`
      (v2, native fork skipped — a fork cannot leave the parent's project).
      Tool arg `directory` validated (absolute, exists, is-dir,
      realpath-canonicalized); state/artifacts/checks/scope keyed off it.
      Engine needs no changes: per-directory plugin instances drive their
      own goals once they exist; turn 1 is prompted directly by start().
      Verified: typecheck + goal-tools/workspace-execution suites green.
      LIVE two-server run (owner in A, worker lands in B, writes + checks
      pass) still needs a host with two projects — owner runbook below.)
- [ ] P2: engine-per-managed-dir
- [ ] P3: multi-dir owner tools + aggregated list
- [ ] P4: multi-project TUI view
- [ ] P5: management-mode conventions doc

### P1 live-verification runbook (owner: run with real sessions)
1. Terminal A: `cd /tmp/proj-a && opencode` (opencode-loopd plugin loaded).
2. Terminal B: `cd /tmp/proj-b && opencode` (loads plugin instance for B;
   create `src/` subdir if you want scope inference to pick files).
3. In A, run tool: `loopd_create_goal({ name: "xdir-probe",
   objective: "write the single line XDIR-OK into probe.txt",
   write_scope: ["probe.txt"], checks: ["grep -q XDIR-OK probe.txt"],
   directory: "/tmp/proj-b" })`.
4. Expect: ok:true, `directory` echoes B; worker session directory == B
   (`loopd_command_get` or session info shows B as cwd).
5. Worker writes `/tmp/proj-b/probe.txt`, checks pass from B's root,
   `complete_goal` accepted. No `invalid_directory`, no scope-denied.
6. Negative probes: `directory: "relative/path"`, a missing path, and a
   file path → each rejected with `invalid_directory`, nothing persisted.
