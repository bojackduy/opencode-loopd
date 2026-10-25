/** @jsxImportSource @opentui/solid */
import { afterEach, describe, expect, it } from "bun:test"
import { promises as fs } from "fs"
import os from "os"
import path from "path"
import { testRender } from "@opentui/solid"
import { LoopDashboard } from "../../src/tui/dashboard"
import { parseCommand, commandHelp } from "../../src/tui/command-parser"
import { mutateState } from "../../src/infrastructure/state-repository"

const THEME = {
  primary: "#fff",
  secondary: "#fff",
  accent: "#fff",
  text: "#fff",
  textMuted: "#888",
  success: "#0f0",
  warning: "#ff0",
  error: "#f00",
  info: "#0ff",
  background: "#000",
  backgroundPanel: "#111",
  backgroundElement: "#222",
  backgroundMenu: "#333",
  border: "#444",
}

const setups: Array<{ renderer: { destroy(): void } }> = []
afterEach(() => {
  while (setups.length > 0) setups.pop()!.renderer.destroy()
})

function fakeApi() {
  return {
    theme: { current: THEME },
    mode: { push: () => () => {} },
    renderer: { currentFocusedRenderable: undefined },
    client: {},
    event: { on: () => () => {} },
    ui: {
      dialog: { open: true, replace: () => {}, clear: () => {}, setSize: () => {} },
    },
    route: {
      navigate: () => {},
      current: { name: "session", params: { sessionID: "ses-owner" } },
    },
  }
}

async function seedDir(fences: boolean): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "loopd-dashboard-release-"))
  const goal = {
    id: "goal-1",
    name: "goal-one",
    status: "active",
    objective: "do things",
    ownerSessionID: "ses-owner",
    workerSessionID: "worker-1",
    config: {},
    tokensUsed: 0,
    costUsed: 0,
    timeUsedSeconds: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
  const workspaceCalls = fences
    ? [{ callID: "call-1", sessionID: "ses-owner", paths: [], uncontrolled: true, at: new Date().toISOString() }]
    : []
  await mutateState(dir, "seed", async (state) => ({
    ...state,
    goals: [goal as never],
    runtimes: [],
    commands: [],
    workspaceCalls: workspaceCalls as never,
  }))
  return dir
}

describe(":release verb parsing", () => {
  it("parses a bare release as inspect-only", () => {
    expect(parseCommand("release")).toMatchObject({ command: "release", args: {}, positional: [] })
  })

  it("parses --call, --goal and --session selectors", () => {
    expect(parseCommand("release --call call-1 --goal goal-1 --session ses-1").args).toEqual({
      call: "call-1",
      goal: "goal-1",
      session: "ses-1",
    })
  })

  it("documents the verb and the W key in help", () => {
    const help = commandHelp()
    expect(help).toContain(":release")
    expect(help).toContain("W release fence")
  })
})

describe("LoopDashboard workspace fences", () => {
  it("shows the live fence count in the header", async () => {
    const dir = await seedDir(true)
    try {
      const setup = await testRender(() => (
        <LoopDashboard api={fakeApi() as never} directory={dir} ownerSessionID="ses-owner" />
      ))
      setups.push(setup as never)
      await setup.flush()
      await setup.waitFor(() => setup.captureCharFrame().includes("1 fence"))
      expect(setup.captureCharFrame()).toContain("1 fence")
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it("? shows the release escape hatch", async () => {
    const dir = await seedDir(true)
    try {
      const setup = await testRender(() => (
        <LoopDashboard api={fakeApi() as never} directory={dir} ownerSessionID="ses-owner" />
      ))
      setups.push(setup as never)
      await setup.flush()
      setup.mockInput.pressKey("?")
      await setup.waitFor(() => setup.captureCharFrame().includes("W release"))
      expect(setup.captureCharFrame()).toContain("W release")
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it("W on the Commands tab is refused without touching the command", async () => {
    const dir = await seedDir(true)
    try {
      const setup = await testRender(() => (
        <LoopDashboard api={fakeApi() as never} directory={dir} initialView="commands" ownerSessionID="ses-owner" />
      ))
      setups.push(setup as never)
      await setup.flush()
      setup.mockInput.pressKey("W")
      await setup.waitFor(() => setup.captureCharFrame().includes("Goals tab"))
      expect(setup.captureCharFrame()).toContain("Goal controls need the Goals tab")
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it("W with no fences reports that nothing is blocked", async () => {
    const dir = await seedDir(false)
    try {
      const setup = await testRender(() => (
        <LoopDashboard api={fakeApi() as never} directory={dir} ownerSessionID="ses-owner" />
      ))
      setups.push(setup as never)
      await setup.flush()
      await setup.waitFor(() => setup.captureCharFrame().includes("goal-one"))
      setup.mockInput.pressKey("W")
      await setup.waitFor(() => setup.captureCharFrame().includes("No workspace fences"))
      expect(setup.captureCharFrame()).toContain("No workspace fences to release")
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})
