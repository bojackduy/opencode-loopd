import { describe, it, expect } from "bun:test"
import {
  createGoal,
  canTransition,
  isTerminal,
  isRunning,
  type GoalStatus,
} from "../../src/domain/goal"
import {
  createRuntimeState,
  acquireLease,
  releaseLease,
  leaseIsValid,
  markProgress,
} from "../../src/domain/runtime"

describe("Goal Domain", () => {
  describe("createGoal", () => {
    it("creates goal with defaults", () => {
      const goal = createGoal({
        id: "g1" as any,
        name: "test",
        objective: "obj",
        status: "active",
        ownerSessionID: "s1",
        config: {},
      })

      expect(goal.tokensUsed).toBe(0)
      expect(goal.timeUsedSeconds).toBe(0)
      expect(goal.createdAt).toBeTruthy()
      expect(goal.updatedAt).toBeTruthy()
    })
  })

  describe("canTransition", () => {
    it("allows active -> complete (model)", () => {
      expect(canTransition("active", "complete", "model")).toBe(true)
    })

    it("blocks active -> paused (model)", () => {
      expect(canTransition("active", "paused", "model")).toBe(false)
    })

    it("allows active -> paused (user)", () => {
      expect(canTransition("active", "paused", "user")).toBe(true)
    })

    it("blocks paused -> complete (user)", () => {
      expect(canTransition("paused", "complete", "user")).toBe(false)
    })

    it("allows paused -> active (user)", () => {
      expect(canTransition("paused", "active", "user")).toBe(true)
    })
  })

  describe("isTerminal", () => {
    it("returns true for complete", () => {
      expect(isTerminal("complete")).toBe(true)
    })

    it("returns false for active", () => {
      expect(isTerminal("active")).toBe(false)
    })
  })

  describe("isRunning", () => {
    it("returns true for active", () => {
      expect(isRunning("active")).toBe(true)
    })

    it("returns true for blocked", () => {
      expect(isRunning("blocked")).toBe(true)
    })

    it("returns false for paused", () => {
      expect(isRunning("paused")).toBe(false)
    })

    it("returns false for complete", () => {
      expect(isRunning("complete")).toBe(false)
    })
  })
})

describe("Runtime Domain", () => {
  describe("createRuntimeState", () => {
    it("creates runtime with defaults", () => {
      const rt = createRuntimeState("g1" as any)

      expect(rt.phase).toBe("idle")
      expect(rt.consecutiveFailures).toBe(0)
      expect(rt.turnCount).toBe(0)
      expect(rt.noProgressCount).toBe(0)
      expect(rt.progressDuringTurn).toBe(false)
    })
  })

  describe("acquireLease", () => {
    it("sets phase to running with valid lease", () => {
      const rt = createRuntimeState("g1" as any)
      const leased = acquireLease(rt, 60_000)

      expect(leased.phase).toBe("running")
      expect(leased.leaseExpiresAt).toBeTruthy()
      expect(leased.turnStartedAt).toBeTruthy()
      expect(leased.progressDuringTurn).toBe(false)
    })
  })

  describe("releaseLease", () => {
    it("sets phase to idle and clears lease", () => {
      const rt = createRuntimeState("g1" as any)
      const leased = acquireLease(rt, 60_000)
      const released = releaseLease(leased)

      expect(released.phase).toBe("idle")
      expect(released.leaseExpiresAt).toBeUndefined()
      expect(released.turnStartedAt).toBeUndefined()
    })
  })

  describe("leaseIsValid", () => {
    it("returns false for no lease", () => {
      const rt = createRuntimeState("g1" as any)
      expect(leaseIsValid(rt)).toBe(false)
    })

    it("returns true for future lease", () => {
      const rt = createRuntimeState("g1" as any)
      const leased = acquireLease(rt, 60_000)
      expect(leaseIsValid(leased)).toBe(true)
    })
  })

  describe("markProgress", () => {
    it("sets progressDuringTurn to true", () => {
      const rt = createRuntimeState("g1" as any)
      const marked = markProgress(rt)

      expect(marked.progressDuringTurn).toBe(true)
      expect(marked.lastProgressAt).toBeTruthy()
    })
  })
})
