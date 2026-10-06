import { describe, expect, it } from "bun:test"
import { observeProviderLimit } from "../../src/domain/provider-limit"

describe("provider limit classification", () => {
  it("recognizes structured 429 and quota errors without persisting raw errors", () => {
    const result = observeProviderLimit({ data: { statusCode: 429, message: "secret diagnostic", responseHeaders: { authorization: "SECRET", "retry-after": "60" } } }, "session-error", "p/m")!
    expect(result.kind).toBe("rate-limit")
    expect(result.model).toBe("p/m")
    expect(result.statusCode).toBe(429)
    expect(Date.parse(result.retryAt!) - Date.parse(result.observedAt)).toBeGreaterThanOrEqual(59_000)
    expect(JSON.stringify(result)).not.toContain("SECRET")
    expect(JSON.stringify(result)).not.toContain("diagnostic")
    expect(observeProviderLimit({ code: "insufficient_quota" }, "prompt-delivery")?.kind).toBe("quota")
    expect(observeProviderLimit(new Error("Rate limit exceeded"), "prompt-delivery")?.kind).toBe("rate-limit")
  })

  it("does not classify network/auth/context/budget/pause as provider limits", () => {
    for (const message of ["network rate limit", "authentication quota exceeded", "maximum context length exceeded", "cost budget limit", "maxTurns reached", "paused", "quota information unknown", "rate limit information unknown", "ECONNRESET", "request timeout", "Invalid API key"]) {
      expect(observeProviderLimit(new Error(message), "session-error")).toBeUndefined()
    }
    expect(observeProviderLimit({ statusCode: 401, message: "quota exceeded" }, "session-error")).toBeUndefined()
    expect(observeProviderLimit({ statusCode: 403, message: "rate limited" }, "session-error")).toBeUndefined()
  })

  it("accepts only a safe retry-after scalar and never invents a quota reset", () => {
    const result = observeProviderLimit({ statusCode: 429, responseHeaders: { "retry-after": "garbage-token" } }, "session-error")!
    expect(result.retryAt).toBeUndefined()
    expect(result).not.toHaveProperty("remaining")
    const date = "Wed, 07 Oct 2026 12:00:00 GMT"
    expect(observeProviderLimit({ statusCode: 429, retryAfter: date }, "session-error")?.retryAt).toBe("2026-10-07T12:00:00.000Z")
  })
})
