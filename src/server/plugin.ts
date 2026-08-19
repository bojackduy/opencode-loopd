// ─── Server Plugin Entry ─────────────────────────────────────────────────────
// The engine. Hooks, tools, scheduling, worker sessions, continuation.

import type { Plugin, PluginModule } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin/tool"
import { createControlService } from "../application/control-service"
import type { ControlService } from "../application/control-service"
import type { LoopCommand, StartGoalCommand } from "../domain/commands"
import { randomUUID } from "crypto"

const PLUGIN_ID = "opencode-loopd"
let controlService: ControlService | undefined

function goalTools(dir: string, svc: ControlService, sessionID: string) {
  return {
    report_goal_progress: tool({
      description:
        "Report meaningful progress on the current goal without completing it. " +
        "Call after durable state changes (file writes, verifications).",
      args: {
        summary: tool.schema.string().describe("What was accomplished."),
        next: tool.schema.string().describe("The next concrete step."),
      },
      execute: async (args) => {
        const cmd: LoopCommand = {
          version: 1,
          requestID: randomUUID(),
          requestedAt: new Date().toISOString(),
          command: "inspect",
          args: { what: "state" },
        }
        // Progress is recorded via the progress file, not here.
        // This tool exists so the model has a visible signal.
        return {
          title: "Progress recorded",
          output: `Progress: ${args.summary}\nNext: ${args.next}`,
        }
      },
    }),
    complete_goal: tool({
      description:
        "Mark the current goal as completed. Use only when acceptance criteria " +
        "are satisfied with concrete evidence.",
      args: {
        summary: tool.schema.string().describe("What was completed."),
        evidence: tool.schema.string().describe("Concrete evidence (commands, files, checks)."),
      },
      execute: async (args) => {
        return { title: "Goal completed", output: `Completed: ${args.summary}\nEvidence: ${args.evidence}` }
      },
    }),
    block_goal: tool({
      description:
        "Mark the current goal as blocked when user input or manual intervention " +
        "is required to continue.",
      args: {
        reason: tool.schema.string().describe("Why the goal is blocked."),
        needed: tool.schema.string().describe("What is needed to unblock."),
      },
      execute: async (args) => {
        return { title: "Goal blocked", output: `Blocked: ${args.reason}\nNeeded: ${args.needed}` }
      },
    }),
  }
}

const server: Plugin = async ({ client, directory }) => {
  controlService = createControlService()

  return {
    event: async ({ event }) => {
      // Forward events to the control service for future use
      // (e.g., detecting session idle for continuation)
    },
    tool: goalTools(directory, controlService, "main"),
    "tool.execute.after": async (input, output) => {
      // Detect goal-related tool completions for future continuation logic
    },
  }
}

export default {
  id: PLUGIN_ID,
  server,
} satisfies PluginModule & { id: string }
