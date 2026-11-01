// ─── TUI: Goal Details (inspector + technical drawer) ─────────────────────────
// Mirrors #inspector and #details from docs/superpowers/prototypes/2026-11-01-dashboard.html:
// split title/state header, current activity, latest result or blocker, button
// row, and a 2-column dl-style technical drawer with a bounded scrollbox.

/** @jsxImportSource @opentui/solid */
import { For, Show, type JSX } from "solid-js"
import type { TuiThemeCurrent } from "@opencode-ai/plugin/tui"
import type { ScrollBoxRenderable } from "@opentui/core"
import type { Goal } from "../domain/goal"
import type { GoalRuntimeState } from "../domain/runtime"
import { formatCost, formatTokens, formatDuration } from "./dashboard"
import { PALETTE, goalStatusShort } from "./dashboard-presentation"

export interface InspectorModel {
  goal: Goal
  directory: string
  activityLine?: string
  acting: boolean
  lastResult?: string
  blocked?: { reason: string; needed: string }
  lastProgress?: { summary: string; next?: string }
  agentMeta?: string
  showFocusProject: boolean
  detailsOpen?: boolean
}

function stateBadge(goal: Goal): { text: string; fg: string } {
  if (goal.status === "blocked") return { text: "✖ Blocked", fg: PALETTE.rose }
  if (goal.status === "budget_limited" || goal.status === "usage_limited") {
    return { text: `! ${goalStatusShort(goal.status)}`, fg: PALETTE.rose }
  }
  if (goal.status === "active") {
    return goal.interactive === true
      ? { text: "◐ Awaiting input", fg: PALETTE.amber }
      : { text: "● Working", fg: PALETTE.sage }
  }
  if (goal.status === "paused") return { text: "‖ Paused", fg: PALETTE.muted }
  if (goal.status === "complete") return { text: "✓ Completed", fg: PALETTE.muted }
  return { text: goalStatusShort(goal.status), fg: PALETTE.ink }
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
  const m = () => props.model
  const badge = () => stateBadge(m().goal)
  const proj = () => m().directory.split("/").pop() ?? m().directory
  const btn = (label: string, keyHint: string, onClick: () => void, active = false) => (
    <box
      flexDirection="row"
      backgroundColor={active ? PALETTE.cyan : PALETTE.base}
      border={true}
      borderColor={active ? PALETTE.cyan : PALETTE.rule}
      paddingLeft={1}
      paddingRight={1}
      {...({ onMouseDown: onClick } as any)}
    >
      <text wrapMode="none">
        <span style={{ fg: active ? PALETTE.tabActiveFg : PALETTE.ink, bold: active }}>{label} </span>
        <span style={{ fg: active ? PALETTE.tabActiveFg : PALETTE.cyan }}>[{keyHint}]</span>
      </text>
    </box>
  )
  return (
    <box
      flexDirection="column"
      border={true}
      borderColor={PALETTE.rule}
      backgroundColor={PALETTE.inset}
      paddingLeft={1}
      paddingRight={1}
      paddingTop={0}
      paddingBottom={0}
      flexShrink={0}
    >
      <box flexDirection="row" justifyContent="space-between" alignItems="center" height={1} flexShrink={0}>
        <text wrapMode="none">
          <span style={{ fg: PALETTE.cyan, bold: true }}>{m().goal.name}</span>
          <span style={{ fg: PALETTE.muted }}> / {proj()}</span>
        </text>
        <text wrapMode="none">
          <span style={{ fg: badge().fg, bold: true }}>{badge().text}</span>
        </text>
      </box>
      <box flexDirection="row" height={1} flexShrink={0}>
        <text wrapMode="none">
          <span style={{ fg: PALETTE.ink }}>Now: </span>
          <span style={{ fg: m().acting ? PALETTE.sage : PALETTE.ink }}>{m().activityLine ?? "Idle — between turns"}</span>
        </text>
      </box>
      <box flexDirection="column" flexShrink={0}>
        {m().blocked ? (
          <text wrapMode="word">
            <span style={{ fg: PALETTE.rose, bold: true }}>Blocked: </span>
            <span style={{ fg: PALETTE.rose }}>{m().blocked!.reason.replace(/\s+/g, " ").slice(0, 180)}</span>
            <span style={{ fg: PALETTE.muted }}> — {m().blocked!.needed.replace(/\s+/g, " ").slice(0, 90)}</span>
          </text>
        ) : (
          <text wrapMode="word">
            <span style={{ fg: PALETTE.muted }}>
              {(m().lastResult ?? "No progress reported yet — steer with [s] Send or [Enter] Actions.").replace(/\s+/g, " ").slice(0, 200)}
            </span>
          </text>
        )}
      </box>
      <box flexDirection="row" gap={1} flexShrink={0} alignItems="center">
        {btn("Send", "s", props.onSend)}
        {btn("Open session", "o", props.onOpen)}
        {btn("Actions", "Enter", props.onActions)}
        {btn("Details", "d", props.onDetails, Boolean(m().detailsOpen))}
        <Show when={m().showFocusProject && props.onFocusProject}>
          {btn("Focus project", "f", () => props.onFocusProject?.())}
        </Show>
      </box>
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
  scrollRef?: (el: ScrollBoxRenderable | undefined) => void
}): JSX.Element {
  const m = () => props.model
  const g = () => m().goal
  const maxTurns = () => (g().config as { maxTurns?: number } | undefined)?.maxTurns
  const turnsLabel = () => {
    const rt = m().runtime
    return rt ? `${rt.budgetTurnCount}${maxTurns() ? `/${maxTurns()}` : ""} turns` : "0 turns"
  }
  const dtRow = (dt: string, dd: string) => (
    <box flexDirection="row" flexShrink={0} paddingLeft={1} paddingRight={1}>
      <box width={16} flexShrink={0}>
        <text wrapMode="none">
          <span style={{ fg: PALETTE.muted }}>{dt}</span>
        </text>
      </box>
      <box flexGrow={1} flexShrink={1} minWidth={0}>
        <text wrapMode="word">
          <span style={{ fg: PALETTE.ink }}>{dd}</span>
        </text>
      </box>
    </box>
  )
  return (
    <box
      flexDirection="column"
      border={true}
      borderColor={PALETTE.rule}
      backgroundColor={PALETTE.inset}
      paddingLeft={1}
      paddingRight={1}
      flexShrink={0}
    >
      <box flexDirection="row" justifyContent="space-between" height={1} flexShrink={0}>
        <text wrapMode="none">
          <span style={{ fg: PALETTE.cyan, bold: true }}>Technical details</span>
          <span style={{ fg: PALETTE.muted }}> · table collapsed to 1 row (j/k switches worker, J/K scrolls details)</span>
        </text>
        <text wrapMode="none">
          <span style={{ fg: PALETTE.muted }}>[d / esc] close</span>
        </text>
      </box>
      <scrollbox
        ref={(el) => props.scrollRef?.(el)}
        height={9}
        scrollX={false}
        scrollY={true}
        stickyScroll={false}
      >
        {dtRow("agent / model", `${m().agentLabel} · ${m().modelLabel}`)}
        {dtRow("budget / turns", `${formatCost((g() as unknown as { costUsed?: number }).costUsed)} · ${turnsLabel()} · ${formatTokens(g().tokensUsed)} tok · ${formatDuration(g().timeUsedSeconds)}`)}
        {dtRow("objective", g().objective.replace(/\s+/g, " "))}
        {dtRow("scope", (() => {
          const writeable = g().config.workspaceWrite !== false
          const scope = g().config.write_scope
          if (!writeable) return "(read-only)"
          if (scope === undefined) return "whole workspace (legacy exclusive)"
          if (scope.length === 0) return "exploration only"
          return scope.join(", ")
        })())}
        {dtRow("checks", (g().config.checks ?? []).join(" · ") || "No source changes")}
        {dtRow("diagnostics", `goal: ${g().id} · worker: ${g().workerSessionID ?? "—"} · owner: ${g().ownerSessionID ?? "—"}`)}
        <box
          flexDirection="column"
          border={true}
          borderColor={PALETTE.rule}
          backgroundColor={PALETTE.base}
          paddingLeft={1}
          paddingRight={1}
          flexShrink={0}
        >
          <For each={m().progressHistory.slice(-4)}>
            {(p) => (
              <text wrapMode="word">
                <span style={{ fg: PALETTE.sage }}>✓ </span>
                <span style={{ fg: PALETTE.ink }}>{p.summary.replace(/\s+/g, " ")}</span>
                <Show when={p.next}>
                  <span style={{ fg: PALETTE.muted }}> → {p.next!.replace(/\s+/g, " ")}</span>
                </Show>
              </text>
            )}
          </For>
          <For
            each={m().transcript.slice(-8)}
            fallback={
              <text>
                <span style={{ fg: PALETTE.muted }}>No recent events recorded yet.</span>
              </text>
            }
          >
            {(line) => (
              <text wrapMode="word">
                <span style={{ fg: PALETTE.muted }}>{line}</span>
              </text>
            )}
          </For>
        </box>
      </scrollbox>
    </box>
  )
}
