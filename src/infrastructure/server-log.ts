import { appendFile } from "fs/promises"

export const SERVER_LOG_FILE = "/tmp/loopd-server.log"

export async function logServerEvent(
  directory: string,
  event: string,
  details: Record<string, unknown> = {},
): Promise<void> {
  try {
    await appendFile(SERVER_LOG_FILE, `${JSON.stringify({
      timestamp: new Date().toISOString(),
      directory,
      event,
      ...details,
    }, errorReplacer)}\n`)
  } catch {
    // Diagnostics must never break goal processing.
  }
}

/**
 * Content-free arg summary for the global flow trace. Logs shape (keys,
 * types, string lengths) without values, so prompts, paths and secrets never
 * reach the diagnostic log but a postmortem can still see WHAT was called.
 */
export function summarizeArgs(args: unknown): Record<string, string> {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return { shape: Array.isArray(args) ? `array[${(args as unknown[]).length}]` : typeof args }
  }
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
    if (typeof value === "string") out[key] = `string:${value.length}`
    else if (typeof value === "number" || typeof value === "boolean") out[key] = typeof value
    else if (value === null || value === undefined) out[key] = String(value)
    else if (Array.isArray(value)) out[key] = `array[${value.length}]`
    else if (typeof value === "object") out[key] = `object[${Object.keys(value).length}]`
    else out[key] = typeof value
  }
  return out
}

/** Byte length of a tool output payload without logging its content. */
export function outputSize(output: unknown): number {
  try {
    if (typeof output === "string") return Buffer.byteLength(output)
    return Buffer.byteLength(JSON.stringify(output ?? ""))
  } catch {
    return -1
  }
}

export function describeError(value: unknown): string {
  if (value instanceof Error) return value.message
  if (typeof value === "string") return value
  if (typeof value === "object" && value !== null && "message" in value) {
    return String((value as { message: unknown }).message)
  }
  try {
    return JSON.stringify(value, errorReplacer)
  } catch {
    return String(value)
  }
}

function errorReplacer(_key: string, value: unknown) {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack }
  }
  return value
}
