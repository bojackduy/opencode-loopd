import { describe, it, expect } from "bun:test"
import {
  emptyCommandPanelState,
  refreshCommandList,
  moveCommandSelection,
  selectCommandFirst,
  selectCommandLast,
  commandPanelKey,
  parseResizeArgs,
  parseCommandLine,
  parseNewCommandTail,
  parseNewCommand,
  formatCommandRow,
  watchBadge,
  commandBadges,
  formatWatchDetail,
} from "../../src/tui/command-controller"
import { createCommandSession } from "../../src/domain/command-session"

function session(id: string, title: string, status: "running" | "exited" = "running") {
  const c = createCommandSession({ id, title, command: "echo", cwd: "/tmp", ownerSessionID: "o" })
  return status === "exited" ? { ...c, status, exitCode: 0 } : c
}

describe("Command panel controller", () => {
  it("refresh keeps selection stable by ID", () => {
    let s = refreshCommandList(emptyCommandPanelState(), [session("a", "a"), session("b", "b")])
    s = moveCommandSelection(s, 1)
    expect(s.selectedCommand?.id).toBe("b")
    const s2 = refreshCommandList(s, [session("a", "a"), session("b", "b"), session("c", "c")])
    expect(s2.selectedCommand?.id).toBe("b")
    expect(s2.selected).toBe(1)
  })

  it("selection clamps at the ends", () => {
    let s = refreshCommandList(emptyCommandPanelState(), [session("a", "a")])
    s = moveCommandSelection(s, 5)
    expect(s.selected).toBe(0)
    s = moveCommandSelection(s, -5)
    expect(s.selected).toBe(0)
    expect(selectCommandFirst(s).selected).toBe(0)
    expect(selectCommandLast(s).selected).toBe(0)
  })

  it("maps ctrl-c to interrupt (never kill) and q to detach", () => {
    const s = refreshCommandList(emptyCommandPanelState(), [session("a", "a")])
    expect(commandPanelKey("ctrl-c", s)).toEqual({ kind: "interrupt" })
    expect(commandPanelKey("terminate", s)).toEqual({ kind: "terminate" })
    expect(commandPanelKey("remove", s)).toEqual({ kind: "remove" })
    // Detach closes the view only — the action carries no session effect.
    expect(commandPanelKey("q", s)).toEqual({ kind: "detach" })
    expect(commandPanelKey("close", s)).toEqual({ kind: "detach" })
    expect(commandPanelKey("detach", s)).toEqual({ kind: "detach" })
    // No selection → no session-targeting actions, detach still works.
    const empty = emptyCommandPanelState()
    expect(commandPanelKey("ctrl-c", empty)).toBeUndefined()
    expect(commandPanelKey("q", empty)).toEqual({ kind: "detach" })
  })

  it("parses :resize args strictly", () => {
    expect(parseResizeArgs(["120", "40"])).toEqual({ cols: 120, rows: 40 })
    expect(parseResizeArgs(["0", "40"])).toBeUndefined()
    expect(parseResizeArgs(["x", "40"])).toBeUndefined()
    expect(parseResizeArgs(["120"])).toBeUndefined()
  })

  it("formats rows with status and exit code", () => {
    expect(formatCommandRow(session("a", "dev"))).toMatch(/dev.*running/)
    expect(formatCommandRow(session("b", "old", "exited"))).toMatch(/exited \(0\)/)
  })

  it("badges watch state and terminal endReason", () => {
    const plain = session("a", "dev")
    expect(watchBadge(plain)).toBeUndefined()
    expect(commandBadges(plain)).toEqual([])

    const filtered = { ...session("b", "w"), watchFilter: "ERROR", watchState: { state: "active", matches: 0, pushes: 0, droppedLines: 0 } } as never
    expect(watchBadge(filtered as never)).toBe("watch:filter")

    const armed = { ...session("c", "w"), watchUntil: "READY", watchUntilAction: "stop", watchState: { state: "active", matches: 0, pushes: 0, droppedLines: 0 } } as never
    expect(watchBadge(armed as never)).toBe("until:stop-armed")

    const keepArmed = { ...session("d", "w"), watchUntil: "READY", watchUntilAction: "keep" } as never
    expect(watchBadge(keepArmed as never)).toBe("until:keep-armed")

    const matched = { ...session("e", "w"), watchUntil: "READY", watchUntilAction: "stop", watchState: { state: "until-matched", matches: 1, pushes: 1, droppedLines: 0 } } as never
    expect(watchBadge(matched as never)).toBe("until-matched")

    const flooded = { ...session("f", "w"), watchFilter: "x", watchState: { state: "flood-suspended", matches: 0, pushes: 0, droppedLines: 101 } } as never
    expect(watchBadge(flooded as never)).toBe("flood-suspended")

    const exhausted = { ...session("g", "w"), watchFilter: "x", watchState: { state: "budget-exhausted", matches: 5, pushes: 30, droppedLines: 2 } } as never
    expect(watchBadge(exhausted as never)).toBe("budget-exhausted")

    // Terminal rows carry endReason; running rows never do.
    const timedOut = { ...session("h", "slow", "exited"), endReason: "timeout" } as never
    expect(commandBadges(timedOut as never)).toEqual(["timeout"])
    expect(formatCommandRow(timedOut as never)).toMatch(/timeout/)
    expect(formatCommandRow({ ...session("i", "run"), endReason: undefined } as never)).not.toMatch(/timeout|until/)
    expect(formatCommandRow(matched as never)).toMatch(/until-matched/)
  })

  it("formats watch detail (spec + counters) for the detail panel", () => {
    expect(formatWatchDetail(session("a", "dev"))).toBeUndefined()
    const c = {
      ...session("b", "w"),
      watchFilter: "ERROR",
      watchUntil: "READY",
      watchUntilAction: "keep",
      watchIgnoreCase: true,
      watchState: { state: "active", matches: 3, pushes: 1, droppedLines: 0 },
    } as never
    const detail = formatWatchDetail(c as never)!
    expect(detail).toMatch(/filter="ERROR"/)
    expect(detail).toMatch(/until="READY"/)
    expect(detail).toMatch(/action=keep/)
    expect(detail).toMatch(/ignore-case/)
    expect(detail).toMatch(/matches=3 pushes=1 dropped=0/)
  })

  it("parses quoted command arguments without invoking a shell", () => {
    expect(parseCommandLine(`printf "%s %s" 'hello world' done\\ now`)).toEqual([
      "printf",
      "%s %s",
      "hello world",
      "done now",
    ])
    expect(parseCommandLine(`echo "unterminated`)).toBeUndefined()
  })

  it("parses the :new tail with quoted boundaries preserved", () => {
    // The reported defect: `:new bash -c "echo hi"` must spawn bash with
    // argv ["-c", "echo hi"] — never ["-c", "echo", "hi"].
    expect(parseNewCommandTail(`new bash -c "echo hi"`)).toEqual(["bash", "-c", "echo hi"])
    expect(parseNewCommandTail(`:new bash -c "echo hi"`)).toEqual(["bash", "-c", "echo hi"])
    expect(parseNewCommandTail(`new printf '%s %s' 'hello world'`)).toEqual(["printf", "%s %s", "hello world"])
    expect(parseNewCommandTail(`new ls --color=always`)).toEqual(["ls", "--color=always"])
    expect(parseNewCommandTail(`new echo done\\ now`)).toEqual(["echo", "done now"])
    // Missing/empty tails and unbalanced quotes fail closed (usage text).
    expect(parseNewCommandTail(`new`)).toBeUndefined()
    expect(parseNewCommandTail(`:new   `)).toBeUndefined()
    expect(parseNewCommandTail(`new echo "unterminated`)).toBeUndefined()
    expect(parseNewCommandTail(`open something`)).toBeUndefined()
  })

  it("splits :new lines into spawn argv with quoting intact", () => {
    expect(parseNewCommand(`new bash -c "echo hi"`)).toEqual({ command: "bash", cmdArgs: ["-c", "echo hi"] })
    expect(parseNewCommand(`:new bash -c "echo hi"`)).toEqual({ command: "bash", cmdArgs: ["-c", "echo hi"] })
    expect(parseNewCommand(`new sh`)).toEqual({ command: "sh", cmdArgs: [] })
    expect(parseNewCommand(`new`)).toBeUndefined()
    expect(parseNewCommand(`new echo "unterminated`)).toBeUndefined()
  })
})
