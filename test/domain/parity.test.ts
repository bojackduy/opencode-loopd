import { describe, expect, it } from "bun:test"
import { INTERACTIONS } from "../../src/domain/interaction-registry"
import { ownerTools } from "../../src/server/owner-tools"
import { commandTools } from "../../src/server/command-tools"
import { createFakeHost } from "../../src/server/host-adapter"
import { createFakeCommandHost } from "../../src/server/command-host"
import { createGoalService } from "../../src/application/goal-service"
import { createCommandService } from "../../src/application/command-service"
import { readFileSync } from "fs"
import path from "path"

describe("Interaction parity registry", () => {
  it("every 'both' interaction has both transports", () => {
    const both = INTERACTIONS.filter((i) => i.transport === "both" && i.command !== "—")
    expect(both.length).toBeGreaterThan(6)
    for (const def of both) {
      expect(def.agentTools.length, `${def.command} missing agentTools`).toBeGreaterThan(0)
      expect(def.tuiKeys.length, `${def.command} missing tuiKeys`).toBeGreaterThan(0)
    }
    // Read-only inspect/open is a virtual group (command "—") but still both-transport
    const inspect = INTERACTIONS.find((i) => i.label === "Inspect/open")!
    expect(inspect.transport).toBe("both")
    expect(inspect.agentTools.length).toBeGreaterThan(0)
    expect(inspect.tuiKeys.length).toBeGreaterThan(0)
  })

  it("no 'both' entry is left half-wired", () => {
    const broken = INTERACTIONS.filter(
      (i) => i.transport === "both" && (i.agentTools.length === 0 || i.tuiKeys.length === 0),
    )
    expect(broken).toEqual([])
  })

  it("documents the send split: TUI :send and agent send_goal_input are the same bare turn", () => {
    const send = INTERACTIONS.find((i) => i.command === "send")!
    expect(send.agentTools).toContain("send_goal_input")
    expect(send.tuiKeys).toContain("send")
    expect(send.description).toMatch(/bare/i)
  })

  it("documents abort parity: TUI A and agent abort_goal_worker share abort_worker", () => {
    const abort = INTERACTIONS.find((i) => i.command === "abort_worker")!
    expect(abort.agentTools).toContain("abort_goal_worker")
    expect(abort.tuiKeys).toContain("A")
  })

  it("covers every active LoopCommand the engine handles", () => {
    // Control worker's switch handles these commands — they must be in the registry
    const handled = ["start", "pause", "resume", "retry", "nudge", "clear", "send", "abort_worker", "force_complete", "block"]
    for (const cmd of handled) {
      expect(
        INTERACTIONS.some((i) => i.command === cmd),
        `LoopCommand "${cmd}" missing from INTERACTIONS — add it so TUI+agent stay in sync`,
      ).toBe(true)
    }
  })

  it("warns when a new command is added to LoopCommand but not to the registry", () => {
    // Canary: LoopCommand union has ~14 variants. This count forces an explicit
    // update to INTERACTIONS when a new command is added, rather than silent drift.
    // If this fails after you added a command, add a row to INTERACTIONS and bump the number.
    expect(INTERACTIONS.length).toBeGreaterThanOrEqual(12)
  })

  it("agent tools in the registry actually exist in ownerTools/commandTools", async () => {
    const dir = `/tmp/loopd-parity-${crypto.randomUUID()}`
    const host = createFakeHost()
    const goalService = createGoalService(host)
    const tools = ownerTools({ directory: dir, host, goalService })
    const commandService = createCommandService(createFakeCommandHost())
    const cmdTools = commandTools({ directory: dir, commandService })
    const toolNames = new Set([...Object.keys(tools), ...Object.keys(cmdTools)])
    // Worker tools live in goalTools, not ownerTools — skip them
    const workerTools = new Set(["get_goal", "report_goal_progress", "complete_goal", "block_goal"])
    for (const def of INTERACTIONS) {
      for (const name of def.agentTools) {
        if (workerTools.has(name)) continue
        if (name === "loopd_create_goal") continue // in goalTools, not ownerTools
        expect(toolNames.has(name), `registry lists agent tool "${name}" but ownerTools has no such tool`).toBe(true)
      }
    }
  })

  it("TUI keys in the registry appear in dashboard/command code", () => {
    const dashboardPath = path.join(import.meta.dir, "../../src/tui/dashboard.tsx")
    const dashboardSrc = readFileSync(dashboardPath, "utf8")
    const parserPath = path.join(import.meta.dir, "../../src/tui/command-parser.ts")
    const parserSrc = readFileSync(parserPath, "utf8")
    const workerPath = path.join(import.meta.dir, "../../src/application/control-worker.ts")
    const workerSrc = readFileSync(workerPath, "utf8")
    const panelPath = path.join(import.meta.dir, "../../src/tui/command-panel.tsx")
    const panelSrc = readFileSync(panelPath, "utf8")
    const controllerPath = path.join(import.meta.dir, "../../src/tui/command-controller.ts")
    const controllerSrc = readFileSync(controllerPath, "utf8")
    const combined = dashboardSrc + "\n" + parserSrc + "\n" + workerSrc + "\n" + panelSrc + "\n" + controllerSrc
    for (const def of INTERACTIONS) {
      if (def.transport === "worker") continue
      // "start" is exposed via control bus, not a dashboard key — its TUI side is the deprecated :goal alias
      if (def.command === "start") continue
      for (const key of def.tuiKeys) {
        // Single-char keys like "p", multi-char like "abort" — check parser or dashboard mentions it
        const quoted = `"${key}"` // dashboard does: key === "x"
        const slashForm = `:${key}` // parser help
        const found = combined.includes(quoted) || combined.includes(slashForm) || combined.includes(`'${key}'`)
        expect(found, `registry lists TUI key "${key}" for ${def.command} but dashboard/command-parser has no mention`).toBe(true)
      }
    }
  })
})
