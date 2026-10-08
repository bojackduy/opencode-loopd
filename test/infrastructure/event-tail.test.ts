import { afterEach, describe, expect, test, spyOn } from "bun:test"
import { promises as fs } from "fs"
import path from "path"
import os from "os"
import { readEventTail } from "../../src/infrastructure/event-tail"
import { readEvents as storeEvents } from "../../src/infrastructure/state-store"
import { readEvents as repositoryEvents } from "../../src/infrastructure/state-repository"

const root = process.env.LOOPD_TEST_TMPDIR ?? os.tmpdir()
const directories: string[] = []
afterEach(async () => {
  for (const dir of directories.splice(0)) await fs.rm(dir, { recursive: true, force: true })
})
async function fixture(raw: string) {
  await fs.mkdir(root, { recursive: true })
  const dir = await fs.mkdtemp(path.join(root, "tail-test-"))
  directories.push(dir)
  const target = path.join(dir, ".opencode/loopd/events.ndjson")
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(target, raw)
  return { dir, target }
}
function original(raw: string, limit: number) {
  try { return raw.trim().split("\n").filter(Boolean).slice(-limit).map((line) => JSON.parse(line)) }
  catch { return [] }
}

describe("bounded event tails", () => {
  test("matches ordering, blank lines, limits and final newline semantics", async () => {
    for (const raw of ["", " \n\n", '\n {"id":1}\n\n{"id":2}\n\n  ', '{"id":1}\r\n{"id":2}', '{"id":1}\n \n{"id":2}\n']) {
      const { dir, target } = await fixture(raw)
      for (const limit of [1, 2, 50, 0, -1, 1.5, Infinity, NaN]) {
        expect(await readEventTail(target, limit)).toEqual(original(raw, limit))
        expect(await storeEvents(dir, limit)).toEqual(original(raw, limit))
        expect(await repositoryEvents(dir, limit)).toEqual(original(raw, limit))
      }
    }
  })
  test("missing files and malformed selected/partial final records retain [] behavior", async () => {
    expect(await readEventTail(path.join(root, "missing-events"), 20)).toEqual([])
    for (const raw of ['{"id":1}\n{"id":', 'bad\n{"id":2}\n']) {
      const { target } = await fixture(raw)
      for (const limit of [1, 2]) expect(await readEventTail(target, limit)).toEqual(original(raw, limit))
    }
  })
  test("UTF-8 boundaries and oversized records", async () => {
    for (const length of [16360, 16361, 16362, 16363, 100000]) {
      const records = [{ id: 1 }, { text: "🦊ế".repeat(length) }, { id: 3 }]
      const { target } = await fixture(records.map((r) => JSON.stringify(r)).join("\n"))
      expect(await readEventTail(target, 2)).toEqual(records.slice(-2))
    }
  })
  test("small tail reads only one 16KiB block, never a full-file buffer", async () => {
    const { target } = await fixture((JSON.stringify({ text: "x".repeat(200) }) + "\n").repeat(50000))
    const realOpen = fs.open.bind(fs)
    let bytes = 0
    let largest = 0
    let closes = 0
    const open = spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await realOpen(...args)
      const read = handle.read.bind(handle)
      handle.read = (async (...args: any[]) => {
        largest = Math.max(largest, args[0].byteLength)
        const result = await (read as any)(...args)
        bytes += result.bytesRead
        return result
      }) as typeof handle.read
      const close = handle.close.bind(handle)
      handle.close = async () => { closes++; await close() }
      return handle
    })
    const readFile = spyOn(fs, "readFile")
    try {
      expect((await readEventTail(target, 20)).length).toBe(20)
      expect(bytes).toBe(16384)
      expect(largest).toBe(16384)
      expect(readFile).not.toHaveBeenCalled()
      expect(closes).toBe(1)
    } finally { open.mockRestore(); readFile.mockRestore() }
  })
})
