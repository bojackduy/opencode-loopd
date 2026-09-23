import { describe, expect, it } from "bun:test"
import { createTerminalSession, type TerminalSessionOptions } from "../../src/tui/terminal-session"
import { utf8ByteLength } from "../../src/domain/command-events"
import type { CommandStreamClient, StreamHandlers } from "../../src/tui/command-stream-client"
import { createCommandSession } from "../../src/domain/command-session"

function ownedCmd(overrides: Record<string, unknown> = {}) {
  return {
    ...createCommandSession({ id: "cmd-1", title: "repl", command: "sh", cwd: "/tmp", ownerSessionID: "owner-1" }),
    ...overrides,
  }
}

interface StreamStub {
  client: CommandStreamClient
  handlers: Map<string, StreamHandlers>
  subscribed: Array<{ commandID: string; owner: string }>
  unsubscribed: string[]
  inputs: Array<{ commandID: string; data: string }>
  interrupts: string[]
  live: Set<string>
  connectResult: { ok: true } | { ok: false; reason: string }
}

function makeStreamStub(): StreamStub {
  const stub: StreamStub = {
    handlers: new Map(),
    subscribed: [],
    unsubscribed: [],
    inputs: [],
    interrupts: [],
    live: new Set(),
    connectResult: { ok: true },
    client: undefined as unknown as CommandStreamClient,
  }
  stub.client = {
    get connectionState() {
      return "connected"
    },
    connect: async () => stub.connectResult,
    subscribe: (commandID, ownerSessionID, handlers = {}) => {
      stub.subscribed.push({ commandID, owner: ownerSessionID })
      stub.handlers.set(commandID, handlers)
      return { ok: true }
    },
    unsubscribe: (commandID) => {
      stub.unsubscribed.push(commandID)
      stub.handlers.delete(commandID)
      stub.live.delete(commandID)
    },
    sendInput: (commandID, data) => {
      if (!stub.live.has(commandID)) return { ok: false, reason: "not-subscribed" }
      stub.inputs.push({ commandID, data })
      return { ok: true }
    },
    sendInterrupt: (commandID) => {
      if (!stub.live.has(commandID)) return { ok: false, reason: "not-subscribed" }
      stub.interrupts.push(commandID)
      return { ok: true }
    },
    isLive: (commandID) => stub.live.has(commandID),
    disconnect: () => {},
    dispose: () => {},
  }
  return stub
}

interface ControlStub {
  calls: Array<{ command: string; goalID?: string; args?: Record<string, unknown> }>
  client: {
    executeRaw: (cmd: { command: string; goalID?: string; args?: Record<string, unknown> }) => Promise<{ ok: boolean; message: string }>
  }
}

function makeControlStub(): ControlStub {
  const stub: ControlStub = {
    calls: [],
    client: undefined as unknown as ControlStub["client"],
  }
  stub.client = {
    executeRaw: async (cmd) => {
      stub.calls.push(cmd)
      return { ok: true, message: "ok" }
    },
  }
  return stub
}

function baseOptions(overrides: Partial<TerminalSessionOptions> = {}): TerminalSessionOptions {
  const stream = makeStreamStub()
  const control = makeControlStub()
  return {
    directory: "/tmp/loopd-terminal-session-test",
    // Realistic dashboard flow: owner and return session are the same
    // trusted current session (owner/return mismatch fails closed).
    routeData: { commandID: "cmd-1", ownerSessionID: "owner-1", returnSessionID: "owner-1" },
    createStreamClient: () => stream.client,
    createControl: () => control.client as never,
    readStateFn: async () => ({ commands: [ownedCmd()], goals: [], runtimes: [], events: [] }) as never,
    readLogFn: async () => ({ text: "", startByte: 0 }),
    pollIntervalMs: 60_000, // no background polls during assertions unless asked
    resizeDebounceMs: 10,
    ...overrides,
  }
}

describe("terminal-session", () => {
  it("invalid route data renders safely and never subscribes or writes", async () => {
    const stream = makeStreamStub()
    const control = makeControlStub()
    const session = createTerminalSession({
      ...baseOptions(),
      routeData: { commandID: "", ownerSessionID: "owner-1" },
      createStreamClient: () => stream.client,
      createControl: () => control.client as never,
    })
    await session.start()
    expect(session.invalidReason).toBeString()
    expect(stream.subscribed).toEqual([])
    session.writeInput("x")
    session.paste("y")
    session.interrupt()
    expect(control.calls).toEqual([])
    expect(session.readView().invalid).toBeString()
    session.dispose()
  })

  it("missing command never subscribes", async () => {
    const stream = makeStreamStub()
    const session = createTerminalSession({
      ...baseOptions(),
      createStreamClient: () => stream.client,
      readStateFn: async () => ({ commands: [], goals: [], runtimes: [], events: [] }) as never,
    })
    await session.start()
    expect(stream.subscribed).toEqual([])
    expect(session.readView().connection).toBe("error")
    session.dispose()
  })

  it("cross-owner pre-check never subscribes or writes", async () => {
    const stream = makeStreamStub()
    const control = makeControlStub()
    const session = createTerminalSession({
      ...baseOptions(),
      createStreamClient: () => stream.client,
      createControl: () => control.client as never,
      readStateFn: async () => ({ commands: [ownedCmd({ ownerSessionID: "owner-2" })], goals: [], runtimes: [], events: [] }) as never,
    })
    await session.start()
    expect(stream.subscribed).toEqual([])
    session.writeInput("x")
    expect(control.calls).toEqual([])
    expect(session.readView().connectionDetail).toMatch(/not owned/)
    session.dispose()
  })

  it("snapshot applies rows; delta appends; status updates liveness", async () => {
    const stream = makeStreamStub()
    const session = createTerminalSession({ ...baseOptions(), createStreamClient: () => stream.client })
    const seen: string[] = []
    void seen
    await session.start()
    expect(stream.subscribed).toEqual([{ commandID: "cmd-1", owner: "owner-1" }])
    const h = stream.handlers.get("cmd-1")!
    // Pre-snapshot: not live.
    expect(session.readView().connection).toBe("polling")
    h.onSnapshot!({ command: ownedCmd() as never, data: "hello", startOffset: 0, endOffset: 5 })
    stream.live.add("cmd-1")
    await new Promise((r) => setTimeout(r, 200))
    let view = session.readView()
    expect(view.connection).toBe("stream")
    expect(view.command?.title).toBe("repl")
    h.onDelta!({ commandID: "cmd-1", data: " world", startOffset: 5, endOffset: 11 })
    await new Promise((r) => setTimeout(r, 200))
    view = session.readView()
    const firstRow = view.rows.slice(0, view.cols).map((c) => c.text).join("")
    expect(firstRow).toBe("hello world".padEnd(view.cols, " "))
    expect(view.totalBytes).toBe(11)
    h.onStatus!(ownedCmd({ status: "exited", exitCode: 0 }) as never)
    await new Promise((r) => setTimeout(r, 200))
    expect(session.readView().live).toBe(false)
    session.dispose()
  })

  it("cross-owner snapshot unsubscribes and blocks writes", async () => {
    const stream = makeStreamStub()
    const control = makeControlStub()
    const session = createTerminalSession({
      ...baseOptions(),
      createStreamClient: () => stream.client,
      createControl: () => control.client as never,
    })
    await session.start()
    const h = stream.handlers.get("cmd-1")!
    h.onSnapshot!({ command: ownedCmd({ ownerSessionID: "intruder" }) as never, data: "x", startOffset: 0, endOffset: 1 })
    await new Promise((r) => setTimeout(r, 50))
    expect(stream.unsubscribed).toContain("cmd-1")
    expect(session.readView().connection).toBe("error")
    session.writeInput("x")
    expect(control.calls).toEqual([])
    session.dispose()
  })

  it("pre-live input falls back to the control bus (never double-sends)", async () => {
    const stream = makeStreamStub()
    const control = makeControlStub()
    const session = createTerminalSession({
      ...baseOptions(),
      createStreamClient: () => stream.client,
      createControl: () => control.client as never,
    })
    await session.start()
    session.writeInput("ls\n") // stream not live (no snapshot) → bus
    expect(control.calls.map((c) => c.command)).toEqual(["cmd_write"])
    expect(control.calls[0]!.args).toMatchObject({ commandID: "cmd-1", input: "ls\n", ownerSessionID: "owner-1" })
    expect(stream.inputs).toEqual([])
    session.interrupt()
    expect(control.calls.map((c) => c.command)).toEqual(["cmd_write", "cmd_interrupt"])
    session.dispose()
  })

  it("live input prefers the stream; paste forwards raw bytes immediately", async () => {
    const stream = makeStreamStub()
    const control = makeControlStub()
    const session = createTerminalSession({
      ...baseOptions(),
      createStreamClient: () => stream.client,
      createControl: () => control.client as never,
    })
    await session.start()
    stream.handlers.get("cmd-1")!.onSnapshot!({ command: ownedCmd() as never, data: "", startOffset: 0, endOffset: 0 })
    stream.live.add("cmd-1")
    session.writeInput("a")
    expect(stream.inputs).toEqual([{ commandID: "cmd-1", data: "a" }])
    expect(control.calls).toEqual([])
    session.paste("pasted\nbytes")
    expect(stream.inputs).toEqual([
      { commandID: "cmd-1", data: "a" },
      { commandID: "cmd-1", data: "pasted\nbytes" },
    ])
    session.dispose()
  })

  it("snapshot-timeout surfaces polling fallback (route stays usable)", async () => {
    const stream = makeStreamStub()
    const session = createTerminalSession({ ...baseOptions(), createStreamClient: () => stream.client })
    await session.start()
    stream.handlers.get("cmd-1")!.onError!("snapshot-timeout: no snapshot for cmd-1 within 8000ms — using polling fallback")
    await new Promise((r) => setTimeout(r, 200))
    const view = session.readView()
    expect(view.connection).toBe("polling")
    expect(view.connectionDetail).toMatch(/polling fallback/)
    session.dispose()
  })

  it("viewport resize debounces and resizes emulator + real PTY", async () => {
    const stream = makeStreamStub()
    const control = makeControlStub()
    const session = createTerminalSession({
      ...baseOptions(),
      createStreamClient: () => stream.client,
      createControl: () => control.client as never,
      resizeDebounceMs: 10,
    })
    await session.start()
    expect(session.appliedSize).toEqual({ cols: 80, rows: 24 })
    session.requestViewportSize(100, 30)
    session.requestViewportSize(120, 40) // collapses into one send
    await new Promise((r) => setTimeout(r, 60))
    expect(session.appliedSize).toEqual({ cols: 120, rows: 40 })
    const resizes = control.calls.filter((c) => c.command === "cmd_resize")
    expect(resizes.length).toBe(1)
    expect(resizes[0]!.args).toMatchObject({ cols: 120, rows: 40 })
    const view = session.readView()
    expect(view.cols).toBe(120)
    expect(view.viewportRows).toBe(40)
    session.dispose()
  })

  it("detach unsubscribes and fires onDetach without terminating", async () => {
    const stream = makeStreamStub()
    const control = makeControlStub()
    let detached = 0
    const session = createTerminalSession({
      ...baseOptions(),
      createStreamClient: () => stream.client,
      createControl: () => control.client as never,
      onDetach: () => {
        detached += 1
      },
    })
    await session.start()
    stream.handlers.get("cmd-1")!.onSnapshot!({ command: ownedCmd() as never, data: "x", startOffset: 0, endOffset: 1 })
    stream.live.add("cmd-1")
    session.detach()
    expect(stream.unsubscribed).toContain("cmd-1")
    expect(detached).toBe(1)
    expect(control.calls.map((c) => c.command)).not.toContain("cmd_terminate")
    // Post-detach input is a no-op (resources gone, command untouched).
    session.writeInput("x")
    expect(control.calls.map((c) => c.command)).not.toContain("cmd_write")
    session.dispose()
  })

  it("computeViewportSize is tested separately", async () => {
    const { computeViewportSize } = await import("../../src/tui/terminal-session")
    expect(computeViewportSize(120, 40, 0)).toEqual({ cols: 120, rows: 40 })
    expect(computeViewportSize(120.9, 40.9, 5)).toEqual({ cols: 120, rows: 35 })
    expect(computeViewportSize(0, 40, 0)).toBeUndefined()
    expect(computeViewportSize(80, 3, 5)).toBeUndefined()
  })

  it("owner/return mismatch fails closed: never subscribes or writes", async () => {
    const stream = makeStreamStub()
    const control = makeControlStub()
    const session = createTerminalSession({
      ...baseOptions(),
      routeData: { commandID: "cmd-1", ownerSessionID: "owner-1", returnSessionID: "ses-other" },
      createStreamClient: () => stream.client,
      createControl: () => control.client as never,
    })
    await session.start()
    expect(session.invalidReason).toBe("owner-return-mismatch")
    expect(stream.subscribed).toEqual([])
    session.writeInput("x")
    session.paste("y")
    session.interrupt()
    expect(control.calls).toEqual([])
    const view = session.readView()
    expect(view.connection).toBe("error")
    expect(view.invalid).toBe("owner-return-mismatch")
    session.dispose()
  })

  it("truncated poll snapshot uses lifetime offsets so the next stream delta continues exactly", async () => {
    const stream = makeStreamStub()
    // Lifetime produced 10000 bytes; only the last 100 are retained.
    const truncated = ownedCmd({ outputBytes: 100, streamBytes: 10000, truncated: true })
    const retainedText = "x".repeat(100)
    const session = createTerminalSession({
      ...baseOptions(),
      createStreamClient: () => stream.client,
      readStateFn: async () => ({ commands: [truncated], goals: [], runtimes: [], events: [] }) as never,
      // Retained file window [0, 100) in file coordinates.
      readLogFn: async (_dir, _id, range) => ({ text: retainedText, startByte: 0 }),
    })
    await session.start()
    // Poll snapshot re-baselined to lifetime coordinates: [9900, 10000).
    await new Promise((r) => setTimeout(r, 300))
    expect(session.readView().totalBytes).toBe(10000)
    // The next live stream delta continues exactly — no re-baseline gap.
    stream.handlers.get("cmd-1")!.onSnapshot!({
      command: truncated as never,
      data: retainedText,
      startOffset: 9900,
      endOffset: 10000,
    })
    stream.live.add("cmd-1")
    stream.handlers.get("cmd-1")!.onDelta!({ commandID: "cmd-1", data: "!", startOffset: 10000, endOffset: 10001 })
    await new Promise((r) => setTimeout(r, 300))
    const view = session.readView()
    expect(view.totalBytes).toBe(10001)
    // The 100 retained bytes plus the appended delta, in grid order
    // (80-col wrap: row 0 holds 80 xs, row 1 holds 20 xs + "!").
    const gridText = view.rows
      .slice(0, 101)
      .map((c) => c.text)
      .join("")
    expect(gridText).toBe(`${retainedText}!`)
    session.dispose()
  })

  it("poll snapshot measures multi-byte payloads in UTF-8 bytes, not string length", async () => {
    const stream = makeStreamStub()
    const text = "héllo wörld ✓" // multi-byte chars: length 13, UTF-8 bytes 17
    expect(text.length).toBeLessThan(utf8ByteLength(text))
    const cmd = ownedCmd({ outputBytes: utf8ByteLength(text), streamBytes: utf8ByteLength(text) })
    const session = createTerminalSession({
      ...baseOptions(),
      createStreamClient: () => stream.client,
      readStateFn: async () => ({ commands: [cmd], goals: [], runtimes: [], events: [] }) as never,
      readLogFn: async () => ({ text, startByte: 0 }),
    })
    await session.start()
    await new Promise((r) => setTimeout(r, 300))
    // Lifetime end offset is byte-based, so a stream delta at totalBytes
    // continues exactly instead of overlapping by the char/byte difference.
    expect(session.readView().totalBytes).toBe(utf8ByteLength(text))
    session.dispose()
  })

  it("rapid snapshot+delta converges on the latest content", async () => {
    const stream = makeStreamStub()
    const session = createTerminalSession({ ...baseOptions(), createStreamClient: () => stream.client })
    await session.start()
    const h = stream.handlers.get("cmd-1")!
    h.onSnapshot!({ command: ownedCmd() as never, data: "v1-", startOffset: 0, endOffset: 3 })
    h.onDelta!({ commandID: "cmd-1", data: "v2", startOffset: 3, endOffset: 5 })
    h.onDelta!({ commandID: "cmd-1", data: "!", startOffset: 5, endOffset: 6 })
    await new Promise((r) => setTimeout(r, 400))
    const view = session.readView()
    const firstRow = view.rows.slice(0, view.cols).map((c) => c.text).join("")
    expect(firstRow.startsWith("v1-v2!")).toBe(true)
    expect(view.totalBytes).toBe(6)
    session.dispose()
  })
})
