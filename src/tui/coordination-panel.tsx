// ─── TUI: Coordination Panel (project-scoped triage drawer/popup) ─────────────
// Mirrors #drawer in docs/superpowers/prototypes/2026-11-01-dashboard.html:
// header with 1-line [esc] pill, project subtitle, filled-cyan active sub-tab
// (Writes / Verification / Reservations), j/k-scrollable item list, legend.

/** @jsxImportSource @opentui/solid */
import { For, Show, type JSX } from "solid-js"
import type { TuiThemeCurrent } from "@opencode-ai/plugin/tui"
import type { ScrollBoxRenderable } from "@opentui/core"
import { PALETTE } from "./dashboard-presentation"

export type CoordinationTab = "writes" | "verify" | "resv"

export interface TicketHold {
  files: string[]
  sessionID: string
  goalName: string
  age: string
}

export interface TicketWaiter {
  files: string[]
  sessionID: string
  goalName: string
  position: number
  waitsFor: string
  ownerPriority: boolean
}

export interface VerifyBlocker {
  kind: "operation" | "ticket" | "uncontrolled" | "legacy"
  text: string
  holder?: string
  age?: string
}

export interface ReservationRow {
  callID: string
  sessionID: string
  goalName: string
  live: boolean
  releasable: boolean
  reason: string
  age: string
}

export interface CoordinationModel {
  directory: string
  shortName: string
  holds: TicketHold[]
  queue: TicketWaiter[]
  verifyBlockers: VerifyBlocker[]
  verifyNote?: string
  reservations: ReservationRow[]
}

export function CoordinationPanel(props: {
  theme: TuiThemeCurrent
  model: CoordinationModel
  tab: CoordinationTab
  onTab: (tab: CoordinationTab) => void
  onInspectReservations: () => void
  onRelease: (callID: string) => void
  onOpenSession: (goalID: string) => void
  onClose?: () => void
  scrollRef?: (el: ScrollBoxRenderable | undefined) => void
}): JSX.Element {
  const m = () => props.model
  const tabBtn = (id: CoordinationTab, keyHint: string, label: string) => {
    const active = () => props.tab === id
    return (
      <box
        flexDirection="row"
        backgroundColor={active() ? PALETTE.cyan : PALETTE.base}
        border={true}
        borderColor={active() ? PALETTE.cyan : PALETTE.rule}
        paddingLeft={1}
        paddingRight={1}
        {...({ onMouseDown: () => props.onTab(id) } as any)}
      >
        <text wrapMode="none">
          <span style={{ fg: active() ? PALETTE.tabActiveFg : PALETTE.muted }}>[{keyHint}] </span>
          <span style={{ fg: active() ? PALETTE.tabActiveFg : PALETTE.ink, bold: active() }}>{label}</span>
        </text>
      </box>
    )
  }
  return (
    <box
      flexDirection="column"
      border={true}
      borderColor={PALETTE.cyan}
      backgroundColor={PALETTE.inset}
      paddingLeft={2}
      paddingRight={2}
      paddingTop={1}
      paddingBottom={1}
      gap={1}
      flexShrink={0}
    >
      {/* 1-line header: use a background pill (not border={true}) inside height={1} */}
      <box flexDirection="row" justifyContent="space-between" alignItems="center" height={1} flexShrink={0}>
        <text wrapMode="none">
          <span style={{ fg: PALETTE.cyan, bold: true }}>Coordination</span>
          <span style={{ fg: PALETTE.muted }}> / </span>
          <span style={{ fg: PALETTE.violet, bold: true }}>{m().shortName}</span>
        </text>
        <box
          flexDirection="row"
          backgroundColor={PALETTE.base}
          paddingLeft={1}
          paddingRight={1}
          height={1}
          {...({ onMouseDown: () => props.onClose?.() } as any)}
        >
          <text wrapMode="none">
            <span style={{ fg: PALETTE.amber, bold: true }}>[esc]</span>
          </text>
        </box>
      </box>
      <box flexDirection="row" height={1} flexShrink={0}>
        <text wrapMode="none">
          <span style={{ fg: PALETTE.muted }}>
            {m().directory} · j / k scrolls · w / v / r or Tab switches tab · Esc closes
          </span>
        </text>
      </box>
      <box flexDirection="row" gap={1} flexShrink={0} alignItems="center">
        {tabBtn("writes", "w", `Writes (${m().holds.length})`)}
        {tabBtn("verify", "v", `Verification (${m().verifyBlockers.length})`)}
        {tabBtn("resv", "r", `Reservations (${m().reservations.length})`)}
      </box>
      <scrollbox
        ref={(el) => props.scrollRef?.(el)}
        height={10}
        scrollX={false}
        scrollY={true}
        stickyScroll={false}
      >
        <Show when={props.tab === "writes"}>
          <box flexDirection="column" flexShrink={0} gap={1}>
            <text wrapMode="none">
              <span style={{ fg: PALETTE.cyan }}>Current write tickets</span>
            </text>
            <For
              each={m().holds}
              fallback={
                <box border={true} borderColor={PALETTE.rule} backgroundColor={PALETTE.base} paddingLeft={1} paddingRight={1}>
                  <text wrapMode="none">
                    <span style={{ fg: PALETTE.muted }}>No active writes in this project.</span>
                  </text>
                </box>
              }
            >
              {(h) => (
                <box flexDirection="column" border={true} borderColor={PALETTE.rule} backgroundColor={PALETTE.base} paddingLeft={1} paddingRight={1}>
                  <text wrapMode="word">
                    <span style={{ fg: PALETTE.sage, bold: true }}>● Writing </span>
                    <span style={{ fg: PALETTE.ink, bold: true }}>{h.files.join(", ")}</span>
                  </text>
                  <text wrapMode="none">
                    <span style={{ fg: PALETTE.muted }}>Holder: </span>
                    <span style={{ fg: PALETTE.cyan }}>{h.goalName}</span>
                    <span style={{ fg: PALETTE.muted }}> · session {h.sessionID.slice(0, 14)} · held {h.age}</span>
                  </text>
                </box>
              )}
            </For>
            <text wrapMode="none">
              <span style={{ fg: PALETTE.cyan }}>Queued write requests (scope claims are NOT a queue)</span>
            </text>
            <For
              each={m().queue}
              fallback={
                <box border={true} borderColor={PALETTE.rule} backgroundColor={PALETTE.base} paddingLeft={1} paddingRight={1}>
                  <text wrapMode="none">
                    <span style={{ fg: PALETTE.muted }}>No queued write requests.</span>
                  </text>
                </box>
              }
            >
              {(q) => (
                <box flexDirection="column" border={true} borderColor={PALETTE.rule} backgroundColor={PALETTE.base} paddingLeft={1} paddingRight={1}>
                  <text wrapMode="word">
                    <span style={{ fg: PALETTE.amber, bold: true }}>#{q.position} </span>
                    <span style={{ fg: PALETTE.ink, bold: true }}>{q.goalName}</span>
                    <Show when={q.ownerPriority}>
                      <span style={{ fg: PALETTE.cyan }}> ★owner priority</span>
                    </Show>
                  </text>
                  <text wrapMode="word">
                    <span style={{ fg: PALETTE.ink }}>{q.files.join(", ")}</span>
                  </text>
                  <text wrapMode="word">
                    <span style={{ fg: PALETTE.muted }}>Waits for {q.waitsFor} to finish its write ticket.</span>
                  </text>
                </box>
              )}
            </For>
          </box>
        </Show>

        <Show when={props.tab === "verify"}>
          <box flexDirection="column" flexShrink={0} gap={1}>
            <For
              each={m().verifyBlockers}
              fallback={
                <box border={true} borderColor={PALETTE.rule} backgroundColor={PALETTE.base} paddingLeft={1} paddingRight={1}>
                  <text wrapMode="none">
                    <span style={{ fg: PALETTE.sage }}>● Workspace quiet — host checks can run immediately.</span>
                  </text>
                </box>
              }
            >
              {(b) => (
                <box flexDirection="column" border={true} borderColor={PALETTE.rule} backgroundColor={PALETTE.base} paddingLeft={1} paddingRight={1}>
                  <text wrapMode="word">
                    <span style={{ fg: PALETTE.amber, bold: true }}>● Host checks waiting: </span>
                    <span style={{ fg: PALETTE.ink }}>{b.text}</span>
                  </text>
                  <text wrapMode="word">
                    <span style={{ fg: PALETTE.muted }}>
                      {b.holder ?? "unknown holder"}{b.age ? ` · ${b.age}` : ""} — checks resume after the workspace is quiet.
                    </span>
                  </text>
                </box>
              )}
            </For>
            <box
              flexDirection="row"
              border={true}
              borderColor={PALETTE.rule}
              backgroundColor={PALETTE.base}
              paddingLeft={1}
              paddingRight={1}
              {...({ onMouseDown: () => props.onTab("resv") } as any)}
            >
              <text wrapMode="none">
                <span style={{ fg: PALETTE.cyan }}>[r] Inspect reservations →</span>
              </text>
            </box>
          </box>
        </Show>

        <Show when={props.tab === "resv"}>
          <box flexDirection="column" flexShrink={0} gap={1}>
            <For
              each={m().reservations}
              fallback={
                <box border={true} borderColor={PALETTE.rule} backgroundColor={PALETTE.base} paddingLeft={1} paddingRight={1}>
                  <text wrapMode="none">
                    <span style={{ fg: PALETTE.muted }}>No active or stale reservations in this project.</span>
                  </text>
                </box>
              }
            >
              {(r) => (
                <box flexDirection="column" border={true} borderColor={PALETTE.rule} backgroundColor={PALETTE.base} paddingLeft={1} paddingRight={1}>
                  <text wrapMode="word">
                    <span style={{ fg: r.live ? PALETTE.sage : PALETTE.rose, bold: true }}>
                      {r.live ? "● Live / tracked reservation " : "! Ended reservation "}
                    </span>
                    <span style={{ fg: PALETTE.ink, bold: true }}>{r.callID.slice(0, 18)}</span>
                  </text>
                  <text wrapMode="word">
                    <span style={{ fg: PALETTE.violet }}>{r.goalName}</span>
                    <span style={{ fg: PALETTE.muted }}>
                      {" · session "}{r.sessionID.slice(0, 14)}{" · "}{r.age}
                    </span>
                  </text>
                  <text wrapMode="word">
                    <span style={{ fg: PALETTE.muted }}>{r.reason}</span>
                  </text>
                  <box flexDirection="row" gap={1}>
                    <box
                      flexDirection="row"
                      border={true}
                      borderColor={PALETTE.cyan}
                      backgroundColor={PALETTE.inset}
                      paddingLeft={1}
                      paddingRight={1}
                      {...({ onMouseDown: () => props.onRelease(r.callID) } as any)}
                    >
                      <text wrapMode="none">
                        <span style={{ fg: PALETTE.cyan }}>Release reservation… [W]</span>
                      </text>
                    </box>
                  </box>
                </box>
              )}
            </For>
          </box>
        </Show>
      </scrollbox>
      <box flexDirection="row" height={1} flexShrink={0}>
        <text wrapMode="none">
          <span style={{ fg: PALETTE.muted }}>
            Scope = permission · Ticket = current write · Verification waits for quiet · [W] release · [Esc] close
          </span>
        </text>
      </box>
    </box>
  )
}
