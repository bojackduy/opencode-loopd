// Only allowlisted public metadata crosses the host boundary. Provider/model
// records can contain request headers, bodies and credentials: never spread them.
export interface CatalogModel {
  providerID: string
  modelID: string
  name: string
  usable: boolean | "unknown"
  contextLimit?: number
  outputLimit?: number
}

export interface CatalogProvider {
  providerID: string
  name: string
  connected: boolean | "unknown"
}

export interface ModelCatalog {
  capability: "supported" | "unsupported" | "unavailable"
  source: string
  observedAt: string
  switching: "session" | "next-prompt" | "unsupported"
  providers: CatalogProvider[]
  models: CatalogModel[]
  quota: {
    status: "unknown"
    capability: "unsupported"
    source: string
    observedAt: string
    limitation: string
  }
}

export function emptyCatalog(source: string, switching: ModelCatalog["switching"], capability: ModelCatalog["capability"] = "unsupported"): ModelCatalog {
  const observedAt = new Date().toISOString()
  return {
    capability, source, observedAt, switching, providers: [], models: [],
    quota: {
      status: "unknown", capability: "unsupported", source, observedAt,
      limitation: "Host catalog does not report remaining quota or reset time. Connected/enabled does not prove remaining balance; local rate-limit observations are not balance data.",
    },
  }
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function model(raw: unknown, providerID: string, usable: CatalogModel["usable"]): CatalogModel | undefined {
  const value = record(raw)
  // v2 session model references use id, not the upstream modelID alias.
  if (typeof value.id !== "string" || !value.id) return undefined
  const limit = record(value.limit)
  return {
    providerID, modelID: value.id,
    name: typeof value.name === "string" ? value.name : value.id,
    usable,
    ...(typeof limit.context === "number" && Number.isFinite(limit.context) ? { contextLimit: limit.context } : {}),
    ...(typeof limit.output === "number" && Number.isFinite(limit.output) ? { outputLimit: limit.output } : {}),
  }
}

export function normalizeV1Catalog(raw: unknown): ModelCatalog {
  const result = emptyCatalog("v1 provider.list", "next-prompt", "unavailable")
  const value = record(raw)
  if (!Array.isArray(value.all) || !Array.isArray(value.connected)) return result
  result.capability = "supported"
  const connected = new Set(value.connected.filter((id): id is string => typeof id === "string"))
  for (const rawProvider of value.all) {
    const p = record(rawProvider)
    if (typeof p.id !== "string") continue
    const available = connected.has(p.id)
    result.providers.push({ providerID: p.id, name: typeof p.name === "string" ? p.name : p.id, connected: available })
    for (const rawModel of Object.values(record(p.models))) {
      const m = model(rawModel, p.id, available)
      if (m) result.models.push(m)
    }
  }
  return result
}

export function normalizeV2Catalog(rawProviders: unknown, rawModels: unknown): ModelCatalog {
  const result = emptyCatalog("v2 provider.list + model.list", "session", "unavailable")
  const providers = record(rawProviders).data
  const models = record(rawModels).data
  if (!Array.isArray(providers) || !Array.isArray(models)) return result
  result.capability = "supported"
  const disabled = new Set<string>()
  for (const rawProvider of providers) {
    const p = record(rawProvider)
    if (typeof p.id !== "string") continue
    if (p.activation === "disabled") disabled.add(p.id)
    // Activation is NOT evidence of a connected account.
    result.providers.push({ providerID: p.id, name: typeof p.name === "string" ? p.name : p.id, connected: "unknown" })
  }
  const knownProviders = new Set(result.providers.map((p) => p.providerID))
  for (const rawModel of models) {
    const value = record(rawModel)
    if (typeof value.providerID !== "string" || !knownProviders.has(value.providerID)) continue
    const usable = disabled.has(value.providerID) || value.enabled === false ? false : value.enabled === true ? true : "unknown"
    const m = model(value, value.providerID, usable)
    if (m) result.models.push(m)
  }
  return result
}
