# AGENTS.md — opencode-loopd ground rules

1. NO UNIT TESTS. Never create, edit, or run test files. No `bun test`, no new files under `test/`, no temp render checks committed. Verification = `bun run typecheck` + live shelf-test via shell/opencode only.
2. Surgical changes. Touch only asked files. Match existing style.
3. Shell never fenced. Prompt-awareness only, recorded uncontrolled. Real enforcement = write tickets + checks quiescence.
4. `report_goal_progress`: `summary` + `next` required, `evidence` optional.
5. dist/ is tracked. Rebuild + commit + `opencode service restart` for live changes.
