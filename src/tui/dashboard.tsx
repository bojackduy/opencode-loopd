// ─── TUI: Dashboard Component ────────────────────────────────────────────────
// Modal dashboard — single always-focused input traps keys, no leak to chat.
// Scrollable sections with input always visible at bottom.

/** @jsxImportSource @opentui/solid */
import { batch, createSignal, For, Show, onCleanup, onMount, createEffect, type JSX } from "solid-js"
import { useKeyboard } from "@opentui/solid"
import type { TuiPluginApi, TuiThemeCurrent } from "@opencode-ai/plugin/tui"
import type { InputRenderable, ParsedKey, ScrollBoxRenderable, TextRenderable } from "@opentui/core"
import { readEvents, readState } from "../infrastructure/state-repository"
import { createControlClient } from "../infrastructure/control-client"
import type { StoreState } from "../infrastructure/state-repository"
import type { Goal } from "../domain/goal"
import type { GoalRuntimeState } from "../domain/runtime"
import { parseCommand, commandHelp, commandTabHelp } from "./command-parser"
import { parseNewCommand } from "./command-controller"
import { workerActivityLabel } from "../domain/status-labels"
import { bugReportUrl, openBrowserUrl } from "../browser"
import {
  moveDashboardSelection,
  resolveDashboardOpen,
  toggleDashboardView,
  dashboardViewForKey,
  goalSelectionKey,
  indexForSelectionKey,
  toggleCollapsed,
  type DashboardSelection,
  type DashboardView,
} from "./dashboard-view"
import { TERMINAL_ROUTE_NAME, currentRouteSessionID, terminalRoutePayload } from "./terminal-route"
import type { CommandSession } from "../domain/command-session"
import { randomUUID } from "crypto"
import { createDashboardRefresh } from "./dashboard-refresh"
import { managedStorePath, resolveManagedDirs, statusAll, type ManagedDirStatus } from "../server/managed-status"
import {
  toRowModel,
  summarizeScope,
  summaryText,
  groupByDirectory,
  filterRows,
  ageText,
  countdownText,
  formatRowColumns,
  fitHintBar,
  FOOT_HINTS,
  type RowModel,
  type DirectoryGroup,
} from "./dashboard-presentation"
import { GoalInspector, GoalDetailsDrawer } from "./goal-details"
import {
  CoordinationPanel,
  type CoordinationTab,
  type CoordinationModel,
} from "./coordination-panel"

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
  /** Which tab opens focused (`/loop` → project, `/commands` → commands). */
  initialView?: DashboardView | "goals"
  /** Owner scope for the Commands view. Defaults to the current session. */
  ownerSessionID?: string
  /** Fullscreen open for commands. Default: route-navigate + close popup. */
  onOpenCommand?: (payload: { commandID: string; ownerSessionID: string; returnSessionID: string }) => void
  /** Keyboard-active gate. Default: the popup dialog is open. */
  isActive?: () => boolean
}

/** Legacy callers pass "goals" — normalize to the Project tab. */
function normalizeInitialView(view: DashboardView | "goals" | undefined): DashboardView {
  if (view === "goals") return "project"
  return view ?? "project"
}

function eventColor(type: string, theme: TuiThemeCurrent) {
  if (type === "goal.completed") return theme.info
  if (type === "goal.blocked" || type === "run.failed") return theme.error
  if (type === "goal.created" || type === "goal.progress") return theme.success
  if (type === "run.started" || type === "compaction.started") return theme.warning
  return theme.textMuted
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

/** Dashboard header: exactly two lines. Line 1 is title+project+counts;
 * line 2 is tabs+scope. Segments stay short so a phrase never wraps
 * mid-way; each line is one <text> node. A separate component (not inline)
 * so the OpenTUI test renderer can assert the two-line shape directly. */
export function DashboardHeader(props: {
  theme: TuiThemeCurrent
  mode: string
  scopeName: string
  summary: string
  tab: "project" | "fleet" | "commands"
  projCount: number
  onBugReport: () => void
}): JSX.Element {
  const theme = () => props.theme
  const tabLabel = (id: "project" | "fleet" | "commands", text: string) => (
    <span style={{ fg: props.tab === id ? theme().info : theme().textMuted, bold: props.tab === id }}>
      {props.tab === id ? `[${text}]` : ` ${text} `}
    </span>
  )
  // Three fixed lines, one responsibility each:
  //   1 identity (title + bug action)
  //   2 navigation (tabs) + interaction mode
  //   3 status summary + scope
  // Keeping them apart is what stops the header reading as one run-on line.
  return (
    <box flexDirection="column" flexShrink={0} gap={0}>
      <box flexDirection="row" justifyContent="space-between" alignItems="center" height={1} overflow="hidden" flexShrink={0}>
        <text wrapMode="none" truncate={true} minWidth={0} flexShrink={1}>
          <span style={{ fg: theme().info, bold: true }}>⬢ Loop Dashboard</span>
        </text>
        <box flexDirection="row" alignItems="center" backgroundColor={theme().error as unknown as string} paddingLeft={1} paddingRight={1} {...({ onMouseDown: props.onBugReport } as any)}>
          <text><span style={{ fg: "white", bold: true }}>Bug Report</span></text>
        </box>
      </box>
      <box flexDirection="row" alignItems="center" height={1} overflow="hidden" flexShrink={0} gap={1}>
        <text wrapMode="none" truncate={true} minWidth={0} flexShrink={1}>
          {tabLabel("project", "1 Project")}
          {tabLabel("fleet", "2 Fleet")}
          {tabLabel("commands", "3 Commands")}
          <span style={{ fg: theme().textMuted }}> │ </span>
          <span style={{ fg: props.mode === "normal" ? theme().success : theme().warning, bold: true }}>{props.mode.toUpperCase()}</span>
        </text>
      </box>
      <box flexDirection="row" alignItems="center" height={1} overflow="hidden" flexShrink={0}>
        <text wrapMode="none" truncate={true} minWidth={0} flexShrink={1}>
          <span style={{ fg: theme().text }}>{props.summary}</span>
          <span style={{ fg: theme().textMuted }}> │ </span>
          <span style={{ fg: theme().accent, bold: true }}>{props.scopeName}</span>
          <span style={{ fg: theme().textMuted }}> · {props.projCount} proj</span>
        </text>
      </box>
    </box>
  )
}

export function LoopDashboard(props: Props) {
  const theme = () => props.api.theme.current
  const [mode, setMode] = createSignal<Mode>("normal")
  const [selected, setSelected] = createSignal(0)
  const [commandInput, setCommandInput] = createSignal("")
  const [statusText, setStatusText] = createSignal("")
  // Shared Goals/Commands tabs (`/loop` opens goals, `/commands` opens
  // commands). Goal indexes stay on the legacy `selected` signal; command
  // selection lives on `cmdSelected` so the two never cross-apply.
  const [tab, setTab] = createSignal<DashboardView>(normalizeInitialView(props.initialView))
  const [cmdSelected, setCmdSelected] = createSignal(0)
  // Project scope for the Project tab (one managed directory) and the
  // Commands tab filter. Fleet shows all managed dirs grouped.
  const [projectScope, setProjectScope] = createSignal<string>(props.directory)
  const [cmdScope, setCmdScope] = createSignal<string>("all")
  const [filterText, setFilterText] = createSignal("")
  const [collapsed, setCollapsed] = createSignal<string[]>([])
  const [coordOpen, setCoordOpen] = createSignal(false)
  const [coordTab, setCoordTab] = createSignal<CoordinationTab>("writes")
  const [detailsOpen, setDetailsOpen] = createSignal(false)
  const [actionsOpen, setActionsOpen] = createSignal(false)
  const [selectedKey, setSelectedKey] = createSignal<string | undefined>(undefined)
  const [pendingRelease, setPendingRelease] = createSignal<{ callID: string; dir: string } | null>(null)
  const ownerSessionID = () => props.ownerSessionID ?? currentRouteSessionID(props.api)
  /** Command entries across the command scope: own dir (live bus) plus
   * managed dirs (display-only reads). Owner filter + finished hiding apply
   * per entry; mutating actions stay own-dir only (guarded at the call site). */
  const commandEntries = (): Array<{ cmd: CommandSession; dir: string }> => {
    const dirs = cmdScope() === "all" ? managedDirs() : [cmdScope()]
    const out: Array<{ cmd: CommandSession; dir: string }> = []
    for (const dir of dirs) {
      const cmds = dir === props.directory ? (state()?.commands ?? []) : (managedStates()[dir]?.commands ?? [])
      for (const cmd of cmds) out.push({ cmd, dir })
    }
    return out
  }
  const ownerCommands = () => {
    const owned = commandEntries().filter(({ cmd }) =>
      ownerSessionID() ? cmd.ownerSessionID === ownerSessionID() : false,
    )
    if (showCompleted()) return owned.map(({ cmd }) => cmd)
    const terminal = ["exited", "terminated", "missing"]
    return owned.filter(({ cmd }) => !terminal.includes(cmd.status)).map(({ cmd }) => cmd)
  }
  /** Directory of an owned command entry (for the foreign guard). */
  const commandDir = (commandID: string): string => {
    const hit = commandEntries().find(({ cmd }) => cmd.id === commandID)
    return hit ? hit.dir : props.directory
  }
  /** Owned-but-finished commands hidden by the `c` toggle — surfaced in the empty state. */
  const hiddenFinishedCommands = () => {
    if (showCompleted()) return 0
    const terminal = ["exited", "terminated", "missing"]
    return (state()?.commands ?? []).filter(
      (c) => c.ownerSessionID === ownerSessionID() && terminal.includes(c.status),
    ).length
  }
  const [state, setState] = createSignal<StoreState | null>(null)
  const [hintCols, setHintCols] = createSignal(80)
  let hintBoxEl: { width?: number } | undefined
  /** Whole-frame scroller: j/k past the last list row scrolls the frame so the
   * inspector and drawer come into view, instead of clamping at the list end. */
  let frameEl: ScrollBoxRenderable | undefined
  // Refit footer hints to the measured bar width on every clock tick (cheap
  // string math; the dashboard already re-renders for ages). Falls back to
  // the 80-column default before the first measurement.
  createEffect(() => {
    clock()
    const w = hintBoxEl?.width
    if (typeof w === "number" && w > 0) {
      // Reserve the borders (2), the row paddings (2), the gap (1) and the
      // NORMAL/INSERT badge (8) plus a small safety margin: overshooting here
      // clipped the last hint mid-word at the panel edge.
      const cols = Math.max(20, Math.floor(w) - 20)
      if (cols !== hintCols()) setHintCols(cols)
    }
  })
  const [events, setEvents] = createSignal<Record<string, unknown>[]>([])
  const [selectedGoal, setSelectedGoal] = createSignal<Goal | null>(null)
  const [showLogs, setShowLogs] = createSignal(false)
  const [showHelp, setShowHelp] = createSignal(false)
  const [showCompleted, setShowCompleted] = createSignal(false)
  const [clock, setClock] = createSignal(Date.now())
  const [agentIndex, setAgentIndex] = createSignal<Record<string, AgentMeta>>({})
  // Multi-project view over the single managed-dirs resolver (registry file
  // + env + explicit). Single-dir default: [props.directory] until loaded.
  const [managedDirList, setManagedDirList] = createSignal<string[]>([props.directory])
  const managedDirs = () => managedDirList()
  const [projectStatuses, setProjectStatuses] = createSignal<ManagedDirStatus[] | null>(null)
  const [showProjects, setShowProjects] = createSignal(false)
  // Per-directory states for the aggregate Goals tab (own dir stays on the
  // live control-bus state; foreign dirs are read directly, display-only).
  const [managedStates, setManagedStates] = createSignal<Record<string, StoreState>>({})
  async function refreshProjects() {
    try {
      setManagedDirList(await resolveManagedDirs(props.directory))
      setProjectStatuses(await statusAll(managedDirs()))
      const states: Record<string, StoreState> = {}
      for (const dir of managedDirs()) {
        if (dir === props.directory) continue
        try {
          states[dir] = await readState(dir)
        } catch { /* per-dir failure shows in :projects; Goals tab keeps own goals */ }
      }
      if (!disposed) setManagedStates(states)
    } catch (e) {
      setStatusText(`Error: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  let inputEl: InputRenderable | undefined
  let focusTimer: ReturnType<typeof setTimeout> | undefined
  let disposed = false
  const client = createControlClient(props.directory)
  /** Per-directory control clients: foreign rows act on their own project bus,
   * never the local fallback. Creation is cheap (closure over directory);
   * a target with no live control worker surfaces an honest timeout. */
  const clients = new Map<string, ReturnType<typeof createControlClient>>([[props.directory, client]])
  function clientFor(dir: string): ReturnType<typeof createControlClient> {
    let c = clients.get(dir)
    if (!c) {
      c = createControlClient(dir)
      clients.set(dir, c)
    }
    return c
  }
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
  refreshProjects()
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
    const currentGoals = rowModels()
    const currentCommands = ownerCommands()
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
      const last = Math.max(0, currentGoals.length - 1)
      const selectedNow = tab() === "commands" ? cmdSelected() : selected()
      // Past the list boundary, walk the frame instead: the list is capped,
      // so the remaining content (inspector, details, logs) lives below the
      // fold exactly as on the prototype's scrollable page.
      if (move === "down" && selectedNow >= last) { frameEl?.scrollBy({ x: 0, y: 1 }); return }
      if (move === "up" && selectedNow <= 0 && (frameEl?.scrollTop ?? 0) > 0) { frameEl?.scrollBy({ x: 0, y: -1 }); return }
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
    // Goal controls apply to the worker tabs — never on Commands or to a
    // command selection. Model controls (model/models) are goal verbs too.
    const needsWorkerTab = ["p", "r", "A", "N", "W", "model", "models", "agent", "agents"].includes(key)
    if (needsWorkerTab && tab() === "commands") {
      prevent(evt)
      setStatusText("Goal controls need the Project or Fleet tab (Tab to switch).")
      return
    }
    if (key === "p") { prevent(evt); void executeCommand("pause"); return }
    if (key === "r") { prevent(evt); void executeCommand("resume"); return }
    if (key === "R") { prevent(evt); void executeCommand("retry"); return }
    if (key === "x") { prevent(evt); void executeCommand("clear"); return }
    if (key === "A") { prevent(evt); void executeCommand("abort"); return }
    if (key === "N") { prevent(evt); void executeCommand("nudge"); return }
    // Revamp keys: history, filter, details, coordination, send-prefill.
    // `h` no longer selects a tab (`1` covers Project); `l` still opens
    // Commands alongside `3`.
    if (key === "h") {
      prevent(evt)
      setShowCompleted((v) => {
        const next = !v
        setStatusText(next ? "Showing finished goals and commands." : "Hiding finished goals and commands.")
        return next
      })
      return
    }
    if (key === "/") {
      prevent(evt)
      // Filter runs through the command input (:filter) — no second focusable.
      setCommandInput("filter ")
      if (inputEl) inputEl.value = "filter "
      setMode("insert")
      focusInput()
      return
    }
    if (key === "d") { prevent(evt); setDetailsOpen((v) => !v); return }
    if (key === "t") { prevent(evt); setCoordOpen((v) => !v); return }
    if (key === "s") {
      prevent(evt)
      if (!selectedGoal()) { setStatusText("No goal selected"); return }
      setCommandInput("send ")
      if (inputEl) inputEl.value = "send "
      setMode("insert")
      focusInput()
      return
    }
    if (isEnterKey(evt)) { prevent(evt); setActionsOpen((v) => !v); return }
    if (pendingRelease()) {
      if (key === "y") {
        prevent(evt)
        const target = pendingRelease()!
        setPendingRelease(null)
        void releaseWorkspaceFences({ callID: target.callID }, target.dir)
        return
      }
      if (isEscapeKey(evt)) { prevent(evt); setPendingRelease(null); return }
    }
    if (key === "[") {
      prevent(evt)
      cycleScope(-1)
      return
    }
    if (key === "]") {
      prevent(evt)
      cycleScope(1)
      return
    }
    if (isEscapeKey(evt)) {
      if (actionsOpen()) { prevent(evt); setActionsOpen(false); return }
      if (detailsOpen()) { prevent(evt); setDetailsOpen(false); return }
      if (coordOpen()) { prevent(evt); setCoordOpen(false); focusInput(); return }
      if (filterText()) { prevent(evt); setFilterText(""); setStatusText("filter cleared"); return }
    }
    if (key === "W") {
      prevent(evt)
      // One-key fence release for the selected goal's own project bus.
      if (fenceCount() === 0) {
        setStatusText("No workspace fences to release — nothing is blocking writes or checks.")
        return
      }
      const goal = selectedGoal()
      void releaseWorkspaceFences(goal ? { goalID: goal.id } : {}, goal ? goalDir(goal.id) : undefined)
      return
    }
    if (key === "L") { prevent(evt); setShowLogs((value) => !value); return }
    if (key === "o") {
      prevent(evt)
      // `o` dispatches by active selection type: goals open their native
      // worker session; commands close the popup and open the fullscreen
      // terminal route. Never cross-applies.
      const target = resolveDashboardOpen(
        { goals: activeGoals().map((e) => e.goal), commands: state()?.commands ?? [] },
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

  /** Raw control-bus send for the Commands tab (owner-scoped, fail closed).
   * Mutations route to the local bus only: foreign rows are display-only
   * (open their own dashboard or steer via agent tools). */
  async function executeCommandRaw(command: string, args: Record<string, unknown>, commandID?: string) {
    const owner = ownerSessionID()
    if (!owner) {
      setStatusText("No owning session (open from a session view) — mutations disabled.")
      return
    }
    if (commandID && commandDir(commandID) !== props.directory) {
      setStatusText(`Foreign command — open the ${commandDir(commandID)} dashboard. Mutations stay local.`)
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

  /**
   * Inspect or release workspace fences through the same goalService path the
   * agent tool uses. No selector = inspect; every safety refusal is reported
   * verbatim. Refresh afterwards: the fence state is what the user acted on.
   */
  async function releaseWorkspaceFences(selection: { callID?: string; goalID?: string; sessionID?: string }, dir?: string) {
    const owner = ownerSessionID()
    if (!owner) {
      setStatusText("No owning session (open from a session view) — release disabled.")
      return
    }
    const targetDir = dir ?? props.directory
    const selecting = Boolean(selection.callID || selection.goalID || selection.sessionID)
    if (!selecting && fenceCount() === 0) {
      setStatusText("No live workspace reservations — nothing is fencing this project.")
      return
    }
    setStatusText(selecting ? "releasing workspace fence…" : "inspecting workspace fences…")
    try {
      const r = await clientFor(targetDir).execute({
        version: 1,
        requestID: randomUUID(),
        requestedAt: new Date().toISOString(),
        command: "release_workspace",
        args: { ownerSessionID: owner, ...selection },
      })
      setStatusText(r.ok ? r.message : `Release refused: ${r.message}`)
      await refresh()
    } catch (e) {
      setStatusText(`Error: ${e instanceof Error ? e.message : String(e)}`)
    }
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
    return
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
      case "projects": {
        setShowProjects(true)
        await refreshProjects()
        const list = projectStatuses() ?? []
        setStatusText(list.length ? list.map((p) => `${p.directory}: ${p.total} goals (${p.active} active, ${p.blocked} blocked)`).join(" · ") : `${managedDirs().length} project(s): ${managedDirs().join(", ")}`)
        return
      }
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
    // Goal verbs reach the selected goal's own project bus (see bus above):
    // foreign rows act remotely, never through the local fallback. The old
    // display-only guard is gone — routing replaced blocking.
    // Worker-tab verbs route through the selected goal's own project bus
    // (per-directory client). A target with no live control worker answers
    // with an honest timeout — never a local fallback, never fake success.
    const verbDir = selectedGoal() ? goalDir(selectedGoal()!.id) : props.directory
    const bus = clientFor(verbDir)
    // Immediate feedback: the control round-trip can take seconds (or time
    // out at 30s), and silence until then reads as "keys do nothing".
    if (!["help", "logs", "q", "close"].includes(parsed.command)) {
      setStatusText(`sending ${parsed.command}…`)
    }
    try {
      switch (parsed.command) {
        case "filter": {
          setFilterText(parsed.positional.join(" "))
          setStatusText(parsed.positional.length ? `filter: "${parsed.positional.join(" ")}"` : "filter cleared")
          break
        }
        case "project": {
          const name = parsed.positional.join(" ").trim()
          if (!name) {
            setStatusText(`projects: ${managedDirs().join(" · ")}`)
            break
          }
          const match = managedDirs().find((d) => d === name || d.split("/").pop() === name || String(managedDirs().indexOf(d) + 1) === name)
          if (!match) { setStatusText(`Unknown project "${name}" — :project lists managed dirs.`); break }
          if (tab() === "commands") setCmdScope(match)
          else setProjectScope(match)
          setSelected(0)
          setStatusText(`scope: ${match}`)
          break
        }
        case "collapse": {
          const name = parsed.positional.join(" ").trim()
          const dir = name
            ? (managedDirs().find((d) => d === name || d.split("/").pop() === name) ?? null)
            : (selectedDir() || null)
          if (!dir) { setStatusText(`Unknown project "${name}"`); break }
          setCollapsed(toggleCollapsed(collapsed(), dir))
          setSelected(0)
          setStatusText(collapsed().includes(dir) ? `collapsed ${dir}` : `expanded ${dir}`)
          break
        }
        case "focus": {
          const dir = selectedDir()
          setProjectScope(dir)
          setTab("project")
          setSelected(0)
          setFilterText("")
          setStatusText(`scope: ${dir}`)
          break
        }
        case "history": {
          setShowCompleted((v) => !v)
          setStatusText(showCompleted() ? "Showing finished goals and commands." : "Hiding finished goals and commands.")
          break
        }
        case "send": {
          if (!selectedGoal()) { setStatusText("No goal selected"); break }
          const message = parsed.positional.join(" ") || parsed.args.message || ""
          if (!message) { setStatusText("Usage: :send <message>"); break }
          const r = await bus.execute({ version: 1, requestID: randomUUID(), requestedAt: new Date().toISOString(), command: "send", goalID: selectedGoal()!.id, args: { message } })
          setStatusText(r.ok ? r.message : `Error: ${r.message}`); if (r.ok) await refresh()
          break
        }
        case "open": {
          const goal = selectedGoal()
          if (!goal?.workerSessionID) { setStatusText("No worker session"); break }
          try {
            props.api.route.navigate("session", { sessionID: goal.workerSessionID })
            props.api.ui.dialog.clear()
          } catch {
            setStatusText("Navigate unsupported here — read the transcript via agent tools (read_goal_transcript).")
          }
          return
        }
        case "force": {
          if (!selectedGoal()) { setStatusText("No goal"); break }
          const summary = parsed.positional.join(" ") || parsed.args.summary || "Force-completed from dashboard."
          const evidence = parsed.args.evidence || "Manual override — no verification checks run."
          const r = await bus.execute({ version: 1, requestID: randomUUID(), requestedAt: new Date().toISOString(), command: "force_complete", goalID: selectedGoal()!.id, args: { summary, evidence } })
          setStatusText(r.ok ? r.message : `Error: ${r.message}`); if (r.ok) await refresh()
          break
        }
        case "block": {
          if (!selectedGoal()) { setStatusText("No goal"); break }
          const reason = parsed.positional.join(" ") || parsed.args.reason || "Blocked from dashboard."
          const needed = parsed.args.needed || "User intervention required."
          const r = await bus.execute({ version: 1, requestID: randomUUID(), requestedAt: new Date().toISOString(), command: "block", goalID: selectedGoal()!.id, args: { reason, needed } })
          setStatusText(r.ok ? r.message : `Error: ${r.message}`); if (r.ok) await refresh()
          break
        }
        case "pause": { if (!selectedGoal()) { setStatusText("No goal"); break } const r = await bus.execute({ version: 1, requestID: randomUUID(), requestedAt: new Date().toISOString(), command: "pause", goalID: selectedGoal()!.id }); setStatusText(r.ok ? r.message : `Error: ${r.message}`); if (r.ok) await refresh(); break }
        case "resume": { if (!selectedGoal()) { setStatusText("No goal"); break } const r = await bus.execute({ version: 1, requestID: randomUUID(), requestedAt: new Date().toISOString(), command: "resume", goalID: selectedGoal()!.id }); setStatusText(r.ok ? r.message : `Error: ${r.message}`); if (r.ok) await refresh(); break }
        case "retry": { if (!selectedGoal()) { setStatusText("No goal"); break } const r = await bus.execute({ version: 1, requestID: randomUUID(), requestedAt: new Date().toISOString(), command: "retry", goalID: selectedGoal()!.id }); setStatusText(r.ok ? r.message : `Error: ${r.message}`); if (r.ok) await refresh(); break }
        case "clear": { if (!selectedGoal()) { setStatusText("No goal"); break } const r = await bus.execute({ version: 1, requestID: randomUUID(), requestedAt: new Date().toISOString(), command: "clear", goalID: selectedGoal()!.id }); setStatusText(r.ok ? r.message : `Error: ${r.message}`); if (r.ok) await refresh(); break }
        case "abort": { if (!selectedGoal()) { setStatusText("No goal"); break } const r = await bus.execute({ version: 1, requestID: randomUUID(), requestedAt: new Date().toISOString(), command: "abort_worker", goalID: selectedGoal()!.id }); setStatusText(r.ok ? r.message : `Error: ${r.message}`); if (r.ok) await refresh(); break }
        case "nudge": { if (!selectedGoal()) { setStatusText("No goal"); break } const r = await bus.execute({ version: 1, requestID: randomUUID(), requestedAt: new Date().toISOString(), command: "nudge", goalID: selectedGoal()!.id }); setStatusText(r.ok ? r.message : `Error: ${r.message}`); if (r.ok) await refresh(); break }
        case "interactive": {
          if (!selectedGoal()) { setStatusText("No goal"); break }
          const next = !(selectedGoal()!.interactive === true)
          const r = await bus.execute({ version: 1, requestID: randomUUID(), requestedAt: new Date().toISOString(), command: "set_interactive", goalID: selectedGoal()!.id, args: { interactive: next } })
          setStatusText(r.ok ? r.message : `Error: ${r.message}`); if (r.ok) await refresh()
          break
        }
        case "agent": {
          if (!selectedGoal()) { setStatusText("No goal selected"); break }
          const agent = parsed.positional.join(" ").trim()
          if (!agent) { setStatusText("Usage: :agent <name> — :agents lists available agents."); break }
          const r = await bus.execute({ version: 1, requestID: randomUUID(), requestedAt: new Date().toISOString(), command: "switch_goal_identity", goalID: selectedGoal()!.id, args: { agent } })
          setStatusText(r.ok ? r.message : `Error: ${r.message}`); if (r.ok) await refresh()
          break
        }
        case "agents": {
          const r = await bus.execute({ version: 1, requestID: randomUUID(), requestedAt: new Date().toISOString(), command: "list_agents" })
          setStatusText(r.ok ? r.message : `Error: ${r.message}`)
          break
        }
        case "model": {
          if (!selectedGoal()) { setStatusText("No goal selected"); break }
          const target = parsed.positional.join(" ").trim()
          if (!target) { setStatusText("Usage: :model <provider/model> — e.g. :model openai/gpt-5.6-sol. :models lists what's available."); break }
          const r = await bus.execute({ version: 1, requestID: randomUUID(), requestedAt: new Date().toISOString(), command: "switch_goal_identity", goalID: selectedGoal()!.id, args: { model: target } })
          setStatusText(r.ok ? r.message : `Error: ${r.message}`); if (r.ok) await refresh()
          break
        }
        case "models": {
          const r = await bus.execute({ version: 1, requestID: randomUUID(), requestedAt: new Date().toISOString(), command: "list_models" })
          setStatusText(r.ok ? r.message : `Error: ${r.message}`)
          break
        }
        case "release": {
          await releaseWorkspaceFences({
            callID: parsed.args.call,
            goalID: parsed.args.goal,
            sessionID: parsed.args.session,
          })
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
        case "projects": {
          setShowProjects(!showProjects())
          if (showProjects()) {
            await refreshProjects()
            const list = projectStatuses() ?? []
            setStatusText(list.length ? list.map((p) => `${p.directory}: ${p.total} goals (${p.active} active, ${p.blocked} blocked)`).join(" · ") : `${managedDirs().length} project(s): ${managedDirs().join(", ")}`)
          }
          break
        }
        case "q": case "close": props.api.ui.dialog.clear(); return
        default: {
          // Bare text in insert mode → treat as send to selected goal
          if (parsed.command && selectedGoal()) {
            const message = parsed.raw
            const r = await bus.execute({ version: 1, requestID: randomUUID(), requestedAt: new Date().toISOString(), command: "send", goalID: selectedGoal()!.id, args: { message } })
            setStatusText(r.ok ? `sent: ${message.slice(0, 80)}` : `Error: ${r.message}`); if (r.ok) await refresh()
          } else setStatusText(`Unknown: ${parsed.command}. ? for help`)
        }
      }
    } catch (e) { setStatusText(`Error: ${e instanceof Error ? e.message : String(e)}`) }
    returnToNormalMode()
  }

  /** Worker rows for the active tab. Project shows one managed directory
   * (projectScope); Fleet merges all managed dirs; both hide completed
   * unless history is on, then apply the text filter. */
  const activeGoals = () => {
    const inScope = (g: Goal) => showCompleted() || g.status !== "complete"
    if (tab() === "fleet") {
      const own = (state()?.goals ?? []).filter(inScope).map((g) => ({ goal: g, dir: props.directory }))
      const seen = new Set(own.map((e) => e.goal.id))
      const out = [...own]
      for (const [dir, st] of Object.entries(managedStates())) {
        if (dir === props.directory) continue
        for (const g of st.goals ?? []) {
          if (inScope(g) && !seen.has(g.id)) {
            seen.add(g.id)
            out.push({ goal: g, dir })
          }
        }
      }
      return out
    }
    const dir = projectScope()
    const list = dir === props.directory
      ? (state()?.goals ?? [])
      : (managedStates()[dir]?.goals ?? [])
    return list.filter(inScope).map((goal) => ({ goal, dir }))
  }
  /** Row models for the table: filtered, with stable directory+ID keys. */
  const rowModels = (): RowModel[] => {
    const now = clock()
    const rows = activeGoals().map(({ goal, dir }) => toRowModel(goal, dir, runtimeFor(goal.id), now))
    return filterRows(rows, filterText())
  }
  /** Actions/coordination take over the panel like the prototype's modal:
   * while either is open the table and inspector step aside so the panel owns
   * the viewport instead of getting squeezed into a few rows. */
  const panelOpen = () => actionsOpen() || coordOpen()
  /** Display list for the worker tabs: flat rows on Project, directory
   * group headers + rows on Fleet. Selection addresses rows only.
   *
   * Expanded-detail mode (`d`): the table collapses to the selected row only,
   * so the inspector + technical drawer get the vertical space. j/k still
   * walks every worker; the visible row follows the selection, and closing
   * the drawer restores the full table. This mirrors the prototype's
   * "detail open = one row" rule and avoids a cropped drawer. */
  const displayItems = (): Array<{ kind: "header"; dir: string; group: DirectoryGroup } | { kind: "row"; row: RowModel; index: number }> => {
    const all = rowModels()
    const rows = detailsOpen() ? all.slice(selected(), selected() + 1) : all
    if (tab() !== "fleet") return rows.map((row) => ({ kind: "row" as const, row, index: all.indexOf(row) }))
    const out: Array<{ kind: "header"; dir: string; group: DirectoryGroup } | { kind: "row"; row: RowModel; index: number }> = []
    for (const group of groupByDirectory(rows, collapsed())) {
      out.push({ kind: "header", dir: group.directory, group })
      rows.forEach((row) => {
        if (row.directory === group.directory) out.push({ kind: "row", row, index: all.indexOf(row) })
      })
    }
    return out
  }
  /** Which project a listed goal belongs to (own dir unless found elsewhere). */
  const goalDir = (goalID: string): string => {
    if ((state()?.goals ?? []).some((g) => g.id === goalID)) return props.directory
    for (const [dir, st] of Object.entries(managedStates())) {
      if ((st.goals ?? []).some((g) => g.id === goalID)) return dir
    }
    return props.directory
  }
  /** Runtime for a listed goal, from its own project's state. */
  const runtimeFor = (goalID: string): GoalRuntimeState | undefined =>
    state()?.runtimes.find((r) => r.goalID === goalID)
    ?? Object.values(managedStates()).map((st) => (st.runtimes ?? []).find((r) => r.goalID === goalID)).find(Boolean)
  /** Recent event lines for a goal's technical drawer. */
  const recentTranscriptFor = (goalID: string): string[] =>
    events()
      .filter((e) => (e as { goalID?: string }).goalID === goalID)
      .slice(-12)
      .map((e) => {
        const ev = e as { type?: string; summary?: string }
        return `${String(ev.type ?? "event")}${ev.summary ? ` — ${ev.summary}` : ""}`.slice(0, 160)
      })
  /** State-correct palette verbs for the selected goal. */
  const paletteVerbs = (): Array<{ key: string; label: string }> => {
    const g = selectedGoal()
    if (!g) return []
    if (g.status === "paused") return [{ key: "r", label: "Resume worker" }]
    if (g.status === "blocked") return [{ key: "R", label: "Retry worker" }, { key: "p", label: "Pause worker" }]
    if (g.status === "complete") return [{ key: "x", label: "Clear (removes goal)" }]
    return [{ key: "p", label: "Pause worker" }, { key: "N", label: "Nudge with full contract" }]
  }
  /** Project context for the coordination drawer: fleet follows the
   * selected row, project tab follows scope, commands tab follows filter. */
  const coordDir = () => {
    if (tab() === "fleet") return selectedDir()
    if (tab() === "commands") return cmdScope() === "all" ? props.directory : cmdScope()
    return projectScope()
  }
  const stateForDir = (dir: string): StoreState | null =>
    dir === props.directory ? state() : (managedStates()[dir] ?? null)
  /** Coordination model built from authoritative store reads only. */
  const coordModel = (): CoordinationModel => {
    const dir = coordDir()
    const st = stateForDir(dir)
    const goals = st?.goals ?? []
    const nameOf = (goalID: string | undefined) =>
      (goalID && goals.find((g) => g.id === goalID)?.name) || (goalID ?? "").slice(0, 8)
    const holds = (st?.writeTickets?.holders ?? []).map((h) => ({
      files: h.files ?? [],
      sessionID: h.sessionID ?? "?",
      goalName: nameOf(h.goalID),
      age: ageText((h as { grantedAt?: string }).grantedAt, clock()),
    }))
    const queue = (st?.writeTickets?.queue ?? []).map((w, i) => {
      const conflict = holds.find((h) => h.files.some((f) => (w.files ?? []).includes(f)))
      return {
        files: w.files ?? [],
        sessionID: w.sessionID ?? "?",
        goalName: nameOf(w.goalID),
        position: i + 1,
        waitsFor: conflict ? `${conflict.goalName} (${conflict.files.join(", ").slice(0, 40)})` : "clearing writes",
        ownerPriority: w.isOwner === true,
      }
    })
    const blockers: CoordinationModel["verifyBlockers"] = []
    const op = (st as unknown as { workspaceOperation?: { id: string; sessionID: string; goalID?: string } } | null)?.workspaceOperation
    if (op) blockers.push({ kind: "operation", text: `operation ${op.id}`, holder: `session ${op.sessionID}${op.goalID ? ` · ${nameOf(op.goalID)}` : ""}` })
    for (const h of holds) blockers.push({ kind: "ticket", text: `ticket on ${h.files.join(", ").slice(0, 60)}`, holder: `${h.goalName} · held ${h.age}` })
    for (const c of (st?.workspaceCalls ?? []).filter((c) => c.uncontrolled)) {
      blockers.push({ kind: "uncontrolled", text: "live shell/command (writes unknown)", holder: `session ${(c.sessionID ?? "").slice(0, 12)}…`, age: ageText(c.at, clock()) })
    }
    for (const c of (st?.workspaceCalls ?? []).filter((c) => (c.paths?.length ?? 0) > 0)) {
      blockers.push({ kind: "legacy", text: `legacy write on ${(c.paths ?? []).join(", ").slice(0, 60)}`, holder: `session ${(c.sessionID ?? "").slice(0, 12)}…`, age: ageText(c.at, clock()) })
    }
    return {
      directory: dir,
      shortName: dir.split("/").pop() || dir,
      holds,
      queue,
      verifyBlockers: blockers,
      verifyNote: blockers.length === 0 ? "quiet — checks can run" : undefined,
      reservations: (st?.workspaceCalls ?? []).map((c) => ({
        callID: c.callID,
        sessionID: c.sessionID ?? "?",
        goalName: nameOf(c.goalID),
        live: true,
        releasable: false,
        reason: "liveness unconfirmed from here — Inspect refreshes from server; release asks the server, refusal names why",
        age: ageText(c.at, clock()),
      })),
    }
  }
  /** Cycle the scope picker: project tab rotates projectScope, commands
   * tab rotates cmdScope (including "all"). Selection resets. */
  function cycleScope(dir: 1 | -1) {
    if (tab() === "commands") {
      const opts = ["all", ...managedDirs()]
      const idx = opts.indexOf(cmdScope())
      setCmdScope(opts[(idx + dir + opts.length) % opts.length]!)
      setCmdSelected(0)
      return
    }
    const dirs = managedDirs()
    if (dirs.length <= 1) { setStatusText("one project managed — :project lists managed dirs"); return }
    const idx = dirs.indexOf(projectScope())
    setProjectScope(dirs[(idx + dir + dirs.length) % dirs.length]!)
    setSelected(0)
  }
  /** Compact scope summary for the header: needs-action / working / awaiting.
   * Completed stay hidden with no giant done count. */
  const scopeSummaryText = () => {
    if (tab() === "commands") {
      const running = ownerCommands().filter((c) => c.status === "running").length
      return `${running} running · ${ownerCommands().length} shown`
    }
    const entries = activeGoals()
    const s = summarizeScope(
      entries.map((e) => e.goal),
      (i) => {
        const rt = runtimeFor(entries[i]!.goal.id) as (GoalRuntimeState & { activeRunID?: string }) | undefined
        return entries[i]!.goal.interactive === true && !!rt && rt.phase === "idle" && !rt.activeRunID
      },
    )
    return summaryText(s)
  }
  const fenceCount = () => state()?.workspaceCalls?.length || 0

  function handleBugReport() {
    const goal = selectedGoal()
    const extra = goal ? `Goal: ${goal.name} (${goal.id.slice(0, 8)}) status=${goal.status} objective=${goal.objective.slice(0, 120)}` : "No goal selected"
    const url = bugReportUrl({ runtimeLabel: `opencode-loopd dashboard`, extra })
    const res = openBrowserUrl(url)
    setStatusText(res.status === "opened" ? "Opening bug report in browser…" : `Could not open browser: ${res.reason} — ${url}`)
  }

  createEffect(() => {
    const rows = rowModels()
    setSelected(Math.max(0, Math.min(selected(), Math.max(0, rows.length - 1))))
    setCmdSelected(Math.max(0, Math.min(cmdSelected(), ownerCommands().length - 1)))
    // Selection follows the filtered row list; resolve back to the goal entry
    // so inspector/actions never target a hidden or stale row.
    const row = rows[selected()] ?? null
    const entry = row ? activeGoals().find((e) => e.goal.id === row.id && e.dir === row.directory) ?? null : null
    setSelectedGoal(entry ? entry.goal : null)
    // Keep keyboard selection glued to the same directory+ID row across
    // refresh/filter/collapse instead of drifting by index.
    const key = entry ? goalSelectionKey(entry.dir, entry.goal.id) : undefined
    if (key !== selectedKey()) {
      const idx = key ? indexForSelectionKey(rows.map((r) => goalSelectionKey(r.directory, r.id)), key) : 0
      if (idx !== selected()) setSelected(idx)
      setSelectedKey(key)
    }
  })
  /** Project directory of the selected worker row. */
  const selectedDir = () => activeGoals()[selected()]?.dir ?? props.directory

  function rowIdFor(goalID: string): string {
    return `loopd-goal-${goalID}`
  }

  return (
    <box flexDirection="column" width="100%" alignItems="center" padding={1}>
      <box flexDirection="column" width="90%" border={true} borderColor={theme().border} padding={1}>
        {/* Header — always visible, vivid (see DashboardHeader: two fixed lines). */}
        <DashboardHeader
          theme={theme()}
          mode={mode()}
          scopeName={tab() === "fleet" ? "All projects" : tab() === "commands" ? "Command sessions" : (projectScope().split("/").pop() || projectScope())}
          summary={scopeSummaryText()}
          tab={tab()}
          projCount={managedDirs().length}
          onBugReport={handleBugReport}
        />

        {/* Scrollable body — the whole frame scrolls (list is capped), so the
            inspector and drawer always stay reachable via j/k or wheel. */}
        <scrollbox ref={(el) => { frameEl = el }} flexDirection="column" flexGrow={1} flexShrink={1} minHeight={0}
          scrollX={false} scrollY={true} stickyScroll={false}>
          {/* Help panel — single text to avoid flex overlap */}
<Show when={showHelp()}>
              <box flexDirection="column" padding={1} border={true} borderColor="yellow" backgroundColor={theme().background} flexShrink={0} maxHeight={22}>
                <box flexDirection="column" padding={1} backgroundColor={theme().background} flexShrink={1} minHeight={0} overflow="scroll">
                  <text>
                <span style={{ fg: "yellow", bold: true }}>{tab() === "commands" ? "━━━ Commands: ? help  : insert  h history  X kill  R restart  x remove-done  o fullscreen  q close ━━━" : "━━━ Keys: 1/2/3 tabs  j/k move  Enter actions  s send  d details  o session  t coordination  / filter  h history  W release  q close ━━━"}</span>
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

          {/* Projects panel — :projects lists managed dirs (registry file + env). */}
          <Show when={showProjects()}>
            <box flexDirection="column" padding={1} border={true} borderColor={theme().border} flexShrink={0} maxHeight={12}>
              <text>
                <span style={{ fg: theme().accent, bold: true }}>⬣ Projects ({managedDirs().length})</span>
                <span style={{ fg: theme().textMuted }}> — :projects to hide · registry .opencode/loopd/managed.json (+ LOOPD_MANAGED_DIRS)</span>
                <For each={projectStatuses() ?? managedDirs().map((d) => ({ directory: d, storePath: managedStorePath(d), total: 0, active: 0, blocked: 0, paused: 0, complete: 0, blockedItems: [] as ManagedDirStatus["blockedItems"] }))}>{(p) => (
                  <>
                    {"\n"}
                    <span style={{ fg: theme().text, bold: true }}>{p.directory}</span>
                    <span style={{ fg: theme().textMuted }}> — {p.total} goals ({p.active} active, {p.blocked} blocked, {p.paused} paused, {p.complete} done)</span>
                    <For each={p.blockedItems.slice(0, 3)}>{(b) => (
                      <>
                        {"\n"}
                        <span style={{ fg: theme().error }}>  ✖ {b.name}: </span>
                        <span style={{ fg: theme().textMuted }}>{b.reason.slice(0, 80)}</span>
                      </>
                    )}</For>
                  </>
                )}</For>
              </text>
            </box>
          </Show>

          {/* Worker tabs: Project (one directory) and Fleet (grouped).
              Toolbar: scope picker state, filter state, history state. */}
          <Show when={tab() === "project" || tab() === "fleet"}>
          <Show when={!panelOpen()}>
          <Show when={rowModels().length > 0} fallback={
            <box flexDirection="column" gap={1} padding={1}>
              <text><span style={{ fg: theme().textMuted }}>No workers{filterText() ? ` matching "${filterText()}"` : ""}.</span><span style={{ fg: theme().accent }}> /goal</span><span style={{ fg: theme().textMuted }}> in parent chat to create one.</span></text>
              <text style={{ fg: theme().textMuted }}>Scope: {tab() === "fleet" ? "all projects" : projectScope()}/.opencode/loopd</text>
              <text><span style={{ fg: theme().textMuted }}>Tip: </span><span style={{ fg: theme().warning }}>s</span><span style={{ fg: theme().textMuted }}> send · </span><span style={{ fg: theme().warning }}>o</span><span style={{ fg: theme().textMuted }}> open child · </span><span style={{ fg: theme().warning }}>t</span><span style={{ fg: theme().textMuted }}> coordination · </span><span style={{ fg: theme().warning }}>/</span><span style={{ fg: theme().textMuted }}> filter.</span></text>
            </box>
          }>
            <text>
              <span style={{ fg: theme().textMuted }}>Scope </span>
              <span style={{ fg: theme().accent, bold: true }}>{tab() === "fleet" ? `all projects (${managedDirs().length})` : (projectScope().split("/").pop() || projectScope())}</span>
              {filterText() && <><span style={{ fg: theme().textMuted }}> · filter </span><span style={{ fg: theme().text }}>"{filterText()}"</span></>}
              <span style={{ fg: theme().textMuted }}> · history {showCompleted() ? "shown" : "hidden"}</span>
              {detailsOpen() && <span style={{ fg: theme().textMuted }}> · detail open — table collapsed to the selected row</span>}
            </text>
            {/* Column header: one line, same fixed geometry as the rows, so a
                reader scans columns instead of decoding each row. */}
            <box flexDirection="row" paddingLeft={3} paddingRight={1} height={1} flexShrink={0}>
              <text wrapMode="none" truncate={true}>
                <span style={{ fg: theme().textMuted }}>{"WORKER".padEnd(22)}│ {"STATE".padEnd(30)}│ ACTIVITY</span>
              </text>
            </box>
            <DashboardList count={displayItems().length} selectedID={rowModels()[selected()] ? rowIdFor(rowModels()[selected()]!.id) : undefined}>
              <For each={displayItems()}>
                {(item) => {
                  if (item.kind === "header") {
                    const g = item.group
                    return (
                      <DashboardRow id={`loopd-group-${g.directory}`} backgroundColor={theme().backgroundElement}>
                        <span style={{ fg: theme().accent, bold: true }}>{collapsed().includes(g.directory) ? "▸" : "▾"} {g.shortName}</span>
                        <span style={{ fg: theme().textMuted }}> / {g.needsAction > 0 ? `${g.needsAction} needs action · ` : "no intervention needed · "}{g.working} working (:collapse toggles)</span>
                      </DashboardRow>
                    )
                  }
                  const row = item.row
                  const isActive = () => item.index === selected()
                  const stateFg = () => row.state === "blocked" ? theme().error : row.state === "active" ? theme().success : row.state === "paused" ? theme().warning : theme().textMuted
                  const attnFg = () => row.attention === "blocker" || row.attention === "unreachable" || row.attention === "stale" || row.attention === "error" ? theme().error : theme().warning
                  // Fixed columns (name / state / activity / updated) keep rows
                  // aligned no matter how long the underlying values are.
                  const cols = () => formatRowColumns(row)
                  return (
                    <DashboardRow id={rowIdFor(row.id)} backgroundColor={isActive() ? theme().backgroundElement : undefined}>
                      {/* Single-line row: name / state / current activity / updated.
                          Full info lives in the inspector + technical drawer. */}
                        <span style={{ fg: stateFg(), bold: isActive() }}>{isActive() ? `▶ ${cols().name}` : `  ${cols().name}`}</span>
                        <span style={{ fg: theme().textMuted }}> │ </span>
                        <span style={{ fg: stateFg(), bold: true }}>{cols().state}</span>
                        <span style={{ fg: theme().textMuted }}> │ </span>
                        <span style={{ fg: row.attention === null ? theme().text : attnFg() }}>{cols().activity}</span>
                        {row.turnText && <span style={{ fg: theme().textMuted }}> · {row.turnText}</span>}
                        <span style={{ fg: theme().textMuted }}> · {cols().updated}</span>
                        {row.attention && row.attentionText && <span style={{ fg: attnFg(), bold: true }}> │ ⚠ {row.attentionText.slice(0, 60)}</span>}
                    </DashboardRow>
                  )
                }}
              </For>
            </DashboardList>
          </Show>

          </Show>

          <Show when={!panelOpen() && selectedGoal()}>
            {(goal) => {
              const entry = () => activeGoals().find((e) => e.goal.id === goal().id)
              const dir = () => entry()?.dir ?? props.directory
              const rt = () => runtimeFor(goal().id)
              const activity = () => rt() ? workerActivityLabel(rt()!, clock()) : undefined
              const lp = () => goal().lastProgress
              const blk = () => goal().blocker
              const agentName = () => goal().config.agent
              const meta = () => agentName() ? (agentIndex()[agentName()!] ?? agentIndex()[agentName()!.toLowerCase()]) : undefined
              const model = () => goal().config.model
              return (<>
                <GoalInspector
                  theme={theme()}
                  model={{
                    goal: goal(),
                    directory: dir(),
                    activityLine: activity() ? `${activity()!.short} — ${activity()!.hint}` : undefined,
                    acting: activity()?.acting ?? false,
                    lastResult: lp()?.summary,
                    blocked: blk() ? { reason: blk()!.reason, needed: blk()!.needed } : undefined,
                    lastProgress: lp() ?? undefined,
                    agentMeta: meta()?.mode,
                    showFocusProject: tab() === "fleet",
                  }}
                  onSend={() => { setCommandInput("send "); if (inputEl) inputEl.value = "send "; setMode("insert"); focusInput() }}
                  onOpen={() => { if (goal().workerSessionID) { try { props.api.route.navigate("session", { sessionID: goal().workerSessionID }); props.api.ui.dialog.clear() } catch { setStatusText("Navigate unsupported here — read the transcript via agent tools (read_goal_transcript).") } } else setStatusText("No worker session") }}
                  onActions={() => setActionsOpen(true)}
                  onDetails={() => setDetailsOpen((v) => !v)}
                  onFocusProject={() => { setProjectScope(dir()); setTab("project"); setSelected(0); setStatusText(`scope: ${dir()}`) }}
                />
                <Show when={detailsOpen()}>
                  <GoalDetailsDrawer
                    theme={theme()}
                    model={{
                      goal: goal(),
                      runtime: rt(),
                      transcript: recentTranscriptFor(goal().id),
                      progressHistory: lp() ? [{ summary: lp()!.summary, next: lp()!.next, at: lp()!.at }] : [],
                      agentLabel: agentName() ? `${agentName()!}${meta()?.mode ? ` (${meta()!.mode})` : ""}` : (goal().parentAgent ?? "parent"),
                      modelLabel: model() ?? goal().parentModel ?? "parent",
                    }}
                  />
                </Show>
              </>)
            }}
          </Show>

          {/* Actions palette — state-correct verbs for the selected goal.
              The palette lists; existing keys act (no new interaction risk). */}
          <Show when={actionsOpen() && selectedGoal()}>
            <box flexDirection="column" border={true} borderColor={theme().accent} padding={1} flexShrink={0} maxHeight={10}>
              <text>
                <span style={{ fg: theme().accent, bold: true }}>Actions / {selectedGoal()!.name}</span>
                <span style={{ fg: theme().textMuted }}> — press the key, Esc closes</span>
                <For each={paletteVerbs()}>{(v) => (
                  <><span style={{ fg: theme().warning, bold: true }}>{"\n"}[{v.key}] </span><span style={{ fg: theme().text }}>{v.label}</span></>
                )}</For>
                {"\n"}<span style={{ fg: theme().textMuted }}>[s] Send · [o] Open session · [d] Technical details</span>
              </text>
            </box>
          </Show>

          {/* Coordination drawer — project-scoped triage (see coordination-panel.tsx). */}
          <Show when={coordOpen()}>
            <CoordinationPanel
              theme={theme()}
              model={coordModel()}
              tab={coordTab()}
              onTab={(t) => setCoordTab(t)}
              onInspectReservations={() => void releaseWorkspaceFences({}, coordDir())}
              onRelease={(callID) => setPendingRelease({ callID, dir: coordDir() })}
              onOpenSession={() => { const g = selectedGoal(); if (g?.workerSessionID) { try { props.api.route.navigate("session", { sessionID: g.workerSessionID }); props.api.ui.dialog.clear() } catch { setStatusText("Navigate unsupported here.") } } }}
            />
          </Show>
          <Show when={pendingRelease()}>
            <box flexDirection="column" border={true} borderColor={theme().error} padding={1} flexShrink={0}>
              <text>
                <span style={{ fg: theme().error, bold: true }}>Release {pendingRelease()!.callID.slice(0, 12)}… in {pendingRelease()!.dir}?</span>
                <span style={{ fg: theme().textMuted }}> — server decides; refusal names the reason. </span>
                <span style={{ fg: theme().warning, bold: true }}>[y] release · [Esc] cancel</span>
              </text>
            </box>
          </Show>

          </Show>

          {/* Commands tab — owner-scoped sessions. `o` opens the fullscreen
              terminal route; goal controls never apply here. */}
          <Show when={tab() === "commands"}>
            <text>
              <span style={{ fg: theme().textMuted }}>Scope: </span>
              <span style={{ fg: theme().accent, bold: true }}>{cmdScope() === "all" ? `all projects (${managedDirs().length})` : (cmdScope().split("/").pop() || cmdScope())}</span>
              <span style={{ fg: theme().textMuted }}> · history: {showCompleted() ? "shown (h to hide)" : "hidden (h to show)"} · :project :history · [ ] cycle scope</span>
            </text>
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
                          {managedDirs().length > 1 && <><span style={{ fg: theme().textMuted }}> │ </span><span style={{ fg: theme().accent }}>⬣ {commandDir(cmd.id).split("/").pop() ?? commandDir(cmd.id)}</span></>}
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
        </scrollbox>

        {/* Input — always visible at bottom, vivid mode badge */}
        <box ref={(el) => { hintBoxEl = el as unknown as { width?: number } }} flexDirection="row" border={true} borderColor={mode() === "insert" ? theme().warning : theme().border} paddingLeft={1} paddingRight={1} flexShrink={0} height={3} gap={1}>
          <text>
            <span style={{ fg: mode() === "insert" ? theme().warning : theme().success, bold: true, bg: mode() === "insert" ? (theme().backgroundElement as unknown as string) : undefined }}>{mode() === "insert" ? " INSERT " : " NORMAL "}</span>
          </text>
          <input
            ref={(el: InputRenderable) => { inputEl = el; focusInput() }}
            flexGrow={1}
            placeholder={mode() === "insert" ? ":send hello  or  :filter text  or  :project name  (Ctrl+N: normal)" : statusText() || fitHintBar(FOOT_HINTS, hintCols())}
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
