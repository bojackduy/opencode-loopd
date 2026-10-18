/** @jsxImportSource @opentui/solid */
import { afterEach, describe, expect, it, spyOn } from "bun:test"
import { promises as fs } from "fs"
import path from "path"
import os from "os"
import { testRender } from "@opentui/solid"
import { LoopDashboard } from "../../src/tui/dashboard"
import { TERMINAL_ROUTE_NAME } from "../../src/tui/terminal-route"
import { mutateState } from "../../src/infrastructure/state-repository"
import { createCommandSession } from "../../src/domain/command-session"
import { ScrollBoxRenderable, TextRenderable } from "@opentui/core"
import { createRuntimeState, type GoalRuntimeState } from "../../src/domain/runtime"
import { createGoal } from "../../src/domain/goal"
import plugin from "../../src/tui/plugin"
import { TERMINAL_INPUT_MODE } from "../../src/tui/terminal-view"
import { readState } from "../../src/infrastructure/state-repository"

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

/** Same as seedDir plus one finished owned command (hidden by default). */
async function seedDirWithFinishedCommand(): Promise<string> {
  const dir = await seedDir()
  const finished = {
    ...createCommandSession({ id: "cmd-done", title: "done-cmd", command: "true", cwd: "/tmp", ownerSessionID: "ses-owner" }),
    status: "exited",
    exitCode: 0,
  }
  await mutateState(dir, "seed-finished", async (s) => ({
    ...s,
    commands: [finished as never, ...(s.commands ?? [])],
  }))
  return dir
}

describe("LoopDashboard shared Goals/Commands (mounted)", () => {
  for (const entry of ["loop", "commands", "panel"] as const) {
    it(`v2 ${entry} opens the registered terminal from the Commands selection and detaches without termination`, async () => {
      const dir = await seedDir()
      let dialog: (() => any) | undefined
      let layer: any
      let page: any
      const slots: any[] = []
      const destinations: any[] = []
      const modes: string[] = []
      let panelClosed = 0
      let dialogCleared = 0
      const panel = { name: "opencode.loopd.commands", sessionID: "ses-owner", focused: false }
      let current: any = { type: "session", sessionID: "ses-owner" }
      const ctx = {
        location: { directory: dir }, theme: {}, renderer: {}, client: {},
        data: {
          location: { default: () => ({ directory: dir }) },
          session: { get: () => ({ location: { directory: dir } }) },
          on: () => () => {},
        },
        keymap: {
          layer: (get: () => any) => { layer = get() },
          mode: { push: (mode: string) => { modes.push(mode); return () => { modes.splice(modes.indexOf(mode), 1) } } },
        },
        ui: {
          router: {
            current: () => current,
            register: (route: any) => { page = route; return () => {} },
            navigate: (destination: any) => {
              if (destination.type === "plugin") expect(destination.name).toBe(page.name)
              destinations.push(destination)
              current = destination
            },
          },
          slot: (slot: any) => { slots.push(slot); return () => {} },
          panel: { open: () => false, close: () => { panelClosed++ } },
          dialog: {
            show: (render: () => any) => { dialog = render }, set: () => {},
            clear: () => { dialogCleared++ },
          },
        },
      }
      const cleanup = plugin.setup(ctx as any)
      try {
        slots.find((slot) => slot.append === "app").render()
        if (entry === "panel") {
          dialog = () => slots.find((slot) => slot.append === "session.panel").render(panel)
        } else layer.commands[entry === "loop" ? 0 : 1].run()
        const dashboard = await testRender(() => dialog!(), { width: 120, height: 40 })
        setups.push(dashboard)
        await dashboard.flush()
        await dashboard.waitForFrame((frame) => frame.includes(entry === "loop" ? "goal-one" : "owned-cmd"))
        if (entry === "loop") {
          dashboard.mockInput.pressKey("l")
          await dashboard.waitFor(() => dashboard.captureCharFrame().includes("owned-cmd"))
        }
        expect(dashboard.captureCharFrame()).not.toContain("foreign-cmd")
        // The dashboard focuses its input after mount; flush runs that timer
        // before dispatching a key, including the session.panel entrypoint.
        await dashboard.flush()
        if (entry === "panel") {
          dashboard.mockInput.pressKey("o")
          await dashboard.flush()
          expect(destinations).toEqual([])
          panel.focused = true
        }
        dashboard.mockInput.pressKey("o")
        await dashboard.waitFor(() => dialogCleared > 0)
        expect(destinations).toEqual([{
          type: "plugin", name: TERMINAL_ROUTE_NAME,
          data: { commandID: "cmd-owned", ownerSessionID: "ses-owner", returnSessionID: "ses-owner" },
        }])
        expect(panelClosed).toBe(1)
        expect(dialogCleared).toBe(1)
        dashboard.renderer.destroy()
        setups.pop()

        // Mount the actual registered V2 page, not a V1 route mock or a
        // substitute TerminalView. Its real session driver loads the command.
        const terminal = await testRender(() => page.render({ data: current.data }), { width: 120, height: 40 })
        setups.push(terminal)
        await terminal.flush()
        await terminal.waitFor(() => terminal.captureCharFrame().includes("owned-cmd"), { maxPasses: 2000 })
        expect(modes).toContain(TERMINAL_INPUT_MODE)
        await terminal.mockInput.pressKey("]", { ctrl: true })
        await terminal.flush()
        expect(destinations.at(-1)).toEqual({ type: "session", sessionID: "ses-owner" })
        terminal.renderer.destroy()
        setups.pop()
        expect(modes).not.toContain(TERMINAL_INPUT_MODE)
        expect((await readState(dir)).commands?.find((command) => command.id === "cmd-owned")?.status).toBe("running")
      } finally {
        while (setups.length) setups.pop()!.renderer.destroy()
        if (typeof cleanup === "function") cleanup()
        await fs.rm(dir, { recursive: true, force: true })
      }
    })
  }

  for (const view of ["goals", "commands", "panel", "terminal", "home"] as const) {
    it(`v2 opens ${view} from the current session project instead of the setup location`, async () => {
      const startup = await fs.mkdtemp(path.join(os.tmpdir(), "loopd-v2-startup-"))
      const current = await seedDir()
      let render: (() => any) | undefined
      let layer: any
      let terminalRoute: any
      const slots: any[] = []
      let session: { location: { directory: string } } | undefined
      let defaultDirectory = startup
      const ctx = {
        location: { directory: startup },
        theme: {}, renderer: { currentFocusedRenderable: undefined }, client: {},
        data: {
          location: { default: () => ({ directory: defaultDirectory }) },
          session: { get: (id: string) => id === "ses-owner" ? session : { location: { directory: startup } } }, on: () => () => {},
        },
        keymap: { mode: { push: () => () => {} }, layer: (get: () => any) => { layer = get() } },
        ui: {
          router: {
            current: () => view === "home" ? { type: "home" } : ({ type: "session", sessionID: view === "panel" || view === "terminal" ? "ses-other" : "ses-owner" }),
            register: (route: any) => { terminalRoute = route; return () => {} }, navigate: () => {},
          },
          slot: (slot: any) => { slots.push(slot); return () => {} },
          panel: { open: () => false, close: () => {} },
          dialog: { show: (component: () => any) => { render = component }, clear: () => {}, set: () => {} },
        },
      }
      const cleanup = plugin.setup(ctx as any)
      try {
        // Session metadata becomes available after plugin setup. Default and
        // plugin locations intentionally stay on the original project.
        session = { location: { directory: current } }
        if (view === "home") defaultDirectory = current
        slots.find((slot) => slot.append === "app").render()
        if (view === "panel") render = () => slots.find((slot) => slot.append === "session.panel").render({ name: "opencode.loopd.commands", sessionID: "ses-owner", focused: true })
        else if (view === "terminal") render = () => terminalRoute.render({ data: { commandID: "cmd-owned", ownerSessionID: "ses-owner", returnSessionID: "ses-owner" } })
        else layer.commands[view === "goals" || view === "home" ? 0 : 1].run()
        const setup = await testRender(() => render!(), { width: 120, height: 40 })
        setups.push(setup)
        const expected = view === "goals" || view === "home" ? "goal-one" : "owned-cmd"
        const deadline = Date.now() + 2000
        do {
          await setup.renderOnce()
          if (setup.captureCharFrame().includes(expected)) break
          await Bun.sleep(10)
        } while (Date.now() < deadline)
        expect(setup.captureCharFrame()).toContain(expected)
      } finally {
        while (setups.length) setups.pop()!.renderer.destroy()
        if (typeof cleanup === "function") cleanup()
        await fs.rm(startup, { recursive: true, force: true })
        await fs.rm(current, { recursive: true, force: true })
      }
    })
  }
  for (const fixture of [
    { index: 0, name: "goals", expected: "goal-one", resumed: false },
    { index: 1, name: "commands", expected: "owned-cmd", resumed: false },
    { index: 0, name: "resumed session goals", expected: "goal-one", resumed: true },
    { index: 1, name: "resumed session commands", expected: "owned-cmd", resumed: true },
  ]) {
    it(`v1 opens the current project's ${fixture.name} instead of its startup directory`, async () => {
      const startup = await fs.mkdtemp(path.join(os.tmpdir(), "loopd-dashboard-startup-"))
      const current = await seedDir()
      let dialog: (() => any) | undefined
      let layer: any
      const api = {
        ...fakeApi([], { count: 0 }),
        state: { path: { directory: startup }, session: { get: (_id: string): { directory: string } | undefined => undefined } },
        keymap: { registerLayer: (value: any) => { layer = value } },
        lifecycle: { onDispose: () => {} },
      }
      api.ui.dialog.replace = ((render: () => any) => { dialog = render }) as any
      try {
        await plugin.tui(api as any)
        if (fixture.resumed) api.state.session.get = () => ({ directory: current })
        else api.state.path.directory = current
        layer.commands[fixture.index].run()
        const setup = await testRender(() => dialog!(), { width: 120, height: 40 })
        setups.push(setup)
        const deadline = Date.now() + 2000
        let frame = ""
        do {
          await setup.renderOnce()
          frame = setup.captureCharFrame()
          if (frame.includes(fixture.expected)) break
          await Bun.sleep(10)
        } while (Date.now() < deadline)
        expect(frame).toContain(fixture.expected)
      } finally {
        while (setups.length) setups.pop()!.renderer.destroy()
        await fs.rm(startup, { recursive: true, force: true })
        await fs.rm(current, { recursive: true, force: true })
      }
    })
  }
  for (const fixture of [
    { label: "REQUESTED", patch: {}, active: false },
    { label: "SENDING", patch: { activePromptDispatchAt: new Date().toISOString() }, active: false },
    { label: "AWAITING", patch: { activePromptAcceptedAt: new Date().toISOString() }, active: false },
    { label: "PROMPT SEEN", patch: { activePromptObservedAt: new Date().toISOString() }, active: false },
    { label: "RUNNING", patch: { activePromptObservedAt: new Date().toISOString(), activeAssistantMessageID: "assistant-current" }, active: true },
    { label: "STALE", patch: { leaseExpiresAt: new Date(Date.now() - 60_000).toISOString(), activeAssistantMessageID: "assistant-old" }, active: false },
    { label: "UNCONFIRMED", patch: { unknownStatusCount: 1, activeAssistantMessageID: "assistant-current" }, active: false },
    { label: "QUEUED", patch: { phase: "queued" }, active: false },
    { label: "FINISHING", patch: { activeAssistantCompletedAt: new Date().toISOString() }, active: false },
    { label: "PROMPT SEEN", patch: { activePromptObservedAt: new Date().toISOString(), activeAssistantMessageID: "assistant-old", lastWorkerStatus: "idle" }, active: false },
  ] satisfies Array<{ label: string; patch: Partial<GoalRuntimeState>; active: boolean }>) {
    it(`worker activity evidence renders ${fixture.label}, not merely its stored running phase`, async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "loopd-dashboard-activity-test-"))
      const goal = createGoal({ id: "activity-goal" as never, name: "activity-fixture", objective: "fixture", ownerSessionID: "ses-owner", status: "active", config: {} })
      const runtime: GoalRuntimeState = {
        ...createRuntimeState(goal.id), phase: "running", activeRunID: "run-current" as never,
        activePromptMessageID: "msg_current", leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        ...fixture.patch,
      }
      await mutateState(dir, "test.activity", async (state) => ({ ...state, goals: [goal], runtimes: [runtime] }))
      const setup = await testRender(() => <LoopDashboard api={fakeApi([], { count: 0 }) as never} directory={dir} ownerSessionID="ses-owner" />, { width: 160, height: 45 })
      setups.push(setup as never)
      try {
        await setup.waitForFrame((frame) => frame.includes("activity-fixture"))
        const frame = setup.captureCharFrame()
        expect(frame).toContain(fixture.label)
        expect(frame).toContain(`${fixture.active ? 1 : 0} observed active`)
        if (!fixture.active) expect(frame).not.toContain("worker acting now")
      } finally {
        setup.renderer.destroy()
        setups.pop()
        await fs.rm(dir, { recursive: true, force: true })
      }
    })
  }

  for (const view of ["goals", "commands"] as const) {
    it(`${view}: long lists follow j/k/g/G and wheel scrolls the list, not row text`, async () => {
      const dir = await seedDir()
      await mutateState(dir, "seed-long-list", async (s) => ({
        ...s,
        goals: Array.from({ length: 25 }, (_, i) => ({ ...s.goals[0]!, id: `goal-${i}`, name: `goal-${i} ${"long-title-".repeat(30)}` })),
        commands: Array.from({ length: 25 }, (_, i) => ({ ...s.commands![0]!, id: `cmd-${i}`, title: `cmd-${i} ${"long-title-".repeat(30)}`, args: ["argument-".repeat(50)] })),
      }))
      const setup = await testRender(() => (
        <LoopDashboard api={fakeApi([], { count: 0 }) as never} directory={dir} initialView={view} ownerSessionID="ses-owner" />
      ), { width: 100, height: 50 })
      setups.push(setup as never)
      await setup.waitFor(() => setup.captureCharFrame().includes(view === "goals" ? "goal-0" : "cmd-0"))
      const findList = (): ScrollBoxRenderable => {
        const search = (node: any): ScrollBoxRenderable | undefined => {
          if (node instanceof ScrollBoxRenderable) return node
          for (const child of node.getChildren()) { const found = search(child); if (found) return found }
        }
        return search(setup.renderer.root)!
      }
      const prefix = view === "goals" ? "goal" : "cmd"
      const selectedVisible = (index: number) => {
        const list = findList()
        const row = list.getChildren()[index]!
        expect(row.y).toBeGreaterThanOrEqual(list.viewport.y)
        expect(row.y + row.height).toBeLessThanOrEqual(list.viewport.y + list.viewport.height)
        expect(setup.captureCharFrame()).toContain(`▶ ${view === "goals" ? "● " : ""}${prefix}-${index}`)
      }
      for (let i = 1; i <= 12; i++) { setup.mockInput.pressKey("j"); await setup.flush(); selectedVisible(i) }
      setup.mockInput.pressKey("G"); await setup.flush(); selectedVisible(24)
      setup.mockInput.pressKey("k"); await setup.flush(); selectedVisible(23)
      setup.mockInput.pressKey("g"); await setup.flush(); selectedVisible(0)
      const list = findList()
      const text = list.getChildren()[0]!.getChildren()[0] as TextRenderable
      await setup.mockMouse.scroll(text.x + 3, text.y, "right")
      await setup.flush()
      expect(text.scrollX).toBe(0)
      expect(list.scrollLeft).toBe(0)
      await setup.mockMouse.scroll(text.x + 3, text.y, "down")
      await setup.flush()
      expect(list.scrollTop).toBeGreaterThan(0)
      expect(setup.captureCharFrame()).toContain("Loop Dashboard")
      expect(setup.captureCharFrame()).toContain("NORMAL")
      expect(text.scrollY).toBe(0)
      expect(list.getChildren().every((row) => row.height === 1)).toBe(true)
      expect(list.content.width).toBeLessThanOrEqual(list.viewport.width)
      // Remount the selected tab; its existing selection must be visible.
      setup.mockInput.pressKey("G"); await setup.flush(); selectedVisible(24)
      setup.mockInput.pressTab(); await setup.flush()
      setup.mockInput.pressTab(); await setup.flush(); selectedVisible(24)
    })

    it(`${view}: completed filtering and refresh clamp selection, including empty lists`, async () => {
      const dir = await seedDir()
      await mutateState(dir, "seed-filtered-list", async (s) => ({
        ...s,
        goals: Array.from({ length: 25 }, (_, i) => ({ ...s.goals[0]!, id: `goal-${i}`, name: `goal-${i}`, status: i < 15 ? "active" as const : "complete" as const })),
        commands: Array.from({ length: 25 }, (_, i) => ({ ...s.commands![0]!, id: `cmd-${i}`, title: `cmd-${i}`, status: i < 15 ? "running" as const : "exited" as const }))
          .flatMap((cmd) => [s.commands![1]!, cmd]),
      }))
      const api = fakeApi([], { count: 0 })
      const handlers = new Map<string, () => void>()
      api.event.on = ((name: string, handler: () => void) => { handlers.set(name, handler); return () => handlers.delete(name) }) as never
      const setup = await testRender(() => (
        <LoopDashboard api={api as never} directory={dir} initialView={view} ownerSessionID="ses-owner" />
      ), { width: 120, height: 50 })
      setups.push(setup as never)
      const marker = (i: number) => `▶ ${view === "goals" ? "● goal" : "cmd"}-${i}`
      await setup.waitFor(() => setup.captureCharFrame().includes(marker(0)))
      setup.mockInput.pressKey("c"); await setup.flush()
      setup.mockInput.pressKey("G"); await setup.flush()
      expect(setup.captureCharFrame()).toContain(view === "goals" ? "goal-24" : marker(24))
      setup.mockInput.pressKey("c"); await setup.flush()
      expect(setup.captureCharFrame()).toContain(marker(14))
      expect(setup.captureCharFrame()).not.toContain(view === "goals" ? "goal-24" : "cmd-24")
      expect(setup.captureCharFrame()).not.toContain("foreign-cmd")
      await mutateState(dir, "shrink", async (s) => ({
        ...s, goals: s.goals.slice(0, 2), commands: s.commands!.filter((c) => c.id === "cmd-0" || c.id === "cmd-1"),
      }))
      await handlers.get("session.idle")!()
      await setup.waitForFrame((frame) => frame.includes(marker(1)))
      await mutateState(dir, "empty", async (s) => ({ ...s, goals: [], commands: [] }))
      await handlers.get("session.idle")!()
      await setup.waitForFrame((frame) => frame.includes(view === "goals" ? "No active goals" : "No live command"))
      setup.mockInput.pressKey("G"); await setup.flush()
      const replacement = await seedDir()
      // Reuse valid domain fixtures, not a mocked control client.
      const { readState } = await import("../../src/infrastructure/state-repository")
      const next = await readState(replacement)
      await mutateState(dir, "repopulate", async (s) => ({ ...s, goals: next.goals, commands: next.commands }))
      await handlers.get("session.idle")!()
      await setup.waitForFrame((frame) => frame.includes(view === "goals" ? "▶ ● goal-one" : "▶ owned-cmd"))
    })
  }

  it("unmount releases mode, event subscriptions, keyboard handlers and timers", async () => {
    const dir = await seedDir()
    const intervals = spyOn(globalThis, "setInterval")
    const clearIntervals = spyOn(globalThis, "clearInterval")
    const timeouts = spyOn(globalThis, "setTimeout")
    const clearTimeouts = spyOn(globalThis, "clearTimeout")
    try {
      const api = fakeApi([], { count: 0 })
      let popped = 0
      let subscribed = 0
      api.mode.push = () => () => { popped++ }
      api.event.on = () => { subscribed++; return () => { subscribed-- } }
      const setup = await testRender(() => <LoopDashboard api={api as never} directory={dir} />)
      await setup.waitFor(() => setup.captureCharFrame().includes("goal-one"))
      const ownedIntervals = intervals.mock.results.map((r) => r.value)
      const focusTimers = timeouts.mock.calls.flatMap((args, i) => args[1] === 10 ? [timeouts.mock.results[i]!.value] : [])
      expect(subscribed).toBe(4)
      expect(ownedIntervals.length).toBeGreaterThanOrEqual(2)
      const beforeListeners = setup.renderer.keyInput.listenerCount("keypress")
      setup.renderer.destroy()
      expect(subscribed).toBe(0)
      expect(popped).toBe(1)
      expect(setup.renderer.keyInput.listenerCount("keypress")).toBeLessThan(beforeListeners)
      for (const interval of ownedIntervals) expect(clearIntervals.mock.calls.some(([id]) => id === interval)).toBe(true)
      expect(focusTimers.length).toBeGreaterThan(0)
      expect(clearTimeouts.mock.calls.some(([id]) => id === focusTimers.at(-1))).toBe(true)
    } finally {
      intervals.mockRestore(); clearIntervals.mockRestore(); timeouts.mockRestore(); clearTimeouts.mockRestore()
    }
  })
  it("unmount fences a pending initial state read and late agent metadata", async () => {
    const dir = await seedDir()
    const raw = await fs.readFile(path.join(dir, ".opencode/loopd/state.json"), "utf8")
    let resolveState!: (raw: string) => void
    let resolveAgents!: (value: unknown) => void
    const stateRead = new Promise<string>((resolve) => { resolveState = resolve })
    const agents = new Promise<unknown>((resolve) => { resolveAgents = resolve })
    const readFile = fs.readFile.bind(fs)
    let reads = 0
    let agentNames = 0
    const spy = spyOn(fs, "readFile").mockImplementation(((target: any, ...args: any[]) => {
      if (String(target) === path.join(dir, ".opencode/loopd/state.json")) { reads++; return stateRead }
      return (readFile as any)(target, ...args)
    }) as typeof fs.readFile)
    try {
      const handlers = new Map<string, () => void>()
      const api = fakeApi([], { count: 0 })
      api.client = { app: { agents: () => agents } }
      api.event.on = ((name: string, handler: () => void) => { handlers.set(name, handler); return () => handlers.delete(name) }) as never
      const setup = await testRender(() => <LoopDashboard api={api as never} directory={dir} />)
      expect(reads).toBe(1)
      for (let i = 0; i < 100; i++) handlers.get("session.status")!()
      expect(reads).toBe(1)
      setup.renderer.destroy()
      expect(handlers.size).toBe(0)
      resolveState(raw)
      resolveAgents([{ get name() { agentNames++; return "late-agent" } }])
      // Flush the already resolved continuations, not a timing-based sleep.
      await stateRead; await agents; await Promise.resolve(); await Promise.resolve()
      expect(reads).toBe(1)
      expect(agentNames).toBe(0)
    } finally { spy.mockRestore() }
  })
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
    const dir = await seedDirWithFinishedCommand()
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
    expect(setup.captureCharFrame()).toContain("▶ owned-cmd")
    expect(setup.captureCharFrame()).not.toContain("▶ ▶ owned-cmd")
    // Finished commands are hidden until `c` reveals them.
    expect(setup.captureCharFrame()).not.toContain("done-cmd")
    setup.mockInput.pressKey("c")
    await setup.waitFor(() => setup.captureCharFrame().includes("done-cmd"))
    expect(setup.captureCharFrame()).toContain("Showing finished commands.")
    // Toggle back hides them again.
    setup.mockInput.pressKey("c")
    await setup.waitFor(() => !setup.captureCharFrame().includes("done-cmd"))
    expect(setup.captureCharFrame()).toContain("Hiding finished commands.")
  })

  it("Commands empty state tells you how many finished commands are hidden", async () => {
    const dir = await seedDirWithFinishedCommand()
    await mutateState(dir, "kill-live", async (s) => ({
      ...s,
      commands: (s.commands ?? []).map((c) => (c.id === "cmd-owned" ? { ...c, status: "exited" } : c)),
    }))
    const setup = await testRender(() => (
      <LoopDashboard api={fakeApi([], { count: 0 }) as never} directory={dir} initialView="commands" ownerSessionID="ses-owner" />
    ))
    setups.push(setup as never)
    await setup.flush()
    await setup.waitFor(() => setup.captureCharFrame().includes("finished hidden"))
    expect(setup.captureCharFrame()).toContain("2 finished hidden")
  })

  it("? opens Commands help with kill/restart/remove instead of Goals help", async () => {
    const dir = await seedDir()
    const setup = await testRender(() => (
      <LoopDashboard api={fakeApi([], { count: 0 }) as never} directory={dir} initialView="commands" ownerSessionID="ses-owner" />
    ))
    setups.push(setup as never)
    await setup.flush()
    setup.mockInput.pressKey("?")
    await setup.waitFor(() => setup.captureCharFrame().includes("Commands tab (selected command only)"))
    const frame = setup.captureCharFrame()
    expect(frame).toContain("X / :kill")
    expect(frame).toContain("R / :restart")
    expect(frame).toContain("x / :remove")
    expect(frame).not.toContain(":force")
  })

  it("o on a command closes the popup and navigates to the terminal route", async () => {
    const dir = await seedDirWithFinishedCommand()
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
    const frame = setup.captureCharFrame()
    expect(frame).not.toContain("done-cmd")
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
