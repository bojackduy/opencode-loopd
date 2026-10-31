// ─── Server: Managed Status ──────────────────────────────────────────────────
// CLI-first multi-project view helper. Thin wrapper over the single resolver
// in ../infrastructure/managed-dirs (registry file + env + explicit).
// Single-dir default stays intact: with no registry/env/extra the result is
// just [currentDir].

import path from "path"
import { readState } from "../infrastructure/state-repository"
import {
  parseManagedDirsEnv as parseEnv,
  resolveManagedDirs as resolveInfra,
} from "../infrastructure/managed-dirs"

export interface ManagedBlockedItem {
  goalID: string
  name: string
  reason: string
  needed: string
}

export interface ManagedDirStatus {
  directory: string
  storePath: string
  total: number
  active: number
  blocked: number
  paused: number
  complete: number
  blockedItems: ManagedBlockedItem[]
  error?: string
}

export function managedStorePath(directory: string): string {
  return path.join(directory, ".opencode", "loopd")
}

/** Parse LOOPD_MANAGED_DIRS (colon-separated, like PATH). Empty → []. */
export function parseManagedDirsEnv(envValue?: string): string[] {
  return parseEnv(envValue)
}

/**
 * Resolve managed dirs for a dashboard instance: instance dir first, then
 * registry (.opencode/loopd/managed.json), env, explicit extras.
 */
export async function resolveManagedDirs(
  currentDir: string,
  extra?: string[],
): Promise<string[]> {
  return resolveInfra(currentDir, { extra })
}

export async function statusForDirectory(directory: string): Promise<ManagedDirStatus> {
  const storePath = managedStorePath(directory)
  try {
    const state = await readState(directory)
    const goals = state.goals ?? []
    const blockedGoals = goals.filter((g) => g.status === "blocked")
    return {
      directory,
      storePath,
      total: goals.length,
      active: goals.filter((g) => g.status === "active").length,
      blocked: blockedGoals.length,
      paused: goals.filter((g) => g.status === "paused").length,
      complete: goals.filter((g) => g.status === "complete").length,
      blockedItems: blockedGoals.map((g) => ({
        goalID: g.id,
        name: g.name,
        reason: g.blocker?.reason ?? "blocked",
        needed: g.blocker?.needed ?? "",
      })),
    }
  } catch (error) {
    return {
      directory,
      storePath,
      total: 0,
      active: 0,
      blocked: 0,
      paused: 0,
      complete: 0,
      blockedItems: [],
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/** Read state per dir. Never throws: per-dir failures land on `error`. */
export async function statusAll(managedDirs: string[]): Promise<ManagedDirStatus[]> {
  const out: ManagedDirStatus[] = []
  for (const dir of managedDirs.length > 0 ? managedDirs : ["."]) {
    out.push(await statusForDirectory(dir))
  }
  return out
}
