// Persistence across a host restart: a background server must outlive the
// plugin instance that spawned it (dispose detaches; reconcile adopts by pid)
// and must stay stoppable, or the user is left with an unreachable process.
import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { promises as fs } from "fs"
import path from "path"
import os from "os"
import { createCommandService } from "../../src/application/command-service"
import { createLocalProcessHost } from "../../src/server/command-host"
import { readState } from "../../src/infrastructure/state-repository"

function tmpDir(): string {
  return path.join(os.tmpdir(), `loopd-detach-test-${crypto.randomUUID()}`)
}

function alive(pid: number | undefined): boolean {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out")
    await new Promise((r) => setTimeout(r, 25))
  }
}

describe("Command detach across host restart", () => {
  let dir: string

  beforeEach(async () => {
    dir = tmpDir()
    await fs.mkdir(dir, { recursive: true })
  })

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it("adopts a surviving server by pid and can still stop it", async () => {
    const first = createCommandService(createLocalProcessHost())
    const server = await first.start(dir, {
      title: "detached server",
      command: "sleep",
      args: ["297"],
      cwd: dir,
      ownerSessionID: "owner-1",
      watchUntil: "ready",
      watchUntilAction: "keep",
    })
    await waitFor(() => alive(server.pid))
    const pid = server.pid!

    // Host teardown (plugin reload) must not kill the server.
    await first.dispose(dir)
    expect(alive(pid)).toBe(true)

    // New host instance: no handle exists, but the pid is still ours.
    const second = createCommandService(createLocalProcessHost())
    await second.reconcile(dir)
    const adopted = await second.get(dir, server.id, "owner-1")
    expect(adopted?.status).toBe("running")
    expect(adopted?.detached).toBe(true)
    expect(alive(pid)).toBe(true)
    expect((await readState(dir)).orphanedCommandProcesses ?? []).toEqual([])

    // Adopted means manageable: terminate reaches the pid.
    const stopped = await second.terminate(dir, server.id, "owner-1", { actor: "control" })
    expect(stopped.ok).toBe(true)
    await waitFor(() => !alive(pid))
    const after = await second.get(dir, server.id, "owner-1")
    // The torn-down instance in this test still observes the exit and may
    // record it as "exited"; a real restart has no such observer, so either
    // terminal status is correct. What matters: dead process, known actor.
    expect(["terminated", "exited"]).toContain(after?.status ?? "")
    expect(after?.terminatedBy).toBe("control")
  })

  it("never adopts a preserved command whose process already died", async () => {
    const first = createCommandService(createLocalProcessHost())
    const server = await first.start(dir, {
      title: "gone server",
      command: "sleep",
      args: ["298"],
      cwd: dir,
      ownerSessionID: "owner-1",
      watchUntil: "ready",
      watchUntilAction: "keep",
    })
    const pid = server.pid!
    await first.dispose(dir)
    process.kill(pid, "SIGKILL")
    await waitFor(() => !alive(pid))

    const second = createCommandService(createLocalProcessHost())
    await second.reconcile(dir)
    const after = await second.get(dir, server.id, "owner-1")
    expect(after?.status).not.toBe("running")
    expect(after?.detached).toBeFalsy()
  })
})
