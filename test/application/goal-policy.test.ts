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

  it("passes through an explicit agent and model", () => {
    const result = resolveGoalCreationConfig({
      directory: "/project",
      objective: "Research and report",
      config: { workspaceWrite: false, agent: "researcher", model: "ollama/qwen3.8:27b" },
      defaults: {},
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.config.agent).toBe("researcher")
      expect(result.config.model).toBe("ollama/qwen3.8:27b")
      expect(result.defaultsApplied).toEqual({ agent: false, model: false, checks: false })
    }
  })

  it("falls back to defaultModel when no explicit model", () => {
    const result = resolveGoalCreationConfig({
      directory: "/project",
      objective: "Research and report",
      config: { workspaceWrite: false },
      defaults: { defaultModel: "openai/gpt-5.6-sol" },
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.config.model).toBe("openai/gpt-5.6-sol")
      expect(result.defaultsApplied.model).toBe(true)
    }
  })

  it("rejects malformed model strings", () => {
    for (const model of ["gpt-5", "openai/", "/gpt-5", "open ai/gpt-5"]) {
      const result = resolveGoalCreationConfig({
        directory: "/project",
        objective: "Research and report",
        config: { workspaceWrite: false, model },
        defaults: {},
      })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.errorCode).toBe("invalid_model")
    }
  })
})
