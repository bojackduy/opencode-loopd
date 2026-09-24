// ─── Server: Host Adapter ────────────────────────────────────────────────────
// Wraps the OpenCode SDK client behind a testable interface.
// Production uses the real client; tests use a fake.

import { randomUUID } from "crypto"
import { describeError, logServerEvent } from "../infrastructure/server-log"
import type { Plugin as V2Plugin } from "@opencode/plugin"
import type { BridgeOutcome } from "../v2/native-bridge"
import type { NativeForkChild, WorkerTopology } from "../v2/native-rpc"
import { resolveNativeParentID } from "../v2/native-rpc"

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
  compactSession(sessionID: string): Promise<void>
  notifyOwner(ownerSessionID: string, message: string, agent?: string): Promise<void>
}

const recentParentNotifies = new Map<string, number>()
function shouldDedupParentNotify(ownerSessionID: string, message: string): boolean {
  const key = `${ownerSessionID}:${message.slice(0, 200)}`
  const now = Date.now()
  const last = recentParentNotifies.get(key)
  if (last !== undefined && now - last < 60_000) return true
  recentParentNotifies.set(key, now)
  // prune old entries occasionally
  if (recentParentNotifies.size > 200) {
    for (const [k, t] of recentParentNotifies.entries()) if (now - t > 60_000) recentParentNotifies.delete(k)
  }
  return false
}

// ─── Real Host (SDK-backed) ─────────────────────────────────────────────────

export function createRealHost(client: any, directory: string): LoopHost {
  return {
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
        throw new Error(`OpenCode session.promptAsync failed for worker "${sessionID}": ${detail}`)
      }
      await logServerEvent(directory, "worker.prompted", { sessionID })
      // SDK may return the created message ID in response headers or body
      return { messageID: result?.data?.messageID }
    },

    async readSession(sessionID) {
      try {
        const result = await client.session.get({ path: { id: sessionID } })
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

    async sessionStatus(sessionID) {
      try {
        const result = await client.session.status({})
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

    async abortSession(sessionID) {
      try {
        await client.session.abort({ path: { id: sessionID } })
      } catch {
        // Best-effort abort
      }
    },

    async readMessages(sessionID, limit = 10) {
      try {
        const result = await client.session.messages({
          path: { id: sessionID },
          query: { limit },
        })
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

    async compactSession(sessionID) {
      try {
        await client.session.compact({ sessionID })
      } catch {
        // Best-effort compaction
      }
    },

    async notifyOwner(ownerSessionID, message, agent) {
      if (shouldDedupParentNotify(ownerSessionID, message)) {
        await logServerEvent(directory, "parent.notify.deduped", { ownerSessionID, preview: message.slice(0, 160) })
        return
      }
      // Preserve the parent's identity: without an explicit agent the session
      // falls back to the global default (often Build), not the parent that
      // spawned the subagent. Callers pass the snapshot `parentAgent` when
      // available; otherwise we best-effort read the live session.
      let resolvedAgent = agent?.trim() || undefined
      if (!resolvedAgent) {
        try {
          const sess = await client.session.get({ path: { id: ownerSessionID } })
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
        } else {
          await logServerEvent(directory, "parent.notified", { ownerSessionID, preview: message.slice(0, 160) })
        }
      } catch (error) {
        await logServerEvent(directory, "parent.notify.failed", { ownerSessionID, detail: describeError(error) })
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

  return {
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
          const child = await context.session.get({ sessionID: childID })
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
          if (agent) await context.session.switchAgent({ sessionID: childID, agent })
          if (model) {
            await context.session.switchModel({
              sessionID: childID,
              model: { id: model.modelID, providerID: model.providerID },
            })
          }
          const rename = (context.session as {
            update?: (input: { sessionID: string; title: string }) => Promise<unknown>
          }).update
          if (rename) await rename({ sessionID: childID, title })
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
      const session = await context.session.create({
        title,
        ...(agent !== undefined ? { agent } : {}),
        ...(model !== undefined ? { model: { id: model.modelID, providerID: model.providerID } } : {}),
        location: { directory },
        metadata: { "loopd.parentID": parentID },
      })
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
      if (agent) await context.session.switchAgent({ sessionID, agent })
      if (model) {
        await context.session.switchModel({
          sessionID,
          model: { id: model.modelID, providerID: model.providerID },
        })
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
      const result = await context.session.prompt({
        sessionID,
        id: messageID,
        text: prompt,
      })
      statuses.set(sessionID, "busy")
      await logServerEvent(directory, "worker.prompted", { sessionID })
      return { messageID: (result as any)?.id }
    },

    async readSession(sessionID) {
      try {
        const session = await context.session.get({ sessionID })
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
      return statuses.get(sessionID) ?? "unknown"
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
        const messages = await context.session.context({ sessionID })
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

    async compactSession(sessionID) {
      try {
        await context.session.command({ sessionID, name: "compact", text: "" })
      } catch {
        // Best-effort compaction
      }
    },

    async notifyOwner(ownerSessionID, message) {
      try {
        await context.session.prompt({ sessionID: ownerSessionID, text: message })
        await logServerEvent(directory, "parent.notified", { ownerSessionID, preview: message.slice(0, 160) })
      } catch (error) {
        await logServerEvent(directory, "parent.notify.failed", { ownerSessionID, detail: describeError(error) })
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
}

export function createFakeHost(options: FakeHostOptions = {}): LoopHost & {
  sessions: Map<string, string[]>
  messages: Map<string, SessionMessage[]>
  prompts: string[]
  promptCalls: Array<{ sessionID: string; agent?: string; model?: ModelRef }>
} {
  const sessions = new Map<string, string[]>()
  const messages = new Map<string, SessionMessage[]>()
  const prompts: string[] = []
  const promptCalls: Array<{ sessionID: string; agent?: string; model?: ModelRef }> = []
  const recentNotifies = new Map<string, number>()

  return {
    sessions,
    messages,
    prompts,
    promptCalls,
    async createWorker({ parentID, title, agent }) {
      const id = `worker-${crypto.randomUUID().slice(0, 8)}`
      sessions.set(id, [])
      messages.set(id, [])
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
