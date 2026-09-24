// ─── v2 Native Server Wiring ─────────────────────────────────────────────────
// Binds the pure bridge coordinator (native-bridge.ts) to a live v2 server
// plugin context: registers the loopd.native RPC methods, emits
// workerCreateRequested, and exposes requestWorker for createV2Host.
// Returns undefined when the host has no RPC domain — the caller then uses
// the flagged root fallback (never throws for missing RPC support).

import { randomUUID } from "crypto"
import { createNativeBridge, type BridgeOutcome, type NativeBridge } from "./native-bridge"
import { nativeRpcDefinition, type WorkerCreateRequest } from "./native-rpc"

export interface NativeRpcRegistration {
  events: {
    emit: (name: string, data: unknown) => unknown
  }
  dispose: () => Promise<void>
}

export interface NativeServerHostContext {
  rpc: {
    register: (
      definition: unknown,
      handlers: Record<string, (input: any, context: unknown) => Promise<unknown>>,
    ) => Promise<NativeRpcRegistration>
  }
}

export interface NativeWorkerInput {
  goalID?: string
  parentSessionID: string
  title: string
  agent?: string
  model?: { providerID: string; modelID: string }
  directory: string
}

export interface NativeServer {
  bridge: NativeBridge
  requestWorker: (input: NativeWorkerInput) => Promise<BridgeOutcome>
  dispose: () => Promise<void>
}

export async function setupNativeServer(context: NativeServerHostContext): Promise<NativeServer | undefined> {
  if (!context || !context.rpc || typeof context.rpc.register !== "function") return undefined
  const bridge = createNativeBridge()
  let registration: NativeRpcRegistration
  try {
    registration = await context.rpc.register(nativeRpcDefinition, {
      claimRequest: async (input: { requestID: string; claimantID: string }) => {
        const { won } = bridge.handleClaim(input)
        return { requestID: input.requestID, claimantID: input.claimantID, won }
      },
      completeWorkerCreate: async (input) => {
        bridge.handleComplete(input)
        return {}
      },
      failRequest: async (input) => {
        bridge.handleFailure(input)
        return {}
      },
    })
  } catch {
    bridge.dispose()
    return undefined
  }
  if (!registration || !registration.events || typeof registration.events.emit !== "function") {
    bridge.dispose()
    try {
      await registration?.dispose()
    } catch {}
    return undefined
  }
  return {
    bridge,
    requestWorker: async (input) => {
      const request: WorkerCreateRequest = {
        requestID: `req_${randomUUID()}`,
        goalID: input.goalID ?? "",
        parentSessionID: input.parentSessionID,
        title: input.title,
        ...(input.agent ? { agent: input.agent } : {}),
        ...(input.model ? { model: { id: input.model.modelID, providerID: input.model.providerID } } : {}),
        directory: input.directory,
      }
      return bridge.requestWorker(request, (req) => registration.events.emit("workerCreateRequested", req))
    },
    dispose: async () => {
      // Reject pending first so in-flight createWorker calls fail fast,
      // then release the host registration.
      bridge.dispose()
      try {
        await registration.dispose()
      } catch {}
    },
  }
}
