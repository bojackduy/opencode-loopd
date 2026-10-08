import fs from "node:fs/promises"
import path from "node:path"
import type { Goal } from "../domain/goal"

/** Resolve existing symlinks, including the nearest existing parent of a new file. */
async function resolveExistingParent(target: string): Promise<string> {
  try {
    return await fs.realpath(target)
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error
    // A dangling symlink is not a safe new-file parent (nor a safe new file).
    try {
      const stat = await fs.lstat(target)
      if (stat.isSymbolicLink()) throw new Error(`Dangling symlink in scope: ${target}`)
    } catch (missing: any) {
      if (missing?.code !== "ENOENT") throw missing
    }
    const parent = path.dirname(target)
    if (parent === target) throw error
    return path.join(await resolveExistingParent(parent), path.basename(target))
  }
}

export async function canonicalScopePath(directory: string, input: string): Promise<string> {
  if (typeof input !== "string" || !input.trim() || input.includes("\0") || /[*?\[\]{}]/.test(input)) {
    throw new Error("write_scope requires exact non-empty file paths, not glob patterns")
  }
  const root = await fs.realpath(directory)
  const resolved = await resolveExistingParent(path.resolve(root, input))
  const relative = path.relative(root, resolved)
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Scope path is outside the workspace or names its root: ${input}`)
  }
  try {
    if ((await fs.stat(resolved)).isDirectory()) throw new Error(`Scope must name a file, not a directory: ${input}`)
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error
  }
  return relative.split(path.sep).join("/")
}

export async function canonicalWriteScope(directory: string, inputs: string[]): Promise<string[]> {
  return [...new Set(await Promise.all(inputs.map((input) => canonicalScopePath(directory, input))))].sort()
}

export interface ScopeConflict {
  goalID: string
  ownerSessionID: string
  name: string
  path: string
}

/** Called inside the state transaction; callers must fence/release quiescent owners separately. */
export function findScopeConflict(goals: Goal[], candidate: Goal): ScopeConflict | undefined {
  if (candidate.config.workspaceWrite === false || candidate.config.write_scope?.length === 0) return
  for (const owner of goals) {
    if (owner.id === candidate.id || owner.status !== "active" || owner.config.workspaceWrite === false || owner.config.write_scope?.length === 0) continue
    const requested = candidate.config.write_scope
    const held = owner.config.write_scope
    const overlap = requested === undefined || held === undefined
      ? requested?.[0] ?? held?.[0] ?? "*"
      : requested.find((file) => held.includes(file))
    if (overlap !== undefined) return { goalID: owner.id, ownerSessionID: owner.ownerSessionID, name: owner.name, path: overlap }
  }
}

export function scopeConflictMessage(conflict: ScopeConflict): string {
  return `Write scope conflict on "${conflict.path}": goal "${conflict.name}" (${conflict.goalID}), owned by session ${conflict.ownerSessionID}. Coordinate with the owner or release the conflicting scope before retrying; do not poll claims.`
}
