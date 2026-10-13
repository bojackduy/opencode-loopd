import { afterEach, beforeEach, expect, it } from "bun:test"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { createGoalService } from "../../src/application/goal-service"
import { createCommandService } from "../../src/application/command-service"
import { createFakeCommandHost } from "../../src/server/command-host"
import { createLoopEngine } from "../../src/application/loop-engine"
import { deliverOwnerNotification as notifyCommandOwner } from "../../src/application/owner-notification"
import { createFakeHost } from "../../src/server/host-adapter"
import { peekGoalInbox, readState, mutateState } from "../../src/infrastructure/state-repository"

let dir: string
let host: ReturnType<typeof createFakeHost>
let goals: ReturnType<typeof createGoalService>
const engines: ReturnType<typeof createLoopEngine>[] = []
const commands: ReturnType<typeof createCommandService>[] = []
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "loopd-owner-notify-"))
  host = createFakeHost({ autoCompletePrompts: false })
  goals = createGoalService(host)
})
afterEach(async () => {
  for (const engine of engines.splice(0)) engine.stop()
  for (const command of commands.splice(0)) await command.dispose(dir)
  await fs.rm(dir, { recursive: true, force: true })
})
async function start(workspaceWrite = false) {
  return (await goals.start(dir, { name: "notification fixture", objective: "verify notification delivery", ownerSessionID: "parent", config: { workspaceWrite, checks: workspaceWrite ? ["true"] : [] } })).goal
}
function rawNotifications() { return (host.sessions as any).notifications ?? [] }

it("queues a busy worker's command/watch output without an untracked host prompt", async () => {
  const goal = await start()
  host.sessionStatus = async () => "busy"
  const before = (await readState(dir)).runtimes[0]
  expect(await notifyCommandOwner(dir, host, goals, goal.workerSessionID!, "[watch test] READY")).toBe(true)
  expect(await peekGoalInbox(dir, goal.id)).toEqual(["[user] [watch test] READY"])
  expect(rawNotifications()).toEqual([])
  const after = (await readState(dir)).runtimes[0]
  expect(after.activePromptMessageID).toBe(before.activePromptMessageID)
  expect(after.runGeneration).toBe(before.runGeneration)
  expect(host.promptCalls).toHaveLength(1)
})

it("delivers an idle worker notification through a tracked prompt and confirms that turn", async () => {
  const goal = await start()
  const before = (await readState(dir)).runtimes[0]
  expect(await notifyCommandOwner(dir, host, goals, goal.workerSessionID!, "[command test] DONE")).toBe(true)
  const rt = (await readState(dir)).runtimes[0]
  expect(rawNotifications()).toEqual([])
  expect(host.prompts[1]).toContain("[command test] DONE")
  expect(rt.runGeneration).toBe(before.runGeneration + 1)
  expect(rt.activePromptMessageID).not.toBe(before.activePromptMessageID)
  expect(rt.activePromptAcceptedAt).toBeDefined()
  expect(await peekGoalInbox(dir, goal.id)).toEqual([])
  const engine = createLoopEngine({ directory: dir, host, goalService: goals, pollIntervalMs: 60_000, confirmIdleMs: 0 })
  engines.push(engine); engine.start()
  await engine.handleEvent({ type: "message.updated", properties: { info: { id: "notification-answer", role: "assistant", sessionID: goal.workerSessionID, parentID: rt.activePromptMessageID, finish: "stop", time: { completed: Date.now() } } } })
  expect((await readState(dir)).runtimes[0].activeAssistantCompletedAt).toBeDefined()
  await engine.handleEvent({ type: "session.idle", properties: { sessionID: goal.workerSessionID } })
  await engine.handleEvent({ type: "session.idle", properties: { sessionID: goal.workerSessionID } })
  expect(host.promptCalls).toHaveLength(3)
})

it("keeps a paused worker's late notification queued instead of starting it", async () => {
  const goal = await start()
  await goals.pause(dir, goal.id)
  expect(await notifyCommandOwner(dir, host, goals, goal.workerSessionID!, "late exit")).toBe(true)
  expect(await peekGoalInbox(dir, goal.id)).toEqual(["[user] late exit"])
  expect(rawNotifications()).toEqual([])
  expect((await readState(dir)).goals[0].status).toBe("paused")
  expect(host.promptCalls).toHaveLength(1)
})

it("never revives a retired worker with late command output", async () => {
  const goal = await start()
  await goals.clear(dir, goal.id)
  expect(await notifyCommandOwner(dir, host, goals, goal.workerSessionID!, "late exit")).toBe(false)
  expect(rawNotifications()).toEqual([])
})

it("preserves ordinary parent-session notification delivery", async () => {
  await start()
  expect(await notifyCommandOwner(dir, host, goals, "parent", "parent command exited", "parent-agent")).toBe(true)
  expect(rawNotifications()).toEqual([{ ownerSessionID: "parent", message: "parent command exited", agent: "parent-agent" }])
})

it("keeps a live reservation while queuing a worker notification", async () => {
  const goal = await start()
  await mutateState(dir, "reserve", async (state) => {
    state.workspaceCalls = [{ sessionID: goal.workerSessionID!, goalID: goal.id, callID: "live-write", paths: ["file.ts"], at: new Date().toISOString() }]
    return state
  })
  expect(await notifyCommandOwner(dir, host, goals, goal.workerSessionID!, "command exited")).toBe(true)
  expect((await readState(dir)).workspaceCalls).toHaveLength(1)
  expect(await peekGoalInbox(dir, goal.id)).toEqual(["[user] command exited"])
  expect(rawNotifications()).toEqual([])
  expect(host.promptCalls).toHaveLength(1)
})

it("command watch and exit notifications drain once after the original busy turn completes", async () => {
  const goal = await start(true)
  host.sessionStatus = async () => "busy"
  const original = (await readState(dir)).runtimes[0].activePromptMessageID
  const backend = createFakeCommandHost()
  let watchDone!: () => void
  let exitDone!: () => void
  const watch = new Promise<void>((resolve) => { watchDone = resolve })
  const exit = new Promise<void>((resolve) => { exitDone = resolve })
  const service = createCommandService(backend, {
    watchCoalesceMs: 1,
    onWatchNotify: async (directory, owner, message) => { await notifyCommandOwner(directory, host, goals, owner, message); watchDone() },
    onOwnerNotify: async (directory, owner, message) => { const sent = await notifyCommandOwner(directory, host, goals, owner, message); exitDone(); return sent },
  })
  commands.push(service)
  await service.start(dir, { title: "test build", command: "echo", ownerSessionID: goal.workerSessionID!, notifyOnExit: true, watchFilter: "READY" })
  const process = [...backend.procs.values()].at(-1)!
  let timer: ReturnType<typeof setTimeout> | undefined
  const bounded = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("notification callbacks timed out")), 2000) })
  try {
    process.emitOutput("READY\n")
    await Promise.race([watch, bounded])
    process.emitExit({ exitCode: 0 })
    await Promise.race([exit, bounded])
  } finally { if (timer) clearTimeout(timer) }
  expect(await peekGoalInbox(dir, goal.id)).toHaveLength(2)
  expect(rawNotifications()).toEqual([])
  expect((await readState(dir)).runtimes[0].activePromptMessageID).toBe(original)
  expect(host.promptCalls).toHaveLength(1)
  host.sessionStatus = async () => "idle"
  const engine = createLoopEngine({ directory: dir, host, goalService: goals, pollIntervalMs: 60_000, confirmIdleMs: 0 })
  engines.push(engine); engine.start()
  await engine.handleEvent({ type: "message.updated", properties: { info: { id: "original-completed", role: "assistant", sessionID: goal.workerSessionID, parentID: original, finish: "stop", time: { completed: Date.now() } } } })
  for (let i = 0; i < 4; i++) await engine.handleEvent({ type: "session.idle", properties: { sessionID: goal.workerSessionID } })
  expect(host.promptCalls).toHaveLength(2)
  expect(host.prompts[1]).toContain('[watch "test build"]')
  expect(host.prompts[1]).toContain('[command "test build"')
  expect(await peekGoalInbox(dir, goal.id)).toEqual([])
})
