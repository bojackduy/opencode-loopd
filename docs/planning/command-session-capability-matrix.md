# CommandSession capability matrix (proved 2026-09-22)

Against the installed `node_modules` in this repo (`@opencode-ai/plugin ^1.18.30`,
`@opencode/plugin ^2.0.11`, `@opencode-ai/sdk`, `@opencode/client`). Three
separate questions per API: (a) does it exist, (b) is it reachable from the
**server** plugin context, (c) is it reachable from the **TUI** context client.

## (a) APIs exist — ordinary PTY + experimental persistentPty

- v1 SDK (`node_modules/@opencode-ai/sdk/dist/gen/sdk.gen.d.ts:38-65`):
  `client.pty.list/create/get/update/remove/connect`. Shapes in
  `dist/gen/types.gen.d.ts:562-570` (`Pty {id,title,command,args,cwd,status,running|exited,pid}`),
  `:1536-1667` (`PtyCreateData` body `{command?,args?,cwd?,title?,env?}` + query
  `{directory?}`; `PtyUpdateData` body `{title?,size?{rows,cols}}`; `PtyConnectData`
  `200: boolean`). Events `pty.created/updated/exited/deleted` (`:571-597`).
- v1 has **no** HTTP write/stdin or HTTP output-read for ordinary PTYs. I/O is
  only via the `connect` WebSocket upgrade (`200: boolean` — upgrade handshake,
  not a data channel).
- v2 SDK (`node_modules/@opencode-ai/sdk/dist/v2/gen/sdk.gen.d.ts:740-833`):
  `Pty.shells/list/create/get/update/remove/connectToken/connect`, plus a second
  `Pty2` (`V2Pty*`, `:2051-2145`). `Pty` type at
  `dist/v2/gen/types.gen.d.ts:480-489` (adds `exitCode?`). Ticket flow:
  `connectToken → {ticket, expires_in}` (`:3140-3143`), `connect` takes
  `{cursor?, ticket?}` (`V2PtyConnectData`, `:11341+`).
- v2 core (`node_modules/@opencode/client/dist/promise/client.d.ts:177-199`):
  `pty.{list,create,get,update,remove,connect.token}` (same ordinary model) and
  `experimental.persistentPty.{read,list,create,shutdown,handoff,get,update,snapshot,remove,connectToken}`.
  persistentPty is **session-scoped**: create/list/read take `sessionID`
  (`generated/types.d.ts:7925-7970`), `PersistentPtyReadResult` carries a real
  terminal screen (`screen{text,cols,rows,cursor}`, `:591+`), `snapshot` returns
  `{info,text,checkpoint,cursor}`. This is per-AI-session terminal state, not a
  standalone arbitrary-command runner.

## (b) Server plugin context

- v1 server (`node_modules/@opencode-ai/plugin/dist/index.d.ts:37-42`):
  `PluginInput.client: ReturnType<typeof createOpencodeClient>` — the full v1
  `OpencodeClient`, which exposes `pty: Pty` (`sdk.gen.d.ts:384`). So from a v1
  server plugin, host-owned lifecycle calls
  `client.pty.create/list/get/update/remove` are type-available plain HTTP.
  I/O (`connect`) is a WS upgrade — unproven from inside the plugin process
  (no in-repo caller does it; see below).
- v2 server (`node_modules/@opencode/plugin/dist/promise/plugin.d.ts:23-44`):
  `Context` exposes **no** general client and **no** pty domain. The only
  terminal surface is
  `experimental.terminal: Pick<OpenCodeClient["experimental"]["persistentPty"], "read">`
  (read-only, session-scoped). A v2 server plugin **cannot** create/list/remove
  host PTYs through its context. Full `OpenCodeClient` (with `pty` +
  `experimental.persistentPty`) exists in `@opencode/client` but is not handed
  to v2 server plugins.

## (c) TUI context client

- v1 TUI (`node_modules/@opencode-ai/plugin/dist/tui.d.ts:1,492`):
  `api.client: OpencodeClient` imported from `@opencode-ai/sdk/v2` — the v2 gen
  client, which exposes `get pty(): Pty` (`v2/gen/sdk.gen.d.ts:2284`, full
  lifecycle + `connectToken`/`connect`). So the v1 TUI **can** drive host-owned
  ordinary PTYs, including the ticketed WS connect from the TUI process.
- v2 TUI (`node_modules/@opencode/plugin/dist/tui/context.d.ts:1,449`):
  `client: OpenCodeClient` from `@opencode/client` — full `pty` +
  `experimental.persistentPty`. Same conclusion: TUI-side native attach is
  possible; server-side is not (v2).

## Reference (`/Users/duytrinh/Code/opencode-pty`, read-only)

- `src/plugin/pty/manager.ts`: uses in-process `Terminal` from `bun-pty`
  (native dep), **not** host `client.pty.*`.
- `grep client.pty|pty.create|persistentPty src/` → zero hits: no evidence for a
  plugin-process → host WS connect path. Its WS surface (`src/web/server`,
  `src/web/client/hooks/use-web-socket.ts`) is its **own** web server (browser
  clients), which this goal forbids us to copy (no web UI).
- Reused semantics: retained exited sessions, separate terminate vs cleanup,
  snapshot + incremental output, owner association, bounded output
  (`src/plugin/pty/*`). Reused permission posture from
  `src/adapters/v1/permissions.ts` (`V1PermissionAuthorizer`: reads
  `client.config.get()` → `permission.bash`, fail-closed on `ask`/unavailable)
  **except** its default-allow when no rules are configured (`if (!bashPerms)
  return`), which this goal excludes for autonomous starts: loopd agent tools
  request/declare OpenCode's native `bash` permission before spawning.
- Not copied: global in-memory singleton, browser/web server, prompt-based exit
  notifications, default-allow, missing resize/restart semantics.

## Decision for this slice

- Server execution backend (v1 + v2): local child process via `Bun.spawn`
  with pipes (`src/server/command-host.ts`, `createLocalProcessHost`). No new
  native dependency (`bun-pty` deliberately **not** added). Rationale, from the
  matrix above: no HTTP write/read exists for ordinary PTYs in either version;
  the only I/O path is a WS upgrade whose plugin-process viability is unproven
  (zero in-repo callers); v2 server context cannot even do lifecycle. Pipes give
  a complete honest slice (spawn/write/read-paged/interrupt-as-SIGINT/
  terminate-escalating/remove) with two labeled gaps: `resize: false` (no tty
  winsize on pipes) and `terminalEmulation: false` (byte stream, not a screen).
- Host-owned swap follow-up (needs live-host proof before claiming):
  1. v1 server: replace spawn/status/remove with `client.pty.*` once a
     plugin-process WS `connect` round-trip (write + output frames) is
     demonstrated against a live host; keep loopd metadata/ownership linkage.
  2. v2 server: blocked on context — needs either a context capability addition
     or an out-of-band client; `experimental.terminal.read` only covers reads.
  3. TUI native attach: both TUI clients already expose `pty.connectToken` +
     `connect`; a future TUI may attach a real terminal widget to a host PTY
     without touching the server slice. No plain-log-text masquerading: until a
     real terminal widget exists, the panel is labeled byte-stream output.
- Evidence still owed before the later v2 AI-worker migration: live-host
  `pty.create → connectToken → WS frames → remove` transcript from a plugin
  process, and the persistentPty session-scoping answer (can a persistent PTY
  exist without an AI session? current types say no — create requires
  `sessionID`).
