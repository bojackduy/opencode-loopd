import { afterEach, describe, expect, it } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createGoal, type Goal, type GoalConfig, type GoalID } from "../../src/domain/goal"
import { canonicalScopePath, canonicalWriteScope, findScopeConflict, scopeConflictMessage } from "../../src/infrastructure/workspace-scope"

const roots: string[] = []
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "loopd-scope-"))
  roots.push(root)
  await fs.mkdir(path.join(root, "src"))
  await fs.writeFile(path.join(root, "src", "file.ts"), "original")
  return root
}
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))) })

function goal(id: string, config: GoalConfig, status: Goal["status"] = "active") {
  return createGoal({ id: id as GoalID, name: id, objective: "test", ownerSessionID: `owner-${id}`, status, config })
}

describe("canonical exact-file scope", () => {
  it("normalizes traversal, absolute paths and new nested file parents", async () => {
    const root = await fixture()
    expect(await canonicalWriteScope(root, ["src/../src/file.ts", path.join(root, "src/file.ts"), "src/new/deep/file.ts"]))
      .toEqual(["src/file.ts", "src/new/deep/file.ts"])
  })

  it("collapses file and new-parent symlink aliases", async () => {
    const root = await fixture()
    await fs.symlink("src", path.join(root, "alias"))
    await fs.symlink("src/file.ts", path.join(root, "file-alias"))
    expect(await canonicalWriteScope(root, ["alias/file.ts", "file-alias", "alias/new/file.ts"]))
      .toEqual(["src/file.ts", "src/new/file.ts"])
  })

  it("rejects outside-root aliases, dangling links, directories and globs", async () => {
    const root = await fixture()
    await fs.symlink(path.dirname(root), path.join(root, "outside"))
    await fs.symlink("missing", path.join(root, "dangling"))
    for (const input of ["../outside.ts", "outside/new.ts", "dangling", "src", ".", "src/*.ts", "src/[ab].ts", ""]) {
      await expect(canonicalScopePath(root, input)).rejects.toThrow()
    }
  })

  it("supports an explicitly empty scope", async () => {
    expect(await canonicalWriteScope(await fixture(), [])).toEqual([])
  })
})

describe("scope conflicts", () => {
  it("allows disjoint files and rejects overlap with owner/path diagnostics", () => {
    const owner = goal("one", { workspaceWrite: true, write_scope: ["src/a.ts"] })
    expect(findScopeConflict([owner], goal("two", { workspaceWrite: true, write_scope: ["src/b.ts"] }))).toBeUndefined()
    const conflict = findScopeConflict([owner], goal("two", { workspaceWrite: true, write_scope: ["src/a.ts", "src/b.ts"] }))!
    expect(conflict).toEqual({ goalID: "one", ownerSessionID: "owner-one", name: "one", path: "src/a.ts" })
    expect(scopeConflictMessage(conflict)).toContain("owner-one")
    expect(scopeConflictMessage(conflict)).toContain("do not poll")
  })

  it("legacy writers conflict symmetrically with file writers", () => {
    const legacy = goal("legacy", { workspaceWrite: true })
    const scoped = goal("scoped", { workspaceWrite: true, write_scope: ["src/a.ts"] })
    expect(findScopeConflict([legacy], scoped)?.path).toBe("src/a.ts")
    expect(findScopeConflict([scoped], legacy)?.path).toBe("src/a.ts")
    expect(findScopeConflict([legacy], goal("other", { workspaceWrite: true }))?.path).toBe("*")
  })

  it("read-only/exploration goals have no shared-source ownership", () => {
    const legacy = goal("legacy", { workspaceWrite: true })
    for (const config of [{ workspaceWrite: false }, { workspaceWrite: true, write_scope: [] }]) {
      const candidate = goal("empty", config)
      expect(findScopeConflict([legacy], candidate)).toBeUndefined()
      expect(findScopeConflict([candidate], legacy)).toBeUndefined()
    }
    expect(findScopeConflict([legacy], legacy)).toBeUndefined()
    expect(findScopeConflict([goal("paused", { workspaceWrite: true }, "paused")], legacy)).toBeUndefined()
  })
})
