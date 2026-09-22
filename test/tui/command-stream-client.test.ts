import { describe, it, expect } from "bun:test"
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
  /** Drive the socket open from the test. */
  open(): void {
    this.onopen?.()
  }
  /** Deliver a server→client message. */
  deliver(msg: unknown): void {
    this.onmessage?.(typeof msg === "string" ? msg : JSON.stringify(msg))
  }
  /** Unexpected close (server side). */
  drop(code = 1006, reason = "abnormal"): void {
    this.onclose?.(code, reason)
  }
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

async function tmpDir(): Promise<string> {
  const dir = path.join(os.tmpdir(), `loopd-stream-client-test-${crypto.randomUUID()}`)
  await fs.mkdir(dir, { recursive: true })
  return dir
}

async function writeEndpoint(dir: string, url = "ws://127.0.0.1:9/stream?token=t"): Promise<void> {
  const p = path.join(dir, ".opencode", "loopd", "commands", ".stream-endpoint.json")
  await fs.mkdir(path.dirname(p), { recursive: true })
  await fs.writeFile(p, JSON.stringify({ url, token: "t", pid: 1, generation: "g", startedAt: new Date().toISOString() }))
}

describe("Command stream client", () => {
  it("no-endpoint → {ok:false} without throwing", async () => {
    const dir = await tmpDir()
    const sockets: FakeSocket[] = []
    const client = createCommandStreamClient({ createSocket: (url) => { const s = new FakeSocket(); sockets.push(s); return s } })
    const r = await client.connect(dir)
    expect(r).toEqual({ ok: false, reason: "no-endpoint" })
    expect(sockets.length).toBe(0)
    client.dispose()
  })

  it("snapshot replaces state with correct offsets", async () => {
    const dir = await tmpDir()
    await writeEndpoint(dir)
    const sockets: FakeSocket[] = []
    const client = createCommandStreamClient({ createSocket: () => { const s = new FakeSocket(); sockets.push(s); return s } })
    expect((await client.connect(dir)).ok).toBe(true)
    sockets[0]!.open()
    let snap: { data: string; startOffset: number; endOffset: number } | undefined
    client.subscribe("cmd-1", "owner-1", { onSnapshot: (s) => { snap = s } })
    expect(sentTypes(sockets[0]!).includes("subscribe")).toBe(true)
    sockets[0]!.deliver({ type: "snapshot", command: session("cmd-1"), data: "hello", startOffset: 0, endOffset: 5 })
    expect(snap).toMatchObject({ data: "hello", startOffset: 0, endOffset: 5 })
    client.dispose()
  })

  it("exact-continue deltas append", async () => {
    const dir = await tmpDir()
    await writeEndpoint(dir)
    const sockets: FakeSocket[] = []
    const client = createCommandStreamClient({ createSocket: () => { const s = new FakeSocket(); sockets.push(s); return s } })
    await client.connect(dir)
    sockets[0]!.open()
    const deltas: string[] = []
    client.subscribe("cmd-1", "owner-1", { onDelta: (d) => deltas.push(d.data) })
    sockets[0]!.deliver({ type: "snapshot", command: session("cmd-1"), data: "ab", startOffset: 0, endOffset: 2 })
    sockets[0]!.deliver({ type: "output", commandID: "cmd-1", data: "cd", startOffset: 2, endOffset: 4 })
    sockets[0]!.deliver({ type: "output", commandID: "cmd-1", data: "ef", startOffset: 4, endOffset: 6 })
    expect(deltas).toEqual(["cd", "ef"])
    client.dispose()
  })

  it("gap triggers one resync (fresh subscribe handshake)", async () => {
    const dir = await tmpDir()
    await writeEndpoint(dir)
    const sockets: FakeSocket[] = []
    const client = createCommandStreamClient({ createSocket: () => { const s = new FakeSocket(); sockets.push(s); return s } })
    await client.connect(dir)
    sockets[0]!.open()
    const deltas: string[] = []
    client.subscribe("cmd-1", "owner-1", { onDelta: (d) => deltas.push(d.data) })
    sockets[0]!.deliver({ type: "snapshot", command: session("cmd-1"), data: "ab", startOffset: 0, endOffset: 2 })
    const before = sockets[0]!.sent.length
    // Gap: next starts at 10, skipping bytes 2..10.
    sockets[0]!.deliver({ type: "output", commandID: "cmd-1", data: "XX", startOffset: 10, endOffset: 12 })
    expect(deltas).toEqual([]) // gap bytes never appended
    const fresh = sockets[0]!.sent.slice(before).map((s) => JSON.parse(s))
    expect(fresh.length).toBe(1)
    expect(fresh[0]).toMatchObject({ type: "subscribe", commandID: "cmd-1", ownerSessionID: "owner-1" })
    // A second gap frame in the same episode must NOT trigger another resync.
    sockets[0]!.deliver({ type: "output", commandID: "cmd-1", data: "YY", startOffset: 12, endOffset: 14 })
    expect(sockets[0]!.sent.length).toBe(before + 1)
    // Fresh snapshot resolves the episode; exact-continue works again.
    sockets[0]!.deliver({ type: "snapshot", command: session("cmd-1"), data: "abXX", startOffset: 8, endOffset: 12 })
    sockets[0]!.deliver({ type: "output", commandID: "cmd-1", data: "ZZ", startOffset: 12, endOffset: 14 })
    expect(deltas).toEqual(["ZZ"])
    client.dispose()
  })

  it("overlap does not duplicate bytes", async () => {
    const dir = await tmpDir()
    await writeEndpoint(dir)
    const sockets: FakeSocket[] = []
    const client = createCommandStreamClient({ createSocket: () => { const s = new FakeSocket(); sockets.push(s); return s } })
    await client.connect(dir)
    sockets[0]!.open()
    const deltas: string[] = []
    client.subscribe("cmd-1", "owner-1", { onDelta: (d) => deltas.push(d.data) })
    sockets[0]!.deliver({ type: "snapshot", command: session("cmd-1"), data: "abcd", startOffset: 0, endOffset: 4 })
    const before = sockets[0]!.sent.length
    // Overlap: redelivery starting at 2.
    sockets[0]!.deliver({ type: "output", commandID: "cmd-1", data: "cd", startOffset: 2, endOffset: 4 })
    expect(deltas).toEqual([])
    expect(sockets[0]!.sent.length).toBe(before + 1) // one resync, no duplicate append
    client.dispose()
  })

  it("status updates metadata", async () => {
    const dir = await tmpDir()
    await writeEndpoint(dir)
    const sockets: FakeSocket[] = []
    const client = createCommandStreamClient({ createSocket: () => { const s = new FakeSocket(); sockets.push(s); return s } })
    await client.connect(dir)
    sockets[0]!.open()
    let status: string | undefined
    client.subscribe("cmd-1", "owner-1", { onStatus: (c) => { status = c.status } })
    sockets[0]!.deliver({ type: "snapshot", command: session("cmd-1", { status: "running" }), data: "", startOffset: 0, endOffset: 0 })
    sockets[0]!.deliver({ type: "status", command: session("cmd-1", { status: "exited", exitCode: 0 }) })
    expect(status).toBe("exited")
    client.dispose()
  })

  it("sendInput/sendInterrupt serialize correct wire messages", async () => {
    const dir = await tmpDir()
    await writeEndpoint(dir)
    const sockets: FakeSocket[] = []
    const client = createCommandStreamClient({ createSocket: () => { const s = new FakeSocket(); sockets.push(s); return s } })
    await client.connect(dir)
    sockets[0]!.open()
    client.subscribe("cmd-1", "owner-1", {})
    sockets[0]!.sent.length = 0 // drop the subscribe handshake
    expect(client.sendInput("cmd-1", "ls\n")).toEqual({ ok: true })
    expect(client.sendInterrupt("cmd-1")).toEqual({ ok: true })
    const msgs = sockets[0]!.sent.map((s) => JSON.parse(s))
    expect(msgs).toEqual([
      { type: "input", commandID: "cmd-1", data: "ls\n" },
      { type: "interrupt", commandID: "cmd-1" },
    ])
    // Not subscribed → {ok:false} so callers fall back to the control bus.
    expect(client.sendInput("other", "x").ok).toBe(false)
    expect(client.sendInterrupt("other").ok).toBe(false)
    client.dispose()
  })

  it("unexpected close → reconnect with resubscribe", async () => {
    const dir = await tmpDir()
    await writeEndpoint(dir)
    const sockets: FakeSocket[] = []
    const states: string[] = []
    const client = createCommandStreamClient({
      createSocket: () => { const s = new FakeSocket(); sockets.push(s); return s },
      onConnection: (s) => states.push(s),
      initialBackoffMs: 1,
      maxBackoffMs: 5,
    })
    await client.connect(dir)
    sockets[0]!.open()
    client.subscribe("cmd-1", "owner-1", {})
    const subscribesBefore = sentTypes(sockets[0]!).filter((t) => t === "subscribe").length
    expect(subscribesBefore).toBe(1)
    sockets[0]!.drop()
    // Reconnect fires via backoff timer; open the new socket when it appears.
    const start = Date.now()
    while (sockets.length < 2 && Date.now() - start < 2000) {
      await new Promise((r) => setTimeout(r, 5))
    }
    expect(sockets.length).toBe(2)
    sockets[1]!.open()
    await new Promise((r) => setTimeout(r, 5))
    expect(sentTypes(sockets[1]!).includes("subscribe")).toBe(true)
    expect(states).toContain("connected")
    client.dispose()
  })

  it("resync-loop guard: persistent gap does not spin forever", async () => {
    const dir = await tmpDir()
    await writeEndpoint(dir)
    const sockets: FakeSocket[] = []
    const errors: string[] = []
    const client = createCommandStreamClient({
      createSocket: () => { const s = new FakeSocket(); sockets.push(s); return s },
      maxResyncsPerWindow: 3,
      resyncWindowMs: 60_000,
    })
    await client.connect(dir)
    sockets[0]!.open()
    client.subscribe("cmd-1", "owner-1", { onError: (m) => errors.push(m) })
    sockets[0]!.deliver({ type: "snapshot", command: session("cmd-1"), data: "ab", startOffset: 0, endOffset: 2 })
    // Each gap episode needs its snapshot to clear resyncPending; simulate a
    // server that keeps sending gaps by alternating gap + stale snapshot that
    // never advances (each cycle consumes one resync allowance).
    for (let i = 0; i < 5; i++) {
      sockets[0]!.deliver({ type: "output", commandID: "cmd-1", data: "XX", startOffset: 100 + i, endOffset: 102 + i })
      sockets[0]!.deliver({ type: "snapshot", command: session("cmd-1"), data: "ab", startOffset: 0, endOffset: 2 })
    }
    const subscribes = sentTypes(sockets[0]!).filter((t) => t === "subscribe").length
    // 1 initial + max 3 resyncs — bounded, never 1-per-gap forever.
    expect(subscribes).toBe(1 + 3)
    expect(errors.some((e) => e.includes("resync-loop-guard"))).toBe(true)
    client.dispose()
  })
})
