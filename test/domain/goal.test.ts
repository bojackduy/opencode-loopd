import { describe, it, expect } from "bun:test"
import {
  createGoal,
  canTransition,
  MODEL_TRANSITIONS,
  USER_TRANSITIONS,
  SYSTEM_TRANSITIONS,
} from "../../src/domain/goal"
import type { GoalID } from "../../src/domain/goal"

describe("Goal domain", () => {
  it("creates a goal with defaults", () => {
    const goal = createGoal({
      id: "test-1" as GoalID,
      name: "test",
      objective: "do something",
      status: "active",
      ownerSessionID: "session-1",
      config: {},
    })

    expect(goal.id).toBe("test-1")
    expect(goal.name).toBe("test")
    expect(goal.status).toBe("active")
    expect(goal.tokensUsed).toBe(0)
    expect(goal.timeUsedSeconds).toBe(0)
    expect(goal.createdAt).toBeTruthy()
    expect(goal.updatedAt).toBeTruthy()
  })

  describe("canTransition", () => {
    it("allows model to complete active goal", () => {
      expect(canTransition("active", "complete", "model")).toBe(true)
    })

    it("allows model to block active goal", () => {
      expect(canTransition("active", "blocked", "model")).toBe(true)
    })

    it("rejects model from pausing goal", () => {
      expect(canTransition("active", "paused", "model")).toBe(false)
    })

    it("allows user to pause active goal", () => {
      expect(canTransition("active", "paused", "user")).toBe(true)
    })

    it("allows user to resume paused goal", () => {
      expect(canTransition("paused", "active", "user")).toBe(true)
    })

    it("allows user to resume blocked goal", () => {
      expect(canTransition("blocked", "active", "user")).toBe(true)
    })

    it("rejects user from completing goal", () => {
      expect(canTransition("active", "complete", "user")).toBe(false)
    })

    it("allows system to budget-limit active goal", () => {
      expect(canTransition("active", "budget_limited", "system")).toBe(true)
    })

    it("allows system to usage-limit active goal", () => {
      expect(canTransition("active", "usage_limited", "system")).toBe(true)
    })

    it("rejects system from pausing goal", () => {
      expect(canTransition("active", "paused", "system")).toBe(false)
    })

    it("allows model to complete budget-limited goal", () => {
      expect(canTransition("budget_limited", "complete", "model")).toBe(true)
    })

    it("allows user to restart complete goal", () => {
      expect(canTransition("complete", "active", "user")).toBe(true)
    })

    it("rejects non-user transitions from complete", () => {
      expect(canTransition("complete", "active", "model")).toBe(false)
      expect(canTransition("complete", "active", "system")).toBe(false)
    })
  })

  describe("transition tables", () => {
    it("model can only complete, block, or ask user", () => {
      expect(MODEL_TRANSITIONS.active).toEqual(["complete", "blocked", "awaiting_user"])
    })

    it("user can only pause/resume", () => {
      expect(USER_TRANSITIONS.active).toEqual(["paused"])
      expect(USER_TRANSITIONS.paused).toEqual(["active"])
    })

    it("system can budget-limit or usage-limit", () => {
      expect(SYSTEM_TRANSITIONS.active).toContain("budget_limited")
      expect(SYSTEM_TRANSITIONS.active).toContain("usage_limited")
    })
  })
})
