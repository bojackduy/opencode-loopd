// ─── Server: Host Adapter ────────────────────────────────────────────────────
// Wraps the OpenCode SDK client behind a testable interface.
// Production uses the real client; tests use a fake.

export interface ModelRef {
  providerID: string
  modelID: string
}

export interface SessionMessage {
  role: "user" | "assistant"
  content: string
  timestamp?: string
}

export interface LoopHost {
  createWorker(input: { parentID: string; title: string }): Promise<string>
  promptWorker(input: {
    sessionID: string
    prompt: string
    model?: ModelRef
    agent?: string
  }): Promise<void>
  sessionStatus(sessionID: string): Promise<"idle" | "busy" | "retry">
  abortSession(sessionID: string): Promise<void>
  readMessages(sessionID: string, limit?: number): Promise<SessionMessage[]>
}

export function createRealHost(client: any): LoopHost {
  return {
    async createWorker({ parentID, title }) {
      const result = await client.session.create({
        body: { parentID, title },
      })
      const data = result?.data
      if (!data?.id) throw new Error("failed to create worker session")
      return data.id
    },

    async promptWorker({ sessionID, prompt, model, agent }) {
      const body: any = {
        parts: [{ type: "text", text: prompt }],
      }
      if (model) body.model = model
      if (agent) body.agent = agent
      await client.session.promptAsync({
        path: { id: sessionID },
        body,
      })
    },

    async sessionStatus(sessionID) {
      try {
        const result = await client.session.status({})
        const data = result?.data
        if (!data || typeof data !== "object") return "idle"
        const status = data[sessionID]
        if (!status || typeof status !== "object") return "idle"
        return status.type || "idle"
      } catch {
        return "idle"
      }
    },

    async abortSession(sessionID) {
      await client.session.abort({ path: { id: sessionID } })
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
        }))
      } catch {
        return []
      }
    },
  }
}
