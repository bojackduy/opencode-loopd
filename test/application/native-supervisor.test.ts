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

async function blockedEvents() {
  return (await fs.readFile(path.join(dir, ".opencode/loopd/events.ndjson"), "utf8")).trim().split("\n").map((line) => JSON.parse(line)).filter((event) => event.type === "native.reconcile-blocked")
}

// One assignment, so a 20ms maintenance tick can never observe a half-set
// snapshot (idle with the previous turn's outcome still on it).
async function provenIdleWithoutOutcome() {
  const rt = (await readState(dir)).runtimes[0]
  snapshot = { status: "idle", idleAt: new Date().toISOString(), latestUserMessageID: rt.activePromptMessageID }
}

it("native gate diagnostics report the blocking gate once per generation, never on busy or success", async () => {
  const goal = await start()
  const event = { type: "session.idle", properties: { sessionID: goal.workerSessionID } }
  // busy/retry are normal in-progress states, not blocks.
  await engine.handleEvent(event)
  expect(await blockedEvents()).toHaveLength(0)
  // An unproven read is a real block, and repeated identical reads stamp once.
  snapshot = { status: "unknown" }
  await engine.handleEvent(event)
  await engine.handleEvent(event)
  expect(await blockedEvents()).toMatchObject([{ reason: "host-not-idle", runGeneration: 1, phase: "running", observedStatus: "unknown", ownsLatest: false }])
  expect((await readState(dir)).runtimes[0].nativeReconcileBlocked).toEqual({ reason: "host-not-idle", runGeneration: 1 })
  // A new generation gets a fresh budget, so the same gate reports again.
  await mutateState(dir, "new-generation", async (s) => { s.runtimes[0].runGeneration++; return s })
  await engine.handleEvent(event)
  expect(await blockedEvents()).toHaveLength(2)
  // Advancing the turn emits nothing.
  await terminal()
  await engine.handleEvent(event)
  expect(await blockedEvents()).toHaveLength(2)
})

it("charges a sustained provider retry window and blocks instead of parking silently", async () => {
  const { goal } = await goals.start(dir, {
    name: "provider-retry",
    objective: "verify provider retry escalation",
    ownerSessionID: "parent",
    config: { workspaceWrite: false, maxFailures: 1 },
  })
  // A retrying worker never proves idle, so readExecution reports unknown while
  // the host's own status is the only evidence the model call keeps failing.
  host.sessionStatus = async () => "retry"
  snapshot = { status: "unknown" }
  engine = createLoopEngine({ directory: dir, host, goalService: goals, pollIntervalMs: 60_000, confirmIdleMs: 0, providerRetryGraceMs: 20 })
  engine.start()
  const event = { type: "session.idle", properties: { sessionID: goal.workerSessionID } }
  await engine.handleEvent(event)
  expect((await readState(dir)).runtimes[0].providerRetrySince).toBeTruthy()
  // A short blip must not block the goal.
  await engine.handleEvent(event)
  expect((await readState(dir)).goals[0].status).toBe("active")
  // One failure per sustained window; maxFailures 1 therefore blocks now.
  await Bun.sleep(30)
  await engine.handleEvent(event)
  const state = await readState(dir)
  expect(state.runtimes[0].consecutiveFailures).toBe(1)
  expect(state.goals[0].status).toBe("blocked")
  expect(state.goals[0].blocker?.kind).toBe("provider-limit")
  const events = (await fs.readFile(path.join(dir, ".opencode/loopd/events.ndjson"), "utf8")).trim().split("\n")
    .map((line) => JSON.parse(line)).filter((item) => item.type === "native.provider-retry")
  expect(events).toMatchObject([{ consecutiveFailures: 1, runGeneration: 1 }])
  expect((host.sessions as any).notifications ?? []).toHaveLength(1)
})

it("native maintenance recovers a proven idle turn with no outcome through the no-output retry policy", async () => {
  await start(false, 20)
  await provenIdleWithoutOutcome()
  await waitFor(async () => (await readState(dir)).runtimes[0].phase === "waiting_retry")
  engine.stop()
  const rt = (await readState(dir)).runtimes[0]
  expect(rt.consecutiveFailures).toBe(1)
  expect(rt.lastError).toContain("OpenCode closed this turn with no output (no finish reason, no parts, no error)")
  expect(rt.activeRunID).toBeUndefined()
  expect(rt.nativeInboxMessageIDs).toBeUndefined()
})

for (const blocker of ["busy", "retry", "unknown", "live-tool", "undelivered", "operation", "interactive", "closing"] as const) {
  it(`native outputless maintenance preserves the ${blocker} gate`, async () => {
    const goal = await start(false, 20)
    // Install the fence while the host still reports busy, so no maintenance
    // tick can ever observe an unfenced proven-idle turn.
    await mutateState(dir, "recovery-fence", async (s) => {
      if (blocker === "live-tool") s.workspaceCalls = [{ callID: "live", sessionID: goal.workerSessionID!, goalID: goal.id, paths: [], at: new Date().toISOString() }]
      if (blocker === "undelivered") s.runtimes[0].nativeInboxMessageIDs = ["pending"]
      if (blocker === "operation") s.workspaceOperation = { id: "operation", goalID: goal.id, sessionID: goal.workerSessionID! }
      if (blocker === "closing") s.goals[0].scopeClosing = true
      if (blocker === "interactive") s.goals[0].interactive = true
      return s
    })
    if (blocker === "busy" || blocker === "retry" || blocker === "unknown") snapshot = { status: blocker }
    else await provenIdleWithoutOutcome()
    await Bun.sleep(120)
    engine.stop()
    const rt = (await readState(dir)).runtimes[0]
    expect(rt.phase).toBe("running")
    expect(rt.consecutiveFailures).toBe(0)
    expect(rt.activeRunID).toBeDefined()
    expect(host.promptCalls).toHaveLength(1)
    // The manual-goal fence blocks the no-output recovery at its own gate.
    if (blocker === "interactive") expect(rt.nativeReconcileBlocked?.reason).toBe("missing-outcome")
  })
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

it("nudge overrides a dead unconfirmed prompt on an idle worker with an expired lease", async () => {
  const goal = await start()
  const quietAgo = new Date(Date.now() - 20 * 60_000).toISOString()
  // Long-accepted prompt, expired lease, no activity: delivery bookkeeping
  // will never confirm it, and the engine's native path never re-prompts.
  await mutateState(dir, "stale-accepted-prompt", async (s) => {
    const rt = s.runtimes[0]
    rt.turnStartedAt = quietAgo
    rt.lastActivityAt = quietAgo
    rt.activePromptAcceptedAt = quietAgo
    rt.leaseExpiresAt = new Date(Date.now() - 60_000).toISOString()
    return s
  })
  const original = (await readState(dir)).runtimes[0].activePromptMessageID!
  // Host shows idle but someone else's message is latest: foreign-prompt.
  snapshot = { status: "idle", idleAt: new Date().toISOString(), latestUserMessageID: "msg_someone-else", deliveredMessageIDs: [] }
  host.sessionStatus = async () => "idle"
  const result = await goals.nudge(dir, goal.id)
  expect(result.ok).toBe(true)
  // A fresh turn went out with a new prompt ID instead of a refusal.
  expect(host.promptCalls).toHaveLength(2)
  const rt = (await readState(dir)).runtimes[0]
  expect(rt.activePromptMessageID).toBeDefined()
  expect(rt.activePromptMessageID).not.toBe(original)
})

it("nudge still refuses an unconfirmed prompt while the lease is valid", async () => {
  const goal = await start()
  const quietAgo = new Date(Date.now() - 20 * 60_000).toISOString()
  await mutateState(dir, "fresh-lease", async (s) => {
    const rt = s.runtimes[0]
    rt.lastActivityAt = quietAgo
    rt.activePromptAcceptedAt = quietAgo
    rt.leaseExpiresAt = new Date(Date.now() + 60_000).toISOString()
    return s
  })
  snapshot = { status: "idle", idleAt: new Date().toISOString(), latestUserMessageID: "msg_someone-else", deliveredMessageIDs: [] }
  host.sessionStatus = async () => "idle"
  const result = await goals.nudge(dir, goal.id)
  expect(result).toMatchObject({ ok: false, outcome: "blocked" })
  expect(result.message).toContain("delivery is unconfirmed")
  expect(host.promptCalls).toHaveLength(1)
})
