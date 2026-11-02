# Activation fence deadlock (2026-11-01)

Symptom: `loopd_create_goal` rejected in another session (opencode-web-bridges
worktree) with "Protected goal activation denied: an uncontrolled tool/shell
is still executing", on three attempts including an isolated worktree.
`await_quiescence` could not help: it needs an active worker session, and no
goal existed yet. Native message history proved both blocking calls terminal
(python3 error 2026-10-31, shell completed 2026-11-01), yet state kept both
reservations.

Root causes fixed:

1. V2 had no terminal-evidence reader (`readToolExecutions` is v1-only), so
   completed V2 calls persisted as uncontrolled reservations forever.
2. Goal start never reconciled before activation; the fence vetoed the launch
   before any worker existed to park or clean up.
3. Owner control verbs recorded uncontrolled reservations, so a create-goal
   call could veto its own scoped activation (self-veto).
4. `releaseTerminalWorkspaceCalls` cleaned calls but not ticket holders/queue,
   and never woke fence awaits — phantom holders fenced checks forever.
5. Denied ticket waiters were stored, then their execution never ran; a later
   promotion minted phantom holders. The queue promised a wake that cannot
   exist for a dead execution.
6. Denial/busy texts were unactionable ("still executing", no IDs) and one
   falsely claimed denied checks burn evaluator budget.

Fixes (this change):

- New idle-session reconcile: a host-proved idle session has settled every
  call (a running call would keep it busy). Reservations predating the idle
  observation are released with no age inference; runtime-tracked tools,
  post-observation calls, unknown statuses, and non-idle sessions stay
  fenced. Ticket holders/queue entries keyed to released calls and dead
  waiters from idle sessions are pruned in the same transaction, and fence
  awaits fire.
- `startUnlocked` runs `reconcileTerminalWorkspaceCalls` before the atomic
  goal.create fence (fail-open to the existing fence on reconcile error).
- Owner control verbs no longer record workspace reservations.
- Ticket promotion only promotes waiters with a live execution; dead waiters
  are dropped with a `ticket.waiter-dropped` event.
- Activation denial names each uncontrolled call (callID, session, age) and
  points at `loopd_release_workspace` + the worker-only limit of
  `await_quiescence`.
- `releaseAbsentSessionWorkspaceCalls` now also releases goal-less calls whose
  session is positively absent (a gone session runs nothing; live-session
  goal-less calls still go through the explicit owner release path).
- `await_quiescence` is labeled worker-only in description and denial.

Verification: `bun run typecheck`, `bun run build`, `git diff --check`,
service restart, then a scratch writer goal created/completed/cleared live.

Voice incident (2026-11-02): a read-only worker died without any after-hook,
leaving a write fence; worker status stayed `unknown`, so neither the idle
nor the absent path could fire, and nudge refused generically. Fix: the
absent path now also prunes ticket holders/queue of gone sessions (probing
their sessions even with no workspaceCall), fires fence awaits, and nudge
short-circuits a positively-absent worker to "resume first" guidance.

Residual risks: the v2 server context exposes no message-history API, so
historical proof rests on idle status, not per-call terminal records; a
worktree that copies another directory's state inherits its stale fences
until its own instance reconciles on next start.
