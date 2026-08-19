// ─── TUI: Dashboard Component ────────────────────────────────────────────────
// Functional modal dashboard with Neovim-style keybindings.
// Modes: NORMAL, COMMAND, FORM, CONFIRM, HELP

/** @jsxImportSource @opentui/solid */
import { createSignal, For, Show, onCleanup, onMount } from "solid-js"
import type { TuiPluginApi, TuiThemeCurrent } from "@opencode-ai/plugin/tui"
import { readState, readEvents } from "../infrastructure/state-store"
import { createControlClient } from "../infrastructure/control-client"
import type { StoreState } from "../infrastructure/state-store"
import type { Goal, GoalStatus } from "../domain/goal"
import type { GoalRuntimeState, RuntimePhase } from "../domain/runtime"
import { parseCommand, commandHelp } from "./command-parser"
import { randomUUID } from "crypto"

type Mode = "normal" | "command" | "form" | "confirm" | "help"

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
  const [confirmAction, setConfirmAction] = createSignal<(() => Promise<void>) | null>(null)

  const client = createControlClient(props.directory)

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

    try {
      switch (parsed.command) {
        case "goal": {
          if (parsed.args._1 === "start") {
            const name = parsed.args._2 || parsed.args.name || "unnamed"
            const objective = parsed.args.objective || parsed.args._3 || ""
            const result = await client.execute({
              version: 1,
              requestID: randomUUID(),
              requestedAt: new Date().toISOString(),
              command: "start",
              args: { name, objective, config: {} },
            })
            setStatusText(result.ok ? result.message : `Error: ${result.message}`)
          }
          break
        }
        case "pause": {
          const goal = selectedGoal()
          if (!goal) { setStatusText("No goal selected"); break }
          const result = await client.execute({
            version: 1,
            requestID: randomUUID(),
            requestedAt: new Date().toISOString(),
            command: "pause",
            goalID: goal.id,
          })
          setStatusText(result.ok ? result.message : `Error: ${result.message}`)
          break
        }
        case "resume": {
          const goal = selectedGoal()
          if (!goal) { setStatusText("No goal selected"); break }
          const result = await client.execute({
            version: 1,
            requestID: randomUUID(),
            requestedAt: new Date().toISOString(),
            command: "resume",
            goalID: goal.id,
          })
          setStatusText(result.ok ? result.message : `Error: ${result.message}`)
          break
        }
        case "retry": {
          const goal = selectedGoal()
          if (!goal) { setStatusText("No goal selected"); break }
          const result = await client.execute({
            version: 1,
            requestID: randomUUID(),
            requestedAt: new Date().toISOString(),
            command: "retry",
            goalID: goal.id,
          })
          setStatusText(result.ok ? result.message : `Error: ${result.message}`)
          break
        }
        case "clear": {
          const goal = selectedGoal()
          if (!goal) { setStatusText("No goal selected"); break }
          setConfirmAction(() => async () => {
            const result = await client.execute({
              version: 1,
              requestID: randomUUID(),
              requestedAt: new Date().toISOString(),
              command: "clear",
              goalID: goal.id,
            })
            setStatusText(result.ok ? result.message : `Error: ${result.message}`)
          })
          setMode("confirm")
          break
        }
        case "logs": {
          setShowLogs(!showLogs())
          break
        }
        case "help": {
          setMode("help")
          break
        }
        case "q":
        case "close": {
          props.api.ui.dialog.clear()
          return
        }
        default: {
          setStatusText(`Unknown command: ${parsed.command}. Type :help for available commands.`)
        }
      }
    } catch (e) {
      setStatusText(`Error: ${e instanceof Error ? e.message : String(e)}`)
    }

    await refresh()
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
