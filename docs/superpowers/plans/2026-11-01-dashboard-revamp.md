# Dashboard Revamp — Implementation Plan (2026-11-01)

Design: `docs/superpowers/specs/2026-11-01-dashboard-design.md`.
Prototype: `docs/superpowers/prototypes/2026-11-01-dashboard.html` (visual/interaction truth, mock data).

## Goal

Implement the approved 3-tab dashboard natively in the existing OpenTUI/Solid dashboard. Same constraints as the design doc. No unit tests at any point.

## Architecture

New pure-presenter module + two view components behind the existing shell; registry rows for every new binding; per-directory control clients for foreign actions. See design doc.

## Tech Stack

Existing OpenTUI/Solid stack only. No new dependencies.

## Spec

Per design doc. Rows name/state/activity/updated; inspector pinned compact; technical drawer complete; coordination strip project-scoped with Writes/Verification/Reservations; keyboard map per design; selection by directory+ID.

## Global Constraints

Per design doc, plus: sequential slices below in order; one structured edit at a time; compile only when implementation is ready (`bun run typecheck` then `bun run build`); `run_goal_checks` or `await_quiescence` for busy waits, no polling; no commits/pushes/restarts.

## Review Focus

Per design doc section.

## Deliverables (sequential — do not parallelize)

- [ ] 1. Registry rows: add `s` (send), `d` (details, uiOnly), `o`/`open` (already present — verify), `t` (coordination drawer, uiOnly), `/` filter (uiOnly), `h` history (uiOnly), `Enter` actions palette, `1/2/3` tabs. Check: registry lists every new binding; `test/domain/parity.test.ts` expectations still satisfiable (read-only review, do NOT run it).
- [ ] 2. `src/tui/dashboard-presentation.ts` (new): pure functions — row model (name/state/activity/updated), scope summary counts, state-vs-activity classification (working/paused/awaiting/blocked/limited), group-by-directory + collapse, age/countdown text. Check: import it from a scratch readout and eyeball outputs for blocked/paused/working samples (no committed check files).
- [ ] 3. `src/tui/dashboard-view.ts` (extend): view type `project | fleet | commands`, per-tab selection kept separately, history flag, filter text, collapse set, selection helpers keyed by directory+ID. Check: selection stable across a simulated refresh (manual reason-through + read-back).
- [ ] 4. Header + tabs + toolbar in `dashboard.tsx`: project scope header, 1/2/3 tabs, search input + project picker + history toggle. `h` moves to history; keep `l→commands`. Check: Tab/`h`/`l`/`1/2/3` no longer collide (`?` help lists each once).
- [ ] 5. Worker table (Project + Fleet): compact rows via presenters, Fleet groups/collapses by directory with focus-project action. Check: rows show 4 columns only; Fleet group headers show per-project needs-action/working counts.
- [ ] 6. `src/tui/goal-details.tsx` (new): pinned inspector (latest result/blocker + Send/Open/Actions/Details + Fleet focus) + technical drawer (full objective, model/agent/budgets/turns, scope, checks, transcript/progress/history, raw IDs). Check: every row field from the old detail panel appears either in inspector or drawer — nothing lost.
- [ ] 7. Actions palette + dialogs: state-correct verbs, directory+ID targeting, send dialog, confirmation for release/force/clear. Check: palette on blocked offers retry/pause only; on paused offers resume only; confirmations name the exact target.
- [ ] 8. `src/tui/coordination-panel.tsx` (new): project-scoped Writes/Verification/Reservations triage reusing `release_workspace` report + safety; foreign projects show own coordination; live/foreign/unknown disabled with reasons; stale release refreshes authoritative state. Check: numbers match direct store reads for a live ticket + a queued waiter + one uncontrolled call.
- [ ] 9. Foreign routing: per-directory `createControlClient(goalDir)` for actions on foreign rows; honest timeout surfaces; session-open fallback where native navigate unsupported. Check: mutating a foreign row never touches the local bus (read the call path; no live second project required).
- [ ] 10. Keyboard/focus/small-terminal pass: input isolation, focus return, Esc stack, bounded scroll everywhere, short-terminal sanity. Check: type `s`, `d`, `/` into inputs without firing actions; Esc closes topmost only.
- [ ] 11. Final compile: `bun run typecheck`, then `bun run build`. Check: both exit 0. Then `run_goal_checks`. Record outputs + self-review (diff vs requirements) in artifact progress. No commits/pushes/restarts.
