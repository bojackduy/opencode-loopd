import fs from "node:fs/promises"
import path from "node:path"
import type { ApprovedGoalCommand } from "../domain/goal"

/** Validate owner-created authority before persistence; workers cannot supply overrides. */
export async function canonicalGoalCommands(directory: string, input: unknown): Promise<ApprovedGoalCommand[]> {
  if (!Array.isArray(input)) throw new Error("approvedCommands must be an array of named command specifications.")
  const root = await fs.realpath(directory)
  const names = new Set<string>()
  const result: ApprovedGoalCommand[] = []
  const fields = new Set(["name", "command", "args", "cwd", "kind", "timeoutSeconds"])
  for (const value of input) {
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !fields.has(key))) {
      throw new Error("approvedCommands entries allow only name, command, args, cwd, kind and timeoutSeconds.")
    }
    const { name, command, args, cwd, kind, timeoutSeconds } = value
    if (typeof name !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name) || names.has(name)) {
      throw new Error("approvedCommands requires unique non-empty names using letters, digits, dots, underscores or hyphens.")
    }
    if (typeof command !== "string" || !command.trim() || command.includes("\0")) {
      throw new Error(`approvedCommands ${name}: command must be a non-empty executable without NUL bytes.`)
    }
    if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string" || arg.includes("\0"))) {
      throw new Error(`approvedCommands ${name}: args must be a fixed string array without NUL bytes.`)
    }
    if (kind !== "finite" && kind !== "server") throw new Error(`approvedCommands ${name}: kind must be finite or server.`)
    if (timeoutSeconds !== undefined && (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds <= 0)) {
      throw new Error(`approvedCommands ${name}: timeoutSeconds must be a positive finite integer.`)
    }
    if (typeof cwd !== "string" || !cwd.trim() || cwd.includes("\0") || path.isAbsolute(cwd)) {
      throw new Error(`approvedCommands ${name}: cwd must be a fixed workspace-relative directory.`)
    }
    let canonical: string
    try {
      const resolved = await fs.realpath(path.resolve(root, cwd))
      canonical = path.relative(root, resolved)
      if (canonical === ".." || canonical.startsWith(`..${path.sep}`) || path.isAbsolute(canonical) || !(await fs.stat(resolved)).isDirectory()) {
        throw new Error("cwd escapes the workspace or is not a directory")
      }
    } catch {
      throw new Error(`approvedCommands ${name}: cwd must resolve to an existing directory inside the workspace.`)
    }
    names.add(name)
    result.push({
      name, command, args: [...args], cwd: canonical.split(path.sep).join("/") || ".", kind,
      ...(timeoutSeconds !== undefined ? { timeoutSeconds } : {}),
    })
  }
  return result
}
