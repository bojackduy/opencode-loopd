import { describe, expect, it } from "bun:test"
import {
  AGENT_EVENT_MAX_LINES,
  AGENT_EVENT_MAX_PAYLOAD_BYTES,
  MAX_AGENT_EVENT_BYTES,
  MAX_AGENT_EVENT_SUMMARIES,
  appendAgentEventSummary,
  boundTailPayload,
  buildAgentEventEnvelope,
  formatAgentChannelStatus,
  formatAgentEventEnvelope,
  nextAgentEventSequence,
  summarizeAgentEvent,
  tailRange,
  type AgentEventTrigger,
} from "../../src/domain/command-agent-event"
import { CommandWatcher } from "../../src/domain/command-watch"
import type { CommandSession } from "../../src/domain/command-session"

const NOW = "2026-10-25T00:00:00.000Z"

function session(over: Partial<CommandSession> = {}): CommandSession {
  return {
    id: "cmd-1" as CommandSession["id"],
    title: "dev server",
    command: "vite",
    args: [],
    cwd: "/repo",
    ownerSessionID: "owner-1",
    status: "running",
    outputBytes: 0,
    streamBytes: 0,
    truncated: false,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  }
}

function envelope(trigger: AgentEventTrigger, over: Partial<CommandSession> = {}, range = { startOffset: 0, endOffset: 0 }) {
  const s = session(over)
  return buildAgentEventEnvelope({ session: s, trigger, sequence: 1, timestamp: NOW, range, lines: 1 })
}

describe("agent event envelope", () => {
  it("carries the full contract for every trigger kind", () => {
    const triggers: AgentEventTrigger[] = ["watch-match", "until-match", "exit", "timeout", "flood", "budget"]
    for (const trigger of triggers) {
      const event = envelope(trigger, { status: "exited", exitCode: 2, streamBytes: 100, outputBytes: 100, endedAt: NOW }, {
        startOffset: 10,
        endOffset: 40,
      })
      expect(event.trigger).toBe(trigger)
      expect(event.commandID).toBe("cmd-1")
      expect(event.title).toBe("dev server")
      expect(event.sequence).toBe(1)
      expect(event.timestamp).toBe(NOW)
      expect(event.status).toBe("exited")
      expect(event.exitCode).toBe(2)
      expect(event.retainedBytes).toBe(100)
      expect(event.streamBytes).toBe(100)
      expect(event.truncated).toBe(false)
      expect(event.range).toEqual({ startOffset: 10, endOffset: 40 })
      expect(event.lines).toBe(1)
      expect(event.durationMs).toBe(0)
    }
  })

  it("sequences deliveries monotonically per command", () => {
    expect(nextAgentEventSequence({})).toBe(1)
    expect(nextAgentEventSequence({ agentEventSeq: 1 })).toBe(2)
    expect(nextAgentEventSequence({ agentEventSeq: 41 })).toBe(42)
  })

  it("reports truncation and absolute lifetime offsets past the 512KB ring", () => {
    const event = envelope("watch-match", {
      outputBytes: 512 * 1024,
      streamBytes: 700_000,
      truncated: true,
    }, tailRange(700_000, 4096))
    expect(event.retainedBytes).toBe(512 * 1024)
    expect(event.streamBytes).toBe(700_000)
    expect(event.truncated).toBe(true)
    expect(event.range).toEqual({ startOffset: 695_904, endOffset: 700_000 })
  })

  it("tailRange never goes negative and clamps to the stream end", () => {
    expect(tailRange(0, 4096)).toEqual({ startOffset: 0, endOffset: 0 })
    expect(tailRange(100, 4096)).toEqual({ startOffset: 0, endOffset: 100 })
    expect(tailRange(1000, 100)).toEqual({ startOffset: 900, endOffset: 1000 })
  })
})

describe("agent event formatting", () => {
  it("shows trigger, console range, terminal facts and the paging hint", () => {
    const event = envelope("exit", { status: "exited", exitCode: 7, streamBytes: 20, outputBytes: 20 }, {
      startOffset: 4,
      endOffset: 20,
    })
    const message = formatAgentEventEnvelope(event, ["boom"])
    expect(message).toContain('event #1 exit')
    expect(message).toContain("exitCode=7")
    expect(message).toContain("console [4,20)")
    expect(message).toContain("boom")
    expect(message).toContain("loopd_command_get")
    expect(message).toContain("id=cmd-1 offsetBytes=4")
    expect(message).toContain("source of truth")
  })

  it("keeps the watch-family prefix so existing owner messages stay recognizable", () => {
    expect(formatAgentEventEnvelope(envelope("watch-match"), ["line"])).toContain('[watch "dev server"]')
    expect(formatAgentEventEnvelope(envelope("flood"), [], "FLOOD: dropped")).toContain("FLOOD:")
    expect(formatAgentEventEnvelope(envelope("budget"), [], "BUDGET: exhausted")).toContain("BUDGET:")
  })

  it("stays bounded at 4KB no matter how much payload is passed", () => {
    const payload = Array.from({ length: 500 }, (_, i) => `line-${i}-${"x".repeat(200)}`)
    const message = formatAgentEventEnvelope(envelope("watch-match", {}, { startOffset: 0, endOffset: 10 }), payload)
    expect(Buffer.byteLength(message, "utf8")).toBeLessThanOrEqual(MAX_AGENT_EVENT_BYTES)
  })

  it("keeps only the newest bounded summaries for the human inspect path", () => {
    let log = appendAgentEventSummary(undefined, summarizeAgentEvent(envelope("exit")))
    for (let i = 2; i <= MAX_AGENT_EVENT_SUMMARIES + 5; i++) {
      const event = buildAgentEventEnvelope({
        session: session(),
        trigger: "watch-match",
        sequence: i,
        timestamp: NOW,
        range: { startOffset: i, endOffset: i + 1 },
        lines: 1,
      })
      log = appendAgentEventSummary(log, summarizeAgentEvent(event))
    }
    expect(log).toHaveLength(MAX_AGENT_EVENT_SUMMARIES)
    expect(log[0]!.sequence).toBe(6)
    expect(log.at(-1)!.sequence).toBe(MAX_AGENT_EVENT_SUMMARIES + 5)
  })

  it("tells a human explicitly when the agent received nothing", () => {
    expect(formatAgentChannelStatus({ outputBytes: 120, streamBytes: 120, truncated: false })).toContain(
      "agent events: none",
    )
    const withEvents = formatAgentChannelStatus({
      outputBytes: 120,
      streamBytes: 120,
      truncated: false,
      agentEvents: [
        { sequence: 1, trigger: "watch-match", timestamp: NOW, status: "running", lines: 2, startOffset: 10, endOffset: 40 },
      ],
    })
    expect(withEvents).toContain("agent events: 1")
    expect(withEvents).toContain("[10,40)")
  })
})

describe("bounded agent payload", () => {
  it("keeps the newest 20 lines and reports the exact suffix bytes", () => {
    const text = Array.from({ length: 100 }, (_, i) => `l-${i}`).join("\n") + "\n"
    const payload = boundTailPayload(text)
    expect(payload.lines).toHaveLength(AGENT_EVENT_MAX_LINES)
    expect(payload.lines[0]).toBe("l-80")
    expect(payload.lines.at(-1)).toBe("l-99")
    expect(payload.bytes).toBe(Buffer.byteLength(payload.lines.join("\n")))
  })

  it("caps the payload at 4KB even with huge lines", () => {
    const text = Array.from({ length: 10 }, () => "y".repeat(1000)).join("\n")
    const payload = boundTailPayload(text)
    expect(payload.bytes).toBeLessThanOrEqual(AGENT_EVENT_MAX_PAYLOAD_BYTES)
    expect(payload.lines.length).toBeLessThanOrEqual(AGENT_EVENT_MAX_LINES)
  })

  it("returns an empty payload for empty output", () => {
    expect(boundTailPayload("\n\n")).toEqual({ lines: [], bytes: 0 })
  })
})

describe("console channel vs agent channel", () => {
  it("delivers only filter-passed lines while the console keeps everything", () => {
    const watcher = new CommandWatcher({ filter: "ERROR" })
    const consoleText = "info ok\nERROR boom\nwarn nope\n"
    watcher.feedChunk(consoleText, 1000, 0)
    const push = watcher.takePush()!
    expect(push.lines).toEqual(["ERROR boom"])
    // The delivered range points at the matching line, not at the whole chunk.
    expect(push.range).toBeDefined()
    const bytes = Buffer.from(consoleText, "utf8")
    const delivered = bytes.subarray(push.range!.startOffset, push.range!.endOffset).toString("utf8")
    expect(delivered).toBe("ERROR boom\n")
    // Filtered-out output is absent from the event and fully present in console.
    expect(consoleText).toContain("warn nope")
    expect(push.lines.join("\n")).not.toContain("warn nope")
  })

  it("lets an agent page around a delivered event by its console range", () => {
    const watcher = new CommandWatcher({ filter: "READY" })
    const consoleText = "boot\ntick\nREADY\n"
    watcher.feedChunk(consoleText, 1000, 0)
    const push = watcher.takePush()!
    const range = push.range!
    const bytes = Buffer.from(consoleText, "utf8")
    // Page from the event start: the delivered line is exactly there.
    expect(bytes.subarray(range.startOffset).toString("utf8").startsWith("READY\n")).toBe(true)
    // Page the preceding bytes: context before the event is still readable.
    expect(bytes.subarray(0, range.startOffset).toString("utf8")).toBe("boot\ntick\n")
    expect(range.endOffset).toBe(bytes.length)
  })

  it("keeps offsets exact across chunk boundaries, CRLF and bare CR", () => {
    const watcher = new CommandWatcher({})
    watcher.feedChunk("a\r", 1000, 0)
    const second = watcher.feedChunk("\nb\rprogress 20%\n", 1000, 2)
    const push = watcher.takePush()!
    const consoleText = "a\r\nb\rprogress 20%\n"
    const bytes = Buffer.from(consoleText, "utf8")
    expect(push.lines).toEqual(["a", "progress 20%"])
    const first = bytes.subarray(0, 3).toString("utf8")
    expect(first).toBe("a\r\n")
    expect(push.range).toEqual({ startOffset: 0, endOffset: bytes.length })
    expect(second.completed).toEqual(["a", "progress 20%"])
  })

  it("reports the range of the until window actually delivered", () => {
    const watcher = new CommandWatcher({ until: "READY", untilAction: "keep" })
    const consoleText = "old-1\nold-2\nREADY now\n"
    watcher.feedChunk(consoleText, 1000, 0)
    const push = watcher.takeUntilPushWithRange()
    expect(push.lines.at(-1)).toBe("READY now")
    const bytes = Buffer.from(consoleText, "utf8")
    expect(push.range).toBeDefined()
    expect(bytes.subarray(push.range!.startOffset, push.range!.endOffset).toString("utf8")).toContain("READY now")
    expect(push.range!.endOffset).toBe(bytes.length)
  })

  it("omits ranges when the caller has no absolute offsets (legacy path)", () => {
    const watcher = new CommandWatcher({ filter: "x" })
    watcher.feedChunk("x\n", 1000)
    expect(watcher.takePush()!.range).toBeUndefined()
  })
})
