# Dashboard Revamp — Design Spec (2026-11-01)

Source of truth: `docs/superpowers/prototypes/2026-11-01-dashboard.html` (SHA256 `05891b21…5b35a`, byte-copied, never hand-edited).
Target: native OpenCode OpenTUI/Solid dashboard (`/loop`), not a web app. No new dependencies.

## Goal

Replace the overloaded single-screen dashboard (everything inline: model/agent/tokens/IDs per row, full-detail panel, bare "N fences" with no affordance) with a three-tab worker-management surface:

- **Project tab** — one managed directory: compact summary, search + project picker + history toggle, readable worker table (name/state/current activity/updated only), pinned compact inspector, technical detail drawer.
- **Fleet tab** — same table grouped/collapsed by directory, focus-project action, same inspector/actions per worker.
- **Commands tab** — current full streaming/PTY/fullscreen `CommandPanel` behavior, untouched internals.
- **Coordination strip** — project-scoped triage above the footer: real write holders (files+ages), queued write requests with conflicting holders, real verification blockers, reservations with release safety. Foreign projects show their own coordination, never a global count.

## Architecture

```
dashboard.tsx            thin shell: signals, keyboard, tab routing, refresh
dashboard-presentation.ts pure presenters (no Solid): row text, summary counts,
                          state/activity labels, age/countdown text, group/collapse
goal-details.tsx          inspector (pinned, compact) + technical drawer/panel
coordination-panel.tsx    triage drawer: Writes / Verification / Reservations
dashboard-view.ts         extended: 3-tab view type, per-tab selection, history
interaction-registry.ts   new rows for s/d/o/t/filter/history/actions
```

- Presentation logic lives in `dashboard-presentation.ts` as pure functions so rows/summary/grouping are reviewable without rendering.
- `dashboard.tsx` keeps refresh, control clients (one per directory — created on demand via existing `createControlClient(dir)`, never a local fallback for foreign goals), keyboard map, and dialog/focus management.
- Foreign worker actions route through the correct per-directory client or existing safe routing. A target with no live control worker surfaces the client's honest timeout, never fake success. No automatic cross-project engine provisioning (out of scope).
- Foreign session open uses supported native `route.navigate("session", …)`; where the host cannot open a foreign session, show transcript fallback/instructions instead of corrupting the parent route.
- Commands internals (terminal/emulator/panel) are not rewritten.

## Tech Stack

Existing only: OpenTUI `@opentui/solid` + `@opentui/core`, Solid signals, file-backed control bus (`createControlClient`), `readState` per directory, current theme object. In-theme overlay boxes for dialogs (same pattern as the existing help panel) — no native dialog renderable is used inside the dashboard today.

## Spec

**Header:** `LOOPD` + scope (project name, or "All projects" on Fleet, or "Command sessions") + compact scope summary. No giant done count; completed hidden by default.

**Tabs:** `1/2/3` select Project/Fleet/Commands. `j/k`/arrows move, `g/G` first/last (keep). `h` becomes history toggle (replaces old `h→goals`; `1` covers it). `l` keeps `→commands`. `/` focuses filter, `?` help overlay, `Esc` dismisses topmost (details → dialog → input).

**Rows:** name / state / current activity / updated. No model/agent/token/IDs. State vs activity separated using existing `workerActivityLabel` + status helpers: Working = acting now; Paused = healthy parked; interactive idle with confirmed idle + no run + no queued input = awaiting input (label only then — autonomous idle is never "awaiting input"); blockers/limits/errors = attention.

**Inspector (pinned, compact):** latest meaningful result or blocker + buttons Send(`s`) / Open session(`o`) / Actions(`Enter`) / Details(`d`); Fleet adds Focus project. Same everywhere.

**Technical drawer:** full objective, model/agent/budgets/turns, exact scope + checks, transcript/progress/history, raw IDs. Nothing discarded, nothing irretrievably truncated.

**Actions palette (`Enter`):** state-correct verbs only (pause/nudge/retry/resume/clear/abort/force/block/send/open/transcript). Never targets hidden/stale rows or same-named projects: selection key is directory+ID, stable across refresh/filter/history/collapse.

**Coordination strip (selected PROJECT context):** writes = actual ticket holders with exact files + ages; queued = real queued write requests + conflicting holders/priority (scope claims are NOT a queue — never presented as one); verification = actual operation/ticket/uncontrolled/legacy blockers, never bare "fences". Reservations reuse the existing `release_workspace` report + release safety: exact call/session/goal, server releasable/reason, confirmation before targeted release; live/foreign/unknown entries disabled with the actual reason. Never infer staleness from age alone. Releasing a stale item refreshes authoritative state and must not falsely clear another live blocker.

**Inputs/modals:** shortcuts isolated (no shortcut chars entering text); focus returns to the list; parent actions cannot fire accidentally. Overlays usable in small/short terminals with bounded scroll.

## Global Constraints

- `AGENTS.md`: NO UNIT TESTS. No test files created/edited/run, no `bun test`, no committed render checks.
- Ownership/quiescence/scope semantics untouched. No manual ticket mutation to get checks green.
- No new dependencies, no web visuals. Reuse theme + control/goal services.
- One structured edit at a time; never hand-edit the prototype.
- No git commits/pushes/service restarts (parent owns review + finalize).
- New key/colon bindings get `interaction-registry.ts` rows (parity test enforces it).

## Review Focus

1. Selection identity (directory+ID) survives refresh/filter/collapse/history — no action lands on a hidden/stale/same-named row.
2. State vs activity labels: no autonomous-idle "awaiting input", no lost blocker/error signal.
3. Coordination numbers equal authoritative store reads; release confirmations target exactly one reservation.
4. Foreign actions use per-directory clients; timeouts honest; no local fallback, no fake success.
5. Keyboard isolation in inputs/modals; focus return; small-terminal usability.
6. Completed-hidden default with no giant done count anywhere.
