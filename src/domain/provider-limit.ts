/** A local failure observation, never a provider balance or remaining-quota claim. */
export interface ProviderLimitObservation {
  kind: "rate-limit" | "quota"
  source: "prompt-delivery" | "session-error"
  observedAt: string
  model?: string
  statusCode?: number
  retryAt?: string
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : {}
}

export function observeProviderLimit(error: unknown, source: ProviderLimitObservation["source"], model?: string): ProviderLimitObservation | undefined {
  const wrapper = object(error)
  const root = wrapper.cause ? object(wrapper.cause) : wrapper
  const data = object(root.data)
  const status = root.statusCode ?? root.status ?? data.statusCode ?? data.status
  const statusCode = typeof status === "number" ? status : undefined
  const code = root.code ?? data.code
  const message = [root.message, data.message, typeof error === "string" ? error : undefined].filter((s): s is string => typeof s === "string").join(" ")
  // Authentication, context, network and loop budgets are not provider quotas.
  if (statusCode === 401 || statusCode === 403 || /context.{0,20}(length|window|overflow)|maximum context|invalid.{0,10}(key|token)|unauthori[sz]ed|authentication|network|ECONN|ENOTFOUND|max.?turn|cost.?budget|budget.?limit/i.test(message)) return undefined
  const quota = code === "insufficient_quota" || code === "quota_exceeded" || /\b(insufficient quota|quota (exceeded|exhausted)|exceeded.{0,20}quota|usage limit reached|credit balance.{0,20}(low|exhausted|insufficient))\b/i.test(message)
  const rate = statusCode === 429 || code === "rate_limit_exceeded" || /\b(rate[ -]limit(ed| exceeded| reached| hit)|too many requests)\b/i.test(message)
  if (!quota && !rate) return undefined
  const observedAt = new Date().toISOString()
  const headers = object(root.responseHeaders ?? data.responseHeaders)
  const retryAfter = root.retryAfter ?? data.retryAfter ?? headers["retry-after"]
  let retryAt: string | undefined
  if (typeof retryAfter === "number" && Number.isFinite(retryAfter) && retryAfter >= 0) {
    retryAt = new Date(Date.now() + Math.min(retryAfter, 31_536_000) * 1000).toISOString()
  } else if (typeof retryAfter === "string") {
    if (/^\d+(\.\d+)?$/.test(retryAfter)) {
      retryAt = new Date(Date.now() + Math.min(Number(retryAfter), 31_536_000) * 1000).toISOString()
    } else if (Number.isFinite(Date.parse(retryAfter))) {
      retryAt = new Date(retryAfter).toISOString()
    }
  }
  return { kind: quota ? "quota" : "rate-limit", source, observedAt, ...(model ? { model } : {}), ...(statusCode !== undefined ? { statusCode } : {}), ...(retryAt ? { retryAt } : {}) }
}
