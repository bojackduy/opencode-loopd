// ─── TUI: Command Parser ─────────────────────────────────────────────────────
// Parses `:` commands in the dashboard with proper quoting support.

export interface ParsedCommand {
  command: string
  args: Record<string, string>
  positional: string[]
  raw: string
}

export function parseCommand(input: string): ParsedCommand | null {
  const trimmed = input.trim()
  if (!trimmed) return null

  const tokens = tokenize(trimmed)
  if (tokens.length === 0) return null

  const command = tokens[0]!
  const args: Record<string, string> = {}
  const positional: string[] = []

  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i]!
    if (token.startsWith("--")) {
      const eqIdx = token.indexOf("=")
      if (eqIdx > 0) {
        args[token.slice(2, eqIdx)] = token.slice(eqIdx + 1)
      } else if (i + 1 < tokens.length && !tokens[i + 1]!.startsWith("--")) {
        args[token.slice(2)] = tokens[++i]!
      } else {
        args[token.slice(2)] = "true"
      }
    } else {
      positional.push(token)
    }
  }

  return { command, args, positional, raw: trimmed }
}

function tokenize(input: string): string[] {
  const tokens: string[] = []
  let current = ""
  let inQuote: string | null = null
  let escape = false

  for (const char of input) {
    if (escape) {
      current += char
      escape = false
      continue
    }
    if (char === "\\") {
      escape = true
      continue
    }
    if (inQuote) {
      if (char === inQuote) {
        inQuote = null
      } else {
        current += char
      }
      continue
    }
    if (char === '"' || char === "'") {
      inQuote = char
      continue
    }
    if (char === " " || char === "\t") {
      if (current) {
        tokens.push(current)
        current = ""
      }
      continue
    }
    current += char
  }
  if (current) tokens.push(current)

  return tokens
}

export function commandHelp(): string {
  return [
    "Modes: : insert, Ctrl+N normal, ? toggle help",
    "Navigation: j/k move, g/G top/bottom, o open child, L toggle logs",
    "Commands:",
    '  :goal start <name> --objective "<text>"  Create a new goal',
    "  :pause                                    Pause the selected goal",
    "  :resume                                   Resume the selected goal",
    "  :retry                                    Retry the blocked goal",
    "  :clear                                    Clear the selected goal",
    "  :answer <text>                            Answer worker's question",
    "  :logs                                     Toggle log view",
    "  :help                                     Show this help",
    "  :q / :close                               Close dashboard",
  ].join("\n")
}
