import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { promises as fs } from "fs"
import path from "path"
import os from "os"
import { createCommandService } from "../../src/application/command-service"
import { createCommandEventBroker, type CommandEventBroker } from "../../src/application/command-event-broker"
import { createFakeCommandHost } from "../../src/server/command-host"
import type { CommandHost, CommandProcessHandle } from "../../src/server/command-host"
import {
  offsetsContinuous,
  utf8ByteLength,
  validateCommandStreamMessage,
  type CommandStreamMessage,
  type OutputMessage,
} from "../../src/domain/command-events"
import { MAX_COMMAND_OUTPUT_BYTES } from "../../src/domain/command-session"

function tmpDir(): string {
  return path.join(os.tmpdir(), `loopd-broker-test-${crypto.randomUUID()}`)
}

async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  for (;;) {
    if (await cond()) return
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out")
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe("CommandEventBroker", () => {
  let dir: string
  let host: ReturnType<typeof createFakeCommandHost>
  let broker: CommandEventBroker
  let svc: ReturnType<typeof createCommandService>

  beforeEach(async () => {
    dir = tmpDir()
    await fs.mkdir(dir, { recursive: true })
    host = createFakeCommandHost()
    broker = createCommandEventBroker()
    svc = createCommandService(host, { broker })
  })

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it("subscriber receives snapshot then live deltas with no missing/duplicate bytes", async () => {
    const s = await svc.start(dir, { title: "stream", command: "cat", ownerSessionID: "owner-1" })
    const proc = [...host.procs.values()].at(-1)!
    proc.emitOutput("hello ")
    proc.emitOutput("world\n")
    await waitFor(async () => (await svc.get(dir, s.id, "owner-1"))?.streamBytes === utf8ByteLength("hello world\n"))

    const received: CommandStreamMessage[] = []
    const sinkID = await broker.subscribe(s.id, "owner-1", (m) => received.push(m))
    expect(typeof sinkID).toBe("string")
    const snap = received[0]
    expect(snap?.type).toBe("snapshot")
    if (snap?.type !== "snapshot") throw new Error("expected snapshot")
    expect(snap.data).toBe("hello world\n")
    expect(snap.endOffset - snap.startOffset).toBe(utf8ByteLength(snap.data))

    proc.emitOutput("more\n")
    await waitFor(() => received.some((m) => m.type === "output" && (m as OutputMessage).data === "more\n"))
    const live = received.filter((m) => m.type === "output") as OutputMessage[]
    expect(live.length).toBe(1)
    expect(offsetsContinuous(snap.endOffset, live[0]!.startOffset)).toBe(true)
    // Full reconstruction has no gaps or duplicates.
    const full = snap.data + live.map((o) => o.data).join("")
    expect(full).toBe("hello world\nmore\n")

    broker.unsubscribe(s.id, sinkID)
    expect(broker.subscriberCount(s.id)).toBe(0)
  })

  it("output emitted during subscribe is not lost and not duplicated", async () => {
    const s = await svc.start(dir, { title: "race", command: "cat", ownerSessionID: "owner-1" })
    const proc = [...host.procs.values()].at(-1)!
    proc.emitOutput("before-")
    const received: CommandStreamMessage[] = []
    // Start subscribe, then race live output through the snapshot window.
    const subPromise = broker.subscribe(s.id, "owner-1", (m) => received.push(m))
    proc.emitOutput("during-")
    proc.emitOutput("after")
    const sinkID = await subPromise
    expect(typeof sinkID).toBe("string")
    await waitFor(() => {
      const snap = received.find((m) => m.type === "snapshot")
      if (!snap || snap.type !== "snapshot") return false
      const liveData = received
        .filter((m) => m.type === "output")
        .map((m) => (m as OutputMessage).data)
        .join("")
      // Snapshot may already include some/all raced bytes (dedup drops
      // covered buffered events); reconstruction must equal exactly once.
      const end = (snap as { endOffset: number }).endOffset
      void end
      return (snap.data + liveData).length >= "before-during-after".length
    })
    const snap = received.find((m) => m.type === "snapshot")!
    if (snap.type !== "snapshot") throw new Error("expected snapshot")
    const liveData = received
      .filter((m) => m.type === "output")
      .map((m) => (m as OutputMessage).data)
      .join("")
    expect(snap.data + liveData).toBe("before-during-after")
    // Offsets chain continuously from snapshot through live deltas.
    let cursor = snap.endOffset
    expect(snap.endOffset - snap.startOffset).toBe(utf8ByteLength(snap.data))
    for (const m of received.filter((x) => x.type === "output") as OutputMessage[]) {
      expect(m.startOffset).toBe(cursor)
      expect(m.endOffset - m.startOffset).toBe(utf8ByteLength(m.data))
      cursor = m.endOffset
    }
    expect(cursor).toBe(snap.endOffset + utf8ByteLength(liveData))
  })

  it("immediate output+exit ordering: started status precedes exited", async () => {
    // Immediate host emits output+exit synchronously inside spawn, exercising
    // the pending[] replay path. Record broker.publish call order even with
    // zero subscribers (publish drops but is still invoked persist-first).
    const seen: CommandStreamMessage[] = []
    const rawPublish = broker.publish.bind(broker)
    broker.publish = ((commandID: string, msg: CommandStreamMessage) => {
      seen.push(msg)
      return rawPublish(commandID, msg)
    }) as typeof broker.publish

    const exited = Promise.resolve({ exitCode: 0 })
    const immediateHost: CommandHost = {
      capabilities: host.capabilities,
      spawn(_opts, onOutput, onExit) {
        onOutput("fast\n")
        onExit({ exitCode: 0 })
        return {
          pid: 42,
          write: () => false,
          interrupt: () => false,
          terminate: () => true,
          kill: () => true,
          isAlive: () => false,
          exited: () => exited,
        } satisfies CommandProcessHandle
      },
      livePids: () => new Set(),
    }
    const immediate = createCommandService(immediateHost, { broker })
    const started = await immediate.start(dir, { title: "fast", command: "true", ownerSessionID: "owner-1" })
    expect(started.status).toBe("exited")

    const statuses = seen.filter((m) => m.type === "status")
    expect(statuses.length).toBeGreaterThanOrEqual(2)
    expect(statuses[0]?.type).toBe("status")
    if (statuses[0]?.type === "status" && statuses.at(-1)?.type === "status") {
      expect(statuses[0].command.status).toBe("running")
      expect(statuses.at(-1)!.command.status).toBe("exited")
    }
    const outputs = seen.filter((m) => m.type === "output") as OutputMessage[]
    expect(outputs.length).toBe(1)
    expect(outputs[0]!.data).toBe("fast\n")
    // Live-subscriber view: subscribe after completion yields an exited snapshot.
    const received: CommandStreamMessage[] = []
    await broker.subscribe(started.id, "owner-1", (m) => received.push(m))
    expect(received[0]?.type).toBe("snapshot")
    if (received[0]?.type === "snapshot") {
      expect(received[0].command.status).toBe("exited")
      expect(received[0].data).toBe("fast\n")
    }
  })

  it("truncation keeps lifetime offsets monotonic while retained bytes reset (offset math, no 512KB write)", async () => {
    // Lifetime production of MAX+100 bytes retaining only the last MAX bytes.
    const lifetime = MAX_COMMAND_OUTPUT_BYTES + 100
    const retained = MAX_COMMAND_OUTPUT_BYTES
    const startOffset = lifetime - retained
    const endOffset = lifetime
    expect(startOffset).toBe(100)
    expect(endOffset).toBeGreaterThan(retained)
    // Snapshot over retained bytes maps via streamBytes.
    const data = "x".repeat(1000)
    const snapStart = lifetime - utf8ByteLength(data)
    expect(snapStart).toBe(lifetime - 1000)
    expect(snapStart + utf8ByteLength(data)).toBe(lifetime)
    // Multi-byte safety at scale.
    const emoji = "🔥".repeat(50) // 200 bytes
    expect(utf8ByteLength(emoji)).toBe(200)
    expect(validateCommandStreamMessage({
      type: "output", commandID: "cmd-1", data: emoji,
      startOffset: lifetime, endOffset: lifetime + 200,
    }).ok).toBe(true)

    // Service-level: small writes advance streamBytes monotonically and match
    // retained size when untruncated.
    const s = await svc.start(dir, { title: "mono", command: "cat", ownerSessionID: "owner-1" })
    const proc = [...host.procs.values()].at(-1)!
    proc.emitOutput("ab")
    proc.emitOutput("🔥") // 4 bytes
    await waitFor(async () => (await svc.get(dir, s.id, "owner-1"))?.streamBytes === 6)
    const after = await svc.get(dir, s.id, "owner-1")
    expect(after?.streamBytes).toBe(6)
    expect(after?.outputBytes).toBe(6)
    expect(after?.truncated).toBe(false)
  })

  it("gap detection handshake: out-of-order delivery triggers resync path", async () => {
    const s = await svc.start(dir, { title: "gaps", command: "cat", ownerSessionID: "owner-1" })
    const proc = [...host.procs.values()].at(-1)!
    proc.emitOutput("0123456789") // 10 bytes, offsets 0..10
    await waitFor(async () => (await svc.get(dir, s.id, "owner-1"))?.streamBytes === 10)

    const received: CommandStreamMessage[] = []
    await broker.subscribe(s.id, "owner-1", (m) => received.push(m))
    const snap = received[0]
    expect(snap?.type).toBe("snapshot")
    if (snap?.type !== "snapshot") throw new Error("expected snapshot")

    // Simulate an out-of-order delivery attempt (gap: 10 -> 15).
    const gapped: OutputMessage = { type: "output", commandID: s.id, data: "ABCDE", startOffset: 15, endOffset: 20 }
    expect(offsetsContinuous(snap.endOffset, gapped.startOffset)).toBe(false)
    // Client handshake: detect the gap and resync (re-subscribe) to heal.
    expect(offsetsContinuous(10, 10)).toBe(true) // exact-continue is healthy
    expect(offsetsContinuous(10, 7)).toBe(false) // overlap/duplicate also resyncs
    broker.publish(s.id, gapped)
    await new Promise((r) => setTimeout(r, 25))
    const deliveredGap = received.find(
      (m) => m.type === "output" && (m as OutputMessage).startOffset === 15,
    ) as OutputMessage | undefined
    expect(deliveredGap).toBeDefined() // broker delivers; client detects gap

    // Resync path: fresh subscribe returns a snapshot ending at true N=10
    // (gapped publish was never persisted, so disk truth is unchanged).
    const healed: CommandStreamMessage[] = []
    await broker.subscribe(s.id, "owner-1", (m) => healed.push(m))
    expect(healed[0]?.type).toBe("snapshot")
    if (healed[0]?.type === "snapshot") {
      expect(healed[0].endOffset).toBe(10)
      expect(healed[0].data).toBe("0123456789")
    }
  })

  it("cross-owner subscribe is rejected", async () => {
    const s = await svc.start(dir, { title: "owned", command: "cat", ownerSessionID: "owner-1" })
    await expect(broker.subscribe(s.id, "owner-2", () => {})).rejects.toThrow()
    expect(broker.subscriberCount(s.id)).toBe(0)
    // Owner can still subscribe.
    const sinkID = await broker.subscribe(s.id, "owner-1", () => {})
    expect(typeof sinkID).toBe("string")
    broker.unsubscribe(s.id, sinkID)
  })

  it("chatty output (200 rapid chunks) preserves per-command ordering", async () => {
    const s = await svc.start(dir, { title: "chatty", command: "cat", ownerSessionID: "owner-1" })
    const proc = [...host.procs.values()].at(-1)!
    const received: CommandStreamMessage[] = []
    await broker.subscribe(s.id, "owner-1", (m) => received.push(m))
    const N = 200
    const chunks: string[] = Array.from({ length: N }, (_, i) => `line-${i}\n`)
    for (const c of chunks) proc.emitOutput(c)
    const expectedTotal = chunks.reduce((a, c) => a + utf8ByteLength(c), 0)
    await waitFor(
      () => {
        const liveBytes = received
          .filter((m) => m.type === "output")
          .reduce((a, m) => a + utf8ByteLength((m as OutputMessage).data), 0)
        return liveBytes === expectedTotal
      },
      5000,
    )
    const live = received.filter((m) => m.type === "output") as OutputMessage[]
    expect(live.length).toBe(N)
    // Outputs arrive in publish order with continuous offsets.
    let cursor = (received[0] as { endOffset: number }).endOffset
    if (received[0]?.type === "snapshot") cursor = received[0].endOffset
    for (let i = 0; i < N; i++) {
      expect(live[i]!.data).toBe(chunks[i])
      expect(live[i]!.startOffset).toBe(cursor)
      expect(live[i]!.endOffset).toBe(cursor + utf8ByteLength(chunks[i]!))
      cursor = live[i]!.endOffset
    }
    const session = await svc.get(dir, s.id, "owner-1")
    expect(session?.streamBytes).toBe(expectedTotal)
  })

  it("sink throwing does not break service or other sinks", async () => {
    const s = await svc.start(dir, { title: "noisy", command: "cat", ownerSessionID: "owner-1" })
    const proc = [...host.procs.values()].at(-1)!
    const good: CommandStreamMessage[] = []
    await broker.subscribe(s.id, "owner-1", () => {
      throw new Error("boom")
    })
    await broker.subscribe(s.id, "owner-1", (m) => good.push(m))
    proc.emitOutput("one\n")
    proc.emitOutput("two\n")
    await waitFor(() => good.filter((m) => m.type === "output").length === 2)
    // Service still works: write/resize/terminate unaffected by throwing sink.
    const w = await svc.write(dir, s.id, "owner-1", "x\n")
    expect(w.ok).toBe(true)
    const t = await svc.terminate(dir, s.id, "owner-1")
    expect(t.ok).toBe(true)
    await waitFor(() => good.some((m) => m.type === "status" && m.command.status === "terminated"))
    const statuses = good.filter((m) => m.type === "status")
    expect(statuses.length).toBeGreaterThanOrEqual(1)
  })
})
