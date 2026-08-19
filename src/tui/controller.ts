// ─── TUI: Controller ─────────────────────────────────────────────────────────
// Testable controller for dashboard actions. Separated from rendering.

import { randomUUID } from "crypto"
import type { ControlClient } from "../infrastructure/control-client"
import type { StoreState } from "../infrastructure/state-repository"
import type { Goal } from "../domain/goal"

export interface DashboardState {
  goals: Goal[]
  selected: number
  activeGoals: Goal[]
  selectedGoal: Goal | null
  statusText: string
  showLogs: boolean
}

export interface ControllerResult {
  statusText: string
  needsRefresh: boolean
}

export interface DashboardController {
  /** Refresh state from the control client. */
  refresh(): Promise<DashboardState>

  /** Move selection down. */
  moveDown(state: DashboardState): DashboardState

  /** Move selection up. */
  moveUp(state: DashboardState): DashboardState

  /** Move to first goal. */
  moveFirst(state: DashboardState): DashboardState

  /** Move to last goal. */
  moveLast(state: DashboardState): DashboardState

  /** Start a new goal. */
  startGoal(ownerSessionID: string, name: string, objective: string): Promise<ControllerResult>

  /** Pause the selected goal. */
  pauseGoal(goal: Goal): Promise<ControllerResult>

  /** Resume the selected goal. */
  resumeGoal(goal: Goal): Promise<ControllerResult>

  /** Retry the selected goal. */
  retryGoal(goal: Goal): Promise<ControllerResult>

  /** Clear the selected goal. */
  clearGoal(goal: Goal): Promise<ControllerResult>

  /** Toggle log view. */
  toggleLogs(state: DashboardState): DashboardState

  /** Execute a parsed command. */
  executeCommand(
    command: string,
    args: Record<string, string>,
    positional: string[],
    state: DashboardState,
    ownerSessionID: string,
  ): Promise<ControllerResult>
}

export function createDashboardController(client: ControlClient): DashboardController {
  async function refresh(): Promise<DashboardState> {
    const s = await client.getState()
    const activeGoals = s.goals.filter((g) => g.status !== "complete")
    return {
      goals: s.goals,
      selected: 0,
      activeGoals,
      selectedGoal: activeGoals[0] || null,
      statusText: "",
      showLogs: false,
    }
  }

  function moveDown(state: DashboardState): DashboardState {
    if (state.activeGoals.length === 0) return state
    const next = Math.min(state.selected + 1, state.activeGoals.length - 1)
    return { ...state, selected: next, selectedGoal: state.activeGoals[next] || null }
  }

  function moveUp(state: DashboardState): DashboardState {
    if (state.activeGoals.length === 0) return state
    const next = Math.max(state.selected - 1, 0)
    return { ...state, selected: next, selectedGoal: state.activeGoals[next] || null }
  }

  function moveFirst(state: DashboardState): DashboardState {
    return { ...state, selected: 0, selectedGoal: state.activeGoals[0] || null }
  }

  function moveLast(state: DashboardState): DashboardState {
    if (state.activeGoals.length === 0) return state
    const last = state.activeGoals.length - 1
    return { ...state, selected: last, selectedGoal: state.activeGoals[last] || null }
  }

  async function startGoal(ownerSessionID: string, name: string, objective: string): Promise<ControllerResult> {
    const result = await client.execute({
      version: 1,
      requestID: randomUUID(),
      requestedAt: new Date().toISOString(),
      command: "start",
      args: { name, objective, config: {}, ownerSessionID },
    })
    return {
      statusText: result.ok ? result.message : `Error: ${result.message}`,
      needsRefresh: true,
    }
  }

  async function pauseGoal(goal: Goal): Promise<ControllerResult> {
    const result = await client.execute({
      version: 1,
      requestID: randomUUID(),
      requestedAt: new Date().toISOString(),
      command: "pause",
      goalID: goal.id,
    })
    return {
      statusText: result.ok ? result.message : `Error: ${result.message}`,
      needsRefresh: true,
    }
  }

  async function resumeGoal(goal: Goal): Promise<ControllerResult> {
    const result = await client.execute({
      version: 1,
      requestID: randomUUID(),
      requestedAt: new Date().toISOString(),
      command: "resume",
      goalID: goal.id,
    })
    return {
      statusText: result.ok ? result.message : `Error: ${result.message}`,
      needsRefresh: true,
    }
  }

  async function retryGoal(goal: Goal): Promise<ControllerResult> {
    const result = await client.execute({
      version: 1,
      requestID: randomUUID(),
      requestedAt: new Date().toISOString(),
      command: "retry",
      goalID: goal.id,
    })
    return {
      statusText: result.ok ? result.message : `Error: ${result.message}`,
      needsRefresh: true,
    }
  }

  async function clearGoal(goal: Goal): Promise<ControllerResult> {
    const result = await client.execute({
      version: 1,
      requestID: randomUUID(),
      requestedAt: new Date().toISOString(),
      command: "clear",
      goalID: goal.id,
    })
    return {
      statusText: result.ok ? result.message : `Error: ${result.message}`,
      needsRefresh: true,
    }
  }

  function toggleLogs(state: DashboardState): DashboardState {
    return { ...state, showLogs: !state.showLogs }
  }

  async function executeCommand(
    command: string,
    args: Record<string, string>,
    positional: string[],
    state: DashboardState,
    ownerSessionID: string,
  ): Promise<ControllerResult> {
    switch (command) {
      case "goal": {
        if (positional[0] === "start") {
          const name = positional[1] || args.name || "unnamed"
          const objective = args.objective || positional[2] || ""
          return startGoal(ownerSessionID, name, objective)
        }
        return { statusText: "Usage: :goal start <name> --objective <text>", needsRefresh: false }
      }
      case "pause": {
        if (!state.selectedGoal) return { statusText: "No goal selected", needsRefresh: false }
        return pauseGoal(state.selectedGoal)
      }
      case "resume": {
        if (!state.selectedGoal) return { statusText: "No goal selected", needsRefresh: false }
        return resumeGoal(state.selectedGoal)
      }
      case "retry": {
        if (!state.selectedGoal) return { statusText: "No goal selected", needsRefresh: false }
        return retryGoal(state.selectedGoal)
      }
      case "clear": {
        if (!state.selectedGoal) return { statusText: "No goal selected", needsRefresh: false }
        return clearGoal(state.selectedGoal)
      }
      case "logs": {
        return { statusText: "", needsRefresh: false }
      }
      case "help": {
        return { statusText: "", needsRefresh: false }
      }
      case "q":
      case "close": {
        return { statusText: "close", needsRefresh: false }
      }
      default: {
        return { statusText: `Unknown command: ${command}. Type :help for available commands.`, needsRefresh: false }
      }
    }
  }

  return {
    refresh,
    moveDown,
    moveUp,
    moveFirst,
    moveLast,
    startGoal,
    pauseGoal,
    resumeGoal,
    retryGoal,
    clearGoal,
    toggleLogs,
    executeCommand,
  }
}
