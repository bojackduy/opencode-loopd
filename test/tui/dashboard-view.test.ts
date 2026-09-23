import { describe, expect, test } from "bun:test"
import {
  initialDashboardSelection,
  moveDashboardSelection,
  resolveDashboardOpen,
  switchDashboardView,
  toggleDashboardView,
  dashboardViewForKey,
  visibleOwnerCommands,
} from "../../src/tui/dashboard-view"
import { createCommandSession } from "../../src/domain/command-session"

function cmd(id: string, owner: string) {
  return createCommandSession({ id, title: id, command: "sh", cwd: "/tmp", ownerSessionID: owner })
}

function goal(id: string, worker?: string) {
  return { id, name: id, status: "active", workerSessionID: worker } as never
}

describe("dashboard-view", () => {
  test("toggle/switch preserve per-view indexes", () => {
    expect(toggleDashboardView("goals")).toBe("commands")
    expect(toggleDashboardView("commands")).toBe("goals")
    const sel = { ...initialDashboardSelection("goals"), goalIndex: 2, commandIndex: 3 }
    const switched = switchDashboardView(sel, "commands")
    expect(switched).toEqual({ view: "commands", goalIndex: 2, commandIndex: 3 })
  })

  test("h selects Goals and l selects Commands directionally (never toggle)", () => {
    expect(dashboardViewForKey("h")).toBe("goals")
    expect(dashboardViewForKey("l")).toBe("commands")
    // Idempotent: pressing the same key twice stays on the same tab.
    // Non-directional keys (including Tab, handled by toggle) resolve empty.
    expect(dashboardViewForKey("tab")).toBeUndefined()
    expect(dashboardViewForKey("j")).toBeUndefined()
    expect(dashboardViewForKey("H")).toBeUndefined()
    expect(dashboardViewForKey("L")).toBeUndefined()
    expect(dashboardViewForKey("")).toBeUndefined()
  })

  test("movement clamps to the active view only", () => {
    let sel = initialDashboardSelection("goals")
    sel = moveDashboardSelection(sel, "down", 3, 5)
    expect(sel).toEqual({ view: "goals", goalIndex: 1, commandIndex: 0 })
    sel = moveDashboardSelection(sel, "last", 3, 5)
    expect(sel.goalIndex).toBe(2)
    // Commands view moves commandIndex, keeps goalIndex.
    sel = switchDashboardView(sel, "commands")
    sel = moveDashboardSelection(sel, "down", 3, 5)
    expect(sel).toEqual({ view: "commands", goalIndex: 2, commandIndex: 1 })
    sel = moveDashboardSelection(sel, "up", 3, 5)
    expect(sel.commandIndex).toBe(0)
    // Empty lists clamp to 0, never negative.
    sel = moveDashboardSelection(initialDashboardSelection("commands"), "down", 0, 0)
    expect(sel.commandIndex).toBe(0)
  })

  test("o on a goal opens the worker session", () => {
    const target = resolveDashboardOpen(
      { goals: [goal("g1", "worker-9")], commands: [] },
      { view: "goals", goalIndex: 0, commandIndex: 0 },
      "owner-1",
      "ses-ret",
    )
    expect(target).toEqual({ kind: "goal", workerSessionID: "worker-9" })
  })

  test("o on a command opens the terminal route with owner scoping", () => {
    const target = resolveDashboardOpen(
      { goals: [], commands: [cmd("a", "owner-1"), cmd("b", "owner-2")] },
      { view: "commands", goalIndex: 0, commandIndex: 0 },
      "owner-1",
      "ses-ret",
    )
    expect(target).toEqual({
      kind: "command",
      data: { commandID: "a", ownerSessionID: "owner-1", returnSessionID: "ses-ret" },
    })
  })

  test("o with no selection or no goal worker is none (never cross-applies)", () => {
    expect(
      resolveDashboardOpen({ goals: [], commands: [] }, { view: "goals", goalIndex: 0, commandIndex: 0 }, "o", "s").kind,
    ).toBe("none")
    expect(
      resolveDashboardOpen(
        { goals: [goal("g1")], commands: [cmd("a", "owner-1")] },
        { view: "goals", goalIndex: 0, commandIndex: 0 },
        "owner-1",
        "ses-ret",
      ).kind,
    ).toBe("none")
    // Command view never resolves a goal target and vice versa.
    const cmdTarget = resolveDashboardOpen(
      { goals: [goal("g1", "w1")], commands: [cmd("a", "owner-1")] },
      { view: "commands", goalIndex: 0, commandIndex: 0 },
      "owner-1",
      "ses-ret",
    )
    expect(cmdTarget.kind).toBe("command")
  })

  test("commands view is owner-scoped", () => {
    const list = [cmd("a", "owner-1"), cmd("b", "owner-2")]
    expect(visibleOwnerCommands(list, "owner-1").map((c) => c.id)).toEqual(["a"])
    expect(visibleOwnerCommands(list, undefined)).toEqual([])
    expect(visibleOwnerCommands(undefined, "owner-1")).toEqual([])
  })
})
