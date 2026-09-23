/** @jsxImportSource @opentui/solid */
import { describe, expect, it } from "bun:test"
import { testRender } from "@opentui/solid"
import { TerminalView, buildTerminalRows, TERMINAL_INPUT_MODE } from "../../src/tui/terminal-view"
import type { TerminalSession, TerminalSessionOptions, TerminalSessionSnapshot } from "../../src/tui/terminal-session"
import type { CursorState, ScreenCell } from "../../src/tui/terminal-screen"
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

function fakeApi(navigated: Array<{ name: string; params?: unknown }>) {
  const mode = {
    pushed: [] as string[],
    popped: 0,
    push(name: string) {
      mode.pushed.push(name)
      return () => {
        mode.popped += 1
      }
    },
  }
  return {
    theme: { current: THEME },
    mode,
    route: {
      navigate: (name: string, params?: unknown) => {
        navigated.push({ name, params })
      },
    },
  }
}

function cellsFromText(text: string, cols: number, rows: number): ScreenCell[] {
  const cells: ScreenCell[] = []
  for (let i = 0; i < cols * rows; i++) cells.push({ text: " " })
  for (let i = 0; i < text.length && i < cells.length; i++) cells[i]!.text = text[i]!
  return cells
}

function snapshot(overrides: Partial<TerminalSessionSnapshot> = {}): TerminalSessionSnapshot {
  const cols = 20
  const rows = 6
  return {
    rows: cellsFromText("", cols, rows),
    cols,
    viewportRows: rows,
    cursor: { x: 0, y: 0, visible: true } satisfies CursorState,
    activeBuffer: "normal",
    command: null,
    connection: "stream",
    connectionDetail: "live",
    totalBytes: 0,
    live: true,
    invalid: undefined,
    ...overrides,
  }
}

interface FakeDriver {
  session: TerminalSession
  opts: TerminalSessionOptions | undefined
  inputs: string[]
  pastes: string[]
  interrupts: number
  detaches: number
  starts: number
  resizes: Array<{ cols: number; rows: number }>
  emit: (snap: TerminalSessionSnapshot) => void
}

function makeFakeDriver(): FakeDriver & { create: (opts: TerminalSessionOptions) => TerminalSession } {
  const fake: FakeDriver = {
    session: undefined as unknown as TerminalSession,
    opts: undefined,
    inputs: [],
    pastes: [],
    interrupts: 0,
    detaches: 0,
    starts: 0,
    resizes: [],
    emit: () => {},
  }
  const session: TerminalSession = {
    get data() {
      return { commandID: "cmd-1", ownerSessionID: "owner-1", returnSessionID: "ses-ret" }
    },
    get invalidReason() {
      return undefined
    },
    start: async () => {
      fake.starts += 1
    },
    writeInput: (bytes) => {
      fake.inputs.push(bytes)
    },
    paste: (text) => {
      fake.pastes.push(text)
    },
    interrupt: () => {
      fake.interrupts += 1
    },
    detach: () => {
      fake.detaches += 1
      try {
        fake.opts?.onDetach?.()
      } catch {}
    },
    requestViewportSize: (cols, rows) => {
      fake.resizes.push({ cols, rows })
    },
    get appliedSize() {
      return { cols: 20, rows: 6 }
    },
    readView: () => snapshot(),
    dispose: () => {},
  }
  fake.session = session
  const create = (opts: TerminalSessionOptions) => {
    fake.opts = opts
    fake.emit = (snap) => opts.onSnapshot?.(snap)
    return session
  }
  return Object.assign(fake, { create })
}

async function renderView(
  data: unknown,
  fake: ReturnType<typeof makeFakeDriver>,
  onDetach?: () => void,
  detached: { count: number } = { count: 0 },
) {
  const navigated: Array<{ name: string; params?: unknown }> = []
  // kittyKeyboard: modern hosts send Kitty-protocol frames (notably Ctrl+]);
  // the view must handle them (detach chord, no blind forwarding).
  const setup = await testRender(
    () => (
      <TerminalView
        api={fakeApi(navigated) as never}
        directory="/tmp/loopd-terminal-view-test"
        data={data}
        createSession={fake.create}
        onDetach={() => {
          detached.count += 1
          onDetach?.()
        }}
      />
    ),
    { kittyKeyboard: true },
  )
  await setup.flush()
  return { setup, navigated, detached }
}

describe("TerminalView (mounted)", () => {
  it("invalid route data renders safely with no subscribe-or-write surface", async () => {
    const fake = makeFakeDriver()
    const { setup } = await renderView({ commandID: "", ownerSessionID: "x" }, fake)
    fake.emit(snapshot({ invalid: "commandID-required", connection: "error", connectionDetail: "invalid route data: commandID-required" }))
    await setup.flush()
    const frame = setup.captureCharFrame()
    expect(frame).toContain("Invalid terminal route")
    expect(frame).toContain("Ctrl+]")
    expect(fake.starts).toBe(1)
    setup.renderer.destroy()
  })

  it("header shows command metadata; viewport renders every row; footer shows controls", async () => {
    const fake = makeFakeDriver()
    const cmd = {
      ...createCommandSession({ id: "cmd-1", title: "repl", command: "sh", cwd: "/tmp", ownerSessionID: "owner-1" }),
      status: "running",
    } as never
    const { setup } = await renderView({ commandID: "cmd-1", ownerSessionID: "owner-1", returnSessionID: "s" }, fake)
    fake.emit(snapshot({ rows: cellsFromText("hello-view", 20, 6), command: cmd, totalBytes: 10 }))
    await setup.flush()
    const frame = setup.captureCharFrame()
    expect(frame).toContain("repl")
    expect(frame).toContain("hello-view")
    expect(frame).toContain("Ctrl+]")
    // Footer wraps at full width ("...keeps running20x6..."), so assert the
    // fragments separately.
    expect(frame).toContain("detach (keeps running")
    expect(frame).toContain("20x6")
    setup.renderer.destroy()
  })

  it("typing forwards raw bytes immediately (no line submit)", async () => {
    const fake = makeFakeDriver()
    const { setup } = await renderView({ commandID: "cmd-1", ownerSessionID: "owner-1", returnSessionID: "s" }, fake)
    fake.emit(snapshot())
    await setup.flush()
    await setup.mockInput.pressKeys(["a", "b"])
    await setup.flush()
    await setup.waitFor(() => fake.inputs.join("") === "ab")
    expect(fake.inputs).toEqual(["a", "b"])
    setup.renderer.destroy()
  })

  it("Ctrl+C interrupts the PTY and never detaches", async () => {
    const fake = makeFakeDriver()
    const { setup, detached } = await renderView(
      { commandID: "cmd-1", ownerSessionID: "owner-1", returnSessionID: "s" },
      fake,
    )
    fake.emit(snapshot())
    await setup.flush()
    // NOTE: mock keys must be dispatched back-to-back — any frame pump
    // (flush/waitFor) between two presses drops the second press in the
    // OpenTUI test renderer. Separate tests isolate each chord instead.
    setup.mockInput.pressCtrlC()
    await setup.waitFor(() => fake.interrupts === 1)
    expect(fake.detaches).toBe(0)
    expect(detached.count).toBe(0)
    setup.renderer.destroy()
  })

  it("Ctrl+] detaches and never interrupts or terminates", async () => {
    const fake = makeFakeDriver()
    const { setup, detached } = await renderView(
      { commandID: "cmd-1", ownerSessionID: "owner-1", returnSessionID: "s" },
      fake,
    )
    fake.emit(snapshot())
    await setup.flush()
    setup.mockInput.pressKey("]", { ctrl: true })
    await setup.waitFor(() => fake.detaches === 1)
    expect(fake.interrupts).toBe(0)
    expect(fake.inputs).toEqual([])
    expect(detached.count).toBe(1)
    // Detach-not-terminate: the fake driver exposes no terminate path at
    // all; the headless session test asserts cmd_terminate is never sent.
    setup.renderer.destroy()
  })

  it("paste bytes forward immediately as raw stdin", async () => {
    const fake = makeFakeDriver()
    const { setup } = await renderView({ commandID: "cmd-1", ownerSessionID: "owner-1", returnSessionID: "s" }, fake)
    fake.emit(snapshot())
    await setup.flush()
    await setup.mockInput.pasteBracketedText("pasted-bytes-123")
    await setup.flush()
    await setup.waitFor(() => fake.pastes.length === 1)
    expect(fake.pastes).toEqual(["pasted-bytes-123"])
    // Paste never goes through key encoding (no per-char inputs).
    expect(fake.inputs).toEqual([])
    setup.renderer.destroy()
  })

  it("pushes the terminal input mode on mount and pops it on unmount", async () => {
    const fake = makeFakeDriver()
    const navigated: Array<{ name: string; params?: unknown }> = []
    const api = fakeApi(navigated) as never as ReturnType<typeof fakeApi>
    const setup = await testRender(
      () => (
        <TerminalView
          api={api as never}
          directory="/tmp/loopd-terminal-view-test"
          data={{ commandID: "cmd-1", ownerSessionID: "owner-1", returnSessionID: "s" }}
          createSession={fake.create}
        />
      ),
      { kittyKeyboard: true },
    )
    await setup.flush()
    expect(api.mode.pushed).toEqual([TERMINAL_INPUT_MODE])
    setup.renderer.destroy()
    expect(api.mode.popped).toBe(1)
  })
})

describe("buildTerminalRows", () => {
  it("renders every viewport row and preserves blank rows", () => {
    const rows = buildTerminalRows(cellsFromText("hi", 10, 4), 10, 4, { x: 0, y: 0, visible: false })
    expect(rows.length).toBe(4)
    // Width-preserving: "hi" + background spaces (never collapsed).
    expect(rows[0]!.map((r) => r.text).join("")).toBe("hi        ")
    // Blank rows keep one space run (line preserved, never zero runs).
    expect(rows[3]!.length).toBe(1)
    expect(rows[3]![0]!.text).toBe(" ")
  })

  it("preserves a styled trailing blank run (non-default background)", () => {
    const cols = 6
    const cells: ScreenCell[] = []
    for (let i = 0; i < cols; i++) cells.push({ text: " " })
    cells[0] = { text: "a" }
    // Trailing blanks with a highlight background are visible output.
    for (let i = 1; i < cols; i++) cells[i] = { text: " ", bg: "#ff0000" }
    const rows = buildTerminalRows(cells, cols, 1, { x: 0, y: 0, visible: false })
    const joined = rows[0]!.map((r) => r.text).join("")
    expect(joined).toBe("a     ")
    expect(rows[0]!.some((r) => r.bg === "#ff0000")).toBe(true)
  })

  it("skips width-0 continuation cells so columns after a wide glyph align", () => {
    // CJK lead (width 2) + continuation (width 0) + ASCII.
    const cells: ScreenCell[] = [
      { text: "漢", width: 2 },
      { text: " ", width: 0 },
      { text: "x" },
      { text: "y" },
    ]
    const rows = buildTerminalRows(cells, 4, 1, { x: 9, y: 0, visible: false })
    const joined = rows[0]!.map((r) => r.text).join("")
    // No literal space emitted for the continuation cell.
    expect(joined).toBe("漢xy")
  })

  it("propagates the inverse flag for theme-time default resolution", () => {
    const cells: ScreenCell[] = [{ text: "i", inverse: true }, { text: "a" }]
    for (let i = 2; i < 4; i++) cells.push({ text: " " })
    const rows = buildTerminalRows(cells, 4, 1, { x: 9, y: 0, visible: false })
    expect(rows[0]![0]!.inverse).toBe(true)
    // Inverse cells never merge into a neighboring plain run.
    expect(rows[0]!.length).toBeGreaterThan(1)
  })

  it("marks the visible cursor cell without dropping rows", () => {
    const rows = buildTerminalRows(cellsFromText("ab", 10, 2), 10, 2, { x: 1, y: 0, visible: true })
    const flat = rows[0]!
    expect(flat.some((r) => r.cursor)).toBe(true)
    expect(rows.length).toBe(2)
  })

  it("hidden cursor marks nothing", () => {
    const rows = buildTerminalRows(cellsFromText("ab", 10, 2), 10, 2, { x: 1, y: 0, visible: false })
    expect(rows.flat().some((r) => r.cursor)).toBe(false)
  })

  it("measured viewport drives initial and subsequent resizes", async () => {
    const fake = makeFakeDriver()
    const { setup } = await renderView({ commandID: "cmd-1", ownerSessionID: "owner-1", returnSessionID: "s" }, fake)
    fake.emit(snapshot())
    await setup.flush()
    // Initial measure after mount (renderable ref + post-mount measure).
    await setup.waitFor(() => fake.resizes.length >= 1)
    const first = fake.resizes[0]!
    expect(first.cols).toBeGreaterThan(0)
    expect(first.rows).toBeGreaterThan(0)
    // Subsequent host resize flows through onSizeChange → debounced request.
    setup.resize(100, 30)
    await setup.waitFor(() => fake.resizes.some((r) => r.cols !== first.cols || r.rows !== first.rows))
    setup.renderer.destroy()
  })
})
