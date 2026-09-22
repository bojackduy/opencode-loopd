// ─── Server: Command Stream Transport (Milestone 3) ──────────────────────────
// Private loopback WebSocket transport for event-driven command streaming.
// Transport layer ONLY: no TUI client, no PTY backend, no control-bus moves.
//
// Pattern (read-only reference): opencode-pty src/web/server snapshot+live-delta
// + per-session topics — but NO browser/web UI here: this is a private
// loopback IPC server bound to 127.0.0.1 with an ephemeral port (port 0) and
// a cryptographically random connection token required on upgrade.
//
// Ownership: the broker resolver enforces subscribe ownership; input/interrupt
// are bound to the ownerSessionID recorded at subscribe time (never trust a
// per-message owner — the wire messages carry no owner field).

import { randomBytes, randomUUID, timingSafeEqual } from "crypto"
import { promises as fs } from "fs"
import path from "path"
import type { ServerWebSocket } from "bun"
import { validateCommandStreamMessage } from "../domain/command-events"
import type { CommandService } from "../application/command-service"
import type { CommandEventBroker, CommandEventSink } from "../application/command-event-broker"
import { describeError, logServerEvent } from "../infrastructure/server-log"

export interface CommandStreamEndpoint {
  url: string
  token: string
  pid: number
  generation: string
  startedAt: string
}

export interface CommandStreamServer {
  /** Full connect URL (includes ?token=). */
  readonly url: string | undefined
  readonly token: string
  readonly generation: string
  readonly endpointPath: string
  start(): Promise<void>
  stop(): Promise<void>
}

export function streamEndpointPath(directory: string): string {
  return path.join(directory, ".opencode", "loopd", "commands", ".stream-endpoint.json")
}

/** True when the pid is alive. EPERM (no permission) still means alive. */
function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code
    if (code === "EPERM") return true
    return false
  }
}

function tokensEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  try {
    return timingSafeEqual(ab, bb)
  } catch {
    return false
  }
}

/** Per-socket subscription entry: owner is bound at subscribe time. */
interface SocketSub {
  sinkID: string
  ownerSessionID: string
}

/** Close the socket so the client resyncs rather than receiving a gap. */
const MAX_BUFFERED_BYTES = 512 * 1024

export function createCommandStreamServer(
  directory: string,
  commandService: CommandService,
  broker: CommandEventBroker,
): CommandStreamServer {
  const endpointPath = streamEndpointPath(directory)
  const token = randomBytes(32).toString("hex")
  const generation = randomUUID()
  const startedAt = new Date().toISOString()

  let server: ReturnType<typeof Bun.serve> | undefined
  let serverURL: string | undefined
  let started = false
  let stopped = false

  // One socket may hold multiple command subscriptions.
  const sockets = new Set<ServerWebSocket<unknown>>()
  const subsBySocket = new Map<ServerWebSocket<unknown>, Map<string, SocketSub>>()

  function sendError(ws: ServerWebSocket<unknown>, code: string, message: string): void {
    try {
      ws.send(JSON.stringify({ type: "error", code, message }))
    } catch {
      // Socket already gone — nothing to do.
    }
  }

  /** Guard backpressure: on overflow close so the client resyncs. */
  function sendToSocket(ws: ServerWebSocket<unknown>, payload: string): boolean {
    try {
      const buffered = (ws as { bufferedAmount?: number }).bufferedAmount ?? 0
      if (buffered > MAX_BUFFERED_BYTES) {
        try {
          ws.close(1011, "backpressure overflow: resync")
        } catch {}
        return false
      }
      ws.send(payload)
      return true
    } catch {
      return false
    }
  }

  function makeSink(ws: ServerWebSocket<unknown>): CommandEventSink {
    return (msg) => {
      // Broker validates before publish by contract; sink only serializes.
      if (stopped || !sockets.has(ws)) return
      sendToSocket(ws, JSON.stringify(msg))
    }
  }

  function subsFor(ws: ServerWebSocket<unknown>): Map<string, SocketSub> {
    let m = subsBySocket.get(ws)
    if (!m) {
      m = new Map()
      subsBySocket.set(ws, m)
    }
    return m
  }

  function cleanupSocket(ws: ServerWebSocket<unknown>): void {
    const subs = subsBySocket.get(ws)
    if (subs) {
      for (const [commandID, entry] of subs) {
        try {
          broker.unsubscribe(commandID, entry.sinkID)
        } catch {}
      }
      subsBySocket.delete(ws)
    }
    sockets.delete(ws)
  }

  async function handleSubscribe(ws: ServerWebSocket<unknown>, commandID: string, ownerSessionID: string): Promise<void> {
    const subs = subsFor(ws)
    const previous = subs.get(commandID)
    if (previous) {
      try {
        broker.unsubscribe(commandID, previous.sinkID)
      } catch {}
      subs.delete(commandID)
    }
    const sink = makeSink(ws)
    let sinkID: string
    try {
      sinkID = await broker.subscribe(commandID, ownerSessionID, sink)
    } catch (error) {
      sendError(ws, "subscribe-failed", error instanceof Error ? error.message : String(error))
      return
    }
    // Socket may have closed during the handshake — do not leak the entry.
    if (!sockets.has(ws)) {
      try {
        broker.unsubscribe(commandID, sinkID)
      } catch {}
      return
    }
    subs.set(commandID, { sinkID, ownerSessionID })
  }

  async function handleResync(ws: ServerWebSocket<unknown>, commandID: string): Promise<void> {
    // Resync = unsubscribe + fresh subscribe handshake (fresh snapshot).
    const subs = subsFor(ws)
    const previous = subs.get(commandID)
    if (!previous) {
      sendError(ws, "not-subscribed", `No subscription for command ${commandID} on this socket; subscribe first.`)
      return
    }
    await handleSubscribe(ws, commandID, previous.ownerSessionID)
  }

  async function handleInput(ws: ServerWebSocket<unknown>, commandID: string, data: string): Promise<void> {
    const owner = subsFor(ws).get(commandID)?.ownerSessionID
    if (!owner) {
      sendError(ws, "not-subscribed", `No subscription for command ${commandID} on this socket; subscribe first.`)
      return
    }
    try {
      const result = await commandService.write(directory, commandID, owner, data)
      if (!result.ok) sendError(ws, "input-failed", result.message)
    } catch (error) {
      sendError(ws, "input-failed", error instanceof Error ? error.message : String(error))
    }
  }

  async function handleInterrupt(ws: ServerWebSocket<unknown>, commandID: string): Promise<void> {
    const owner = subsFor(ws).get(commandID)?.ownerSessionID
    if (!owner) {
      sendError(ws, "not-subscribed", `No subscription for command ${commandID} on this socket; subscribe first.`)
      return
    }
    try {
      const result = await commandService.interrupt(directory, commandID, owner)
      if (!result.ok) sendError(ws, "interrupt-failed", result.message)
    } catch (error) {
      sendError(ws, "interrupt-failed", error instanceof Error ? error.message : String(error))
    }
  }

  async function handleSocketMessage(ws: ServerWebSocket<unknown>, raw: string | Buffer | ArrayBuffer | Uint8Array): Promise<void> {
    let parsed: unknown
    try {
      const text = typeof raw === "string" ? raw : Buffer.from(raw as Uint8Array).toString("utf8")
      parsed = JSON.parse(text)
    } catch {
      sendError(ws, "invalid-message", "Message must be JSON.")
      return
    }
    // Fail-closed: validate EVERY inbound message, never throw, never act on invalid.
    let validated: ReturnType<typeof validateCommandStreamMessage>
    try {
      validated = validateCommandStreamMessage(parsed)
    } catch (error) {
      sendError(ws, "invalid-message", `Validation failed: ${String(error)}`)
      return
    }
    if (!validated.ok) {
      sendError(ws, "invalid-message", validated.error)
      return
    }
    const msg = validated.message
    try {
      switch (msg.type) {
        case "subscribe":
          await handleSubscribe(ws, msg.commandID, msg.ownerSessionID)
          break
        case "resync":
          await handleResync(ws, msg.commandID)
          break
        case "input":
          await handleInput(ws, msg.commandID, msg.data)
          break
        case "interrupt":
          await handleInterrupt(ws, msg.commandID)
          break
        default:
          // snapshot/output/status/error are server→client only; anything
          // else inbound is a protocol violation, never acted on.
          sendError(ws, "invalid-message", `Message type "${(msg as { type: string }).type}" is not accepted inbound.`)
          break
      }
    } catch (error) {
      sendError(ws, "internal-error", error instanceof Error ? error.message : String(error))
    }
  }

  async function writeEndpointFile(url: string): Promise<void> {
    const endpoint: CommandStreamEndpoint = {
      url,
      token,
      pid: process.pid,
      generation,
      startedAt,
    }
    await fs.mkdir(path.dirname(endpointPath), { recursive: true })
    await fs.writeFile(endpointPath, JSON.stringify(endpoint, null, 2) + "\n", { mode: 0o600 })
    await fs.chmod(endpointPath, 0o600)
  }

  return {
    get url() {
      return serverURL
    },
    token,
    generation,
    endpointPath,

    async start(): Promise<void> {
      if (started) return
      started = true

      // Stale detection (best-effort, never throws): if an endpoint file
      // exists, check whether its pid is dead. Either way we start our own
      // server and replace the file with our generation — we never connect
      // to ("trust") the old endpoint, and dispose() only removes our own
      // generation. A live foreign endpoint is therefore superseded, never
      // adopted.
      try {
        const previous = await fs.readFile(endpointPath, "utf8").then(
          (text) => JSON.parse(text) as Partial<CommandStreamEndpoint>,
          () => undefined,
        )
        if (previous && typeof previous.pid === "number" && isPidAlive(previous.pid) && previous.pid !== process.pid) {
          void logServerEvent(directory, "command-stream.superseded-live-endpoint", { pid: previous.pid })
        }
      } catch {}

      const srv = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(req, upgrading) {
          if (stopped) return new Response("Server is stopping.", { status: 503 })
          let url: URL
          try {
            url = new URL(req.url)
          } catch {
            return new Response("Bad request.", { status: 400 })
          }
          if (url.pathname !== "/" && url.pathname !== "/stream") {
            return new Response("Not found.", { status: 404 })
          }
          const presented = url.searchParams.get("token") ?? ""
          if (!presented || !tokensEqual(presented, token)) {
            return new Response("Forbidden: valid connection token required.", { status: 403 })
          }
          const ok = upgrading.upgrade(req, { data: undefined })
          if (!ok) return new Response("WebSocket upgrade required.", { status: 400 })
          return undefined as unknown as Response
        },
        websocket: {
          open(ws) {
            sockets.add(ws as ServerWebSocket<unknown>)
          },
          message(ws, raw) {
            void handleSocketMessage(ws as ServerWebSocket<unknown>, raw as string | Buffer).catch((error) => {
              try {
                sendError(ws as ServerWebSocket<unknown>, "internal-error", describeError(error))
              } catch {}
            })
          },
          close(ws) {
            cleanupSocket(ws as ServerWebSocket<unknown>)
          },
        },
      })
      server = srv as unknown as ReturnType<typeof Bun.serve>
      const port = (srv as unknown as { port: number }).port
      serverURL = `ws://127.0.0.1:${port}/stream?token=${token}`
      await writeEndpointFile(serverURL)
      void logServerEvent(directory, "command-stream.started", { port, generation })
    },

    async stop(): Promise<void> {
      stopped = true
      // Close client sockets first (stop accepting before children die).
      for (const ws of [...sockets]) {
        try {
          ws.close(1001, "server shutting down")
        } catch {}
        cleanupSocket(ws)
      }
      sockets.clear()
      subsBySocket.clear()
      try {
        server?.stop(true)
      } catch {}
      server = undefined
      serverURL = undefined
      // Remove the endpoint file ONLY when its generation matches ours —
      // never delete another generation's file.
      try {
        const text = await fs.readFile(endpointPath, "utf8")
        const current = JSON.parse(text) as Partial<CommandStreamEndpoint>
        if (current?.generation === generation) {
          await fs.unlink(endpointPath)
        } else {
          void logServerEvent(directory, "command-stream.keep-endpoint", {
            reason: "generation mismatch — another server owns the file",
          })
        }
      } catch {
        // Already gone or unreadable — nothing to do.
      }
      void logServerEvent(directory, "command-stream.stopped", { generation })
    },
  }
}
