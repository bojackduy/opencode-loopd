import { describe, expect, it } from "bun:test"
import { createNativeBridge, NativeBridgeError } from "../../src/v2/native-bridge"
import type { WorkerCreateRequest } from "../../src/v2/native-rpc"

function request(id = "req-1"): WorkerCreateRequest {
  return { requestID: id, goalID: "goal-1", parentSessionID: "parent-1", title: "loopd: test" }
}

const noopEmit = () => {}

describe("native bridge: exactly-one claimant", () => {
  it("first claim wins; the second loses", async () => {
    const bridge = createNativeBridge({ claimTimeoutMs: 50, claimedTimeoutMs: 50 })
    const pending = bridge.requestWorker(request(), noopEmit)
    // Suppress unhandled rejection warnings on the pending promise; the
    // claimed-timeout below is expected in this test.
    void pending.catch(() => {})
    expect(bridge.handleClaim({ requestID: "req-1", claimantID: "tui-A" })).toEqual({ won: true })
    expect(bridge.handleClaim({ requestID: "req-1", claimantID: "tui-B" })).toEqual({ won: false })
    await expect(pending).rejects.toBeInstanceOf(NativeBridgeError)
    bridge.dispose()
  })

  it("claims for unknown requests lose", () => {
    const bridge = createNativeBridge()
    expect(bridge.handleClaim({ requestID: "nope", claimantID: "tui-A" })).toEqual({ won: false })
    bridge.dispose()
  })

  it("completes the native child exactly once; late duplicates are ignored", async () => {
    const bridge = createNativeBridge({ claimTimeoutMs: 50, claimedTimeoutMs: 500 })
    const pending = bridge.requestWorker(request(), noopEmit)
    expect(bridge.handleClaim({ requestID: "req-1", claimantID: "tui-A" })).toEqual({ won: true })
    expect(bridge.handleComplete({
      requestID: "req-1",
      childSessionID: "child-1",
      parentSessionID: "parent-1",
      topology: "v2-native-child",
    })).toBe(true)
    await expect(pending).resolves.toEqual({
      kind: "native-child",
      childSessionID: "child-1",
      parentSessionID: "parent-1",
      topology: "v2-native-child",
    })
    // Late duplicate completion after settle: ignored, no second outcome.
    expect(bridge.handleComplete({
      requestID: "req-1",
      childSessionID: "child-EVIL",
      parentSessionID: "parent-1",
      topology: "v2-native-child",
    })).toBe(false)
    bridge.dispose()
  })
})

describe("native bridge: timeouts", () => {
  it("unclaimed request resolves as unclaimed (root fallback path)", async () => {
    const bridge = createNativeBridge({ claimTimeoutMs: 10, claimedTimeoutMs: 10 })
    await expect(bridge.requestWorker(request(), noopEmit)).resolves.toEqual({ kind: "unclaimed" })
    bridge.dispose()
  })

  it("emit throw behaves as unclaimed (unsupported transport)", async () => {
    const bridge = createNativeBridge()
    await expect(bridge.requestWorker(request(), () => {
      throw new Error("no rpc")
    })).resolves.toEqual({ kind: "unclaimed" })
    bridge.dispose()
  })

  it("claimed-but-vanished rejects (never duplicate, never silent fallback)", async () => {
    const bridge = createNativeBridge({ claimTimeoutMs: 10, claimedTimeoutMs: 10 })
    const pending = bridge.requestWorker(request(), noopEmit)
    expect(bridge.handleClaim({ requestID: "req-1", claimantID: "tui-ghost" })).toEqual({ won: true })
    const error = await pending.catch((e) => e)
    expect(error).toBeInstanceOf(NativeBridgeError)
    expect((error as NativeBridgeError).code).toBe("claimed-timeout")
    // Late completion after the claimed-timeout: ignored (still no duplicate).
    expect(bridge.handleComplete({
      requestID: "req-1",
      childSessionID: "child-late",
      parentSessionID: "parent-1",
      topology: "v2-native-child",
    })).toBe(false)
    bridge.dispose()
  })
})

describe("native bridge: explicit failure", () => {
  it("pre-creation failure resolves fallback-safe", async () => {
    const bridge = createNativeBridge({ claimTimeoutMs: 50, claimedTimeoutMs: 500 })
    const pending = bridge.requestWorker(request(), noopEmit)
    bridge.handleClaim({ requestID: "req-1", claimantID: "tui-A" })
    expect(bridge.handleFailure({
      requestID: "req-1",
      reason: "fork-failed",
      detail: "boom",
      preCreation: true,
    })).toBe(true)
    await expect(pending).resolves.toEqual({ kind: "fallback-safe", reason: "fork-failed", detail: "boom" })
    bridge.dispose()
  })

  it("post-creation failure rejects (parent-mismatch never falls back)", async () => {
    const bridge = createNativeBridge({ claimTimeoutMs: 50, claimedTimeoutMs: 500 })
    const pending = bridge.requestWorker(request(), noopEmit)
    bridge.handleClaim({ requestID: "req-1", claimantID: "tui-A" })
    expect(bridge.handleFailure({
      requestID: "req-1",
      reason: "parent-mismatch",
      detail: "child.parentID=\"other\"",
      preCreation: false,
    })).toBe(true)
    const error = await pending.catch((e) => e)
    expect(error).toBeInstanceOf(NativeBridgeError)
    expect((error as NativeBridgeError).code).toBe("parent-mismatch")
    bridge.dispose()
  })
})

describe("native bridge: disposal", () => {
  it("rejects all pending requests", async () => {
    const bridge = createNativeBridge({ claimTimeoutMs: 5000, claimedTimeoutMs: 5000 })
    const p1 = bridge.requestWorker(request("a"), noopEmit)
    const p2 = bridge.requestWorker(request("b"), noopEmit)
    expect(bridge.pendingCount()).toBe(2)
    bridge.dispose()
    expect(bridge.isDisposed()).toBe(true)
    await expect(p1).rejects.toMatchObject({ code: "disposed" })
    await expect(p2).rejects.toMatchObject({ code: "disposed" })
    expect(bridge.pendingCount()).toBe(0)
  })

  it("rejects new requests after disposal", async () => {
    const bridge = createNativeBridge()
    bridge.dispose()
    await expect(bridge.requestWorker(request(), noopEmit)).rejects.toMatchObject({ code: "disposed" })
  })
})
