import { describe, expect, it } from "bun:test"
import {
  handleWorkerCreateRequest,
  subscribeNativeRequests,
  type ForkHandlerDeps,
  type NativeRpcClient,
  type RpcCallOptions,
} from "../../src/v2/native-tui"
import type { WorkerCreateRequest } from "../../src/v2/native-rpc"

function request(): WorkerCreateRequest {
  return {
    requestID: "req-1",
    goalID: "goal-1",
    parentSessionID: "parent-1",
    title: "loopd: test goal",
    agent: "plan",
    model: { id: "muse-spark", providerID: "opencode" },
  }
}

interface FakeConduct {
  forks: Array<{ sessionID: string; before?: string }>
  switchedAgents: Array<{ sessionID: string; agent: string }>
  switchedModels: Array<{ sessionID: string; model: unknown }>
  updated: Array<{ sessionID: string; title?: string }>
  completed: unknown[]
  failed: unknown[]
}

function deps(overrides: Partial<{
  parentExists: boolean
  messages: Array<{ id: string }>
  claimWon: boolean
  forkResult: { id: string; parentID?: string | null } | Error
  switchAgentThrows: boolean
}> = {}): { deps: ForkHandlerDeps; seen: FakeConduct } {
  const {
    parentExists = true,
    messages = [{ id: "msg_first" }, { id: "msg_second" }],
    claimWon = true,
    forkResult = { id: "child-1", parentID: "parent-1" },
    switchAgentThrows = false,
  } = overrides
  const seen: FakeConduct = {
    forks: [],
    switchedAgents: [],
    switchedModels: [],
    updated: [],
    completed: [],
    failed: [],
  }
  const deps: ForkHandlerDeps = {
    client: {
      session: {
        fork: async (input) => {
          seen.forks.push(input)
          if (forkResult instanceof Error) throw forkResult
          return forkResult
        },
        switchAgent: async (input) => {
          if (switchAgentThrows) throw new Error("no such agent")
          seen.switchedAgents.push(input)
        },
        switchModel: async (input) => {
          seen.switchedModels.push(input)
        },
        update: async (input) => {
          seen.updated.push(input)
        },
      },
    },
    data: {
      session: {
        get: (id) => (parentExists && id === "parent-1" ? { id } : undefined),
        message: { list: () => messages },
      },
    },
    claimantID: "tui-A",
    claim: async () => ({ won: claimWon }),
    complete: async (r) => {
      seen.completed.push(r)
    },
    fail: async (f) => {
      seen.failed.push(f)
    },
  }
  return { deps, seen }
}

describe("tui fork handler (Probe B executable spec)", () => {
  it("ignores requests for unknown parents without claiming", async () => {
    const { deps: d, seen } = deps({ parentExists: false })
    let claimed = false
    d.claim = async () => {
      claimed = true
      return { won: true }
    }
    await expect(handleWorkerCreateRequest(request(), d)).resolves.toEqual({
      handled: "ignored-unknown-parent",
    })
    expect(claimed).toBe(false)
    expect(seen.forks).toEqual([])
  })

  it("returns quietly when the claim race is lost", async () => {
    const { deps: d, seen } = deps({ claimWon: false })
    await expect(handleWorkerCreateRequest(request(), d)).resolves.toEqual({ handled: "claim-lost" })
    expect(seen.forks).toEqual([])
    expect(seen.completed).toEqual([])
    expect(seen.failed).toEqual([])
  })

  it("forks before the first message and configures agent/model/title", async () => {
    const { deps: d, seen } = deps()
    const outcome = await handleWorkerCreateRequest(request(), d)
    expect(outcome).toEqual({
      handled: "completed",
      childSessionID: "child-1",
      forkInput: { sessionID: "parent-1", before: "msg_first" },
    })
    expect(seen.forks).toEqual([{ sessionID: "parent-1", before: "msg_first" }])
    expect(seen.switchedAgents).toEqual([{ sessionID: "child-1", agent: "plan" }])
    expect(seen.switchedModels).toEqual([{
      sessionID: "child-1",
      model: { id: "muse-spark", providerID: "opencode" },
    }])
    expect(seen.updated).toEqual([{ sessionID: "child-1", title: "loopd: test goal" }])
    expect(seen.completed).toEqual([{
      requestID: "req-1",
      childSessionID: "child-1",
      parentSessionID: "parent-1",
      topology: "v2-native-child",
    }])
  })

  it("forks with no `before` boundary when the parent has no messages", async () => {
    const { deps: d, seen } = deps({ messages: [] })
    const outcome = await handleWorkerCreateRequest(request(), d)
    expect(outcome).toEqual({
      handled: "completed",
      childSessionID: "child-1",
      forkInput: { sessionID: "parent-1" },
    })
    expect(seen.forks).toEqual([{ sessionID: "parent-1" }])
  })

  it("fork throw reports pre-creation failure (fallback safe)", async () => {
    const { deps: d, seen } = deps({ forkResult: new Error("fork exploded") })
    const outcome = await handleWorkerCreateRequest(request(), d)
    expect(outcome).toEqual({ handled: "failed", reason: "fork-failed", preCreation: true })
    expect(seen.failed).toEqual([{
      requestID: "req-1",
      reason: "fork-failed",
      preCreation: true,
      detail: "fork exploded",
    }])
    expect(seen.completed).toEqual([])
  })

  it("parent mismatch reports post-creation failure (never fallback)", async () => {
    const { deps: d, seen } = deps({ forkResult: { id: "child-1", parentID: "someone-else" } })
    const outcome = await handleWorkerCreateRequest(request(), d)
    expect(outcome).toEqual({ handled: "failed", reason: "parent-mismatch", preCreation: false })
    expect(seen.completed).toEqual([])
    expect(seen.failed).toHaveLength(1)
  })

  it("configure failure after creation is post-creation (no fallback)", async () => {
    const { deps: d, seen } = deps({ switchAgentThrows: true })
    const outcome = await handleWorkerCreateRequest(request(), d)
    expect(outcome).toEqual({ handled: "failed", reason: "configure-failed", preCreation: false })
    expect(seen.completed).toEqual([])
  })
})

describe("subscribeNativeRequests location routing (live v2 regression)", () => {
  const REPO = "/Users/duytrinh/Code/opencode-loopd"
  const HOME = "/Users/duytrinh"

  interface FakeBridge {
    pending: Set<string>
    claims: Array<{ requestID: string; claimantID: string }>
  }

  function twoLocationClient(): {
    client: NativeRpcClient
    bridges: Record<string, FakeBridge>
    calls: Array<{ method: string; options: RpcCallOptions | undefined }>
    handlers: Array<(event: { data?: unknown; location?: { directory?: string } }) => void>
  } {
    const bridges: Record<string, FakeBridge> = {
      [HOME]: { pending: new Set(), claims: [] },
      [REPO]: { pending: new Set(["req-1"]), claims: [] },
    }
    const calls: Array<{ method: string; options: RpcCallOptions | undefined }> = []
    const handlers: Array<(event: { data?: unknown; location?: { directory?: string } }) => void> = []
    const bridgeFor = (options?: RpcCallOptions): FakeBridge => {
      // No location = TUI default location (home). Mirrors makeRpc routing:
      // the call lands on whatever bridge owns that location.
      const dir = options?.location?.directory ?? HOME
      return bridges[dir] ?? bridges[HOME]!
    }
    const client: NativeRpcClient = {
      claimRequest: async (input, options) => {
        calls.push({ method: "claimRequest", options })
        const bridge = bridgeFor(options)
        bridge.claims.push(input)
        const won = bridge.pending.delete(input.requestID)
        return { won }
      },
      completeWorkerCreate: async (_result, options) => {
        calls.push({ method: "completeWorkerCreate", options })
      },
      failRequest: async (_failure, options) => {
        calls.push({ method: "failRequest", options })
      },
      events: {
        on: (_name, handler) => {
          handlers.push(handler)
          return () => {}
        },
      },
    }
    return { client, bridges, calls, handlers }
  }

  function subscriberDeps(outcomes: unknown[]) {
    return {
      client: {
        session: {
          fork: async () => ({ id: "child-1", parentID: "parent-1" }),
          switchAgent: async () => {},
          switchModel: async () => {},
          update: async () => {},
        },
      },
      data: {
        session: {
          get: (id: string) => (id === "parent-1" ? { id } : undefined),
          message: { list: () => [{ id: "msg_first" }] },
        },
      },
      claimantID: "tui-A",
      onOutcome: (outcome: unknown, requestID: string) => {
        outcomes.push({ outcome, requestID })
      },
    }
  }

  const req = (): WorkerCreateRequest => ({
    requestID: "req-1",
    goalID: "goal-1",
    parentSessionID: "parent-1",
    title: "loopd: test goal",
  })

  it("routes claim+complete to the emitting location's bridge (repo wins, home untouched)", async () => {
    const { client, bridges, calls, handlers } = twoLocationClient()
    const outcomes: unknown[] = []
    subscribeNativeRequests(client, subscriberDeps(outcomes))
    expect(handlers).toHaveLength(1)
    // Server emitted from the repo location (V2EventRpc.location is required).
    handlers[0]!({ data: req(), location: { directory: REPO } })
    await new Promise((r) => setTimeout(r, 50))
    // Claim reached the repo bridge (which held the pending request) exactly once.
    expect(bridges[REPO]!.claims).toHaveLength(1)
    expect(bridges[HOME]!.claims).toHaveLength(0)
    // Complete followed the same route.
    const completeCalls = calls.filter((c) => c.method === "completeWorkerCreate")
    expect(completeCalls).toHaveLength(1)
    expect(completeCalls[0]!.options).toEqual({ location: { directory: REPO } })
    expect(outcomes).toHaveLength(1)
  })

  it("without routing the claim lands on the default bridge and loses (the live bug)", async () => {
    // Documents the pre-fix behavior: a claim with no location option is
    // routed to the default (home) bridge, which never held req-1.
    const { bridges } = twoLocationClient()
    const homeBridge = bridges[HOME]!
    const won = homeBridge.pending.delete("req-1")
    expect(won).toBe(false)
    expect(bridges[REPO]!.pending.has("req-1")).toBe(true)
  })

  it("event without location still attempts (options undefined, never throws)", async () => {
    const { client, calls, handlers } = twoLocationClient()
    const outcomes: unknown[] = []
    subscribeNativeRequests(client, subscriberDeps(outcomes))
    handlers[0]!({ data: req() })
    await new Promise((r) => setTimeout(r, 50))
    expect(calls[0]).toEqual({ method: "claimRequest", options: undefined })
  })
})
