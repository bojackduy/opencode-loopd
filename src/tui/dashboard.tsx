// ─── TUI: Dashboard Component ────────────────────────────────────────────────
// Mirrors docs/superpowers/prototypes/2026-11-01-dashboard.html:
//   1. Header (LOOPD + project + [Bug Report])
//   2. Nav tabs ([1] Project / [2] Fleet / [3] Commands, filled cyan active)
//   3. Summary + Toolbar (project picker, visible / filter input, [h] history)
//   4. 4-column Worker table (Worker | State | Current activity | Updated)
//      — collapses to 1 row when [d] Details is open; j/k still walks all rows
//   5. Selected Worker Inspector + optional Technical Details drawer
//   6. Coordination strip (#coordstrip) right above Footer
//   7. Modal popups for [Enter] Actions, [s] Send input, [t] Coordination, [?] Help
//      where Esc closes ONLY the active popup/filter/details, never the whole UI.

/** @jsxImportSource @opentui/solid */
import { batch, createSignal, For, Show, onCleanup, onMount, createEffect, type JSX } from "solid-js"
import { useKeyboard } from "@opentui/solid"
import type { TuiPluginApi, TuiThemeCurrent } from "@opencode-ai/plugin/tui"
import type { InputRenderable, ParsedKey, ScrollBoxRenderable, TextRenderable } from "@opentui/core"
import { readState } from "../infrastructure/state-repository"
import { createControlClient } from "../infrastructure/control-client"
import type { StoreState } from "../infrastructure/state-repository"
import type { Goal } from "../domain/goal"
import type { GoalRuntimeState } from "../domain/runtime"
import { parseCommand } from "./command-parser"
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
  PALETTE,
  ROW_COLS,
  toRowModel,
  summarizeScope,
  summaryText,
  groupByDirectory,
  filterRows,
  ageText,
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

// ─── Sub-popup Escape coordinator (shared with plugin.tsx) ──────────────────
// OpenCode's host dialog closes on Esc unless intercepted. Whenever a child
// popup/drawer/input is open, tryDismissDashboardSubPopup() consumes Esc and
// closes only that child; plugin.tsx also checks this in onClose so even a
// host-level dialog clear immediately re-mounts the dashboard at the same state.

export interface SavedDashboardState {
  tab: DashboardView
  selected: number
  cmdSelected: number
  projectScope: string
  cmdScope: string
  filterText: string
  showCompleted: boolean
  detailsOpen: boolean
}

let activeSubPopupDismiss: (() => boolean) | undefined
let lastDashboardState: SavedDashboardState | undefined

export function tryDismissDashboardSubPopup(): boolean {
  try {
    return activeSubPopupDismiss?.() === true
  } catch {
    return false
  }
}

export function getSavedDashboardState(): SavedDashboardState | undefined {
  return lastDashboardState
}

function prevent(evt: ParsedKey) {
  const e = evt as ParsedKey & { preventDefault?: () => void; stopPropagation?: () => void }
  e.preventDefault?.()
  e.stopPropagation?.()
}

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
type InsertKind = "colon" | "filter" | "send"

interface Props {
  api: TuiPluginApi
  directory: string
  initialView?: DashboardView | "goals"
  ownerSessionID?: string
  onOpenCommand?: (payload: { commandID: string; ownerSessionID: string; returnSessionID: string }) => void
  isActive?: () => boolean
  restoredState?: SavedDashboardState
}

function normalizeInitialView(view: DashboardView | "goals" | undefined): DashboardView {
  if (view === "goals") return "project"
  return view ?? "project"
}

function commandStatusColor(status: CommandSession["status"]): string {
  switch (status) {
    case "running": return PALETTE.cyan
    case "exited": return PALETTE.muted
    case "terminated": return PALETTE.amber
    case "missing": return PALETTE.rose
    default: return PALETTE.ink
  }
}
function commandStatusIcon(status: CommandSession["status"]): string {
  switch (status) {
    case "running": return "●"
    case "exited": return "✓"
    case "terminated": return "■"
    case "missing": return "!"
    default: return "○"
  }
}
function commandStatusLabel(status: CommandSession["status"]): { short: string; hint: string } {
  switch (status) {
    case "running": return { short: "running", hint: "process is executing" }
    case "exited": return { short: "exited", hint: "process ended on its own" }
    case "terminated": return { short: "terminated", hint: "stopped via interrupt/terminate" }
    case "missing": return { short: "missing", hint: "no live execution found" }
    default: return { short: String(status), hint: "" }
  }
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

function DashboardList(props: { count: number; maxRows?: number; selectedID?: string; children: JSX.Element }) {
  let scroll: ScrollBoxRenderable | undefined
  let followPending = true
  createEffect(() => {
    props.count
    props.selectedID
    followPending = true
    scroll?.requestRender()
  })
  const rows = () => Math.max(1, Math.min(props.count, props.maxRows ?? 6))
  return (
    <scrollbox
      ref={(el) => { scroll = el }}
      height={rows()}
      scrollX={false}
      scrollY={true}
      stickyScroll={false}
      renderAfter={() => {
        if (!followPending || !scroll) return
        followPending = false
        if (props.selectedID) scroll.scrollChildIntoView(props.selectedID)
      }}
    >
      {props.children}
    </scrollbox>
  )
}

/** Never set truncate={true} on multi-column rows: OpenTUI's native truncate
 * places "..." in the middle of the string, mangling the State column. Each
 * column is already width-bounded by formatRowColumns(). */
function DashboardRow(props: { id: string; backgroundColor?: string; onClick?: () => void; children: JSX.Element }) {
  let text: TextRenderable | undefined
  return (
    <box
      id={props.id}
      flexDirection="row"
      paddingLeft={1}
      paddingRight={1}
      height={1}
      flexShrink={0}
      overflow="hidden"
      backgroundColor={props.backgroundColor}
      onMouseScroll={() => { if (text) { text.scrollX = 0; text.scrollY = 0 } }}
      {...(props.onClick ? ({ onMouseDown: props.onClick } as any) : {})}
    >
      <text ref={(el) => { text = el }} wrapMode="none">
        {props.children}
      </text>
    </box>
  )
}

/** Header + navigation tabs modeled directly after the web prototype:
 *  Line 1: LOOPD + active project + [Bug Report]
 *  Line 2: [1] Project | [2] Fleet | [3] Commands (filled cyan active tab) */
export function DashboardHeader(props: {
  theme: TuiThemeCurrent
  mode: string
  scopeName: string
  summary: string
  tab: "project" | "fleet" | "commands"
  projCount: number
  onBugReport: () => void
  onSelectTab?: (tab: "project" | "fleet" | "commands") => void
}): JSX.Element {
  const tabBtn = (id: "project" | "fleet" | "commands", num: string, label: string) => {
    const active = () => props.tab === id
    return (
      <box
        flexDirection="row"
        backgroundColor={active() ? PALETTE.cyan : PALETTE.inset}
        paddingLeft={2}
        paddingRight={2}
        height={1}
        {...({ onMouseDown: () => props.onSelectTab?.(id) } as any)}
      >
        <text wrapMode="none">
          <span style={{ fg: active() ? PALETTE.tabActiveFg : PALETTE.rule }}>[{num}] </span>
          <span style={{ fg: active() ? PALETTE.tabActiveFg : PALETTE.muted, bold: active() }}>{label}</span>
        </text>
      </box>
    )
  }
  return (
    <box flexDirection="column" flexShrink={0} backgroundColor={PALETTE.inset}>
      <box
        flexDirection="row"
        justifyContent="space-between"
        alignItems="center"
        paddingLeft={2}
        paddingRight={2}
        height={1}
        flexShrink={0}
      >
        <text wrapMode="none">
          <span style={{ fg: PALETTE.cyan, bold: true }}>LOOPD</span>
          <span style={{ fg: PALETTE.muted }}>   </span>
          <span style={{ fg: PALETTE.ink }}>{props.scopeName}</span>
          <span style={{ fg: PALETTE.muted }}>   [{props.projCount} project{props.projCount === 1 ? "" : "s"}]</span>
        </text>
        <box
          flexDirection="row"
          backgroundColor={PALETTE.base}
          paddingLeft={1}
          paddingRight={1}
          {...({ onMouseDown: props.onBugReport } as any)}
        >
          <text wrapMode="none">
            <span style={{ fg: PALETTE.muted }}>[Bug Report]</span>
          </text>
        </box>
      </box>
      <box
        flexDirection="row"
        justifyContent="space-between"
        alignItems="center"
        paddingLeft={1}
        paddingRight={2}
        height={1}
        flexShrink={0}
      >
        <box flexDirection="row" gap={1} alignItems="center">
          {tabBtn("project", "1", "Project")}
          {tabBtn("fleet", "2", "Fleet")}
          {tabBtn("commands", "3", "Commands")}
        </box>
        <text wrapMode="none">
          <span style={{ fg: props.mode === "normal" ? PALETTE.muted : PALETTE.amber, bold: props.mode !== "normal" }}>
            {props.mode.toUpperCase()}
          </span>
        </text>
      </box>
    </box>
  )
}

export function LoopDashboard(props: Props) {
  const theme = () => props.api.theme.current
  const initial = props.restoredState
  const [mode, setMode] = createSignal<Mode>("normal")
  const [insertKind, setInsertKind] = createSignal<InsertKind>("colon")
  const [selected, setSelected] = createSignal(initial?.selected ?? 0)
  const [commandInput, setCommandInput] = createSignal("")
  const [statusText, setStatusText] = createSignal("")
  const [tab, setTab] = createSignal<DashboardView>(initial?.tab ?? normalizeInitialView(props.initialView))
  const [cmdSelected, setCmdSelected] = createSignal(initial?.cmdSelected ?? 0)
  const [projectScope, setProjectScope] = createSignal<string>(initial?.projectScope ?? props.directory)
  const [cmdScope, setCmdScope] = createSignal<string>(initial?.cmdScope ?? "all")
  const [filterText, setFilterText] = createSignal(initial?.filterText ?? "")
  const [collapsed, setCollapsed] = createSignal<string[]>([])
  const [coordOpen, setCoordOpen] = createSignal(false)
  const [coordTab, setCoordTab] = createSignal<CoordinationTab>("writes")
  const [detailsOpen, setDetailsOpen] = createSignal(initial?.detailsOpen ?? false)
  const [actionsOpen, setActionsOpen] = createSignal(false)
  const [actionIdx, setActionIdx] = createSignal(0)
  const [sendOpen, setSendOpen] = createSignal(false)
  const [selectedKey, setSelectedKey] = createSignal<string | undefined>(undefined)
  const [pendingRelease, setPendingRelease] = createSignal<{ callID: string; dir: string } | null>(null)
  const ownerSessionID = () => props.ownerSessionID ?? currentRouteSessionID(props.api)

  let detailsScrollEl: ScrollBoxRenderable | undefined
  let coordScrollEl: ScrollBoxRenderable | undefined

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
    const base = showCompleted()
      ? owned.map(({ cmd }) => cmd)
      : owned.filter(({ cmd }) => !["exited", "terminated", "missing"].includes(cmd.status)).map(({ cmd }) => cmd)
    const q = filterText().trim().toLowerCase()
    if (!q) return base
    return base.filter((c) => `${c.title} ${c.command} ${c.args.join(" ")} ${c.status}`.toLowerCase().includes(q))
  }
  const commandDir = (commandID: string): string => {
    const hit = commandEntries().find(({ cmd }) => cmd.id === commandID)
    return hit ? hit.dir : props.directory
  }
  const hiddenFinishedCommands = () => {
    if (showCompleted()) return 0
    const terminal = ["exited", "terminated", "missing"]
    return (state()?.commands ?? []).filter(
      (c) => c.ownerSessionID === ownerSessionID() && terminal.includes(c.status),
    ).length
  }
  const [state, setState] = createSignal<StoreState | null>(null)
  const [hintCols, setHintCols] = createSignal(84)
  let hintBoxEl: { width?: number } | undefined
  createEffect(() => {
    clock()
    const w = hintBoxEl?.width
    if (typeof w === "number" && w > 0) {
      const cols = Math.max(24, Math.floor(w) - 6)
      if (cols !== hintCols()) setHintCols(cols)
    }
  })
  const [events, setEvents] = createSignal<Record<string, unknown>[]>([])
  const [selectedGoal, setSelectedGoal] = createSignal<Goal | null>(null)
  const [showLogs, setShowLogs] = createSignal(false)
  const [showHelp, setShowHelp] = createSignal(false)
  const [showCompleted, setShowCompleted] = createSignal(initial?.showCompleted ?? false)
  const [clock, setClock] = createSignal(Date.now())
  const [agentIndex, setAgentIndex] = createSignal<Record<string, AgentMeta>>({})
  const [managedDirList, setManagedDirList] = createSignal<string[]>([props.directory])
  const managedDirs = () => managedDirList()
  const [projectStatuses, setProjectStatuses] = createSignal<ManagedDirStatus[] | null>(null)
  const [showProjects, setShowProjects] = createSignal(false)
  const [managedStates, setManagedStates] = createSignal<Record<string, StoreState>>({})

  // Persist view state so an Escape-intercepted remount restores seamlessly.
  createEffect(() => {
    lastDashboardState = {
      tab: tab(),
      selected: selected(),
      cmdSelected: cmdSelected(),
      projectScope: projectScope(),
      cmdScope: cmdScope(),
      filterText: filterText(),
      showCompleted: showCompleted(),
      detailsOpen: detailsOpen(),
    }
  })

  async function refreshProjects() {
    try {
      setManagedDirList(await resolveManagedDirs(props.directory))
      setProjectStatuses(await statusAll(managedDirs()))
      const states: Record<string, StoreState> = {}
      for (const dir of managedDirs()) {
        if (dir === props.directory) continue
        try {
          states[dir] = await readState(dir)
        } catch {}
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
      // Insert mode owns the cursor: focus so keystrokes land in the box.
      // Normal mode blurs it so no stray block cursor blinks at the corner.
      if (mode() === "insert") {
        const current = props.api.renderer.currentFocusedRenderable
        if (current && current !== inputEl) current.blur()
        inputEl?.focus()
      } else {
        inputEl?.blur()
      }
    }, 10)
  }

  function enterInsertMode(kind: InsertKind, initialValue = "") {
    setInsertKind(kind)
    setCommandInput(initialValue)
    if (inputEl) inputEl.value = initialValue
    setMode("insert")
    focusInput()
  }

  function returnToNormalMode() {
    setCommandInput("")
    if (inputEl) inputEl.value = ""
    setSendOpen(false)
    setMode("normal")
    focusInput()
  }

  function openSendModal() {
    if (!selectedGoal() && tab() !== "commands") {
      setStatusText("No worker selected")
      return
    }
    setActionsOpen(false)
    setCoordOpen(false)
    setShowHelp(false)
    setSendOpen(true)
    enterInsertMode("send", "")
  }

  function openFilterBox() {
    setActionsOpen(false)
    setCoordOpen(false)
    setSendOpen(false)
    enterInsertMode("filter", filterText())
  }

  /** Dismiss the topmost child popup/drawer/input. Returns true if something
   * was closed, false when the dashboard is already at the base view. */
  function dismissTopSubPopup(): boolean {
    if (pendingRelease()) { setPendingRelease(null); return true }
    if (sendOpen()) { returnToNormalMode(); return true }
    if (actionsOpen()) { setActionsOpen(false); return true }
    if (coordOpen()) { setCoordOpen(false); focusInput(); return true }
    if (showHelp()) { setShowHelp(false); return true }
    if (showProjects()) { setShowProjects(false); return true }
    if (mode() === "insert") {
      if (insertKind() === "filter") setFilterText("")
      returnToNormalMode()
      return true
    }
    if (detailsOpen()) { setDetailsOpen(false); return true }
    if (filterText()) { setFilterText(""); setStatusText("filter cleared"); return true }
    return false
  }

  activeSubPopupDismiss = dismissTopSubPopup

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
    } catch {}
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
    if (activeSubPopupDismiss === dismissTopSubPopup) activeSubPopupDismiss = undefined
    refreshQueue.dispose()
    popMode()
    if (focusTimer) clearTimeout(focusTimer)
    for (const u of unsubs) typeof u === "function" ? u() : clearInterval(u as unknown as number)
  })

  onMount(() => {
    focusInput()
  })
  createEffect(() => { mode(); focusInput() })

  /** State-correct palette verbs for the selected goal (also used by Enter popup). */
  const paletteVerbs = (): Array<{ key: string; cmd: string; label: string }> => {
    const g = selectedGoal()
    if (!g) return []
    const list: Array<{ key: string; cmd: string; label: string }> = []
    if (g.status === "paused") list.push({ key: "r", cmd: "resume", label: "Resume worker" })
    else if (g.status === "blocked") {
      list.push({ key: "R", cmd: "retry", label: "Retry worker" })
      list.push({ key: "p", cmd: "pause", label: "Pause worker" })
    } else if (g.status === "complete") {
      list.push({ key: "x", cmd: "clear", label: "Clear completed goal" })
    } else {
      list.push({ key: "p", cmd: "pause", label: "Pause worker" })
      list.push({ key: "N", cmd: "nudge", label: "Nudge with full contract" })
      list.push({ key: "A", cmd: "abort", label: "Abort current turn only" })
    }
    list.push({ key: "s", cmd: "__send__", label: "Send bare input to worker" })
    list.push({ key: "o", cmd: "open", label: "Open worker session transcript" })
    list.push({ key: "m", cmd: "interactive", label: g.interactive ? "Switch to autonomous turns" : "Switch to manual (await input)" })
    list.push({ key: "Esc", cmd: "__cancel__", label: "Cancel" })
    return list
  }

  async function runPaletteVerb(item: { key: string; cmd: string; label: string }) {
    setActionsOpen(false)
    if (item.cmd === "__cancel__") return
    if (item.cmd === "__send__") { openSendModal(); return }
    await executeCommand(item.cmd)
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
    const isColon = name === ":" || seq === ":" || raw === ":" || name === "colon"
    const isQuestion = name === "?" || seq === "?" || raw === "?"

    // Insert mode (Send modal, Filter box, or :command bar)
    if (mode() === "insert") {
      if (isEscapeKey(evt) || isCtrlN(evt)) {
        prevent(evt)
        if (insertKind() === "filter") setFilterText("")
        returnToNormalMode()
        return
      }
      if (isEnterKey(evt)) {
        prevent(evt)
        const val = commandInput().trim()
        const kind = insertKind()
        if (kind === "filter") {
          setFilterText(val)
          setStatusText(val ? `filter: "${val}"` : "filter cleared")
          returnToNormalMode()
          return
        }
        if (kind === "send") {
          returnToNormalMode()
          if (!val) return
          if (tab() === "commands") {
            void executeCommand(val)
          } else {
            void executeCommand(`send ${val}`)
          }
          return
        }
        void executeCommand(val)
        return
      }
      return
    }

    const key = raw || seq || name

    // 1. Release confirmation modal
    if (pendingRelease()) {
      if (key === "y" || isEnterKey(evt)) {
        prevent(evt)
        const target = pendingRelease()!
        setPendingRelease(null)
        void releaseWorkspaceFences({ callID: target.callID }, target.dir)
        return
      }
      if (isEscapeKey(evt) || key === "n") {
        prevent(evt)
        setPendingRelease(null)
        return
      }
      return
    }

    // 2. Actions popup modal (j/k + Enter + hotkeys + Esc)
    if (actionsOpen()) {
      const verbs = paletteVerbs()
      if (isEscapeKey(evt)) { prevent(evt); setActionsOpen(false); return }
      if (name === "down" || key === "j") {
        prevent(evt)
        setActionIdx((i) => Math.min(verbs.length - 1, i + 1))
        return
      }
      if (name === "up" || key === "k") {
        prevent(evt)
        setActionIdx((i) => Math.max(0, i - 1))
        return
      }
      if (isEnterKey(evt)) {
        prevent(evt)
        const chosen = verbs[actionIdx()]
        if (chosen) void runPaletteVerb(chosen)
        return
      }
      const match = verbs.find((v) => v.key === key)
      if (match) {
        prevent(evt)
        void runPaletteVerb(match)
        return
      }
      return
    }

    // 3. Coordination drawer modal (j/k scrolls, w/v/r or 1/2/3 or Tab switches sub-tab, W releases, Esc closes)
    if (coordOpen()) {
      if (isEscapeKey(evt) || key === "t") {
        prevent(evt)
        setCoordOpen(false)
        focusInput()
        return
      }
      if (name === "down" || key === "j") {
        prevent(evt)
        coordScrollEl?.scrollBy({ x: 0, y: 2 })
        return
      }
      if (name === "up" || key === "k") {
        prevent(evt)
        coordScrollEl?.scrollBy({ x: 0, y: -2 })
        return
      }
      if (key === "g") { prevent(evt); coordScrollEl?.scrollTo(0); return }
      if (key === "G") { prevent(evt); coordScrollEl?.scrollTo(9999); return }
      if (key === "w" || key === "1") { prevent(evt); setCoordTab("writes"); return }
      if (key === "v" || key === "2") { prevent(evt); setCoordTab("verify"); return }
      if (key === "r" || key === "3") { prevent(evt); setCoordTab("resv"); return }
      if (name === "tab" || name === "right") {
        prevent(evt)
        setCoordTab((t) => (t === "writes" ? "verify" : t === "verify" ? "resv" : "writes"))
        return
      }
      if (name === "left") {
        prevent(evt)
        setCoordTab((t) => (t === "resv" ? "verify" : t === "verify" ? "writes" : "resv"))
        return
      }
      if (key === "W") {
        prevent(evt)
        const first = coordModel().reservations[0]
        if (first) setPendingRelease({ callID: first.callID, dir: coordDir() })
        else void releaseWorkspaceFences({}, coordDir())
        return
      }
      return
    }

    // 4. Technical details popup modal (j/k scrolls, n/p switches worker, d or Esc closes)
    if (detailsOpen()) {
      if (isEscapeKey(evt) || key === "d") {
        prevent(evt)
        setDetailsOpen(false)
        return
      }
      if (name === "down" || key === "j" || key === "J" || name === "pagedown") {
        prevent(evt)
        detailsScrollEl?.scrollBy({ x: 0, y: 2 })
        return
      }
      if (name === "up" || key === "k" || key === "K" || name === "pageup") {
        prevent(evt)
        detailsScrollEl?.scrollBy({ x: 0, y: -2 })
        return
      }
      if (key === "g") { prevent(evt); detailsScrollEl?.scrollTo(0); return }
      if (key === "G") { prevent(evt); detailsScrollEl?.scrollTo(9999); return }
      if (key === "n" || key === "]") {
        prevent(evt)
        const max = Math.max(0, rowModels().length - 1)
        setSelected((s) => Math.min(max, s + 1))
        return
      }
      if (key === "p" || key === "[") {
        prevent(evt)
        setSelected((s) => Math.max(0, s - 1))
        return
      }
      return
    }

    // 5. Help or Projects popup
    if (showHelp()) {
      if (isEscapeKey(evt) || isQuestion || key === "q") {
        prevent(evt)
        setShowHelp(false)
        return
      }
      return
    }
    if (showProjects()) {
      if (isEscapeKey(evt) || key === "q") {
        prevent(evt)
        setShowProjects(false)
        return
      }
    }

    // 6. Escape in base view clears Filter before closing dialog
    if (isEscapeKey(evt)) {
      if (dismissTopSubPopup()) {
        prevent(evt)
        return
      }
      return
    }

    if (isColon) { prevent(evt); enterInsertMode("colon", ""); return }
    if (isQuestion) { prevent(evt); setShowHelp((v) => !v); return }

    if (tab() === "commands" && Boolean(evt.ctrl) && name === "c") {
      prevent(evt)
      const sel = selectedCommand()
      if (!sel) { setStatusText("No command selected."); return }
      void executeCommandRaw("cmd_interrupt", { commandID: sel.id }, sel.id)
      return
    }
    if (key === "h") {
      prevent(evt)
      setShowCompleted((v) => {
        const next = !v
        setStatusText(next ? "History shown" : "History hidden")
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
      const next = moveDashboardSelection(dashboardSelection(), move, currentGoals.length, currentCommands.length)
      setSelected(next.goalIndex)
      setCmdSelected(next.commandIndex)
    }
    if (name === "down" || key === "j") { prevent(evt); applyMove("down"); return }
    if (name === "up" || key === "k") { prevent(evt); applyMove("up"); return }
    if (key === "g") { prevent(evt); applyMove("first"); return }
    if (key === "G") { prevent(evt); applyMove("last"); return }

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
    if (tab() === "commands" && ["p", "r", "A", "N"].includes(key)) {
      prevent(evt)
      setStatusText(`Key "${key}" is a Worker control — switch to [1] Project or [2] Fleet.`)
      return
    }
    if (key === "p") { prevent(evt); void executeCommand("pause"); return }
    if (key === "r") { prevent(evt); void executeCommand("resume"); return }
    if (key === "R") { prevent(evt); void executeCommand("retry"); return }
    if (key === "x") { prevent(evt); void executeCommand("clear"); return }
    if (key === "A") { prevent(evt); void executeCommand("abort"); return }
    if (key === "N") { prevent(evt); void executeCommand("nudge"); return }
    if (key === "/") {
      prevent(evt)
      openFilterBox()
      return
    }
    if (key === "d") { prevent(evt); setDetailsOpen((v) => !v); return }
    if (key === "t") { prevent(evt); setCoordOpen((v) => !v); return }
    if (key === "s") {
      prevent(evt)
      openSendModal()
      return
    }
    if (key === "f" && tab() === "fleet" && selectedGoal()) {
      prevent(evt)
      const dir = selectedDir()
      setProjectScope(dir)
      setTab("project")
      setSelected(0)
      setStatusText(`scope: ${dir.split("/").pop() || dir}`)
      return
    }
    if (isEnterKey(evt)) {
      prevent(evt)
      if (tab() === "commands") {
        openSendModal()
        return
      }
      setActionIdx(0)
      setActionsOpen(true)
      return
    }
    if (key === "[") { prevent(evt); cycleScope(-1); return }
    if (key === "]") { prevent(evt); cycleScope(1); return }
    if (key === "W") {
      prevent(evt)
      if (fenceCount() === 0) {
        setStatusText("No workspace fences to release.")
        return
      }
      const goal = selectedGoal()
      void releaseWorkspaceFences(goal ? { goalID: goal.id } : {}, goal ? goalDir(goal.id) : undefined)
      return
    }
    if (key === "L") { prevent(evt); setShowLogs((value) => !value); return }
    if (key === "o") {
      prevent(evt)
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
              : "Nothing to open.",
        )
      }
      return
    }
    if (key === "B") { prevent(evt); handleBugReport(); return }
    if (key === "q") { prevent(evt); props.api.ui.dialog.clear(); return }
  })

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

  async function releaseWorkspaceFences(selection: { callID?: string; goalID?: string; sessionID?: string }, dir?: string) {
    const owner = ownerSessionID()
    if (!owner) {
      setStatusText("No owning session — release disabled.")
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
      setStatusText(`"${sel.title}" is still running — X force kill · :terminate graceful.`)
      return
    }
    void executeCommandRaw("cmd_remove", { commandID: sel.id }, sel.id)
  }

  async function executeCommandTabCommand(verb: string, _positional: string[], raw: string) {
    switch (verb) {
      case "model": case "models": case "agent": case "agents":
        setStatusText(`:${verb} is only available on the Project / Fleet tabs.`)
        return
      case "new": {
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
        return
      }
      default: {
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
    if (tab() === "commands" && !["q", "close", "filter", "project", "history"].includes(parsed.command)) {
      await executeCommandTabCommand(parsed.command, parsed.positional, parsed.raw)
      returnToNormalMode()
      return
    }
    const verbDir = selectedGoal() ? goalDir(selectedGoal()!.id) : props.directory
    const bus = clientFor(verbDir)
    if (!["help", "logs", "q", "close", "filter", "project", "history", "collapse", "focus"].includes(parsed.command)) {
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
          if (!match) { setStatusText(`Unknown project "${name}"`); break }
          if (tab() === "commands") setCmdScope(match)
          else setProjectScope(match)
          setSelected(0)
          setStatusText(`scope: ${match.split("/").pop() || match}`)
          break
        }
        case "collapse": {
          const name = parsed.positional.join(" ").trim()
          const dir = name
            ? managedDirs().find((d) => d === name || d.split("/").pop() === name) ?? selectedDir()
            : selectedDir()
          setCollapsed((list) => toggleCollapsed(list, dir))
          break
        }
        case "focus": {
          const dir = selectedDir()
          setProjectScope(dir)
          setTab("project")
          setSelected(0)
          setFilterText("")
          setStatusText(`scope: ${dir.split("/").pop() || dir}`)
          break
        }
        case "history": {
          setShowCompleted((v) => !v)
          setStatusText(showCompleted() ? "History shown" : "History hidden")
          break
        }
        case "send": {
          if (!selectedGoal()) { setStatusText("No goal selected"); break }
          const message = parsed.positional.join(" ") || parsed.args.message || ""
          if (!message) { openSendModal(); return }
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
            setStatusText("Navigate unsupported here — read transcript via read_goal_transcript.")
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
          if (!agent) { setStatusText("Usage: :agent <name>"); break }
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
          if (!target) { setStatusText("Usage: :model <provider/model>"); break }
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
        case "goal": { setStatusText("Create goals via /goal in parent chat."); break }
        case "bug":
        case "report": { handleBugReport(); break }
        case "logs": setShowLogs(!showLogs()); break
        case "help": setShowHelp(true); break
        case "projects": {
          setShowProjects(!showProjects())
          if (showProjects()) await refreshProjects()
          break
        }
        case "q": case "close": props.api.ui.dialog.clear(); return
        default: {
          if (parsed.command && selectedGoal()) {
            const message = parsed.raw
            const r = await bus.execute({ version: 1, requestID: randomUUID(), requestedAt: new Date().toISOString(), command: "send", goalID: selectedGoal()!.id, args: { message } })
            setStatusText(r.ok ? `sent: ${message.slice(0, 60)}` : `Error: ${r.message}`); if (r.ok) await refresh()
          } else setStatusText(`Unknown: ${parsed.command}. ? for help`)
        }
      }
    } catch (e) { setStatusText(`Error: ${e instanceof Error ? e.message : String(e)}`) }
    returnToNormalMode()
  }

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

  const activeFilterQuery = () =>
    mode() === "insert" && insertKind() === "filter" ? commandInput() : filterText()

  const rowModels = (): RowModel[] => {
    const now = clock()
    const rows = activeGoals().map(({ goal, dir }) => toRowModel(goal, dir, runtimeFor(goal.id), now))
    return filterRows(rows, activeFilterQuery())
  }

  /** Modal popups take the main body so they behave like real dialogs and
   * never stretch or clip the dashboard vertically. Details (`d`) is also a
   * full popup view now so the worker table never has to collapse to 1 row. */
  const modalPopupOpen = () =>
    Boolean(pendingRelease()) || sendOpen() || actionsOpen() || coordOpen() || detailsOpen() || showHelp() || showProjects()

  const displayItems = (): Array<{ kind: "header"; dir: string; group: DirectoryGroup } | { kind: "row"; row: RowModel; index: number }> => {
    const rows = rowModels()
    if (tab() !== "fleet") {
      return rows.map((row, index) => ({ kind: "row" as const, row, index }))
    }
    const out: Array<{ kind: "header"; dir: string; group: DirectoryGroup } | { kind: "row"; row: RowModel; index: number }> = []
    for (const group of groupByDirectory(rows, collapsed())) {
      out.push({ kind: "header", dir: group.directory, group })
      rows.forEach((row, idx) => {
        if (row.directory === group.directory) out.push({ kind: "row", row, index: idx })
      })
    }
    return out
  }

  const goalDir = (goalID: string): string => {
    if ((state()?.goals ?? []).some((g) => g.id === goalID)) return props.directory
    for (const [dir, st] of Object.entries(managedStates())) {
      if ((st.goals ?? []).some((g) => g.id === goalID)) return dir
    }
    return props.directory
  }

  const runtimeFor = (goalID: string): GoalRuntimeState | undefined =>
    state()?.runtimes.find((r) => r.goalID === goalID)
    ?? Object.values(managedStates()).map((st) => (st.runtimes ?? []).find((r) => r.goalID === goalID)).find(Boolean)

  const recentTranscriptFor = (goalID: string): string[] =>
    events()
      .filter((e) => (e as { goalID?: string }).goalID === goalID)
      .slice(-10)
      .map((e) => {
        const ev = e as { type?: string; summary?: string }
        return `${String(ev.type ?? "event")}${ev.summary ? ` — ${ev.summary}` : ""}`.slice(0, 160)
      })

  const coordDir = () => {
    if (tab() === "fleet") return selectedDir()
    if (tab() === "commands") return cmdScope() === "all" ? props.directory : cmdScope()
    return projectScope()
  }
  const stateForDir = (dir: string): StoreState | null =>
    dir === props.directory ? state() : (managedStates()[dir] ?? null)

  const coordModel = (): CoordinationModel => {
    const dir = coordDir()
    const st = stateForDir(dir)
    const goals = st?.goals ?? []
    const nameOf = (goalID: string | undefined) =>
      (goalID && goals.find((g) => g.id === goalID)?.name) || (goalID ?? "").slice(0, 8) || "owner/session"
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
      blockers.push({ kind: "uncontrolled", text: "live shell/command", holder: `session ${(c.sessionID ?? "").slice(0, 12)}…`, age: ageText(c.at, clock()) })
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
      verifyNote: blockers.length === 0 ? "Workspace quiet — checks can run" : undefined,
      reservations: (st?.workspaceCalls ?? []).map((c) => ({
        callID: c.callID,
        sessionID: c.sessionID ?? "?",
        goalName: nameOf(c.goalID),
        live: true,
        releasable: true,
        reason: "Server verifies ownership and liveness before releasing.",
        age: ageText(c.at, clock()),
      })),
    }
  }

  function cycleScope(dir: 1 | -1) {
    if (tab() === "commands") {
      const opts = ["all", ...managedDirs()]
      const idx = opts.indexOf(cmdScope())
      setCmdScope(opts[(idx + dir + opts.length) % opts.length]!)
      setCmdSelected(0)
      return
    }
    const dirs = managedDirs()
    if (dirs.length <= 1) { setStatusText("1 project managed — :projects lists registry"); return }
    const idx = dirs.indexOf(projectScope())
    setProjectScope(dirs[(idx + dir + dirs.length) % dirs.length]!)
    setSelected(0)
  }

  const scopeSummaryCounts = () => {
    const entries = activeGoals()
    return summarizeScope(
      entries.map((e) => e.goal),
      (i) => {
        const rt = runtimeFor(entries[i]!.goal.id) as (GoalRuntimeState & { activeRunID?: string }) | undefined
        return entries[i]!.goal.interactive === true && !!rt && rt.phase === "idle" && !rt.activeRunID
      },
    )
  }

  const scopeSummaryText = () => {
    if (tab() === "commands") {
      const running = ownerCommands().filter((c) => c.status === "running").length
      return `${running} running · ${ownerCommands().length} shown`
    }
    return summaryText(scopeSummaryCounts())
  }
  const fenceCount = () => state()?.workspaceCalls?.length || 0

  function handleBugReport() {
    const goal = selectedGoal()
    const extra = goal ? `Goal: ${goal.name} (${goal.id.slice(0, 8)}) status=${goal.status}` : "No goal selected"
    const url = bugReportUrl({ runtimeLabel: `opencode-loopd dashboard`, extra })
    const res = openBrowserUrl(url)
    setStatusText(res.status === "opened" ? "Opening bug report in browser…" : `Bug report: ${url}`)
  }

  createEffect(() => {
    const rows = rowModels()
    setSelected(Math.max(0, Math.min(selected(), Math.max(0, rows.length - 1))))
    setCmdSelected(Math.max(0, Math.min(cmdSelected(), Math.max(0, ownerCommands().length - 1))))
    const row = rows[selected()] ?? null
    const entry = row ? activeGoals().find((e) => e.goal.id === row.id && e.dir === row.directory) ?? null : null
    setSelectedGoal(entry ? entry.goal : null)
    const key = entry ? goalSelectionKey(entry.dir, entry.goal.id) : undefined
    if (key !== selectedKey()) {
      const idx = key ? indexForSelectionKey(rows.map((r) => goalSelectionKey(r.directory, r.id)), key) : 0
      if (idx !== selected()) setSelected(idx)
      setSelectedKey(key)
    }
  })

  const selectedDir = () => activeGoals()[selected()]?.dir ?? props.directory

  function rowIdFor(goalID: string): string {
    return `loopd-goal-${goalID}`
  }

  const rowStateColor = (row: RowModel): string => {
    if (row.state === "blocked" || row.state === "budget_limited" || row.state === "usage_limited") return PALETTE.rose
    if (row.state === "active") return row.manual ? PALETTE.amber : PALETTE.sage
    if (row.state === "paused") return PALETTE.violet
    if (row.state === "complete") return PALETTE.sky
    return PALETTE.muted
  }

  const rowNameColor = (row: RowModel, active: boolean): string => {
    if (active) return PALETTE.cyan
    if (row.state === "blocked" || row.state === "budget_limited" || row.state === "usage_limited") return PALETTE.rose
    if (row.state === "active") return row.manual ? PALETTE.amber : PALETTE.sage
    if (row.state === "paused") return PALETTE.violet
    if (row.state === "complete") return PALETTE.sky
    return PALETTE.ink
  }

  const coordStripSummary = () => {
    const cm = coordModel()
    const projPrefix = tab() === "fleet" ? `${cm.shortName} │ ` : ""
    const writesPart = `Writes ${cm.holds.length} running${cm.queue.length ? ` · ${cm.queue.length} queued` : ""}`
    const verifyPart = cm.verifyBlockers.length ? `Verification waiting (${cm.verifyBlockers.length})` : "No verification waits"
    const resvPart = cm.reservations.length ? ` │ ${cm.reservations.length} reservation${cm.reservations.length === 1 ? "" : "s"}` : ""
    return `${projPrefix}${writesPart} · ${verifyPart}${resvPart}`
  }

  const headerModeLabel = () => {
    if (mode() !== "insert") return "normal"
    if (insertKind() === "filter") return "filter"
    if (insertKind() === "send") return "send"
    return "command"
  }

  return (
    <box
      flexDirection="column"
      width="100%"
      border={true}
      borderColor={PALETTE.rule}
      backgroundColor={PALETTE.base}
      flexShrink={0}
    >
      {/* 1 & 2. Header + Navigation Tabs */}
      <DashboardHeader
        theme={theme()}
        mode={headerModeLabel()}
        scopeName={tab() === "fleet" ? "All projects" : tab() === "commands" ? (cmdScope() === "all" ? "All projects" : (cmdScope().split("/").pop() || cmdScope())) : (projectScope().split("/").pop() || projectScope())}
        summary={scopeSummaryText()}
        tab={tab()}
        projCount={managedDirs().length}
        onBugReport={handleBugReport}
        onSelectTab={(nextTab) => { setTab(nextTab); setSelected(0) }}
      />

      {/* 3..5. Main body: tight vertical rhythm (gap 0) so sections read as
          one dashboard instead of separated islands. Sized to content — never
          flexGrow:1 so it never pushes footer off-screen. */}
      <box
        flexDirection="column"
        paddingLeft={2}
        paddingRight={2}
        paddingTop={0}
        paddingBottom={0}
        gap={0}
        flexShrink={0}
      >
        {/* ─── MODAL POPUPS (Actions / Send / Coordination / Help / Projects / Release) ─── */}
        <Show when={pendingRelease()}>
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
          >
            <box flexDirection="row" justifyContent="space-between" height={1}>
              <text wrapMode="none">
                <span style={{ fg: PALETTE.cyan, bold: true }}>Release reservation</span>
              </text>
              <text wrapMode="none">
                <span style={{ fg: PALETTE.muted }}>[esc]</span>
              </text>
            </box>
            <text wrapMode="word">
              <span style={{ fg: PALETTE.ink, bold: true }}>{pendingRelease()!.callID}</span>
              <span style={{ fg: PALETTE.muted }}> in {pendingRelease()!.dir}</span>
            </text>
            <text wrapMode="word">
              <span style={{ fg: PALETTE.muted }}>
                The server verifies ownership and call liveness before releasing. Live calls from other sessions are never released.
              </span>
            </text>
            <box flexDirection="row" gap={2}>
              <box border={true} borderColor={PALETTE.cyan} backgroundColor={PALETTE.base} paddingLeft={1} paddingRight={1}>
                <text wrapMode="none"><span style={{ fg: PALETTE.cyan, bold: true }}>[y / Enter] Confirm release</span></text>
              </box>
              <box border={true} borderColor={PALETTE.rule} backgroundColor={PALETTE.base} paddingLeft={1} paddingRight={1}>
                <text wrapMode="none"><span style={{ fg: PALETTE.muted }}>[n / Esc] Cancel</span></text>
              </box>
            </box>
          </box>
        </Show>

        <Show when={!pendingRelease() && sendOpen()}>
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
          >
            <box flexDirection="row" justifyContent="space-between" height={1}>
              <text wrapMode="none">
                <span style={{ fg: PALETTE.cyan, bold: true }}>
                  {tab() === "commands" ? "Send stdin" : "Send input"}
                </span>
                <span style={{ fg: PALETTE.muted }}>
                  {" → "}
                  {tab() === "commands" ? (selectedCommand()?.title ?? "command") : (selectedGoal()?.name ?? "worker")}
                </span>
              </text>
              <box
                backgroundColor={PALETTE.base}
                paddingLeft={1}
                paddingRight={1}
                height={1}
                {...({ onMouseDown: () => returnToNormalMode() } as any)}
              >
                <text wrapMode="none"><span style={{ fg: PALETTE.amber, bold: true }}>[esc]</span></text>
              </box>
            </box>
            <text wrapMode="none">
              <span style={{ fg: PALETTE.muted }}>
                {tab() === "commands"
                  ? "Writes a line to the selected process stdin:"
                  : "Delivers bare words as the worker's own turn (no steering wrapper):"}
              </span>
            </text>
            <box
              flexDirection="row"
              border={true}
              borderColor={PALETTE.amber}
              backgroundColor={PALETTE.base}
              paddingLeft={1}
              paddingRight={1}
              height={3}
              alignItems="center"
            >
              <text wrapMode="word">
                <span style={{ fg: PALETTE.amber, bold: true }}>› </span>
                <span style={{ fg: commandInput() ? PALETTE.ink : PALETTE.muted }}>
                  {commandInput() || "Give this worker a short directive…"}
                </span>
                <span style={{ fg: PALETTE.cyan, bold: true }}>█</span>
              </text>
            </box>
            <box flexDirection="row" justifyContent="space-between" height={1}>
              <text wrapMode="none">
                <span style={{ fg: PALETTE.muted }}>Press </span>
                <span style={{ fg: PALETTE.ink, bold: true }}>Enter</span>
                <span style={{ fg: PALETTE.muted }}> to send · </span>
                <span style={{ fg: PALETTE.ink, bold: true }}>Esc</span>
                <span style={{ fg: PALETTE.muted }}> to cancel</span>
              </text>
            </box>
          </box>
        </Show>

        <Show when={!pendingRelease() && !sendOpen() && actionsOpen() && selectedGoal()}>
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
          >
            <box flexDirection="row" justifyContent="space-between" height={1}>
              <text wrapMode="none">
                <span style={{ fg: PALETTE.cyan, bold: true }}>Actions / {selectedGoal()!.name}</span>
              </text>
              <box
                backgroundColor={PALETTE.base}
                paddingLeft={1}
                paddingRight={1}
                height={1}
                {...({ onMouseDown: () => setActionsOpen(false) } as any)}
              >
                <text wrapMode="none"><span style={{ fg: PALETTE.amber, bold: true }}>[esc]</span></text>
              </box>
            </box>
            <text wrapMode="none">
              <span style={{ fg: PALETTE.muted }}>
                {selectedDir().split("/").pop() || selectedDir()} · j/k move · Enter select · or press key directly
              </span>
            </text>
            <box flexDirection="column" gap={0}>
              <For each={paletteVerbs()}>
                {(v, idx) => {
                  const active = () => idx() === actionIdx()
                  return (
                    <box
                      flexDirection="row"
                      justifyContent="space-between"
                      backgroundColor={active() ? PALETTE.selectedBg : PALETTE.base}
                      border={true}
                      borderColor={active() ? PALETTE.cyan : PALETTE.rule}
                      paddingLeft={1}
                      paddingRight={1}
                      {...({ onMouseDown: () => void runPaletteVerb(v) } as any)}
                    >
                      <text wrapMode="none">
                        <span style={{ fg: active() ? PALETTE.cyan : PALETTE.muted, bold: true }}>
                          {active() ? "> " : "  "}
                        </span>
                        <span style={{ fg: PALETTE.ink, bold: active() }}>{v.label}</span>
                      </text>
                      <text wrapMode="none">
                        <span style={{ fg: PALETTE.cyan }}>[{v.key}]</span>
                      </text>
                    </box>
                  )
                }}
              </For>
            </box>
          </box>
        </Show>

        <Show when={!pendingRelease() && !sendOpen() && !actionsOpen() && coordOpen()}>
          <CoordinationPanel
            theme={theme()}
            model={coordModel()}
            tab={coordTab()}
            onTab={(t) => setCoordTab(t)}
            onInspectReservations={() => void releaseWorkspaceFences({}, coordDir())}
            onRelease={(callID) => setPendingRelease({ callID, dir: coordDir() })}
            onOpenSession={() => {
              const g = selectedGoal()
              if (g?.workerSessionID) {
                try {
                  props.api.route.navigate("session", { sessionID: g.workerSessionID })
                  props.api.ui.dialog.clear()
                } catch {
                  setStatusText("Navigate unsupported here.")
                }
              }
            }}
            onClose={() => setCoordOpen(false)}
            scrollRef={(el) => { coordScrollEl = el }}
          />
        </Show>

        <Show when={!pendingRelease() && !sendOpen() && !actionsOpen() && !coordOpen() && detailsOpen() && selectedGoal()}>
          {(goal) => {
            const entry = () => activeGoals().find((e) => e.goal.id === goal().id)
            const dir = () => entry()?.dir ?? props.directory
            const rt = () => runtimeFor(goal().id)
            const lp = () => goal().lastProgress
            const agentName = () => goal().config.agent
            const meta = () => (agentName() ? (agentIndex()[agentName()!] ?? agentIndex()[agentName()!.toLowerCase()]) : undefined)
            const model = () => goal().config.model
            return (
              <GoalDetailsDrawer
                theme={theme()}
                scrollRef={(el) => { detailsScrollEl = el }}
                onClose={() => setDetailsOpen(false)}
                model={{
                  goal: goal(),
                  directory: dir(),
                  runtime: rt(),
                  transcript: recentTranscriptFor(goal().id),
                  progressHistory: lp() ? [{ summary: lp()!.summary, next: lp()!.next, at: lp()!.at }] : [],
                  agentLabel: agentName() ? `${agentName()!}${meta()?.mode ? ` (${meta()!.mode})` : ""}` : (goal().parentAgent ?? "parent"),
                  modelLabel: model() ?? goal().parentModel ?? "parent",
                }}
              />
            )
          }}
        </Show>

        <Show when={!pendingRelease() && !sendOpen() && !actionsOpen() && !coordOpen() && !detailsOpen() && showHelp()}>
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
          >
            <box flexDirection="row" justifyContent="space-between" height={1}>
              <text wrapMode="none">
                <span style={{ fg: PALETTE.cyan, bold: true }}>Keyboard shortcuts</span>
              </text>
              <box
                backgroundColor={PALETTE.base}
                paddingLeft={1}
                paddingRight={1}
                height={1}
                {...({ onMouseDown: () => setShowHelp(false) } as any)}
              >
                <text wrapMode="none"><span style={{ fg: PALETTE.amber, bold: true }}>[esc]</span></text>
              </box>
            </box>
            <box border={true} borderColor={PALETTE.rule} backgroundColor={PALETTE.base} paddingLeft={1} paddingRight={1}>
              <text wrapMode="none">
                <span style={{ fg: PALETTE.cyan }}>1 / 2 / 3   </span><span style={{ fg: PALETTE.ink }}>Project / Fleet / Commands tabs</span>{"\n"}
                <span style={{ fg: PALETTE.cyan }}>j / k       </span><span style={{ fg: PALETTE.ink }}>Move selection (or scroll inside Details / Coordination)</span>{"\n"}
                <span style={{ fg: PALETTE.cyan }}>Enter       </span><span style={{ fg: PALETTE.ink }}>Worker actions popup</span>{"\n"}
                <span style={{ fg: PALETTE.cyan }}>s           </span><span style={{ fg: PALETTE.ink }}>Send input popup</span>{"\n"}
                <span style={{ fg: PALETTE.cyan }}>o           </span><span style={{ fg: PALETTE.ink }}>Open worker session / fullscreen command</span>{"\n"}
                <span style={{ fg: PALETTE.cyan }}>d           </span><span style={{ fg: PALETTE.ink }}>Technical details popup (j/k scrolls, n/p switches worker)</span>{"\n"}
                <span style={{ fg: PALETTE.cyan }}>t           </span><span style={{ fg: PALETTE.ink }}>Project coordination popup (j/k scrolls, w/v/r switches tab)</span>{"\n"}
                <span style={{ fg: PALETTE.cyan }}>/           </span><span style={{ fg: PALETTE.ink }}>Focus filter box in toolbar</span>{"\n"}
                <span style={{ fg: PALETTE.cyan }}>h           </span><span style={{ fg: PALETTE.ink }}>Show or hide completed history</span>{"\n"}
                <span style={{ fg: PALETTE.cyan }}>[ / ]       </span><span style={{ fg: PALETTE.ink }}>Cycle project scope</span>{"\n"}
                <span style={{ fg: PALETTE.cyan }}>Esc         </span><span style={{ fg: PALETTE.ink }}>Close active popup / filter, or close dashboard</span>
              </text>
            </box>
          </box>
        </Show>

        <Show when={!pendingRelease() && !sendOpen() && !actionsOpen() && !coordOpen() && !detailsOpen() && !showHelp() && showProjects()}>
          <box
            flexDirection="column"
            border={true}
            borderColor={PALETTE.cyan}
            backgroundColor={PALETTE.inset}
            paddingLeft={2}
            paddingRight={2}
            paddingTop={1}
            paddingBottom={1}
          >
            <box flexDirection="row" justifyContent="space-between" height={1}>
              <text wrapMode="none">
                <span style={{ fg: PALETTE.cyan, bold: true }}>Managed projects ({managedDirs().length})</span>
              </text>
              <text wrapMode="none"><span style={{ fg: PALETTE.muted }}>[esc] close</span></text>
            </box>
            <For each={projectStatuses() ?? managedDirs().map((d) => ({ directory: d, storePath: managedStorePath(d), total: 0, active: 0, blocked: 0, paused: 0, complete: 0, blockedItems: [] as ManagedDirStatus["blockedItems"] }))}>
              {(p) => (
                <text wrapMode="none">
                  <span style={{ fg: PALETTE.ink, bold: true }}>{p.directory}</span>
                  <span style={{ fg: PALETTE.muted }}> — {p.total} goals ({p.active} active, {p.blocked} blocked, {p.paused} paused)</span>
                </text>
              )}
            </For>
          </box>
        </Show>

        {/* ─── NORMAL VIEW (Summary + Toolbar + Table + Inspector + Details) ─── */}
        <Show when={!modalPopupOpen()}>
          {/* 3a. Summary line (#summary in web UI) */}
          <box flexDirection="row" justifyContent="space-between" alignItems="center" height={1} flexShrink={0}>
            <text wrapMode="none">
              <Show
                when={tab() !== "commands"}
                fallback={
                  <span style={{ fg: PALETTE.muted }}>
                    Raw processes / independent from worker lifecycle · <span style={{ fg: PALETTE.amber }}>{scopeSummaryText()}</span>
                  </span>
                }
              >
                <span style={{ fg: PALETTE.amber, bold: true }}>{scopeSummaryCounts().needsAction}</span>
                <span style={{ fg: PALETTE.muted }}> needs action · </span>
                <span style={{ fg: PALETTE.amber, bold: true }}>{scopeSummaryCounts().working}</span>
                <span style={{ fg: PALETTE.muted }}> working · </span>
                <span style={{ fg: PALETTE.amber, bold: true }}>{scopeSummaryCounts().awaiting}</span>
                <span style={{ fg: PALETTE.muted }}> awaiting input</span>
                <Show when={scopeSummaryCounts().paused > 0}>
                  <span style={{ fg: PALETTE.muted }}> · </span>
                  <span style={{ fg: PALETTE.amber, bold: true }}>{scopeSummaryCounts().paused}</span>
                  <span style={{ fg: PALETTE.muted }}> paused</span>
                </Show>
                <Show when={detailsOpen()}>
                  <span style={{ fg: PALETTE.muted }}> · detail open (1 row)</span>
                </Show>
              </Show>
            </text>
            <Show when={statusText()}>
              <text wrapMode="none">
                <span style={{ fg: PALETTE.cyan }}>{statusText().slice(0, 48)}</span>
              </text>
            </Show>
          </box>

          {/* 3b. Toolbar (#toolbar in web UI: project selector, visible / filter box, [h] history checkbox) */}
          <box flexDirection="row" justifyContent="space-between" alignItems="center" height={3} flexShrink={0} gap={1}>
            <box flexDirection="row" gap={1} alignItems="center">
              <Show when={tab() !== "fleet"}>
                <box
                  flexDirection="row"
                  border={true}
                  borderColor={PALETTE.rule}
                  backgroundColor={PALETTE.inset}
                  paddingLeft={1}
                  paddingRight={1}
                  {...({ onMouseDown: () => cycleScope(1) } as any)}
                >
                  <text wrapMode="none">
                    <span style={{ fg: PALETTE.ink }}>
                      {tab() === "commands"
                        ? (cmdScope() === "all" ? "All projects" : (cmdScope().split("/").pop() || cmdScope()))
                        : (projectScope().split("/").pop() || projectScope())}
                    </span>
                    <span style={{ fg: PALETTE.muted }}> ▾ [ ]</span>
                  </text>
                </box>
              </Show>
              <box
                flexDirection="row"
                border={true}
                borderColor={mode() === "insert" && insertKind() === "filter" ? PALETTE.amber : activeFilterQuery() ? PALETTE.cyan : PALETTE.rule}
                backgroundColor={PALETTE.inset}
                paddingLeft={1}
                paddingRight={1}
                width={38}
                {...({ onMouseDown: () => openFilterBox() } as any)}
              >
                <text wrapMode="none">
                  <Show
                    when={mode() === "insert" && insertKind() === "filter"}
                    fallback={
                      activeFilterQuery() ? (
                        <>
                          <span style={{ fg: PALETTE.cyan }}>/ </span>
                          <span style={{ fg: PALETTE.ink }}>{activeFilterQuery().slice(0, 26)}</span>
                          <span style={{ fg: PALETTE.muted }}> (Esc clear)</span>
                        </>
                      ) : (
                        <span style={{ fg: PALETTE.muted }}>/ filter workers or commands</span>
                      )
                    }
                  >
                    <span style={{ fg: PALETTE.amber, bold: true }}>/ </span>
                    <span style={{ fg: PALETTE.ink }}>{commandInput()}</span>
                    <span style={{ fg: PALETTE.cyan, bold: true }}>█</span>
                  </Show>
                </text>
              </box>
            </box>
            <box
              flexDirection="row"
              border={true}
              borderColor={showCompleted() ? PALETTE.cyan : PALETTE.rule}
              backgroundColor={PALETTE.inset}
              paddingLeft={1}
              paddingRight={1}
              {...({ onMouseDown: () => setShowCompleted((v) => !v) } as any)}
            >
              <text wrapMode="none">
                <span style={{ fg: showCompleted() ? PALETTE.cyan : PALETTE.muted }}>
                  {showCompleted() ? "[✓]" : "[ ]"} history [h]
                </span>
              </text>
            </box>
          </box>

          {/* 4. Worker Table (Project & Fleet tabs) */}
          <Show when={tab() === "project" || tab() === "fleet"}>
            <Show
              when={rowModels().length > 0}
              fallback={
                <box border={true} borderColor={PALETTE.rule} backgroundColor={PALETTE.inset} paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1}>
                  <text wrapMode="none">
                    <span style={{ fg: PALETTE.muted }}>
                      No matching workers{activeFilterQuery() ? ` for "${activeFilterQuery()}"` : ""}. Use /goal in chat to start one, or press [h] to toggle history.
                    </span>
                  </text>
                </box>
              }
            >
              <box flexDirection="column" flexShrink={0}>
                {/* Table column headers */}
                <box flexDirection="row" paddingLeft={1} paddingRight={1} height={1} flexShrink={0}>
                  <text wrapMode="none">
                    <span style={{ fg: PALETTE.muted }}>
                      {"  "}
                      {"Worker".padEnd(ROW_COLS.name)}
                      {"  "}
                      {"State".padEnd(ROW_COLS.state)}
                      {"  "}
                      {"Current activity".padEnd(ROW_COLS.activity)}
                      {"  "}
                      {"Updated"}
                    </span>
                  </text>
                </box>
                <box flexDirection="row" paddingLeft={1} paddingRight={1} height={1} flexShrink={0}>
                  <text wrapMode="none">
                    <span style={{ fg: PALETTE.rule }}>
                      {"─".repeat(2 + ROW_COLS.name + 2 + ROW_COLS.state + 2 + ROW_COLS.activity + 2 + ROW_COLS.updated)}
                    </span>
                  </text>
                </box>
                <DashboardList
                  count={displayItems().length}
                  maxRows={6}
                  selectedID={rowModels()[selected()] ? rowIdFor(rowModels()[selected()]!.id) : undefined}
                >
                  <For each={displayItems()}>
                    {(item) => {
                      if (item.kind === "header") {
                        const g = item.group
                        return (
                          <DashboardRow
                            id={`loopd-group-${g.directory}`}
                            backgroundColor={PALETTE.inset}
                            onClick={() => setCollapsed((list) => toggleCollapsed(list, g.directory))}
                          >
                            <span style={{ fg: PALETTE.cyan, bold: true }}>
                              {collapsed().includes(g.directory) ? "▸" : "▾"} {g.shortName}
                            </span>
                            <span style={{ fg: PALETTE.muted }}>
                              {" / "}
                              {g.needsAction > 0 ? `${g.needsAction} needs action` : "No intervention needed"}
                              {" · "}
                              {g.working} working
                            </span>
                          </DashboardRow>
                        )
                      }
                      const row = item.row
                      const isActive = () => item.index === selected()
                      const stateFg = () => rowStateColor(row)
                      const nameFg = () => rowNameColor(row, isActive())
                      const cols = () => formatRowColumns(row)
                      return (
                        <DashboardRow
                          id={rowIdFor(row.id)}
                          backgroundColor={isActive() ? PALETTE.selectedBg : undefined}
                          onClick={() => setSelected(item.index)}
                        >
                          <span style={{ fg: PALETTE.cyan, bold: true }}>{isActive() ? "> " : "  "}</span>
                          <span style={{ fg: nameFg(), bold: true }}>{cols().name}</span>
                          <span style={{ fg: PALETTE.muted }}>{"  "}</span>
                          <span style={{ fg: stateFg(), bold: true }}>{cols().state}</span>
                          <span style={{ fg: PALETTE.muted }}>{"  "}</span>
                          <span style={{ fg: row.state === "blocked" ? PALETTE.rose : PALETTE.ink }}>{cols().activity}</span>
                          <span style={{ fg: PALETTE.muted }}>{"  "}{cols().updated}</span>
                        </DashboardRow>
                      )
                    }}
                  </For>
                </DashboardList>
              </box>
            </Show>

            {/* 5. Selected Worker Inspector (Details opens as a modal popup on [d]) */}
            <Show when={selectedGoal()}>
              {(goal) => {
                const entry = () => activeGoals().find((e) => e.goal.id === goal().id)
                const dir = () => entry()?.dir ?? props.directory
                const rt = () => runtimeFor(goal().id)
                const activity = () => (rt() ? workerActivityLabel(rt()!, clock()) : undefined)
                const lp = () => goal().lastProgress
                const blk = () => goal().blocker
                const agentName = () => goal().config.agent
                const meta = () => (agentName() ? (agentIndex()[agentName()!] ?? agentIndex()[agentName()!.toLowerCase()]) : undefined)
                return (
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
                      detailsOpen: detailsOpen(),
                    }}
                    onSend={() => openSendModal()}
                    onOpen={() => {
                      if (goal().workerSessionID) {
                        try {
                          props.api.route.navigate("session", { sessionID: goal().workerSessionID })
                          props.api.ui.dialog.clear()
                        } catch {
                          setStatusText("Navigate unsupported here.")
                        }
                      } else setStatusText("No worker session")
                    }}
                    onActions={() => { setActionIdx(0); setActionsOpen(true) }}
                    onDetails={() => setDetailsOpen(true)}
                    onFocusProject={() => {
                      setProjectScope(dir())
                      setTab("project")
                      setSelected(0)
                      setStatusText(`scope: ${dir().split("/").pop() || dir()}`)
                    }}
                  />
                )
              }}
            </Show>
          </Show>

          {/* Commands tab */}
          <Show when={tab() === "commands"}>
            <Show
              when={ownerCommands().length > 0}
              fallback={
                <box border={true} borderColor={PALETTE.rule} backgroundColor={PALETTE.inset} paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1}>
                  <text wrapMode="none">
                    <span style={{ fg: PALETTE.muted }}>
                      No live command sessions{hiddenFinishedCommands() > 0 ? ` (${hiddenFinishedCommands()} finished hidden — press [h] to show)` : ""}. Use :new &lt;cmd&gt; to start one.
                    </span>
                  </text>
                </box>
              }
            >
              <box flexDirection="column" flexShrink={0}>
                <box flexDirection="row" paddingLeft={1} paddingRight={1} height={1} flexShrink={0}>
                  <text wrapMode="none">
                    <span style={{ fg: PALETTE.muted }}>
                      {"  "}{"Title".padEnd(22)}{"  "}{"Status".padEnd(14)}{"  "}{"Command".padEnd(36)}{"  "}{"Updated"}
                    </span>
                  </text>
                </box>
                <box flexDirection="row" paddingLeft={1} paddingRight={1} height={1} flexShrink={0}>
                  <text wrapMode="none">
                    <span style={{ fg: PALETTE.rule }}>{"─".repeat(86)}</span>
                  </text>
                </box>
                <DashboardList
                  count={ownerCommands().length}
                  maxRows={6}
                  selectedID={selectedCommand() ? `loopd-command-${selectedCommand()!.id}` : undefined}
                >
                  <For each={ownerCommands()}>
                    {(cmd, i) => {
                      const isActive = () => i() === cmdSelected()
                      const pad = (s: string, w: number) => (s.length > w ? `${s.slice(0, w - 1)}…` : s.padEnd(w))
                      return (
                        <DashboardRow
                          id={`loopd-command-${cmd.id}`}
                          backgroundColor={isActive() ? PALETTE.selectedBg : undefined}
                          onClick={() => setCmdSelected(i())}
                        >
                          <span style={{ fg: PALETTE.cyan, bold: true }}>{isActive() ? "> " : "  "}</span>
                          <span style={{ fg: PALETTE.ink, bold: isActive() }}>{pad(cmd.title, 22)}</span>
                          <span style={{ fg: PALETTE.muted }}>{"  "}</span>
                          <span style={{ fg: commandStatusColor(cmd.status), bold: isActive() }}>
                            {pad(`${commandStatusIcon(cmd.status)} ${commandStatusLabel(cmd.status).short}`, 14)}
                          </span>
                          <span style={{ fg: PALETTE.muted }}>{"  "}</span>
                          <span style={{ fg: PALETTE.ink }}>{pad(`${cmd.command} ${cmd.args.join(" ")}`.trim(), 36)}</span>
                          <span style={{ fg: PALETTE.muted }}>{"  "}{ageText(cmd.updatedAt, clock())}</span>
                        </DashboardRow>
                      )
                    }}
                  </For>
                </DashboardList>
              </box>
            </Show>
            <Show when={selectedCommand()}>
              {(cmd) => (
                <box
                  flexDirection="column"
                  border={true}
                  borderColor={PALETTE.rule}
                  backgroundColor={PALETTE.inset}
                  paddingLeft={1}
                  paddingRight={1}
                  flexShrink={0}
                >
                  <box flexDirection="row" justifyContent="space-between" height={1}>
                    <text wrapMode="none">
                      <span style={{ fg: PALETTE.cyan, bold: true }}>{cmd().title}</span>
                      <span style={{ fg: PALETTE.muted }}> / {commandDir(cmd().id).split("/").pop() ?? commandDir(cmd().id)}</span>
                    </text>
                    <text wrapMode="none">
                      <span style={{ fg: commandStatusColor(cmd().status), bold: true }}>
                        {commandStatusIcon(cmd().status)} {commandStatusLabel(cmd().status).short}
                      </span>
                    </text>
                  </box>
                  <text wrapMode="none">
                    <span style={{ fg: PALETTE.muted }}>Command: </span>
                    <span style={{ fg: PALETTE.ink }}>{cmd().command} {cmd().args.join(" ")}</span>
                    <span style={{ fg: PALETTE.muted }}> · {cmd().outputBytes}B · updated {ageText(cmd().updatedAt, clock())}</span>
                  </text>
                  <box flexDirection="row" gap={1}>
                    <box border={true} borderColor={PALETTE.rule} backgroundColor={PALETTE.base} paddingLeft={1} paddingRight={1} {...({ onMouseDown: () => openSendModal() } as any)}>
                      <text wrapMode="none"><span style={{ fg: PALETTE.ink }}>Send stdin </span><span style={{ fg: PALETTE.cyan }}>[s]</span></text>
                    </box>
                    <box border={true} borderColor={PALETTE.rule} backgroundColor={PALETTE.base} paddingLeft={1} paddingRight={1}>
                      <text wrapMode="none"><span style={{ fg: PALETTE.ink }}>Fullscreen </span><span style={{ fg: PALETTE.cyan }}>[o]</span></text>
                    </box>
                    <box border={true} borderColor={PALETTE.rule} backgroundColor={PALETTE.base} paddingLeft={1} paddingRight={1} {...({ onMouseDown: () => void killSelectedCommand() } as any)}>
                      <text wrapMode="none"><span style={{ fg: PALETTE.ink }}>Kill </span><span style={{ fg: PALETTE.cyan }}>[X]</span></text>
                    </box>
                    <box border={true} borderColor={PALETTE.rule} backgroundColor={PALETTE.base} paddingLeft={1} paddingRight={1} {...({ onMouseDown: () => void restartSelectedCommand() } as any)}>
                      <text wrapMode="none"><span style={{ fg: PALETTE.ink }}>Restart </span><span style={{ fg: PALETTE.cyan }}>[R]</span></text>
                    </box>
                  </box>
                </box>
              )}
            </Show>
          </Show>
        </Show>
      </box>

      {/* 6. Coordination strip (#coordstrip in web UI, right above footer) */}
      <box
        flexDirection="row"
        justifyContent="space-between"
        alignItems="center"
        backgroundColor={PALETTE.base}
        paddingLeft={2}
        paddingRight={2}
        height={1}
        flexShrink={0}
      >
        <text wrapMode="none">
          <span style={{ fg: PALETTE.amber }}>{coordStripSummary()}</span>
        </text>
        <box
          flexDirection="row"
          backgroundColor={PALETTE.inset}
          paddingLeft={1}
          paddingRight={1}
          {...({ onMouseDown: () => setCoordOpen((v) => !v) } as any)}
        >
          <text wrapMode="none">
            <span style={{ fg: PALETTE.cyan }}>[t] Inspect coordination</span>
          </text>
        </box>
      </box>

      {/* 7. Footer hint bar + hidden focus trap input */}
      <box
        ref={(el) => { hintBoxEl = el as unknown as { width?: number } }}
        flexDirection="row"
        backgroundColor={PALETTE.inset}
        paddingLeft={2}
        paddingRight={2}
        height={1}
        flexShrink={0}
        alignItems="center"
      >
        <Show when={mode() === "insert" && insertKind() === "colon"}>
          <text wrapMode="none">
            <span style={{ fg: PALETTE.amber, bold: true }}>:</span>
          </text>
        </Show>
        <input
          ref={(el: InputRenderable) => { inputEl = el; focusInput() }}
          flexGrow={1}
          placeholder={
            mode() === "insert" && insertKind() === "colon"
              ? "send <msg> | filter <text> | project <name> | release (Esc cancel)"
              : fitHintBar(FOOT_HINTS, hintCols())
          }
          placeholderColor={PALETTE.muted as unknown as any}
          cursorColor={PALETTE.cyan as unknown as any}
          focusedTextColor={(mode() === "insert" && insertKind() === "colon" ? PALETTE.ink : PALETTE.inset) as unknown as any}
          focusedBackgroundColor={PALETTE.inset as unknown as any}
          onInput={(v: string) => {
            if (mode() === "insert") setCommandInput(v)
            else if (inputEl?.value) inputEl.value = ""
          }}
          onKeyDown={(evt: ParsedKey) => {
            if (mode() !== "insert") { if ((evt.name || "").length === 1) prevent(evt); return }
          }}
        />
      </box>
    </box>
  )
}
