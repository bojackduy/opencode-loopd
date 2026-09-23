import { describe, expect, it } from "bun:test"
import { promises as fs } from "fs"
import path from "path"
import os from "os"
import { createCommandStreamClient, type StreamSocket } from "../../src/tui/command-stream-client"
import { createCommandSession } from "../../src/domain/command-session"

function session(id: string, overrides: Record<string, unknown> = {}) {
  return { ...createCommandSession({ id, title: id, command: "echo", cwd: "/tmp", ownerSessionID: "owner-1" }), ...overrides }
}

class FakeSocket implements StreamSocket {
  sent: string[] = []
  onopen: (() => void) | null = null
  onmessage: ((data: string) => void) | null = null
  onclose: ((code: number, reason: string) => void) | null = null
  onerror: ((err: unknown) => void) | null = null
  closed = false
  send(data: string): void {
    this.sent.push(data)
  }
  close(): void {
    this.closed = true
  }
  open(): void {
    this.onopen?.()
  }
  deliver(msg: unknown): void {
    this.onmessage?.(typeof msg === "string" ? msg : JSON.stringify(msg))
  }
  drop(code = 1006, reason = "abnormal"): void {
    this.onclose?.(code, reason)
  }
}

async function tmpDir(): Promise<string> {
  const dir = path.join(os.tmpdir(), `loopd-stream-lifecycle-test-${crypto.randomUUID()}`)
  await fs.mkdir(dir, { recursive: true })
  return dir
}

async function writeEndpoint(dir: string, url = "ws://127.0.0.1:9/stream?token=t"): Promise<void> {
  const p = path.join(dir, ".opencode", "loopd", "commands", ".stream-endpoint.json")
  await fs.mkdir(path.dirname(p), { recursive: true })
  await fs.writeFile(p, JSON.stringify({ url, token: "t", pid: 1, generation: "g", startedAt: new Date().toISOString() }))
}

function sentTypes(sock: FakeSocket): string[] {
  return sock.sent.map((s) => {
    try {
      return (JSON.parse(s) as { type: string }).type
    } catch {
      return "unparseable"
    }
  })
}

describe("stream lifecycle (route needs)", () => {
  it("isLive is false until snapshot; input rejected before confirmation", async () => {
    const dir = await tmpDir()
    await writeEndpoint(dir)
    const sockets: FakeSocket[] = []
    const client = createCommandStreamClient({ createSocket: () => { const s = new FakeSocket(); sockets.push(s); return s } })
    await client.connect(dir)
    sockets[0]!.open()
    client.subscribe("cmd-1", "owner-1", {})
    expect(client.isLive("cmd-1")).toBe(false)
    expect(client.sendInput("cmd-1", "x").ok).toBe(false)
    expect(client.sendInterrupt("cmd-1").ok).toBe(false)
    sockets[0]!.deliver({ type: "snapshot", command: session("cmd-1"), data: "", startOffset: 0, endOffset: 0 })
    expect(client.isLive("cmd-1")).toBe(true)
    expect(client.sendInput("cmd-1", "x")).toEqual({ ok: true })
    expect(client.sendInterrupt("cmd-1")).toEqual({ ok: true })
    client.dispose()
  })

  it("unsubscribe sends the wire verb and stops delivery", async () => {
    const dir = await tmpDir()
    await writeEndpoint(dir)
    const sockets: FakeSocket[] = []
    const client = createCommandStreamClient({ createSocket: () => { const s = new FakeSocket(); sockets.push(s); return s } })
    await client.connect(dir)
    sockets[0]!.open()
    const deltas: string[] = []
    client.subscribe("cmd-1", "owner-1", { onDelta: (d) => deltas.push(d.data) })
    sockets[0]!.deliver({ type: "snapshot", command: session("cmd-1"), data: "ab", startOffset: 0, endOffset: 2 })
    expect(client.isLive("cmd-1")).toBe(true)
    client.unsubscribe("cmd-1")
    expect(sentTypes(sockets[0]!).includes("unsubscribe")).toBe(true)
    expect(client.isLive("cmd-1")).toBe(false)
    // Late frames for the removed sub are ignored.
    sockets[0]!.deliver({ type: "output", commandID: "cmd-1", data: "zz", startOffset: 2, endOffset: 4 })
    expect(deltas).toEqual([])
    client.dispose()
  })

  it("absent snapshot times out into a polling-fallback error", async () => {
    const dir = await tmpDir()
    await writeEndpoint(dir)
    const sockets: FakeSocket[] = []
    const errors: string[] = []
    const client = createCommandStreamClient({
      createSocket: () => { const s = new FakeSocket(); sockets.push(s); return s },
      snapshotTimeoutMs: 20,
    })
    await client.connect(dir)
    sockets[0]!.open()
    client.subscribe("cmd-1", "owner-1", { onError: (m) => errors.push(m) })
    expect(client.isLive("cmd-1")).toBe(false)
    await new Promise((r) => setTimeout(r, 60))
    expect(errors.some((e) => e.includes("snapshot-timeout"))).toBe(true)
    expect(client.isLive("cmd-1")).toBe(false)
    client.dispose()
  })

  it("stale socket close cannot clear the new connection (generation fence)", async () => {
    const dir = await tmpDir()
    await writeEndpoint(dir)
    const sockets: FakeSocket[] = []
    const client = createCommandStreamClient({
      createSocket: () => { const s = new FakeSocket(); sockets.push(s); return s },
      initialBackoffMs: 1,
      maxBackoffMs: 5,
    })
    await client.connect(dir)
    sockets[0]!.open()
    client.subscribe("cmd-1", "owner-1", {})
    sockets[0]!.deliver({ type: "snapshot", command: session("cmd-1"), data: "", startOffset: 0, endOffset: 0 })
    expect(client.isLive("cmd-1")).toBe(true)
    // Drop → reconnect opens socket[1]; stale socket[0] close afterwards is fenced.
    sockets[0]!.drop()
    const start = Date.now()
    while (sockets.length < 2 && Date.now() - start < 2000) {
      await new Promise((r) => setTimeout(r, 5))
    }
    expect(sockets.length).toBe(2)
    sockets[1]!.open()
    sockets[1]!.deliver({ type: "snapshot", command: session("cmd-1"), data: "", startOffset: 0, endOffset: 0 })
    expect(client.isLive("cmd-1")).toBe(true)
    // Late close from the stale first socket must not disconnect liveness.
    sockets[0]!.drop()
    await new Promise((r) => setTimeout(r, 10))
    expect(client.connectionState).toBe("connected")
    expect(client.isLive("cmd-1")).toBe(true)
    client.dispose()
  })

  it("pre-snapshot deltas are bounded and never applied", async () => {
    const dir = await tmpDir()
    await writeEndpoint(dir)
    const sockets: FakeSocket[] = []
    const deltas: string[] = []
    const client = createCommandStreamClient({
      createSocket: () => { const s = new FakeSocket(); sockets.push(s); return s },
      maxPreSnapshotBuffered: 2,
    })
    await client.connect(dir)
    sockets[0]!.open()
    client.subscribe("cmd-1", "owner-1", { onDelta: (d) => deltas.push(d.data) })
    for (let i = 0; i < 10; i++) {
      sockets[0]!.deliver({ type: "output", commandID: "cmd-1", data: "x", startOffset: i, endOffset: i + 1 })
    }
    expect(deltas).toEqual([])
    const subscribes = sentTypes(sockets[0]!).filter((t) => t === "subscribe").length
    // 1 initial + 1 resync (guarded by resyncPending, not per-frame).
    expect(subscribes).toBeLessThanOrEqual(2)
    client.dispose()
  })
})
