// ─── TUI: Coordination Panel (project-scoped triage drawer) ───────────────────
// Writes / Verification / Reservations for ONE selected project. Numbers come
// from authoritative store reads passed in as props — this component never
// infers staleness from age and never mutates tickets.

/** @jsxImportSource @opentui/solid */
import { For, type JSX } from "solid-js"
import type { TuiThemeCurrent } from "@opencode-ai/plugin/tui"

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
}): JSX.Element {
  const theme = () => props.theme
  const m = () => props.model
  const tabBtn = (id: CoordinationTab, label: string) => (
    <span
      style={{
        fg: props.tab === id ? (theme().info as unknown as string) : (theme().textMuted as unknown as string),
        bold: props.tab === id,
      }}
    >[{label}] </span>
  )
  return (
    <box flexDirection="column" border={true} borderColor={theme().border} padding={1} flexShrink={0} maxHeight={14}>
      <text>
        <span style={{ fg: theme().accent, bold: true }}>Coordination / {m().shortName}</span>
        <span style={{ fg: theme().textMuted }}> — scope = permission · ticket = current write · verification waits for quiet</span>
        {"\n"}
        {tabBtn("writes", "Writes")}{tabBtn("verify", "Verification")}{tabBtn("resv", "Reservations")}
      </text>
      {/* Scrollable body: long holder/queue/reservation lists scroll instead
          of clipping. Text wraps; nothing is cut without a way to reach it. */}
      <scrollbox height={9} scrollX={false} scrollY={true}>
      {props.tab === "writes" && (
        <text>
          <span style={{ fg: theme().textMuted }}>Current write tickets</span>
          <For each={m().holds} fallback={<span style={{ fg: theme().textMuted }}>{"\n"}no active writes</span>}>{(h) => (
            <><span style={{ fg: theme().warning, bold: true }}>{"\n"}HOLD </span><span style={{ fg: theme().text }}>{h.files.join(", ").slice(0, 80)}</span><span style={{ fg: theme().textMuted }}> — {h.goalName} · held {h.age}</span></>
          )}</For>
          {"\n"}<span style={{ fg: theme().textMuted }}>Queued write requests (scope claims are NOT a queue)</span>
          <For each={m().queue} fallback={<span style={{ fg: theme().textMuted }}>{"\n"}none queued</span>}>{(q) => (
            <><span style={{ fg: theme().textMuted }}>{"\n"}WAIT #{q.position} </span><span style={{ fg: theme().text }}>{q.files.join(", ").slice(0, 80)}</span><span style={{ fg: theme().textMuted }}> — {q.goalName} · waits for {q.waitsFor}{q.ownerPriority ? " ★owner" : ""}</span></>
          )}</For>
        </text>
      )}
      {props.tab === "verify" && (
        <text>
          <span style={{ fg: theme().textMuted }}>Verification blockers</span>
          <For each={m().verifyBlockers} fallback={<span style={{ fg: theme().success }}>{"\n"}quiet — checks can run</span>}>{(b) => (
            <><span style={{ fg: theme().warning, bold: true }}>{"\n"}WAIT </span><span style={{ fg: theme().text }}>{b.text.slice(0, 120)}</span>{b.holder && <span style={{ fg: theme().textMuted }}> — {b.holder}</span>}{b.age && <span style={{ fg: theme().textMuted }}> · {b.age}</span>}</>
          )}</For>
          {m().verifyNote && <><span style={{ fg: theme().textMuted }}>{"\n"}</span><span style={{ fg: theme().textMuted }}>{m().verifyNote}</span></>}
        </text>
      )}
      {props.tab === "resv" && (
        <text>
          <span style={{ fg: theme().textMuted }}>Write reservations — release targets exactly one entry after confirmation</span>
          <For each={m().reservations} fallback={<span style={{ fg: theme().textMuted }}>{"\n"}none</span>}>{(r) => (
            <>
              <span style={{ fg: r.live ? theme().warning : theme().error, bold: true }}>{"\n"}{r.live ? "● LIVE " : "! ENDED "}</span>
              <span style={{ fg: theme().text }}>{r.callID.slice(0, 12)}…</span>
              <span style={{ fg: theme().textMuted }}> — {r.goalName} · {r.age}</span>
              {"\n"}<span style={{ fg: theme().textMuted }}>  {r.reason}</span>
              {!r.releasable && <span style={{ fg: theme().error }}> [release unavailable]</span>}
            </>
          )}</For>
        </text>
      )}
      </scrollbox>
    </box>
  )
}
