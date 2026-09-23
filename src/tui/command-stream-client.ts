// ─── TUI: Command Stream Client (headless-testable) ──────────────────────────
// Event-driven primary path for command output. Polling remains the fallback.
// This module has no OpenCode TUI imports so bun test can exercise it with a
// fake socket. Transport/server/broker/PTY are untouched.
//
// Wire contract (see src/domain/command-events.ts + command-stream-server.ts):
//   client → server: subscribe {commandID, ownerSessionID}, unsubscribe,
//     input, interrupt, resync-equivalent (fresh subscribe handshake)
//   server → client: snapshot {command, data, startOffset, endOffset},
//     output {commandID, data, startOffset, endOffset},
//     status {command}, error {code, message}
// Subscription is live only after a valid snapshot/ack (isLive + input gated
// on hasSnapshot). Absent snapshot within snapshotTimeoutMs surfaces a
// polling-fallback error. Callbacks are fenced by connection generation so
// stale sockets cannot clear new state. Endpoint metadata is re-read on
// reconnect; pre-snapshot deltas are bounded and never applied.
// Offsets are absolute UTF-8 lifetime byte offsets; exact-continue appends,
// gap OR overlap triggers exactly one resync per episode (fresh subscribe).
// Resync-loop guard: per-subscription counter + cooldown.

import { promises as fs } from "fs"
import path from "path"
import { offsetsContinuous, validateCommandStreamMessage } from "../domain/command-events"
import type { CommandSession as CommandSessionShape } from "../domain/command-session"

export type StreamConnectionState = "connected" | "connecting" | "disconnected"

export interface StreamSnapshot {
  command: CommandSessionShape
  data: string
  startOffset: number
  endOffset: number
}

export interface StreamDelta {
  commandID: string
  data: string
  startOffset: number
  endOffset: number
}

export interface StreamHandlers {
  onSnapshot?: (snap: StreamSnapshot) => void
  onDelta?: (delta: StreamDelta) => void
  onStatus?: (command: CommandSessionShape) => void
  onError?: (message: string) => void
  onConnection?: (state: StreamConnectionState) => void
}

/** Minimal socket surface the client needs (fake-testable). */
export interface StreamSocket {
  send(data: string): void
  close(code?: number, reason?: string): void
  onopen: (() => void) | null
  onmessage: ((data: string) => void) | null
  onclose: ((code: number, reason: string) => void) | null
  onerror: ((err: unknown) => void) | null
}

export type StreamSocketFactory = (url: string) => StreamSocket

export type EndpointReader = (directory: string) => Promise<{ url: string } | undefined>

export interface CommandStreamClientOptions {
  readEndpoint?: EndpointReader
  createSocket?: StreamSocketFactory
  onConnection?: (state: StreamConnectionState) => void
  /** First reconnect delay (default 250ms). Override in tests. */
  initialBackoffMs?: number
  /** Reconnect delay cap (default 8000ms). */
  maxBackoffMs?: number
  /** Max resyncs per window before giving up (default 5). */
  maxResyncsPerWindow?: number
  /** Resync counting window (default 30_000ms). */
  resyncWindowMs?: number
  /** Snapshot wait before polling-fallback error (default 8000ms). */
  snapshotTimeoutMs?: number
  /** Max output frames held pre-snapshot before dropping (default 32). */
  maxPreSnapshotBuffered?: number
}

export type ConnectResult = { ok: true } | { ok: false; reason: string }
export type SendResult = { ok: true } | { ok: false; reason: string }

interface SubState {
  commandID: string
  ownerSessionID: string
  handlers: StreamHandlers
  /** Absolute end offset of the last applied bytes (undefined until snapshot). */
  endOffset: number | undefined
  startOffset: number | undefined
  /** True only after a valid snapshot/ack — gates isLive + input. */
  hasSnapshot: boolean
  /** True while a fresh-subscribe resync is in flight (snapshot pending). */
  resyncPending: boolean
  resyncTimes: number[]
  /** Pre-snapshot output frames seen (bounded; excess dropped, never applied). */
  preSnapshotDropped: number
  snapshotTimer: ReturnType<typeof setTimeout> | undefined
}

function defaultEndpointPath(directory: string): string {
  return path.join(directory, ".opencode", "loopd", "commands", ".stream-endpoint.json")
}

async function defaultReadEndpoint(directory: string): Promise<{ url: string } | undefined> {
  let text: string
  try {
    text = await fs.readFile(defaultEndpointPath(directory), "utf8")
  } catch {
    return undefined
  }
  try {
    const parsed = JSON.parse(text) as { url?: unknown }
    if (!parsed || typeof parsed.url !== "string" || parsed.url.length === 0) return undefined
    return { url: parsed.url }
  } catch {
    return undefined
  }
}

function defaultCreateSocket(url: string): StreamSocket {
  const ws = new WebSocket(url) as unknown as {
    send(data: string): void
    close(code?: number, reason?: string): void
    onopen: (() => void) | null
    onmessage: ((ev: { data: unknown }) => void) | null
    onclose: ((ev: { code: number; reason: string }) => void) | null
    onerror: ((err: unknown) => void) | null
  }
  const socket: StreamSocket = {
    send: (data) => ws.send(data),
    close: (code, reason) => ws.close(code, reason),
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
  }
  ws.onopen = () => socket.onopen?.()
  ws.onmessage = (ev) => socket.onmessage?.(String(ev.data))
  ws.onclose = (ev) => socket.onclose?.(ev.code, ev.reason)
  ws.onerror = (err) => socket.onerror?.(err)
  return socket
}

export interface CommandStreamClient {
  readonly connectionState: StreamConnectionState
  connect(directory: string): Promise<ConnectResult>
  subscribe(commandID: string, ownerSessionID: string, handlers?: StreamHandlers): SendResult
  unsubscribe(commandID: string): void
  sendInput(commandID: string, data: string): SendResult
  sendInterrupt(commandID: string): SendResult
  /** True when the socket is open and the command has an active subscription. */
  isLive(commandID: string): boolean
  disconnect(): void
  dispose(): void
}

export function createCommandStreamClient(options: CommandStreamClientOptions = {}): CommandStreamClient {
  const readEndpoint = options.readEndpoint ?? defaultReadEndpoint
  const createSocket = options.createSocket ?? defaultCreateSocket
  const initialBackoffMs = options.initialBackoffMs ?? 250
  const maxBackoffMs = options.maxBackoffMs ?? 8000
  const maxResyncsPerWindow = options.maxResyncsPerWindow ?? 5
  const resyncWindowMs = options.resyncWindowMs ?? 30_000
  const snapshotTimeoutMs = options.snapshotTimeoutMs ?? 8000
  const maxPreSnapshotBuffered = options.maxPreSnapshotBuffered ?? 32

  let state: StreamConnectionState = "disconnected"
  let directory = ""
  let endpointURL = ""
  let socket: StreamSocket | undefined
  /** Connection generation: stale-socket callbacks cannot clear new state. */
  let generation = 0
  let closedIntentionally = false
  let reconnectAttempt = 0
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined
  const subs = new Map<string, SubState>()

  function emitConnection(next: StreamConnectionState): void {
    if (state === next) return
    state = next
    try {
      options.onConnection?.(next)
    } catch {}
    for (const sub of subs.values()) {
      try {
        sub.handlers.onConnection?.(next)
      } catch {}
    }
  }

  function sendWire(msg: unknown): boolean {
    if (!socket || state !== "connected") return false
    try {
      socket.send(JSON.stringify(msg))
      return true
    } catch {
      return false
    }
  }

  function sendSubscribe(sub: SubState): boolean {
    return sendWire({ type: "subscribe", commandID: sub.commandID, ownerSessionID: sub.ownerSessionID })
  }

  function clearSnapshotTimer(sub: SubState): void {
    if (sub.snapshotTimer) {
      clearTimeout(sub.snapshotTimer)
      sub.snapshotTimer = undefined
    }
  }

  /** Arm the absent-snapshot timeout → polling-fallback signal. */
  function armSnapshotTimer(sub: SubState): void {
    clearSnapshotTimer(sub)
    if (sub.hasSnapshot) return
    sub.snapshotTimer = setTimeout(() => {
      sub.snapshotTimer = undefined
      if (sub.hasSnapshot || !subs.has(sub.commandID)) return
      sub.resyncPending = false
      try {
        sub.handlers.onError?.(
          `snapshot-timeout: no snapshot for ${sub.commandID} within ${snapshotTimeoutMs}ms — using polling fallback`,
        )
      } catch {}
    }, snapshotTimeoutMs)
    const t = sub.snapshotTimer as unknown as { unref?: () => void }
    try {
      t.unref?.()
    } catch {}
  }

  function pruneResyncTimes(sub: SubState, now: number): void {
    sub.resyncTimes = sub.resyncTimes.filter((t) => now - t < resyncWindowMs)
  }

  /** Request a fresh snapshot; guarded to one in-flight resync per episode. */
  function requestResync(sub: SubState, reason: string): void {
    if (sub.resyncPending) return
    const now = Date.now()
    pruneResyncTimes(sub, now)
    if (sub.resyncTimes.length >= maxResyncsPerWindow) {
      // Loop guard: persistent gap — stop spinning, surface once.
      try {
        sub.handlers.onError?.(`resync-loop-guard: giving up after ${sub.resyncTimes.length} resyncs (${reason})`)
      } catch {}
      return
    }
    sub.resyncTimes.push(now)
    sub.resyncPending = true
    if (!sendSubscribe(sub)) {
      // Socket not open — the pending flag clears on the next snapshot;
      // the resubscribe-on-open path below will deliver the handshake.
      return
    }
  }

  function handleMessage(raw: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return // fail-closed: ignore malformed frames
    }
    let validated: ReturnType<typeof validateCommandStreamMessage>
    try {
      validated = validateCommandStreamMessage(parsed)
    } catch {
      return
    }
    if (!validated.ok) return
    const msg = validated.message
    switch (msg.type) {
      case "snapshot": {
        const id = (msg.command as CommandSessionShape).id
        const sub = subs.get(id)
        if (!sub) return
        sub.startOffset = msg.startOffset
        sub.endOffset = msg.endOffset
        sub.resyncPending = false
        sub.hasSnapshot = true
        sub.preSnapshotDropped = 0
        clearSnapshotTimer(sub)
        try {
          sub.handlers.onSnapshot?.({
            command: msg.command as CommandSessionShape,
            data: msg.data,
            startOffset: msg.startOffset,
            endOffset: msg.endOffset,
          })
        } catch {}
        break
      }
      case "output": {
        const sub = subs.get(msg.commandID)
        if (!sub) return
        if (sub.endOffset === undefined || !sub.hasSnapshot) {
          // No baseline yet — bound pre-snapshot deltas (never apply), ask
          // once for a snapshot instead of guessing.
          sub.preSnapshotDropped += 1
          if (sub.preSnapshotDropped <= maxPreSnapshotBuffered) {
            requestResync(sub, "no-baseline")
          }
          return
        }
        if (offsetsContinuous(sub.endOffset, msg.startOffset)) {
          sub.endOffset = msg.endOffset
          try {
            sub.handlers.onDelta?.({
              commandID: msg.commandID,
              data: msg.data,
              startOffset: msg.startOffset,
              endOffset: msg.endOffset,
            })
          } catch {}
        } else {
          // Gap OR overlap: never append partial/duplicate bytes — resync.
          requestResync(sub, msg.startOffset > sub.endOffset ? "gap" : "overlap")
        }
        break
      }
      case "status": {
        const id = (msg.command as CommandSessionShape).id
        const sub = subs.get(id)
        if (!sub) return
        try {
          sub.handlers.onStatus?.(msg.command as CommandSessionShape)
        } catch {}
        break
      }
      case "error": {
        const text = `${msg.code}: ${msg.message}`
        for (const sub of subs.values()) {
          try {
            sub.handlers.onError?.(text)
          } catch {}
        }
        break
      }
      default:
        // subscribe/input/interrupt/resync are client→server only inbound —
        // never acted on.
        break
    }
  }

  function openSocket(): boolean {
    if (!endpointURL) return false
    closedIntentionally = false
    generation += 1
    const myGeneration = generation
    emitConnection("connecting")
    let next: StreamSocket
    try {
      next = createSocket(endpointURL)
    } catch {
      scheduleReconnect()
      return false
    }
    socket = next
    socket.onopen = () => {
      // Fence: a stale socket opening late must not clear newer state.
      if (myGeneration !== generation || socket !== next) return
      reconnectAttempt = 0
      emitConnection("connected")
      // Re-read endpoint metadata on reconnect (server may have restarted
      // with a new generation); the next reconnect tick picks it up.
      if (directory) {
        void readEndpoint(directory).then(
          (ep) => {
            if (myGeneration !== generation) return
            if (ep && typeof ep.url === "string" && ep.url.length > 0) endpointURL = ep.url
          },
          () => {},
        )
      }
      // Auto-resubscribe all prior subscriptions after (re)connect. Offsets
      // re-baseline: the fresh snapshot replaces, never appends.
      for (const sub of subs.values()) {
        sub.resyncPending = false
        sub.hasSnapshot = false
        sub.endOffset = undefined
        sub.startOffset = undefined
        sub.preSnapshotDropped = 0
        sendSubscribe(sub)
        armSnapshotTimer(sub)
      }
    }
    socket.onmessage = (data) => {
      if (myGeneration !== generation || socket !== next) return
      handleMessage(data)
    }
    socket.onclose = () => {
      // Fence: a stale socket closing must not tear down the new connection.
      if (myGeneration !== generation || socket !== next) return
      socket = undefined
      // Subscriptions go stale on close: liveness requires a fresh snapshot.
      for (const sub of subs.values()) {
        sub.hasSnapshot = false
        sub.endOffset = undefined
        sub.startOffset = undefined
        sub.resyncPending = false
        clearSnapshotTimer(sub)
      }
      if (closedIntentionally) {
        emitConnection("disconnected")
        return
      }
      emitConnection("disconnected")
      scheduleReconnect()
    }
    socket.onerror = () => {
      // Error frames are informational; the close handler drives reconnect.
    }
    return true
  }

  function scheduleReconnect(): void {
    if (closedIntentionally) return
    if (reconnectTimer) return // one pending reconnect at a time
    const delay = Math.min(initialBackoffMs * 2 ** reconnectAttempt, maxBackoffMs)
    reconnectAttempt += 1
    emitConnection("connecting")
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined
      if (closedIntentionally || !directory) return
      // Re-read endpoint metadata before reopening so a restarted server
      // (new generation/port) is picked up without a manual reconnect.
      void readEndpoint(directory).then(
        (ep) => {
          if (closedIntentionally || !directory) return
          if (ep && typeof ep.url === "string" && ep.url.length > 0) endpointURL = ep.url
          if (!endpointURL) {
            scheduleReconnect()
            return
          }
          openSocket()
        },
        () => {
          if (!endpointURL) {
            scheduleReconnect()
            return
          }
          openSocket()
        },
      )
    }, delay)
    // Don't hold the process open for reconnect backoff alone.
    const t = reconnectTimer as unknown as { unref?: () => void }
    try {
      t.unref?.()
    } catch {}
  }

  return {
    get connectionState() {
      return state
    },

    async connect(nextDirectory: string): Promise<ConnectResult> {
      directory = nextDirectory
      let endpoint: { url: string } | undefined
      try {
        endpoint = await readEndpoint(nextDirectory)
      } catch {
        return { ok: false, reason: "no-endpoint" }
      }
      if (!endpoint || typeof endpoint.url !== "string" || endpoint.url.length === 0) {
        // Server starts lazily — absent/unparseable endpoint is NORMAL.
        return { ok: false, reason: "no-endpoint" }
      }
      // Same endpoint already live — nothing to do.
      if (endpointURL === endpoint.url && socket && (state === "connected" || state === "connecting")) {
        return { ok: true }
      }
      try {
        socket?.close(1000, "reconnect")
      } catch {}
      socket = undefined
      if (reconnectTimer) {
        clearTimeout(reconnectTimer)
        reconnectTimer = undefined
      }
      reconnectAttempt = 0
      endpointURL = endpoint.url
      const opened = openSocket()
      if (!opened) return { ok: false, reason: "connect-failed" }
      return { ok: true }
    },

    subscribe(commandID: string, ownerSessionID: string, handlers: StreamHandlers = {}): SendResult {
      if (!commandID || !ownerSessionID) return { ok: false, reason: "owner-required" }
      let sub = subs.get(commandID)
      if (!sub) {
        sub = {
          commandID,
          ownerSessionID,
          handlers,
          endOffset: undefined,
          startOffset: undefined,
          hasSnapshot: false,
          resyncPending: false,
          resyncTimes: [],
          preSnapshotDropped: 0,
          snapshotTimer: undefined,
        }
        subs.set(commandID, sub)
      } else {
        sub.ownerSessionID = ownerSessionID
        sub.handlers = handlers
        // Fresh selection re-baselines offsets; the new snapshot replaces.
        sub.endOffset = undefined
        sub.startOffset = undefined
        sub.hasSnapshot = false
        sub.resyncPending = false
        sub.preSnapshotDropped = 0
        clearSnapshotTimer(sub)
      }
      if (!socket || state !== "connected") {
        // Recorded for auto-resubscribe on open; handshake goes out then.
        return { ok: true }
      }
      const sent = sendSubscribe(sub)
      if (sent) armSnapshotTimer(sub)
      return sent ? { ok: true } : { ok: false, reason: "send-failed" }
    },

    unsubscribe(commandID: string): void {
      const sub = subs.get(commandID)
      if (sub) clearSnapshotTimer(sub)
      subs.delete(commandID)
      // Real server-side unsubscribe: drops the broker entry so deltas stop.
      // Best-effort (socket may be down); local removal always stops applying.
      if (sub && socket && state === "connected") {
        try {
          socket.send(JSON.stringify({ type: "unsubscribe", commandID }))
        } catch {}
      }
    },

    sendInput(commandID: string, data: string): SendResult {
      const sub = subs.get(commandID)
      // Rejected before ownership/subscription confirmation (no snapshot yet).
      if (!socket || state !== "connected" || !sub || !sub.hasSnapshot) {
        return { ok: false, reason: "not-subscribed" }
      }
      return sendWire({ type: "input", commandID, data }) ? { ok: true } : { ok: false, reason: "send-failed" }
    },

    sendInterrupt(commandID: string): SendResult {
      const sub = subs.get(commandID)
      if (!socket || state !== "connected" || !sub || !sub.hasSnapshot) {
        return { ok: false, reason: "not-subscribed" }
      }
      return sendWire({ type: "interrupt", commandID }) ? { ok: true } : { ok: false, reason: "send-failed" }
    },

    isLive(commandID: string): boolean {
      // Live only after a valid snapshot/ack — never on subscribe-alone.
      return state === "connected" && (subs.get(commandID)?.hasSnapshot === true)
    },

    disconnect(): void {
      closedIntentionally = true
      generation += 1
      if (reconnectTimer) {
        clearTimeout(reconnectTimer)
        reconnectTimer = undefined
      }
      for (const sub of subs.values()) {
        clearSnapshotTimer(sub)
        sub.hasSnapshot = false
        sub.endOffset = undefined
        sub.startOffset = undefined
        sub.resyncPending = false
      }
      try {
        socket?.close(1000, "client disconnect")
      } catch {}
      socket = undefined
      emitConnection("disconnected")
    },

    dispose(): void {
      for (const sub of subs.values()) clearSnapshotTimer(sub)
      subs.clear()
      if (reconnectTimer) {
        clearTimeout(reconnectTimer)
        reconnectTimer = undefined
      }
      closedIntentionally = true
      generation += 1
      try {
        socket?.close(1000, "client dispose")
      } catch {}
      socket = undefined
      if (state !== "disconnected") emitConnection("disconnected")
    },
  }
}

export { defaultEndpointPath as streamEndpointPathForClient }
