import { describe, expect, test } from "bun:test"
import {
  TERMINAL_ROUTE_NAME,
  filterCommandsByOwner,
  isTerminalRouteConsistent,
  resolveOpenTarget,
  terminalRoutePayload,
  validateTerminalRouteData,
} from "../../src/tui/terminal-route"
import { createCommandSession } from "../../src/domain/command-session"

function cmd(id: string, owner: string) {
  return createCommandSession({ id, title: id, command: "sh", cwd: "/tmp", ownerSessionID: owner })
}

describe("terminal-route", () => {
  test("route name is stable", () => {
    expect(TERMINAL_ROUTE_NAME).toBe("opencode.loopd.terminal")
  })

  test("valid data passes", () => {
    const r = validateTerminalRouteData({ commandID: "c1", ownerSessionID: "o1", returnSessionID: "s1" })
    expect(r).toEqual({ ok: true, data: { commandID: "c1", ownerSessionID: "o1", returnSessionID: "s1" } })
  })

  test("missing/invalid data fails closed", () => {
    for (const raw of [
      undefined,
      null,
      "c1",
      [],
      {},
      { commandID: "", ownerSessionID: "o", returnSessionID: "s" },
      { commandID: "c", ownerSessionID: "", returnSessionID: "s" },
      { commandID: "c", ownerSessionID: "o", returnSessionID: "" },
      { commandID: "c", ownerSessionID: "o" },
    ]) {
      const r = validateTerminalRouteData(raw)
      expect(r.ok).toBe(false)
    }
  })

  test("payload round-trips through validation", () => {
    const payload = terminalRoutePayload("c1", "o1", "s1")
    expect(validateTerminalRouteData(payload)).toEqual({
      ok: true,
      data: { commandID: "c1", ownerSessionID: "o1", returnSessionID: "s1" },
    })
  })

  test("owner filtering excludes cross-owner commands", () => {
    const list = [cmd("a", "owner-1"), cmd("b", "owner-2"), cmd("c", "owner-1")]
    expect(filterCommandsByOwner(list, "owner-1").map((c) => c.id)).toEqual(["a", "c"])
    expect(filterCommandsByOwner(list, "owner-2").map((c) => c.id)).toEqual(["b"])
    expect(filterCommandsByOwner(list, undefined)).toEqual([])
  })

  test("o on goal opens worker session", () => {
    expect(
      resolveOpenTarget({
        selection: { kind: "goal", workerSessionID: "worker-1" },
        ownerSessionID: "o1",
        returnSessionID: "s1",
      }),
    ).toEqual({ kind: "goal", workerSessionID: "worker-1" })
  })

  test("o on goal without worker session is none", () => {
    const r = resolveOpenTarget({
      selection: { kind: "goal" },
      ownerSessionID: "o1",
      returnSessionID: "s1",
    })
    expect(r.kind).toBe("none")
  })

  test("o on command builds terminal route data", () => {
    expect(
      resolveOpenTarget({
        selection: { kind: "command", commandID: "c9" },
        ownerSessionID: "o1",
        returnSessionID: "s1",
      }),
    ).toEqual({ kind: "command", data: { commandID: "c9", ownerSessionID: "o1", returnSessionID: "s1" } })
  })

  test("o on command without owner/return never opens", () => {
    expect(
      resolveOpenTarget({ selection: { kind: "command", commandID: "c9" }, ownerSessionID: undefined, returnSessionID: "s1" }).kind,
    ).toBe("none")
    expect(
      resolveOpenTarget({ selection: { kind: "command", commandID: "c9" }, ownerSessionID: "o1", returnSessionID: undefined }).kind,
    ).toBe("none")
    expect(
      resolveOpenTarget({ selection: null, ownerSessionID: "o1", returnSessionID: "s1" }).kind,
    ).toBe("none")
  })

  test("dashboard flow is consistent only when owner and return match", () => {
    // Route data is not an auth token, but the supported dashboard flow
    // always navigates with owner === return === current session.
    expect(isTerminalRouteConsistent({ commandID: "c", ownerSessionID: "s", returnSessionID: "s" })).toBe(true)
    expect(isTerminalRouteConsistent({ commandID: "c", ownerSessionID: "o1", returnSessionID: "s1" })).toBe(false)
  })
})
