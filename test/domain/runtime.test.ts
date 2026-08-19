import { describe, it, expect } from "bun:test"
import {
  createRuntimeState,
  acquireLease,
  releaseLease,
  leaseIsValid,
} from "../../src/domain/runtime"
import type { GoalID } from "../../src/domain/goal"

describe("Runtime domain", () => {
  it("creates runtime state with defaults", () => {
    const rt = createRuntimeState("goal-1" as GoalID)
    expect(rt.goalID).toBe("goal-1")
    expect(rt.phase).toBe("idle")
    expect(rt.consecutiveFailures).toBe(0)
    expect(rt.runCount).toBe(0)
    expect(rt.turnCount).toBe(0)
    expect(rt.noProgressCount).toBe(0)
  })

  describe("lease management", () => {
    it("acquires a lease with expiry", () => {
      const rt = createRuntimeState("goal-1" as GoalID)
      const leased = acquireLease(rt, 30_000)

      expect(leased.phase).toBe("running")
      expect(leased.leaseExpiresAt).toBeTruthy()
      expect(leaseIsValid(leased)).toBe(true)
    })

    it("releases a lease", () => {
      const rt = createRuntimeState("goal-1" as GoalID)
      const leased = acquireLease(rt, 30_000)
      const released = releaseLease(leased)

      expect(released.phase).toBe("idle")
      expect(released.leaseExpiresAt).toBeUndefined()
      expect(leaseIsValid(released)).toBe(false)
    })

    it("rejects expired lease", () => {
      const rt = createRuntimeState("goal-1" as GoalID)
      // Acquire with 0ms timeout — already expired
      const leased = acquireLease(rt, 0)
      // Wait a tick to ensure expiry
      const expired = { ...leased, leaseExpiresAt: new Date(Date.now() - 1000).toISOString() }
      expect(leaseIsValid(expired)).toBe(false)
    })

    it("rejects lease without expiry", () => {
      const rt = createRuntimeState("goal-1" as GoalID)
      expect(leaseIsValid(rt)).toBe(false)
    })
  })
})
