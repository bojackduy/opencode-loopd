import type { GoalID } from "../domain/goal"
import { mutateState } from "../infrastructure/state-repository"
import { canonicalWriteScope, findScopeConflict, scopeConflictMessage, type ScopeConflict } from "../infrastructure/workspace-scope"
import { assertScopeAvailable, heldGoals } from "./workspace-execution"

export class GoalScopeConflictError extends Error {
  constructor(readonly conflict: ScopeConflict, readonly kind: "initial" | "expansion") {
    super(scopeConflictMessage(conflict))
    this.name = "GoalScopeConflictError"
  }
}

/** Additive, all-or-nothing claims. Session and generation are checked under the state lock. */
export async function claimGoalScope(
  directory: string,
  goalID: GoalID,
  workerSessionID: string,
  generation: number,
  paths: string[],
): Promise<string[]> {
  let claimed: string[] = []
  await mutateState(directory, `goal.claim-scope:${goalID}`, async (state) => {
    const goal = state.goals.find((item) => item.id === goalID)
    const runtime = state.runtimes.find((item) => item.goalID === goalID)
    if (!goal || goal.workerSessionID !== workerSessionID || runtime?.runGeneration !== generation) {
      throw new Error("Scope claim denied: stale worker session or run generation. Read get_goal before claiming.")
    }
    if (goal.status !== "active") throw new Error(`Scope claim denied: goal is ${goal.status}, not active.`)
    if (goal.config.workspaceWrite === false) throw new Error("Read-only/artifact goals cannot claim shared workspace files.")
    if (goal.config.write_scope === undefined) throw new Error("Legacy whole-workspace goals already own the workspace; explicit scopes must be selected at creation.")
    const additions = await canonicalWriteScope(directory, paths)
    claimed = [...new Set([...goal.config.write_scope, ...additions])].sort()
    const candidate = { ...goal, config: { ...goal.config, write_scope: claimed } }
    const conflict = findScopeConflict(heldGoals(state).map((owner) => ({ ...owner, status: "active" })), candidate)
    if (conflict) throw new GoalScopeConflictError(conflict, goal.config.write_scope.length === 0 ? "initial" : "expansion")
    assertScopeAvailable(state, candidate)
    goal.config.write_scope = claimed
    goal.updatedAt = new Date().toISOString()
    return state
  })
  return claimed
}
