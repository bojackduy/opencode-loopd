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
