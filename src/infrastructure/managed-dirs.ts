// ─── Infrastructure: Managed Dirs ────────────────────────────────────────────
// Single resolver for every multi-project view: instance directory first,
// then registry file (.opencode/loopd/managed.json), then LOOPD_MANAGED_DIRS
// env, then explicit extras. Resolved absolute, deduped. Single-dir default:
// with no registry/env/extra the result is just [instanceDir].

import { promises as fs } from "fs"
import path from "path"

const REGISTRY_VERSION = 1

interface ManagedRegistry {
  version: number
  dirs: string[]
}

export interface ResolveManagedDirsOptions {
  /** Explicit extra directories (highest precedence, appended last). */
  extra?: string[]
  /** Raw LOOPD_MANAGED_DIRS value; defaults to process.env when omitted. */
  env?: string
}

function registryFile(instanceDir: string): string {
  return path.join(instanceDir, ".opencode", "loopd", "managed.json")
}

function normalizeDir(input: string): string {
  return path.normalize(input)
}

function resolveEntry(instanceDir: string, entry: string): string {
  if (path.isAbsolute(entry)) return normalizeDir(entry)
  return normalizeDir(path.resolve(instanceDir, entry))
}

async function readRegistry(instanceDir: string): Promise<ManagedRegistry> {
  try {
    const raw = await fs.readFile(registryFile(instanceDir), "utf8")
    const parsed = JSON.parse(raw) as Partial<ManagedRegistry>
    const dirs = Array.isArray(parsed.dirs) ? parsed.dirs.filter((d): d is string => typeof d === "string" && d.trim().length > 0) : []
    return { version: REGISTRY_VERSION, dirs }
  } catch (error: any) {
    if (error?.code === "ENOENT") return { version: REGISTRY_VERSION, dirs: [] }
    throw error
  }
}

/** Parse LOOPD_MANAGED_DIRS (colon-separated, like PATH). Empty → []. */
export function parseManagedDirsEnv(envValue?: string): string[] {
  const raw: unknown = envValue !== undefined ? envValue : (process as any)?.env?.LOOPD_MANAGED_DIRS
  if (typeof raw !== "string" || !raw) return []
  const sep = path.delimiter
  return raw.split(sep).map((s: string) => s.trim()).filter(Boolean)
}

/**
 * The one resolver. Instance dir first, then registry entries, then env
 * dirs, then explicit extras — each resolved against the instance dir,
 * absolute, deduped, order-preserving.
 */
export async function resolveManagedDirs(
  instanceDir: string,
  opts: ResolveManagedDirsOptions = {},
): Promise<string[]> {
  const root = normalizeDir(path.resolve(instanceDir))
  const seen = new Set<string>([root])
  const result = [root]
  const push = (entry: string) => {
    const trimmed = entry.trim()
    if (!trimmed) return
    const resolved = resolveEntry(root, trimmed)
    if (!seen.has(resolved)) {
      seen.add(resolved)
      result.push(resolved)
    }
  }
  const registry = await readRegistry(instanceDir)
  for (const entry of registry.dirs) push(entry)
  for (const entry of parseManagedDirsEnv(opts.env)) push(entry)
  for (const entry of opts.extra ?? []) push(entry)
  return result
}

/** Registry-only view (instance dir first). Same as resolve with no env/extra. */
export async function listManagedDirs(instanceDir: string): Promise<string[]> {
  const root = normalizeDir(path.resolve(instanceDir))
  const seen = new Set<string>([root])
  const result = [root]
  const registry = await readRegistry(instanceDir)
  for (const entry of registry.dirs) {
    const resolved = resolveEntry(root, entry.trim())
    if (!seen.has(resolved)) {
      seen.add(resolved)
      result.push(resolved)
    }
  }
  return result
}

/** Add a directory to the registry. Returns the updated managed list. */
export async function addManagedDir(instanceDir: string, dir: string): Promise<string[]> {
  if (typeof dir !== "string" || !dir.trim()) throw new Error("dir must be a non-empty path")
  const root = normalizeDir(path.resolve(instanceDir))
  const resolved = resolveEntry(root, dir.trim())
  const registry = await readRegistry(instanceDir)
  const entries = registry.dirs.map((d) => resolveEntry(root, d.trim()))
  if (!entries.includes(resolved)) entries.push(resolved)
  // Store as absolute paths for portability across cwd changes.
  const payload = JSON.stringify({ version: REGISTRY_VERSION, dirs: entries }, null, 2)
  const target = registryFile(instanceDir)
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(target, payload, "utf8")
  return listManagedDirs(instanceDir)
}
