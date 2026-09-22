# Command Sessions

Standalone arbitrary interactive commands, independent from goals and AI worker
sessions. Start them from an agent (`loopd_command_*` tools) or the TUI
(`/commands` palette command). See also the
[capability matrix](./command-session-capability-matrix.md) for what the
installed host APIs can and cannot do, with file/type evidence.

## UX

- Agent: `loopd_command_start` → `loopd_command_list` /
  `loopd_command_get` (metadata + bounded output snapshot) →
  `loopd_command_write` (raw stdin) → `loopd_command_interrupt` (SIGINT) →
  `loopd_command_terminate` (SIGTERM→SIGKILL) → `loopd_command_remove`.
   `loopd_command_resize` applies the size live to the PTY winsize (pipe
   fallback: stores the requested size and reports unsupported).
- TUI: `/commands` opens a host-owned fullscreen session panel on v2 and an
  xlarge compatibility dialog on v1. `j/k`
  move, `:` types (`:new <cmd> [args]`, `:terminate`, `:remove`,
  `:interrupt`, `:resize <cols> <rows>`, `:open-cmd` refresh), Enter in
  insert mode sends raw stdin (newline appended), `ctrl-c` interrupts,
  `q` detaches. Commands confirmed on the PTY backend render an emulated
  terminal screen (headless `@xterm/headless` view over the byte stream —
  cursor addressing, SGR colors, alt-screen, scroll regions); pipe-backend
  sessions keep the raw-text view. The panel header says which view is shown.
- Every response carries the host capability flags of the ACTIVE backend
  (`resize: true` on the PTY backend, `false` on the pipe fallback;
  `terminalEmulation: false` always), so callers never have to
  guess what the backend can do.

## Lifecycle semantics

- `running → exited` (process ended on its own; exit code kept),
  `running → terminated` (explicit terminate; SIGTERM recorded, SIGKILL on
  escalation), `running → missing` (restart reconciliation found no live
  execution — output log retained, remove to clean up).
- `terminate ≠ remove`: remove refuses while running. Removing deletes the
  metadata record and its output log.
- `interrupt` = SIGINT delivery (Ctrl+C as a signal, not a kill). A process
  that traps SIGINT keeps running — that is correct behavior, and the session
  stays `running` with `signal: "SIGINT"` recorded.
- Detach (closing the panel/view) is a client-side no-op: the command keeps
  running. Termination is explicit-only.
- Goal linkage (`goalID`) is display metadata. Pausing/clearing a goal never
  touches commands; stopping a command never touches goals (separate service,
  no shared imports — enforced by construction and tested).

## Await semantics (explicit opt-in wake)

A goal wakes on a command's exit ONLY after an explicit await
(`loopd_command_await`, TUI `:await <goalID>`, control bus `cmd_await`). A
merely linked command never wakes its goal — the display-only linkage behavior
is otherwise unchanged.

- Exactly-once, terminal-only: when an awaited command reaches `exited`,
  `terminated`, or `missing`, the await is consumed (removed first, so a
  duplicate/late status event can never fire twice) and ONE wake-up is
  delivered with the exit code, signal, and a bounded output tail (last 4 KB
  of the retained log). Output chunks never wake, no matter how chatty.
- Delivery rides the existing continuation machinery: a `pendingInbox` item
  plus the idle-continuation path (same seam as send/nudge — never a second
  parallel loop). If the goal is blocked when the exit lands, the evidence
  waits in `pendingInbox` for the next explicit resume/retry; a non-active
  goal is never auto-activated.
- Lifecycle independence preserved: pausing or clearing a goal cancels its
  outstanding awaits (an exit afterwards fires nothing); removing a finished
  command clears awaits pointing at it; terminating an awaited command is
  allowed and wakes normally; cross-owner awaits (requester must own both the
  goal and the command) are rejected fail-closed.
- Durable: awaits persist in the state repo (IDs only — never output bytes),
  so they survive plugin restarts. Reconcile fires an await whose command is
  already terminal exactly once, and discards (with a ledger note) an await
  whose command record is gone.

## Permissions

Every operation is owner-scoped (`ownerSessionID`): agent tools deny without
session context and on owner mismatch; the control bus (`cmd_*`) requires
`ownerSessionID` in args and matches it against the stored owner. Agent-started
commands request OpenCode's `bash` permission before spawning (v1 uses
`ToolContext.ask`; v2 declares the native tool permission). TUI starts are
direct user actions typed in the owning session panel rather than autonomous
agent actions. Missing session ownership fails closed.

## Known limitations (first slice)

- Output is an interleaved stdout+stderr byte stream (arrival order), bounded
  at 512 KB retained per command (oldest bytes dropped at the bound, flagged
  `truncated`); reads page by byte offset (default 64 KB, cap 256 KB).
- Real PTY bytes (`bun-pty`, TERM=xterm-256color, default 80x24): cursor
  addressing and alt-screen sequences pass through output untouched, `stty
  size` reflects spawn/resize winsize, Ctrl+C is line-discipline SIGINT
  (trappable/ignorable). The panel renders a VIEW-SIDE emulation of those
  bytes (`src/tui/terminal-screen.ts`, `@xterm/headless`): cursor movement,
  SGR colors/attrs, erase, scroll regions, wrap, alt-screen enter/exit, and
  resize reflow. Best-effort after log truncation — bytes before the retained
  window are gone, so the grid can diverge from a live terminal; the raw log
  is the durable record. Host `terminalEmulation` stays `false` deliberately:
  the host captures a byte stream, the TUI emulates a screen from it.
- Panel/backend handshake (no new channel): the panel learns PTY-vs-pipe per
  command from the existing `cmd_resize` result (`ok` = PTY winsize applied,
  `unsupported` = pipe fallback) and auto-pushes its dimensions on selection
  (trailing-debounced 500ms) so the child observes the real winsize. Snapshot
  and resync reset + re-feed the emulator; deltas append incrementally with
  offset tracking; repaints coalesce (≥120ms trailing throttle + the existing
  2s refresh cadence) so a chatty `yes` cannot storm renderer state.
- v2 server plugins cannot drive host-owned PTYs at all (context exposes
  `terminal.read` only); both TUI clients could attach natively later via
  `pty.connectToken` + `connect` — recorded as follow-up, not implemented.
- Live output in the panel is stream-primary with a poll fallback: when the
  command stream socket is connected and subscribed, deltas append
  immediately (2 s output poller gated off, 30 s metadata safety refresh);
  when disconnected or before the server starts, the panel falls back to the
  2 s pollers and resumes the stream on reconnect. Closing/reopening
  replays from the retained log (detach/reopen safe).

## Evidence owed before the v2 AI-worker migration

- Live-host transcript: `pty.create → connectToken → WebSocket frames →
  remove` from a plugin process (proves the TUI/server attach path).
- persistentPty session-scoping answer: current types require `sessionID` to
  create — confirm whether a persistent PTY can exist without an AI session.
