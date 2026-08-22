// ─── Server: Host Adapter ────────────────────────────────────────────────────
// Wraps the OpenCode SDK client behind a testable interface.
// Production uses the real client; tests use a fake.

import { describeError, logServerEvent } from "../infrastructure/server-log"

export interface ModelRef {
  providerID: string
  modelID: string
}

export interface SessionMessage {
  role: "user" | "assistant"
  content: string
  timestamp?: string
  messageID?: string
}

export interface SessionUsage {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
}

export type SessionStatusType = "idle" | "busy" | "retry"

export interface LoopHost {
  createWorker(input: { parentID: string; title: string; agent?: string }): Promise<string>
  promptWorker(input: {
    sessionID: string
    prompt: string
    model?: ModelRef
    agent?: string
  }): Promise<void>
  sessionStatus(sessionID: string): Promise<SessionStatusType>
  abortSession(sessionID: string): Promise<void>
  readMessages(sessionID: string, limit?: number): Promise<SessionMessage[]>
  compactSession(sessionID: string): Promise<void>
  notifyOwner(ownerSessionID: string, message: string): Promise<void>
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
    async createWorker({ parentID, title, agent }) {
      try {
        const body: any = { parentID, title }
        if (agent) body.agent = agent
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

    async promptWorker({ sessionID, prompt, model, agent }) {
      const body: any = {
        parts: [{ type: "text", text: prompt }],
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
    },

    async sessionStatus(sessionID) {
      try {
        const result = await client.session.status({})
        const data = result?.data
        if (!data || typeof data !== "object") return "idle"
        const status = data[sessionID]
        if (!status || typeof status !== "object") return "idle"
        const type = status.type as string
        if (type === "busy" || type === "retry") return type
        return "idle"
      } catch {
        return "idle"
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
        return data.map((m: any) => ({
          role: m.info?.role || "assistant",
          content: m.parts
            ?.filter((p: any) => p.type === "text")
            .map((p: any) => p.text)
            .join("\n") || "",
          timestamp: m.info?.time?.completed
            ? new Date(m.info.time.completed).toISOString()
            : undefined,
          messageID: m.id,
        }))
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

    async notifyOwner(ownerSessionID, message) {
      if (shouldDedupParentNotify(ownerSessionID, message)) {
        await logServerEvent(directory, "parent.notify.deduped", { ownerSessionID, preview: message.slice(0, 160) })
        return
      }
      try {
        const result = await withTimeout<any>(
          client.session.promptAsync({
            path: { id: ownerSessionID },
            body: { parts: [{ type: "text", text: message }] },
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
}

export function createFakeHost(options: FakeHostOptions = {}): LoopHost & {
  sessions: Map<string, string[]>
  prompts: string[]
} {
  const sessions = new Map<string, string[]>()
  const prompts: string[] = []
  const recentNotifies = new Map<string, number>()

  return {
    sessions,
    prompts,
    async createWorker({ parentID, title, agent }) {
      const id = `worker-${crypto.randomUUID().slice(0, 8)}`
      sessions.set(id, [])
      if (agent) (sessions as any).agents = { ...((sessions as any).agents || {}), [id]: agent }
      return id
    },
    async promptWorker({ sessionID, prompt }) {
      const msgs = sessions.get(sessionID) || []
      msgs.push(prompt)
      sessions.set(sessionID, msgs)
      prompts.push(prompt)
      if (options.workerDelay) {
        await new Promise((r) => setTimeout(r, options.workerDelay))
      }
    },
    async sessionStatus(sessionID) {
      if (sessions.has(sessionID)) return "idle"
      return "idle"
    },
    async abortSession(sessionID) {
      sessions.delete(sessionID)
    },
    async readMessages(sessionID) {
      return []
    },
    async compactSession(sessionID) {
      // No-op for fake host
    },

    async notifyOwner(ownerSessionID, message) {
      const key = `${ownerSessionID}:${message.slice(0, 200)}`
      const now = Date.now()
      const last = recentNotifies.get(key)
      if (last !== undefined && now - last < 60_000) return
      recentNotifies.set(key, now)
      // Fake host records for tests
      ;(sessions as any).notifications = (sessions as any).notifications || []
      ;(sessions as any).notifications.push({ ownerSessionID, message })
    },
  }
}
