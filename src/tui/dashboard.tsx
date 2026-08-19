// ─── TUI: Dashboard Component ────────────────────────────────────────────────
// Functional modal dashboard with Neovim-style keybindings.
// Uses the controller for all actions. Renders state reactively.

/** @jsxImportSource @opentui/solid */
import { createSignal, For, Show, onCleanup, onMount, batch } from "solid-js"
import type { TuiPluginApi, TuiThemeCurrent } from "@opencode-ai/plugin/tui"
import { readEvents } from "../infrastructure/state-repository"
import { createControlClient } from "../infrastructure/control-client"
import type { StoreState } from "../infrastructure/state-repository"
import type { Goal, GoalStatus } from "../domain/goal"
import type { GoalRuntimeState, RuntimePhase } from "../domain/runtime"
import { parseCommand, commandHelp } from "./command-parser"
import { createDashboardController, type DashboardState } from "./controller"
import { randomUUID } from "crypto"

type Mode = "normal" | "command" | "confirm" | "help"

interface Props {
  api: TuiPluginApi
  directory: string
}

// ─── Status Helpers ──────────────────────────────────────────────────────────

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

function phaseIcon(phase: RuntimePhase): string {
  switch (phase) {
    case "running": return "▶"
    case "compacting": return "⏳"
    case "waiting_retry": return "🔄"
    case "stopping": return "⏹"
    default: return "○"
  }
}

function statusIcon(status: GoalStatus): string {
  switch (status) {
    case "active": return "●"
    case "paused": return "❚❚"
    case "blocked": return "✖"
    case "complete": return "✓"
    case "budget_limited": return "$"
    case "usage_limited": return "⏰"
    default: return "○"
  }
}

// ─── Dashboard ───────────────────────────────────────────────────────────────

export function LoopDashboard(props: Props) {
  const theme = () => props.api.theme.current
  const [mode, setMode] = createSignal<Mode>("normal")
  const [selected, setSelected] = createSignal(0)
  const [commandInput, setCommandInput] = createSignal("")
  const [statusText, setStatusText] = createSignal("Press ? for help")
  const [state, setState] = createSignal<StoreState | null>(null)
  const [events, setEvents] = createSignal<Record<string, unknown>[]>([])
  const [selectedGoal, setSelectedGoal] = createSignal<Goal | null>(null)
  const [showLogs, setShowLogs] = createSignal(false)

  const client = createControlClient(props.directory)
  const ctrl = createDashboardController(client)

  // ─── State Refresh ───────────────────────────────────────────────────────

  async function refresh() {
    try {
      const s = await client.getState()
      setState(s)
      const goals = s.goals.filter((g) => g.status !== "complete")
      if (goals.length > 0 && selected() >= goals.length) {
        setSelected(goals.length - 1)
      }
      const sel = goals[selected()]
      setSelectedGoal(sel || null)

      const ev = await client.getEvents(20)
      setEvents(ev)
    } catch (e) {
      setStatusText(`Error: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  refresh()
  const refreshInterval = setInterval(refresh, 2000)
  onCleanup(() => clearInterval(refreshInterval))

  // ─── Actions ─────────────────────────────────────────────────────────────

  async function executeCommand(cmd: string) {
    const parsed = parseCommand(cmd)
    if (!parsed) return

    const route = props.api.route.current
    const ownerSessionID = route.name === "session" ? (route.params?.sessionID as string || "main") : "main"

    try {
      const result = await ctrl.executeCommand(
        parsed.command,
        parsed.args,
        parsed.positional,
        { goals: state()?.goals || [], selected: selected(), activeGoals: state()?.goals.filter((g) => g.status !== "complete") || [], selectedGoal: selectedGoal(), statusText: statusText(), showLogs: showLogs() },
        ownerSessionID,
      )
      setStatusText(result.statusText)
      if (result.needsRefresh) await refresh()
    } catch (e) {
      setStatusText(`Error: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // ─── Keyboard ────────────────────────────────────────────────────────────

  props.api.keymap.registerLayer({
    mode: "modal",
    commands: [],
    bindings: [
      { key: "escape", cmd: "loopd.close", desc: "Close dashboard" },
      { key: "ctrl+c", cmd: "loopd.close", desc: "Close dashboard" },
      { key: "j", cmd: "loopd.next", desc: "Next goal" },
      { key: "down", cmd: "loopd.next", desc: "Next goal" },
      { key: "k", cmd: "loopd.prev", desc: "Previous goal" },
      { key: "up", cmd: "loopd.prev", desc: "Previous goal" },
      { key: "g", cmd: "loopd.first", desc: "First goal" },
      { key: "G", cmd: "loopd.last", desc: "Last goal" },
      { key: "p", cmd: "loopd.pause", desc: "Pause selected goal" },
      { key: "r", cmd: "loopd.resume", desc: "Resume selected goal" },
      { key: "R", cmd: "loopd.retry", desc: "Retry failed goal" },
      { key: "x", cmd: "loopd.clear", desc: "Clear selected goal" },
      { key: "L", cmd: "loopd.logs", desc: "Toggle log view" },
      { key: ":", cmd: "loopd.command", desc: "Enter command mode" },
      { key: "?", cmd: "loopd.help", desc: "Show help" },
      { key: "q", cmd: "loopd.close", desc: "Close dashboard" },
    ],
  })

  // ─── Active Goals ────────────────────────────────────────────────────────

  const activeGoals = () => state()?.goals.filter((g) => g.status !== "complete") || []

  // ─── Render ──────────────────────────────────────────────────────────────

  return (
    <box flexDirection="column" width="100%" height="100%">
      {/* Header */}
      <box flexDirection="row" padding={1}>
        <text>
          <span style={{ fg: theme().primary, bold: true }}>Loop Dashboard</span>
          <span style={{ fg: theme().textMuted }}>{" │ "}</span>
          <span style={{ fg: mode() === "normal" ? theme().success : theme().warning }}>
            {mode().toUpperCase()}
          </span>
          <span style={{ fg: theme().textMuted }}>{" │ goals: "}</span>
          <span style={{ fg: theme().text }}>{activeGoals().length}</span>
          <span style={{ fg: theme().textMuted }}>{" │ verified: "}</span>
          <span style={{ fg: theme().info }}>
            {state()?.goals.filter((g) => g.status === "complete").length || 0}
          </span>
        </text>
      </box>

      {/* Goal list or help */}
      <Show
        when={mode() !== "help"}
        fallback={
          <box flexDirection="column" flexGrow={1} padding={1}>
            <text><span style={{ fg: theme().primary, bold: true }}>Keyboard Shortcuts</span></text>
            <text><span style={{ fg: theme().text }}>
              {commandHelp()}
            </span></text>
          </box>
        }
      >
        <box flexDirection="column" flexGrow={1} padding={1}>
          <Show
            when={activeGoals().length > 0}
            fallback={
              <text>
                <span style={{ fg: theme().textMuted }}>
                  No active goals. Press : to create one.
                </span>
              </text>
            }
          >
            <For each={activeGoals()}>
              {(goal, i) => {
                const runtime = () =>
                  state()?.runtimes.find((r) => r.goalID === goal.id)
                const isActive = () => i() === selected()
                return (
                  <box
                    flexDirection="row"
                    paddingLeft={1}
                    paddingRight={1}
                    paddingTop={0}
                    paddingBottom={0}
                    backgroundColor={isActive() ? theme().backgroundElement : undefined}
                  >
                    <text>
                      <span style={{ fg: statusColor(goal.status, theme()), bold: isActive() }}>
                        {statusIcon(goal.status)} {goal.name}
                      </span>
                      <span style={{ fg: theme().textMuted }}>{" │ "}</span>
                      <span style={{ fg: statusColor(goal.status, theme()) }}>
                        {goal.status}
                      </span>
                      {runtime() && (
                        <>
                          <span style={{ fg: theme().textMuted }}>{" │ "}</span>
                          <span style={{ fg: theme().text }}>
                            {phaseIcon(runtime()!.phase)} turn {runtime()!.turnCount}
                          </span>
                          {runtime()!.consecutiveFailures > 0 && (
                            <span style={{ fg: theme().error }}>
                              {" │ "}{runtime()!.consecutiveFailures} failures
                            </span>
                          )}
                        </>
                      )}
                    </text>
                  </box>
                )
              }}
            </For>
          </Show>
        </box>
      </Show>

      {/* Selected goal details */}
      <Show when={selectedGoal()}>
        <box flexDirection="column" border={true} borderColor="gray" padding={1}>
          <text>
            <span style={{ fg: theme().primary, bold: true }}>{selectedGoal()!.name}</span>
          </text>
          <text>
            <span style={{ fg: theme().textMuted }}>
              {selectedGoal()!.objective.slice(0, 120)}
            </span>
          </text>
          {selectedGoal()!.config.progressFile && (
            <text>
              <span style={{ fg: theme().textMuted }}>
                progress: {selectedGoal()!.config.progressFile}
              </span>
            </text>
          )}
          {selectedGoal()!.lastProgress && (
            <text>
              <span style={{ fg: theme().textMuted }}>
                last progress: {selectedGoal()!.lastProgress!.summary.slice(0, 80)}
              </span>
            </text>
          )}
        </box>
      </Show>

      {/* Event log */}
      <Show when={showLogs() && events().length > 0}>
        <box flexDirection="column" border={true} borderColor="gray" padding={1} maxHeight={8}>
          <text><span style={{ fg: theme().primary, bold: true }}>Recent Events</span></text>
          <For each={events().slice(-10)}>
            {(event) => (
              <text>
                <span style={{ fg: theme().textMuted }}>
                  {(event as any).type} {(event as any).goalID?.slice(0, 8)}
                </span>
              </text>
            )}
          </For>
        </box>
      </Show>

      {/* Status bar */}
      <box flexDirection="row" border={true} borderColor="gray" padding={0}>
        <Show
          when={mode() === "command"}
          fallback={
            <text>
              <span style={{ fg: theme().textMuted }}>
                {statusText() || " q:close  p:pause  r:resume  R:retry  x:clear  :cmd  ?help"}
              </span>
            </text>
          }
        >
          <text>
            <span style={{ fg: theme().warning }}>:{commandInput()}</span>
          </text>
        </Show>
      </box>
    </box>
  )
}
