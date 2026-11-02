# Actions Dropdown Implementation Plan

> **For agentic workers:** Use executing-plans to implement this approved surgical change.

**Goal:** Anchored Actions menu, isolated popup keys, correct Details and Coordination navigation.

**Architecture:** Reuse the project menu's relative anchor, bounded list, host colors, and above-anchor fallback. Forward popup navigation from a high-priority native keymap into the existing handler, using event consumption to prevent duplicate dispatch.

**Tech Stack:** Solid, OpenTUI, TypeScript, Bun.

**Spec:** `docs/superpowers/specs/2026-11-02-actions-dropdown-design.md`.

## Global constraints

No unit tests or test-file changes. No dependencies, backend changes, commit, or restart. Preserve unrelated files. Build tracked distribution output.

## Review focus

- Short/narrow terminals: bound menu width/rows and choose above-anchor placement.
- Repeated popup navigation: one shared handler and consumed-event guard prevent double movement.
- Shift+Tab: reverse Coordination order and wrap without changing main tabs.
- Escape: dismiss only the active child popup, including fullscreen Commands.
- Actions: keep availability, direct shortcuts, and destructive confirmation paths unchanged.

## Task

- [x] Inspect Actions rendering, Details scroll API, Coordination routing, and host keymap precedence.
- [x] Add Actions button anchor/menu slot in goal-details.tsx and anchored DashboardList in dashboard.tsx; remove the old framed Actions view from modal replacement rendering.
- [x] Share popup keyboard dispatch with a high-priority layer in plugin.tsx, retaining consumed-event guards.
- [x] Separate one-line Details steps from viewport page steps; reverse Coordination Tab when shift is present.
- [x] Run trusted typecheck, build, and diff-check; review the final diff.
- [x] Record actual runtime evidence or the exact missing live-verification surface.

## Verification evidence

Initial approved typecheck after implementation exited 0. Configured host checks (`bun run typecheck`, `bun run build`, `git diff --check`) returned `ok:true, passed:true, failures:[]`. Reviewed the source diff; existing commands and confirmation calls remain unchanged. Rebuilt tracked dist/tui.js.

Live visual/keyboard behavior and latency remain UNVERIFIED. Discovery for `opencode TUI keyboard capture screenshot` surfaced browser capture tools, not a native TUI input/capture driver; this goal has no approved interactive launcher. No user session was driven or service restarted. The routing fix closes a source-visible host-keymap precedence gap; it does not establish a measured latency cause or speedup.
