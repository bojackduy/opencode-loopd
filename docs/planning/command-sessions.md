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
- TUI: `/loop` and `/commands` open the SAME shared dashboard (Goals and
  Commands tabs; `Tab`/`h`/`l` switch, `j`/`k`/`g`/`G` select). `/loop`
  focuses Goals, `/commands` focuses Commands (owner-scoped — only the
  current session's commands). On a goal, `o` opens the native worker
  session as before; on a command, `o` closes the popup and navigates to
  the plugin-owned fullscreen terminal page (route `opencode.loopd.terminal`,
  registered on both the v1 `api.route` and v2 `ctx.ui.router` contracts).
  The Commands tab also offers `:new <cmd> [args]`, `:interrupt`,
  `:terminate`, `:remove`, and bare-text stdin. Goal controls (`p`/`r`/`R`/
  `x`/`A`/`N`) never fire on the Commands tab.
- Fullscreen terminal page (primary monitor — no browser involved, no chat
  session, no dialog/panel): compact header (command metadata + connection
  status), viewport flexes to all remaining space, footer (controls +
  dimensions). Raw keypresses forward immediately (never a line-submit
  input); `Ctrl+C` is interrupt input to the PTY (never closes OpenCode);
  `Ctrl+]` detaches back to the return session; paste forwards raw bytes
  immediately. The measured viewport (renderable ref + onSizeChange, 75ms
  debounce, 80x24 fallback-only) resizes both the headless emulator and the
  real PTY winsize. Invalid/missing/cross-owner route data renders a safe
  error and can never subscribe or write. Unmount unsubscribes and frees
  everything, but NEVER terminates the command — detach (closing the page
  or panel) is a client-side no-op: the command keeps running. Termination
  is explicit-only (`:terminate`, agent tools).
- Compatibility fallback: hosts that truly lack route support keep the old
  clipped CommandPanel monitor dialog. It is not used on normal v1/v2 hosts.
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
- Live output in the terminal page is stream-primary with a poll fallback:
  when the command stream socket is connected and subscribed, deltas append
  immediately (2 s output poller gated off); when disconnected or before the
  server starts, the page falls back to 2 s polls and resumes the stream on
  reconnect. A subscription counts as live only after a valid snapshot/ack;
  input before that is rejected (control-bus fallback applies); an absent
  snapshot times out into the polling fallback. Closing/reopening replays
  from the retained log (detach/reopen safe).

## Live-only verification (not covered by automated tests)

Automated tests cover the route contract, key encoding, screen emulation,
stream lifecycle, session driver, mounted layout/input via the OpenTUI test
renderer, and both contracts' registration/payload shapes. The following
still needs live dogfooding in a real OpenCode host (parent will do this
after review — no live v1/v2 proof is claimed here):

- v1 host: `/loop` + `/commands` dialogs, `o` on a command navigates to the
  fullscreen page, `Ctrl+]` returns to the originating session.
- v2 host: session.panel dashboard (fullscreen presentation), same `o` flow
  via `ctx.ui.router`, detach back to the session.
- Real PTY winsize follows the measured viewport (`stty size` inside the
  command matches the page); interactive apps (vim/htop) usable via the
  alt-screen path.
- Stream-primary behavior under load (chatty `yes`), reconnect resync, and
  the 2 s polling fallback with the server stopped.

## Evidence owed before the v2 AI-worker migration

- Live-host transcript: `pty.create → connectToken → WebSocket frames →
  remove` from a plugin process (proves the TUI/server attach path).
- persistentPty session-scoping answer: current types require `sessionID` to
  create — confirm whether a persistent PTY can exist without an AI session.
