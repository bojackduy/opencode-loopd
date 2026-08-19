// ─── TUI: Command Parser ─────────────────────────────────────────────────────
// Parses `:` commands in the dashboard.

export interface ParsedCommand {
  command: string
  args: Record<string, string>
  raw: string
}

export function parseCommand(input: string): ParsedCommand | null {
  const trimmed = input.trim()
  if (!trimmed) return null

  const parts = trimmed.split(/\s+/)
  const command = parts[0] || ""
  const args: Record<string, string> = {}

  // Parse key=value pairs and flags
  for (let i = 1; i < parts.length; i++) {
    const part = parts[i]!
    if (part.startsWith("--")) {
      const eqIdx = part.indexOf("=")
      if (eqIdx > 0) {
        args[part.slice(2, eqIdx)] = part.slice(eqIdx + 1)
      } else {
        args[part.slice(2)] = "true"
      }
    } else if (part.includes("=")) {
      const eqIdx = part.indexOf("=")
      args[part.slice(0, eqIdx)] = part.slice(eqIdx + 1)
    } else {
      // Positional args
      args[`_${i}`] = part
    }
  }

  return { command, args, raw: trimmed }
}

export function commandHelp(): string {
  return [
    "Commands:",
    "  :goal start <name> --objective <text>  Create a new goal",
    "  :pause                                 Pause the selected goal",
    "  :resume                                Resume the selected goal",
    "  :retry                                 Retry the blocked goal",
    "  :clear                                 Clear the selected goal",
    "  :logs                                  Toggle log view",
    "  :inspect state                         Show raw state",
    "  :q / :close                            Close dashboard",
    "  :help                                  Show this help",
  ].join("\n")
}
