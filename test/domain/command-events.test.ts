import { describe, it, expect } from "bun:test"
import { createCommandSession } from "../../src/domain/command-session"
import {
  PROTOCOL_VERSION,
  validateCommandStreamMessage,
  offsetsContinuous,
  expectedNextEnd,
  utf8ByteLength,
} from "../../src/domain/command-events"

function makeCommand() {
  return createCommandSession({
    id: "cmd-1",
    title: "t",
    command: "bun",
    cwd: "/tmp",
    ownerSessionID: "owner-1",
  })
}

describe("command-events protocol", () => {
  it("exposes a version constant", () => {
    expect(PROTOCOL_VERSION).toBe(1)
  })

  it("valid snapshot/output/status messages pass validation", () => {
    const command = makeCommand()
    const data = "hello"
    const snap = validateCommandStreamMessage({
      type: "snapshot",
      command,
      data,
      startOffset: 0,
      endOffset: utf8ByteLength(data),
    })
    expect(snap.ok).toBe(true)

    const out = validateCommandStreamMessage({
      type: "output",
      commandID: "cmd-1",
      data,
      startOffset: 5,
      endOffset: 5 + utf8ByteLength(data),
    })
    expect(out.ok).toBe(true)

    const status = validateCommandStreamMessage({ type: "status", command })
    expect(status.ok).toBe(true)

    const sub = validateCommandStreamMessage({
      type: "subscribe",
      commandID: "cmd-1",
      ownerSessionID: "owner-1",
    })
    expect(sub.ok).toBe(true)

    const input = validateCommandStreamMessage({
      type: "input",
      commandID: "cmd-1",
      data: "ls\n",
    })
    expect(input.ok).toBe(true)

    expect(validateCommandStreamMessage({ type: "interrupt", commandID: "cmd-1" }).ok).toBe(true)
    expect(validateCommandStreamMessage({ type: "resync", commandID: "cmd-1" }).ok).toBe(true)
    expect(validateCommandStreamMessage({ type: "unsubscribe", commandID: "cmd-1" }).ok).toBe(true)
    expect(
      validateCommandStreamMessage({ type: "error", code: "NOT_FOUND", message: "gone" }).ok,
    ).toBe(true)
  })

  it("rejects malformed input without throwing", () => {
    const bad: unknown[] = [
      null,
      undefined,
      42,
      "output",
      [],
      {}, // missing type
      { type: 42 },
      { type: "nope" }, // unknown type
      { type: "output", commandID: "cmd-1", data: "hi", startOffset: -1, endOffset: 1 }, // negative
      { type: "output", commandID: "cmd-1", data: "hi", startOffset: 1.5, endOffset: 3 }, // non-integer
      { type: "output", commandID: "cmd-1", data: "hi", startOffset: 5, endOffset: 3 }, // end < start
      { type: "output", commandID: "cmd-1", data: "hi", startOffset: 0, endOffset: 99 }, // byte mismatch
      { type: "output", commandID: "", data: "hi", startOffset: 0, endOffset: 2 }, // empty id
      { type: "output", commandID: "cmd-1", data: 42, startOffset: 0, endOffset: 0 }, // wrong data type
      { type: "snapshot", command: { id: "x" }, data: "", startOffset: 0, endOffset: 0 }, // bad command
      { type: "status", command: null },
      { type: "input", commandID: "cmd-1", data: 7 },
      { type: "interrupt", commandID: 7 },
      { type: "resync" },
      { type: "unsubscribe" },
      { type: "unsubscribe", commandID: "" },
      { type: "error", code: "", message: "m" },
      { type: "error", code: "E", message: 7 },
      { type: "subscribe", commandID: "cmd-1" }, // missing owner
    ]
    for (const value of bad) {
      let result: ReturnType<typeof validateCommandStreamMessage>
      expect(() => {
        result = validateCommandStreamMessage(value)
      }).not.toThrow()
      expect(result!.ok).toBe(false)
      if (!result!.ok) expect(typeof result!.error).toBe("string")
    }
  })

  it("detects gap / duplicate / exact-continue", () => {
    expect(offsetsContinuous(10, 10)).toBe(true) // exact continue
    expect(offsetsContinuous(10, 15)).toBe(false) // gap
    expect(offsetsContinuous(10, 7)).toBe(false) // duplicate/overlap
    expect(offsetsContinuous(0, 0)).toBe(true)
  })

  it("measures UTF-8 multi-byte offsets in bytes, not string length", () => {
    const emoji = "🔥" // 4 bytes UTF-8, length 2 in UTF-16
    const cjk = "日本語" // 9 bytes UTF-8, length 3
    expect(emoji.length).not.toBe(utf8ByteLength(emoji))
    expect(utf8ByteLength(emoji)).toBe(4)
    expect(utf8ByteLength(cjk)).toBe(9)
    expect(expectedNextEnd(0, emoji)).toBe(4)
    expect(expectedNextEnd(4, cjk)).toBe(13)

    // string-length-based endOffset must be rejected for multi-byte data
    const wrong = validateCommandStreamMessage({
      type: "output",
      commandID: "cmd-1",
      data: emoji,
      startOffset: 0,
      endOffset: emoji.length, // 2 — wrong, bytes are 4
    })
    expect(wrong.ok).toBe(false)

    const right = validateCommandStreamMessage({
      type: "output",
      commandID: "cmd-1",
      data: emoji,
      startOffset: 0,
      endOffset: 4,
    })
    expect(right.ok).toBe(true)
  })

  it("streamBytes is monotonic across simulated truncation", () => {
    const c = makeCommand()
    expect(c.streamBytes).toBe(0)
    expect(c.outputBytes).toBe(0)

    // Simulate lifetime production of 100 bytes, then truncation that
    // retains only the last 10 bytes on disk.
    c.streamBytes += 100
    c.outputBytes = 100
    c.truncated = false
    // Truncation drops oldest 90 bytes: retained resets, lifetime does not.
    c.outputBytes = 10
    c.truncated = true
    expect(c.outputBytes).toBe(10)
    expect(c.streamBytes).toBe(100)
    expect(c.streamBytes).toBeGreaterThanOrEqual(c.outputBytes)

    // More output after truncation advances both, lifetime stays ahead.
    c.streamBytes += 5
    c.outputBytes += 5
    expect(c.streamBytes).toBe(105)
    expect(c.outputBytes).toBe(15)
  })
})
