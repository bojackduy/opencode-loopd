import { afterEach, describe, expect, it, spyOn } from "bun:test"
import { promises as fs } from "node:fs"
import path from "node:path"
import os from "node:os"
import { createHash } from "node:crypto"
import { createControlClient } from "../../src/infrastructure/control-client"
import { mutateState, readState } from "../../src/infrastructure/state-repository"
import { beforeWorkspaceTool, afterWorkspaceTool } from "../../src/application/workspace-execution"

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "loopd-control-io-"))
  const lock = path.join(os.tmpdir(), "loopd-locks", createHash("sha256").update(dir).digest("hex"), "state.lock")
  cleanups.push(async () => { await fs.rm(dir, { recursive: true, force: true }); await fs.rm(path.dirname(lock), { recursive: true, force: true }) })
  return { dir, lock }
}

describe("control I/O failure recovery", () => {
  for (const tool of ["read", "glob", "grep"] as const) {
    it(`main-session ${tool} hooks do not queue behind a live state mutation`, async () => {
      const { dir } = await fixture()
      let entered!: () => void
      let release!: () => void
      const ready = new Promise<void>((resolve) => { entered = resolve })
      const gate = new Promise<void>((resolve) => { release = resolve })
      const holder = mutateState(dir, "live-holder", async (state) => { entered(); await gate; return state })
      await ready
      const hooks = (async () => {
        await beforeWorkspaceTool(dir, { tool, sessionID: "main", callID: "read-call" }, {})
        await afterWorkspaceTool(dir, "main", "read-call", tool)
        return "done"
      })()
      let timer: ReturnType<typeof setTimeout>
      try {
        expect(await Promise.race([hooks, new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), 100) })])).toBe("done")
      } finally { clearTimeout(timer!); release(); await holder; await hooks }
      expect((await readState(dir)).revision).toBe(1)
    })
  }

  it("releases its own completed transaction even when opening the lock for cleanup fails", async () => {
    const { dir, lock } = await fixture()
    const read = fs.readFile.bind(fs)
    await mutateState(dir, "cleanup-resource-failure", async (state) => {
      const mock = spyOn(fs, "readFile").mockImplementation(((file: unknown, ...args: unknown[]) => {
        if (file === lock) return Promise.reject(Object.assign(new Error("file table full"), { code: "ENFILE" }))
        return (read as any)(file, ...args)
      }) as any)
      cleanups.push(() => { mock.mockRestore() })
      return state
    })
    expect(await fs.stat(lock).catch(() => undefined)).toBeUndefined()
  })

  it("does not poison the lock path when writing acquisition metadata fails", async () => {
    const { dir, lock } = await fixture()
    const open = fs.open.bind(fs)
    const mock = spyOn(fs, "open").mockImplementation((async (file: unknown, ...args: unknown[]) => {
      const handle = await (open as any)(file, ...args)
      if (file === lock) handle.writeFile = async () => { throw Object.assign(new Error("metadata write failed"), { code: "EIO" }) }
      return handle
    }) as any)
    cleanups.push(() => { mock.mockRestore() })
    await expect(mutateState(dir, "metadata-failure", async (state) => state)).rejects.toThrow("metadata write failed")
    expect(await fs.stat(lock).catch(() => undefined)).toBeUndefined()
  })

  it("does not remove a replacement owner's lock when the original lease finishes", async () => {
    const { dir, lock } = await fixture()
    const replacement = { pid: process.pid, operation: "replacement", token: crypto.randomUUID(), acquiredAt: new Date().toISOString() }
    await mutateState(dir, "original", async (state) => {
      await fs.rename(lock, `${lock}.held`)
      await fs.writeFile(lock, JSON.stringify(replacement))
      return state
    })
    expect(JSON.parse(await fs.readFile(lock, "utf8"))).toEqual(replacement)
  })

  it("does not replace persisted authority with an empty store after a read I/O error", async () => {
    const { dir, lock } = await fixture()
    await mutateState(dir, "seed", async (state) => state)
    const read = fs.readFile.bind(fs)
    const mock = spyOn(fs, "readFile").mockImplementation(((file: unknown, ...args: unknown[]) => {
      if (String(file).endsWith("state.json")) return Promise.reject(Object.assign(new Error("state read failed"), { code: "ENFILE" }))
      return (read as any)(file, ...args)
    }) as any)
    cleanups.push(() => { mock.mockRestore() })
    await expect(mutateState(dir, "unreadable-state", async (state) => state)).rejects.toThrow("state read failed")
    mock.mockRestore()
    expect((await readState(dir)).revision).toBe(1)
    expect(await fs.stat(lock).catch(() => undefined)).toBeUndefined()
  })

  for (const stalled of ["submission", "response", "diagnostics"] as const) {
    it(`bounds ${stalled} filesystem I/O instead of leaving the dashboard sending indefinitely`, async () => {
      const { dir } = await fixture()
      const read = fs.readFile.bind(fs)
      const mkdir = fs.mkdir.bind(fs)
      const stat = fs.stat.bind(fs)
      let release!: () => void
      const gate = new Promise<void>((resolve) => { release = resolve })
      if (stalled === "submission") {
        const mock = spyOn(fs, "mkdir").mockImplementation((async (file: unknown, ...args: unknown[]) => {
          if (String(file).endsWith("control/requests")) { await gate; throw new Error("released injected stall") }
          return (mkdir as any)(file, ...args)
        }) as any)
        cleanups.push(() => { mock.mockRestore() })
      } else if (stalled === "response") {
        const mock = spyOn(fs, "readFile").mockImplementation((async (file: unknown, ...args: unknown[]) => {
          if (String(file).includes("control/responses/")) { await gate; throw new Error("released injected stall") }
          return (read as any)(file, ...args)
        }) as any)
        cleanups.push(() => { mock.mockRestore() })
      } else {
        const mock = spyOn(fs, "stat").mockImplementation((async (file: unknown, ...args: unknown[]) => {
          if (String(file).includes("control/processing/")) { await gate; throw new Error("released injected stall") }
          return (stat as any)(file, ...args)
        }) as any)
        cleanups.push(() => { mock.mockRestore() })
      }
      const request = createControlClient(dir).executeRaw({ command: "nudge", goalID: "fixture" }, 20)
      let timer: ReturnType<typeof setTimeout>
      try {
        const result = await Promise.race([request, new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), 500) })])
        expect(result?.errorCode).toBe("timeout")
        expect(result?.message).toMatch(/later|retry|processing/i)
      } finally {
        clearTimeout(timer!)
        release()
        await request
      }
    })
  }
})
