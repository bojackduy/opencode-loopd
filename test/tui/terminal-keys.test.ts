import { describe, expect, test } from "bun:test"
import { encodeTerminalKey, isDetachChord, isInterruptChord } from "../../src/tui/terminal-keys"

describe("encodeTerminalKey", () => {
  test("releases are ignored", () => {
    expect(encodeTerminalKey({ name: "a", text: "a", release: true })).toBeUndefined()
  })

  test("printable text forwards immediately", () => {
    expect(encodeTerminalKey({ name: "a", text: "a" })).toBe("a")
    expect(encodeTerminalKey({ name: "z", text: "Z", shift: true })).toBe("Z")
    // Paste bytes forward as their text.
    expect(encodeTerminalKey({ text: "pasted-bytes-123" })).toBeUndefined() // multi-char text refused
    expect(encodeTerminalKey({ sequence: "x" })).toBe("x")
  })

  test("Enter/Tab/Backspace/Escape", () => {
    expect(encodeTerminalKey({ name: "return" })).toBe("\r")
    expect(encodeTerminalKey({ name: "enter" })).toBe("\r")
    expect(encodeTerminalKey({ name: "tab" })).toBe("\t")
    expect(encodeTerminalKey({ name: "backspace" })).toBe("\x7f")
    expect(encodeTerminalKey({ name: "escape" })).toBe("\x1b")
  })

  test("arrows/Home/End/Delete/PageUp/PageDown VT sequences", () => {
    expect(encodeTerminalKey({ name: "up" })).toBe("\x1b[A")
    expect(encodeTerminalKey({ name: "down" })).toBe("\x1b[B")
    expect(encodeTerminalKey({ name: "right" })).toBe("\x1b[C")
    expect(encodeTerminalKey({ name: "left" })).toBe("\x1b[D")
    expect(encodeTerminalKey({ name: "home" })).toBe("\x1b[H")
    expect(encodeTerminalKey({ name: "end" })).toBe("\x1b[F")
    expect(encodeTerminalKey({ name: "delete" })).toBe("\x1b[3~")
    expect(encodeTerminalKey({ name: "pageup" })).toBe("\x1b[5~")
    expect(encodeTerminalKey({ name: "pagedown" })).toBe("\x1b[6~")
  })

  test("Ctrl+A..Z are C0 bytes (Ctrl+C is interrupt input, not close)", () => {
    expect(encodeTerminalKey({ name: "c", ctrl: true })).toBe("\x03")
    expect(encodeTerminalKey({ name: "a", ctrl: true })).toBe("\x01")
    expect(encodeTerminalKey({ name: "z", ctrl: true })).toBe("\x1a")
    expect(encodeTerminalKey({ name: "d", ctrl: true })).toBe("\x04")
  })

  test("Alt prefixes Escape", () => {
    expect(encodeTerminalKey({ name: "b", text: "b", alt: true })).toBe("\x1bb")
    expect(encodeTerminalKey({ name: "left", alt: true })).toBe("\x1b\x1b[D")
  })

  test("Kitty encodings are refused, never forwarded blindly", () => {
    expect(encodeTerminalKey({ name: "a", sequence: "\x1b[97;5u", ctrl: true })).toBeUndefined()
    expect(encodeTerminalKey({ name: "up", sequence: "\x1b[1;5A" })).toBe("\x1b[A") // named key wins
    expect(encodeTerminalKey({ sequence: "\x1b[97u" })).toBeUndefined()
  })

  test("unknown multi-char sequences are refused", () => {
    expect(encodeTerminalKey({ name: "f1" })).toBeUndefined()
    expect(encodeTerminalKey({})).toBeUndefined()
  })

  test("Ctrl+] is the reserved local detach chord (never forwarded)", () => {
    expect(isDetachChord({ name: "]", ctrl: true })).toBe(true)
    expect(isDetachChord({ sequence: "", ctrl: true })).toBe(true)
    expect(isDetachChord({ name: "]", ctrl: true, source: "kitty" })).toBe(true)
    expect(isDetachChord({ name: "]" })).toBe(false)
    expect(isDetachChord({ name: "]", ctrl: true, release: true })).toBe(false)
    expect(isDetachChord({ name: "c", ctrl: true })).toBe(false)
    // The encoder never emits the detach byte, on any source.
    expect(encodeTerminalKey({ name: "]", ctrl: true })).toBeUndefined()
    expect(encodeTerminalKey({ name: "]", ctrl: true, source: "kitty" })).toBeUndefined()
  })

  test("Ctrl+C is interrupt input (never a local close)", () => {
    expect(isInterruptChord({ name: "c", ctrl: true })).toBe(true)
    expect(isInterruptChord({ name: "C", ctrl: true })).toBe(true)
    expect(isInterruptChord({ name: "c" })).toBe(false)
    expect(isInterruptChord({ name: "]", ctrl: true })).toBe(false)
    expect(encodeTerminalKey({ name: "c", ctrl: true })).toBe("")
  })

  test("kitty frames pass only conventional keys; option counts as alt", () => {
    expect(encodeTerminalKey({ name: "a", text: "a", source: "kitty" })).toBe("a")
    expect(encodeTerminalKey({ name: "up", source: "kitty" })).toBe("\x1b[A")
    expect(encodeTerminalKey({ name: "f1", sequence: "\x1bOP", source: "kitty" })).toBeUndefined()
    expect(encodeTerminalKey({ name: "b", text: "b", option: true })).toBe("\x1bb")
  })
})
