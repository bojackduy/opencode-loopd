# Ticket-per-Scope Plan — survives compaction

## Objective
Redesign Opencode Loopd plugin concurrency from global workspace lock to ticket-per-file model. Ship non-stop until tests + shelf-test pass via shell/opencode (no loopd tools).

## User Rules (never break across compaction)
- Never ask for repeated approvals; execute autonomously.
- Never weaken tests/checks to pass — fix code or update expectations to queued semantics only when semantics changed.
- Do not modify other projects.
- Commit split by blast radius; push when asked (now: push allowed after build).
- Ticket model must hold: per-scope granularity (per file set, empty=exclusive), queue FIFO with owner priority, shell never blocked (prompt-awareness only on initial+nudge), replace write_scope global lock with ticket, fail-tolerance (crash must not hold lock forever), engine as OS scheduler (interrupt/wake).
- Shell/opencode shelf-test mandatory; never use loopd tools for shelf-test.
- Caveman voice in chat (terse, one idea/sentence, payload verbatim). Code/comments/commits stay normal prose.
- Surgical changes: touch only needed lines, match existing style, no speculative features.
- Verification before completion: bun test + typecheck + build must pass before push/restart.

## Architecture Decisions (locked)
- State: `src/infrastructure/state-repository.ts` `CURRENT_VERSION 10`, `writeTickets { holders: WriteTicket[], queue: WriteWaiter }` with migration.
- WriteTicket { ticketID, goalID, sessionID, callID, files[], grantedAt, generation }, WriteWaiter { waiterID, goalID, sessionID, callID, files[], requestedAt, isOwner }.
- Helpers in `src/application/workspace-execution.ts`: `ticketHolders/queue/ensureTickets/filesOverlap/canGrantTicket/queuePosition`.
- `beforeWorkspaceTool`: readTools exempt; shell/uncontrolled never ticketed (record workspaceCalls uncontrolled, allow concurrently, worker shell denied); structured writes use ticket: reclaim terminal holders, `canGrantTicket` checks both holders + legacy `workspaceCalls` overlapping files (`filesOverlap`), if overlap queue (owner priority splice) and throw `Write ticket queued ... position N`, else grant holder + push workspaceCalls.
- `afterWorkspaceTool`: remove holder & queue entry by callID, then grant next waiters in queue order where `canGrantTicket` passes (allow disjoint files together).
- `withWorkspaceOperation` (checks): reclaim terminal holders, then block if `workspaceOperation` OR `holders.length>0` OR `hasUncontrolled` OR `hasLegacyWrite` (`workspaceCalls` with paths>0). This fences checks until quiescent but allows shells.
- `assertScopeAvailable`: unchanged except must still fence activation; legacy call overlap still fences.
- `canGrantTicket` legacy check: `(workspaceCalls ?? []).some(c => !c.uncontrolled && filesOverlap(c.paths, files))`.
- Host proof: `isMainSession` outside transaction; no network I/O while holding lock.
- TUI theme: `adaptThemeV2` probing hue/feedback/background/raised/border + loopd violet/pink/mint fallbacks.
- Plugin: `src/server/plugin.ts` trace `tool.call.started/finished/denied`, `beforeWorkspaceTool` wiring.

## Work State
### Completed (committed or working dir)
- State version 10 + migration, ticket helpers, shell prompt-awareness, queue grant logic.
- Test fixes: `test/infrastructure/state-store.test.ts` expect 10 + writeTickets; `test/application/owner-workspace-execution.test.ts` shell concurrency + checks fence; `test/server/workspace-execution.test.ts` queued vs being written, unrecognized vs uncontrolled split; `test/application/control-worker-release.test.ts` queued regex; `test/server/v2-orchestration.test.ts` queued regex; `src/application/workspace-execution.ts` canGrant + withWorkspaceOperation legacy fences.
- Result: `bun test` 990 pass 0 fail, `tsc --noEmit` pass.

### Done (c0bc5c4 live)
- Committed `25fd49b` persist queued ticket (throw outside mutate) + `e579231` reclaim deleted/terminal holders + `c0bc5c4` periodic sweep (reaps dead holders/waiters, promotes grantable waiters; engine maintenance + goal reconcile log `reapedTickets`).
- Verified `bun run typecheck` pass, `bun test` 990 pass 0 fail, `bun run build` dist/server.js 557K, pushed to master.
- Real-terminal shelf test via shell (real `bun run` OS process, no loopd tools): `Promise.all` disjoint writes both fulfilled holders=2, overlap queued position 1, sweep reaped `["dead","dead-wait"]` promoted `live-wait` to holder, owner write correctly queued behind live holder.
- Real opencode check: `opencode --version` v2.2.3, `opencode service status` live, `opencode plugin list` shows `opencode-loopd.server 1.14.6 file:/Users/duytrinh/Code/opencode-loopd`.
- `opencode service restart` done; `/tmp/loopd-server.log` shows post-restart `tool.call.started` for opencode-loopd.
- Skill doc touched up: WorkspaceWrite bullet, new "Write tickets (per-scope concurrency)" section, owner coordination + command fence bullets fixed to ticket model.

### Blocked
- None.

## Next Moves (ordered, verify per step)
1. `git status --short; git diff --stat` → stage `src/application/workspace-execution.ts` + 2 test files.
2. `git commit -q -m "fix(workspace): legacy fence + queued semantics + terminal sweep"` 
3. `bun run typecheck && bun test 2>&1 | tail -5` → expect 990 pass.
4. `bun run build 2>&1 | tail -10` → verify dist mtime.
5. `git add dist && git commit -q -m "chore: build dist for ticket model" || true` (if dist tracked).
6. `git push` (user allowed push when asked — now after build; push directly).
7. `opencode service restart` + `sleep 2 && cat /tmp/loopd-server.log | tail -20` to confirm new version trace.
8. Shelf-test: use `shell` tool (not loopd tools) to create two goals via `opencode` CLI with disjoint `write_scope` (e.g., `src/a.ts` vs `src/b.ts`), start writes, check `state.json` holders =2, then overlapping `src/a.ts` queues, release one holder via after hook, verify queue grants. Also run `tick` via shell and dashboard.

## Relevant Files
- `src/application/workspace-execution.ts` — ticket core (TO EDIT LAST: withWorkspaceOperation sweep already done)
- `src/infrastructure/state-repository.ts` — version 10, writeTickets types/migration
- `src/domain/goal.ts` — `isTerminal` used for reclaim
- `test/infrastructure/state-store.test.ts`, `test/application/owner-workspace-execution.test.ts`, `test/server/workspace-execution.test.ts`, `test/server/v2-orchestration.test.ts`, `test/application/control-worker-release.test.ts`, `test/server/goal-delivery-regression.test.ts`, `test/application/workspace-recovery.test.ts` — updated expectations
- `src/server/plugin.ts` — trace + before hook
- `skills/loopd/SKILL.md` — calling convention ticket/grant docs (update if needed after shelf-test)
- `/tmp/loopd-server.log` — flow trace source of truth
- `~/.config/opencode/opencode.jsonc` — `plugins: ["file:/Users/duytrinh/Code/opencode-loopd"]`

## Constraints to not lose
- Do not reintroduce `assertCommandQuiescence` global fences; commands/shells coexist with tickets when files disjoint.
- Do not make shell ticketed; shell stays prompt-awareness only.
- Empty file list = exclusive (filesOverlap true).
- After-hook must grant queued disjoint waiters; preserve owner priority insertion.
- Checks must see both holders and legacy workspaceCalls; shell must not be blocked by sibling holders (single-human concurrency).
- Crash fail-tolerance: reclaim terminal holders in beforeWorkspaceTool + withWorkspaceOperation; consider adding to reconcile/sweep for background release.

## Commands Cheat Sheet
```
bun test 2>&1 | grep -E "fail\)|pass" | tail
bun run typecheck
bun run build
git log --oneline -5
opencode service restart
cat /tmp/loopd-server.log | tail -30
# shelf-test via shell tool only, not loopd_create_goal
```

## Definition of Done
- 990 tests pass, typecheck pass, build pass, dist rebuilt, push done, service restarted, shelf-test log shows ticket.granted for disjoint parallel writes + queued + granted after release + checks quiescence.

## Known issue (found while recording the TUI demo, 2026-10-30)
- Loop Dashboard dialog paints once with pre-refresh state ("0 open / 0 done")
  and never picks up the async refresh, even though the same data path
  (`createDashboardRefresh` + `getState`) returns the 2 complete goals headless.
  Footer placeholder (host-rendered) updates, dialog body does not.
- Suspect: host TUI renderer does not re-render plugin dialog content after
  mount, or a Solid signal/propagation break in the dialog tree.
- Demo works around it: dashboard shown empty BEFORE the work (honest),
  agent work + file results carry the story. Repro: open `/loop` with
  completed goals in store -> still shows 0 done. Debug line was added and
  reverted (`dbg store goals=`).
