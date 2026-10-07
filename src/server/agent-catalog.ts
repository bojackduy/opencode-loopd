// Project public identity metadata only; prompts and permissions stay private.
export interface CatalogAgent {
  name: string
  description?: string
  mode: "primary" | "subagent" | "all"
}

export interface AgentCatalog {
  capability: "supported" | "unsupported" | "unavailable"
  source: string
  observedAt: string
  switching: "session" | "next-prompt" | "unsupported"
  agents: CatalogAgent[]
}

export function emptyAgentCatalog(source: string, switching: AgentCatalog["switching"], capability: AgentCatalog["capability"] = "unsupported"): AgentCatalog {
  return { capability, source, observedAt: new Date().toISOString(), switching, agents: [] }
}

export function normalizeAgentCatalog(raw: unknown, source: string, switching: AgentCatalog["switching"]): AgentCatalog {
  const result = emptyAgentCatalog(source, switching, "unavailable")
  if (!Array.isArray(raw)) return result
  result.capability = "supported"
  for (const value of raw) {
    if (!value || typeof value !== "object" || typeof value.name !== "string" || !value.name.trim()) continue
    if (value.mode !== "primary" && value.mode !== "subagent" && value.mode !== "all") continue
    result.agents.push({ name: value.name, mode: value.mode, ...(typeof value.description === "string" ? { description: value.description } : {}) })
  }
  return result
}
