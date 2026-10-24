// Real OpenCode process + built plugin + loopback fixture model. No live keys,
// user config, shared server, existing goal store, or model quota are used.
import assert from "node:assert/strict"
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { createControlClient } from "../src/infrastructure/control-client"

const root = await mkdtemp(join(tmpdir(), "loopd-host-smoke-"))
const project = join(root, "project")
await mkdir(join(root, "config/opencode/plugins"), { recursive: true })
await mkdir(project)
const binary = process.env.OPENCODE_V2_BIN ?? "opencode"
const expectedVersion = process.env.LOOPD_SMOKE_HOST_VERSION ?? "2.0.32"
const versionProcess = Bun.spawn([binary, "--version"], { env: { PATH: process.env.PATH!, HOME: join(root, "home") }, stdout: "pipe", stderr: "pipe" })
const [versionOutput, versionError, versionExit] = await Promise.all([new Response(versionProcess.stdout).text(), new Response(versionProcess.stderr).text(), versionProcess.exited])
assert.equal(versionExit, 0, `host version probe failed: ${versionError}`)
assert.equal(versionOutput.trim().match(/\bv?(2\.\d+\.\d+)\b/)?.[1], expectedVersion, `Expected tested OpenCode ${expectedVersion}; got ${versionOutput.trim()}`)
const timeoutMs = Number(process.env.LOOPD_SMOKE_TIMEOUT_MS ?? 90000)
assert(Number.isFinite(timeoutMs) && timeoutMs > 0 && timeoutMs <= 300000, "invalid smoke timeout")
const plugin = pathToFileURL(resolve("dist/server.js")).href
await writeFile(join(root, "config/opencode/plugins/loopd.ts"), `export { default } from ${JSON.stringify(plugin)}\n`)
const check = `test "$(cat verified.txt 2>/dev/null)" = 'checked by real host'`
let parentStarted = false
let workerStep = 0
let parentResults = 0
let holdParent = true
let releaseParent: (() => void) | undefined
let modelCalls = 0
let scopedStep = 0
let nextParentCode: string | undefined
let interactiveCalls = 0
let holdInteractive = false
let releaseInteractive: (() => void) | undefined
const requests: Array<{ parent: boolean; action: string }> = []
const server = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  async fetch(request) {
    try {
      const body = await request.json() as any
      modelCalls++
      await writeFile(join(root, `model-request-${modelCalls}.json`), JSON.stringify(body))
      const messages = body.messages ?? []
      const parent = body.model === "fixture"
      let code: string | undefined
      let direct: { name: string; args: unknown } | undefined
      let text = "Fixture response complete."
      let action = "reply"
      if (parent && !parentStarted) {
        parentStarted = true; action = "create"
        code = `return await tools.loopd_create_goal(${JSON.stringify({
          name: "smoke checked delegation", objective: "SMOKE_WORKER: produce verified.txt and pass the configured acceptance check; this is a deterministic host fixture.",
          checkCwd: project, checks: [check], workspaceWrite: true, agent: "build", model: "fixture/worker", maxTurns: 8,
        })})`
      } else if (parent) {
        if (holdParent) await new Promise<void>((resolve) => { releaseParent = resolve })
        if (nextParentCode) { code = nextParentCode; nextParentCode = undefined; action = "owner-control" }
        parentResults = Math.max(parentResults, messages.filter((m: any) => m.role === "user" && JSON.stringify(m.content).includes("completed: real host checked delegation verified")).length)
        text = "The parent remains available during background work."
      } else if (body.model === "manual") {
        interactiveCalls++
        if (holdInteractive) await new Promise<void>((resolve) => { releaseInteractive = resolve })
        action = "interactive-checkpoint"
        text = "Interactive checkpoint: wait for owner steering."
      } else if (body.model === "scoped") {
        action = `scoped-${scopedStep}`
        if (scopedStep === 0) code = 'return await tools.claim_goal_scope({paths:["owned.txt"],runGeneration:1})'
        else if (scopedStep === 1 || scopedStep === 2) {
          direct = { name: "write", args: { path: join(project, scopedStep === 1 ? "outside.txt" : "owned.txt"), content: "scoped proof\n" } }
        } else if (scopedStep === 3) code = 'return await tools.complete_goal({summary:"scoped fixture completed",evidence:"denied outside write and passed owned-file check"})'
        scopedStep++
      } else {
        assert.equal(body.model, "worker", "unexpected fixture model")
        action = `worker-${workerStep}`
        if (workerStep === 0) {
          text = "First execution finished; the objective still needs an automatic continuation."
        } else if (workerStep === 1) {
          // After a normal native continuation, prove claims cannot bypass checks.
          code = `return await tools.complete_goal({summary:"premature fixture claim",evidence:"fixture intentionally has not written the artifact"})`
        } else if (workerStep === 2) {
          const write = body.tools?.find((t: any) => t.function?.name === "write")
          assert(write, "native write tool not exposed")
          direct = { name: write.function.name, args: { path: join(project, "verified.txt"), content: "checked by real host\n" } }
        } else if (workerStep === 3) {
          code = `return await tools.complete_goal({summary:"real host checked delegation verified",evidence:"native write created verified.txt; host acceptance command must pass"})`
        }
        workerStep++
      }
      if (code) {
        const execute = body.tools?.find((t: any) => t.function?.name === "execute")
        assert(execute, "CodeMode execute not exposed")
        direct = { name: execute.function.name, args: { code } }
      }
      requests.push({ parent, action })
      const delta = direct ? { role: "assistant", tool_calls: [{ index: 0, id: `call_fixture_${modelCalls}`, type: "function", function: { name: direct.name, arguments: JSON.stringify(direct.args) } }] } : { role: "assistant", content: text }
      const usage = { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 }
      const chunk = (delta: unknown, finish_reason: string | null, used?: unknown) => ({ id: `chatcmpl_fixture_${modelCalls}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "fixture", choices: [{ index: 0, delta, finish_reason }], ...(used ? { usage: used } : {}) })
      if (!body.stream) return Response.json({ ...chunk({}, null), object: "chat.completion", choices: [{ index: 0, message: delta, finish_reason: direct ? "tool_calls" : "stop" }], usage })
      return new Response([chunk(delta, null), chunk({}, direct ? "tool_calls" : "stop", usage)].map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
    } catch (error) {
      await writeFile(join(root, "fixture-error.txt"), String(error))
      return Response.json({ error: { message: String(error) } }, { status: 500 })
    }
  },
})
await writeFile(join(root, "config/opencode/opencode.json"), JSON.stringify({
  model: "fixture/fixture", snapshots: false,
  providers: { fixture: { env: ["FIXTURE_API_KEY"], package: "@opencode-ai/ai/providers/openai-compatible", settings: { baseURL: `http://127.0.0.1:${server.port}/v1` }, models: Object.fromEntries(["fixture", "worker", "manual", "scoped"].map((id) => [id, { name: `Loopd local ${id}`, limit: { context: 100000, output: 2000 } }])) } },
}))
const env = {
  PATH: process.env.PATH!, HOME: join(root, "home"),
  XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"),
  XDG_STATE_HOME: join(root, "state"), XDG_CACHE_HOME: join(root, "cache"),
  OPENCODE_DB: join(root, "host.db"), OPENCODE_PASSWORD: crypto.randomUUID(), FIXTURE_API_KEY: "local-only",
}
const spawnHost = () => Bun.spawn([binary, "serve", "--hostname", "127.0.0.1", "--port", "0"], { cwd: project, env, stdout: "pipe", stderr: "pipe" })
let child = spawnHost()
let output = ""
let previousOutput = ""
const consume = async (stream: ReadableStream<Uint8Array>) => { for await (const bytes of stream) output += new TextDecoder().decode(bytes) }
let readers = Promise.all([consume(child.stdout), consume(child.stderr)])
async function stopHost() {
  child.kill()
  const kill = setTimeout(() => child.kill("SIGKILL"), 3000)
  try { await child.exited; await readers } finally { clearTimeout(kill) }
}
const deadline = Date.now() + timeoutMs
let stage = "server-ready"
const startedAt = new Date().toISOString()
async function waitFor(name: string, condition: () => Promise<boolean> | boolean) {
  stage = name
  while (Date.now() < deadline) {
    if (await condition()) return
    assert(child.exitCode === null, `private host exited: ${output.slice(-2000)}`)
    await Bun.sleep(50)
  }
  throw new Error(`timeout at ${stage}; modelCalls=${modelCalls}; artifacts=${root}`)
}
let result: Record<string, unknown> = { result: "FAIL", hostVersion: expectedVersion, startedAt }
try {
  await waitFor("server-ready", () => /http:\/\/127\.0\.0\.1:\d+/.test(output))
  let base = output.match(/http:\/\/127\.0\.0\.1:\d+/)![0]
  async function api(route: string, data?: unknown) {
    const response = await fetch(base + route, { method: data === undefined ? "GET" : "POST", headers: { "content-type": "application/json", authorization: `Basic ${btoa(`opencode:${env.OPENCODE_PASSWORD}`)}` }, ...(data === undefined ? {} : { body: JSON.stringify(data) }), signal: AbortSignal.timeout(Math.max(1, Math.min(10000, deadline - Date.now()))) })
    const text = await response.text()
    assert(response.ok, `${route}: ${response.status} ${text.slice(0, 2000)}`)
    return text ? JSON.parse(text) : undefined
  }
  const created = await api("/api/session", { location: { directory: project }, title: "Loopd lifecycle smoke", agent: "build", model: { providerID: "fixture", id: "fixture" } })
  const parentID = created.data.id
  await api(`/api/session/${parentID}/prompt`, { text: "SMOKE_PARENT: create the checked background fixture goal; do not perform the worker's work in this session." })
  let state: any
  await waitFor("parent-busy-before-notification", () => !!releaseParent)
  await waitFor("checked-goal-completion", async () => {
    try { state = JSON.parse(await readFile(join(project, ".opencode/loopd/state.json"), "utf8")) } catch { return false }
    return state.goals?.[0]?.status === "complete"
  })
  const goal = state.goals[0]
  assert.notEqual(goal.workerSessionID, parentID, "goal did not delegate to a separate worker")
  assert.equal(goal.ownerSessionID, parentID)
  const events = (await readFile(join(project, ".opencode/loopd/events.ndjson"), "utf8")).trim().split("\n").map((line) => JSON.parse(line))
  assert.equal(events.filter((e) => e.type === "goal.completion_rejected").length, 1, "premature completion was not rejected exactly once")
  assert.equal(events.filter((e) => e.type === "goal.completed").length, 1, "completion was not recorded exactly once")
  assert(events.filter((e) => e.type === "run.started").length >= 2, "missing normal native continuation")
  assert(events.some((e) => e.type === "run.completed"), "native execution completion was not reconciled")
  // No second user submission: the worker's report must steer the held parent
  // and reach a model request automatically after its current response ends.
  holdParent = false
  releaseParent!()
  await waitFor("parent-result", () => parentResults >= 1)
  assert.equal(parentResults, 1, "duplicate completion notices reached the owner")
  await waitFor("native-sessions-idle", async () => {
    const active = await api("/api/session/active")
    return !(parentID in active.data) && !(goal.workerSessionID in active.data)
  })
  assert.equal(await readFile(join(project, "verified.txt"), "utf8"), "checked by real host\n")

  // Control uses the real dashboard transport against the private instance.
  const controls = createControlClient(project)
  const readStore = async () => JSON.parse(await readFile(join(project, ".opencode/loopd/state.json"), "utf8"))
  holdInteractive = true
  nextParentCode = `return await tools.loopd_create_goal(${JSON.stringify({ name: "smoke manual lifecycle", objective: "wait for explicit owner input", workspaceWrite: false, interactive: true, agent: "build", model: "fixture/manual", maxTurns: 8 })})`
  await api(`/api/session/${parentID}/prompt`, { text: "SMOKE_PARENT: create the manual lifecycle fixture." })
  await waitFor("interactive-worker-busy", async () => interactiveCalls >= 1 && !!releaseInteractive)
  let manual = (await readStore()).goals.find((g: any) => g.name === "smoke manual lifecycle")
  assert(manual?.workerSessionID, "manual worker missing")
  const queued = await controls.executeRaw({ command: "send", goalID: manual.id, args: { message: "SMOKE_STEERING_RECEIPT" } }, 10000)
  assert(queued.ok, `busy steering refused: ${queued.message}`)
  assert.match(queued.message, /queued.*OpenCode inbox/i)
  const held = await readStore()
  assert.equal(held.runtimes.find((r: any) => r.goalID === manual.id).runCount, 1)
  holdInteractive = false
  releaseInteractive!()
  await waitFor("queued-steering-delivered", async () => {
    const active = await api("/api/session/active")
    return interactiveCalls >= 2 && !(manual.workerSessionID in active.data)
  })
  assert.equal(interactiveCalls, 2, "queued steering was not delivered exactly once")
  assert.equal((await readStore()).runtimes.find((r: any) => r.goalID === manual.id).runCount, 1, "manual goal auto-continued")
  const paused = await controls.executeRaw({ command: "pause", goalID: manual.id }, 10000)
  assert(paused.ok, `pause failed: ${paused.message}`)
  assert.equal((await readStore()).goals.find((g: any) => g.id === manual.id).status, "paused")

  // Restart only this disposable process, retaining private persisted state.
  await stopHost()
  previousOutput += output
  output = ""
  child = spawnHost()
  readers = Promise.all([consume(child.stdout), consume(child.stderr)])
  await waitFor("restart-ready", () => /http:\/\/127\.0\.0\.1:\d+/.test(output))
  base = output.match(/http:\/\/127\.0\.0\.1:\d+/)![0]
  // A prompt on the retained parent activates this project's plugin instance.
  await api(`/api/session/${parentID}/prompt`, { text: "SMOKE_PARENT: remain available; do not resume goals automatically." })
  await waitFor("restart-control-ready", async () => {
    const reply = await controls.executeRaw({ command: "list_agents" }, 1500)
    return reply.ok
  })
  manual = (await readStore()).goals.find((g: any) => g.id === manual.id)
  assert.equal(manual.status, "paused", "restart silently resumed a paused goal")
  const beforeResume = interactiveCalls
  releaseInteractive = undefined
  holdInteractive = true
  const resumed = await controls.executeRaw({ command: "resume", goalID: manual.id }, 10000)
  assert(resumed.ok, `resume failed: ${resumed.message}`)
  await waitFor("resumed-worker-busy", () => interactiveCalls > beforeResume && !!releaseInteractive)
  const cleared = await controls.executeRaw({ command: "clear", goalID: manual.id }, 15000)
  assert(cleared.ok, `clear failed: ${cleared.message}`)
  holdInteractive = false
  releaseInteractive!()
  const staleNudge = await controls.executeRaw({ command: "nudge", goalID: manual.id }, 10000)
  assert.equal(staleNudge.ok, false)
  assert.equal((await readStore()).goals.some((g: any) => g.id === manual.id), false, "late execution resurrected a cleared goal")
  nextParentCode = `return await tools.loopd_create_goal(${JSON.stringify({ name: "smoke scoped writes", objective: "claim owned.txt, deny outside writes, create owned.txt and verify", workspaceWrite: true, write_scope: [], checks: ["test -f owned.txt"], checkCwd: project, agent: "build", model: "fixture/scoped", maxTurns: 8 })})`
  await api(`/api/session/${parentID}/prompt`, { text: "SMOKE_PARENT: run the scoped fixture." })
  await waitFor("scoped-completion", async () => (await readStore()).goals.some((g: any) => g.name === "smoke scoped writes" && g.status === "complete"))
  assert.equal(await readFile(join(project, "owned.txt"), "utf8"), "scoped proof\n")
  assert.equal(await readFile(join(project, "outside.txt"), "utf8").catch(() => undefined), undefined, "out-of-scope write executed")
  assert.equal((await readStore()).workspaceCalls?.length ?? 0, 0, "execution fence leaked after rejected tool")
  result = { ...result, result: "PASS", hostBinary: binary, parentID, workerSessionID: goal.workerSessionID, workerTopology: goal.workerTopology, modelCalls, workerStep, parentResults, coverage: ["plugin-activation", "CodeMode-create", "separate-worker", "automatic-continuation", "reject-failed-check", "native-write", "host-checked-completion", "owner-notification", "busy-native-steering", "manual-no-auto-continue", "pause", "restart-preserves-paused-goal", "resume", "clear-during-execution", "cleared-ID-nudge", "scoped-claim", "out-of-scope-write-denied", "owned-write", "failed-tool-fence-cleanup"], notCovered: ["real-provider-quota", "interactive-TUI", "native-child-bridge-topology", "power-loss", "main-session-reads-during-lock-contention"], artifacts: root }
  console.log(JSON.stringify(result, null, 2))
} catch (error) {
  result = { ...result, stage, error: String(error), requests, artifacts: root }
  throw error
} finally {
  releaseParent?.()
  releaseInteractive?.()
  await stopHost()
  server.stop(true)
  await writeFile(join(root, "server.log"), previousOutput + output)
  await writeFile(join(root, "result.json"), JSON.stringify(result, null, 2))
  if (process.env.LOOPD_SMOKE_ARTIFACTS_DIR) await cp(root, resolve(process.env.LOOPD_SMOKE_ARTIFACTS_DIR), { recursive: true })
  console.error(`Lifecycle artifacts: ${root}`)
}
