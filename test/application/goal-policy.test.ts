import { describe, expect, it } from "bun:test"
import { resolveGoalCreationConfig } from "../../src/application/goal-policy"

describe("goal creation policy", () => {
  it("defaults unclassified objectives to exclusive workspace writes", () => {
    for (const objective of [
      "Update dependencies",
      "Implement authentication",
      "Fix login",
      "Add a database migration",
      "Analyze the repository",
    ]) {
      const result = resolveGoalCreationConfig({
        directory: "/project",
        objective,
        config: {},
        defaults: { defaultAgent: "smart-agent", defaultChecks: ["bun test"] },
      })
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.config.workspaceWrite).toBe(true)
        expect(result.config.checks).toEqual(["bun test"])
        expect(result.config.checkCwd).toBe("/project")
      }
    }
  })

  it("allows explicit artifact-only work without project checks", () => {
    const result = resolveGoalCreationConfig({
      directory: "/project",
      objective: "Analyze the repository and write an isolated report",
      config: { workspaceWrite: false },
      defaults: { defaultAgent: "smart-agent", defaultChecks: ["bun test"] },
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.config.workspaceWrite).toBe(false)
      expect(result.config.checks).toBeUndefined()
      expect(result.config.checkCwd).toBeUndefined()
    }
  })
})
