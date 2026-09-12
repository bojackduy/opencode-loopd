import type { GoalConfig } from "../domain/goal"

export interface GoalCreationDefaults {
  defaultAgent?: string
  defaultModel?: string
  defaultChecks?: string[]
}

export type GoalConfigResolution =
  | {
      ok: true
      config: GoalConfig
      defaultsApplied: { agent: boolean; model: boolean; checks: boolean }
    }
  | { ok: false; message: string; errorCode: "missing_checks" | "invalid_model" }

export function resolveGoalCreationConfig(input: {
  directory: string
  objective: string
  config?: GoalConfig
  defaults?: GoalCreationDefaults
}): GoalConfigResolution {
  const requested = input.config || {}
  const defaults = input.defaults || {}
  const explicitAgent = cleanText(requested.agent)
  const defaultAgent = cleanText(defaults.defaultAgent)
  // agent is optional — SDK falls back to parent session's agent when neither explicit nor default
  const agent = explicitAgent || defaultAgent || undefined

  const explicitModel = cleanText(requested.model)
  const defaultModel = cleanText(defaults.defaultModel)
  const model = explicitModel || defaultModel || undefined
  if (model && !isValidModelRef(model)) {
    return {
      ok: false,
      errorCode: "invalid_model",
      message: `Invalid model "${model}". Use "providerID/modelID" (e.g. "openai/gpt-5.6-sol", "ollama/qwen3.8:27b"). Discover with \`opencode models\`.`,
    }
  }

  // Safe default: any unclassified goal may touch the shared repository.
  // Artifact-only/read-only work must opt out explicitly.
  const workspaceWrite = requested.workspaceWrite ?? true
  const explicitChecks = cleanList(requested.checks)
  const defaultChecks = workspaceWrite ? cleanList(defaults.defaultChecks || ["bun test"]) : []
  const checks = explicitChecks.length > 0 ? explicitChecks : defaultChecks
  if (workspaceWrite && checks.length === 0) {
    return {
      ok: false,
      errorCode: "missing_checks",
      message: "Workspace-writing goals require completion checks. Pass checks or configure plugin option defaultChecks.",
    }
  }

  return {
    ok: true,
    config: {
      ...requested,
      agent,
      model,
      workspaceWrite,
      checks: checks.length > 0 ? checks : undefined,
      checkCwd: requested.checkCwd || (workspaceWrite ? input.directory : undefined),
    },
    defaultsApplied: {
      agent: !explicitAgent && Boolean(defaultAgent),
      model: !explicitModel && Boolean(defaultModel),
      checks: explicitChecks.length === 0 && defaultChecks.length > 0,
    },
  }
}

/**
 * User-facing model format is "providerID/modelID" (e.g. "openai/gpt-5.6-sol").
 * The modelID segment may itself contain slashes/colons; only the first slash
 * separates provider from model.
 */
export function isValidModelRef(value: string): boolean {
  const slash = value.indexOf("/")
  if (slash <= 0 || slash >= value.length - 1) return false
  const providerID = value.slice(0, slash).trim()
  const modelID = value.slice(slash + 1).trim()
  if (!providerID || !modelID) return false
  if (/\s/.test(providerID) || /\s/.test(modelID)) return false
  return true
}

function cleanText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed || undefined
}

function cleanList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .map(cleanText)
    .filter((item): item is string => Boolean(item))
}
