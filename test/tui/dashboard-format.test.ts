import { describe, expect, it } from "bun:test"
import { agentColor, formatCost, formatDuration, formatTokens, indexAgents } from "../../src/tui/dashboard"

describe("Dashboard formatting", () => {
  it("compacts token counts", () => {
    expect(formatTokens(undefined)).toBe("0")
    expect(formatTokens(0)).toBe("0")
    expect(formatTokens(99)).toBe("99")
    expect(formatTokens(80811)).toBe("80.8k")
    expect(formatTokens(322456)).toBe("322.5k")
    expect(formatTokens(24048111)).toBe("24.05M")
  })

  it("formats cost like OpenCode", () => {
    expect(formatCost(undefined)).toBe("$0.00")
    expect(formatCost(0)).toBe("$0.00")
    expect(formatCost(0.02514021)).toBe("$0.03")
    expect(formatCost(0.0012)).toBe("$0.0012")
    expect(formatCost(1.5)).toBe("$1.50")
  })

  it("formats durations", () => {
    expect(formatDuration(undefined)).toBe("0s")
    expect(formatDuration(0)).toBe("0s")
    expect(formatDuration(19)).toBe("19s")
    expect(formatDuration(180)).toBe("3m")
    expect(formatDuration(5400)).toBe("1.5h")
  })

  it("indexes agents by exact and lowercase name", () => {
    const index = indexAgents([
      { name: "Nature", color: "accent", mode: "primary" },
      { name: "researcher", color: "#00ff00", mode: "subagent" },
    ])
    expect(index["Nature"].mode).toBe("primary")
    expect(index["nature"].color).toBe("accent")
    expect(index["RESEARCHER"]).toBeUndefined()
    expect(index["researcher"].color).toBe("#00ff00")
  })

  it("resolves theme names and hex colors, falls back to text", () => {
    const theme = { text: "t", primary: "p", accent: "a", success: "s", warning: "w", error: "e", info: "i" } as any
    expect(agentColor("accent", theme)).toBe("a")
    expect(agentColor("#FFFFFF", theme)).toBe("#FFFFFF")
    expect(agentColor(undefined, theme)).toBe("t")
    expect(agentColor("nope", theme)).toBe("t")
  })
})
