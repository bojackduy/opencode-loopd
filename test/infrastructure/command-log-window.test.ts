import { describe, expect, it, afterEach } from "bun:test"
import { promises as fs } from "fs"
import path from "path"
import os from "os"
import {
  commandLogFile,
  decodeUtf8Window,
  readCommandLog,
} from "../../src/infrastructure/state-repository"
import { utf8ByteLength } from "../../src/domain/command-events"

const dirs: string[] = []
afterEach(async () => {
  while (dirs.length > 0) await fs.rm(dirs.pop()!, { recursive: true, force: true })
})

async function seedDir(content: string): Promise<{ dir: string; id: string }> {
  const dir = path.join(os.tmpdir(), `loopd-log-window-${crypto.randomUUID()}`)
  await fs.mkdir(dir, { recursive: true })
  dirs.push(dir)
  const id = "cmd-1"
  await fs.mkdir(path.dirname(commandLogFile(dir, id)), { recursive: true })
  await fs.writeFile(commandLogFile(dir, id), content, "utf8")
  return { dir, id }
}

describe("decodeUtf8Window", () => {
  it("passes ASCII windows through untouched", () => {
    const buf = Buffer.from("hello world", "utf8")
    const r = decodeUtf8Window(buf, 100)
    expect(r.text).toBe("hello world")
    expect(r.startByte).toBe(100)
    expect(r.endByte).toBe(111)
  })

  it("skips a leading split sequence and trims a trailing one", () => {
    // "a漢b": a(1) + 漢(3: e6 bc a2) + b(1) = 5 bytes.
    const full = Buffer.from("a漢b", "utf8")
    expect(full.length).toBe(5)
    // Window starting mid-漢 (byte 2, a continuation byte).
    const mid = full.subarray(2)
    const r = decodeUtf8Window(mid, 2)
    expect(r.text).toBe("b")
    expect(r.startByte).toBe(4)
    // Window ending mid-漢 (bytes 0..3: a + first 2 bytes of 漢).
    const cut = full.subarray(0, 3)
    const r2 = decodeUtf8Window(cut, 0)
    expect(r2.text).toBe("a")
    expect(r2.endByte).toBe(1)
  })

  it("always satisfies utf8ByteLength(text) === endByte - startByte", () => {
    const text = "héllo wörld ✓ 漢字 emoji 🎉 end"
    const full = Buffer.from(text, "utf8")
    for (let start = 0; start < full.length; start++) {
      for (let end = start + 1; end <= Math.min(full.length, start + 8); end++) {
        const r = decodeUtf8Window(full.subarray(start, end), start)
        expect(utf8ByteLength(r.text)).toBe(r.endByte - r.startByte)
        // Decoded text never contains a replacement character from splitting:
        // every returned byte range is a clean prefix of complete sequences.
        expect(r.startByte).toBeGreaterThanOrEqual(start)
        expect(r.endByte).toBeLessThanOrEqual(end)
      }
    }
  })
})

describe("readCommandLog byte windows", () => {
  it("returns boundary-safe windows whose byte length matches the offsets", async () => {
    const text = "x".repeat(50) + "漢字テスト" + "y".repeat(50)
    const { dir, id } = await seedDir(text)
    const total = Buffer.byteLength(text, "utf8")
    // Deliberately split inside the multi-byte run.
    const log = await readCommandLog(dir, id, { offsetBytes: 51, limitBytes: 10 })
    expect(log.totalBytes).toBe(total)
    expect(log.startByte).toBeGreaterThanOrEqual(51)
    // Core invariant: the payload re-encodes to exactly the bytes consumed,
    // so lifetime offset arithmetic (start + byteLength) never drifts.
    const endByte = log.startByte + utf8ByteLength(log.text)
    expect(endByte).toBeLessThanOrEqual(total)
    expect(endByte).toBeGreaterThan(log.startByte)
    expect(log.text).not.toContain("�")
    // Re-reading from the adjusted start yields the same text (idempotent).
    const again = await readCommandLog(dir, id, { offsetBytes: log.startByte, limitBytes: utf8ByteLength(log.text) + 4 })
    expect(again.text.startsWith(log.text)).toBe(true)
  })
})
