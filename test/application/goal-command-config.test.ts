import { afterEach, beforeEach, expect, it } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createGoalService } from "../../src/application/goal-service"
import { createFakeHost } from "../../src/server/host-adapter"
import { readState } from "../../src/infrastructure/state-repository"
import type { GoalConfig } from "../../src/domain/goal"
import { goalTools } from "../../src/server/goal-tools"
import { z } from "zod"

let directory: string
let outside: string
let host: ReturnType<typeof createFakeHost>
let service: ReturnType<typeof createGoalService>

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "loopd-approved-command-"))
  outside = await fs.mkdtemp(path.join(os.tmpdir(), "loopd-command-outside-"))
  host = createFakeHost({ autoCompletePrompts: false })
  service = createGoalService(host)
})
afterEach(async () => {
  await fs.rm(directory, { recursive: true, force: true })
  await fs.rm(outside, { recursive: true, force: true })
})

const specification = () => ({ name: "build", command: "bun", args: ["run", "build"], cwd: ".", kind: "finite" })

it("public creation schema preserves approved commands through service persistence and worker get_goal", async () => {
  const tools = goalTools(directory, service)
  const args = z.object(tools.loopd_create_goal.args).parse({
    name: "public approved", objective: "inspect only", workspaceWrite: false,
    approvedCommands: [specification()],
  })
  const created = JSON.parse((await tools.loopd_create_goal.execute(args, { sessionID: "owner" })).output)
  expect(created.ok).toBe(true)
  const stored = (await readState(directory)).goals.find((goal) => goal.id === created.goalID)!
  expect(stored.config.approvedCommands).toEqual([specification()])
  const worker = JSON.parse((await tools.get_goal.execute({}, { sessionID: stored.workerSessionID! })).output)
  expect(worker.config.approvedCommands).toEqual([specification()])
})

it("public creation schema rejects command authority override fields", () => {
  const schema = z.object(goalTools(directory, service).loopd_create_goal.args)
  expect(() => schema.parse({ name: "bad", objective: "test", approvedCommands: [{ ...specification(), shell: true }] })).toThrow()
})
function start(approvedCommands: unknown) {
  return service.start(directory, {
    name: "approved commands", objective: "inspect only", ownerSessionID: "owner",
    config: { workspaceWrite: false, approvedCommands } as GoalConfig,
  })
}

for (const [label, commands] of [
  ["non-array", {}],
  ["duplicate name", [specification(), specification()]],
  ["empty name", [{ ...specification(), name: "" }]],
  ["invalid kind", [{ ...specification(), kind: "shell" }]],
  ["empty executable", [{ ...specification(), command: "" }]],
  ["NUL executable", [{ ...specification(), command: "bun\0" }]],
  ["non-vector arguments", [{ ...specification(), args: "run build" }]],
  ["non-string argument", [{ ...specification(), args: [7] }]],
  ["NUL argument", [{ ...specification(), args: ["x\0"] }]],
  ["absolute cwd", [{ ...specification(), cwd: "/" }]],
  ["escaping cwd", [{ ...specification(), cwd: "../" }]],
  ["missing cwd", [{ ...specification(), cwd: "does-not-exist" }]],
  ["shell override", [{ ...specification(), shell: true }]],
  ["environment override", [{ ...specification(), env: { TOKEN: "bad" } }]],
  ["zero timeout", [{ ...specification(), timeoutSeconds: 0 }]],
  ["non-finite timeout", [{ ...specification(), timeoutSeconds: Infinity }]],
] as const) {
  it(`rejects ${label} before creating a goal or prompting a worker`, async () => {
    await expect(start(commands)).rejects.toThrow(/approvedCommands/)
    expect((await readState(directory)).goals).toHaveLength(0)
    expect(host.prompts).toHaveLength(0)
  })
}

it("rejects a cwd symlink that leaves the workspace", async () => {
  await fs.symlink(outside, path.join(directory, "escape"))
  await expect(start([{ ...specification(), cwd: "escape" }])).rejects.toThrow(/approvedCommands/)
  expect(host.prompts).toHaveLength(0)
})

it("rejects a cwd naming a file", async () => {
  await fs.writeFile(path.join(directory, "file"), "not a directory")
  await expect(start([{ ...specification(), cwd: "file" }])).rejects.toThrow(/approvedCommands/)
})

it("canonicalizes an in-workspace cwd and persists fixed command authority", async () => {
  await fs.mkdir(path.join(directory, "web"))
  await fs.symlink("web", path.join(directory, "web-alias"))
  const commands = [{ ...specification(), cwd: "web-alias", timeoutSeconds: 15 }]
  const { goal } = await start(commands)
  const stored = (await readState(directory)).goals.find((item) => item.id === goal.id)!
  expect((stored.config as typeof stored.config & { approvedCommands: unknown }).approvedCommands).toEqual([
    { ...specification(), cwd: "web", timeoutSeconds: 15 },
  ])
  expect(stored.config.workspaceWrite).toBe(false)
  expect(stored.config.write_scope).toBeUndefined()
  expect(stored.config.checks).toBeUndefined()
  expect(commands[0]!.cwd).toBe("web-alias")
})

it("grants no executable authority to legacy goals", async () => {
  const { goal } = await service.start(directory, {
    name: "legacy", objective: "inspect only", ownerSessionID: "owner", config: { workspaceWrite: false },
  })
  expect((goal.config as typeof goal.config & { approvedCommands?: unknown }).approvedCommands).toBeUndefined()
})
