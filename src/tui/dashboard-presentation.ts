// ─── TUI: Dashboard Presentation (pure, headless-testable) ────────────────────
// Row text, scope summary, state-vs-activity classification, and directory
// grouping for the Project/Fleet worker tables. No Solid imports: reviewable
// without rendering. Formatting mirrors the prototype's 4-column rows
// (name / state / current activity / updated) plus attention badges.

import type { Goal } from "../domain/goal"
import type { GoalRuntimeState } from "../domain/runtime"
import { workerActivityLabel } from "../domain/status-labels"

export type AttentionKind = "blocker" | "error" | "limit" | "stale" | "unreachable" | null

export interface RowModel {
  id: string
  directory: string
  name: string
  state: string
  stateLabel: string
  activity: string
  updated: string
  attention: AttentionKind
  attentionText?: string
  turnText?: string
  manual: boolean
}

export interface ScopeSummary {
  needsAction: number
  working: number
  awaiting: number
  paused: number
  done: number
}

export const PALETTE = {
  base: "#222430",
  inset: "#1b1d27",
  rule: "#414552",
  rowRule: "#343744",
  selectedBg: "#1e2e2c",
  ink: "#e8e9ee",
  muted: "#a6a9b7",
  cyan: "#9bddce",
  amber: "#e9c982",
  rose: "#e28d99",
  sage: "#a8cb99",
  tabActiveFg: "#14151c",
} as const

const ATTENTION_STATES = new Set(["blocked", "budget_limited", "usage_limited"])

function stateSymbol(status: Goal["status"], manual: boolean): string {
  if (status === "blocked" || status === "budget_limited" || status === "usage_limited") return "✖"
  if (status === "active") return manual ? "◐" : "●"
  if (status === "paused") return "‖"
  if (status === "complete") return "✓"
  return "•"
}

/** Classify a goal+runtime into a row. Autonomous idle is never "awaiting". */
export function toRowModel(
  goal: Goal,
  directory: string,
  runtime: GoalRuntimeState | undefined,
  now: number,
  opts?: { confirmedIdle?: boolean; queuedInput?: boolean },
): RowModel {
  const activity = runtime ? workerActivityLabel(runtime, now) : undefined
  const stateLabel = goalStatusShort(goal.status)
  let attention: AttentionKind = null
  let attentionText: string | undefined
  if (goal.status === "blocked") {
    attention = "blocker"
    attentionText = goal.blocker?.reason?.replace(/\s+/g, " ").slice(0, 100) ?? "blocked"
  } else if (ATTENTION_STATES.has(goal.status)) {
    attention = "limit"
    attentionText = stateLabel
  }
  if (runtime) {
    const rt = runtime as GoalRuntimeState & {
      consecutiveFailures?: number
      evaluatorRejectionCount?: number
      unknownStatusCount?: number
      activeRunID?: string
      retryAfter?: string
    }
    if ((rt.unknownStatusCount ?? 0) >= 3) {
      attention = "unreachable"
      attentionText = "worker unreachable — nudge to recover"
    } else if (rt.phase === "idle" && rt.activeRunID) {
      attention = "stale"
      attentionText = "stale lease — nudge to force a turn"
    } else if ((rt.consecutiveFailures ?? 0) > 0 && goal.status !== "blocked") {
      attention = "error"
      attentionText = `${rt.consecutiveFailures} failures`
    } else if ((rt.evaluatorRejectionCount ?? 0) > 0 && goal.status !== "blocked") {
      attention = "error"
      attentionText = `${rt.evaluatorRejectionCount} check rejections`
    }
  }
  const maxTurns = (goal.config as { maxTurns?: number } | undefined)?.maxTurns
  const turnText = runtime
    ? `${runtime.budgetTurnCount}${maxTurns ? `/${maxTurns}` : ""}`
    : undefined
  const manual = goal.interactive === true
  const rawLabel = manual && goal.status === "active"
    ? "Awaiting input"
    : goal.status === "active"
      ? "Working"
      : stateLabel
  const sym = stateSymbol(goal.status, manual)
  const label = `${sym} ${rawLabel}`
  const activityLine = goal.status === "blocked" && goal.blocker?.reason
    ? goal.blocker.reason.replace(/\s+/g, " ")
    : attentionText
      ? attentionText
      : goal.lastProgress?.summary
        ? goal.lastProgress.summary.replace(/\s+/g, " ")
        : activity
          ? `${activity.short} — ${activity.hint}`
          : "no runtime yet"
  return {
    id: goal.id,
    directory,
    name: goal.name,
    state: goal.status,
    stateLabel: label,
    activity: activityLine,
    updated: ageText(runtime?.lastProgressAt ?? runtime?.lastRunAt, now),
    attention,
    attentionText,
    turnText,
    manual,
  }
}

/** Fixed worker-table columns so rows align: name / state / activity / updated.
 * Kept compact so the 4 columns fit on one line without mid-row truncation. */
export const ROW_COLS = { name: 24, state: 17, activity: 34, updated: 8 } as const

function col(text: string, width: number): string {
  const chars = [...text]
  if (chars.length > width) return `${chars.slice(0, width - 1).join("")}…`
  return text + " ".repeat(width - chars.length)
}

export interface FormattedRow {
  name: string
  state: string
  activity: string
  updated: string
}

export function formatRowColumns(row: RowModel, activityWidth = ROW_COLS.activity): FormattedRow {
  return {
    name: col(row.name, ROW_COLS.name),
    state: col(row.stateLabel, ROW_COLS.state),
    activity: col(row.activity, activityWidth),
    updated: col(row.updated, ROW_COLS.updated),
  }
}

/**
 * "Awaiting input" is reserved for interactive goals with a confirmed idle
 * worker, no active run, and no queued input. Everything else idle is parked.
 */
export function isAwaitingInput(
  goal: Goal,
  runtime: GoalRuntimeState | undefined,
  confirmedIdle: boolean,
  queuedInput: boolean,
): boolean {
  if (goal.interactive !== true) return false
  if (!runtime || runtime.phase !== "idle") return false
  const rt = runtime as GoalRuntimeState & { activeRunID?: string }
  if (rt.activeRunID) return false
  if (queuedInput) return false
  return confirmedIdle
}

/** Footer hints in priority order, most important first. Dropped from the
 * tail when the bar is narrow. */
export const FOOT_HINTS = [
  "1/2/3 tabs",
  "j/k move",
  "Enter actions",
  "s send",
  "d details",
  "o session",
  "t coordination",
  "/ filter",
  "h history",
  "? help",
] as const

/** Fit hints into maxWidth display columns. Keeps the longest leading run
 * that fits and drops whole trailing hints, appending " …" at a separator
 * boundary when anything was dropped. Never clips mid-hint: if even the
 * first hint plus ellipsis cannot fit, returns "…" alone. */
export function fitHintBar(hints: readonly string[], maxWidth: number): string {
  if (maxWidth <= 1) return "…"
  const full = hints.join(" · ")
  if ([...full].length <= maxWidth) return full
  for (let n = hints.length - 1; n >= 1; n--) {
    const candidate = `${hints.slice(0, n).join(" · ")} …`
    if ([...candidate].length <= maxWidth) return candidate
  }
  const first = `${hints[0]} …`
  return [...first].length <= maxWidth ? first : "…"
}

/** Short status label kept in sync with goalStatusLabel(...).short. */
export function goalStatusShort(status: Goal["status"]): string {
  switch (status) {
    case "active": return "Active"
    case "paused": return "Paused"
    case "blocked": return "Blocked"
    case "complete": return "Complete"
    case "budget_limited": return "Budget limited"
    case "usage_limited": return "Usage limited"
    default: return String(status)
  }
}

export function summarizeScope(
  goals: Array<{ status: Goal["status"]; interactive?: boolean }>,
  isAwaiting: (index: number) => boolean,
): ScopeSummary {
  const out: ScopeSummary = { needsAction: 0, working: 0, awaiting: 0, paused: 0, done: 0 }
  goals.forEach((g, i) => {
    if (g.status === "blocked" || g.status === "budget_limited" || g.status === "usage_limited") out.needsAction += 1
    else if (g.status === "active" && isAwaiting(i)) out.awaiting += 1
    else if (g.status === "active") out.working += 1
    else if (g.status === "paused") out.paused += 1
    else if (g.status === "complete") out.done += 1
  })
  return out
}

export function summaryText(s: ScopeSummary): string {
  const parts = [`${s.needsAction} needs action`, `${s.working} working`, `${s.awaiting} awaiting input`]
  if (s.paused > 0) parts.push(`${s.paused} paused`)
  return parts.join(" · ")
}

export interface DirectoryGroup {
  directory: string
  shortName: string
  needsAction: number
  working: number
  rows: RowModel[]
}

/** Group rows by directory for the Fleet tab; collapsed dirs excluded. */
export function groupByDirectory(rows: RowModel[], collapsed: string[]): DirectoryGroup[] {
  const order: string[] = []
  const byDir = new Map<string, RowModel[]>()
  for (const row of rows) {
    if (collapsed.includes(row.directory)) continue
    if (!byDir.has(row.directory)) {
      byDir.set(row.directory, [])
      order.push(row.directory)
    }
    byDir.get(row.directory)!.push(row)
  }
  return order.map((directory) => {
    const group = byDir.get(directory)!
    return {
      directory,
      shortName: directory.split("/").pop() || directory,
      needsAction: group.filter((r) => r.attention === "blocker" || r.attention === "limit").length,
      working: group.filter((r) => r.attention === null && r.state === "active").length,
      rows: group,
    }
  })
}

/** Selection key stable across refresh/filter/history/collapse. */
export function selectionKey(directory: string, goalID: string): string {
  return `${directory}\n${goalID}`
}

/** Filter rows by free text over name/state/activity/directory. */
export function filterRows(rows: RowModel[], query: string): RowModel[] {
  const q = query.trim().toLowerCase()
  if (!q) return rows
  return rows.filter((r) =>
    `${r.name} ${r.stateLabel} ${r.activity} ${r.directory}`.toLowerCase().includes(q),
  )
}

export function ageText(timestamp: string | undefined, now: number): string {
  if (!timestamp) return "never"
  const seconds = Math.max(0, Math.floor((now - Date.parse(timestamp)) / 1000))
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

export function countdownText(targetIso: string | undefined, now: number): string | undefined {
  if (!targetIso) return undefined
  const diff = Math.max(0, Math.floor((Date.parse(targetIso) - now) / 1000))
  if (diff < 60) return `${diff}s`
  const minutes = Math.floor(diff / 60)
  if (minutes < 60) return `${minutes}m ${diff % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}
