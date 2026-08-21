# Changelog

## 1.0.0 (2026-08-21)

### Features

- **Goal lifecycle**: create, active, pause, resume, retry, clear, complete, blocked, awaiting_user
- **Engine-driven loop**: idle detection → continuation steering → automatic re-prompt
- **Continuation steering**: accumulated context (progress history, transcript tail, inbox messages)
- **Worker tools**: get_goal, report_goal_progress, complete_goal, block_goal, ask_user
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
