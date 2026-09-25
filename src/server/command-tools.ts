// ─── Server: Command Tools (owner/agent control surface) ─────────────────────
// Standalone arbitrary commands. Permission rule: every operation scopes to
// the calling session (context.sessionID must equal the stored
// ownerSessionID). Missing session context is denied — arbitrary commands are
// NEVER silently default-allowed.

import { tool } from "@opencode-ai/plugin/tool"
import type { CommandService } from "../application/command-service"
import { requestCommandAwait, wakeGoalForAwait, type AwaitContinuation } from "../application/command-await"
import { COMMAND_HOST_CAPABILITIES, type CommandHostCapabilities } from "./command-host"

export interface CommandToolsOptions {
  directory: string
  commandService: CommandService
  /** Capabilities of the ACTIVE command host backend (PTY or pipe fallback). Defaults to the pipe caps so existing callers stay honest. */
  capabilities?: CommandHostCapabilities
  /**
   * Goal continuation seam for await wakes. When present, an await that fires
   * immediately (command already terminal) on an active goal wakes it through
   * the existing idle-continuation path; otherwise the evidence waits in
   * pendingInbox. Terminal exits always wake via the command service hook.
   */
  goalService?: AwaitContinuation
}

function ownerID(context: unknown): string | undefined {
  const id = (context as { sessionID?: unknown } | undefined)?.sessionID
  return typeof id === "string" && id.length > 0 ? id : undefined
}

function denied() {
  return {
    title: "No session",
    output: JSON.stringify({
      ok: false,
      message: "No session context available. Arbitrary commands require an owning session and are never auto-allowed.",
      errorCode: "no_session",
    }),
  }
}

function summarize(c: {
  id: string
  title: string
  command: string
  args: string[]
  status: string
  exitCode?: number
  signal?: string
  outputBytes: number
  truncated: boolean
  goalID?: string
  notifyOnExit?: boolean
  updatedAt: string
  endReason?: string
  timeoutSeconds?: number
  deadlineAt?: string
  envKeys?: string[]
  shell?: boolean
  watchFilter?: string
  watchUntil?: string
  watchIgnoreCase?: boolean
  watchUntilAction?: string
}) {
  return {
    id: c.id,
    title: c.title,
    argv: [c.command, ...c.args],
    status: c.status,
    exitCode: c.exitCode,
    signal: c.signal,
    endReason: c.endReason,
    timeoutSeconds: c.timeoutSeconds,
    deadlineAt: c.deadlineAt,
    envKeys: c.envKeys,
    shell: c.shell,
    watchFilter: c.watchFilter,
    watchUntil: c.watchUntil,
    watchIgnoreCase: c.watchIgnoreCase,
    watchUntilAction: c.watchUntilAction,
    outputBytes: c.outputBytes,
    truncated: c.truncated,
    goalID: c.goalID,
    notifyOnExit: c.notifyOnExit,
    updatedAt: c.updatedAt,
  }
}

export function commandTools(options: CommandToolsOptions) {
  const { directory, commandService } = options
  const capabilities = options.capabilities ?? COMMAND_HOST_CAPABILITIES
  const sizeNote = capabilities.resize
    ? "applied live to the PTY winsize"
    : "stored; resize is unsupported by the pipe host"

  return {
    loopd_command_start: tool({
      description:
        "Start a standalone interactive OS process (arbitrary shell command) in the background — a dev server, `npm test --watch`, a REPL, a log tail, a build, or a one-off script. This is a raw process, NOT an AI worker: no agent, no checks, no turn loop. For multi-turn autonomous AI work with completion criteria, use loopd_create_goal instead. " +
        "Returns a command_id for loopd_command_get (read output)/loopd_command_write (send stdin)/loopd_command_interrupt (Ctrl+C)/loopd_command_terminate (kill)/loopd_command_remove (delete). " +
        "The user can also open it live: /loop or /commands → Tab/l to the Commands tab → select it → `o` opens a fullscreen interactive terminal page (type directly, Ctrl+C interrupts, Ctrl+] detaches without stopping it). " +
        "Independent from goals: an optional goal_id is display-only metadata and never couples lifecycles — pausing/clearing a goal never touches the command, and terminating a command never touches the goal. " +
        "To make a specific goal wake up when this command finishes, call loopd_command_await separately after starting it (linking alone does not wake anything). " +
        "The OWNER session (you) gets pushed a real message when the command reaches a terminal status — no polling required to find out: by default (auto) that fires on a non-zero exit, on 'missing' (host restarted mid-run), on 'timeout' (timeout_seconds deadline reached — always notifies), or once total runtime crosses ~2 minutes (the long-running/monitor case); quick successful commands stay silent. Override with notify_on_exit.",
      args: {
        title: tool.schema.string().describe("Short human label for the session."),
        command: tool.schema.string().describe("Executable to spawn (e.g. \"bun\", \"python3\")."),
        args: tool.schema.array(tool.schema.string()).optional().describe("Arguments for the command."),
        cwd: tool.schema.string().optional().describe("Working directory. Defaults to the project root."),
        goal_id: tool.schema.string().optional().describe("Optional goal linkage (display only — no lifecycle coupling)."),
        notify_on_exit: tool.schema.boolean().optional().describe("Owner-exit-notification override. true = always push a message to you when this command finishes. false = never (dashboard/loopd_command_get only). Omit for auto (failure, lost-host, timeout, or long-running success)."),
        cols: tool.schema.number().optional().describe(`Requested terminal width (${sizeNote}).`),
        rows: tool.schema.number().optional().describe(`Requested terminal height (${sizeNote}).`),
        env: tool.schema.record(tool.schema.string(), tool.schema.string()).optional().describe("Extra environment variables for the child. Values are passed to the host but never persisted — only names appear as envKeys in summaries."),
        timeout_seconds: tool.schema.number().optional().describe("Per-command timeout in seconds (positive integer). The command is terminated via the standard SIGTERM→SIGKILL path when the deadline passes; endReason becomes 'timeout' and the owner is always notified (auto policy). In-memory only — never resurrected across restarts."),
        shell: tool.schema.boolean().optional().describe("When true, spawn via /bin/sh -c with command+args joined into one shell string (POSIX single-quote escaping). Shell metacharacters are interpreted; prefer argv form for untrusted input."),
        watch_filter: tool.schema.string().optional().describe("Watch line filter (regex on ANSI-stripped lines): only matching lines buffer toward a coalesced owner push. For never-exiting processes (dev servers, log tails)."),
        watch_until: tool.schema.string().optional().describe("Watch until pattern (regex on the filter-surviving stream): first match notifies the owner immediately. With watch_until_action=stop (default) the command is terminated with endReason=until; with keep it keeps running."),
        watch_ignore_case: tool.schema.boolean().optional().describe("Case-insensitive watch matching (default false)."),
        watch_until_action: tool.schema.string().optional().describe("Until action: \"stop\" (default) terminates the command on first until-match; \"keep\" notifies but keeps running (until fires once, filter stream continues)."),
      },
      execute: async (args, context) => {
        const owner = ownerID(context)
        if (!owner) return denied()
        try {
          const argv = [args.command, ...(args.args ?? [])]
          await context.ask({
            permission: "bash",
            patterns: [argv.join(" ")],
            always: [args.command],
            metadata: { command: args.command, args: args.args ?? [], cwd: args.cwd ?? directory },
          })
          if (args.watch_until_action !== undefined && args.watch_until_action !== "stop" && args.watch_until_action !== "keep") {
            throw new Error(`Invalid watch_until_action '${args.watch_until_action}': must be "stop" or "keep".`)
          }
          const session = await commandService.start(directory, {
            title: args.title,
            command: args.command,
            args: args.args ?? [],
            cwd: args.cwd,
            ownerSessionID: owner,
            goalID: args.goal_id,
            notifyOnExit: args.notify_on_exit,
            cols: args.cols,
            rows: args.rows,
            env: args.env,
            timeoutSeconds: args.timeout_seconds,
            shell: args.shell,
            watchFilter: args.watch_filter,
            watchUntil: args.watch_until,
            watchIgnoreCase: args.watch_ignore_case,
            watchUntilAction: args.watch_until_action as "stop" | "keep" | undefined,
          })
          return {
            title: "Command started",
            output: JSON.stringify({ ok: true, command: summarize(session as never), capabilities }, null, 2),
          }
        } catch (error) {
          return {
            title: "Command not started",
            output: JSON.stringify({ ok: false, message: error instanceof Error ? error.message : String(error) }),
          }
        }
      },
    }),

    loopd_command_list: tool({
      description: "List standalone command sessions owned by this session (same set the TUI Commands tab shows for this session). Use before reading/writing to find a command's ID, or to check if a dev server/watcher you started earlier is still running.",
      args: {},
      execute: async (_args, context) => {
        const owner = ownerID(context)
        if (!owner) return denied()
        const sessions = await commandService.list(directory, owner)
        return {
          title: `${sessions.length} command session(s)`,
          output: JSON.stringify({ ok: true, commands: sessions.map((c) => summarize(c as never)), capabilities }, null, 2),
        }
      },
    }),

    loopd_command_get: tool({
      description: "Read a command session's status plus its output so far (bounded snapshot; page with offset_bytes for more). This is how you check on a background process — poll it after starting a build/test-watch/server to see progress or a result. Never terminates the command; detach/inspect is always read-only. With pattern, only matching lines return (regex on ANSI-stripped text, original lines kept) and offset_bytes/limit_bytes page over MATCHES (match index + max matched lines, default 500).",
      args: {
        command_id: tool.schema.string().describe("Command session ID."),
        offset_bytes: tool.schema.number().optional().describe("Byte offset into the output log (paging). With pattern: number of matching lines to skip."),
        limit_bytes: tool.schema.number().optional().describe("Max bytes to return (default 64KB, cap 256KB). With pattern: max matching lines (default 500)."),
        pattern: tool.schema.string().optional().describe("Regex to filter lines (matched against ANSI-stripped text; original lines returned). Dangerous nested-quantifier patterns are rejected."),
        ignore_case: tool.schema.boolean().optional().describe("Case-insensitive pattern matching (default false)."),
      },
      execute: async (args, context) => {
        const owner = ownerID(context)
        if (!owner) return denied()
        let result
        try {
          result = await commandService.read(directory, args.command_id, owner, {
            offsetBytes: args.offset_bytes,
            limitBytes: args.limit_bytes,
            pattern: args.pattern,
            ignoreCase: args.ignore_case,
          })
        } catch (error) {
          return { title: "Read failed", output: JSON.stringify({ ok: false, message: error instanceof Error ? error.message : String(error) }) }
        }
        if (!result) {
          return { title: "Not found", output: JSON.stringify({ ok: false, message: "Command not found for this session." }) }
        }
        return {
          title: `Command: ${result.session.title}`,
          output: JSON.stringify({
            ok: true,
            command: summarize(result.session as never),
            output: result.text,
            startByte: result.startByte,
            totalBytes: result.totalBytes,
            live: result.live,
            ...(result.pattern !== undefined ? { pattern: result.pattern, totalMatches: result.totalMatches } : {}),
          }, null, 2),
        }
      },
    }),

    loopd_command_write: tool({
      description: "Send raw input (stdin bytes) to a running command session — e.g. answer a REPL prompt, confirm a y/n, or type a command into an interactive shell you started. Include a trailing newline yourself if the program is line-buffered.",
      args: {
        command_id: tool.schema.string().describe("Command session ID."),
        input: tool.schema.string().describe("Raw text to write to stdin (include trailing newline for line-buffered programs)."),
      },
      execute: async (args, context) => {
        const owner = ownerID(context)
        if (!owner) return denied()
        const result = await commandService.write(directory, args.command_id, owner, args.input)
        return { title: result.ok ? "Input sent" : "Write failed", output: JSON.stringify({ ...result, command_id: args.command_id }) }
      },
    }),

    loopd_command_interrupt: tool({
      description: "Deliver SIGINT (Ctrl+C) to a running command. The process may trap and continue — that is correct, not a failure. Never kills unconditionally.",
      args: {
        command_id: tool.schema.string().describe("Command session ID."),
      },
      execute: async (args, context) => {
        const owner = ownerID(context)
        if (!owner) return denied()
        const result = await commandService.interrupt(directory, args.command_id, owner)
        return { title: result.ok ? "Interrupted" : "Interrupt failed", output: JSON.stringify({ ...result, command_id: args.command_id }) }
      },
    }),

    loopd_command_terminate: tool({
      description: "Terminate a running command (SIGTERM, escalates to SIGKILL). Stopping a command never pauses/blocks any goal. With remove:true, the record+log are deleted in the same call (atomic from the caller's perspective; proceeds to remove even when the command is already terminal).",
      args: {
        command_id: tool.schema.string().describe("Command session ID."),
        remove: tool.schema.boolean().optional().describe("Also remove the record+log after terminating (or when already terminal)."),
      },
      execute: async (args, context) => {
        const owner = ownerID(context)
        if (!owner) return denied()
        const result = await commandService.terminate(directory, args.command_id, owner, { remove: args.remove })
        return { title: result.ok ? "Terminated" : "Terminate failed", output: JSON.stringify({ ...result, command_id: args.command_id }) }
      },
    }),

    loopd_command_remove: tool({
      description: "Remove a finished command session and its output log. Refuses while running (terminate ≠ remove).",
      args: {
        command_id: tool.schema.string().describe("Command session ID."),
      },
      execute: async (args, context) => {
        const owner = ownerID(context)
        if (!owner) return denied()
        const result = await commandService.remove(directory, args.command_id, owner)
        return { title: result.ok ? "Removed" : "Remove failed", output: JSON.stringify({ ...result, command_id: args.command_id }) }
      },
    }),

    loopd_command_await: tool({
      description:
        "Opt in to a one-shot wake-up: the given goal wakes when the given command reaches a terminal status (exited/terminated/missing) with the exit code, signal, and last 4KB of output as evidence. With 'until', the goal instead wakes ONCE on the first output line matching the regex (evidence: matched lines + bounded tail) and the command keeps running — use this to have a GOAL worker block until a never-exiting process prints something (e.g. 'wait until the dev server prints ready') without polling. Explicit opt-in only — a merely linked command (goal_id passed to loopd_command_start) never wakes its goal on its own; this call is required. Exactly-once: the await is consumed on fire, output chunks never fire exit-awaits, pausing/clearing the goal or removing the command cancels it.",
      args: {
        command_id: tool.schema.string().describe("Command session ID to await."),
        goal_id: tool.schema.string().describe("Goal ID to wake on exit. You must own both the goal and the command."),
        until: tool.schema.string().optional().describe("Regex to wake on: fires once on the first matching output line (matched lines + bounded tail as evidence) without stopping the command. Dangerous nested-quantifier patterns are rejected."),
        ignore_case: tool.schema.boolean().optional().describe("Case-insensitive until matching (default false)."),
      },
      execute: async (args, context) => {
        const owner = ownerID(context)
        if (!owner) return denied()
        const result = await requestCommandAwait(directory, {
          goalID: args.goal_id,
          commandID: args.command_id,
          ownerSessionID: owner,
          ...(args.until !== undefined ? { until: args.until } : {}),
          ...(args.ignore_case !== undefined ? { ignoreCase: args.ignore_case } : {}),
        })
        if (result.ok && result.fired && result.active && options.goalService) {
          await wakeGoalForAwait(directory, options.goalService, args.goal_id as never).catch(() => {})
        }
        return {
          title: result.ok ? "Await registered" : "Await failed",
          output: JSON.stringify({ ...result, command_id: args.command_id, goal_id: args.goal_id }),
        }
      },
    }),

    loopd_command_resize: tool({
      description: capabilities.resize
        ? "Apply a terminal size to a running command (live PTY winsize; the requested size is also stored)."
        : "Request a terminal size for a command. Honestly unsupported by the pipe host: size is stored, never applied.",
      args: {
        command_id: tool.schema.string().describe("Command session ID."),
        cols: tool.schema.number().describe("Requested width."),
        rows: tool.schema.number().describe("Requested height."),
      },
      execute: async (args, context) => {
        const owner = ownerID(context)
        if (!owner) return denied()
        const result = await commandService.resize(directory, args.command_id, owner, args.cols, args.rows)
        return { title: "Resize", output: JSON.stringify({ ...result, command_id: args.command_id }) }
      },
    }),
  }
}
