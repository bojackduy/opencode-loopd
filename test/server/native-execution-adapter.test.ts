import { expect, it } from "bun:test"
import { createV2Host } from "../../src/server/host-adapter"

function fixture() {
  const prompts: any[] = []
  const reports: any[] = []
  const context = {
    location: { directory: "/tmp" },
    session: {
      wait: async (_input: any, _options?: any) => {},
      get: async () => ({ time: { idle: 1000 }, outcome: "succeeded" }),
      context: async () => [{ type: "user", id: "msg_owned", time: { created: 500 }, text: "goal" }],
      prompt: async (input: any) => { prompts.push(input); return { id: input.id } },
      synthetic: async (input: any) => { reports.push(input); return { id: "msg_report" } },
    },
  }
  const statuses = new Map<any, any>()
  return { context, statuses, prompts, reports, host: createV2Host(context as any, statuses) }
}

for (const status of ["idle", "busy"] as const) {
  it(`delivers a background report to an ${status} parent as waking synthetic steering, not a user prompt`, async () => {
    const { host, statuses, prompts, reports } = fixture()
    statuses.set("parent", status)
    expect(await host.notifyOwner("parent", "Goal blocked: provider quota exhausted")).toBe(true)
    expect(reports).toEqual([{
      sessionID: "parent", text: "Goal blocked: provider quota exhausted", delivery: "steer", resume: true,
    }])
    expect(prompts).toEqual([])
    expect(statuses.get("parent")).toBe(status)
  })
}

it("reports failed synthetic delivery without falling back to the user's prompt path", async () => {
  const { host, context, prompts } = fixture()
  context.session.synthetic = async () => { throw new Error("parent unavailable") }
  expect(await host.notifyOwner("parent", "Goal blocked")).toBe(false)
  expect(prompts).toEqual([])
})

it("uses native coordinator idle and durable outcome even with an empty status cache after restart", async () => {
  const { host } = fixture()
  expect(await host.readExecution!("worker")).toMatchObject({ status: "idle", outcome: "succeeded", idleAt: new Date(1000).toISOString(), latestUserMessageID: "msg_owned", deliveredMessageIDs: ["msg_owned"] })
  expect(await host.sessionStatus("worker")).toBe("idle")
})

it("does not turn a failed idle observation into proof from an old succeeded projection", async () => {
  const { context, statuses, host } = fixture()
  context.session.wait = async () => { throw new Error("busy or unreachable") }
  expect(await host.readExecution!("worker")).toEqual({ status: "unknown" })
  statuses.set("worker", "busy")
  expect(await host.readExecution!("worker")).toEqual({ status: "unknown" })
})

it("vetoes new native work arriving during projection reads", async () => {
  const { context, host } = fixture()
  let observations = 0
  context.session.wait = async () => { if (++observations === 2) throw new Error("new queue is running") }
  expect(await host.readExecution!("worker")).toEqual({ status: "unknown" })
})

it("requests native queue delivery explicitly without switching identity or creating another session", async () => {
  const { host, prompts, statuses } = fixture()
  await host.enqueueWorkerMessage!("worker", "msg_receipt", "command done")
  expect(prompts).toEqual([{ sessionID: "worker", id: "msg_receipt", text: "command done", delivery: "queue" }])
  expect(statuses.has("worker")).toBe(false)
})

it("prompt acceptance does not manufacture a cached busy execution", async () => {
  const { host, statuses } = fixture()
  await host.promptWorker({ sessionID: "worker", prompt: "continue", messageID: "msg_receipt" })
  expect(statuses.has("worker")).toBe(false)
})
