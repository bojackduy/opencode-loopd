// ─── Server: Command Tools (owner/agent control surface) ─────────────────────
// Standalone arbitrary commands. Permission rule: every operation scopes to
// the calling session (context.sessionID must equal the stored
// ownerSessionID). Missing session context is denied — arbitrary commands are
// NEVER silently default-allowed.

import { tool } from "@opencode-ai/plugin/tool"
import type { CommandService } from "../application/command-service"
import { COMMAND_HOST_CAPABILITIES } from "./command-host"

export interface CommandToolsOptions {
  directory: string
  commandService: CommandService
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
  updatedAt: string
}) {
  return {
    id: c.id,
    title: c.title,
    argv: [c.command, ...c.args],
    status: c.status,
    exitCode: c.exitCode,
    signal: c.signal,
    outputBytes: c.outputBytes,
    truncated: c.truncated,
    goalID: c.goalID,
    updatedAt: c.updatedAt,
  }
}

export function commandTools(options: CommandToolsOptions) {
  const { directory, commandService } = options

  return {
    loopd_command_start: tool({
      description:
        "Start a standalone interactive command session (arbitrary shell command) in the background. Returns an ID for write/read/interrupt/terminate/remove. Independent from goals: linking a goalID is display-only and never couples lifecycles.",
      args: {
        title: tool.schema.string().describe("Short human label for the session."),
        command: tool.schema.string().describe("Executable to spawn (e.g. \"bun\", \"python3\")."),
        args: tool.schema.array(tool.schema.string()).optional().describe("Arguments for the command."),
        cwd: tool.schema.string().optional().describe("Working directory. Defaults to the project root."),
        goal_id: tool.schema.string().optional().describe("Optional goal linkage (display only — no lifecycle coupling)."),
        cols: tool.schema.number().optional().describe("Requested terminal width (stored; resize is unsupported by the pipe host)."),
        rows: tool.schema.number().optional().describe("Requested terminal height (stored; resize is unsupported by the pipe host)."),
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
          const session = await commandService.start(directory, {
            title: args.title,
            command: args.command,
            args: args.args ?? [],
            cwd: args.cwd,
            ownerSessionID: owner,
            goalID: args.goal_id,
            cols: args.cols,
            rows: args.rows,
          })
          return {
            title: "Command started",
            output: JSON.stringify({ ok: true, command: summarize(session as never), capabilities: COMMAND_HOST_CAPABILITIES }, null, 2),
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
      description: "List standalone command sessions owned by this session.",
      args: {},
      execute: async (_args, context) => {
        const owner = ownerID(context)
        if (!owner) return denied()
        const sessions = await commandService.list(directory, owner)
        return {
          title: `${sessions.length} command session(s)`,
          output: JSON.stringify({ ok: true, commands: sessions.map((c) => summarize(c as never)), capabilities: COMMAND_HOST_CAPABILITIES }, null, 2),
        }
      },
    }),

    loopd_command_get: tool({
      description: "Get a command session's metadata plus a bounded output snapshot. Closing a view detaches; it never terminates.",
      args: {
        command_id: tool.schema.string().describe("Command session ID."),
        offset_bytes: tool.schema.number().optional().describe("Byte offset into the output log (paging)."),
        limit_bytes: tool.schema.number().optional().describe("Max bytes to return (default 64KB, cap 256KB)."),
      },
      execute: async (args, context) => {
        const owner = ownerID(context)
        if (!owner) return denied()
        const result = await commandService.read(directory, args.command_id, owner, {
          offsetBytes: args.offset_bytes,
          limitBytes: args.limit_bytes,
        })
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
          }, null, 2),
        }
      },
    }),

    loopd_command_write: tool({
      description: "Send raw input (stdin bytes) to a running command session.",
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
      description: "Terminate a running command (SIGTERM, escalates to SIGKILL). Stopping a command never pauses/blocks any goal.",
      args: {
        command_id: tool.schema.string().describe("Command session ID."),
      },
      execute: async (args, context) => {
        const owner = ownerID(context)
        if (!owner) return denied()
        const result = await commandService.terminate(directory, args.command_id, owner)
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

    loopd_command_resize: tool({
      description: "Request a terminal size for a command. Honestly unsupported by the pipe host: size is stored, never applied.",
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
