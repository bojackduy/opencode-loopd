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
