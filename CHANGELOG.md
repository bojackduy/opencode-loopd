# Changelog

## 1.6.0 (2026-08-24) — Hardened Lifecycle

> Merge `feat/goal-evaluation` (43 files, +5516 / -1001 since `1.5.3` `5461e0d`). Hardens prompt correlation, maintenance recovery, workspace serialization, and evaluator verification.

### Added

- **Prompt correlation & generation fencing** — each turn pre-generates `activePromptMessageID` (`msg-` UUID), correlates `message.updated`/`message.part.updated` by `runGeneration` + `idleCandidateGeneration`; stale `session.idle` can never release a newer lease (`src/application/loop-engine.ts`, `src/domain/runtime.ts:85`, `src/server/worker-session.ts:62`).
- **Transcript anchoring** — finalization requires latest user prompt == engine prompt **and** assistant response `completedAt` (`src/application/loop-engine.ts:438` `inspectPromptTurn`); prevents phantom completions.
- **Workspace serialization** — single active `workspaceWrite:true` writer enforced on `start`/`resume`/`retry` with rollback; safe default `workspaceWrite=true`; `goal-policy.ts:37` shared by tool + control bus (`src/application/goal-service.ts:79`, `src/application/control-worker.ts:158`).
- **Contract validation** — `defaultAgent`/`defaultChecks` plugin options (`src/server/plugin.ts:152` `parsePluginDefaults`), mandatory `checks` for writers, `checkCwd` defaults to project root for writers / `artifactDir` for readers (`src/application/goal-policy.ts:16`, `src/domain/goal.ts:97` `maxEvaluatorRejections`).
- **Verification tracking** — new domain `src/domain/verification.ts:4` `VerificationAttempt` (id, sequence, runGeneration, cwd, checks with `stdout`/`stderr`), bounded `recentVerificationAttempts` (10), exposed in `get_goal` runtime.
- **Evaluator rejection event** — `goal.completion_rejected` (`src/domain/events.ts:52`) with `attemptID`, `rejectionCount`, `failureSummary`; `freeRetryPending` prevents `budgetTurnCount` charge for <3 rejections, `blocked` after 3 (`src/server/goal-tools.ts:298`).
- **Recovery tool** — `nudge_goal` force re-prompts stuck `active` worker: clears `activeRunID`/`idleCandidate`/`activePromptMessageID`/lease (`phase→idle`) and calls `continueTurn({force:true})` (`src/application/goal-service.ts:696`, `src/server/owner-tools.ts:334`).
- **Tool-call guard** — `activeToolCallIDs: string[]` tracked via `tool.execute.before/after` (`src/server/plugin.ts:67`), blocks idle finalization while tools run (`src/domain/runtime.ts:244` `hasActiveToolCalls`).
- **Maintenance (30s)** — auto-clears stale `phase=idle + activeRunID`, bounds `unknown` status polls (`unknownStatusCount` threshold 3 → one `notifyOwner` per episode via `workerUnreachableNotifiedAt`), recovers counters on success, `active`-only polling (`src/application/loop-engine.ts:694`).
- **Per-goal mutex** — `withGoalOperation(goalID)` serializes `continueTurn`/`pause`/`resume`/`retry`/`clear`/`nudge` and re-checks `leaseIsValid` inside `turn.acquire` transaction (`src/application/goal-service.ts:64`).
- **State migrations v3→v5** — `turnCount → budgetTurnCount + runCount + runGeneration`, `freeRetryPending`, verification fields, `workspaceWrite` default, `activePromptObservedAt`/`unknownStatusCount` (`src/infrastructure/state-repository.ts:178`).
- **Docs** — `skills/loopd/SKILL.md` expanded Contract & Evaluation Semantics, Hardened loop guarantees, Owner/Worker tool refs, Safety Patterns; `docs/planning/remaining-work.md`, `docs/reports/final-report.md`, `docs/bugs/bugs-new.md`, `docs/development/testing-context.md`, `commands/goal.md` updated.

### Changed

- **Loop engine idle** — two-stage debounce `CONFIRM_IDLE_DURATION_MS=2000` requires two `session.idle` 2s apart with no `lastActivityAt` in between; `session.status` handler removed in favor of `session.idle` + `message.*` activity (`src/application/loop-engine.ts:245`, `src/application/loop-engine.ts:183` test).
- **Budget split** — `turnCount` → `budgetTurnCount` (charged) vs `runCount` (monotonic) vs `runGeneration` (fence); `freeRetryPending` path does not bump budget (`src/domain/runtime.ts:39`, `src/application/goal-service.ts:361`).
- **Host adapter** — `sessionStatus` returns `unknown` (was `idle`) for missing status; `promptWorker` sends `messageID` and collapses duplicate `msg-` prefixes; `readMessages` returns `messageID`/`parentMessageID`/`completedAt` (`src/server/host-adapter.ts:88`, `src/server/host-adapter.ts:113`).
- **State repository locking** — `acquireLock` uses `fs.open wx` direct (was `tmp+rename` TOCTOU); `releaseLock` re-verifies `acquiredAt`/`pid` before `rm`; stale `LOCK_STALE_MS=10s`, retry 25ms backoff (`src/infrastructure/state-repository.ts:68`).
- **Goal tools descriptions** — all 5 tools rewritten to reflect host-acceptance semantics (rejection/free retry/blocked, `workspaceWrite` serialization, `checkCwd`) (`src/server/goal-tools.ts:35`, `src/server/owner-tools.ts:19`).
- **Review fixes (PR follow-up `392ecee`)** — `runCompletionChecks` now captures `stdout`+`stderr` (was stderr-only), `VerificationAttempt` stores both, `lastRejectionDetails` includes both; `releaseLock` race fixed; `turnCount` migration properly deletes key; `withGoalOperation` documented; `maxEvaluatorRejections` added to `GoalConfig` (`src/domain/goal.ts:97`).

### Fixed

- **Race: prompt to subagent session** (`5a13398`, `e41fb84`) — `promptWorker` `messageID` double-prefix (`msg-msg-`) collapsed; `FakeHost` same.
- **Race: withGoalOperation gate leak** — `gate` never-rejects chain + deletion guard documented.
- **Race: state lock** — `acquireLock` TOCTOU and `releaseLock` fresh-acquirer deletion fixed.
- **Turn accounting** — evaluator rejection no longer `turnCount--` hack; `budgetTurnCount` unchanged, `freeRetryPending` consumed once.
- **Stdout loss** — completion check `stdout` now preserved in rejection evidence (`src/server/goal-tools.ts:253`).
- **Blocked needed message** — `recordPromptFailure` now contextual: API unavailable only for `blockImmediately`, else `Fix error and retry_goal` (`src/application/goal-service.ts:92`).
- **Dashboard keybinding** — `o` for open child, `L` log toggle (`5921ec5`).
- **Docs refs** — kebab paths `bugs/bugs-new.md`, reports index (`12ad22e`, `78c63b3`).

### Tests & Build

- 159 tests pass (15 files, 386 expects); new suites: `goal-policy.test.ts:43`, `loop-engine` generation-fence/transcript-anchor/unknown-status/stale-run, `goal-service` acquire-race/concurrent/pause-fence/nudge/workspace-serialization, `state-store` v5 migration.
- `dist/server.js` 129KB / `dist/tui.js` 66KB rebuilt (`07ad6c0` `bun run build`).

## 1.0.1 (2026-08-21)

### Changed

- Removed redundant `ask_user` tool and `awaiting_user` status. Workers now use OpenCode's native `question` tool for clarification — questions appear in the TUI footer as blocker tabs, no goal status change needed.
- Removed `:answer` dashboard command (native question answers flow through OpenCode).

## 1.0.0 (2026-08-21)

### Features

- **Goal lifecycle**: create, active, pause, resume, retry, clear, complete, blocked
- **Engine-driven loop**: idle detection → continuation steering → automatic re-prompt
- **Continuation steering**: accumulated context (progress history, transcript tail, inbox messages)
- **Worker tools**: get_goal, report_goal_progress, complete_goal, block_goal (clarification via OpenCode's native `question` tool)
- **Owner tools**: list_background_goals, inspect_background_goal, read_goal_transcript, send_goal_input, pause_goal, resume_goal, clear_goal
- **Inbox system**: bidirectional user↔child messaging
- **Dashboard**: goal list, detail view, question banner, mode switch (NORMAL/INSERT), keyboard shortcuts
- **Safety defaults**: maxTurns=50, maxFailures=3
- **Server/TUI debug logging**: /tmp/loopd-server.log, /tmp/loopd-tui.log
- **Skill file**: agent guidance for goal lifecycle at ~/.config/opencode/skills/loopd/SKILL.md

### Architecture

- Engine-driven loop (same as Codex): idle event → continuation steering → child continues
- Parent visibility layer: owner tools read child transcript, progress, and state
- Bidirectional messaging: inbox system for user→child instructions
- Awaiting_user status: child can pause and ask questions
