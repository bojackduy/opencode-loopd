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
  `loopd_command_resize` stores the requested size and reports unsupported.
- TUI: `/commands` opens a host-owned fullscreen session panel on v2 and an
  xlarge compatibility dialog on v1. `j/k`
  move, `:` types (`:new <cmd> [args]`, `:terminate`, `:remove`,
  `:interrupt`, `:resize <cols> <rows>`, `:open-cmd` refresh), Enter in
  insert mode sends raw stdin (newline appended), `ctrl-c` interrupts,
  `q` detaches. The overlay labels output as a byte stream, never a terminal.
- Every response carries the host capability flags
  (`resize: false`, `terminalEmulation: false`), so callers never have to
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
- No tty: no cursor addressing, no alt-screen, no resize.
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
