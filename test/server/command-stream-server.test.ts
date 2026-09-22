import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { promises as fs } from "fs"
import path from "path"
import os from "os"
import { createCommandService } from "../../src/application/command-service"
import { createCommandEventBroker, type CommandEventBroker } from "../../src/application/command-event-broker"
import { createFakeCommandHost } from "../../src/server/command-host"
import {
  createCommandStreamServer,
  streamEndpointPath,
  type CommandStreamEndpoint,
  type CommandStreamServer,
} from "../../src/server/command-stream-server"
import {
  offsetsContinuous,
  utf8ByteLength,
  type OutputMessage,
} from "../../src/domain/command-events"

function tmpDir(): string {
  return path.join(os.tmpdir(), `loopd-stream-test-${crypto.randomUUID()}`)
}

async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const start = Date.now()
  for (;;) {
    if (await cond()) return
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out")
    await new Promise((r) => setTimeout(r, 10))
  }
}

class TestSocket {
  ws!: WebSocket
  received: any[] = []
  closed = false
  private constructor() {}

  static connect(url: string, timeoutMs = 5000): Promise<TestSocket> {
    return new Promise((resolve, reject) => {
      const t = new TestSocket()
      let settled = false
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true
          try {
            t.ws?.close()
          } catch {}
          reject(new Error(`connect timeout: ${url}`))
        }
      }, timeoutMs)
      const ws = new WebSocket(url)
      t.ws = ws
      ws.onopen = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        ws.onerror = () => {}
        resolve(t)
      }
      ws.onerror = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(new Error("connect error"))
      }
      ws.onclose = () => {
        t.closed = true
      }
      ws.onmessage = (ev) => {
        try {
          t.received.push(JSON.parse(String(ev.data)))
        } catch {}
      }
    })
  }

  send(obj: unknown): void {
    this.ws.send(JSON.stringify(obj))
  }

  async waitForMessage(pred: (m: any) => boolean, timeoutMs = 5000): Promise<any> {
    const start = Date.now()
    for (;;) {
      const found = this.received.find(pred)
      if (found) return found
      if (Date.now() - start > timeoutMs) {
        throw new Error(`waitForMessage timed out; received: ${JSON.stringify(this.received).slice(0, 500)}`)
      }
      await new Promise((r) => setTimeout(r, 10))
    }
  }

  close(): void {
    try {
      this.ws.close()
    } catch {}
  }
}

async function expectConnectFails(url: string): Promise<void> {
  let opened = false
  let failed = false
  await new Promise<void>((resolve) => {
    let settled = false
    const done = () => {
      if (!settled) {
        settled = true
        resolve()
      }
    }
    const timer = setTimeout(done, 3000)
    void timer
    let ws: WebSocket
    try {
      ws = new WebSocket(url)
    } catch {
      failed = true
      done()
      return
    }
    ws.onopen = () => {
      opened = true
      try {
        ws.close()
      } catch {}
      done()
    }
    ws.onerror = () => {
      failed = true
      done()
    }
    ws.onclose = () => {
      // Refused upgrade surfaces as error and/or close without open.
      if (!opened) failed = true
      done()
    }
  })
  expect(opened).toBe(false)
  expect(failed).toBe(true)
}

describe("CommandStreamServer", () => {
  let dir: string
  let host: ReturnType<typeof createFakeCommandHost>
  let broker: CommandEventBroker
  let svc: ReturnType<typeof createCommandService>
  let server: CommandStreamServer | undefined
  const sockets: TestSocket[] = []

  beforeEach(async () => {
    dir = tmpDir()
    await fs.mkdir(dir, { recursive: true })
    host = createFakeCommandHost()
    broker = createCommandEventBroker()
    svc = createCommandService(host, { broker })
    server = createCommandStreamServer(dir, svc, broker)
    await server.start()
  })

  afterEach(async () => {
    for (const s of sockets.splice(0)) {
      try {
        s.close()
      } catch {}
    }
    try {
      await server?.stop()
    } catch {}
    server = undefined
    await fs.rm(dir, { recursive: true, force: true })
  })

  async function endpoint(): Promise<CommandStreamEndpoint> {
    const text = await fs.readFile(streamEndpointPath(dir), "utf8")
    return JSON.parse(text) as CommandStreamEndpoint
  }

  async function connect(): Promise<TestSocket> {
    const ep = await endpoint()
    const s = await TestSocket.connect(ep.url)
    sockets.push(s)
    return s
  }

  it("rejects wrong/missing token", async () => {
    const ep = await endpoint()
    expect(ep.token.length).toBeGreaterThanOrEqual(32)
    const base = ep.url.split("?")[0]!
    await expectConnectFails(base) // missing token
    await expectConnectFails(`${base}?token=wrong-token`) // wrong token
    // Sanity: the real token connects.
    const ok = await TestSocket.connect(ep.url)
    sockets.push(ok)
    ok.close()
  })

  it("subscribe yields snapshot with absolute offsets, then live deltas with no gaps/duplicates", async () => {
    const s = await svc.start(dir, { title: "stream", command: "cat", ownerSessionID: "owner-1" })
    const proc = [...host.procs.values()].at(-1)!
    proc.emitOutput("hello ")
    proc.emitOutput("world\n")
    const total = utf8ByteLength("hello world\n")
    await waitFor(async () => (await svc.get(dir, s.id, "owner-1"))?.streamBytes === total)

    const sock = await connect()
    sock.send({ type: "subscribe", commandID: s.id, ownerSessionID: "owner-1" })
    const snap = await sock.waitForMessage((m) => m.type === "snapshot")
    expect(snap.data).toBe("hello world\n")
    expect(snap.startOffset).toBe(0)
    expect(snap.endOffset).toBe(total)
    expect(snap.endOffset - snap.startOffset).toBe(utf8ByteLength(snap.data))

    proc.emitOutput("more\n")
    const live = (await sock.waitForMessage(
      (m) => m.type === "output" && m.data === "more\n",
    )) as OutputMessage
    expect(live.startOffset).toBe(snap.endOffset)
    expect(live.endOffset - live.startOffset).toBe(utf8ByteLength(live.data))
    expect(offsetsContinuous(snap.endOffset, live.startOffset)).toBe(true)

    const outputs = sock.received.filter((m) => m.type === "output") as OutputMessage[]
    const full = snap.data + outputs.map((o) => o.data).join("")
    expect(full).toBe("hello world\nmore\n")
    let cursor = snap.endOffset
    for (const o of outputs) {
      expect(o.startOffset).toBe(cursor)
      cursor = o.endOffset
    }
  })

  it("client-sent resync triggers a fresh snapshot", async () => {
    const s = await svc.start(dir, { title: "resync", command: "cat", ownerSessionID: "owner-1" })
    const proc = [...host.procs.values()].at(-1)!
    proc.emitOutput("one\n")
    await waitFor(async () => (await svc.get(dir, s.id, "owner-1"))?.streamBytes === utf8ByteLength("one\n"))

    const sock = await connect()
    sock.send({ type: "subscribe", commandID: s.id, ownerSessionID: "owner-1" })
    await sock.waitForMessage((m) => m.type === "snapshot")

    proc.emitOutput("two\n")
    await waitFor(async () => (await svc.get(dir, s.id, "owner-1"))?.streamBytes === utf8ByteLength("one\ntwo\n"))
    await sock.waitForMessage((m) => m.type === "output" && m.data === "two\n")

    sock.send({ type: "resync", commandID: s.id })
    await waitFor(() => sock.received.filter((m) => m.type === "snapshot").length >= 2)
    const snaps = sock.received.filter((m) => m.type === "snapshot")
    const fresh = snaps.at(-1)!
    expect(fresh.data).toBe("one\ntwo\n")
    expect(fresh.endOffset).toBe(utf8ByteLength("one\ntwo\n"))
    expect(fresh.endOffset - fresh.startOffset).toBe(utf8ByteLength(fresh.data))
  })

  it("cross-owner subscribe is rejected", async () => {
    const s = await svc.start(dir, { title: "owned", command: "cat", ownerSessionID: "owner-1" })
    const sock = await connect()
    sock.send({ type: "subscribe", commandID: s.id, ownerSessionID: "owner-2" })
    const err = await sock.waitForMessage((m) => m.type === "error")
    expect(String(err.code)).toMatch(/subscribe/i)
    expect(broker.subscriberCount(s.id)).toBe(0)
  })

  it("input message reaches process stdin", async () => {
    const s = await svc.start(dir, { title: "repl", command: "cat", ownerSessionID: "owner-1" })
    const proc = [...host.procs.values()].at(-1)!
    const sock = await connect()
    sock.send({ type: "subscribe", commandID: s.id, ownerSessionID: "owner-1" })
    await sock.waitForMessage((m) => m.type === "snapshot")
    sock.send({ type: "input", commandID: s.id, data: "hello\n" })
    await waitFor(() => proc.written.includes("hello\n"))
    expect(proc.written).toEqual(["hello\n"])
  })

  it("interrupt message delivers SIGINT", async () => {
    const s = await svc.start(dir, { title: "trap", command: "sh", ownerSessionID: "owner-1" })
    const proc = [...host.procs.values()].at(-1)!
    const sock = await connect()
    sock.send({ type: "subscribe", commandID: s.id, ownerSessionID: "owner-1" })
    await sock.waitForMessage((m) => m.type === "snapshot")
    sock.send({ type: "interrupt", commandID: s.id })
    await waitFor(() => proc.signals.includes("SIGINT"))
    expect(proc.signals).toEqual(["SIGINT"])
  })

  it("socket close removes subscriptions", async () => {
    const s = await svc.start(dir, { title: "close", command: "cat", ownerSessionID: "owner-1" })
    const sock = await connect()
    sock.send({ type: "subscribe", commandID: s.id, ownerSessionID: "owner-1" })
    await sock.waitForMessage((m) => m.type === "snapshot")
    expect(broker.subscriberCount(s.id)).toBe(1)
    sock.close()
    await waitFor(() => broker.subscriberCount(s.id) === 0)
  })

  it("dispose removes the endpoint file and refuses new connects", async () => {
    const ep = await endpoint()
    const url = ep.url
    // Sanity: connects before dispose.
    const sock = await TestSocket.connect(url)
    sockets.push(sock)
    sock.close()
    await server!.stop()
    // Endpoint file is gone.
    await expect(fs.access(streamEndpointPath(dir))).rejects.toThrow()
    // New connects are refused (server stopped).
    await expectConnectFails(url)
  })

  it("stale endpoint file (dead pid) is replaced on start", async () => {
    await server!.stop()
    server = undefined
    const stale = {
      url: "ws://127.0.0.1:9/stream?token=stale",
      token: "stale-token",
      pid: 2147483647, // dead pid — kill(pid, 0) throws ESRCH
      generation: "stale-generation",
      startedAt: new Date(0).toISOString(),
    }
    await fs.mkdir(path.dirname(streamEndpointPath(dir)), { recursive: true })
    await fs.writeFile(streamEndpointPath(dir), JSON.stringify(stale))
    const fresh = createCommandStreamServer(dir, svc, broker)
    server = fresh
    await fresh.start()
    const ep = await endpoint()
    expect(ep.generation).toBe(fresh.generation)
    expect(ep.pid).toBe(process.pid)
    expect(ep.url).not.toBe(stale.url)
    const stat = await fs.stat(streamEndpointPath(dir))
    expect(stat.mode & 0o777).toBe(0o600)
    // The fresh endpoint actually accepts connections.
    const sock = await TestSocket.connect(ep.url)
    sockets.push(sock)
    sock.close()
  })
})
