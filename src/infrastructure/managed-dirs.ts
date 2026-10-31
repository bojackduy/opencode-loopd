// ─── Infrastructure: Managed Dirs ────────────────────────────────────────────
// Registry of additional project directories whose goals are visible via
// owner tools. Single-dir behavior stays default: the instance directory is
// always first and the registry is opt-in.

import { promises as fs } from "fs"
import path from "path"

const REGISTRY_VERSION = 1

interface ManagedRegistry {
  version: number
  dirs: string[]
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

/** Instance directory first, then registry entries (resolved, deduped). */
export async function listManagedDirs(instanceDir: string): Promise<string[]> {
  const root = normalizeDir(path.resolve(instanceDir))
  const registry = await readRegistry(instanceDir)
  const seen = new Set<string>([root])
  const result = [root]
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
