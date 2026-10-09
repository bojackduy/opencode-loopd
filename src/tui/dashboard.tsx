// ─── TUI: Dashboard Component ────────────────────────────────────────────────
// Modal dashboard — single always-focused input traps keys, no leak to chat.
// Scrollable sections with input always visible at bottom.

/** @jsxImportSource @opentui/solid */
import { batch, createSignal, For, Show, onCleanup, onMount, createEffect, type JSX } from "solid-js"
import { useKeyboard } from "@opentui/solid"
import type { TuiPluginApi, TuiThemeCurrent } from "@opencode-ai/plugin/tui"
import type { InputRenderable, ParsedKey, ScrollBoxRenderable, TextRenderable } from "@opentui/core"
import { readEvents } from "../infrastructure/state-repository"
import { createControlClient } from "../infrastructure/control-client"
import type { StoreState } from "../infrastructure/state-repository"
import type { Goal, GoalStatus } from "../domain/goal"
import type { GoalRuntimeState, RuntimePhase } from "../domain/runtime"
import { parseCommand, commandHelp, commandTabHelp } from "./command-parser"
import { parseNewCommand } from "./command-controller"
import { goalStatusLabel, phaseLabel, describeGoalState } from "../domain/status-labels"
import { bugReportUrl, openBrowserUrl } from "../browser"
import {
  initialDashboardSelection,
  moveDashboardSelection,
  resolveDashboardOpen,
  toggleDashboardView,
  dashboardViewForKey,
  visibleOwnerCommands,
  type DashboardSelection,
  type DashboardView,
} from "./dashboard-view"
import { TERMINAL_ROUTE_NAME, currentRouteSessionID, terminalRoutePayload } from "./terminal-route"
import type { CommandSession } from "../domain/command-session"
import { randomUUID } from "crypto"
import { createDashboardRefresh } from "./dashboard-refresh"

function prevent(evt: ParsedKey) {
  const e = evt as ParsedKey & { preventDefault?: () => void; stopPropagation?: () => void }
  e.preventDefault?.()
  e.stopPropagation?.()
}

/** Key names arriving from different terminals/protocols for the same physical key. */
function keyName(evt: ParsedKey): string {
  return ((evt as unknown as { name?: string }).name || "").toLowerCase()
}
function keySeq(evt: ParsedKey): string {
  const e = evt as unknown as { sequence?: string; raw?: string }
  return e.sequence || e.raw || ""
}

export function isEnterKey(evt: ParsedKey): boolean {
  const name = keyName(evt)
  if (name === "return" || name === "enter" || name === "kp_enter") return true
  const seq = keySeq(evt)
  return seq === "\r" || seq === "\n"
}

export function isEscapeKey(evt: ParsedKey): boolean {
  if (keyName(evt) === "escape" || keyName(evt) === "esc") return true
  return keySeq(evt) === "\x1b"
}

export function isCtrlN(evt: ParsedKey): boolean {
  return Boolean(evt.ctrl) && keyName(evt) === "n"
}

type Mode = "normal" | "insert"

interface Props {
  api: TuiPluginApi
  directory: string
  /** Which tab opens focused (`/loop` → goals, `/commands` → commands). */
  initialView?: DashboardView
  /** Owner scope for the Commands view. Defaults to the current session. */
  ownerSessionID?: string
  /** Fullscreen open for commands. Default: route-navigate + close popup. */
  onOpenCommand?: (payload: { commandID: string; ownerSessionID: string; returnSessionID: string }) => void
  /** Keyboard-active gate. Default: the popup dialog is open. */
  isActive?: () => boolean
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

function commandStatusColor(status: CommandSession["status"], theme: TuiThemeCurrent) {
  switch (status) {
    case "running": return theme.success
    case "exited": return theme.info
    case "terminated": return theme.warning
    case "missing": return theme.error
    default: return theme.text
  }
}
function commandStatusIcon(status: CommandSession["status"]): string {
  switch (status) {
    case "running": return "▶"
    case "exited": return "✓"
    case "terminated": return "■"
    case "missing": return "?"
    default: return "○"
  }
}
function commandStatusLabel(status: CommandSession["status"]): { short: string; hint: string } {
  switch (status) {
    case "running": return { short: "RUNNING", hint: "process is executing" }
    case "exited": return { short: "EXITED", hint: "process ended on its own" }
    case "terminated": return { short: "TERMINATED", hint: "stopped via interrupt/terminate" }
    case "missing": return { short: "MISSING", hint: "no live execution found — reconcile" }
    default: return { short: String(status).toUpperCase(), hint: "" }
  }
}
function commandBorderColor(status: CommandSession["status"], theme: TuiThemeCurrent): string {
  return commandStatusColor(status, theme) as unknown as string
}

function ageLabel(timestamp: string | undefined, now: number): string {
  if (!timestamp) return "never"
  const seconds = Math.max(0, Math.floor((now - Date.parse(timestamp)) / 1000))
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  return `${Math.floor(minutes / 60)}h ago`
}

function countdownLabel(targetIso: string | undefined, now: number): string | undefined {
  if (!targetIso) return undefined
  const diff = Math.max(0, Math.floor((Date.parse(targetIso) - now) / 1000))
  if (diff < 60) return `${diff}s`
  const minutes = Math.floor(diff / 60)
  if (minutes < 60) return `${minutes}m ${diff % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

export function formatTokens(n: number | undefined): string {
  if (!n) return "0"
  if (n < 1000) return String(Math.round(n))
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`
  return `${(n / 1_000_000).toFixed(2)}M`
}

export function formatCost(c: number | undefined): string {
  if (!c) return "$0.00"
  if (c < 0.01) return `$${c.toFixed(4)}`
  return `$${c.toFixed(2)}`
}

export function formatDuration(seconds: number | undefined): string {
  if (!seconds || seconds <= 0) return "0s"
  if (seconds < 60) return `${Math.round(seconds)}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  return `${(seconds / 3600).toFixed(1)}h`
}

/** Agent color from OpenCode metadata: theme name → theme value, hex → as-is. */
export function agentColor(color: string | undefined, theme: TuiThemeCurrent): string {
  if (!color) return theme.text as unknown as string
  const named: Record<string, unknown> = {
    primary: theme.primary,
    secondary: (theme as any).secondary,
    accent: theme.accent,
    success: theme.success,
    warning: theme.warning,
    error: theme.error,
    info: theme.info,
  }
  if (named[color]) return named[color] as string
  if (/^#[0-9a-fA-F]{3,8}$/.test(color)) return color
  return theme.text as unknown as string
}

export interface AgentMeta {
  color?: string
  mode?: string
}

export function indexAgents(list: Array<{ name: string; color?: string; mode?: string }>): Record<string, AgentMeta> {
  const map: Record<string, AgentMeta> = {}
  for (const a of list) {
    if (!a?.name) continue
    map[a.name] = { color: a.color, mode: a.mode }
    map[a.name.toLowerCase()] = { color: a.color, mode: a.mode }
  }
  return map
}

/** Both tabs follow selection only after layout (including a tab remount).
 * Wheel scrolling alone must not pull the viewport back to the selection. */
function DashboardList(props: { count: number; selectedID?: string; children: JSX.Element }) {
  let scroll: ScrollBoxRenderable | undefined
  let followPending = true
  createEffect(() => {
    props.count
    props.selectedID
    followPending = true
    scroll?.requestRender()
  })
  return (
    <scrollbox ref={(el) => { scroll = el }} height={Math.min(props.count, 10)}
      scrollX={false} scrollY={true} stickyScroll={false}
      renderAfter={() => {
        if (!followPending || !scroll) return
        followPending = false
        if (props.selectedID) scroll.scrollChildIntoView(props.selectedID)
      }}>
      {props.children}
    </scrollbox>
  )
}

/** TextRenderable scrolls unwrapped text independently, even with truncate.
 * Reset that local offset as the wheel bubbles up to the vertical list. */
function DashboardRow(props: { id: string; backgroundColor?: TuiThemeCurrent["backgroundElement"]; children: JSX.Element }) {
  let text: TextRenderable | undefined
  return (
    <box id={props.id} flexDirection="row" paddingLeft={1} paddingRight={1}
      height={1} flexShrink={0} overflow="hidden" backgroundColor={props.backgroundColor}
      onMouseScroll={() => { if (text) { text.scrollX = 0; text.scrollY = 0 } }}>
      <text ref={(el) => { text = el }} wrapMode="none" truncate={true} minWidth={0} flexShrink={1}>
        {props.children}
      </text>
    </box>
  )
}

export function LoopDashboard(props: Props) {
  const theme = () => props.api.theme.current
  const [mode, setMode] = createSignal<Mode>("normal")
  const [selected, setSelected] = createSignal(0)
  const [commandInput, setCommandInput] = createSignal("")
  const [statusText, setStatusText] = createSignal("Tab goals/commands · : send/command · ? help · c toggle done · o open · q close")
  // Shared Goals/Commands tabs (`/loop` opens goals, `/commands` opens
  // commands). Goal indexes stay on the legacy `selected` signal; command
  // selection lives on `cmdSelected` so the two never cross-apply.
  const [tab, setTab] = createSignal<DashboardView>(props.initialView ?? "goals")
  const [cmdSelected, setCmdSelected] = createSignal(0)
  const ownerSessionID = () => props.ownerSessionID ?? currentRouteSessionID(props.api)
  const ownerCommands = () => visibleOwnerCommands(state()?.commands, ownerSessionID(), showCompleted())
  /** Owned-but-finished commands hidden by the `c` toggle — surfaced in the empty state. */
  const hiddenFinishedCommands = () => {
    if (showCompleted()) return 0
    const terminal = ["exited", "terminated", "missing"]
    return (state()?.commands ?? []).filter(
      (c) => c.ownerSessionID === ownerSessionID() && terminal.includes(c.status),
    ).length
  }
  const [state, setState] = createSignal<StoreState | null>(null)
  const [events, setEvents] = createSignal<Record<string, unknown>[]>([])
  const [selectedGoal, setSelectedGoal] = createSignal<Goal | null>(null)
  const [showLogs, setShowLogs] = createSignal(false)
  const [showHelp, setShowHelp] = createSignal(false)
  const [showCompleted, setShowCompleted] = createSignal(false)
  const [clock, setClock] = createSignal(Date.now())
  const [agentIndex, setAgentIndex] = createSignal<Record<string, AgentMeta>>({})
  let inputEl: InputRenderable | undefined
  let focusTimer: ReturnType<typeof setTimeout> | undefined
  let disposed = false
  const client = createControlClient(props.directory)
  const popMode = props.api.mode.push("loopd.dashboard")

  function focusInput() {
    if (disposed) return
    if (focusTimer) clearTimeout(focusTimer)
    focusTimer = setTimeout(() => {
      if (disposed) return
      const current = props.api.renderer.currentFocusedRenderable
      if (current && current !== inputEl) current.blur()
      inputEl?.focus()
    }, 10)
  }

  const refreshQueue = createDashboardRefresh(client, (s, logs) => {
    batch(() => { setState(s); setEvents(logs) })
  }, (e) => {
    setStatusText(`Error: ${e instanceof Error ? e.message : String(e)}`)
  })
  const refresh = refreshQueue.refresh
  refresh()
  async function refreshAgents() {
    try {
      const res = await (props.api.client as any)?.app?.agents?.()
      const list = (res as any)?.data ?? res ?? []
      if (!disposed && Array.isArray(list)) setAgentIndex(indexAgents(list))
    } catch { /* agent colors are decorative — dashboard works without them */ }
  }
  refreshAgents()
  const unsubs = [
    props.api.event.on("session.idle", () => refresh()),
    props.api.event.on("session.status", () => refresh()),
    props.api.event.on("session.error", () => refresh()),
    props.api.event.on("session.compacted", () => refresh()),
    setInterval(refresh, 10000),
    setInterval(() => setClock(Date.now()), 500),
  ]
  onCleanup(() => {
    disposed = true
    refreshQueue.dispose()
    popMode()
    if (focusTimer) clearTimeout(focusTimer)
    for (const u of unsubs) typeof u === "function" ? u() : clearInterval(u as unknown as number)
  })

  onMount(() => {
    focusInput()
  })
  createEffect(() => { mode(); focusInput() })

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
    if (!props.api.ui.dialog.open) return
    const active = (() => {
      try {
        return props.isActive?.() ?? props.api.ui.dialog.open
      } catch {
        return props.api.ui.dialog.open
      }
    })()
    if (!active) return
    const isColon = name === ":" || seq === ":" || raw === ":" || seq.includes(":") || raw.includes(":") || name === ";" || name === "colon"
    const isQuestion = name === "?" || seq === "?" || raw === "?" || seq.includes("?") || raw.includes("?")
    // Insert mode: the ONLY keys that act here are Enter (send), Escape and
    // Ctrl+N (back to normal). Everything else must reach the input as text.
    // Enter is handled here — not in the input's onKeyDown — because the
    // focused InputRenderable consumes Enter internally and our prop handler
    // never reliably fires for it (typing worked, sending never did).
    if (mode() === "insert") {
      if (isEnterKey(evt)) { prevent(evt); void executeCommand(commandInput()); return }
      if (isEscapeKey(evt) || isCtrlN(evt)) {
        prevent(evt)
        returnToNormalMode()
        return
      }
      return
    }
    if (isColon) { prevent(evt); enterInsertMode(); return }
    if (isQuestion) { prevent(evt); setShowHelp((value) => !value); return }
    const key = raw || seq || name
    // Ctrl-C on the Commands tab interrupts the selected command (SIGINT
    // delivery, never a kill) — mirrors the fallback panel. Plain `c`
    // (below) still toggles completed goals.
    if (tab() === "commands" && Boolean(evt.ctrl) && name === "c") {
      prevent(evt)
      const sel = selectedCommand()
      if (!sel) { setStatusText("No command selected."); return }
      void executeCommandRaw("cmd_interrupt", { commandID: sel.id }, sel.id)
      return
    }
    if (key === "c") {
      prevent(evt)
      setShowCompleted((v) => {
        const next = !v
        // Same toggle on both tabs: goals hide `complete`, commands hide
        // exited/terminated/missing.
        setStatusText(next
          ? `Showing finished ${tab() === "commands" ? "commands" : "goals"}.`
          : `Hiding finished ${tab() === "commands" ? "commands" : "goals"}.`)
        return next
      })
      return
    }
    const currentGoals = state()?.goals.filter((goal) => showCompleted() || goal.status !== "complete") || []
    const currentCommands = ownerCommands()
    // Tab toggles the Goals/Commands tabs; h selects Goals and l selects
    // Commands directionally. j/k/g/G select within the active tab only
    // (headless logic in dashboard-view.ts).
    if (name === "tab") {
      prevent(evt)
      setTab((v) => toggleDashboardView(v))
      return
    }
    const directionalView = dashboardViewForKey(key)
    if (directionalView !== undefined) {
      prevent(evt)
      setTab(directionalView)
      return
    }
    function dashboardSelection(): DashboardSelection {
      return { view: tab(), goalIndex: selected(), commandIndex: cmdSelected() }
    }
    function applyMove(move: "down" | "up" | "first" | "last") {
      const next = moveDashboardSelection(dashboardSelection(), move, currentGoals.length, currentCommands.length)
      setSelected(next.goalIndex)
      setCmdSelected(next.commandIndex)
    }
    if (name === "down" || key === "j") { prevent(evt); applyMove("down"); return }
    if (name === "up" || key === "k") { prevent(evt); applyMove("up"); return }
    if (key === "g") { prevent(evt); applyMove("first"); return }
    if (key === "G") { prevent(evt); applyMove("last"); return }
    // Commands-tab helpers are tab-scoped: X force-kills (SIGKILL now),
    // R restarts with the same spec, x removes finished commands (running
    // ones get a hint, never a kill). Goal keys R/x keep their Goals-tab
    // meaning; only p/r/A/N are refused here.
    if (tab() === "commands" && key === "X") {
      prevent(evt)
      void killSelectedCommand()
      return
    }
    if (tab() === "commands" && key === "R") {
      prevent(evt)
      void restartSelectedCommand()
      return
    }
    if (tab() === "commands" && key === "x") {
      prevent(evt)
      removeFinishedSelected()
      return
    }
    // Goal controls apply to goals only — never to a command selection.
    // Model controls (model/models) are goal verbs too: on the Commands tab
    // they would otherwise be written into a command's stdin.
    const needsGoalsTab = ["p", "r", "A", "N", "model", "models", "agent", "agents"].includes(key)
    if (needsGoalsTab && tab() !== "goals") {
      prevent(evt)
      setStatusText("Goal controls need the Goals tab (Tab to switch).")
      return
    }
    if (key === "p") { prevent(evt); void executeCommand("pause"); return }
    if (key === "r") { prevent(evt); void executeCommand("resume"); return }
    if (key === "R") { prevent(evt); void executeCommand("retry"); return }
    if (key === "x") { prevent(evt); void executeCommand("clear"); return }
    if (key === "A") { prevent(evt); void executeCommand("abort"); return }
    if (key === "N") { prevent(evt); void executeCommand("nudge"); return }
    if (key === "L") { prevent(evt); setShowLogs((value) => !value); return }
    if (key === "o") {
      prevent(evt)
      // `o` dispatches by active selection type: goals open their native
      // worker session; commands close the popup and open the fullscreen
      // terminal route. Never cross-applies.
      const target = resolveDashboardOpen(
        { goals: currentGoals, commands: state()?.commands ?? [] },
        dashboardSelection(),
        ownerSessionID(),
        currentRouteSessionID(props.api),
        showCompleted(),
      )
      if (target.kind === "goal") {
        props.api.route.navigate("session", { sessionID: target.workerSessionID })
        props.api.ui.dialog.clear()
      } else if (target.kind === "command") {
        if (props.onOpenCommand) {
          props.onOpenCommand(target.data)
        } else {
          try {
            props.api.route.navigate(
              TERMINAL_ROUTE_NAME,
              terminalRoutePayload(target.data.commandID, target.data.ownerSessionID, target.data.returnSessionID),
            )
            props.api.ui.dialog.clear()
          } catch {
            setStatusText("Fullscreen route unavailable on this host.")
          }
        }
      } else {
        setStatusText(
          target.reason === "no-worker-session"
            ? "No worker session"
            : target.reason === "no-command"
              ? "No command selected."
              : target.reason === "owner-required"
                ? "No owning session — open disabled."
                : target.reason === "return-required"
                  ? "No return session — open disabled."
                  : "Nothing to open.",
        )
      }
      return
    }
    if (key === "B") {
      prevent(evt)
      handleBugReport()
      return
    }
    if (key === "q") { prevent(evt); props.api.ui.dialog.clear(); return }
  })

  const goals = () => state()?.goals.filter((g) => showCompleted() || g.status !== "complete") || []

  /** Raw control-bus send for the Commands tab (owner-scoped, fail closed). */
  async function executeCommandRaw(command: string, args: Record<string, unknown>, commandID?: string) {
    const owner = ownerSessionID()
    if (!owner) {
      setStatusText("No owning session (open from a session view) — mutations disabled.")
      return
    }
    setStatusText(`sending ${command}…`)
    try {
      const r = await client.executeRaw({ command, goalID: commandID, args: { ...args, ownerSessionID: owner } })
      setStatusText(r.ok ? r.message : `Error: ${r.message}`)
      if (r.ok) await refresh()
    } catch (e) {
      setStatusText(`Error: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  function selectedCommand(): CommandSession | null {
    return ownerCommands()[cmdSelected()] ?? null
  }

  /** Commands-tab process helpers (X/R keys + colon). */
  async function killSelectedCommand() {
    const sel = selectedCommand()
    if (!sel) { setStatusText("No command selected."); return }
    await executeCommandRaw("cmd_kill", { commandID: sel.id }, sel.id)
  }

  async function restartSelectedCommand() {
    const sel = selectedCommand()
    if (!sel) { setStatusText("No command selected."); return }
    await executeCommandRaw("cmd_restart", { commandID: sel.id }, sel.id)
  }

  function removeFinishedSelected() {
    const sel = selectedCommand()
    if (!sel) { setStatusText("No command selected."); return }
    if (sel.status === "running") {
      setStatusText(`"${sel.title}" is still running — X force kill · :terminate graceful · q detach (keeps running).`)
      return
    }
    void executeCommandRaw("cmd_remove", { commandID: sel.id }, sel.id)
  }

  /** Commands-tab colon commands: launch/open/interrupt/terminate/kill/restart/remove/write. */
  async function executeCommandTabCommand(verb: string, positional: string[], raw: string) {
    switch (verb) {
      case "model": case "models": case "agent": case "agents":
        setStatusText(`:${verb} is only available on the Goals tab.`)
        return
      case "new": {
        // Parse the raw tail after `new` (not the re-joined positionals) so
        // quoted/escaped boundaries survive: :new bash -c "echo hi" spawns
        // bash with argv ["-c", "echo hi"].
        const argv = parseNewCommand(raw)
        if (!argv) {
          setStatusText("Usage: :new <command> [args...]")
          return
        }
        const { command, cmdArgs } = argv
        await executeCommandRaw("cmd_start", { title: command, command, cmdArgs })
        return
      }
      case "interrupt":
        if (!selectedCommand()) { setStatusText("No command selected."); return }
        await executeCommandRaw("cmd_interrupt", { commandID: selectedCommand()!.id }, selectedCommand()!.id)
        return
      case "terminate":
        if (!selectedCommand()) { setStatusText("No command selected."); return }
        await executeCommandRaw("cmd_terminate", { commandID: selectedCommand()!.id }, selectedCommand()!.id)
        return
      case "kill":
        await killSelectedCommand()
        return
      case "restart":
        await restartSelectedCommand()
        return
      case "remove":
        if (!selectedCommand()) { setStatusText("No command selected."); return }
        await executeCommandRaw("cmd_remove", { commandID: selectedCommand()!.id }, selectedCommand()!.id)
        return
      case "logs":
        setShowLogs(!showLogs())
        return
      case "help":
        setShowHelp(true)
        return
      default: {
        // Bare text → stdin of the selected command (newline-terminated).
        if (selectedCommand()) {
          const payload = raw.endsWith("\n") ? raw : `${raw}\n`
          await executeCommandRaw("cmd_write", { commandID: selectedCommand()!.id, input: payload }, selectedCommand()!.id)
        } else setStatusText(`Unknown: ${verb}. ? for help`)
      }
    }
  }

  async function executeCommand(cmd: string) {
    const parsed = parseCommand(cmd)
    if (!parsed) { setStatusText("Empty command"); return }
    // Commands tab: launch/open/interrupt/remove/write on the selected
    // command — goal actions never run here.
    if (tab() === "commands" && !["q", "close"].includes(parsed.command)) {
      await executeCommandTabCommand(parsed.command, parsed.positional, parsed.raw)
      returnToNormalMode()
      return
    }
    // Immediate feedback: the control round-trip can take seconds (or time
    // out at 30s), and silence until then reads as "keys do nothing".
    if (!["help", "logs", "q", "close"].includes(parsed.command)) {
      setStatusText(`sending ${parsed.command}…`)
    }
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
        case "abort": { if (!selectedGoal()) { setStatusText("No goal"); break } const r = await client.execute({ version: 1, requestID: randomUUID(), requestedAt: new Date().toISOString(), command: "abort_worker", goalID: selectedGoal()!.id }); setStatusText(r.ok ? r.message : `Error: ${r.message}`); if (r.ok) await refresh(); break }
        case "nudge": { if (!selectedGoal()) { setStatusText("No goal"); break } const r = await client.execute({ version: 1, requestID: randomUUID(), requestedAt: new Date().toISOString(), command: "nudge", goalID: selectedGoal()!.id }); setStatusText(r.ok ? r.message : `Error: ${r.message}`); if (r.ok) await refresh(); break }
        case "interactive": {
          if (!selectedGoal()) { setStatusText("No goal"); break }
          const next = !(selectedGoal()!.interactive === true)
          const r = await client.execute({ version: 1, requestID: randomUUID(), requestedAt: new Date().toISOString(), command: "set_interactive", goalID: selectedGoal()!.id, args: { interactive: next } })
          setStatusText(r.ok ? r.message : `Error: ${r.message}`); if (r.ok) await refresh()
          break
        }
        case "agent": {
          if (!selectedGoal()) { setStatusText("No goal selected"); break }
          const agent = parsed.positional.join(" ").trim()
          if (!agent) { setStatusText("Usage: :agent <name> — :agents lists available agents."); break }
          const r = await client.execute({ version: 1, requestID: randomUUID(), requestedAt: new Date().toISOString(), command: "switch_goal_identity", goalID: selectedGoal()!.id, args: { agent } })
          setStatusText(r.ok ? r.message : `Error: ${r.message}`); if (r.ok) await refresh()
          break
        }
        case "agents": {
          const r = await client.execute({ version: 1, requestID: randomUUID(), requestedAt: new Date().toISOString(), command: "list_agents" })
          setStatusText(r.ok ? r.message : `Error: ${r.message}`)
          break
        }
        case "model": {
          if (!selectedGoal()) { setStatusText("No goal selected"); break }
          const target = parsed.positional.join(" ").trim()
          if (!target) { setStatusText("Usage: :model <provider/model> — e.g. :model openai/gpt-5.6-sol. :models lists what's available."); break }
          const r = await client.execute({ version: 1, requestID: randomUUID(), requestedAt: new Date().toISOString(), command: "switch_goal_identity", goalID: selectedGoal()!.id, args: { model: target } })
          setStatusText(r.ok ? r.message : `Error: ${r.message}`); if (r.ok) await refresh()
          break
        }
        case "models": {
          const r = await client.execute({ version: 1, requestID: randomUUID(), requestedAt: new Date().toISOString(), command: "list_models" })
          setStatusText(r.ok ? r.message : `Error: ${r.message}`)
          break
        }
        // Legacy: keep :goal start but redirect — creation belongs in parent chat
        case "goal": { setStatusText("Create goals via /goal in the parent chat (agent clarifies first). Dashboard: :send to steer the worker."); break }
        case "bug":
        case "report": {
          handleBugReport()
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

  const activeGoals = () => state()?.goals.filter((g) => showCompleted() || g.status !== "complete") || []
  const runningCount = () => state()?.runtimes.filter((runtime) => runtime.phase === "running").length || 0
  const runningFrame = () => ["|", "/", "-", "\\"][Math.floor(clock() / 500) % 4]

  function handleBugReport() {
    const goal = selectedGoal()
    const extra = goal ? `Goal: ${goal.name} (${goal.id.slice(0, 8)}) status=${goal.status} objective=${goal.objective.slice(0, 120)}` : "No goal selected"
    const url = bugReportUrl({ runtimeLabel: `opencode-loopd dashboard`, extra })
    const res = openBrowserUrl(url)
    setStatusText(res.status === "opened" ? "Opening bug report in browser…" : `Could not open browser: ${res.reason} — ${url}`)
  }

  createEffect(() => {
    setSelected(Math.max(0, Math.min(selected(), activeGoals().length - 1)))
    setCmdSelected(Math.max(0, Math.min(cmdSelected(), ownerCommands().length - 1)))
    setSelectedGoal(activeGoals()[selected()] || null)
  })

  function rowIdFor(goalID: string): string {
    return `loopd-goal-${goalID}`
  }

  return (
    <box flexDirection="column" width="100%" alignItems="center" padding={1}>
      <box flexDirection="column" width="90%" border={true} borderColor={theme().border} padding={1}>
        {/* Header — always visible, vivid */}
        <box flexDirection="row" justifyContent="space-between" alignItems="center" padding={0} flexShrink={0} gap={1}>
          <text>
            <span style={{ fg: theme().primary, bold: true }}>⬢ Loop Dashboard</span>
            <span style={{ fg: theme().textMuted }}> │ </span>
            <span style={{ fg: mode() === "normal" ? theme().success : theme().warning, bold: true, bg: mode() === "insert" ? (theme().backgroundElement as unknown as string) : undefined }}> {mode().toUpperCase()} </span>
            <span style={{ fg: theme().textMuted }}> │ </span>
            <span style={{ fg: theme().accent, bold: true }}>{activeGoals().length}</span>
            <span style={{ fg: theme().textMuted }}> open</span>
            <span style={{ fg: theme().textMuted }}> │ </span>
            <span style={{ fg: runningCount() > 0 ? theme().success : theme().textMuted, bold: runningCount() > 0 }}>{runningCount() > 0 ? runningFrame() : "○"} {runningCount()} acting now</span>
            <span style={{ fg: theme().textMuted }}> │ </span>
            <span style={{ fg: theme().info, bold: true }}>{state()?.goals.filter((g) => g.status === "complete").length || 0}</span>
            <span style={{ fg: theme().textMuted }}> done</span>
            <span style={{ fg: theme().textMuted }}> │ </span>
            <span style={{ fg: tab() === "goals" ? theme().primary : theme().textMuted, bold: tab() === "goals" }}>[Goals]</span>
            <span style={{ fg: theme().textMuted }}> </span>
            <span style={{ fg: tab() === "commands" ? theme().primary : theme().textMuted, bold: tab() === "commands" }}>[Commands]</span>
            <span style={{ fg: theme().textMuted }}> (Tab)</span>
          </text>
          <box
            flexDirection="row"
            alignItems="center"
            backgroundColor={theme().error as unknown as string}
            paddingLeft={1}
            paddingRight={1}
            flexShrink={0}
            {...({ onMouseDown: handleBugReport } as any)}
          >
            <text><span style={{ fg: "white", bold: true }}>Bug Report</span></text>
          </box>
        </box>

        {/* Scrollable body — sizes to content; the list caps itself so detail + input stay visible */}
        <box flexDirection="column" flexShrink={1} minHeight={0} overflow="hidden">
          {/* Help panel — single text to avoid flex overlap */}
<Show when={showHelp()}>
              <box flexDirection="column" padding={1} border={true} borderColor="yellow" backgroundColor={theme().background} flexShrink={0} maxHeight={22}>
                <box flexDirection="column" padding={1} backgroundColor={theme().background} flexShrink={1} minHeight={0} overflow="scroll">
                  <text>
                <span style={{ fg: "yellow", bold: true }}>{tab() === "commands" ? "━━━ Commands: ? help  : insert  c toggle done  X kill  R restart  x remove-done  o fullscreen  q close ━━━" : "━━━ Keys: ? toggle help  c toggle done  : insert  Ctrl+N normal  o open  A abort worker  N nudge  q close ━━━"}</span>
                <For each={(tab() === "commands" ? commandTabHelp() : commandHelp()).split("\n")}>{(line) => {
                  // Modes / Nav — split into label + segments, color keys vs descs
                  if (line.startsWith("Modes:") || line.startsWith("Nav:")) {
                    const label = line.startsWith("Modes:") ? "Modes:" : "Nav:"
                    const rest = line.slice(label.length).trim()
                    const segments = rest.split(" | ")
                    return (
                      <>
                        {"\n"}
                        <span style={{ fg: theme().primary, bold: true }}>{label}</span>
                        <span style={{ fg: theme().textMuted }}> </span>
                        <For each={segments}>{(seg, idx) => {
                          const hasArrow = seg.includes("→")
                          if (hasArrow) {
                            const [k, d] = seg.split("→").map((s) => s.trim())
                            return (
                              <>
                                {idx() > 0 && <span style={{ fg: theme().textMuted }}> | </span>}
                                <span style={{ fg: theme().warning, bold: true }}>{k}</span>
                                <span style={{ fg: theme().textMuted }}> → </span>
                                <span style={{ fg: theme().text }}>{d}</span>
                              </>
                            )
                          }
                          const sp = seg.indexOf(" ")
                          const k = sp > 0 ? seg.slice(0, sp) : seg
                          const d = sp > 0 ? seg.slice(sp + 1) : ""
                          return (
                            <>
                              {idx() > 0 && <span style={{ fg: theme().textMuted }}> | </span>}
                              <span style={{ fg: theme().warning, bold: true }}>{k}</span>
                              {d && <span style={{ fg: theme().text }}> {d}</span>}
                            </>
                          )
                        }}</For>
                      </>
                    )
                  }
                  // Commands like ":send <message>                           Send instruction..."
                  if (line.trim().startsWith(":")) {
                    const m = line.match(/^(\s*)(:\S+(?:\s+\S+)*?)\s{2,}(.*)$/)
                    const indent = m?.[1] ?? line.match(/^\s*/)?.[0] ?? ""
                    const key = m?.[2] ?? line.trim().split(/\s{2,}/)[0] ?? line.trim()
                    const desc = m?.[3] ?? line.split(/\s{2,}/)[1] ?? ""
                    return (
                      <>
                        {"\n"}
                        <span style={{ fg: theme().textMuted }}>{indent}</span>
                        <span style={{ fg: theme().warning, bold: true }}>{key}</span>
                        {desc && <><span style={{ fg: theme().textMuted }}>  </span><span style={{ fg: theme().textMuted }}>{desc}</span></>}
                      </>
                    )
                  }
                  const isHeader = line.startsWith("Commands")
                  return (
                    <>
                      {"\n"}
                      <span style={{ fg: isHeader ? theme().primary : theme().textMuted, bold: isHeader }}>{line}</span>
                    </>
                  )
                }}</For>
                </text>
              </box>
              <text style={{ fg: theme().textMuted }}><span style={{ italic: true }}>▼ scroll for more</span></text>
            </box>
          </Show>

          {/* Goal list — goals tab only (commands tab renders below).
              Short lists sit compact with no void below; long lists cap out
              and scroll with selection following via scrollChildIntoView.
              Detail + input stay pinned below in both cases. */}
          <Show when={tab() === "goals"}>
          <Show when={activeGoals().length > 0} fallback={
            <box flexDirection="column" gap={1} padding={1}>
              <text><span style={{ fg: theme().textMuted }}>No active goals.</span><span style={{ fg: theme().accent }}> /goal</span><span style={{ fg: theme().textMuted }}> in parent chat to create one.</span></text>
              <text><span style={{ fg: theme().textMuted }}>Tip: </span><span style={{ fg: theme().warning }}>:send</span><span style={{ fg: theme().textMuted }}> to steer the worker · </span><span style={{ fg: theme().warning }}>o</span><span style={{ fg: theme().textMuted }}> to open child · </span><span style={{ fg: theme().warning }}>:force</span><span style={{ fg: theme().textMuted }}> to complete manually.</span></text>
            </box>
          }>
            <DashboardList count={activeGoals().length} selectedID={activeGoals()[selected()] ? rowIdFor(activeGoals()[selected()]!.id) : undefined}>
              <For each={activeGoals()}>
                {(goal, i) => {
                  const runtime = () => state()?.runtimes.find((r) => r.goalID === goal.id)
                  const isActive = () => i() === selected()
                  const maxTurns = (goal.config as any)?.maxTurns as number | undefined
                  const turnColor = () => {
                    if (!runtime() || !maxTurns) return phaseColor(runtime()?.phase || "idle", theme())
                    const ratio = runtime()!.budgetTurnCount / maxTurns
                    if (ratio >= 1) return theme().error
                    if (ratio >= 0.8) return theme().warning
                    return phaseColor(runtime()!.phase || "idle", theme())
                  }
                  return (
                    <DashboardRow id={rowIdFor(goal.id)} backgroundColor={isActive() ? theme().backgroundElement : undefined}>
                      {/* Single-line row: wrapMode+truncate pin the height so the
                          list viewport math (1 line per row) stays exact in any
                          dialog width. Full info lives in the detail panel. */}
                        <span style={{ fg: statusColor(goal.status, theme()), bold: isActive() }}>{isActive() ? `▶ ${statusIcon(goal.status)} ${goal.name}` : `  ${statusIcon(goal.status)} ${goal.name}`}</span>
                        <span style={{ fg: theme().textMuted }}> │ </span>
                        <span style={{ fg: theme().textMuted }}>Goal </span>
                        <span style={{ fg: statusColor(goal.status, theme()), bold: true }}>{goalStatusLabel(goal.status).short.toUpperCase()}</span>
                        {runtime() && <>
                          <span style={{ fg: theme().textMuted }}> │ Worker </span>
                          <span style={{ fg: turnColor(), bold: runtime()!.phase === "running" }}>{runtime()!.phase === "running" ? runningFrame() : phaseIcon(runtime()!.phase)} {phaseLabel(runtime()!.phase).short.toUpperCase()}</span>
                          <span style={{ fg: turnColor() }}> {runtime()!.budgetTurnCount}{maxTurns ? `/${maxTurns}` : ""}</span>
                          <span style={{ fg: theme().textMuted }}> {ageLabel(runtime()!.lastProgressAt || runtime()!.lastRunAt, clock())}</span>
                        </>}
                        {runtime() && runtime()!.consecutiveFailures > 0 && <span style={{ fg: theme().error, bold: true }}> │ ⚠ {runtime()!.consecutiveFailures} fail</span>}
                        {runtime() && (runtime()!.noProgressCount || 0) > 0 && <span style={{ fg: theme().warning }}> │ {runtime()!.noProgressCount} no-progress</span>}
                        {runtime() && (runtime() as any).evaluatorRejectionCount > 0 && <span style={{ fg: theme().warning, bold: true }}> │ ⚠ {String((runtime() as any).evaluatorRejectionCount)} rejected</span>}
                        {runtime() && (runtime() as any).unknownStatusCount >= 3 && <span style={{ fg: theme().error, bold: true }}> │ ⚠️ UNREACHABLE</span>}
                        {runtime() && runtime()!.phase === "idle" && (runtime() as any).activeRunID && <span style={{ fg: theme().error, bold: true }}> │ ⚠️ STALE LEASE</span>}
                        {goal.interactive === true && <span style={{ fg: theme().accent, bold: true }}> │ ✋ MANUAL</span>}
                        {goal.config.model && <span style={{ fg: theme().info }}> │ 🧠 {goal.config.model}</span>}
                        {goal.config.agent && <span style={{ fg: theme().info }}> │ 🤖 {goal.config.agent}</span>}
                        {runtime() && (runtime() as any).retryAfter && <span style={{ fg: theme().accent }}> │ ↻ {countdownLabel((runtime() as any).retryAfter, clock())}</span>}
                        {runtime() && (runtime() as any).nextRunAt && <span style={{ fg: theme().accent }}> │ ⏰ {countdownLabel((runtime() as any).nextRunAt, clock())}</span>}
                    </DashboardRow>
                  )
                }}
              </For>
            </DashboardList>
          </Show>

          {/* Goal detail — fixed, bounded, border matches status */}
          <Show when={selectedGoal()}>
            {(goal) => {
              const rt = () => state()?.runtimes.find((r) => r.goalID === goal().id)
              const lp = () => goal().lastProgress
              const blk = () => goal().blocker
              return (
                <box flexDirection="column" border={true} borderColor={borderColorForStatus(goal().status, theme())} padding={1} flexShrink={0} maxHeight={13}>
                  <box flexDirection="column" padding={1} backgroundColor={theme().background} flexShrink={1} minHeight={0} overflow="scroll">
                    <text>
                    <span style={{ fg: statusColor(goal().status, theme()), bold: true }}>{statusIcon(goal().status)} {goal().name}</span>
                    <span style={{ fg: theme().textMuted }}> Goal </span>
                    <span style={{ fg: statusColor(goal().status, theme()) }}>{goalStatusLabel(goal().status).short} — {goalStatusLabel(goal().status).hint}</span>
                    {rt() && <><span style={{ fg: theme().textMuted }}> │ Worker </span><span style={{ fg: phaseColor(rt()!.phase, theme()), bold: true }}>{phaseIcon(rt()!.phase)} {phaseLabel(rt()!.phase).short} — {phaseLabel(rt()!.phase).hint}</span><span style={{ fg: theme().textMuted }}> run {rt()!.runCount} (budget {rt()!.budgetTurnCount})</span></>}
                    {"\n"}
                    <span style={{ fg: theme().textMuted }}>{describeGoalState(goal().status, rt()?.phase)}</span>
                    {(rt() as any)?.workerAbortedAt && <><span style={{ fg: theme().warning, bold: true }}> │ ⚠ worker aborted </span><span style={{ fg: theme().textMuted }}>{ageLabel((rt() as any).workerAbortedAt, clock())} — session kept, next turn reuses it</span></>}
                    {(() => {
                      const agentName = goal().config.agent
                      const meta = agentName ? (agentIndex()[agentName] ?? agentIndex()[agentName.toLowerCase()]) : undefined
                      const model = goal().config.model
                      const slash = model?.indexOf("/") ?? -1
                      return (<>
                        {"\n"}
                        <span style={{ fg: theme().textMuted }}>🤖 </span>
                        <span style={{ fg: theme().primary, bold: true }}>Agent: </span>
                        {agentName
                          ? <><span style={{ fg: agentColor(meta?.color, theme()) as any, bold: true }}>{agentName}</span>{meta?.mode && <span style={{ fg: theme().textMuted }}> ({meta.mode})</span>}</>
                          : goal().parentAgent
                            ? <><span style={{ fg: theme().textMuted }}>↩ </span><span style={{ fg: theme().text, bold: true }}>{goal().parentAgent}</span><span style={{ fg: theme().textMuted }}> (parent)</span></>
                            : <span style={{ fg: theme().textMuted }}>parent</span>}
                        <span style={{ fg: theme().textMuted }}> │ 🧠 </span>
                        <span style={{ fg: theme().primary, bold: true }}>Model: </span>
                        {model && slash > 0
                          ? <><span style={{ fg: theme().textMuted }}>{model.slice(0, slash)}/</span><span style={{ fg: theme().info, bold: true }}>{model.slice(slash + 1)}</span></>
                          : goal().parentModel
                            ? <><span style={{ fg: theme().textMuted }}>↩ </span><span style={{ fg: theme().info, bold: true }}>{goal().parentModel}</span><span style={{ fg: theme().textMuted }}> (parent)</span></>
                            : <span style={{ fg: theme().textMuted }}>parent</span>}
                        <span style={{ fg: theme().textMuted }}> │ 💰 </span>
                        <span style={{ fg: theme().primary, bold: true }}>Spent: </span>
                        <span style={{ fg: theme().success, bold: true }}>{formatCost((goal() as any).costUsed)}</span>
                        <span style={{ fg: theme().textMuted }}> · </span>
                        <span style={{ fg: theme().warning, bold: true }}>{formatTokens(goal().tokensUsed)}</span>
                        <span style={{ fg: theme().textMuted }}> tokens · {formatDuration(goal().timeUsedSeconds)}</span>
                      </>)
                    })()}
                    {"\n"}
                    <span style={{ fg: theme().primary, bold: true }}>🎯 Target: </span>
                    <span style={{ fg: theme().text }}>{goal().objective.slice(0, 160)}</span>
                    {lp() && <><span style={{ fg: theme().success }}>{"\n"}✔ </span><span style={{ fg: theme().success, bold: true }}>Progress: </span><span style={{ fg: theme().text }}>{lp()!.summary.slice(0, 100)}</span><span style={{ fg: theme().textMuted }}> → {lp()!.next?.slice(0, 60) || ""}</span></>}
                    {blk() && <><span style={{ fg: theme().error, bold: true }}>{"\n"}✖ Blocked: </span><span style={{ fg: theme().error }}>{blk()!.reason.slice(0, 140)}</span><span style={{ fg: theme().textMuted }}> — {blk()!.needed.slice(0, 60)}</span></>}
                    {goal().config.artifactDir && <><span style={{ fg: theme().accent }}>{"\n"}📁 </span><span style={{ fg: theme().accent, bold: true }}>Artifacts: </span><span style={{ fg: theme().textMuted }}>{String(goal().config.artifactDir).replace(String(props.directory), ".")}</span></>}
                    {goal().workerTopology && <><span style={{ fg: theme().textMuted }}>{"\n"}🌿 Worker: </span><span style={{ fg: theme().text }}>{goal().workerTopology === "v2-native-child" ? "native child" : goal().workerTopology === "v2-root-fallback" ? "root fallback" : "v1 child"}</span>{goal().nativeParentID ? <span style={{ fg: theme().textMuted }}> of {(goal().nativeParentID as string).slice(0, 12)}…</span> : null}</>}
                    {goal().interactive === true && <><span style={{ fg: theme().accent, bold: true }}>{"\n"}✋ Manual: </span><span style={{ fg: theme().textMuted }}>engine never starts turns — steer with :send/nudge (:interactive to re-enable auto)</span></>}
                    {goal().config.model && <><span style={{ fg: theme().info, bold: true }}>{"\n"}🧠 Model: </span><span style={{ fg: theme().text }}>{goal().config.model}</span>{goal().modelSwitch?.pending ? <span style={{ fg: theme().warning }}> → pending {goal().modelSwitch?.pending?.model} (applies next turn)</span> : null}</>}
                    {goal().config.agent && <><span style={{ fg: theme().info, bold: true }}>{"\n"}🤖 Agent: </span><span style={{ fg: theme().text }}>{goal().config.agent}</span>{goal().agentSwitch?.pending ? <span style={{ fg: theme().warning }}> → pending {goal().agentSwitch?.pending?.agent} (applies next turn)</span> : null}</>}
                    {(goal().config.checks?.length ?? 0) > 0 ? <><span style={{ fg: theme().warning }}>{"\n"}▣ </span><span style={{ fg: theme().warning, bold: true }}>Checks: </span><span style={{ fg: theme().textMuted }}>{(goal().config.checks as string[]).join(", ").slice(0, 100)}</span></> : null}
                    <><span style={{ fg: theme().info, bold: true }}>{"\n"}Write scope: </span><span style={{ fg: theme().textMuted }}>{goal().config.workspaceWrite === false ? "read-only / own artifacts" : goal().config.write_scope === undefined ? "whole workspace (legacy exclusive)" : goal().config.write_scope!.length === 0 ? "exploration only — claim before editing" : goal().config.write_scope!.join(", ")}</span>{goal().scopeClosing || goal().scopeClearPending ? <span style={{ fg: theme().warning }}> — closing; claims retained until writes drain</span> : null}</>
                    {(rt() as any)?.evaluatorRejectionCount > 0 && <><span style={{ fg: theme().warning }}>{"\n"}⚠ rejections: </span><span style={{ fg: theme().warning }}>{String((rt() as any).evaluatorRejectionCount)} — {String((rt() as any).lastRejectionDetails || "").slice(0, 80)}</span></>}
                    {(rt() as any)?.unknownStatusCount > 0 && <><span style={{ fg: theme().error }}>{"\n"}⚠️ unreachable: </span><span style={{ fg: theme().error }}>{String((rt() as any).unknownStatusCount)}/3</span><span style={{ fg: theme().textMuted }}> — nudge to recover</span></>}
                    {(rt() as any)?.retryAfter && <><span style={{ fg: theme().accent }}>{"\n"}↻ retry in: </span><span style={{ fg: theme().accent }}>{countdownLabel((rt() as any).retryAfter, clock())}</span></>}
                    {(rt() as any)?.nextRunAt && <><span style={{ fg: theme().accent }}>{"\n"}⏰ next run: </span><span style={{ fg: theme().accent }}>{countdownLabel((rt() as any).nextRunAt, clock())}</span><span style={{ fg: theme().textMuted }}> ({String((rt() as any).scheduleRunCount || 0)} runs)</span></>}
{rt()?.lastError && <><span style={{ fg: theme().error }}>{"\n"}⚠ </span><span style={{ fg: theme().error, bold: true }}>Error: </span><span style={{ fg: theme().error }}>{rt()!.lastError!.slice(0, 120)}</span></>}
                    </text>
                  </box>
                  <text style={{ fg: theme().textMuted }}><span style={{ italic: true }}>▼ scroll for more</span></text>
                </box>
              )
            }}
          </Show>
          </Show>

          {/* Commands tab — owner-scoped sessions. `o` opens the fullscreen
              terminal route; goal controls never apply here. */}
          <Show when={tab() === "commands"}>
            <Show when={ownerCommands().length > 0} fallback={
              <box flexDirection="column" gap={1} padding={1}>
                <text><span style={{ fg: theme().textMuted }}>No live command sessions{hiddenFinishedCommands() > 0 ? ` — ${hiddenFinishedCommands()} finished hidden` : ""}. </span><span style={{ fg: theme().warning }}>:new &lt;command&gt;</span><span style={{ fg: theme().textMuted }}> to start one{hiddenFinishedCommands() > 0 ? ", or " : "; "}</span>{hiddenFinishedCommands() > 0 && <span><span style={{ fg: theme().warning }}>c</span><span style={{ fg: theme().textMuted }}> to show finished.</span></span>}</text>
                <text><span style={{ fg: theme().textMuted }}>Tip: </span><span style={{ fg: theme().warning }}>o</span><span style={{ fg: theme().textMuted }}> fullscreen · </span><span style={{ fg: theme().warning }}>X kill · R restart · x remove-done</span><span style={{ fg: theme().textMuted }}> · </span><span style={{ fg: theme().warning }}>:interrupt :terminate :remove</span><span style={{ fg: theme().textMuted }}> manage · text + Enter writes stdin.</span></text>
              </box>
            }>
              <DashboardList count={ownerCommands().length} selectedID={selectedCommand() ? `loopd-command-${selectedCommand()!.id}` : undefined}>
                <For each={ownerCommands()}>
                  {(cmd, i) => {
                    const isActive = () => i() === cmdSelected()
                    return (
                      <DashboardRow id={`loopd-command-${cmd.id}`} backgroundColor={isActive() ? theme().backgroundElement : undefined}>
                        {/* Single-line row mirrors the Goals row: icon+bold name,
                            status-colored badge, accent executable, muted args. */}
                          <span style={{ fg: commandStatusColor(cmd.status, theme()), bold: isActive() }}>{isActive() ? `▶ ${cmd.title}` : `  ${commandStatusIcon(cmd.status)} ${cmd.title}`}</span>
                          <span style={{ fg: theme().textMuted }}> │ </span>
                          <span style={{ fg: theme().textMuted }}>Cmd </span>
                          <span style={{ fg: commandStatusColor(cmd.status, theme()), bold: true }}>{commandStatusLabel(cmd.status).short}</span>
                          <span style={{ fg: theme().textMuted }}> │ </span>
                          <span style={{ fg: theme().accent, bold: true }}>{cmd.command}</span>
                          {cmd.args.length > 0 && <span style={{ fg: theme().textMuted }}> {cmd.args.join(" ").slice(0, 40)}</span>}
                          {cmd.exitCode !== undefined && <span style={{ fg: cmd.exitCode === 0 ? theme().success : theme().error }}> │ exit {cmd.exitCode}</span>}
                          {cmd.signal && <span style={{ fg: theme().warning }}> │ {cmd.signal}</span>}
                          <span style={{ fg: theme().textMuted }}> │ {ageLabel(cmd.updatedAt, clock())}</span>
                          {cmd.truncated && <span style={{ fg: theme().warning, bold: true }}> │ ⚠ truncated</span>}
                      </DashboardRow>
                    )
                  }}
                </For>
              </DashboardList>
            </Show>
            <Show when={selectedCommand()}>
              {(cmd) => (
                <box flexDirection="column" border={true} borderColor={commandBorderColor(cmd().status, theme())} padding={1} flexShrink={0} maxHeight={8}>
                  <text>
                    <span style={{ fg: commandStatusColor(cmd().status, theme()), bold: true }}>{commandStatusIcon(cmd().status)} {cmd().title}</span>
                    <span style={{ fg: theme().textMuted }}> Cmd </span>
                    <span style={{ fg: commandStatusColor(cmd().status, theme()) }}>{commandStatusLabel(cmd().status).short} — {commandStatusLabel(cmd().status).hint}</span>
                    {"\n"}
                    <span style={{ fg: theme().primary, bold: true }}>⬢ Spawn: </span>
                    <span style={{ fg: theme().accent, bold: true }}>{cmd().command}</span>
                    {cmd().args.length > 0 && <span style={{ fg: theme().text }}> {cmd().args.join(" ")}</span>}
                    {"\n"}
                    <span style={{ fg: theme().textMuted }}>📁 </span>
                    <span style={{ fg: theme().accent, bold: true }}>Cwd: </span>
                    <span style={{ fg: theme().textMuted }}>{cmd().cwd.replace(String(props.directory), ".")}</span>
                    {cmd().goalID && <><span style={{ fg: theme().textMuted }}> │ 🔗 linked goal </span><span style={{ fg: theme().text }}>{cmd().goalID!.slice(0, 8)}</span></>}
                    {"\n"}
                    <span style={{ fg: theme().warning, bold: true }}>💾 </span>
                    <span style={{ fg: theme().warning, bold: true }}>Output: </span>
                    <span style={{ fg: theme().text }}>{cmd().outputBytes} bytes</span>
                    {cmd().truncated && <span style={{ fg: theme().warning, bold: true }}> · ⚠ truncated</span>}
                    <span style={{ fg: theme().textMuted }}> │ updated {ageLabel(cmd().updatedAt, clock())}</span>
                    {cmd().lastError && <><span style={{ fg: theme().error, bold: true }}>{"\n"}⚠ Error: </span><span style={{ fg: theme().error }}>{cmd().lastError!.slice(0, 120)}</span></>}
                    {"\n"}
                    <span style={{ fg: theme().textMuted }}>o fullscreen · X kill · R restart · x remove-done · :interrupt :terminate :remove · text + Enter writes stdin</span>
                  </text>
                </box>
              )}
            </Show>
          </Show>

          {/* Logs — bounded, clipped, per-event coloring */}
          <Show when={showLogs() && events().length > 0}>
            <box flexDirection="column" border={true} borderColor={theme().border} padding={1} maxHeight={7} flexShrink={0} overflow="hidden">
              <text>
                <span style={{ fg: theme().accent, bold: true }}>◈ Recent Events</span><span style={{ fg: theme().textMuted }}> — :logs to hide</span>
                <For each={events().slice(-10)}>{(ev) => (
                  <>
                    {"\n"}
                    <span style={{ fg: eventColor(String((ev as any).type), theme()), bold: true }}>{String((ev as any).type)}</span>
                    <span style={{ fg: theme().textMuted }}> {(ev as any).goalID?.slice(0, 8)}</span>
                    {(ev as any).summary && <span style={{ fg: theme().text }}> — {String((ev as any).summary).slice(0, 60)}</span>}
                  </>
                )}</For>
              </text>
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
              if (mode() === "insert") setCommandInput(v)
              else if (inputEl?.value) inputEl.value = ""
            }}
            onKeyDown={(evt: ParsedKey) => {
              // Single source of truth for Enter/Escape/Ctrl+N is the global
              // useKeyboard handler above; this prop only stops normal-mode
              // keystrokes from landing in the box as text.
              if (mode() !== "insert") { if ((evt.name || "").length === 1) prevent(evt); return }
            }}
          />
        </box>
      </box>
    </box>
  )
}
