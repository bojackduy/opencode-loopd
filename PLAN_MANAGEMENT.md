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
- [ ] P1: cross-dir create path + live two-directory test
- [ ] P2: engine-per-managed-dir
- [ ] P3: multi-dir owner tools + aggregated list
- [ ] P4: multi-project TUI view
- [ ] P5: management-mode conventions doc
