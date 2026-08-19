// ─── Shared: SDK Helpers ─────────────────────────────────────────────────────
// Minimal helpers for interacting with the OpenCode client SDK.

export function sdkError(result: unknown): string | undefined {
  if (!result || typeof result !== "object") return undefined
  const data = result as Record<string, unknown>
  if (typeof data.error === "string") return data.error
  if (data.error && typeof data.error === "object") {
    const err = data.error as Record<string, unknown>
    if (typeof err.message === "string") return err.message
  }
  return undefined
}

export function sdkData<T>(result: unknown): T | undefined {
  if (!result || typeof result !== "object") return undefined
  const data = result as Record<string, unknown>
  if ("data" in data && typeof data.data !== "undefined") return data.data as T
  return undefined
}

export function sdkErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  return String(error)
}

export async function sdkCall<T>(
  fn: (...args: any[]) => Promise<any>,
  ...argsList: any[]
): Promise<T | undefined> {
  try {
    const result = await fn(...argsList)
    if (sdkError(result)) return undefined
    return sdkData<T>(result)
  } catch {
    return undefined
  }
}
