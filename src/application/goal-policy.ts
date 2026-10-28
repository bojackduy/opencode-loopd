import type { GoalConfig } from "../domain/goal"

export interface GoalCreationDefaults {
  defaultAgent?: string
  defaultModel?: string
  defaultChecks?: string[]
  /** Parent session identity, read live at creation. Overrides static defaults. */
  parentAgent?: string
  parentModel?: string
}

export type GoalConfigResolution =
  | {
      ok: true
      config: GoalConfig
      defaultsApplied: { agent: boolean; model: boolean; checks: boolean }
    }
  | { ok: false; message: string; errorCode: "missing_checks" | "invalid_model" }

/**
 * Conservatively identify explicit file references in the objective. This is
 * not a filesystem scope validator: GoalService canonicalizes the result.
 * Unnamed/broad objectives retain legacy exclusive ownership.
 */
export function inferNamedFileWriteScope(objective: string, directory?: string): string[] | undefined {
  const matches = objective.matchAll(/(?<![\w./:@-])(?:\.\/)?(?:[\w.-]+\/)*[\w.-]+\.(?:tsx?|jsx?|mjs|cjs|jsonc?|md|py|go|rs|java|kt|c|cc|cpp|h|hpp|cs|sh|ya?ml|toml|css|scss|html|sql|vue|svelte|xml|txt|proto|gradle|lock)\b/g)
  let paths = [...new Set([...matches].map((match) => match[0]!.replace(/^\.\//, "")))].sort()
  // Filter obvious cross-repo noise: paths like opencode-fleet/src/...
  // that reference another repo name inside this workspace's objective.
  // Keep single-segment files and any path whose top-level looks like a
  // workspace dir (src, lib, test, docs, assets, etc.) or actually exists.
  // Don't filter on filesystem existence alone — new files in new dirs (e.g.
  // src/a.ts in a temp test dir) would be wrongly dropped.
  if (directory && paths.some((p) => p.includes("/"))) {
    try {
      const fs = require("node:fs") as typeof import("node:fs")
      const path = require("node:path") as typeof import("node:path")
      const externalPrefix = /^(opencode-|fleet|voice|loopd)/i
      paths = paths.filter((p) => {
        if (!p.includes("/")) return true
        const top = p.split("/")[0]!
        if (externalPrefix.test(top)) {
          try { fs.statSync(path.join(directory, top)); return true } catch { return false }
        }
        return true
      })
    } catch { /* fallback: keep all */ }
  }
  return paths.length ? paths : undefined
}

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
  const parentAgent = cleanText(defaults.parentAgent)
  // Resolution: explicit > live parent identity > static default.
  // When nothing is set, config.agent stays undefined and OpenCode falls back
  // to its global default agent on each prompt.
  const agent = explicitAgent || parentAgent || defaultAgent || undefined

  const explicitModel = cleanText(requested.model)
  const defaultModel = cleanText(defaults.defaultModel)
  const parentModel = cleanText(defaults.parentModel)
  const model = explicitModel || parentModel || defaultModel || undefined
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
      agent: !explicitAgent && Boolean(parentAgent || defaultAgent),
      model: !explicitModel && Boolean(parentModel || defaultModel),
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
