// Approved command tools: the worker-facing surface. Every executable detail
// is owner-configured and persisted; the caller supplies a NAME only.

import { tool } from "@opencode-ai/plugin/tool"
import { readApprovedServer, runApprovedFiniteCommand, startApprovedServer, stopApprovedServer } from "../application/approved-commands"
import type { CommandService } from "../application/command-service"

export interface ApprovedCommandToolOptions {
  directory: string
  commandService: CommandService
}

const ALLOWED_RUN_FIELDS = new Set(["name"])

function rejected(title: string, message: string) {
  return { title, output: JSON.stringify({ ok: false, errorCode: "override_denied", message }) }
}

export function approvedCommandTools(options: ApprovedCommandToolOptions) {
  const { directory, commandService } = options

  return {
    run_approved_command: tool({
      description:
        "Run one owner-approved FINITE command by name. The executable, argument vector, canonical cwd and timeout are fixed by the owner at goal creation; this tool accepts no executable/args/cwd/env/shell overrides. Finite commands run without a shell under the workspace-wide operation lock, so concurrent source writes and checks are denied until the actual process exits. Returns the real exit code, stdout, stderr, duration and timeout outcome. Owner-trusted commands may write files; this is coordination, not a filesystem sandbox.",
      args: {
        name: tool.schema.string().describe("Approved command name from get_goal config.approvedCommands."),
      },
      execute: async (args, context) => {
        const injected = Object.keys(args as Record<string, unknown>).filter((key) => !ALLOWED_RUN_FIELDS.has(key))
        if (injected.length) {
          return rejected("Approved command denied", `run_approved_command accepts only a name. Override fields are rejected: ${injected.join(", ")}.`)
        }
        const result = await runApprovedFiniteCommand(directory, context?.sessionID, args.name)
        return {
          title: result.ok ? `Approved command passed: ${result.name}` : `Approved command failed: ${result.name}`,
          output: JSON.stringify(result),
        }
      },
    }),

    start_approved_server: tool({
      description:
        "Start one owner-approved SERVER command by name through the managed command service. The executable, args and canonical cwd are fixed by the owner; only the approved name is accepted. Refused while a workspace operation is active, and duplicates are atomic: a second start for the same goal+name returns the existing command instead of spawning a twin. The returned command_id is the managed handle; read output with read_approved_server and stop it with stop_approved_server. Owner-trusted servers may write files.",
      args: {
        name: tool.schema.string().describe("Approved server name from get_goal config.approvedCommands."),
      },
      execute: async (args, context) => {
        const injected = Object.keys(args as Record<string, unknown>).filter((key) => !ALLOWED_RUN_FIELDS.has(key))
        if (injected.length) {
          return rejected("Approved server denied", `start_approved_server accepts only a name. Override fields are rejected: ${injected.join(", ")}.`)
        }
        const result = await startApprovedServer(directory, commandService, context?.sessionID, args.name)
        return {
          title: result.ok ? `Approved server live: ${result.name}` : `Approved server not started: ${result.name}`,
          output: JSON.stringify(result),
        }
      },
    }),

    read_approved_server: tool({
      description:
        "Read one managed approved server by name: status, liveness, pid, exit code and the output tail. The worker that started it and the owning session may read. A missing handle reports exit-is-unproved recovery instead of pretending the process stopped.",
      args: {
        name: tool.schema.string().describe("Approved server name from get_goal config.approvedCommands."),
      },
      execute: async (args, context) => {
        const injected = Object.keys(args as Record<string, unknown>).filter((key) => !ALLOWED_RUN_FIELDS.has(key))
        if (injected.length) {
          return rejected("Approved server read denied", `read_approved_server accepts only a name. Extra fields are rejected: ${injected.join(", ")}.`)
        }
        const result = await readApprovedServer(directory, commandService, context?.sessionID, args.name)
        return {
          title: `${result.live ? "Live" : "Not live"} approved server: ${result.name}`,
          output: JSON.stringify(result),
        }
      },
    }),

    stop_approved_server: tool({
      description:
        "Stop one managed approved server by name (SIGTERM with a kill escalation) and release its linkage only after the process exit is proved. The worker that started it and the owning session may stop. If exit cannot be proved, the fence is retained and the result reports stop_unproven with explicit recovery.",
      args: {
        name: tool.schema.string().describe("Approved server name from get_goal config.approvedCommands."),
      },
      execute: async (args, context) => {
        const injected = Object.keys(args as Record<string, unknown>).filter((key) => !ALLOWED_RUN_FIELDS.has(key))
        if (injected.length) {
          return rejected("Approved server stop denied", `stop_approved_server accepts only a name. Extra fields are rejected: ${injected.join(", ")}.`)
        }
        const result = await stopApprovedServer(directory, commandService, context?.sessionID, args.name)
        return {
          title: result.ok ? `Approved server stopped: ${result.name}` : `Approved server stop failed: ${result.name}`,
          output: JSON.stringify(result),
        }
      },
    }),
  }
}
