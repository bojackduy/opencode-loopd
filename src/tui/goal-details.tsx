// ─── TUI: Goal Details (inspector + technical drawer) ─────────────────────────
// Pinned compact inspector (latest result/blocker + action buttons) and the
// technical drawer (full objective, model/agent/budgets/turns, exact
// scope/checks, transcript/progress/history, raw IDs). Nothing discarded:
// every field the old detail panel showed lives in one of the two.

/** @jsxImportSource @opentui/solid */
import { For, Show, type JSX } from "solid-js"
import type { TuiThemeCurrent } from "@opencode-ai/plugin/tui"
import type { Goal } from "../domain/goal"
import type { GoalRuntimeState } from "../domain/runtime"
import { formatCost, formatTokens, formatDuration } from "./dashboard"

export interface InspectorModel {
  goal: Goal
  directory: string
  /** Short worker-activity line, precomputed by the shell. */
  activityLine?: string
  acting: boolean
  lastResult?: string
  blocked?: { reason: string; needed: string }
  lastProgress?: { summary: string; next?: string }
  agentMeta?: string
  showFocusProject: boolean
}

export function GoalInspector(props: {
  theme: TuiThemeCurrent
  model: InspectorModel
  onSend: () => void
  onOpen: () => void
  onActions: () => void
  onDetails: () => void
  onFocusProject?: () => void
}): JSX.Element {
  const theme = () => props.theme
  const m = () => props.model
  const statusFg = () => statusColor(m().goal.status, theme())
  return (
    <box flexDirection="column" border={true} borderColor={statusFg() as unknown as string} padding={1} flexShrink={0} maxHeight={9}>
      <text>
        <span style={{ fg: statusFg(), bold: true }}>{m().goal.name}</span>
        <span style={{ fg: theme().textMuted }}> / {m().directory.split("/").pop() ?? m().directory}</span>
        <span style={{ fg: theme().textMuted }}> │ Now: </span>
        <span style={{ fg: m().acting ? statusFg() : theme().textMuted }}>{m().activityLine ?? "—"}</span>
        {m().blocked
          ? <><span style={{ fg: theme().error, bold: true }}>{"\n"}✖ Blocked: </span><span style={{ fg: theme().error }}>{m().blocked!.reason.slice(0, 140)}</span><span style={{ fg: theme().textMuted }}> — {m().blocked!.needed.slice(0, 60)}</span></>
          : m().lastResult
            ? <><span style={{ fg: theme().textMuted }}>{"\n"}</span><span style={{ fg: theme().text }}>{m().lastResult!.slice(0, 160)}</span></>
            : null}
        {"\n"}
        <span style={{ fg: theme().warning }}>[s] Send</span>
        <span style={{ fg: theme().textMuted }}> · </span>
        <span style={{ fg: theme().warning }}>[o] Open session</span>
        <span style={{ fg: theme().textMuted }}> · </span>
        <span style={{ fg: theme().warning }}>[Enter] Actions</span>
        <span style={{ fg: theme().textMuted }}> · </span>
        <span style={{ fg: theme().warning }}>[d] Details</span>
        {m().showFocusProject && <><span style={{ fg: theme().textMuted }}> · </span><span style={{ fg: theme().warning }}>[focus] Project</span></>}
      </text>
    </box>
  )
}

export interface DetailsModel {
  goal: Goal
  runtime?: GoalRuntimeState
  transcript: string[]
  progressHistory: Array<{ summary: string; next?: string; at?: string }>
  agentLabel: string
  modelLabel: string
}

export function GoalDetailsDrawer(props: {
  theme: TuiThemeCurrent
  model: DetailsModel
}): JSX.Element {
  const theme = () => props.theme
  const m = () => props.model
  const g = () => m().goal
  /** One label/value row that wraps inside the frame instead of overflowing
   * it. Long values (objective, scope, checks) are the usual overflow source. */
  const row = (label: string, value: string) => (
    <box flexDirection="column" flexShrink={0} paddingLeft={1} paddingRight={1}>
      <text wrapMode="word" minWidth={0}>
        <span style={{ fg: theme().textMuted }}>{label}: </span>
        <span style={{ fg: theme().text }}>{value}</span>
      </text>
    </box>
  )
  return (
    <box flexDirection="column" border={true} borderColor={theme().border} flexShrink={0} flexGrow={1} minHeight={6}>
      {/* Structured metadata: fixed label/value alignment, wrapped, scrollable. */}
      <scrollbox flexDirection="column" flexGrow={1} minHeight={0} scrollX={false} scrollY={true} stickyScroll={false}>
        {row("agent / model", `${m().agentLabel} · ${m().modelLabel}`)}
        {row("budget / turns", `${formatCost((g() as unknown as { costUsed?: number }).costUsed)} · ${formatTokens(g().tokensUsed)} tokens · ${formatDuration(g().timeUsedSeconds)}`)}
        {row("objective", g().objective)}
        {row("scope", (() => {
          const writeable = g().config.workspaceWrite !== false
          const scope = g().config.write_scope
          if (!writeable) return "(read-only)"
          if (scope === undefined) return "whole workspace (legacy exclusive)"
          if (scope.length === 0) return "exploration only"
          return scope.join(", ")
        })())}
        {row("checks", (g().config.checks ?? []).join(" · ") || "none")}
        {row("goal / worker", `${g().id} · ${g().workerSessionID ?? "—"}`)}
        {row("owner", g().ownerSessionID ?? "—")}
        {/* Event history is a separate region with its own scroll. */}
        <box flexDirection="column" flexShrink={0} paddingLeft={1} paddingRight={1} paddingTop={1}>
          <text><span style={{ fg: theme().accent, bold: true }}>Recent activity</span><span style={{ fg: theme().textMuted }}> — newest last</span></text>
        </box>
        <For each={m().progressHistory.slice(-5)}>{(p) => (
          <box flexDirection="column" flexShrink={0} paddingLeft={1} paddingRight={1}>
            <text wrapMode="word" minWidth={0}><span style={{ fg: theme().textMuted }}>✓ </span><span style={{ fg: theme().text }}>{p.summary}</span></text>
            <Show when={p.next}><text wrapMode="word" minWidth={0}><span style={{ fg: theme().textMuted }}>  next: {p.next}</span></text></Show>
          </box>
        )}</For>
        <For each={m().transcript.slice(-10)}>{(line) => (
          <box flexDirection="column" flexShrink={0} paddingLeft={1} paddingRight={1}>
            <text wrapMode="word" minWidth={0}><span style={{ fg: theme().textMuted }}>{line}</span></text>
          </box>
        )}</For>
      </scrollbox>
    </box>
  )
}

function statusColor(status: Goal["status"], theme: TuiThemeCurrent): string {
  switch (status) {
    case "active": return theme.success as unknown as string
    case "paused": return theme.warning as unknown as string
    case "blocked": return theme.error as unknown as string
    case "complete": return theme.info as unknown as string
    case "budget_limited":
    case "usage_limited": return theme.accent as unknown as string
    default: return theme.text as unknown as string
  }
}
