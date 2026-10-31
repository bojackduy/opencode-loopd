// ─── Server: Managed Status ──────────────────────────────────────────────────
// CLI-first multi-project view helper. Single-dir default stays intact:
// resolveManagedDirs(current) === [current] unless extra dirs are given
// (env LOOPD_MANAGED_DIRS or explicit args).

import path from "path"
import { readState } from "../infrastructure/state-repository"

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

/** Dedupe preserving order. Empty strings dropped. */
export function resolveManagedDirs(currentDir: string, extra?: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const dir of [currentDir, ...(extra ?? [])]) {
    if (!dir) continue
    const normalized = path.resolve(dir)
    if (seen.has(normalized)) continue
    seen.add(normalized)
    out.push(dir)
  }
  return out
}

/** Parse LOOPD_MANAGED_DIRS (colon-separated, like PATH). Empty → []. */
export function parseManagedDirsEnv(envValue?: string): string[] {
  if (!envValue) return []
  const sep = path.delimiter
  return envValue.split(sep).map((s) => s.trim()).filter(Boolean)
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
  const dirs = resolveManagedDirs(managedDirs[0] ?? ".", managedDirs.slice(1))
  const out: ManagedDirStatus[] = []
  for (const dir of dirs) {
    out.push(await statusForDirectory(dir))
  }
  return out
}
