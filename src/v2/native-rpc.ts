// ─── v2 Native Worker RPC (shared server↔TUI bridge schema) ─────────────────
// Portable RPC definition for native goal-worker creation. The v2 server
// plugin context exposes NO session.fork path (SessionDomain = Pick<SessionApi,
// "create"|"get"|...> — see Probe C in docs/planning/v2-native-probes.md), so
// native children must be forked from a TUI context (ctx.client.session.fork)
// and coordinated through this server↔TUI RPC bridge.
//
// Topology policy (Phase 2/3):
// - unclaimed after CLAIM_TIMEOUT_MS → current root-session fallback.
// - claimed-but-TUI-vanished (CLAIMED_TIMEOUT_MS) → fail startup, never duplicate.
// - explicit TUI failure pre-creation → root fallback safe.
// Every result reports topology used (native-child vs root-fallback).
//
// IMPORTANT: this file is types + schema constants only — no production
// behavior. Probe A wires it to a test method/event first.

export const NATIVE_RPC_ID = "loopd.native" as const

/** How long the server waits for exactly one TUI to claim a request. */
export const CLAIM_TIMEOUT_MS = 3_000

/**
 * How long the server waits for the claiming TUI to complete the fork.
 * Expiry here must FAIL startup (never duplicate, never silently fall back).
 */
export const CLAIMED_TIMEOUT_MS = 15_000

export interface WorkerCreateRequest {
  requestID: string
  goalID: string
  parentSessionID: string
  title: string
  agent?: string
  model?: { id: string; providerID: string }
  permissions?: Array<{ action: string; resource: string; effect: "allow" | "deny" | "ask" }>
  /** Project directory of the requesting server (TUI claims only on match). */
  directory?: string
}

export interface WorkerClaimResult {
  requestID: string
  /** Opaque TUI claimant identity (for exactly-one-winner diagnostics). */
  claimantID: string
}

export interface WorkerCreateResult {
  requestID: string
  /** Native child session ID; caller MUST verify child.parentID === parent. */
  childSessionID: string
  parentSessionID: string
  /** Topology actually used — surfaced in loopd_create_goal + diagnostics. */
  topology: "v2-native-child"
}

export interface WorkerCreateFailure {
  requestID: string
  /** Machine-readable reason: "tui-vanished" | "fork-failed" | "parent-mismatch" | ... */
  reason: string
  detail?: string
  /** True only when the failure happened pre-creation (root fallback safe). */
  preCreation: boolean
}

export type WorkerTopology = "v1-child" | "v2-native-child" | "v2-root-fallback"

// ─── Portable JSON-Schema definitions ────────────────────────────────────────
// Kept as plain JSON Schema (type: "object") so both the server registrar
// (context.rpc.register) and the TUI subscriber (makeRpc) accept them without
// an effect/Schema dependency. Registration sites cast to PortableDefinition.

const requestSchema = {
  type: "object",
  properties: {
    requestID: { type: "string" },
    goalID: { type: "string" },
    parentSessionID: { type: "string" },
    title: { type: "string" },
    agent: { type: "string" },
    model: {
      type: "object",
      properties: {
        id: { type: "string" },
        providerID: { type: "string" },
      },
      required: ["id", "providerID"],
      additionalProperties: false,
    },
    permissions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          action: { type: "string" },
          resource: { type: "string" },
          effect: { type: "string", enum: ["allow", "deny", "ask"] },
        },
        required: ["action", "resource", "effect"],
        additionalProperties: false,
      },
    },
    directory: { type: "string" },
  },
  required: ["requestID", "goalID", "parentSessionID", "title"],
  additionalProperties: false,
} as const

const claimResultSchema = {
  type: "object",
  properties: {
    requestID: { type: "string" },
    claimantID: { type: "string" },
  },
  required: ["requestID", "claimantID"],
  additionalProperties: false,
} as const

const claimAckSchema = {
  type: "object",
  properties: {
    requestID: { type: "string" },
    claimantID: { type: "string" },
    won: { type: "boolean" },
  },
  required: ["requestID", "claimantID", "won"],
  additionalProperties: false,
} as const

const createResultSchema = {
  type: "object",
  properties: {
    requestID: { type: "string" },
    childSessionID: { type: "string" },
    parentSessionID: { type: "string" },
    topology: { type: "string", const: "v2-native-child" },
  },
  required: ["requestID", "childSessionID", "parentSessionID", "topology"],
  additionalProperties: false,
} as const

const failureSchema = {
  type: "object",
  properties: {
    requestID: { type: "string" },
    reason: { type: "string" },
    detail: { type: "string" },
    preCreation: { type: "boolean" },
  },
  required: ["requestID", "reason", "preCreation"],
  additionalProperties: false,
} as const

const emptySchema = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const

/**
 * Portable RPC definition for the native-worker bridge.
 * - event `workerCreateRequested`: server → all attached TUIs (data = WorkerCreateRequest).
 * - method `claimRequest`: TUI → server atomic claim (input = claim, output = ack with `won`).
 * - method `completeWorkerCreate`: TUI → server fork result (input = WorkerCreateResult).
 * - method `failRequest`: TUI → server explicit failure (input = WorkerCreateFailure).
 */
export const nativeRpcDefinition = {
  id: NATIVE_RPC_ID,
  methods: {
    claimRequest: { input: claimResultSchema, output: claimAckSchema, errors: {} },
    completeWorkerCreate: { input: createResultSchema, output: emptySchema, errors: {} },
    failRequest: { input: failureSchema, output: emptySchema, errors: {} },
  },
  events: {
    workerCreateRequested: { schema: requestSchema },
  },
} as const

export type NativeRpcDefinition = typeof nativeRpcDefinition
