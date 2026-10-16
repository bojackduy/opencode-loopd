import { afterEach, beforeEach, expect, it } from "bun:test"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { createFakeHost, type NativeExecutionSnapshot } from "../../src/server/host-adapter"
import { createGoalService } from "../../src/application/goal-service"
import { createLoopEngine } from "../../src/application/loop-engine"
import { mutateState, peekGoalInbox, readState } from "../../src/infrastructure/state-repository"
import { workerActivityLabel } from "../../src/domain/status-labels"

let dir: string
let host: ReturnType<typeof createFakeHost>
let goals: ReturnType<typeof createGoalService>
let engine: ReturnType<typeof createLoopEngine>
let snapshot: NativeExecutionSnapshot
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "loopd-native-supervisor-"))
  host = createFakeHost({ autoCompletePrompts: false })
  snapshot = { status: "busy" }
  host.readExecution = async () => snapshot
  goals = createGoalService(host)
})
afterEach(async () => { engine?.stop(); await fs.rm(dir, { recursive: true, force: true }) })
async function start(interactive = false, pollIntervalMs = 60_000) {
  const { goal } = await goals.start(dir, { name: "native", objective: "verify native supervision", ownerSessionID: "parent", interactive, config: { workspaceWrite: false } })
  engine = createLoopEngine({ directory: dir, host, goalService: goals, pollIntervalMs, confirmIdleMs: 0 })
  engine.start()
  return goal
}
async function terminal() {
  const rt = (await readState(dir)).runtimes[0]
  snapshot = { status: "idle", outcome: "succeeded", idleAt: new Date().toISOString(), latestUserMessageID: rt.activePromptMessageID }
}
async function waitFor(test: () => Promise<boolean>) {
  const deadline = Date.now() + 3000
  while (!await test()) { if (Date.now() >= deadline) throw new Error("timed out"); await Bun.sleep(10) }
}

it("continues once from native success without idle debounce or transcript completion inference", async () => {
  const goal = await start()
  const windows: Array<number | undefined> = []
  host.readMessages = async (_sessionID, limit) => { windows.push(limit); return [] }
  await terminal()
  await engine.handleEvent({ type: "session.execution.succeeded", properties: { sessionID: goal.workerSessionID } })
  expect(host.promptCalls).toHaveLength(2)
  expect(windows).not.toContain(200)
  await engine.handleEvent({ type: "session.execution.succeeded", properties: { sessionID: goal.workerSessionID } })
  expect(host.promptCalls).toHaveLength(2)
})

it("does not let idle/message events or expired leases finish a busy native execution", async () => {
  const goal = await start()
  await mutateState(dir, "expired", async (s) => { s.runtimes[0].leaseExpiresAt = new Date(0).toISOString(); return s })
  await engine.handleEvent({ type: "message.updated", properties: { info: { sessionID: goal.workerSessionID, role: "assistant", time: { completed: Date.now() } } } })
  await engine.handleEvent({ type: "session.idle", properties: { sessionID: goal.workerSessionID } })
  expect(host.promptCalls).toHaveLength(1)
  expect(workerActivityLabel((await readState(dir)).runtimes[0])).toMatchObject({ short: "Running", acting: true })
})

for (const blocker of ["old-outcome", "foreign-prompt", "unknown", "live-tool"] as const) {
  it(`rejects native completion with ${blocker} evidence`, async () => {
    const goal = await start()
    await terminal()
    if (blocker === "old-outcome") snapshot.idleAt = new Date(0).toISOString()
    if (blocker === "foreign-prompt") snapshot.latestUserMessageID = "msg_foreign"
    if (blocker === "unknown") snapshot = { status: "unknown" }
    if (blocker === "live-tool") await mutateState(dir, "reserve", async (s) => { s.workspaceCalls = [{ callID: "write", sessionID: goal.workerSessionID!, goalID: goal.id, paths: ["source.ts"], at: new Date().toISOString() }]; return s })
    await engine.handleEvent({ type: "session.execution.succeeded", properties: { sessionID: goal.workerSessionID } })
    expect(host.promptCalls).toHaveLength(1)
    expect((await readState(dir)).runtimes[0].phase).toBe("running")
  })
}

it("reconciles missed native completion after engine restart without a manual nudge", async () => {
  await start()
  engine.stop()
  await terminal()
  await mutateState(dir, "expired-restart", async (s) => { s.runtimes[0].leaseExpiresAt = new Date(0).toISOString(); return s })
  await goals.reconcile(dir)
  expect((await readState(dir)).runtimes[0].activePromptMessageID).toBe(snapshot.latestUserMessageID)
  engine = createLoopEngine({ directory: dir, host, goalService: goals, pollIntervalMs: 20 })
  engine.start()
  await waitFor(async () => host.promptCalls.length === 2)
  engine.stop()
  expect(host.promptCalls).toHaveLength(2)
})

it("pauses native interruption rather than treating user stop as a retryable failure", async () => {
  const goal = await start()
  await terminal(); snapshot.outcome = "interrupted"
  await engine.handleEvent({ type: "session.execution.interrupted", properties: { sessionID: goal.workerSessionID, reason: "user" } })
  const state = await readState(dir)
  expect(state.goals[0].status).toBe("paused")
  expect(state.runtimes[0].consecutiveFailures).toBe(0)
  expect(host.promptCalls).toHaveLength(1)
})

it("does not revive a cleared goal on late native success", async () => {
  const goal = await start()
  await terminal()
  await goals.clear(dir, goal.id)
  await engine.handleEvent({ type: "session.execution.succeeded", properties: { sessionID: goal.workerSessionID } })
  expect((await readState(dir)).goals).toEqual([])
  expect(host.promptCalls).toHaveLength(1)
})

it("migrates duplicate legacy runtime tool tracking only on a proven native terminal outcome", async () => {
  const goal = await start()
  await mutateState(dir, "legacy-tracking", async (s) => { s.runtimes[0].activeToolCallIDs = ["old-observation"]; return s })
  await engine.handleEvent({ type: "session.idle", properties: { sessionID: goal.workerSessionID } })
  expect((await readState(dir)).runtimes[0].activeToolCallIDs).toEqual(["old-observation"])
  await terminal()
  await engine.handleEvent({ type: "session.execution.succeeded", properties: { sessionID: goal.workerSessionID } })
  expect((await readState(dir)).runtimes[0].activeToolCallIDs).toEqual([])
  expect(host.promptCalls).toHaveLength(2)
})

it("retains ambiguous native queue receipt without claiming acceptance or retrying a prompt", async () => {
  host.enqueueWorkerMessage = async () => { throw new Error("transport timeout") }
  const goal = await start()
  expect(await goals.sendUserMessage(dir, goal.id, "watch READY")).toMatchObject({ ok: false, outcome: "blocked" })
  expect((await readState(dir)).runtimes[0].nativeInboxMessageIDs).toHaveLength(1)
  expect(await peekGoalInbox(dir, goal.id)).toEqual([])
  await terminal()
  await engine.handleEvent({ type: "session.execution.succeeded", properties: { sessionID: goal.workerSessionID } })
  expect(host.promptCalls).toHaveLength(1)
})

it("records native completion but never auto-continues an interactive goal", async () => {
  const goal = await start(true)
  await terminal()
  await engine.handleEvent({ type: "session.execution.succeeded", properties: { sessionID: goal.workerSessionID } })
  expect(host.promptCalls).toHaveLength(1)
  expect((await readState(dir)).runtimes[0].phase).toBe("idle")
})

it("routes terminal native failure through goal retry policy once", async () => {
  const goal = await start()
  await terminal(); snapshot.outcome = "failed"
  await engine.handleEvent({ type: "session.execution.failed", properties: { sessionID: goal.workerSessionID } })
  await engine.handleEvent({ type: "session.execution.failed", properties: { sessionID: goal.workerSessionID } })
  const rt = (await readState(dir)).runtimes[0]
  expect(rt.phase).toBe("waiting_retry")
  expect(rt.consecutiveFailures).toBe(1)
  expect(host.promptCalls).toHaveLength(1)
})

it("uses native queued receipts rather than copying busy notification contents into loopd's inbox", async () => {
  const queued: string[] = []
  host.enqueueWorkerMessage = async (_sessionID, id) => { queued.push(id) }
  const goal = await start()
  expect(await goals.sendUserMessage(dir, goal.id, "watch READY")).toMatchObject({ ok: true, outcome: "queued" })
  expect(await goals.sendUserMessage(dir, goal.id, "command exited")).toMatchObject({ ok: true, outcome: "queued" })
  expect(await peekGoalInbox(dir, goal.id)).toEqual([])
  expect(host.promptCalls).toHaveLength(1)
  await terminal()
  await engine.handleEvent({ type: "session.execution.succeeded", properties: { sessionID: goal.workerSessionID } })
  expect(host.promptCalls).toHaveLength(1)
  snapshot.latestUserMessageID = queued.at(-1)
  snapshot.deliveredMessageIDs = queued
  await engine.handleEvent({ type: "session.execution.succeeded", properties: { sessionID: goal.workerSessionID } })
  expect(host.promptCalls).toHaveLength(2)
  expect((await readState(dir)).runtimes[0].nativeInboxMessageIDs).toBeUndefined()
})

it("reports accepted but invisible nudge as queued, and never duplicates its pending receipt", async () => {
  const goal = await start()
  const original = (await readState(dir)).runtimes[0].activePromptMessageID!
  snapshot = { status: "idle", latestUserMessageID: original, deliveredMessageIDs: [original] }
  host.sessionStatus = async () => "idle"
  // The host accepts the new inbox item but has not delivered it to context.
  host.readMessages = async () => []
  const result = await goals.nudge(dir, goal.id)
  expect(result).toMatchObject({ ok: true, outcome: "queued" })
  expect(result.message).toContain("delivery and execution are not confirmed")
  const pending = (await readState(dir)).runtimes[0]
  expect(pending.activePromptAcceptedAt).toBeDefined()
  expect(pending.activePromptObservedAt).toBeUndefined()
  expect(await goals.nudge(dir, goal.id)).toMatchObject({ ok: false, outcome: "blocked" })
  expect(host.promptCalls).toHaveLength(2)
  expect((await readState(dir)).runtimes[0].activePromptMessageID).toBe(pending.activePromptMessageID)
})

it("retains pending native notification receipts rather than dropping them on nudge", async () => {
  const goal = await start()
  const original = (await readState(dir)).runtimes[0].activePromptMessageID!
  await mutateState(dir, "queued-notification", async (s) => { s.runtimes[0].nativeInboxMessageIDs = ["msg_pending"]; return s })
  snapshot = { status: "idle", latestUserMessageID: original, deliveredMessageIDs: [original] }
  host.sessionStatus = async () => "idle"
  expect(await goals.nudge(dir, goal.id)).toMatchObject({ ok: false, outcome: "blocked" })
  expect(host.promptCalls).toHaveLength(1)
  expect((await readState(dir)).runtimes[0].nativeInboxMessageIDs).toEqual(["msg_pending"])
})
