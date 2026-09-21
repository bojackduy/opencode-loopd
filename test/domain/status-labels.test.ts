import { describe, it, expect } from "bun:test"
import {
  GOAL_STATUS_META,
  PHASE_META,
  goalStatusLabel,
  phaseLabel,
  describeGoalState,
} from "../../src/domain/status-labels"

describe("status labels", () => {
  it("labels every goal status with a short + hint", () => {
    for (const [key, meta] of Object.entries(GOAL_STATUS_META)) {
      expect(meta.short.trim().length).toBeGreaterThan(0)
      expect(meta.hint.trim().length).toBeGreaterThan(0)
      expect(goalStatusLabel(key).short).toBe(meta.short)
    }
  })

  it("labels every runtime phase with a short + hint", () => {
    for (const [key, meta] of Object.entries(PHASE_META)) {
      expect(meta.short.trim().length).toBeGreaterThan(0)
      expect(meta.hint.trim().length).toBeGreaterThan(0)
      expect(phaseLabel(key).short).toBe(meta.short)
    }
  })

  it("falls back to the raw value for unknown codes", () => {
    expect(goalStatusLabel("mystery").short).toBe("mystery")
    expect(phaseLabel("unknown").short).toBe("unknown")
  })

  it("describes the owned + acting combo", () => {
    expect(describeGoalState("active", "running")).toBe(
      "Loopd owns this; worker is worker acting now.",
    )
  })

  it("describes parked goals as needing the owner", () => {
    expect(describeGoalState("blocked", "idle")).toContain("Parked")
    expect(describeGoalState("blocked", "idle")).toContain("needs you")
    expect(describeGoalState("complete", "idle")).toContain("Done")
  })
})
