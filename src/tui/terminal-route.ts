// ─── TUI: Full-screen Terminal Route Contract (headless-testable) ─────────────
// Stable plugin-owned route for one command session:
//   v1: api.route.register / route.navigate
//   v2: ctx.ui.router.register / navigate({ type: "plugin", name, data })
// Route data carries commandID + ownerSessionID + returnSessionID. Validation
// is fail-closed: invalid/missing/cross-owner data renders safely and must
// never subscribe or write.

import type { CommandSession } from "../domain/command-session"

export const TERMINAL_ROUTE_NAME = "opencode.loopd.terminal"

export interface TerminalRouteData {
  commandID: string
  ownerSessionID: string
  returnSessionID: string
}

export type TerminalRouteValidation =
  | { ok: true; data: TerminalRouteData }
  | { ok: false; reason: string }

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0
}

/** Validate raw route data (v1 params or v2 data). Never throws. */
export function validateTerminalRouteData(raw: unknown): TerminalRouteValidation {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, reason: "route-data-missing" }
  }
  const r = raw as Record<string, unknown>
  if (!isNonEmptyString(r["commandID"])) return { ok: false, reason: "commandID-required" }
  if (!isNonEmptyString(r["ownerSessionID"])) return { ok: false, reason: "ownerSessionID-required" }
  if (!isNonEmptyString(r["returnSessionID"])) return { ok: false, reason: "returnSessionID-required" }
  return {
    ok: true,
    data: {
      commandID: r["commandID"],
      ownerSessionID: r["ownerSessionID"],
      returnSessionID: r["returnSessionID"],
    },
  }
}

/** Build the navigation payload for opening a command fullscreen. */
export function terminalRoutePayload(
  commandID: string,
  ownerSessionID: string,
  returnSessionID: string,
): Record<string, unknown> {
  return { commandID, ownerSessionID, returnSessionID }
}

/**
 * Dashboard-flow consistency check. Route data is NOT an authentication
 * token — server/service ownership checks (stored-state pre-check,
 * per-snapshot re-check, broker subscribe ownership) remain authoritative
 * and are re-verified on the receiving side. For the supported dashboard
 * flow the command owner and the originating return session are the same
 * trusted current session; receivers fail closed when they differ and must
 * never subscribe or write.
 */
export function isTerminalRouteConsistent(data: TerminalRouteData): boolean {
  return data.ownerSessionID === data.returnSessionID
}

/** Read the current session ID from a v1-shaped route (fail-closed). */
export function currentRouteSessionID(
  api: unknown,
): string | undefined {
  try {
    const current = (
      api as unknown as { route?: { current?: { name?: string; params?: { sessionID?: string } } } }
    ).route?.current
    if (current?.name === "session" && current.params?.sessionID) return current.params.sessionID
  } catch {}
  return undefined
}
/** Owner-scoped command filter for the shared dashboard Commands view. */
export function filterCommandsByOwner(
  commands: CommandSession[],
  ownerSessionID: string | undefined,
): CommandSession[] {
  if (!ownerSessionID) return []
  return commands.filter((c) => c.ownerSessionID === ownerSessionID)
}

export type OpenTarget =
  | { kind: "goal"; workerSessionID: string }
  | { kind: "command"; data: TerminalRouteData }
  | { kind: "none"; reason: string }

/**
 * `o` dispatch by active selection type. Goals open their native worker
 * session (unchanged); commands navigate to the plugin-owned terminal route.
 * Never applies a goal action to a command selection or vice versa.
 */
export function resolveOpenTarget(input: {
  selection: { kind: "goal"; workerSessionID?: string } | { kind: "command"; commandID?: string } | null
  ownerSessionID: string | undefined
  returnSessionID: string | undefined
}): OpenTarget {
  const sel = input.selection
  if (!sel) return { kind: "none", reason: "no-selection" }
  if (sel.kind === "goal") {
    if (!sel.workerSessionID) return { kind: "none", reason: "no-worker-session" }
    return { kind: "goal", workerSessionID: sel.workerSessionID }
  }
  // Command selection → terminal route. All three IDs are required; the
  // route validator re-checks on the receiving side (fail-closed twice).
  if (!sel.commandID) return { kind: "none", reason: "no-command" }
  if (!input.ownerSessionID) return { kind: "none", reason: "owner-required" }
  if (!input.returnSessionID) return { kind: "none", reason: "return-required" }
  return {
    kind: "command",
    data: {
      commandID: sel.commandID,
      ownerSessionID: input.ownerSessionID,
      returnSessionID: input.returnSessionID,
    },
  }
}
