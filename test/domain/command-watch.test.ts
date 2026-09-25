import { describe, it, expect } from "bun:test"
import {
  CommandWatcher,
  compileWatchPattern,
  compileWatchSpec,
  createLineAssembler,
  formatWatchBudgetMessage,
  formatWatchFloodMessage,
  formatWatchMessage,
  matchLine,
  stripAnsiForWatch,
  WATCH_COALESCE_WINDOW_MS,
  WATCH_FLOOD_LINES_PER_SEC,
  WATCH_MAX_BYTES_PER_PUSH,
  WATCH_MAX_LINES_PER_PUSH,
  WATCH_MAX_PUSHES_PER_COMMAND,
  MAX_WATCH_MESSAGE_BYTES,
} from "../../src/domain/command-watch"

describe("command-watch assembler", () => {
  it("carries partial lines across chunks", () => {
    const asm = createLineAssembler()
    expect(asm.push("hello wo")).toEqual([])
    expect(asm.push("rld\nnext\npar")).toEqual(["hello world", "next"])
    expect(asm.flush()).toEqual(["par"])
    expect(asm.flush()).toEqual([])
  })

  it("strips ANSI CSI/OSC so colored output matches as visible text", () => {
    const asm = createLineAssembler()
    expect(asm.push("[31mred[0m\nplain\n")).toEqual(["red", "plain"])
    expect(stripAnsiForWatch("[1;32mok[0m")).toBe("ok")
  })

  it("bare CR overwrites the current line (progress bars don't spam)", () => {
    const asm = createLineAssembler()
    expect(asm.push("progress 10%\rprogress 20%\n")).toEqual(["progress 20%"])
  })

  it("treats CRLF as one newline, including pairs split across chunks", () => {
    const asm = createLineAssembler()
    expect(asm.push("a\r")).toEqual([])
    expect(asm.push("\nb\n")).toEqual(["a", "b"])
  })
})

describe("command-watch compile", () => {
  it("rejects invalid regexes with a clear message", () => {
    expect(() => compileWatchPattern("filter", "(unclosed")).toThrow(/Invalid watch filter regex/)
    expect(() => compileWatchSpec({ until: "(*bad" })).toThrow(/Invalid watch until regex/)
  })

  it("rejects dangerous nested-quantifier patterns (M1 parity)", () => {
    expect(() => compileWatchPattern("filter", "(a+)+")).toThrow(/dangerous/)
    expect(() => compileWatchPattern("until", "(?:a)*.*(?:b)*")).toThrow(/dangerous/)
    expect(() => compileWatchSpec({ filter: "(.*.*)" })).toThrow(/dangerous/)
  })

  it("compiles valid patterns with ignoreCase and defaults untilAction to stop", () => {
    const c = compileWatchSpec({ filter: "FOO", ignoreCase: true })
    expect(c.filterRe!.test("foo")).toBe(true)
    expect(c.untilAction).toBe("stop")
    expect(compileWatchSpec({ until: "x", untilAction: "keep" }).untilAction).toBe("keep")
  })

  it("rejects unknown untilAction values", () => {
    expect(() => compileWatchSpec({ until: "x", untilAction: "bogus" as never })).toThrow(/untilAction/)
  })
})

describe("command-watch matchLine pipeline", () => {
  it("evaluates filter first: a blocked line never fires until", () => {
    const c = compileWatchSpec({ filter: "ERROR", until: "READY" })
    expect(matchLine(c, "READY")).toEqual({ pass: false, until: false })
    expect(matchLine(c, "ERROR READY")).toEqual({ pass: true, until: true })
    expect(matchLine(c, "ERROR boom")).toEqual({ pass: true, until: false })
  })

  it("without a filter every line passes and until still fires", () => {
    const c = compileWatchSpec({ until: "ready" })
    expect(matchLine(c, "ready steady")).toEqual({ pass: true, until: true })
    expect(matchLine(c, "booting")).toEqual({ pass: true, until: false })
  })
})

describe("command-watch policy constants", () => {
  it("matches the specified coalescing/flood/budget policy", () => {
    expect(WATCH_COALESCE_WINDOW_MS).toBe(2000)
    expect(WATCH_MAX_LINES_PER_PUSH).toBe(20)
    expect(WATCH_MAX_BYTES_PER_PUSH).toBe(4 * 1024)
    expect(WATCH_MAX_PUSHES_PER_COMMAND).toBe(30)
    expect(WATCH_FLOOD_LINES_PER_SEC).toBe(100)
  })
})

describe("CommandWatcher runtime", () => {
  it("buffers filter-passed lines and reports completed stripped lines", () => {
    const w = new CommandWatcher({ filter: "ERROR" })
    const r = w.feedChunk("a\nERROR x\nb\n", 1000)
    expect(r.completed).toEqual(["a", "ERROR x", "b"])
    expect(r.matched).toEqual(["ERROR x"])
    expect(r.untilLine).toBeNull()
    expect(w.pendingCount).toBe(1)
    const push = w.takePush()
    expect(push).toEqual({ lines: ["ERROR x"], exhaustedNow: false })
    expect(w.state).toMatchObject({ state: "active", matches: 1, pushes: 1 })
  })

  it("skips blank lines entirely", () => {
    const w = new CommandWatcher({ filter: "x" })
    const r = w.feedChunk("\n   \n\t\n", 1000)
    expect(r.completed).toEqual([])
    expect(w.state.matches).toBe(0)
  })

  it("until-match marks until-matched; stop drops later lines, keep continues", () => {
    const stop = new CommandWatcher({ until: "READY" })
    const r1 = stop.feedChunk("boot\nREADY now\n", 1000)
    expect(r1.untilLine).toBe("READY now")
    expect(stop.state.state).toBe("until-matched")
    const r2 = stop.feedChunk("later\n", 1000)
    expect(r2.matched).toEqual([])
    expect(stop.state.droppedLines).toBe(1)

    const keep = new CommandWatcher({ filter: "o", until: "READY", untilAction: "keep" })
    keep.feedChunk("READY go\n", 1000)
    expect(keep.state.state).toBe("until-matched")
    const r3 = keep.feedChunk("foo\n", 1000)
    expect(r3.matched).toEqual(["foo"]) // filter stream continues, until spent
    // A second until-pattern line does not re-fire
    const r4 = keep.feedChunk("READY go again\n", 1000)
    expect(r4.untilLine).toBeNull()
    expect(r4.matched).toEqual(["READY go again"])
  })

  it("flood rule suspends with dropped count (one notice via floodNow)", () => {
    const w = new CommandWatcher({ filter: "ERROR" })
    const lines = Array.from({ length: 101 }, (_, i) => `line-${i}`).join("\n") + "\n"
    const r = w.feedChunk(lines, 5000)
    expect(r.floodNow).toBe(true)
    expect(w.state.state).toBe("flood-suspended")
    expect(w.state.droppedLines).toBeGreaterThanOrEqual(1)
    const droppedAtTrip = w.state.droppedLines
    const r2 = w.feedChunk("ERROR after\nERROR more\n", 5000)
    expect(r2.floodNow).toBe(false) // notice exactly once
    expect(r2.matched).toEqual([])
    expect(w.state.droppedLines).toBeGreaterThan(droppedAtTrip)
  })

  it("budget cap exhausts after 30 pushes with exactly one notice", () => {
    const w = new CommandWatcher({ filter: "x" })
    for (let i = 0; i < WATCH_MAX_PUSHES_PER_COMMAND; i++) {
      w.feedChunk(`x-${i}\n`, 1000 + i)
      const push = w.takePush()
      expect(push?.exhaustedNow).toBe(false)
    }
    expect(w.state.pushes).toBe(30)
    w.feedChunk("x-last\n", 2000)
    const notice = w.takePush()
    expect(notice).toEqual({ lines: [], exhaustedNow: true })
    expect(w.state.state).toBe("budget-exhausted")
    expect(w.takePush()).toBeNull() // notice exactly once
  })

  it("takePush bounds each push to 20 lines / 4KB, leaving overflow pending", () => {
    const w = new CommandWatcher({})
    w.feedChunk(Array.from({ length: 25 }, (_, i) => `l-${i}`).join("\n") + "\n", 1000)
    const first = w.takePush()
    expect(first!.lines).toHaveLength(WATCH_MAX_LINES_PER_PUSH)
    expect(w.pendingCount).toBe(5)
    const big = new CommandWatcher({})
    big.feedChunk(Array.from({ length: 6 }, () => "y".repeat(1024)).join("\n") + "\n", 1000)
    const bounded = big.takePush()!
    expect(Buffer.byteLength(bounded.lines.join("\n"))).toBeLessThanOrEqual(WATCH_MAX_BYTES_PER_PUSH)
    expect(big.pendingCount).toBeGreaterThan(0)
  })

  it("takeUntilPush takes the newest bounded window (matching line survives)", () => {
    const w = new CommandWatcher({ until: "READY" })
    w.feedChunk(Array.from({ length: 25 }, (_, i) => `old-${i}`).join("\n") + "\nREADY!\n", 1000)
    const lines = w.takeUntilPush()
    expect(lines).toHaveLength(20)
    expect(lines[lines.length - 1]).toBe("READY!")
    expect(w.pendingCount).toBe(0)
  })

  it("finish() assembles the trailing partial line through the pipeline", () => {
    const w = new CommandWatcher({ until: "DONE" })
    expect(w.feedChunk("par", 1000).completed).toEqual([])
    const fin = w.finish(1000)
    expect(fin.completed).toEqual(["par"])
    const w2 = new CommandWatcher({ until: "DONE" })
    w2.feedChunk("all DONE", 1000)
    expect(w2.finish(1000).untilLine).toBe("all DONE")
  })
})

describe("command-watch message formatting", () => {
  it("prefixes with [watch title] and stays within 4KB", () => {
    const msg = formatWatchMessage("dev", ["a", "b"])
    expect(msg.startsWith('[watch "dev"]')).toBe(true)
    expect(msg).toContain("a\nb")
    const huge = formatWatchMessage("dev", Array.from({ length: 500 }, () => "x".repeat(100)))
    expect(Buffer.byteLength(huge)).toBeLessThanOrEqual(MAX_WATCH_MESSAGE_BYTES)
    expect(huge.startsWith('[watch "dev"]')).toBe(true)
  })

  it("flood/budget notices name the cause and keep-running semantics", () => {
    expect(formatWatchFloodMessage("t", 7)).toMatch(/FLOOD.*7.*keeps running/)
    expect(formatWatchBudgetMessage("t")).toMatch(/BUDGET.*30.*keeps running/)
  })
})
