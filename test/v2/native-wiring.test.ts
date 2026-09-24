import { describe, expect, it } from "bun:test"
import { setupNativeServer } from "../../src/v2/native-server"
import { subscribeNativeRequests, type NativeRpcClient } from "../../src/v2/native-tui"
import { NATIVE_RPC_ID } from "../../src/v2/native-rpc"

interface CapturedRegistration {
  definition: any
  handlers: Record<string, (input: any) => Promise<any>>
  emitted: Array<{ name: string; data: unknown }>
  disposed: boolean
}

function fakeServerContext(overrides: {
  registerThrows?: boolean
  noEmit?: boolean
} = {}): { context: any; captured: CapturedRegistration } {
  const captured: CapturedRegistration = { definition: undefined, handlers: {}, emitted: [], disposed: false }
  return {
    captured,
    context: {
      rpc: {
        register: async (definition: any, handlers: Record<string, (input: any) => Promise<any>>) => {
          if (overrides.registerThrows) throw new Error("rpc unsupported")
          captured.definition = definition
          captured.handlers = handlers
          return {
            events: {
              emit: (name: string, data: unknown) => {
                if (overrides.noEmit) throw new Error("no transport")
                captured.emitted.push({ name, data })
              },
            },
            dispose: async () => {
              captured.disposed = true
            },
          }
        },
      },
    },
  }
}

describe("native server wiring", () => {
  it("registers the loopd.native definition", async () => {
    const { context, captured } = fakeServerContext()
    const server = await setupNativeServer(context)
    expect(server).toBeDefined()
    expect(captured.definition.id).toBe(NATIVE_RPC_ID)
    expect(Object.keys(captured.handlers).sort()).toEqual(["claimRequest", "completeWorkerCreate", "failRequest"])
    await server!.dispose()
    expect(captured.disposed).toBe(true)
  })

  it("runs a full TUI round-trip through the captured handlers", async () => {
    const { context, captured } = fakeServerContext()
    const server = await setupNativeServer(context)
    const pending = server!.requestWorker({
      goalID: "goal-1",
      parentSessionID: "parent-1",
      title: "loopd: test",
      agent: "plan",
      model: { providerID: "opencode", modelID: "muse-spark" },
      directory: "/tmp/x",
    })
    expect(captured.emitted).toHaveLength(1)
    expect(captured.emitted[0].name).toBe("workerCreateRequested")
    const request = captured.emitted[0].data as any
    expect(request.parentSessionID).toBe("parent-1")
    expect(request.title).toBe("loopd: test")
    expect(request.model).toEqual({ id: "muse-spark", providerID: "opencode" })
    expect(request.directory).toBe("/tmp/x")

    // Two TUIs race; exactly one wins.
    const ackA = await captured.handlers.claimRequest({ requestID: request.requestID, claimantID: "tui-A" }, undefined)
    const ackB = await captured.handlers.claimRequest({ requestID: request.requestID, claimantID: "tui-B" }, undefined)
    expect(ackA).toEqual({ requestID: request.requestID, claimantID: "tui-A", won: true })
    expect(ackB.won).toBe(false)

    await captured.handlers.completeWorkerCreate({
      requestID: request.requestID,
      childSessionID: "child-1",
      parentSessionID: "parent-1",
      topology: "v2-native-child",
    }, undefined)
    await expect(pending).resolves.toEqual({
      kind: "native-child",
      childSessionID: "child-1",
      parentSessionID: "parent-1",
      topology: "v2-native-child",
    })
    await server!.dispose()
  })

  it("disposal rejects pending requests", async () => {
    const { context } = fakeServerContext()
    const server = await setupNativeServer(context)
    const pending = server!.requestWorker({
      parentSessionID: "parent-1",
      title: "loopd: test",
      directory: "/tmp/x",
    })
    void pending.catch(() => {})
    await server!.dispose()
    await expect(pending).rejects.toMatchObject({ code: "disposed" })
  })

  it("returns undefined when RPC is unsupported", async () => {
    await expect(setupNativeServer({} as any)).resolves.toBeUndefined()
    await expect(setupNativeServer({ rpc: {} } as any)).resolves.toBeUndefined()
    const { context } = fakeServerContext({ registerThrows: true })
    await expect(setupNativeServer(context)).resolves.toBeUndefined()
  })
})

describe("native TUI subscriber", () => {
  function fakeRpcClient(): {
    client: NativeRpcClient
    claims: unknown[]
    completed: unknown[]
    failed: unknown[]
    handlers: Array<(event: { data?: unknown }) => void>
    unsubscribed: boolean
    claimWon: boolean
  } {
    const state = {
      claims: [] as unknown[],
      completed: [] as unknown[],
      failed: [] as unknown[],
      handlers: [] as Array<(event: { data?: unknown }) => void>,
      unsubscribed: false,
      claimWon: true,
    }
    const client: NativeRpcClient = {
      claimRequest: async (input) => {
        state.claims.push(input)
        return { won: state.claimWon }
      },
      completeWorkerCreate: async (result) => {
        state.completed.push(result)
      },
      failRequest: async (failure) => {
        state.failed.push(failure)
      },
      events: {
        on: (name, handler) => {
          expect(name).toBe("workerCreateRequested")
          state.handlers.push(handler)
          return () => {
            state.unsubscribed = true
          }
        },
      },
    }
    return { client, state }
  }

  function baseDeps(overrides: { parentExists?: boolean; locationOk?: boolean } = {}) {
    const { parentExists = true, locationOk = true } = overrides
    const forks: unknown[] = []
    return {
      forks,
      deps: {
        client: {
          session: {
            fork: async (input: { sessionID: string; before?: string }) => {
              forks.push(input)
              return { id: "child-1", parentID: "parent-1" }
            },
            switchAgent: async () => {},
            switchModel: async () => {},
            update: async () => {},
          },
        },
        data: {
          session: {
            get: (id: string) => (parentExists && id === "parent-1" ? { id } : undefined),
            message: { list: () => [{ id: "msg_first" }] },
          },
        },
        claimantID: "tui-A",
        isKnownParent: () => locationOk,
      },
    }
  }

  const flush = () => new Promise((r) => setTimeout(r, 10))

  it("handles a full request event and unsubscribes on cleanup", async () => {
    const { client, state } = fakeRpcClient()
    const { deps, forks } = baseDeps()
    const unsubscribe = subscribeNativeRequests(client, deps as any)
    state.handlers[0]({ data: { requestID: "req-1", goalID: "g", parentSessionID: "parent-1", title: "t" } })
    await flush()
    expect(forks).toEqual([{ sessionID: "parent-1", before: "msg_first" }])
    expect(state.completed).toEqual([{
      requestID: "req-1",
      childSessionID: "child-1",
      parentSessionID: "parent-1",
      topology: "v2-native-child",
    }])
    unsubscribe()
    expect(state.unsubscribed).toBe(true)
  })

  it("ignores malformed events and location-mismatched parents", async () => {
    const { client, state } = fakeRpcClient()
    const { deps, forks } = baseDeps({ locationOk: false })
    subscribeNativeRequests(client, deps as any)
    state.handlers[0]({ data: undefined })
    state.handlers[0]({ data: { nope: true } })
    state.handlers[0]({ data: { requestID: "req-1", goalID: "g", parentSessionID: "parent-1", title: "t" } })
    await flush()
    expect(forks).toEqual([])
    expect(state.claims).toEqual([])
  })
})
