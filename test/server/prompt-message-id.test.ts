import { describe, expect, it } from "bun:test"
import {
  createFakeHost,
  createRealHost,
  createV2Host,
  isV2PromptMessageID,
  newPromptMessageID,
} from "../../src/server/host-adapter"

function v2Context(sent: any[]) {
  return {
    location: { directory: "/tmp/loopd-v2-test" },
    session: {
      create: async (input: any) => ({ id: "worker-v2-1", ...input }),
      switchAgent: async () => {},
      switchModel: async () => {},
      prompt: async (input: any) => {
        sent.push(input)
        // Mirror the real v2 schema: reject non-"msg_" ids like the host does.
        if (input.id !== undefined && !String(input.id).startsWith("msg_")) {
          throw new Error(`Expected a string starting with "msg_"\n  at ["id"]`)
        }
        return { id: input.id ?? "msg_generated" }
      },
      get: async () => { throw new Error("not found") },
      context: async () => [],
      command: async () => {},
      interrupt: async () => {},
    },
  } as any
}

describe("prompt message IDs (dual-host contract)", () => {
  it("generates msg_ IDs valid on both hosts", () => {
    const id = newPromptMessageID()
    expect(id.startsWith("msg_")).toBe(true)
    // v1 accepts any "msg" prefix; v2 requires "msg_".
    expect(id.startsWith("msg")).toBe(true)
    expect(isV2PromptMessageID(id)).toBe(true)
    expect(isV2PromptMessageID("msg-abc")).toBe(false)
  })

  it("v1 passes msg_ and legacy msg- IDs through unchanged, prefixes bare IDs", async () => {
    const bodies: any[] = []
    const host = createRealHost({
      session: {
        promptAsync: async ({ body }: any) => {
          bodies.push(body)
          return { data: {} }
        },
      },
    }, "/tmp/loopd-host-test")

    await host.promptWorker({ sessionID: "w", prompt: "hi", messageID: "msg_abc123" })
    expect(bodies[0].messageID).toBe("msg_abc123")

    await host.promptWorker({ sessionID: "w", prompt: "hi", messageID: "msg-legacy" })
    expect(bodies[1].messageID).toBe("msg-legacy")

    await host.promptWorker({ sessionID: "w", prompt: "hi", messageID: "bare" })
    expect(bodies[2].messageID).toBe("msg_bare")
  })

  it("v2 passes msg_ IDs through unchanged (persisted == delivered == correlated)", async () => {
    const sent: any[] = []
    const host = createV2Host(v2Context(sent), new Map())
    const result = await host.promptWorker({ sessionID: "w", prompt: "hi", messageID: "msg_abc123" })
    expect(sent[0].id).toBe("msg_abc123")
    expect(result.messageID).toBe("msg_abc123")
  })

  it("v2 fails fast with a loopd-scoped error for non-msg_ IDs", async () => {
    const sent: any[] = []
    const host = createV2Host(v2Context(sent), new Map())
    await expect(host.promptWorker({ sessionID: "w", prompt: "hi", messageID: "msg-abc123" }))
      .rejects.toThrow('loopd prompt ID "msg-abc123" is invalid for OpenCode v2')
    expect(sent).toHaveLength(0)
  })

  it("fake host records msg_ transcript IDs", async () => {
    const host = createFakeHost()
    const workerID = await host.createWorker({ parentID: "o", title: "t" })
    const { messageID } = await host.promptWorker({ sessionID: workerID, prompt: "go" })
    expect(messageID!.startsWith("msg_")).toBe(true)
    const transcript = await host.readMessages(workerID, 10)
    expect(transcript[0].messageID).toBe(messageID)
    expect(transcript[1].parentMessageID).toBe(messageID)
  })
})
