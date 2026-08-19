// ─── TUI: Dashboard Component ────────────────────────────────────────────────
// Modal dashboard with Neovim-style keybindings.
// Centered popup, keyboard-driven, uses input for command mode.

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
import { randomUUID } from "crypto"

function prevent(evt: ParsedKey) {
  ;(evt as unknown as { preventDefault?: () => void }).preventDefault?.()
}

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
  let commandInputEl: InputRenderable | undefined

  const client = createControlClient(props.directory)

  // Focus input when entering command mode
  createEffect(() => {
    if (mode() === "command" && commandInputEl) {
      queueMicrotask(() => commandInputEl?.focus())
    }
  })

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

  // Event-driven refresh
  const unsubs = [
    props.api.event.on("session.idle", () => refresh()),
    props.api.event.on("session.status", () => refresh()),
    props.api.event.on("session.error", () => refresh()),
    props.api.event.on("session.compacted", () => refresh()),
    setInterval(refresh, 10_000),
  ]
  onCleanup(() => { for (const u of unsubs) typeof u === "function" ? u() : clearInterval(u) })

  // ─── Keyboard — useKeyboard so keys are trapped inside the dialog, not leaked to chat prompt ──
  const goals = () => state()?.goals.filter((g) => g.status !== "complete") || []

  // Push modal mode while dashboard is mounted so outer prompt doesn't receive keys
  const popMode = props.api.mode.push("loopd")
  onCleanup(() => popMode())

  useKeyboard((evt: ParsedKey) => {
    // Let the <input> handle its own keys when in command mode
    if (mode() === "command") {
      const k = (evt as unknown as { name?: string }).name
      if (k === "escape") {
        prevent(evt)
        setCommandInput("")
        setMode("normal")
        return
      }
      // Don't intercept typing — let input receive it
      return
    }

    const name = (evt as unknown as { name?: string }).name
    const raw = (evt as unknown as { raw?: string }).raw
    const key = name || raw || ""

    // Map to actions — we handle both plain and ctrl combos
    switch (key) {
      case "escape": prevent(evt); props.api.ui.dialog.clear(); break
      case "q": prevent(evt); props.api.ui.dialog.clear(); break
      case "j": case "down": prevent(evt); { const g = goals(); if (g.length) setSelected(Math.min(selected() + 1, g.length - 1)) } break
      case "k": case "up": prevent(evt); setSelected(Math.max(selected() - 1, 0)); break
      case "g": prevent(evt); setSelected(0); break
      case "G": prevent(evt); { const g = goals(); if (g.length) setSelected(g.length - 1) } break
      case "p": prevent(evt); void (async () => { const goal = selectedGoal(); if (!goal) return; const r = await client.execute({ version: 1, requestID: randomUUID(), requestedAt: new Date().toISOString(), command: "pause", goalID: goal.id }); setStatusText(r.ok ? r.message : `Error: ${r.message}`); if (r.ok) await refresh() })(); break
      case "r": prevent(evt); void (async () => { const goal = selectedGoal(); if (!goal) return; const r = await client.execute({ version: 1, requestID: randomUUID(), requestedAt: new Date().toISOString(), command: "resume", goalID: goal.id }); setStatusText(r.ok ? r.message : `Error: ${r.message}`); if (r.ok) await refresh() })(); break
      case "R": prevent(evt); void (async () => { const goal = selectedGoal(); if (!goal) return; const r = await client.execute({ version: 1, requestID: randomUUID(), requestedAt: new Date().toISOString(), command: "retry", goalID: goal.id }); setStatusText(r.ok ? r.message : `Error: ${r.message}`); if (r.ok) await refresh() })(); break
      case "x": prevent(evt); void (async () => { const goal = selectedGoal(); if (!goal) return; const r = await client.execute({ version: 1, requestID: randomUUID(), requestedAt: new Date().toISOString(), command: "clear", goalID: goal.id }); setStatusText(r.ok ? r.message : `Error: ${r.message}`); if (r.ok) await refresh() })(); break
      case "L": prevent(evt); setShowLogs(!showLogs()); break
      case ":": prevent(evt); setMode("command"); break
      case "?": prevent(evt); setMode(mode() === "help" ? "normal" : "help"); break
      case "ctrl+c": prevent(evt); props.api.ui.dialog.clear(); break
      default: break
    }
  })

  // ─── Actions ─────────────────────────────────────────────────────────────

  async function executeCommand(cmd: string) {
    const parsed = parseCommand(cmd)
    if (!parsed) return

    const route = props.api.route.current
    const ownerSessionID = route.name === "session" ? (route.params?.sessionID as string || "main") : "main"

    try {
      switch (parsed.command) {
        case "goal": {
          if (parsed.positional[0] === "start") {
            const name = parsed.positional[1] || parsed.args.name || "unnamed"
            const objective = parsed.args.objective || parsed.positional[2] || ""
            const result = await client.execute({
              version: 1,
              requestID: randomUUID(),
              requestedAt: new Date().toISOString(),
              command: "start",
              args: { name, objective, config: {}, ownerSessionID },
            })
            setStatusText(result.ok ? result.message : `Error: ${result.message}`)
            if (result.ok) await refresh()
          } else {
            setStatusText("Usage: :goal start <name> --objective <text>")
          }
          break
        }
        case "pause": {
          if (!selectedGoal()) { setStatusText("No goal selected"); break }
          const result = await client.execute({
            version: 1,
            requestID: randomUUID(),
            requestedAt: new Date().toISOString(),
            command: "pause",
            goalID: selectedGoal()!.id,
          })
          setStatusText(result.ok ? result.message : `Error: ${result.message}`)
          if (result.ok) await refresh()
          break
        }
        case "resume": {
          if (!selectedGoal()) { setStatusText("No goal selected"); break }
          const result = await client.execute({
            version: 1,
            requestID: randomUUID(),
            requestedAt: new Date().toISOString(),
            command: "resume",
            goalID: selectedGoal()!.id,
          })
          setStatusText(result.ok ? result.message : `Error: ${result.message}`)
          if (result.ok) await refresh()
          break
        }
        case "retry": {
          if (!selectedGoal()) { setStatusText("No goal selected"); break }
          const result = await client.execute({
            version: 1,
            requestID: randomUUID(),
            requestedAt: new Date().toISOString(),
            command: "retry",
            goalID: selectedGoal()!.id,
          })
          setStatusText(result.ok ? result.message : `Error: ${result.message}`)
          if (result.ok) await refresh()
          break
        }
        case "clear": {
          if (!selectedGoal()) { setStatusText("No goal selected"); break }
          const result = await client.execute({
            version: 1,
            requestID: randomUUID(),
            requestedAt: new Date().toISOString(),
            command: "clear",
            goalID: selectedGoal()!.id,
          })
          setStatusText(result.ok ? result.message : `Error: ${result.message}`)
          if (result.ok) await refresh()
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
          setStatusText(`Unknown command: ${parsed.command}. Type :help`)
        }
      }
    } catch (e) {
      setStatusText(`Error: ${e instanceof Error ? e.message : String(e)}`)
    }

    setCommandInput("")
    setMode("normal")
  }

  // ─── Active Goals ────────────────────────────────────────────────────────

  const activeGoals = () => state()?.goals.filter((g) => g.status !== "complete") || []

  // ─── Render ──────────────────────────────────────────────────────────────

  return (
    <box flexDirection="column" width="100%" alignItems="center" padding={1}>
      <box flexDirection="column" width="90%" border={true} borderColor="gray" padding={1}>
        {/* Header */}
        <box flexDirection="row" padding={0} flexShrink={0}>
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
          <box flexDirection="column" flexGrow={1} padding={1} minHeight={5}>
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
          {(goal) => (
            <box flexDirection="column" border={true} borderColor="gray" padding={1} flexShrink={0}>
              <text>
                <span style={{ fg: theme().primary, bold: true }}>{goal().name}</span>
              </text>
              <text>
                <span style={{ fg: theme().textMuted }}>
                  {goal().objective.slice(0, 120)}
                </span>
              </text>
              {goal().config.progressFile && (
                <text>
                  <span style={{ fg: theme().textMuted }}>
                    progress: {goal().config.progressFile}
                  </span>
                </text>
              )}
              {goal().lastProgress && (
                <text>
                  <span style={{ fg: theme().textMuted }}>
                    last progress: {goal().lastProgress!.summary.slice(0, 80)}
                  </span>
                </text>
              )}
            </box>
          )}
        </Show>

        {/* Event log */}
        <Show when={showLogs() && events().length > 0}>
          <box flexDirection="column" border={true} borderColor="gray" padding={1} maxHeight={8} flexShrink={0}>
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

        {/* Status bar / Command input - input captures keystrokes so they don't leak to chat */}
        <box flexDirection="row" border={true} borderColor="gray" padding={0} flexShrink={0}>
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
            <box flexDirection="row" flexGrow={1} gap={1}>
              <text><span style={{ fg: theme().warning }}>:</span></text>
              <input
                ref={(el: InputRenderable) => (commandInputEl = el)}
                placeholder="goal start my-goal --objective ..."
                placeholderColor={theme().textMuted}
                cursorColor={theme().primary}
                focusedTextColor={theme().text}
                focusedBackgroundColor={theme().background}
                onInput={(v: string) => setCommandInput(v)}
                onKeyDown={(evt: ParsedKey) => {
                  const k = (evt as unknown as { name?: string; key?: string }).name || (evt as unknown as { key?: string }).key
                  if (k === "enter" || k === "return") {
                    evt.preventDefault?.()
                    const cmd = commandInput()
                    executeCommand(cmd)
                  } else if (k === "escape") {
                    evt.preventDefault?.()
                    setCommandInput("")
                    setMode("normal")
                  }
                }}
              />
            </box>
          </Show>
        </box>
      </box>
    </box>
  )
}
