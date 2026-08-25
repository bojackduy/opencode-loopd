import type { GoalConfig } from "../domain/goal"

export interface GoalCreationDefaults {
  defaultAgent?: string
  defaultChecks?: string[]
}

export type GoalConfigResolution =
  | {
      ok: true
      config: GoalConfig
      defaultsApplied: { agent: boolean; checks: boolean }
    }
  | { ok: false; message: string; errorCode: "missing_checks" }

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

  // Safe default: any unclassified goal may touch the shared repository.
  // Artifact-only/read-only work must opt out explicitly.
  const workspaceWrite = requested.workspaceWrite ?? true
  const explicitChecks = cleanList(requested.checks)
  const defaultChecks = workspaceWrite ? cleanList(defaults.defaultChecks) : []
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
      workspaceWrite,
      checks: checks.length > 0 ? checks : undefined,
      checkCwd: requested.checkCwd || (workspaceWrite ? input.directory : undefined),
    },
    defaultsApplied: {
      agent: !explicitAgent && Boolean(defaultAgent),
      checks: explicitChecks.length === 0 && defaultChecks.length > 0,
    },
  }
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
