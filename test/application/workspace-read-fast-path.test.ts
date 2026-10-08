import { expect, test } from "bun:test"
import { promises as fs } from "fs"
import path from "path"
import os from "os"
import { beforeWorkspaceTool } from "../../src/application/workspace-execution"
import { mutateState, readState } from "../../src/infrastructure/state-repository"

test("exempt read tools neither create state nor acquire a workspace transaction", async () => {
  const root = process.env.LOOPD_TEST_TMPDIR ?? os.tmpdir()
  await fs.mkdir(root, { recursive: true })
  const directory = await fs.mkdtemp(path.join(root, "read-fast-test-"))
  try {
    await beforeWorkspaceTool(directory, { tool: "read", sessionID: "retired", callID: "read-1" }, {})
    expect(await fs.readdir(directory)).toEqual([])
    const state = await mutateState(directory, "seed", async (s) => ({ ...s, retiredWorkerSessions: ["retired"], workspaceOperation: { id: "operation", goalID: "protected", sessionID: "owner" } }))
    const target = path.join(directory, ".opencode/loopd/state.json")
    const raw = await fs.readFile(target, "utf8")
    for (const tool of ["read", "glob", "grep", "get_goal", "codegraph_codegraph_context"]) {
      await beforeWorkspaceTool(directory, { tool, sessionID: "retired", callID: tool }, {})
    }
    expect((await readState(directory)).revision).toBe(state.revision)
    expect(await fs.readFile(target, "utf8")).toBe(raw)
    await expect(beforeWorkspaceTool(directory, { tool: "write", sessionID: "retired", callID: "write" }, { filePath: "source.ts" })).rejects.toThrow("retired worker")
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
})
