/** @jsxImportSource @opentui/solid */
import { afterEach, describe, expect, it } from "bun:test"
import { promises as fs } from "fs"
import path from "path"
import os from "os"
import { testRender } from "@opentui/solid"
import { LoopDashboard } from "../../src/tui/dashboard"
import { TERMINAL_ROUTE_NAME } from "../../src/tui/terminal-route"
import { mutateState } from "../../src/infrastructure/state-repository"
import { createCommandSession } from "../../src/domain/command-session"

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

function fakeApi(navigated: Array<{ name: string; params?: unknown }>, cleared: { count: number }) {
  return {
    theme: { current: THEME },
    mode: { push: () => () => {} },
    renderer: { currentFocusedRenderable: undefined },
    client: {},
    event: { on: () => () => {} },
    ui: {
      dialog: {
        open: true,
        replace: () => {},
        clear: () => {
          cleared.count += 1
        },
        setSize: () => {},
      },
    },
    route: {
      navigate: (name: string, params?: unknown) => {
        navigated.push({ name, params })
      },
      current: { name: "session", params: { sessionID: "ses-owner" } },
    },
  }
}

async function seedDir(): Promise<string> {
  const dir = path.join(os.tmpdir(), `loopd-dashboard-test-${crypto.randomUUID()}`)
  await fs.mkdir(dir, { recursive: true })
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
  // Realistic dashboard flow: the current route session owns the commands
  // it lists (owner === return === current session). Cross-session routes
  // fail closed and never subscribe or write.
  const owned = { ...createCommandSession({ id: "cmd-owned", title: "owned-cmd", command: "sh", cwd: "/tmp", ownerSessionID: "ses-owner" }), status: "running" }
  const foreign = { ...createCommandSession({ id: "cmd-foreign", title: "foreign-cmd", command: "sh", cwd: "/tmp", ownerSessionID: "owner-2" }), status: "running" }
  await mutateState(dir, "seed", async (s) => ({ ...s, goals: [goal as never], runtimes: [], commands: [owned as never, foreign as never] }))
  return dir
}

describe("LoopDashboard shared Goals/Commands (mounted)", () => {
  it("renders tabs; Tab switches between Goals and Commands", async () => {
    const dir = await seedDir()
    const navigated: Array<{ name: string; params?: unknown }> = []
    const cleared = { count: 0 }
    const setup = await testRender(() => (
      <LoopDashboard api={fakeApi(navigated, cleared) as never} directory={dir} ownerSessionID="ses-owner" />
    ))
    setups.push(setup as never)
    await setup.flush()
    await setup.waitFor(() => setup.captureCharFrame().includes("goal-one"))
    expect(setup.captureCharFrame()).toContain("[Goals]")
    expect(setup.captureCharFrame()).toContain("[Commands]")
    setup.mockInput.pressTab()
    await setup.waitFor(() => setup.captureCharFrame().includes("owned-cmd"))
    const frame = setup.captureCharFrame()
    expect(frame).toContain("owned-cmd")
    // Owner filtering: the foreign session's command never renders.
    expect(frame).not.toContain("foreign-cmd")
    // Back to goals with h.
    setup.mockInput.pressKey("h")
    await setup.waitFor(() => setup.captureCharFrame().includes("goal-one"))
  })

  it("/commands entry opens focused on Commands", async () => {
    const dir = await seedDir()
    const navigated: Array<{ name: string; params?: unknown }> = []
    const cleared = { count: 0 }
    const setup = await testRender(() => (
      <LoopDashboard
        api={fakeApi(navigated, cleared) as never}
        directory={dir}
        initialView="commands"
        ownerSessionID="ses-owner"
      />
    ))
    setups.push(setup as never)
    await setup.flush()
    await setup.waitFor(() => setup.captureCharFrame().includes("owned-cmd"))
    expect(setup.captureCharFrame()).not.toContain("foreign-cmd")
  })

  it("o on a command closes the popup and navigates to the terminal route", async () => {
    const dir = await seedDir()
    const navigated: Array<{ name: string; params?: unknown }> = []
    const cleared = { count: 0 }
    const setup = await testRender(() => (
      <LoopDashboard
        api={fakeApi(navigated, cleared) as never}
        directory={dir}
        initialView="commands"
        ownerSessionID="ses-owner"
      />
    ))
    setups.push(setup as never)
    await setup.flush()
    await setup.waitFor(() => setup.captureCharFrame().includes("owned-cmd"))
    setup.mockInput.pressKey("o")
    await setup.waitFor(() => navigated.length === 1)
    expect(navigated[0]).toEqual({
      name: TERMINAL_ROUTE_NAME,
      params: { commandID: "cmd-owned", ownerSessionID: "ses-owner", returnSessionID: "ses-owner" },
    })
    expect(cleared.count).toBe(1)
  })

  it("o on a goal still opens the native worker session", async () => {
    const dir = await seedDir()
    const navigated: Array<{ name: string; params?: unknown }> = []
    const cleared = { count: 0 }
    const setup = await testRender(() => (
      <LoopDashboard api={fakeApi(navigated, cleared) as never} directory={dir} ownerSessionID="ses-owner" />
    ))
    setups.push(setup as never)
    await setup.flush()
    await setup.waitFor(() => setup.captureCharFrame().includes("goal-one"))
    setup.mockInput.pressKey("o")
    await setup.waitFor(() => navigated.length === 1)
    expect(navigated[0]).toEqual({ name: "session", params: { sessionID: "worker-1" } })
    expect(cleared.count).toBe(1)
  })

  it("goal controls do not fire on the Commands tab", async () => {
    const dir = await seedDir()
    const navigated: Array<{ name: string; params?: unknown }> = []
    const cleared = { count: 0 }
    const setup = await testRender(() => (
      <LoopDashboard
        api={fakeApi(navigated, cleared) as never}
        directory={dir}
        initialView="commands"
        ownerSessionID="ses-owner"
      />
    ))
    setups.push(setup as never)
    await setup.flush()
    await setup.waitFor(() => setup.captureCharFrame().includes("owned-cmd"))
    // "p" (pause) on the Commands tab must not navigate or clear anywhere.
    setup.mockInput.pressKey("p")
    await setup.flush()
    expect(navigated).toEqual([])
    expect(cleared.count).toBe(0)
    expect(setup.captureCharFrame()).toContain("Goals tab")
  })

  it("l selects Commands and h selects Goals directionally (repeat presses stay)", async () => {
    const dir = await seedDir()
    const navigated: Array<{ name: string; params?: unknown }> = []
    const cleared = { count: 0 }
    const setup = await testRender(() => (
      <LoopDashboard api={fakeApi(navigated, cleared) as never} directory={dir} ownerSessionID="ses-owner" />
    ))
    setups.push(setup as never)
    await setup.flush()
    await setup.waitFor(() => setup.captureCharFrame().includes("goal-one"))
    // l moves to Commands…
    setup.mockInput.pressKey("l")
    await setup.waitFor(() => setup.captureCharFrame().includes("owned-cmd"))
    // …and pressing l again stays on Commands (directional, never a toggle).
    setup.mockInput.pressKey("l")
    await setup.flush()
    expect(setup.captureCharFrame()).toContain("owned-cmd")
    // h moves back to Goals and stays there on repeat.
    setup.mockInput.pressKey("h")
    await setup.waitFor(() => setup.captureCharFrame().includes("goal-one"))
    setup.mockInput.pressKey("h")
    await setup.flush()
    expect(setup.captureCharFrame()).toContain("goal-one")
  })
})
