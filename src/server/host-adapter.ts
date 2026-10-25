// ─── Server: Host Adapter ────────────────────────────────────────────────────
// Wraps the OpenCode SDK client behind a testable interface.
// Production uses the real client; tests use a fake.

import { randomUUID } from "crypto"
import { describeError, logServerEvent } from "../infrastructure/server-log"
import type { Plugin as V2Plugin } from "@opencode/plugin"
import type { BridgeOutcome } from "../v2/native-bridge"
import type { NativeForkChild, WorkerTopology } from "../v2/native-rpc"
import { resolveNativeParentID } from "../v2/native-rpc"
import { emptyCatalog, normalizeV1Catalog, normalizeV2Catalog, type ModelCatalog } from "./model-catalog"
import { emptyAgentCatalog, normalizeAgentCatalog, type AgentCatalog } from "./agent-catalog"
import { terminalToolExecution, type TerminalToolExecution } from "../domain/tool-execution"

export interface ModelRef {
  providerID: string
  modelID: string
}

export interface SessionMessage {
  role: "user" | "assistant"
  content: string
  timestamp?: string
  messageID?: string
  parentMessageID?: string
  completedAt?: string
  /** A completed tool-call message is a step boundary, not a finished turn. */
  finish?: string
  createdAt?: string
  /** Token usage for completed assistant messages (absent for user messages). */
  tokens?: {
    input: number
    output: number
    reasoning: number
    cacheRead: number
    cacheWrite: number
  }
  /** Provider cost for a completed assistant message, when reported. */
  cost?: number
  /** Active model time in ms (completed - created), when both are reported. */
  durationMs?: number
}

export interface SessionUsage {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
}

export type SessionStatusType = "idle" | "busy" | "retry" | "unknown"

/**
 * Parse a user-facing "providerID/modelID" model string into the SDK shape.
 * Returns undefined for missing/blank input; throws for malformed input.
 */
export function parseModelRef(value?: string): ModelRef | undefined {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  if (!trimmed) return undefined
  const slash = trimmed.indexOf("/")
  if (slash <= 0 || slash >= trimmed.length - 1) {
    throw new Error(`Invalid model "${value}". Use "providerID/modelID" (e.g. "openai/gpt-5.6-sol").`)
  }
  const providerID = trimmed.slice(0, slash).trim()
  const modelID = trimmed.slice(slash + 1).trim()
  if (!providerID || !modelID || /\s/.test(providerID) || /\s/.test(modelID)) {
    throw new Error(`Invalid model "${value}". Use "providerID/modelID" (e.g. "openai/gpt-5.6-sol").`)
  }
  return { providerID, modelID }
}

/**
 * Generate a worker-prompt message ID valid on BOTH hosts.
 * v2 schema-validates `SessionMessage.ID` as a string starting with "msg_";
 * v1 accepts any "msg" prefix and generates "msg_" itself. The underscore
 * form is therefore the only spelling both hosts accept, and the engine
 * persists exactly this value for prompt/assistant event correlation — the
 * adapters must send it through unchanged (never rewrite the separator).
 */
export function newPromptMessageID(): string {
  return `msg_${randomUUID()}`
}

/** True when a prompt ID is deliverable on the v2 host. */
export function isV2PromptMessageID(messageID: string): boolean {
  return messageID.startsWith("msg_")
}

export interface LoopHost {
  /** v2 durable session projection; absent on legacy transports. */
  readExecution?(sessionID: string): Promise<NativeExecutionSnapshot | undefined>
  enqueueWorkerMessage?(sessionID: string, messageID: string, text: string): Promise<void>
  /** Optional public transcript capability; terminal call+session+end evidence only. */
  readToolExecutions?(sessionID: string): Promise<TerminalToolExecution[]>
  /**
   * Definitive existence probe for an execution owner. `true` resolved,
   * `false` positively absent, `undefined` unproven (capability missing,
   * timeout, or an error that does not prove absence). Only `false` may
   * release a stale reservation: a timeout or a missing capability must
   * never be mistaken for a dead session.
   */
  sessionKnown?(sessionID: string): Promise<boolean | undefined>
  /**
   * Authoritative main/root-session proof: true only when the host resolved the
   * session and it has no parent (fork) session. undefined is unproven — a
   * missing capability, timeout or error must never be read as "main".
   */
  isMainSession?(sessionID: string): Promise<boolean | undefined>
  /** True only when an audited execution guard surface is installed. */
  scopedExecution?: boolean
  listAgents?(): Promise<AgentCatalog>
  switchSessionAgent?(sessionID: string, agent: string): Promise<"applied" | "next-prompt" | "unsupported">
  /** Public catalog only; credentials and quota guesses must never escape. */
  listModels?(): Promise<ModelCatalog>
  /** v1 uses explicit next-prompt identity; v2 can update the idle session. */
  switchSessionModel?(sessionID: string, model: ModelRef): Promise<"applied" | "next-prompt" | "unsupported">
  /**
   * Create a worker session. Returns the session ID (v1 + legacy callers) or
   * a WorkerCreation carrying the ID plus v2 topology metadata. v1 and fake
   * hosts return the bare string; only the v2 host returns the object form.
   */
  createWorker(input: { parentID: string; title: string; agent?: string; model?: ModelRef; goalID?: string }): Promise<string | WorkerCreation>
  promptWorker(input: {
    sessionID: string
    prompt: string
    messageID?: string
    model?: ModelRef
    agent?: string
  }): Promise<{ messageID?: string }>
  /**
   * Read a session's current identity (agent + model). Returns undefined when
   * the session cannot be read or reports no identity. Best-effort: callers
   * treat undefined as "fall back to existing defaults".
   */
  readSession(sessionID: string): Promise<{ agent?: string; model?: ModelRef } | undefined>
  sessionStatus(sessionID: string): Promise<SessionStatusType>
  abortSession(sessionID: string): Promise<void>
  readMessages(sessionID: string, limit?: number): Promise<SessionMessage[]>
  compactSession(sessionID: string, model?: ModelRef): Promise<void>
  /** True when the host accepted the prompt; false on a delivery error. */
  notifyOwner(ownerSessionID: string, message: string, agent?: string): Promise<boolean | void>
}

export interface NativeExecutionSnapshot {
  status: SessionStatusType
  outcome?: "succeeded" | "failed" | "interrupted"
  idleAt?: string
  latestUserMessageID?: string
  deliveredMessageIDs?: string[]
}

const recentParentNotifies = new Map<string, number>()
function shouldDedupParentNotify(ownerSessionID: string, message: string): boolean {
  const key = `${ownerSessionID}:${message.slice(0, 200)}`
  const now = Date.now()
  const last = recentParentNotifies.get(key)
  if (last !== undefined && now - last < 60_000) return true
  // prune old entries occasionally
  if (recentParentNotifies.size > 200) {
    for (const [k, t] of recentParentNotifies.entries()) if (now - t > 60_000) recentParentNotifies.delete(k)
  }
  return false
}

function markParentNotified(ownerSessionID: string, message: string): void {
  recentParentNotifies.set(`${ownerSessionID}:${message.slice(0, 200)}`, Date.now())
}

// ─── Real Host (SDK-backed) ─────────────────────────────────────────────────

export function createRealHost(client: any, directory: string): LoopHost {
  // Parentage is immutable for a session's lifetime; cache only proven roots so
  // repeated shell/command hooks do not re-probe the host, while an unproven
  // probe stays uncached and fail-closed.
  const provenRoots = new Set<string>()
  return {
    async listAgents() {
      const switching = typeof client.session?.switchAgent === "function" ? "session" : "next-prompt"
      if (typeof client.agent?.list !== "function") return emptyAgentCatalog("v1 agent.list", switching)
      try {
        const result = await withTimeout<any>(client.agent.list({ query: { directory } }), 10_000, "OpenCode agent.list")
        if (result?.error) return emptyAgentCatalog("v1 agent.list", switching, "unavailable")
        return normalizeAgentCatalog(result?.data, "v1 agent.list", switching)
      } catch {
        return emptyAgentCatalog("v1 agent.list", switching, "unavailable")
      }
    },
    async switchSessionAgent(sessionID, agent) {
      if (typeof client.session?.switchAgent !== "function") return "next-prompt"
      const result = await withTimeout<any>(client.session.switchAgent({ path: { id: sessionID }, body: { agent } }), 10_000, "OpenCode session.switchAgent")
      if (result?.error) throw new Error("OpenCode session.switchAgent rejected the agent.")
      return "applied"
    },
    async listModels() {
      if (typeof client.provider?.list !== "function") return emptyCatalog("v1 provider.list", "next-prompt")
      try {
        const result = await withTimeout<any>(client.provider.list({ query: { directory } }), 10_000, "OpenCode provider.list")
        if (result?.error) return emptyCatalog("v1 provider.list", "next-prompt", "unavailable")
        return normalizeV1Catalog(result?.data)
      } catch {
        return emptyCatalog("v1 provider.list", "next-prompt", "unavailable")
      }
    },
    async switchSessionModel() {
      // Installed v1 SDK has no session.switchModel. A validated assignment
      // takes effect via promptAsync's supported explicit model argument.
      return "next-prompt"
    },
    async createWorker({ parentID, title, agent, model }) {
      try {
        const body: any = { parentID, title }
        if (agent) body.agent = agent
        // session.create accepts agent and a v2-style model ref {id, providerID}.
        // The prompt shape {providerID, modelID} is rejected here with 400
        // (probed live on 1.18.29), so map it. Per-prompt model below stays
        // in prompt_async shape.
        if (model) body.model = { id: model.modelID, providerID: model.providerID }
        const result = await withTimeout<any>(
          client.session.create({ body }),
          10_000,
          "OpenCode session.create",
        )
        const data = result?.data
        if (result?.error || !data?.id) {
          const detail = describeError(result?.error || "response contained no session ID")
          await logServerEvent(directory, "worker.create.failed", { parentID, title, detail })
          throw new Error(`OpenCode session.create failed for parent "${parentID}": ${detail}`)
        }
        await logServerEvent(directory, "worker.created", { parentID, workerSessionID: data.id, title })
        return data.id
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("OpenCode session.create failed")) throw error
        const detail = describeError(error)
        await logServerEvent(directory, "worker.create.failed", { parentID, title, detail })
        throw new Error(`OpenCode session.create failed for parent "${parentID}": ${detail}`)
      }
    },

    async promptWorker({ sessionID, prompt, messageID, model, agent }) {
      const body: any = {
        parts: [{ type: "text", text: prompt }],
      }
      if (messageID) {
        // Preserve the persisted ID verbatim when it already carries a host
        // prefix ("msg-" legacy or "msg_" current): the engine correlates
        // worker events by exact equality with activePromptMessageID, so any
        // rewrite here would deliver successfully yet break tracking. Only
        // bare IDs (never persisted) get the dual-host "msg_" spelling.
        body.messageID = /^msg[-_]/.test(messageID) ? messageID : `msg_${messageID}`
      }
      if (model) body.model = model
      if (agent) body.agent = agent
      const result = await withTimeout<any>(
        client.session.promptAsync({
          path: { id: sessionID },
          body,
        }),
        10_000,
        "OpenCode session.promptAsync",
      )
      if (result?.error) {
        const detail = describeError(result.error)
        await logServerEvent(directory, "worker.prompt.failed", { sessionID, detail })
        throw new Error(`OpenCode session.promptAsync failed for worker "${sessionID}": ${detail}`, { cause: result.error })
      }
      await logServerEvent(directory, "worker.prompted", { sessionID })
      // SDK may return the created message ID in response headers or body
      return { messageID: result?.data?.messageID }
    },

    async readSession(sessionID) {
      try {
        // Bounded: an unreachable host must resolve unknown (via the catch
        // below), never hang resume/nudge probes or turn pre-checks.
        const result = await withTimeout<any>(client.session.get({ path: { id: sessionID } }), 10_000, "OpenCode session.get")
        if (result?.error) return undefined
        const data = result?.data
        if (!data || typeof data !== "object") return undefined
        const agent = typeof (data as any).agent === "string" ? (data as any).agent : undefined
        const rawModel = (data as any).model
        let model: ModelRef | undefined
        if (rawModel && typeof rawModel === "object") {
          // v1 get returns {id, providerID, variant}; accept modelID spelling too.
          const modelID = typeof rawModel.modelID === "string" ? rawModel.modelID
            : typeof rawModel.id === "string" ? rawModel.id : undefined
          const providerID = typeof rawModel.providerID === "string" ? rawModel.providerID : undefined
          if (modelID && providerID) model = { providerID, modelID }
        }
        if (!agent && !model) return undefined
        return { agent, model }
      } catch {
        return undefined
      }
    },

    async isMainSession(sessionID) {
      if (provenRoots.has(sessionID)) return true
      try {
        // Bounded: this sits on the tool hook path; an unproven probe resolves
        // undefined (fail-closed) rather than hanging the caller.
        const result = await withTimeout<any>(client.session.get({ path: { id: sessionID } }), 10_000, "OpenCode session.get (parent identity)")
        if (result?.error) return undefined
        const data = result?.data
        if (!data || typeof data !== "object") return undefined
        const parent = (data as any).fork?.sessionID ?? (data as any).parentID
        if (parent) return false
        provenRoots.add(sessionID)
        return true
      } catch {
        return undefined
      }
    },

    async sessionStatus(sessionID) {
      try {
        // Bounded: liveness probes sit on the resume/nudge control path. A
        // timeout resolves "unknown" (fail-closed upstream), never a hang.
        // NOTE: a missing map entry means idle (OpenCode omits idle sessions);
        // only request failures / malformed payloads are "unknown".
        const result = await withTimeout<any>(client.session.status({}), 10_000, "OpenCode session.status")
        if (result?.error) return "unknown"
        const data = result?.data
        if (!data || typeof data !== "object" || Array.isArray(data)) return "unknown"
        const status = (data as Record<string, unknown>)[sessionID]
        // Sparse map: OpenCode omits idle sessions, so a missing entry means
        // the worker is not active (idle), not unreachable. Reserve "unknown"
        // for request failures or malformed payloads.
        if (status === undefined || status === null) return "idle"
        if (typeof status !== "object" || Array.isArray(status)) return "unknown"
        const type = (status as { type?: unknown }).type
        if (type === "busy" || type === "retry") return type
        if (type === "idle") return "idle"
        return "unknown"
      } catch {
        return "unknown"
      }
    },

    async sessionKnown(sessionID) {
      try {
        const result = await withTimeout<any>(client.session.get({ path: { id: sessionID } }), 10_000, "OpenCode session.get (existence)")
        if (result?.error) {
          const status = result.error?.statusCode ?? result.error?.status ?? result.error?.data?.statusCode
          if (status === 404) return false
          // A message that says "not found" is absence; anything else (auth,
          // network, 5xx) stays unproven so nothing is released on a blip.
          return /not.?found|does not exist|unknown session/i.test(describeError(result.error)) ? false : undefined
        }
        return result?.data ? true : undefined
      } catch {
        return undefined
      }
    },

    async abortSession(sessionID) {
      try {
        // Bounded but still best-effort: abort never gates state transitions.
        await withTimeout<any>(client.session.abort({ path: { id: sessionID } }), 10_000, "OpenCode session.abort")
      } catch {
        // Best-effort abort
      }
    },

    async readMessages(sessionID, limit = 10) {
      try {
        // Bounded: transcript tails are gathered on every turn; an unreachable
        // host must yield [] (via the catch below), never stall the turn.
        const result = await withTimeout<any>(client.session.messages({
          path: { id: sessionID },
          query: { limit },
        }), 10_000, "OpenCode session.messages")
        const data = result?.data
        if (!Array.isArray(data)) return []
        return data.map((m: any) => {
          const createdMs = m.info?.time?.created
          const completedMs = m.info?.time?.completed
          const tokens = m.info?.tokens
          return {
            role: m.info?.role || "assistant",
            content: m.parts
              ?.filter((p: any) => p.type === "text")
              .map((p: any) => p.text)
              .join("\n") || "",
            timestamp: completedMs || createdMs
              ? new Date(completedMs || createdMs).toISOString()
              : undefined,
            messageID: m.info?.id || m.id,
            parentMessageID: m.info?.parentID,
            completedAt: completedMs
              ? new Date(completedMs).toISOString()
              : undefined,
            finish: typeof m.info?.finish === "string" ? m.info.finish : undefined,
            createdAt: typeof createdMs === "number" ? new Date(createdMs).toISOString() : undefined,
            tokens: tokens && typeof tokens.input === "number"
              ? {
                input: tokens.input || 0,
                output: tokens.output || 0,
                reasoning: tokens.reasoning || 0,
                cacheRead: tokens.cache?.read || 0,
                cacheWrite: tokens.cache?.write || 0,
              }
              : undefined,
            cost: typeof m.info?.cost === "number" ? m.info.cost : undefined,
            durationMs: typeof createdMs === "number" && typeof completedMs === "number" && completedMs >= createdMs
              ? completedMs - createdMs
              : undefined,
          }
        })
      } catch {
        return []
      }
    },

    async readToolExecutions(sessionID) {
      try {
        // Public v1 messages API, with no tail limit: an old missed after-hook
        // must not be inferred from age or silently fall outside a recent tail.
        const result = await withTimeout<any>(client.session.messages({ path: { id: sessionID } }), 10_000, "OpenCode session.messages (tool terminal evidence)")
        if (!Array.isArray(result?.data)) return []
        return result.data.flatMap((message: any) => {
          // Public transcript parts may omit their enclosing session identity.
          // Only inherit an exact matching message identity, never a foreign
          // message or an explicitly conflicting part identity.
          if (message.info?.sessionID !== undefined && message.info.sessionID !== sessionID) return []
          return (message.parts ?? []).flatMap((part: any) => {
            const evidence = terminalToolExecution(part?.sessionID === undefined && message.info?.sessionID === sessionID
              ? { ...part, sessionID }
              : part)
            return evidence?.sessionID === sessionID ? [evidence] : []
          })
        })
      } catch { return [] }
    },

    async compactSession(sessionID, model) {
      try {
        // Installed SDK exposes summarize with an explicit provider/model,
        // not session.compact. Never reuse the old session identity after switch.
        const identity = model ?? (await this.readSession(sessionID))?.model
        if (!identity || typeof client.session.summarize !== "function") return
        await withTimeout<any>(client.session.summarize({ path: { id: sessionID }, body: identity }), 10_000, "OpenCode session.summarize")
      } catch {
        // Best-effort compaction
      }
    },

    async notifyOwner(ownerSessionID, message, agent) {
      if (shouldDedupParentNotify(ownerSessionID, message)) {
        await logServerEvent(directory, "parent.notify.deduped", { ownerSessionID, preview: message.slice(0, 160) })
        return true
      }
      // Preserve the parent's identity: without an explicit agent the session
      // falls back to the global default (often Build), not the parent that
      // spawned the subagent. Callers pass the snapshot `parentAgent` when
      // available; otherwise we best-effort read the live session.
      let resolvedAgent = agent?.trim() || undefined
      if (!resolvedAgent) {
        try {
          const sess = await withTimeout<any>(client.session.get({ path: { id: ownerSessionID } }), 10_000, "OpenCode session.get (parent identity)")
          const liveAgent = (sess as any)?.data?.agent
          if (typeof liveAgent === "string" && liveAgent.trim()) resolvedAgent = liveAgent.trim()
        } catch {
          // ignore — will fall through to no agent
        }
      }
      try {
        const body: any = { parts: [{ type: "text", text: message }] }
        if (resolvedAgent) body.agent = resolvedAgent
        const result = await withTimeout<any>(
          client.session.promptAsync({
            path: { id: ownerSessionID },
            body,
          }),
          10_000,
          "OpenCode parent notify",
        )
        if (result?.error) {
          await logServerEvent(directory, "parent.notify.failed", { ownerSessionID, detail: describeError(result.error) })
          return false
        } else {
          markParentNotified(ownerSessionID, message)
          await logServerEvent(directory, "parent.notified", { ownerSessionID, preview: message.slice(0, 160) })
          return true
        }
      } catch (error) {
        await logServerEvent(directory, "parent.notify.failed", { ownerSessionID, detail: describeError(error) })
        return false
      }
    },
  }
}

// ─── V2 Host ────────────────────────────────────────────────────────────────

/**
 * Rich worker-creation result. Only the v2 host produces the object form;
 * v1 and fake hosts keep returning the bare session-ID string.
 */
export interface WorkerCreation {
  sessionID: string
  topology?: WorkerTopology
  nativeParentID?: string
}

/** Normalize any host's createWorker result to the rich form. */
export function toWorkerCreation(result: string | WorkerCreation): WorkerCreation {
  return typeof result === "string" ? { sessionID: result } : result
}

export interface NativeWorkerDependency {
  requestWorker: (input: {
    goalID?: string
    parentSessionID: string
    title: string
    agent?: string
    model?: ModelRef
    directory: string
  }) => Promise<BridgeOutcome>
}

export interface CreateV2HostOptions {
  /**
   * Native-child bridge (Phase 2 wiring). Absent = bridge unsupported:
   * createWorker takes the flagged root fallback directly.
   */
  native?: NativeWorkerDependency
}

export function createV2Host(
  context: V2Plugin.Context,
  statuses: Map<string, SessionStatusType>,
  options: CreateV2HostOptions = {},
): LoopHost {
  const directory = context.location.directory
  // Proven roots only: an unproven probe must be retried, never cached as false.
  const provenRoots = new Set<string>()

  async function readExecution(sessionID: string): Promise<NativeExecutionSnapshot | undefined> {
    try {
      // wait observes the native coordinator, including queued inputs. A
      // bounded, cancelled observation is not an interrupt of the session.
      await withTimeout(context.session.wait({ sessionID }, { signal: AbortSignal.timeout(500) }), 750, "OpenCode v2 idle observation")
      const messages = await withTimeout(context.session.context({ sessionID }), 10_000, "OpenCode v2 delivered inbox projection")
      // A queue may arrive while context is read. Observe idle again before
      // reading its terminal outcome; never use the previous outcome while
      // native queued work is executing.
      await withTimeout(context.session.wait({ sessionID }, { signal: AbortSignal.timeout(500) }), 750, "OpenCode v2 idle recheck")
      const session = await withTimeout(context.session.get({ sessionID }), 10_000, "OpenCode v2 execution projection")
      const idle = session.time?.idle
      return {
        status: "idle",
        outcome: session.outcome,
        idleAt: idle ? new Date(idle).toISOString() : undefined,
        latestUserMessageID: messages.filter((message) => message.type === "user").at(-1)?.id,
        deliveredMessageIDs: messages.filter((message) => message.type === "user").map((message) => message.id),
      }
    } catch {
      return { status: "unknown" }
    }
  }

  return {
    scopedExecution: true,
    readExecution: typeof context.session.wait === "function" ? readExecution : undefined,
    enqueueWorkerMessage: typeof context.session.wait === "function" ? async (sessionID, messageID, text) => {
      await withTimeout(context.session.prompt({ sessionID, id: messageID, text, delivery: "queue" }), 30_000, "OpenCode v2 queue notification")
    } : undefined,
    async listAgents() {
      const switching = typeof context.session.switchAgent === "function" ? "session" : "unsupported"
      if (typeof context.agent?.list !== "function") return emptyAgentCatalog("v2 agent.list", switching)
      try {
        const result = await context.agent.list({ location: { directory } })
        return normalizeAgentCatalog(result.data, "v2 agent.list", switching)
      } catch {
        return emptyAgentCatalog("v2 agent.list", switching, "unavailable")
      }
    },
    async switchSessionAgent(sessionID, agent) {
      if (typeof context.session.switchAgent !== "function") return "unsupported"
      await withTimeout(context.session.switchAgent({ sessionID, agent }), 10_000, "OpenCode v2 session.switchAgent")
      return "applied"
    },
    async listModels() {
      if (typeof context.provider?.list !== "function" || typeof context.model?.list !== "function") {
        return emptyCatalog("v2 provider.list + model.list", typeof context.session.switchModel === "function" ? "session" : "unsupported")
      }
      try {
        const [providers, models] = await Promise.all([
          context.provider.list({ location: { directory } }),
          context.model.list({ location: { directory } }),
        ])
        const catalog = normalizeV2Catalog(providers, models)
        if (typeof context.session.switchModel !== "function") catalog.switching = "unsupported"
        return catalog
      } catch {
        return emptyCatalog("v2 provider.list + model.list", typeof context.session.switchModel === "function" ? "session" : "unsupported", "unavailable")
      }
    },
    async switchSessionModel(sessionID, model) {
      if (typeof context.session.switchModel !== "function") return "unsupported"
      await withTimeout(context.session.switchModel({ sessionID, model: { id: model.modelID, providerID: model.providerID } }), 10_000, "OpenCode v2 session.switchModel")
      return "applied"
    },
    async createWorker({ parentID, title, agent, model, goalID }) {
      // Native path: ask exactly one attached TUI to fork a real child of
      // the parent session. Unclaimed / pre-creation-failed requests fall
      // through to the flagged root fallback below. Claimed-timeout and
      // post-creation failures propagate (fail startup, never duplicate).
      if (options.native) {
        let outcome: BridgeOutcome
        try {
          outcome = await options.native.requestWorker({
            goalID,
            parentSessionID: parentID,
            title,
            agent,
            model,
            directory,
          })
        } catch (error) {
          await logServerEvent(directory, "worker.create.native-failed", {
            parentID,
            title,
            detail: describeError(error),
          })
          throw error
        }
        if (outcome.kind === "native-child") {
          const childID = outcome.childSessionID
          // Verify native parentage through the supported SessionDomain
          // before trusting the child: a mismatch means the TUI forked the
          // wrong session, and using it would corrupt goal linkage.
          // Bounded: verification must not hang startup on a wedged host.
          const child = await withTimeout(context.session.get({ sessionID: childID }), 10_000, "OpenCode v2 session.get (native parent verify)")
          // Live hosts carry parentage as fork.sessionID (parentID often
          // null) — resolve either shape before trusting the child.
          const actualParent = resolveNativeParentID(child as NativeForkChild)
          if (actualParent !== parentID) {
            const detail = `resolved-parent=${JSON.stringify(actualParent)} expected=${JSON.stringify(parentID)}`
            await logServerEvent(directory, "worker.create.parent-mismatch", { parentID, workerSessionID: childID, detail })
            throw new Error(`loopd native worker creation failed for parent "${parentID}" (parent-mismatch): ${detail}`)
          }
          // Configure through the supported SessionDomain (the TUI already
          // applied these at fork time; re-applying is idempotent).
          // LIVE PROBE 2026-09-25 (host 0.0.0-beta-19271): the server
          // SessionDomain has NO update method (title rename exists only on
          // the full TUI client) — the TUI-side title already covers it, so
          // re-applying is best-effort and must never fail creation.
          // Bounded like the LoopHost switch methods above: post-fork config
          // must not hang startup on a wedged host.
          if (agent) await withTimeout(context.session.switchAgent({ sessionID: childID, agent }), 10_000, "OpenCode v2 session.switchAgent (native re-apply)")
          if (model) {
            await withTimeout(context.session.switchModel({
              sessionID: childID,
              model: { id: model.modelID, providerID: model.providerID },
            }), 10_000, "OpenCode v2 session.switchModel (native re-apply)")
          }
          const rename = (context.session as {
            update?: (input: { sessionID: string; title: string }) => Promise<unknown>
          }).update
          if (rename) await withTimeout(rename({ sessionID: childID, title }), 10_000, "OpenCode v2 session.update (native title)")
          statuses.set(childID, "idle")
          await logServerEvent(directory, "worker.created", {
            parentID,
            workerSessionID: childID,
            title,
            topology: "v2-native-child",
            nativeParentID: parentID,
          })
          return { sessionID: childID, topology: "v2-native-child", nativeParentID: parentID } satisfies WorkerCreation
        }
        await logServerEvent(directory, "worker.create.native-fallback", {
          parentID,
          title,
          reason: outcome.kind === "fallback-safe" ? outcome.reason : "unclaimed",
        })
      }
      // LIVE PROBE 2026-09-25 (host 0.0.0-beta-19271): session.create
      // rejects explicit undefined for agent ("Expected string | null").
      // Omit unset optionals instead of passing them through.
      // Bounded like v1 session.create: startup must fail fast, never hang.
      const session = await withTimeout(context.session.create({
        title,
        ...(agent !== undefined ? { agent } : {}),
        ...(model !== undefined ? { model: { id: model.modelID, providerID: model.providerID } } : {}),
        location: { directory },
        metadata: { "loopd.parentID": parentID },
      }), 10_000, "OpenCode v2 session.create")
      statuses.set(session.id, "idle")
      await logServerEvent(directory, "worker.created", {
        parentID,
        workerSessionID: session.id,
        title,
        topology: "v2-root-fallback",
      })
      return { sessionID: session.id, topology: "v2-root-fallback" } satisfies WorkerCreation
    },

    async promptWorker({ sessionID, prompt, messageID, model, agent }) {
      if (agent) await withTimeout(context.session.switchAgent({ sessionID, agent }), 10_000, "OpenCode v2 session.switchAgent (prompt)")
      if (model) {
        await withTimeout(context.session.switchModel({
          sessionID,
          model: { id: model.modelID, providerID: model.providerID },
        }), 10_000, "OpenCode v2 session.switchModel (prompt)")
      }
      // v2 schema-validates the prompt id as SessionMessage.ID ("msg_"
      // prefix). Fail fast with a loopd-scoped message instead of leaking the
      // raw schema error, and never rewrite: the engine persists this exact
      // value as activePromptMessageID for event correlation.
      if (messageID !== undefined && !isV2PromptMessageID(messageID)) {
        throw new Error(
          `loopd prompt ID "${messageID}" is invalid for OpenCode v2: must start with "msg_". ` +
          `Generate IDs with newPromptMessageID() so persisted, delivered, and correlated IDs agree.`,
        )
      }
      // v2 session.prompt returns the enqueued inbox user message
      // (SessionInbox.User), NOT the assistant reply: this is prompt
      // ACCEPTANCE, never LLM completion. A generous bound keeps a wedged
      // host from stalling resume/nudge forever; a lost race never cancels
      // the enqueue (late acceptance is verified before any retry re-prompts).
      const result = await withTimeout(context.session.prompt({
        sessionID,
        id: messageID,
        text: prompt,
      }), 30_000, "OpenCode v2 session.prompt (acceptance)")
      await logServerEvent(directory, "worker.prompted", { sessionID })
      return { messageID: (result as any)?.id }
    },

    async readSession(sessionID) {
      try {
        // Bounded: identity reads sit on turn pre-checks; resolve undefined
        // (via the catch below), never hang the turn.
        const session = await withTimeout(context.session.get({ sessionID }), 10_000, "OpenCode v2 session.get")
        const model = session.model
          ? { providerID: session.model.providerID, modelID: session.model.id }
          : undefined
        if (!session.agent && !model) return undefined
        return { agent: session.agent, model }
      } catch {
        return undefined
      }
    },

    async sessionStatus(sessionID) {
      return typeof context.session.wait === "function" ? (await readExecution(sessionID))?.status ?? "unknown" : statuses.get(sessionID) ?? "unknown"
    },

    async isMainSession(sessionID) {
      if (provenRoots.has(sessionID)) return true
      try {
        const session = await withTimeout(context.session.get({ sessionID }), 10_000, "OpenCode v2 session.get (parent identity)")
        if (!session) return undefined
        // Live hosts carry parentage as fork.sessionID; older ones as parentID.
        const parent = (session as any).fork?.sessionID ?? (session as any).parentID
        if (parent) return false
        provenRoots.add(sessionID)
        return true
      } catch {
        return undefined
      }
    },

    async sessionKnown(sessionID) {
      // v2's session projection throws for both "absent" and "unreachable", so
      // a throw stays unproven rather than being read as a dead session.
      try {
        const session = await withTimeout(context.session.get({ sessionID }), 10_000, "OpenCode v2 session.get (existence)")
        return session ? true : undefined
      } catch (error: any) {
        return /not.?found|does not exist|unknown session/i.test(String(error?.message ?? error)) ? false : undefined
      }
    },

    async abortSession(sessionID) {
      try {
        await context.session.interrupt({ sessionID })
        statuses.set(sessionID, "idle")
      } catch {
        // Best-effort abort
      }
    },

    async readMessages(sessionID, limit = 10) {
      try {
        // Bounded: transcript tails are gathered on every turn; resolve []
        // (via the catch below), never stall the turn.
        const messages = await withTimeout(context.session.context({ sessionID }), 10_000, "OpenCode v2 session.context")
        let parentMessageID: string | undefined
        return messages.flatMap((message): SessionMessage[] => {
          if (message.type === "user") {
            parentMessageID = message.id
            return [{
              role: "user",
              content: message.text,
              timestamp: new Date(message.time.created).toISOString(),
              messageID: message.id,
            }]
          }
          if (message.type !== "assistant") return []
          const created = message.time.created
          const completed = message.time.completed
          return [{
            role: "assistant",
            content: message.content
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("\n"),
            timestamp: new Date(completed ?? created).toISOString(),
            messageID: message.id,
            parentMessageID,
            completedAt: completed ? new Date(completed).toISOString() : undefined,
            createdAt: new Date(created).toISOString(),
            tokens: message.tokens ? {
              input: message.tokens.input,
              output: message.tokens.output,
              reasoning: message.tokens.reasoning,
              cacheRead: message.tokens.cache.read,
              cacheWrite: message.tokens.cache.write,
            } : undefined,
            cost: message.cost,
            durationMs: completed && completed >= created ? completed - created : undefined,
          }]
        }).slice(-limit)
      } catch {
        return []
      }
    },

    async compactSession(sessionID, model) {
      try {
        if (model) {
          if (typeof context.session.switchModel !== "function") return
          await withTimeout(context.session.switchModel({ sessionID, model: { id: model.modelID, providerID: model.providerID } }), 10_000, "OpenCode v2 session.switchModel (compact)")
        }
        await withTimeout(context.session.command({ sessionID, name: "compact", text: "" }), 10_000, "OpenCode v2 session.command (compact)")
      } catch {
        // Best-effort compaction
      }
    },

    async notifyOwner(ownerSessionID, message) {
      try {
        // Background reports are synthetic input, not user-composed prompts.
        // Steering reaches a busy parent's next model step; resume also wakes
        // an idle parent without waiting for the user to submit anything.
        await withTimeout(context.session.synthetic({ sessionID: ownerSessionID, text: message, delivery: "steer", resume: true }), 10_000, "OpenCode v2 parent notify (acceptance)")
        await logServerEvent(directory, "parent.notified", { ownerSessionID, preview: message.slice(0, 160) })
        return true
      } catch (error) {
        const detail = describeError(error) || (error as any)?.name || "(no detail)"
        await logServerEvent(directory, "parent.notify.failed", { ownerSessionID, detail })
        return false
      }
    },
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, operation: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${operation} timed out after ${timeoutMs}ms`)), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

// ─── Fake Host (testing) ────────────────────────────────────────────────────

export interface FakeHostOptions {
  workerDelay?: number
  sessionStatus?: SessionStatusType | ((sessionID: string) => SessionStatusType | Promise<SessionStatusType>)
  autoCompletePrompts?: boolean
  /** Override the existence probe; return undefined to model an unprovable probe. */
  sessionKnown?: (sessionID: string) => boolean | undefined | Promise<boolean | undefined>
  /** Override main-session proof; omitted means the fake host cannot prove one. */
  isMainSession?: (sessionID: string) => boolean | undefined | Promise<boolean | undefined>
}

export function createFakeHost(options: FakeHostOptions = {}): LoopHost & {
  sessions: Map<string, string[]>
  messages: Map<string, SessionMessage[]>
  prompts: string[]
  promptCalls: Array<{ sessionID: string; agent?: string; model?: ModelRef }>
} {
  const sessions = new Map<string, string[]>()
  const messages = new Map<string, SessionMessage[]>()
  // Existence is deliberately separate from `sessions`: real hosts interrupt
  // rather than delete, so an aborted session is still resolvable while it is
  // no longer a live worker. Only IDs this host instance never created are
  // absent, which models a restart against a wiped store.
  const everCreated = new Set<string>()
  const prompts: string[] = []
  const promptCalls: Array<{ sessionID: string; agent?: string; model?: ModelRef }> = []
  const recentNotifies = new Map<string, number>()

  return {
    scopedExecution: true,
    sessions,
    messages,
    prompts,
    promptCalls,
    async createWorker({ parentID, title, agent }) {
      const id = `worker-${crypto.randomUUID().slice(0, 8)}`
      sessions.set(id, [])
      messages.set(id, [])
      everCreated.add(id)
      if (agent) (sessions as any).agents = { ...((sessions as any).agents || {}), [id]: agent }
      return id
    },
    async readSession(_sessionID) {
      // Fake host carries no session identity registry; production reads it
      // via session.get. Tests set identity explicitly where needed.
      return undefined
    },
    async notifyOwner(ownerSessionID, message, agent) {
      const key = `${ownerSessionID}:${message.slice(0, 200)}`
      const now = Date.now()
      const last = recentNotifies.get(key)
      if (last !== undefined && now - last < 60_000) return
      recentNotifies.set(key, now)
      // Fake host records for tests
      ;(sessions as any).notifications = (sessions as any).notifications || []
      ;(sessions as any).notifications.push({ ownerSessionID, message, agent })
    },
    async promptWorker({ sessionID, prompt, messageID, model, agent }) {
      const rawID = messageID || newPromptMessageID()
      const resolvedMessageID = /^msg[-_]/.test(rawID) ? rawID : `msg_${rawID}`
      const msgs = sessions.get(sessionID) || []
      msgs.push(prompt)
      sessions.set(sessionID, msgs)
      const transcript = messages.get(sessionID) || []
      transcript.push({
        role: "user",
        content: prompt,
        timestamp: new Date().toISOString(),
        messageID: resolvedMessageID,
      })
      if (options.autoCompletePrompts !== false) {
        const completedAt = new Date().toISOString()
        transcript.push({
          role: "assistant",
          content: "completed",
          timestamp: completedAt,
          completedAt,
          messageID: `assistant-${crypto.randomUUID().slice(0, 8)}`,
          parentMessageID: resolvedMessageID,
        })
      }
      messages.set(sessionID, transcript)
      prompts.push(prompt)
      promptCalls.push({ sessionID, agent, model })
      if (options.workerDelay) {
        await new Promise((r) => setTimeout(r, options.workerDelay))
      }
      // Return the provided messageID or generate one for tests
      return { messageID: resolvedMessageID }
    },
    async sessionStatus(sessionID) {
      if (typeof options.sessionStatus === "function") return options.sessionStatus(sessionID)
      if (options.sessionStatus) return options.sessionStatus
      if (sessions.has(sessionID)) return "idle"
      return "idle"
    },
    async sessionKnown(sessionID) {
      // Fake host: IDs this instance never created are provably absent, which
      // models a restart against a wiped store. Tests that need "unproven" set
      // FakeHostOptions.sessionKnown explicitly.
      if (options.sessionKnown) return options.sessionKnown(sessionID)
      return everCreated.has(sessionID)
    },
    async isMainSession(sessionID) {
      // Fail closed by default: the fake host has no parentage registry, so it
      // cannot prove a root session. Tests opt in explicitly.
      if (!options.isMainSession) return undefined
      return options.isMainSession(sessionID)
    },
    async abortSession(sessionID) {
      sessions.delete(sessionID)
      messages.delete(sessionID)
    },
    async readMessages(sessionID, limit = 10) {
      return (messages.get(sessionID) || []).slice(-limit)
    },
    async compactSession(sessionID) {
      // No-op for fake host
    },
  }
}
