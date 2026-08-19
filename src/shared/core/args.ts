// ─── Shared: Core Args ───────────────────────────────────────────────────────
// Minimal argument parsing utilities. Adapted from opencode-loop.

export function now(): number {
  return Date.now()
}

export function safeID(id: string): string {
  return String(id || "").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 128)
}

export function parseDuration(input: string | undefined | null): number | null {
  if (!input || typeof input !== "string") return null
  const trimmed = input.trim().toLowerCase()
  if (!trimmed) return null

  // Try seconds
  const secMatch = trimmed.match(/^(\d+(?:\.\d+)?)\s*s$/)
  if (secMatch?.[1]) return Math.round(parseFloat(secMatch[1]) * 1000)

  // Try minutes
  const minMatch = trimmed.match(/^(\d+(?:\.\d+)?)\s*m$/)
  if (minMatch?.[1]) return Math.round(parseFloat(minMatch[1]) * 60_000)

  // Try hours
  const hrMatch = trimmed.match(/^(\d+(?:\.\d+)?)\s*h$/)
  if (hrMatch?.[1]) return Math.round(parseFloat(hrMatch[1]) * 3_600_000)

  // Try days
  const dayMatch = trimmed.match(/^(\d+(?:\.\d+)?)\s*d$/)
  if (dayMatch?.[1]) return Math.round(parseFloat(dayMatch[1]) * 86_400_000)

  // Try plain number (milliseconds)
  const num = Number(trimmed)
  if (!isNaN(num) && num >= 0) return num

  return null
}

export function durationToText(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`
  return `${Math.round(ms / 3_600_000)}h`
}

export function splitFirst(input: string): [string, string] {
  const idx = input.indexOf(" ")
  if (idx === -1) return [input, ""]
  return [input.slice(0, idx), input.slice(idx + 1)]
}
