import { promises as fs } from "fs"

// Read backwards in fixed-size byte blocks. Decode only complete lines so UTF-8
// characters split across blocks survive. Memory follows the requested tail,
// not the age of the append-only log (a single record can still be large).
export async function readEventTail(
  target: string,
  limit: number,
): Promise<Record<string, unknown>[]> {
  try {
    // Preserve Array.slice's historical semantics for unusual limits, including
    // zero (all records). Dashboard callers use a small positive integer.
    if (!Number.isFinite(limit) || limit < 1) {
      const raw = await fs.readFile(target, "utf8")
      return raw.trim().split("\n").filter(Boolean).slice(-limit).map((line) => JSON.parse(line))
    }
    const count = Math.trunc(limit)
    const file = await fs.open(target, "r")
    try {
      let position = (await file.stat()).size
      let fragments: Buffer[] = []
      const lines: string[] = []
      const finishLine = (first = false) => {
        const line = Buffer.concat(fragments.reverse()).toString("utf8")
        fragments = []
        if (line && !((first || lines.length === 0) && !line.trim())) lines.push(line)
      }
      while (position > 0 && lines.length < count) {
        const length = Math.min(16 * 1024, position)
        position -= length
        const buffer = Buffer.allocUnsafe(length)
        const { bytesRead } = await file.read(buffer, 0, length, position)
        let end = bytesRead
        for (let i = bytesRead - 1; i >= 0; i--) {
          if (buffer[i] !== 10) continue
          fragments.push(buffer.subarray(i + 1, end))
          finishLine()
          end = i
          if (lines.length === count) break
        }
        if (lines.length < count) fragments.push(buffer.subarray(0, end))
      }
      if (lines.length < count) finishLine(true)
      // Like the original reader, malformed selected lines (including an
      // incomplete append) return [] rather than silently hiding corruption.
      return lines.reverse().map((line) => JSON.parse(line))
    } finally {
      await file.close()
    }
  } catch {
    return []
  }
}
