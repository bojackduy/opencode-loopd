/** Exact supported host evidence that a reserved tool execution ended. */
export interface TerminalToolExecution {
  sessionID: string
  callID: string
  status: "completed" | "error"
  endedAt: number
}

export function terminalToolExecution(part: any): TerminalToolExecution | undefined {
  if (part?.type !== "tool" || typeof part.sessionID !== "string" || !part.sessionID ||
      typeof part.callID !== "string" || !part.callID ||
      (part.state?.status !== "completed" && part.state?.status !== "error") ||
      typeof part.state?.time?.end !== "number" || !Number.isFinite(part.state.time.end) || part.state.time.end <= 0) return undefined
  return { sessionID: part.sessionID, callID: part.callID, status: part.state.status, endedAt: part.state.time.end }
}

/**
 * Native message-shape evidence: an assistant content tool part with terminal
 * state. Native pages carry no sessionID/callID on parts — ownership is exact
 * only because the caller proves the page itself came from that session's own
 * scoped list read. Never infer exit from age, idle, generation, goal
 * deletion, absent tail, or probe failure: only a validated terminal status
 * with a finite time.completed counts.
 */
export function nativeTerminalTool(part: any): { callID: string; status: "completed" | "error"; endedAt: number } | undefined {
  if (part?.type !== "tool" || typeof part.id !== "string" || !part.id) return undefined
  const rawStatus = typeof part.state === "string" ? part.state : part.state?.status
  if (rawStatus !== "completed" && rawStatus !== "error") return undefined
  const rawEnd = part.time?.completed
  const endedAt = typeof rawEnd === "number" ? rawEnd
    : typeof rawEnd === "string" ? Date.parse(rawEnd) : NaN
  if (!Number.isFinite(endedAt) || endedAt <= 0) return undefined
  return { callID: part.id, status: rawStatus, endedAt }
}
