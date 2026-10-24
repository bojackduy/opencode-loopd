import { afterEach, expect, it } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createGoalService } from "../../src/application/goal-service"
import { createCommandService } from "../../src/application/command-service"
import {
  cleanupApprovedServers,
  readApprovedServer,
  reconcileApprovedServers,
  startApprovedServer,
  stopApprovedServer,
} from "../../src/application/approved-commands"
import { createFakeHost } from "../../src/server/host-adapter"
import { createLocalProcessHost } from "../../src/server/command-host"
import { mutateState, readState } from "../../src/infrastructure/state-repository"
import { approvedCommandTools } from "../../src/server/approved-command-tools"
import type { ApprovedGoalCommand } from "../../src/domain/goal"

const roots: string[] = []
const pids: number[] = []

afterEach(async () => {
  for (const pid of pids.splice(0)) {
    try { process.kill(pid, "SIGKILL") } catch {}
  }
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

async function workspace() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "loopd-approved-server-"))
  roots.push(root)
  return root
}

const server = (name = "dev", body = "console.log('ready'); setInterval(() => {}, 1000)"): ApprovedGoalCommand => ({
  name,
  command: process.execPath,
  args: ["-e", body],
  cwd: ".",
  kind: "server",
})

async function approvedGoal(root: string, commands: ApprovedGoalCommand[], scoped = true) {
  const host = createFakeHost({ autoCompletePrompts: false })
  const service = createGoalService(host)
  const { goal } = await service.start(root, {
    name: "approved-server",
    objective: "manage servers by name",
    ownerSessionID: "owner",
    config: { workspaceWrite: true, ...(scoped ? { write_scope: [] } : {}), approvedCommands: commands },
  })
  return { goal, service }
}

function commands(_root: string, service = createCommandService(createLocalProcessHost())) {
  return service
}

async function waitFor<T>(read: () => Promise<T | undefined>, ok: (value: T) => boolean, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await read()
    if (value !== undefined && ok(value)) return value
    if (Date.now() > deadline) throw new Error("timed out waiting for condition")
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

it("starts one real managed server, links goal/session/generation/spec, and exposes readiness output", async () => {
  const root = await workspace()
  const { goal } = await approvedGoal(root, [server()])
  const worker = goal.workerSessionID!
  const service = commands(root)

  const started = await startApprovedServer(root, service, worker, "dev")
  expect(started.ok).toBe(true)
  expect(started.live).toBe(true)
  expect(started.commandID).toBeDefined()
  expect(started.command).toBe(process.execPath)
  expect(started.args).toEqual(["-e", "console.log('ready'); setInterval(() => {}, 1000)"])
  expect(started.cwd).toBe(root)
  pids.push(started.pid!)

  const state = await readState(root)
  expect(state.approvedServers).toHaveLength(1)
  expect(state.approvedServers![0]).toMatchObject({
    commandID: started.commandID,
    goalID: goal.id,
    workerSessionID: worker,
    runGeneration: state.runtimes.find((runtime) => runtime.goalID === goal.id)!.runGeneration,
    name: "dev",
  })

  const ready = await waitFor(
    () => readApprovedServer(root, service, worker, "dev"),
    (value) => (value.output ?? "").includes("ready"),
  )
  expect(ready.live).toBe(true)
  expect(ready.output).toContain("ready")

  // Duplicate start is refused atomically and names the live session.
  const duplicate = await startApprovedServer(root, service, worker, "dev")
  expect(duplicate.errorCode).toBe("duplicate_server")
  expect(duplicate.message).toContain(started.commandID!)
  expect((await readState(root)).approvedServers).toHaveLength(1)
  expect((await readState(root)).commands!.filter((command) => command.status === "running")).toHaveLength(1)

  const stopped = await stopApprovedServer(root, service, worker, "dev")
  expect(stopped.ok).toBe(true)
  expect(stopped.status).toBe("terminated")
  expect(stopped.exitCode).toBe(143)
  expect(alive(started.pid!)).toBe(false)
  expect((await readState(root)).approvedServers).toHaveLength(0)
  expect((await readApprovedServer(root, service, worker, "dev")).errorCode).toBe("unmanaged_server")
})

it("reuses the managed tools by name and rejects executable overrides", async () => {
  const root = await workspace()
  const { goal } = await approvedGoal(root, [server()])
  const worker = goal.workerSessionID!
  const service = commands(root)
  const tools = approvedCommandTools({ directory: root, commandService: service })

  const started = JSON.parse((await tools.start_approved_server.execute({ name: "dev" }, { sessionID: worker })).output)
  expect(started.ok).toBe(true)
  pids.push(started.pid)

  for (const extra of [{ command: "sh" }, { args: ["-c", "id"] }, { cwd: "/" }, { env: { A: "b" } }, { shell: true }]) {
    const denied = JSON.parse((await tools.start_approved_server.execute({ name: "dev", ...extra } as never, { sessionID: worker })).output)
    expect(denied.errorCode).toBe("override_denied")
  }

  const read = JSON.parse((await tools.read_approved_server.execute({ name: "dev" }, { sessionID: worker })).output)
  expect(read.commandID).toBe(started.commandID)
  const stopped = JSON.parse((await tools.stop_approved_server.execute({ name: "dev" }, { sessionID: worker })).output)
  expect(stopped.ok).toBe(true)
})

it("denies unknown names, finite specs, foreign/retired callers and inactive goals", async () => {
  const root = await workspace()
  const { goal } = await approvedGoal(root, [server(), { name: "build", command: process.execPath, args: ["-e", "0"], cwd: ".", kind: "finite" }])
  const worker = goal.workerSessionID!
  const service = commands(root)

  expect((await startApprovedServer(root, service, worker, "missing")).errorCode).toBe("unknown_approved_command")
  expect((await startApprovedServer(root, service, worker, "build")).errorCode).toBe("kind_mismatch")
  expect((await startApprovedServer(root, service, "foreign", "dev")).errorCode).toBe("unapproved_caller")

  await mutateState(root, "retire", async (state) => { state.retiredWorkerSessions = [worker]; return state })
  expect((await startApprovedServer(root, service, worker, "dev")).errorCode).toBe("unapproved_caller")
  expect((await readApprovedServer(root, service, worker, "dev")).errorCode).toBe("unapproved_caller")

  for (const status of ["paused", "blocked", "complete"] as const) {
    await mutateState(root, `status-${status}`, async (state) => {
      const current = state.goals.find((item) => item.id === goal.id)!
      current.status = status
      state.retiredWorkerSessions = []
      return state
    })
    expect((await startApprovedServer(root, service, worker, "dev")).errorCode).toBe("inactive_goal")
  }
})

it("refuses a start while a workspace operation holds the fence", async () => {
  const root = await workspace()
  const { goal } = await approvedGoal(root, [server()])
  const service = commands(root)
  await mutateState(root, "op", async (state) => {
    state.workspaceOperation = { id: "op-1", goalID: goal.id, sessionID: goal.workerSessionID! }
    return state
  })
  const denied = await startApprovedServer(root, service, goal.workerSessionID!, "dev")
  expect(denied.errorCode).toBe("workspace_busy")
  expect((await readState(root)).approvedServers ?? []).toHaveLength(0)
  await mutateState(root, "op-clear", async (state) => { state.workspaceOperation = undefined; return state })
})

it("lifecycle cleanup stops a paused goal's server with a proved exit and leaves standalone commands alone", async () => {
  const root = await workspace()
  const { goal } = await approvedGoal(root, [server()], false)
  const worker = goal.workerSessionID!
  const service = commands(root)

  const started = await startApprovedServer(root, service, worker, "dev")
  pids.push(started.pid!)

  const standalone = await service.start(root, {
    title: "standalone",
    command: process.execPath,
    args: ["-e", "setInterval(() => {}, 1000)"],
    cwd: root,
    ownerSessionID: "owner",
    goalID: goal.id,
  })
  pids.push(standalone.pid!)

  await mutateState(root, "pause", async (state) => {
    state.goals.find((item) => item.id === goal.id)!.status = "paused"
    return state
  })
  const result = await reconcileApprovedServers(root, service)
  expect(result.unproven).toEqual([])
  expect(result.stopped).toEqual([`${goal.id}:dev`])
  expect(alive(started.pid!)).toBe(false)
  expect((await readState(root)).approvedServers).toHaveLength(0)

  const standaloneState = (await readState(root)).commands!.find((command) => command.id === standalone.id)!
  expect(standaloneState.status).toBe("running")
  expect(alive(standalone.pid!)).toBe(true)
  await service.terminate(root, standalone.id, "owner")
})

it("reconcile stops servers after worker rotation and clears the linkage", async () => {
  const root = await workspace()
  const { goal } = await approvedGoal(root, [server()])
  const worker = goal.workerSessionID!
  const service = commands(root)
  const started = await startApprovedServer(root, service, worker, "dev")
  pids.push(started.pid!)

  await mutateState(root, "rotate", async (state) => {
    const current = state.goals.find((item) => item.id === goal.id)!
    current.workerSessionID = "rotated-worker"
    state.runtimes.find((runtime) => runtime.goalID === goal.id)!.runGeneration += 1
    return state
  })
  const result = await reconcileApprovedServers(root, service)
  expect(result.stopped).toEqual([`${goal.id}:dev`])
  expect(alive(started.pid!)).toBe(false)
  expect((await readState(root)).approvedServers).toHaveLength(0)
  expect((await readApprovedServer(root, service, "rotated-worker", "dev")).errorCode).toBe("unmanaged_server")
})

it("lets the owning session read and stop a server after the goal went inactive", async () => {
  const root = await workspace()
  const { goal } = await approvedGoal(root, [server()])
  const service = commands(root)
  const started = await startApprovedServer(root, service, goal.workerSessionID!, "dev")
  pids.push(started.pid!)

  await mutateState(root, "pause", async (state) => {
    state.goals.find((item) => item.id === goal.id)!.status = "paused"
    return state
  })

  const read = await readApprovedServer(root, service, "owner", "dev")
  expect(read.live).toBe(true)
  expect((await stopApprovedServer(root, service, "someone-else", "dev")).errorCode).toBe("unmanaged_server")
  const stopped = await stopApprovedServer(root, service, "owner", "dev")
  expect(stopped.ok).toBe(true)
  expect(alive(started.pid!)).toBe(false)
})

it("fails closed on a lost handle: start and stop report recovery, and the fence survives cleanup", async () => {
  const root = await workspace()
  const { goal } = await approvedGoal(root, [server()])
  const worker = goal.workerSessionID!
  const service = commands(root)
  const started = await startApprovedServer(root, service, worker, "dev")
  pids.push(started.pid!)

  // Simulate a host restart: a fresh service instance has no live handle, so
  // reconcile honestly marks the persisted process missing (exit unproved).
  const restarted = createCommandService(createLocalProcessHost())
  expect((await restarted.reconcile(root)).markedMissing).toBe(1)

  expect((await startApprovedServer(root, service, worker, "dev")).errorCode).toBe("recovery_required")
  expect((await stopApprovedServer(root, service, worker, "dev")).errorCode).toBe("stop_unproven")
  const cleanup = await cleanupApprovedServers(root, service, goal.id)
  expect(cleanup.unproven).toEqual([`${goal.id}:dev`])
  expect((await readState(root)).approvedServers).toHaveLength(1)

  // Only a proved terminal status releases the linkage; the record never ages out.
  await mutateState(root, "proved", async (state) => {
    const command = state.commands!.find((item) => item.id === started.commandID)!
    command.status = "terminated"
    command.exitCode = 143
    return state
  })
  expect((await cleanupApprovedServers(root, service, goal.id)).stopped).toEqual([`${goal.id}:dev`])
  expect((await readState(root)).approvedServers).toHaveLength(0)
})
