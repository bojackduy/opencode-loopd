// ─── Domain: Interaction Registry ──────────────────────────────────────────
// Single source of truth for every user-initiated interaction.
// TUI (key/slash) and agent (tool) are two transports over the same command.
// Adding a row here must be reflected in both transports — enforced by
// `test/domain/parity.test.ts` which fails if parity drifts.

import type { CommandName } from "./commands"

export type Transport = "tui" | "agent" | "both" | "worker"

export interface InteractionDef {
  /** LoopCommand name (control bus). "—" for read-only transports. */
  command: CommandName | "—"
  /** Agent tool name(s) that expose this interaction */
  agentTools: string[]
  /** TUI binding(s) */
  tuiKeys: string[] // e.g. ["p"], ["R"], ["A","abort"]
  /** Human label */
  label: string
  /** Short description */
  description: string
  /** Whether it targets a specific goal */
  needsGoal: boolean
  /** Transport classification */
  transport: Transport
  /** UI-only: no agent parity expected */
  uiOnly?: boolean
}

/**
 * Every interaction the user can trigger. Both transports read this.
 * Convention: keep `command` as the LoopCommand name where applicable.
 * Read-only queries use command "—" and are transport-specific.
 */
export const INTERACTIONS: InteractionDef[] = [
  // ── Goal lifecycle ───────────────────────────────────────────────
  {
    command: "start",
    agentTools: ["loopd_create_goal"],
    tuiKeys: ["start"], // via control bus; dashboard delegates to /goal in parent chat
    label: "Create goal",
    description: "Create a new background goal (objective + checks + agent/model)",
    needsGoal: false,
    transport: "both",
  },
  {
    command: "pause",
    agentTools: ["pause_goal"],
    tuiKeys: ["p", "pause"],
    label: "Pause",
    description: "Pause an active goal, release lease, abort worker",
    needsGoal: true,
    transport: "both",
  },
  {
    command: "resume",
    agentTools: ["resume_goal"],
    tuiKeys: ["r", "resume"],
    label: "Resume",
    description: "Resume a paused goal",
    needsGoal: true,
    transport: "both",
  },
  {
    command: "retry",
    agentTools: ["resume_goal"], // resume_goal handles both paused→active and blocked→active
    tuiKeys: ["R", "retry"],
    label: "Retry",
    description: "Retry a blocked goal (alias of resume for blocked)",
    needsGoal: true,
    transport: "both",
  },
  {
    command: "nudge",
    agentTools: ["nudge_goal"],
    tuiKeys: ["N", "nudge"],
    label: "Nudge",
    description: "Force re-prompt with full steering even if not idle",
    needsGoal: true,
    transport: "both",
  },
  {
    command: "clear",
    agentTools: ["clear_goal"],
    tuiKeys: ["x", "clear"],
    label: "Clear",
    description: "Abort worker and remove goal+runtime+ledger (cannot be undone)",
    needsGoal: true,
    transport: "both",
  },
  {
    command: "abort_worker",
    agentTools: ["abort_goal_worker"],
    tuiKeys: ["A", "abort"],
    label: "Abort worker",
    description: "Abort the worker session only, keep goal+transcript, session stays browsable",
    needsGoal: true,
    transport: "both",
  },
  {
    command: "send",
    agentTools: ["send_goal_input"],
    tuiKeys: ["send"],
    label: "Send",
    description: "Send bare words as their own turn (no steering wrapper), immediate",
    needsGoal: true,
    transport: "both",
  },
  {
    command: "force_complete",
    agentTools: ["force_complete_goal"],
    tuiKeys: ["force"],
    label: "Force complete",
    description: "Force-complete goal with summary/evidence (bypass checks)",
    needsGoal: true,
    transport: "both",
  },
  {
    command: "block",
    agentTools: ["force_block_goal"],
    tuiKeys: ["block"],
    label: "Force block",
    description: "Force-block goal with reason/needed",
    needsGoal: true,
    transport: "both",
  },

  // ── Read-only / inspection ────────────────────────────────────────
  {
    command: "—",
    agentTools: ["list_background_goals", "inspect_background_goal", "read_goal_transcript"],
    tuiKeys: ["o", "open"],
    label: "Inspect/open",
    description: "Inspect goal contract/runtime or open worker session",
    needsGoal: true,
    transport: "both",
  },
  // Worker-only (not owner/TUI)
  {
    command: "—",
    agentTools: ["get_goal", "report_goal_progress", "complete_goal", "block_goal"],
    tuiKeys: [],
    label: "Worker tools",
    description: "Worker session tools (report progress, propose completion)",
    needsGoal: false,
    transport: "worker",
  },

  // ── Command sessions (standalone; never coupled to goals) ──────────
  // Agent side: loopd_command_* owner tools. TUI side: the :commands panel
  // (src/tui/command-panel.tsx) over the same control-bus ops (cmd_*).
  {
    command: "—",
    agentTools: ["loopd_command_start"],
    tuiKeys: ["commands", "new"],
    label: "Start command",
    description: "Start a standalone interactive command session (owner-scoped; goal linkage is display-only)",
    needsGoal: false,
    transport: "both",
  },
  {
    command: "—",
    agentTools: ["loopd_command_list", "loopd_command_get"],
    tuiKeys: ["commands", "open-cmd"],
    label: "Inspect command",
    description: "List/select command sessions with bounded byte-stream output replay plus live updates; closing detaches, never terminates",
    needsGoal: false,
    transport: "both",
  },
  {
    command: "—",
    agentTools: ["loopd_command_write"],
    tuiKeys: ["write", "input"],
    label: "Write to command",
    description: "Send raw stdin bytes to a running command",
    needsGoal: false,
    transport: "both",
  },
  {
    command: "—",
    agentTools: ["loopd_command_interrupt"],
    tuiKeys: ["ctrl-c", "interrupt"],
    label: "Interrupt command",
    description: "Deliver SIGINT (Ctrl+C) as a signal, not a kill; a trapping process may continue",
    needsGoal: false,
    transport: "both",
  },
  {
    command: "—",
    agentTools: ["loopd_command_terminate"],
    tuiKeys: ["terminate"],
    label: "Terminate command",
    description: "SIGTERM escalating to SIGKILL; never pauses/blocks any goal",
    needsGoal: false,
    transport: "both",
  },
  {
    command: "—",
    agentTools: ["loopd_command_remove"],
    tuiKeys: ["remove"],
    label: "Remove command",
    description: "Remove a finished command and its log; refuses while running (terminate ≠ remove)",
    needsGoal: false,
    transport: "both",
  },
  {
    command: "—",
    agentTools: ["loopd_command_resize"],
    tuiKeys: ["resize"],
    label: "Resize command",
    description: "Requested size is stored only; the pipe host has no tty winsize (honestly unsupported)",
    needsGoal: false,
    transport: "both",
  },
]

// ── Helpers for codegen / validation ─────────────────────────────────

export function interactionsByCommand(name: CommandName): InteractionDef | undefined {
  return INTERACTIONS.find((i) => i.command === name)
}

export function tuiInteractions(): InteractionDef[] {
  return INTERACTIONS.filter((i) => i.tuiKeys.length > 0)
}

export function agentInteractions(): InteractionDef[] {
  return INTERACTIONS.filter((i) => i.agentTools.length > 0)
}
