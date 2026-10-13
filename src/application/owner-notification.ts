import type { GoalService } from "./goal-service"
import type { LoopHost } from "../server/host-adapter"
import { readState } from "../infrastructure/state-repository"
import { logServerEvent } from "../infrastructure/server-log"

/** Worker notifications share tracked delivery; ordinary owners retain host delivery. */
export async function deliverOwnerNotification(directory: string, host: Pick<LoopHost, "notifyOwner">, goals: GoalService, sessionID: string, message: string, agent?: string): Promise<boolean> {
  const state = await readState(directory)
  if (state.retiredWorkerSessions?.includes(sessionID)) return false
  const goal = state.goals.find((item) => item.workerSessionID === sessionID)
  if (goal) {
    // Raw parent notification injection changes assistant ancestry without
    // changing the engine's prompt anchor. Queue behind busy/live tools; use
    // the existing fenced send path when idle, preserving run correlation.
    const result = await goals.sendUserMessage(directory, goal.id, message)
    await logServerEvent(directory, "worker.notification", { goalID: goal.id, workerSessionID: sessionID, outcome: result.outcome })
    return result.ok
  }
  return (await host.notifyOwner(sessionID, message, agent)) !== false
}
