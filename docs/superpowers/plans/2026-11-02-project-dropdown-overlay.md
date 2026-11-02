# Project Dropdown Overlay Implementation Plan

> **For agentic workers:** Use executing-plans to implement this approved plan inline.

**Goal:** Show a compact names-only project dropdown without replacing the dashboard.

**Architecture:** Keep existing picker state and separate its visibility from modal
replacement state. Anchor an absolute, bounded list beneath the selector; share
one option list across keyboard movement, initial highlight, and mouse selection.

**Tech Stack:** TypeScript, SolidJS, OpenTUI, existing OpenCode plugin integration.

**Spec:** `docs/superpowers/specs/2026-11-02-project-dropdown-overlay-design.md`

## Global Constraints

- No unit tests or test-file changes. No dependencies or backend edits.
- Preserve unrelated files. Do not commit or restart the service.
- Claim exact source and documentation paths before structured edits.

## Review Focus

- Commands starts at `All projects`: preserve and highlight that option.
- Existing filter and scrolled table: cancel must not unmount or reset either.
- Many projects and small terminals: bound the list and follow the highlight.
- Escape from dialog and fullscreen Commands panel: consume once, leaving host open.
- Mouse events: dropdown choices must not activate the table behind them.

## Task 1: Overlay and keyboard behavior

**Files:** `src/tui/dashboard.tsx`, `src/tui/plugin.tsx`, `dist/tui.js`.

- [x] Derive picker options from the current tab; keep `all` for Commands.
- [x] Open at current scope without refreshing or changing underlying view state.
- [x] Replace the status panel with a toolbar-anchored absolute scrolling list.
- [x] Keep dropdown state out of the modal replacement predicate.
- [x] Route keys to the dropdown before underlying controls; consume Escape once.
- [x] Ensure the host Escape integration also protects fullscreen Commands.
- [x] Review cancellation, option mapping, bounds, and event flow directly in source.
- [x] Run approved typecheck, build, and diff-check; host reports all checks passed.
- [x] Assess a safe live shelf check only if an isolated keyboard surface is available;
      otherwise record keyboard/render behavior as unverified.
- [x] Leave source and rebuilt distribution uncommitted for parent review.

## Execution ruling

Open above the selector only when fewer than three rows remain below it. Review
found that forcing one list row plus two borders below would otherwise overflow.
Normal placement remains directly below; the fallback trades strict below-only
placement for keeping the dropdown visible in short terminals.

## Verification

`run_goal_checks` returned `ok: true`, `passed: true`, `failures: []` for the
configured `bun run typecheck`, `bun run build`, and `git diff --check` commands.
The approved standalone typecheck also returned exit code 0. Status confirms
`dist/tui.js` rebuilt and no backend or `AGENTS.md` changes.

Fresh read-only review found the short-terminal placement risk above; the fallback
addresses it in source. Live visual and keyboard/Escape behavior remain unverified:
tool discovery found no OpenCode TUI keyboard/capture driver, and this scoped goal
has no approved interactive launcher. No service restart or user-session input was
attempted. Compilation and source review are not runtime evidence.
