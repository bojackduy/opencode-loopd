// ─── TUI: Dashboard Component ────────────────────────────────────────────────
// Modal dashboard — single always-focused input traps keys, no leak to chat.
// Scrollable sections with input always visible at bottom.

/** @jsxImportSource @opentui/solid */
import { createSignal, For, Show, onCleanup, onMount, createEffect } from "solid-js"
import { useKeyboard } from "@opentui/solid"
import type { TuiPluginApi, TuiThemeCurrent } from "@opencode-ai/plugin/tui"
import type { InputRenderable, ParsedKey } from "@opentui/core"
import { readEvents } from "../infrastructure/state-repository"
import { createControlClient } from "../infrastructure/control-client"
import type { StoreState } from "../infrastructure/state-repository"
import type { Goal, GoalStatus } from "../domain/goal"
import type { GoalRuntimeState, RuntimePhase } from "../domain/runtime"
import { parseCommand, commandHelp } from "./command-parser"
import { bugReportUrl, openBrowserUrl } from "../browser"
import { randomUUID } from "crypto"

const LOG_FILE = "/tmp/loopd-tui.log"
function debugLog(...args: unknown[]) {
  try {
    const { appendFileSync } = require("node:fs") as typeof import("node:fs")
    appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${args.map((a) => typeof a === "string" ? a : JSON.stringify(a)).join(" ")}\n`)
  } catch {}
}
function prevent(evt: ParsedKey) {
  const e = evt as ParsedKey & { preventDefault?: () => void; stopPropagation?: () => void }
  e.preventDefault?.()
  e.stopPropagation?.()
}

type Mode = "normal" | "insert"

interface Props {
  api: TuiPluginApi
  directory: string
}

function statusColor(status: GoalStatus, theme: TuiThemeCurrent) {
  switch (status) {
    case "active": return theme.success
    case "paused": return theme.warning
    case "blocked": return theme.error
    case "complete": return theme.info
    case "budget_limited": return theme.accent
    case "usage_limited": return theme.accent
    default: return theme.text
  }
}
function phaseColor(phase: RuntimePhase, theme: TuiThemeCurrent) {
  switch (phase) {
    case "running": return theme.success
    case "compacting": return theme.warning
    case "waiting_retry": return theme.accent
    case "stopping": return theme.error
    default: return theme.textMuted
  }
}
function borderColorForStatus(status: GoalStatus, theme: TuiThemeCurrent): string {
  switch (status) {
    case "active": return theme.success as unknown as string
    case "paused": return theme.warning as unknown as string
    case "blocked": return theme.error as unknown as string
    case "budget_limited":
    case "usage_limited": return theme.accent as unknown as string
    default: return "gray"
  }
}
function eventColor(type: string, theme: TuiThemeCurrent) {
  if (type === "goal.completed") return theme.info
  if (type === "goal.blocked" || type === "run.failed") return theme.error
  if (type === "goal.created" || type === "goal.progress") return theme.success
  if (type === "run.started" || type === "compaction.started") return theme.warning
  return theme.textMuted
}
function phaseIcon(phase: RuntimePhase): string {
  switch (phase) {
    case "running": return "▶"
    case "compacting": return "⏳"
    case "waiting_retry": return "🔄"
    case "stopping": return "⏹"
    case "queued": return "◷"
    case "idle": return "○"
    default: return "○"
  }
}
function statusIcon(status: GoalStatus): string {
  switch (status) {
    case "active": return "●"
    case "paused": return "❚❚"
    case "blocked": return "✖"
    case "complete": return "✓"
    case "budget_limited": return "⬢"
    case "usage_limited": return "⏰"
    default: return "○"
  }
}

function ageLabel(timestamp: string | undefined, now: number): string {
  if (!timestamp) return "never"
  const seconds = Math.max(0, Math.floor((now - Date.parse(timestamp)) / 1000))
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  return `${Math.floor(minutes / 60)}h ago`
}

export function LoopDashboard(props: Props) {
  const theme = () => props.api.theme.current
  const [mode, setMode] = createSignal<Mode>("normal")
  const [selected, setSelected] = createSignal(0)
  const [commandInput, setCommandInput] = createSignal("")
  const [statusText, setStatusText] = createSignal("Press : to send/command, ? help, o open, q close")
  const [state, setState] = createSignal<StoreState | null>(null)
  const [events, setEvents] = createSignal<Record<string, unknown>[]>([])
  const [selectedGoal, setSelectedGoal] = createSignal<Goal | null>(null)
  const [showLogs, setShowLogs] = createSignal(false)
  const [showHelp, setShowHelp] = createSignal(false)
  const [clock, setClock] = createSignal(Date.now())
  let inputEl: InputRenderable | undefined
  let focusTimer: ReturnType<typeof setTimeout> | undefined
  const client = createControlClient(props.directory)
  const popMode = props.api.mode.push("loopd.dashboard")

  function focusInput() {
    if (focusTimer) clearTimeout(focusTimer)
    focusTimer = setTimeout(() => {
      const current = props.api.renderer.currentFocusedRenderable
      if (current && current !== inputEl) current.blur()
      inputEl?.focus()
    }, 10)
  }

  async function refresh() {
    try {
      const s = await client.getState()
      setState(s)
      const goals = s.goals.filter((g) => g.status !== "complete")
      if (goals.length > 0 && selected() >= goals.length) setSelected(goals.length - 1)
      setSelectedGoal(goals[selected()] || null)
      setEvents(await client.getEvents(20))
    } catch (e) {
      setStatusText(`Error: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  refresh()
  const unsubs = [
    props.api.event.on("session.idle", () => refresh()),
    props.api.event.on("session.status", () => refresh()),
    props.api.event.on("session.error", () => refresh()),
    props.api.event.on("session.compacted", () => refresh()),
    setInterval(refresh, 10000),
    setInterval(() => setClock(Date.now()), 500),
  ]
  onCleanup(() => {
    popMode()
    if (focusTimer) clearTimeout(focusTimer)
    for (const u of unsubs) typeof u === "function" ? u() : clearInterval(u as unknown as number)
  })

  onMount(() => {
    try { const { writeFileSync } = require("node:fs") as typeof import("node:fs"); writeFileSync(LOG_FILE, `[${new Date().toISOString()}] dashboard mounted dir=${props.directory} mode=${mode()} dialogOpen=${props.api.ui.dialog.open}\n`) } catch {}
    debugLog("mounted", "dialogOpen", props.api.ui.dialog.open, "directory", props.directory)
    focusInput()
  })
  createEffect(() => { const m = mode(); debugLog("mode ->", m); focusInput() })

  function enterInsertMode() {
    setCommandInput("")
    if (inputEl) inputEl.value = ""
    setMode("insert")
    focusInput()
  }

  function returnToNormalMode() {
    setCommandInput("")
    if (inputEl) inputEl.value = ""
    setMode("normal")
    focusInput()
  }

  useKeyboard((evt: ParsedKey) => {
    const name = evt.name || ""
    const seq = (evt as unknown as { sequence?: string }).sequence || ""
    const raw = (evt as unknown as { raw?: string }).raw || ""
    debugLog("useKeyboard", `name=${name} seq=${JSON.stringify(seq)} raw=${JSON.stringify(raw)} shift=${(evt as unknown as { shift?: boolean }).shift} ctrl=${evt.ctrl} mode=${mode()} dialogOpen=${props.api.ui.dialog.open}`)
    if (!props.api.ui.dialog.open) return
    const isColon = name === ":" || seq === ":" || raw === ":" || seq.includes(":") || raw.includes(":") || name === ";" || name === "colon"
    const isQuestion = name === "?" || seq === "?" || raw === "?" || seq.includes("?") || raw.includes("?")
    debugLog("isColon", isColon, "isQuestion", isQuestion, "modeBefore", mode())
    if (mode() === "insert") {
      if (evt.ctrl && name.toLowerCase() === "n") {
        prevent(evt)
        returnToNormalMode()
        debugLog("insert -> normal via ctrl+n")
      }
      return
    }
    if (isColon) { prevent(evt); enterInsertMode(); debugLog("normal -> insert"); return }
    if (isQuestion) { prevent(evt); setShowHelp((value) => !value); debugLog("toggle help"); return }
    const key = raw || seq || name
    const currentGoals = state()?.goals.filter((goal) => goal.status !== "complete") || []
    if (name === "down" || key === "j") { prevent(evt); setSelected((index) => Math.min(currentGoals.length - 1, index + 1)); return }
    if (name === "up" || key === "k") { prevent(evt); setSelected((index) => Math.max(0, index - 1)); return }
    if (key === "g") { prevent(evt); setSelected(0); return }
    if (key === "G") { prevent(evt); setSelected(Math.max(0, currentGoals.length - 1)); return }
    if (key === "p") { prevent(evt); void executeCommand("pause"); return }
    if (key === "r") { prevent(evt); void executeCommand("resume"); return }
    if (key === "R") { prevent(evt); void executeCommand("retry"); return }
    if (key === "x") { prevent(evt); void executeCommand("clear"); return }
    if (key === "L") { prevent(evt); setShowLogs((value) => !value); return }
    if (key === "o") {
      prevent(evt)
      const goal = selectedGoal()
      if (goal?.workerSessionID) {
        props.api.route.navigate("session", { sessionID: goal.workerSessionID })
        props.api.ui.dialog.clear()
      }
      return
    }
    if (key === "B") {
      prevent(evt)
      const goal = selectedGoal()
      const extra = goal ? `Goal: ${goal.name} (${goal.id.slice(0,8)}) status=${goal.status} objective=${goal.objective.slice(0,120)}` : "No goal selected"
      const url = bugReportUrl({ runtimeLabel: `opencode-loopd dashboard`, extra })
      const res = openBrowserUrl(url)
      setStatusText(res.status === "opened" ? "Opening bug report in browser…" : `Could not open browser: ${res.reason} — ${url}`)
      return
    }
    if (key === "q") { prevent(evt); props.api.ui.dialog.clear(); return }
  })

  const goals = () => state()?.goals.filter((g) => g.status !== "complete") || []

  async function executeCommand(cmd: string) {
    debugLog("executeCommand raw=", JSON.stringify(cmd))
    const parsed = parseCommand(cmd)
    debugLog("parsed", parsed)
    if (!parsed) { setStatusText("Empty command"); debugLog("empty command"); return }
    try {
      switch (parsed.command) {
        case "send": {
          if (!selectedGoal()) { setStatusText("No goal selected"); break }
          const message = parsed.positional.join(" ") || parsed.args.message || ""
          if (!message) { setStatusText("Usage: :send <message>"); break }
          const r = await client.execute({ version: 1, requestID: randomUUID(), requestedAt: new Date().toISOString(), command: "send", goalID: selectedGoal()!.id, args: { message } })
          setStatusText(r.ok ? r.message : `Error: ${r.message}`); if (r.ok) await refresh()
          break
        }
        case "open": {
          const goal = selectedGoal()
          if (!goal?.workerSessionID) { setStatusText("No worker session"); break }
          props.api.route.navigate("session", { sessionID: goal.workerSessionID })
          props.api.ui.dialog.clear()
          return
        }
        case "force": {
          if (!selectedGoal()) { setStatusText("No goal"); break }
          const summary = parsed.positional.join(" ") || parsed.args.summary || "Force-completed from dashboard."
          const evidence = parsed.args.evidence || "Manual override — no verification checks run."
          const r = await client.execute({ version: 1, requestID: randomUUID(), requestedAt: new Date().toISOString(), command: "force_complete", goalID: selectedGoal()!.id, args: { summary, evidence } })
          setStatusText(r.ok ? r.message : `Error: ${r.message}`); if (r.ok) await refresh()
          break
        }
        case "block": {
          if (!selectedGoal()) { setStatusText("No goal"); break }
          const reason = parsed.positional.join(" ") || parsed.args.reason || "Blocked from dashboard."
          const needed = parsed.args.needed || "User intervention required."
          const r = await client.execute({ version: 1, requestID: randomUUID(), requestedAt: new Date().toISOString(), command: "block", goalID: selectedGoal()!.id, args: { reason, needed } })
          setStatusText(r.ok ? r.message : `Error: ${r.message}`); if (r.ok) await refresh()
          break
        }
        case "pause": { if (!selectedGoal()) { setStatusText("No goal"); break } const r = await client.execute({ version: 1, requestID: randomUUID(), requestedAt: new Date().toISOString(), command: "pause", goalID: selectedGoal()!.id }); setStatusText(r.ok ? r.message : `Error: ${r.message}`); if (r.ok) await refresh(); break }
        case "resume": { if (!selectedGoal()) { setStatusText("No goal"); break } const r = await client.execute({ version: 1, requestID: randomUUID(), requestedAt: new Date().toISOString(), command: "resume", goalID: selectedGoal()!.id }); setStatusText(r.ok ? r.message : `Error: ${r.message}`); if (r.ok) await refresh(); break }
        case "retry": { if (!selectedGoal()) { setStatusText("No goal"); break } const r = await client.execute({ version: 1, requestID: randomUUID(), requestedAt: new Date().toISOString(), command: "retry", goalID: selectedGoal()!.id }); setStatusText(r.ok ? r.message : `Error: ${r.message}`); if (r.ok) await refresh(); break }
        case "clear": { if (!selectedGoal()) { setStatusText("No goal"); break } const r = await client.execute({ version: 1, requestID: randomUUID(), requestedAt: new Date().toISOString(), command: "clear", goalID: selectedGoal()!.id }); setStatusText(r.ok ? r.message : `Error: ${r.message}`); if (r.ok) await refresh(); break }
        // Legacy: keep :goal start but redirect — creation belongs in parent chat
        case "goal": { setStatusText("Create goals via /goal in the parent chat (agent clarifies first). Dashboard: :send to steer the worker."); break }
        case "bug":
        case "report": {
          const goal = selectedGoal()
          const extra = goal ? `Goal: ${goal.name} (${goal.id.slice(0,8)}) status=${goal.status} objective=${goal.objective.slice(0,120)}` : "No goal selected"
          const url = bugReportUrl({ runtimeLabel: `opencode-loopd dashboard`, extra })
          const res = openBrowserUrl(url)
          setStatusText(res.status === "opened" ? "Opening bug report in browser…" : `Could not open browser: ${res.reason} — ${url}`)
          break
        }
        case "logs": setShowLogs(!showLogs()); break
        case "help": setShowHelp(true); break
        case "q": case "close": props.api.ui.dialog.clear(); return
        default: {
          // Bare text in insert mode → treat as send to selected goal
          if (parsed.command && selectedGoal()) {
            const message = parsed.raw
            const r = await client.execute({ version: 1, requestID: randomUUID(), requestedAt: new Date().toISOString(), command: "send", goalID: selectedGoal()!.id, args: { message } })
            setStatusText(r.ok ? `sent: ${message.slice(0, 80)}` : `Error: ${r.message}`); if (r.ok) await refresh()
          } else setStatusText(`Unknown: ${parsed.command}. ? for help`)
        }
      }
    } catch (e) { setStatusText(`Error: ${e instanceof Error ? e.message : String(e)}`) }
    returnToNormalMode()
  }

  const activeGoals = () => state()?.goals.filter((g) => g.status !== "complete") || []
  const runningCount = () => state()?.runtimes.filter((runtime) => runtime.phase === "running").length || 0
  const runningFrame = () => ["|", "/", "-", "\\"][Math.floor(clock() / 500) % 4]

  createEffect(() => setSelectedGoal(activeGoals()[selected()] || null))

  return (
    <box flexDirection="column" width="100%" alignItems="center" padding={1}>
      <box flexDirection="column" width="90%" border={true} borderColor={theme().border} padding={1}>
        {/* Header — always visible, vivid */}
        <box flexDirection="row" padding={0} flexShrink={0}>
          <text>
            <span style={{ fg: theme().primary, bold: true }}>⬢ Loop Dashboard</span>
            <span style={{ fg: theme().textMuted }}> │ </span>
            <span style={{ fg: mode() === "normal" ? theme().success : theme().warning, bold: true, bg: mode() === "insert" ? (theme().backgroundElement as unknown as string) : undefined }}> {mode().toUpperCase()} </span>
            <span style={{ fg: theme().textMuted }}> │ </span>
            <span style={{ fg: theme().accent, bold: true }}>{activeGoals().length}</span>
            <span style={{ fg: theme().textMuted }}> goals</span>
            <span style={{ fg: theme().textMuted }}> │ </span>
            <span style={{ fg: runningCount() > 0 ? theme().success : theme().textMuted, bold: runningCount() > 0 }}>{runningCount() > 0 ? runningFrame() : "○"} {runningCount()} RUNNING</span>
            <span style={{ fg: theme().textMuted }}> │ </span>
            <span style={{ fg: theme().info, bold: true }}>{state()?.goals.filter((g) => g.status === "complete").length || 0}</span>
            <span style={{ fg: theme().textMuted }}> done</span>
          </text>
        </box>

        {/* Scrollable body — grows, hides overflow */}
        <box flexDirection="column" flexGrow={1} minHeight={0} overflow="hidden">
          {/* Help panel — single text to avoid flex overlap */}
          <Show when={showHelp()}>
            <box flexDirection="column" padding={1} border={true} borderColor="yellow" backgroundColor={theme().background} flexShrink={0} maxHeight={14} overflow="hidden">
              <text>
                <span style={{ fg: "yellow", bold: true }}>━━━ Keys: ? toggle  : insert  Ctrl+N normal  o open  B bug  q close ━━━</span>
                <For each={commandHelp().split("\n")}>{(line) => {
                  const isHeader = line.startsWith("Modes:") || line.startsWith("Nav:") || line.startsWith("Commands")
                  const isCmd = line.trim().startsWith(":")
                  return (
                    <>
                      {"\n"}
                      <span style={{ fg: isHeader ? theme().primary : isCmd ? theme().warning : theme().text, bold: isHeader }}>{line}</span>
                    </>
                  )
                }}</For>
              </text>
            </box>
          </Show>

          {/* Goal list — takes remaining space, clipped */}
          <box flexDirection="column" flexGrow={1} padding={1} minHeight={0} overflow="hidden">
            <Show when={activeGoals().length > 0} fallback={
              <box flexDirection="column" gap={1}>
                <text><span style={{ fg: theme().textMuted }}>No active goals.</span><span style={{ fg: theme().accent }}> /goal</span><span style={{ fg: theme().textMuted }}> in parent chat to create one.</span></text>
                <text><span style={{ fg: theme().textMuted }}>Tip: </span><span style={{ fg: theme().warning }}>:send</span><span style={{ fg: theme().textMuted }}> to steer the worker · </span><span style={{ fg: theme().warning }}>o</span><span style={{ fg: theme().textMuted }}> to open child · </span><span style={{ fg: theme().warning }}>:force</span><span style={{ fg: theme().textMuted }}> to complete manually.</span></text>
              </box>
            }>
              <For each={activeGoals()}>
                {(goal, i) => {
                  const runtime = () => state()?.runtimes.find((r) => r.goalID === goal.id)
                  const isActive = () => i() === selected()
                  const maxTurns = (goal.config as any)?.maxTurns as number | undefined
                  const turnColor = () => {
                    if (!runtime() || !maxTurns) return phaseColor(runtime()?.phase || "idle", theme())
                    const ratio = runtime()!.turnCount / maxTurns
                    if (ratio >= 1) return theme().error
                    if (ratio >= 0.8) return theme().warning
                    return phaseColor(runtime()!.phase || "idle", theme())
                  }
                  return (
                    <box flexDirection="row" paddingLeft={1} paddingRight={1} backgroundColor={isActive() ? theme().backgroundElement : undefined}>
                      <text>
                        <span style={{ fg: statusColor(goal.status, theme()), bold: isActive() }}>{isActive() ? `▶ ${statusIcon(goal.status)} ${goal.name}` : `  ${statusIcon(goal.status)} ${goal.name}`}</span>
                        <span style={{ fg: theme().textMuted }}> │ </span>
                        <span style={{ fg: statusColor(goal.status, theme()), bold: true }}>{goal.status.toUpperCase()}</span>
                        {runtime() && <>
                          <span style={{ fg: theme().textMuted }}> │ </span>
                          <span style={{ fg: turnColor(), bold: runtime()!.phase === "running" }}>{runtime()!.phase === "running" ? runningFrame() : phaseIcon(runtime()!.phase)} {runtime()!.phase.toUpperCase()}</span>
                          <span style={{ fg: turnColor() }}> {runtime()!.turnCount}{maxTurns ? `/${maxTurns}` : ""}</span>
                          <span style={{ fg: theme().textMuted }}> {ageLabel(runtime()!.lastProgressAt || runtime()!.lastRunAt, clock())}</span>
                        </>}
                        {runtime() && runtime()!.consecutiveFailures > 0 && <span style={{ fg: theme().error, bold: true }}> │ ⚠ {runtime()!.consecutiveFailures} fail</span>}
                        {runtime() && (runtime()!.noProgressCount || 0) > 0 && <span style={{ fg: theme().warning }}> │ {runtime()!.noProgressCount} no-progress</span>}
                      </text>
                    </box>
                  )
                }}
              </For>
            </Show>
          </box>

          {/* Goal detail — fixed, bounded, border matches status */}
          <Show when={selectedGoal()}>
            {(goal) => {
              const rt = () => state()?.runtimes.find((r) => r.goalID === goal().id)
              return (
                <box flexDirection="column" border={true} borderColor={borderColorForStatus(goal().status, theme())} padding={1} flexShrink={0} maxHeight={10}>
                  <text>
                    <span style={{ fg: statusColor(goal().status, theme()), bold: true }}>{statusIcon(goal().status)} {goal().name}</span>
                    <span style={{ fg: statusColor(goal().status, theme()) }}> {goal().status.toUpperCase()}</span>
                    {rt() && <><span style={{ fg: theme().textMuted }}> │ </span><span style={{ fg: phaseColor(rt()!.phase, theme()), bold: true }}>{phaseIcon(rt()!.phase)} {rt()!.phase}</span><span style={{ fg: theme().textMuted }}> turn {rt()!.turnCount}</span></>}
                    {"\n"}
                    <span style={{ fg: theme().text }}>{goal().objective.slice(0, 160)}</span>
                    {goal().lastProgress && <><span style={{ fg: theme().success }}>{"\n"}✔ </span><span style={{ fg: theme().text }}>{goal().lastProgress!.summary.slice(0, 100)}</span><span style={{ fg: theme().textMuted }}> → {goal().lastProgress!.next?.slice(0, 60) || ""}</span></>}
                    {goal().blocker && <><span style={{ fg: theme().error, bold: true }}>{"\n"}✖ blocked: </span><span style={{ fg: theme().error }}>{goal().blocker!.reason.slice(0, 140)}</span><span style={{ fg: theme().textMuted }}> — {goal().blocker!.needed.slice(0, 60)}</span></>}
                    {goal().config.artifactDir && <><span style={{ fg: theme().accent }}>{"\n"}📁 </span><span style={{ fg: theme().textMuted }}>{String(goal().config.artifactDir).replace(String(props.directory), ".")}</span></>}
                    {rt()?.lastError && <><span style={{ fg: theme().error }}>{"\n"}⚠ </span><span style={{ fg: theme().error }}>{rt()!.lastError!.slice(0, 120)}</span></>}
                  </text>
                </box>
              )
            }}
          </Show>

          {/* Logs — bounded, clipped, per-event coloring */}
          <Show when={showLogs() && events().length > 0}>
            <box flexDirection="column" border={true} borderColor={theme().border} padding={1} maxHeight={7} flexShrink={0} overflow="hidden">
              <text><span style={{ fg: theme().accent, bold: true }}>◈ Recent Events</span><span style={{ fg: theme().textMuted }}> — :logs to hide</span></text>
              <For each={events().slice(-10)}>{(ev) => (
                <text>
                  <span style={{ fg: eventColor(String((ev as any).type), theme()), bold: true }}>{String((ev as any).type)}</span>
                  <span style={{ fg: theme().textMuted }}> {(ev as any).goalID?.slice(0, 8)}</span>
                  {(ev as any).summary && <span style={{ fg: theme().text }}> — {String((ev as any).summary).slice(0, 60)}</span>}
                </text>
              )}</For>
            </box>
          </Show>
        </box>

        {/* Input — always visible at bottom, vivid mode badge */}
        <box flexDirection="row" border={true} borderColor={mode() === "insert" ? theme().warning : theme().border} paddingLeft={1} paddingRight={1} flexShrink={0} height={3} gap={1}>
          <text>
            <span style={{ fg: mode() === "insert" ? theme().warning : theme().success, bold: true, bg: mode() === "insert" ? (theme().backgroundElement as unknown as string) : undefined }}>{mode() === "insert" ? " INSERT " : " NORMAL "}</span>
          </text>
          <input
            ref={(el: InputRenderable) => { inputEl = el; focusInput() }}
            flexGrow={1}
            placeholder={mode() === "insert" ? ":send hello  or  :force done --evidence proof  or  :open  (Ctrl+N: normal)" : statusText() || "Press : to send/command  ·  ? help  ·  o open child  ·  q close"}
            placeholderColor={theme().textMuted}
            cursorColor={theme().primary}
            focusedTextColor={theme().text}
            focusedBackgroundColor={theme().background}
            onInput={(v: string) => {
              debugLog("onInput", JSON.stringify(v), "mode", mode())
              if (mode() === "insert") setCommandInput(v)
              else if (inputEl?.value) inputEl.value = ""
            }}
            onKeyDown={(evt: ParsedKey) => {
              const name = evt.name || ""
              const seq = (evt as unknown as { sequence?: string }).sequence || ""
              debugLog("input onKeyDown", `name=${name} seq=${JSON.stringify(seq)} mode=${mode()} value=${JSON.stringify(commandInput())}`)
              if (mode() !== "insert") { if ((evt.name||"").length===1) prevent(evt); return }
              if (name === "return" || name === "enter") { prevent(evt); debugLog("input enter -> execute"); void executeCommand(commandInput()); return }
              if (evt.ctrl && name.toLowerCase() === "n") { prevent(evt); debugLog("input ctrl+n -> normal"); returnToNormalMode(); return }
            }}
          />
        </box>
      </box>
    </box>
  )
}
