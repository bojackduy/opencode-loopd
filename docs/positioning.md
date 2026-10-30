# Product Positioning — opencode-loopd

Last updated: 2026-10-28 (release v1.14.6, 990 tests passing)

## 1. Product description

opencode-loopd is an **OpenCode plugin** (server + TUI) that adds
**background goals** to OpenCode. Each goal owns a dedicated **worker (child)
subagent** that loops autonomously on a multi-turn objective; the **loop
engine** drives continuations with accumulated context; the **schedule
worker** requeues the same goal on an interval; the **dashboard** and **owner
tools** keep the parent session in control. Think *Codex goals* or *Claude
Code loop*, native to OpenCode's session model — with scheduled intervals
for repetitive dialogues.

Beyond goals, it ships **command sessions**: raw OS processes (dev servers,
watchers, REPLs, builds) as background interactive terminals with a
fullscreen TUI, owner exit notifications, and line-level watches — instead of
freezing the agent turn in `bash`.

## 2. Primary audience

- **OpenCode users** who run long, multi-step tasks (refactors, research,
  builds, monitoring) and don't want the main chat blocked.
- **Developers who already use Claude Code loop / Codex goals** and want the
  same pattern native to OpenCode, with scheduled intervals and a modal TUI.
- **Solo devs / small teams** running autonomous agents against a real
  codebase, who need verified completion (host-run checks, not model
  self-report).

## 3. User pain points

- The main chat blocks while a long task runs; context gets polluted.
- "Done" claims from agents are unverified — no acceptance gate.
- No way to run a dev server in the background and keep interacting.
- No scheduling: repetitive monitoring needs manual re-invocation.
- No visibility into what a background agent is doing mid-run.

## 4. Value proposition

"Run long tasks as autonomous child sessions while the main chat stays
interactive — with verified completion, scheduling, and a keyboard-driven
dashboard. OpenCode runs the sessions; loopd supervises the goals."

## 5. Differentiators

- **Host-run acceptance checks** (not model self-report) — `checks` must pass
  before `complete_goal` is accepted.
- **Scheduled intervals** (`scheduleEveryMs`/`scheduleMaxRuns`) with
  skip-if-running and serialization — unique vs. Claude Code loop.
- **Command sessions** with fullscreen terminal, watches, timeouts — replaces
  `opencode-pty`/`opencode-sentinel`.
- **Mid-run identity switching** (`switch_goal_identity`) — change model/agent
  on the same worker session, with rollback.
- **Scoped file ownership** — exact-file claims, not globs, with conflict
  detection across concurrent goals.
- **Modal TUI dashboard** (`/loop`, `<leader>o`) — no chat pollution.
- **Mid-goal grants** (`grant_approved_command`, `grant_write_scope`) —
  workers can be unblocked without recreating the goal.

## 6. Competitors

- **@prevalentware/opencode-goal-plugin** — narrower: one goal per session,
  current-session continuation, TUI. See `reports/Goal plugin comparison.md`.
- **Claude Code loop** — reference UX; loopd ports the pattern to OpenCode.
- **Codex goals** — reference concept; loopd is native to OpenCode sessions.
- **opencode-pty / opencode-sentinel** — superseded by command sessions.

## 7. Suggested pricing / monetization

Free, open-source (AGPL-3.0-or-later). Monetization is not currently in
scope; revisit if cloud-hosted or team features are added. (Assumption:
single-maintainer project; no revenue model yet.)

## 8. Recommended marketing channels

- GitHub (topics, releases, social preview) — primary.
- npm (already published, @bojackduy/opencode-loopd).
- OpenCode community (Discord, ecosystem list) — primary audience lives here.
- Hacker News / Reddit (r/programming, r/LocalLLaMA) — launch post.
- Dev blog / X — technical posts about scope/fence/design decisions.
- Product Hunt — secondary, dev-tool audience.

## Assumptions

- Single maintainer (bojackduy / Duy Trinh). No team, no revenue.
- No real user base yet; metrics in README are not fabricated.
- GitHub Pages serves docs/index.html as the landing page.
- No paid services, no ads budget.
