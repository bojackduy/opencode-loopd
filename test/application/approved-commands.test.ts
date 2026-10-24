import { afterEach, expect, it } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { z } from "zod"
import { createGoalService } from "../../src/application/goal-service"
import { createFakeHost } from "../../src/server/host-adapter"
import { mutateState, readState } from "../../src/infrastructure/state-repository"
import { approvedCommandTools } from "../../src/server/approved-command-tools"
import { beforeWorkspaceTool } from "../../src/application/workspace-execution"
import type { ApprovedGoalCommand } from "../../src/domain/goal"

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))) })

async function workspace() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "loopd-approved-run-"))
  roots.push(root)
  return root
}

async function approvedGoal(root: string, commands: ApprovedGoalCommand[], config: { write_scope?: string[] } = {}) {
  const host = createFakeHost({ autoCompletePrompts: false })
  const service = createGoalService(host)
  const { goal } = await service.start(root, {
    name: "approved", objective: "use named commands only", ownerSessionID: "owner",
    config: { workspaceWrite: true, ...config, approvedCommands: commands },
  })
  return { goal, service }
}

const echo = (name = "echo"): ApprovedGoalCommand => ({ name, command: process.execPath, args: ["-e", "console.log('approved-output')"], cwd: ".", kind: "finite" })

function run(root: string, sessionID: string, name: string) {
  return approvedCommandTools({ directory: root }).run_approved_command.execute({ name }, { sessionID })
}

function parse(result: { output: string }) {
  return JSON.parse(result.output)
}

it("executes the stored executable and fixed args without a shell and reports real output and exit", async () => {
  const root = await workspace()
  const { goal } = await approvedGoal(root, [echo()])
  const result = parse(await run(root, goal.workerSessionID!, "echo"))
  expect(result.ok).toBe(true)
  expect(result.name).toBe("echo")
  expect(result.exitCode).toBe(0)
  expect(result.timedOut).toBe(false)
  expect(result.cwd).toBe(".")
  expect(result.stdout).toContain("approved-output")
  expect(result.args).toEqual(["-e", "console.log('approved-output')"])
  expect(result.command).toBe(process.execPath)
})

it("reports a nonzero exit as failure with the actual code and output", async () => {
  const root = await workspace()
  const { goal } = await approvedGoal(root, [{ name: "fail", command: process.execPath, args: ["-e", "console.error('bad'); process.exit(7)"], cwd: ".", kind: "finite" }])
  const result = parse(await run(root, goal.workerSessionID!, "fail"))
  expect(result.ok).toBe(false)
  expect(result.exitCode).toBe(7)
  expect(result.timedOut).toBe(false)
  expect(result.stderr).toContain("bad")
})

it("enforces the fixed timeout and reports the timeout outcome", async () => {
  const root = await workspace()
  const { goal } = await approvedGoal(root, [{ name: "slow", command: process.execPath, args: ["-e", "setTimeout(() => console.log('late'), 5000)"], cwd: ".", kind: "finite", timeoutSeconds: 1 }])
  const result = parse(await run(root, goal.workerSessionID!, "slow"))
  expect(result.ok).toBe(false)
  expect(result.timedOut).toBe(true)
  expect(result.timeoutSeconds).toBe(1)
  expect(result.durationMs).toBeLessThan(4500)
})

it("runs in the stored canonical cwd, not the caller's choice", async () => {
  const root = await workspace()
  await fs.mkdir(path.join(root, "web"))
  const { goal } = await approvedGoal(root, [{ name: "cwd", command: process.execPath, args: ["-e", "console.log(process.cwd())"], cwd: "web", kind: "finite" }])
  const result = parse(await run(root, goal.workerSessionID!, "cwd"))
  expect(result.cwd).toBe("web")
  expect(await fs.realpath(result.stdout.trim())).toBe(await fs.realpath(path.join(root, "web")))
})

it("accepts a name only and rejects executable, argument, cwd, environment, shell and kind overrides", async () => {
  const root = await workspace()
  const { goal } = await approvedGoal(root, [echo()])
  const worker = goal.workerSessionID!
  expect(z.object(approvedCommandTools({ directory: root }).run_approved_command.args).parse({ name: "echo" })).toEqual({ name: "echo" })
  for (const extra of [{ command: "rm" }, { args: ["-rf", "/"] }, { cwd: "/" }, { env: { A: "b" } }, { shell: true }, { kind: "server" }, { timeoutSeconds: 1 }]) {
    const result = parse(await approvedCommandTools({ directory: root }).run_approved_command.execute({ name: "echo", ...extra } as never, { sessionID: worker }))
    expect(result.errorCode).toBe("override_denied")
  }
})

it("denies unknown names and goals that never granted authority", async () => {
  const root = await workspace()
  const { goal, service } = await approvedGoal(root, [echo()])
  expect(parse(await run(root, goal.workerSessionID!, "missing")).errorCode).toBe("unknown_approved_command")
  const legacy = await service.start(root, { name: "legacy", objective: "none", ownerSessionID: "owner", config: { workspaceWrite: false } })
  expect(parse(await run(root, legacy.goal.workerSessionID!, "echo")).errorCode).toBe("unknown_approved_command")
})

it("denies foreign callers, retired workers and rotated sessions", async () => {
  const root = await workspace()
  const { goal } = await approvedGoal(root, [echo()])
  const worker = goal.workerSessionID!
  expect(parse(await run(root, "foreign", "echo")).errorCode).toBe("unapproved_caller")
  expect(parse(await run(root, "main", "echo")).errorCode).toBe("unapproved_caller")

  await mutateState(root, "retire", async (state) => { state.retiredWorkerSessions = [worker]; return state })
  expect(parse(await run(root, worker, "echo")).errorCode).toBe("unapproved_caller")

  await mutateState(root, "rotate", async (state) => {
    const current = state.goals.find((item) => item.id === goal.id)!
    current.workerSessionID = "rotated-worker"
    state.runtimes.find((runtime) => runtime.goalID === goal.id)!.runGeneration += 1
    return state
  })
  expect(parse(await run(root, worker, "echo")).errorCode).toBe("unapproved_caller")
  expect(parse(await run(root, "rotated-worker", "echo")).ok).toBe(true)
})

it("denies non-active goals", async () => {
  const root = await workspace()
  const { goal } = await approvedGoal(root, [echo()])
  const worker = goal.workerSessionID!
  for (const status of ["paused", "blocked", "complete"] as const) {
    await mutateState(root, `status-${status}`, async (state) => {
      state.goals.find((item) => item.id === goal.id)!.status = status
      return state
    })
    expect(parse(await run(root, worker, "echo")).errorCode).toBe("inactive_goal")
  }
})

it("holds the workspace operation lock for the whole process so source writes are denied", async () => {
  const root = await workspace()
  const { goal } = await approvedGoal(root, [{ name: "hold", command: process.execPath, args: ["-e", "setTimeout(() => process.exit(0), 400)"], cwd: ".", kind: "finite" }], { write_scope: [] })
  const worker = goal.workerSessionID!
  const running = run(root, worker, "hold")
  await new Promise((resolve) => setTimeout(resolve, 150))
  expect((await readState(root)).workspaceOperation).toBeDefined()
  await expect(beforeWorkspaceTool(root, { tool: "write", sessionID: "owner", callID: "during-run" }, { filePath: "a.ts" })).rejects.toThrow(/Workspace operation/)
  expect(parse(await running).ok).toBe(true)
  expect((await readState(root)).workspaceOperation).toBeUndefined()
})

it("serializes concurrent executions so the others observe the lock instead of running", async () => {
  const root = await workspace()
  const { goal } = await approvedGoal(root, [{ name: "hold", command: process.execPath, args: ["-e", "setTimeout(() => process.exit(0), 300)"], cwd: ".", kind: "finite" }], { write_scope: [] })
  const worker = goal.workerSessionID!
  const parsed = (await Promise.all([1, 2, 3].map(() => run(root, worker, "hold")))).map(parse)
  expect(parsed.filter((item) => item.ok)).toHaveLength(1)
  expect(parsed.filter((item) => item.errorCode === "workspace_busy")).toHaveLength(2)
})
