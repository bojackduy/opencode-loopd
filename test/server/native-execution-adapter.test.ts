import { expect, it } from "bun:test"
import { createV2Host } from "../../src/server/host-adapter"

function fixture() {
  const prompts: any[] = []
  const context = {
    location: { directory: "/tmp" },
    session: {
      wait: async (_input: any, _options?: any) => {},
      get: async () => ({ time: { idle: 1000 }, outcome: "succeeded" }),
      context: async () => [{ type: "user", id: "msg_owned", time: { created: 500 }, text: "goal" }],
      prompt: async (input: any) => { prompts.push(input); return { id: input.id } },
    },
  }
  const statuses = new Map<any, any>()
  return { context, statuses, prompts, host: createV2Host(context as any, statuses) }
}

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
  expect(await host.readExecution!("worker")).toEqual({ status: "busy" })
})

it("vetoes new native work arriving during projection reads", async () => {
  const { context, host } = fixture()
  let observations = 0
  context.session.wait = async () => { if (++observations === 2) throw new Error("new queue is running") }
  expect(await host.readExecution!("worker")).toEqual({ status: "unknown" })
})

it("requests native queue delivery explicitly without switching identity or creating another session", async () => {
  const { host, prompts } = fixture()
  await host.enqueueWorkerMessage!("worker", "msg_receipt", "command done")
  expect(prompts).toEqual([{ sessionID: "worker", id: "msg_receipt", text: "command done", delivery: "queue" }])
})
