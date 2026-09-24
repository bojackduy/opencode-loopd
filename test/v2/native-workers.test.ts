import { describe, expect, it, beforeEach, afterEach } from "bun:test"
import { promises as fs } from "fs"
import path from "path"
import os from "os"
import { randomUUID } from "crypto"
import {
  createRealHost,
  createV2Host,
  toWorkerCreation,
  type SessionStatusType,
} from "../../src/server/host-adapter"
import { NativeBridgeError } from "../../src/v2/native-bridge"
import type { BridgeOutcome } from "../../src/v2/native-bridge"
import { readState, mutateState } from "../../src/infrastructure/state-repository"

function tmpDir(): string {
  return path.join(os.tmpdir(), `loopd-v2native-${randomUUID()}`)
}

interface FakeV2Session {
  calls: { switchAgent: unknown[]; switchModel: unknown[]; update: unknown[]; create: unknown[] }
  childParentID: string | undefined
  makeContext: (directory: string) => any
}

function fakeV2(childParentID: string | undefined = "parent-1"): FakeV2Session {
  const calls = { switchAgent: [] as unknown[], switchModel: [] as unknown[], update: [] as unknown[], create: [] as unknown[] }
  return {
    calls,
    childParentID,
    makeContext: (directory: string) => ({
      location: { directory },
      session: {
        create: async (input: any) => {
          calls.create.push(input)
          return { id: "root-worker-1" }
        },
        get: async ({ sessionID }: any) => {
          if (sessionID === "child-1") return { id: "child-1", parentID: childParentID }
          return { id: sessionID }
        },
        switchAgent: async (input: any) => {
          calls.switchAgent.push(input)
        },
        switchModel: async (input: any) => {
          calls.switchModel.push(input)
        },
        update: async (input: any) => {
          calls.update.push(input)
        },
      },
    }),
  }
}

describe("v2 native workers (Phase 3)", () => {
  it("returns the native child with verified parent + configuration", async () => {
    const fake = fakeV2("parent-1")
    const statuses = new Map<string, SessionStatusType>()
    const host = createV2Host(fake.makeContext("/tmp/x"), statuses, {
      native: {
        requestWorker: async () => ({
          kind: "native-child",
          childSessionID: "child-1",
          parentSessionID: "parent-1",
          topology: "v2-native-child",
        } satisfies BridgeOutcome),
      },
    })
    const result = await host.createWorker({
      parentID: "parent-1",
      title: "loopd: test",
      agent: "plan",
      model: { providerID: "opencode", modelID: "muse-spark" },
      goalID: "goal-1",
    })
    expect(result).toEqual({ sessionID: "child-1", topology: "v2-native-child", nativeParentID: "parent-1" })
    expect(fake.calls.switchAgent).toEqual([{ sessionID: "child-1", agent: "plan" }])
    expect(fake.calls.switchModel).toEqual([{
      sessionID: "child-1",
      model: { id: "muse-spark", providerID: "opencode" },
    }])
    expect(fake.calls.update).toEqual([{ sessionID: "child-1", title: "loopd: test" }])
    expect(fake.calls.create).toEqual([])
    expect(statuses.get("child-1")).toBe("idle")
  })

  it("throws on parent mismatch (never uses the wrong session)", async () => {
    const fake = fakeV2("someone-else")
    const statuses = new Map<string, SessionStatusType>()
    const host = createV2Host(fake.makeContext("/tmp/x"), statuses, {
      native: {
        requestWorker: async () => ({
          kind: "native-child",
          childSessionID: "child-1",
          parentSessionID: "parent-1",
          topology: "v2-native-child",
        } satisfies BridgeOutcome),
      },
    })
    await expect(host.createWorker({ parentID: "parent-1", title: "loopd: test" }))
      .rejects.toThrow("parent-mismatch")
    expect(fake.calls.switchAgent).toEqual([])
  })

  it("unclaimed requests take the flagged root fallback (metadata path)", async () => {
    const fake = fakeV2()
    const statuses = new Map<string, SessionStatusType>()
    const host = createV2Host(fake.makeContext("/tmp/x"), statuses, {
      native: { requestWorker: async () => ({ kind: "unclaimed" } satisfies BridgeOutcome) },
    })
    const result = await host.createWorker({ parentID: "parent-1", title: "loopd: test" })
    expect(result).toEqual({ sessionID: "root-worker-1", topology: "v2-root-fallback" })
    expect(fake.calls.create).toHaveLength(1)
    expect((fake.calls.create[0] as any).metadata).toEqual({ "loopd.parentID": "parent-1" })
  })

  it("pre-creation failure takes the flagged root fallback", async () => {
    const fake = fakeV2()
    const host = createV2Host(fake.makeContext("/tmp/x"), new Map(), {
      native: {
        requestWorker: async () => ({ kind: "fallback-safe", reason: "fork-failed", detail: "boom" } satisfies BridgeOutcome),
      },
    })
    const result = await host.createWorker({ parentID: "parent-1", title: "loopd: test" })
    expect(result).toEqual({ sessionID: "root-worker-1", topology: "v2-root-fallback" })
  })

  it("claimed-timeout propagates (fail startup, never duplicate)", async () => {
    const fake = fakeV2()
    const host = createV2Host(fake.makeContext("/tmp/x"), new Map(), {
      native: {
        requestWorker: async () => {
          throw new NativeBridgeError("claimed-timeout", "req-1", "vanished")
        },
      },
    })
    await expect(host.createWorker({ parentID: "parent-1", title: "loopd: test" }))
      .rejects.toBeInstanceOf(NativeBridgeError)
    expect(fake.calls.create).toEqual([])
  })

  it("no bridge wired takes the flagged root fallback", async () => {
    const fake = fakeV2()
    const host = createV2Host(fake.makeContext("/tmp/x"), new Map())
    const result = await host.createWorker({ parentID: "parent-1", title: "loopd: test" })
    expect(result).toEqual({ sessionID: "root-worker-1", topology: "v2-root-fallback" })
  })
})

describe("host return-shape compatibility", () => {
  it("v1 real host still returns the bare session-ID string", async () => {
    const host = createRealHost({
      session: { create: async () => ({ data: { id: "worker-1" } }) },
    }, "/tmp/loopd-host-test")
    const result = await host.createWorker({ parentID: "owner-1", title: "loopd: test" })
    expect(typeof result).toBe("string")
    expect(result).toBe("worker-1")
  })

  it("toWorkerCreation normalizes both forms", () => {
    expect(toWorkerCreation("abc")).toEqual({ sessionID: "abc" })
    expect(toWorkerCreation({ sessionID: "abc", topology: "v2-native-child", nativeParentID: "p" }))
      .toEqual({ sessionID: "abc", topology: "v2-native-child", nativeParentID: "p" })
  })
})

describe("topology persistence across restart", () => {
  let dir: string
  beforeEach(async () => {
    dir = tmpDir()
    await fs.mkdir(dir, { recursive: true })
  })
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it("keeps workerTopology + nativeParentID through write/read", async () => {
    const state = await readState(dir)
    const now = new Date().toISOString()
    state.goals.push({
      id: "g1" as any,
      name: "test",
      objective: "obj",
      status: "active",
      ownerSessionID: "parent-1",
      workerSessionID: "child-1",
      workerTopology: "v2-native-child",
      nativeParentID: "parent-1",
      tokensUsed: 0,
      timeUsedSeconds: 0,
      config: {},
      createdAt: now,
      updatedAt: now,
    } as any)
    const { writeState } = await import("../../src/infrastructure/state-repository")
    await writeState(dir, state)
    const reloaded = await readState(dir)
    expect(reloaded.goals[0].workerTopology).toBe("v2-native-child")
    expect(reloaded.goals[0].nativeParentID).toBe("parent-1")

    await mutateState(dir, "test", async (s) => {
      const g = s.goals.find((x) => x.id === ("g1" as any))
      if (g) g.workerSessionID = "child-1"
      return s
    })
    const reloaded2 = await readState(dir)
    expect(reloaded2.goals[0].workerTopology).toBe("v2-native-child")
  })
})
