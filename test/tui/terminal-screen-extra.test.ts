import { describe, expect, test } from "bun:test"
import {
  createCommandScreenFeed,
  createTerminalScreen,
  type ScreenCell,
} from "../../src/tui/terminal-screen"

function rowText(cells: ScreenCell[], cols: number, y: number): string {
  return cells
    .slice(y * cols, (y + 1) * cols)
    .map((c) => c.text)
    .join("")
}

describe("terminal-screen correctness", () => {
  test("256-color cube maps to full range (index 231 = #ffffff)", async () => {
    const screen = createTerminalScreen(10, 2)
    // 231 = cube max (5,5,5) → 55+40*5 = 255 each.
    screen.write("\x1b[38;5;231mW\x1b[0m")
    await screen.flush()
    expect(screen.readScreen()[0].fg).toBe("#ffffff")
    // 16 = cube min (0,0,0) → black.
    screen.reset()
    screen.write("\x1b[38;5;16mB\x1b[0m")
    await screen.flush()
    expect(screen.readScreen()[0].fg).toBe("#000000")
    // 196 = (5,0,0) → #ff0000.
    screen.reset()
    screen.write("\x1b[38;5;196mR\x1b[0m")
    await screen.flush()
    expect(screen.readScreen()[0].fg).toBe("#ff0000")
    screen.dispose()
  })

  test("cursor position tracks writes, visibility follows DECTCEM", async () => {
    const screen = createTerminalScreen(20, 5)
    await screen.flush()
    expect(screen.cursor).toMatchObject({ x: 0, y: 0, visible: true })
    screen.write("hello")
    await screen.flush()
    expect(screen.cursor.x).toBe(5)
    expect(screen.cursor.y).toBe(0)
    screen.write("\x1b[?25l")
    await screen.flush()
    expect(screen.cursor.visible).toBe(false)
    screen.write("\x1b[?25h")
    await screen.flush()
    expect(screen.cursor.visible).toBe(true)
    screen.dispose()
  })

  test("wide-character continuation cells are preserved", async () => {
    const screen = createTerminalScreen(10, 2)
    screen.write("A\u6f22B") // A + CJK + B
    await screen.flush()
    const cells = screen.readScreen()
    expect(cells[0].text).toBe("A")
    expect(cells[1].text).toBe("\u6f22")
    expect(cells[1].width).toBe(2)
    // Continuation cell: width 0, never collapsed.
    expect(cells[2].width).toBe(0)
    expect(cells.length).toBe(10 * 2)
    screen.dispose()
  })

  test("blank rows and background spaces are preserved; every row serialized", async () => {
    const screen = createTerminalScreen(8, 4)
    screen.write("hi")
    await screen.flush()
    const rows = screen.serialize()
    expect(rows.length).toBe(4)
    expect(rows[0]).toBe("hi      ")
    expect(rows[1]).toBe("        ")
    expect(rows[3]).toBe("        ")
    const cells = screen.readScreen()
    expect(cells.length).toBe(8 * 4)
    screen.dispose()
  })

  test("serialize/reset/flush prevent stale repaint", async () => {
    const screen = createTerminalScreen(20, 2)
    screen.write("stale-bytes")
    await screen.flush()
    expect(screen.serialize()[0].startsWith("stale-bytes")).toBe(true)
    screen.reset()
    await screen.flush()
    expect(screen.serialize()).toEqual(["                    ", "                    "])
    expect(screen.cursor).toMatchObject({ x: 0, y: 0, visible: true })
    screen.dispose()
  })

  test("bytes written before reset never appear after reset (no async repaint)", async () => {
    const screen = createTerminalScreen(20, 2)
    // Queue bytes but reset before they parse: the reset disposes the
    // parser, so the stranded write parses into the dead instance.
    screen.write("stale-bytes")
    screen.reset()
    await screen.flush()
    expect(screen.serialize()).toEqual(["                    ", "                    "])
    // The new parser accepts fresh bytes normally.
    screen.write("fresh")
    await screen.flush()
    expect(screen.serialize()[0].startsWith("fresh")).toBe(true)
    screen.dispose()
  })

  test("snapshot then rapid deltas converge on the latest content", async () => {
    const screen = createTerminalScreen(20, 2)
    const feed = createCommandScreenFeed(screen)
    feed.applySnapshot("v1-", 0, 3)
    expect(feed.applyDelta("v2", 3, 5)).toBe(true)
    expect(feed.applyDelta("!", 5, 6)).toBe(true)
    await screen.flush()
    expect(screen.serialize()[0].startsWith("v1-v2!")).toBe(true)
    // Resync path: a fresh snapshot replaces, never appends.
    feed.applySnapshot("new", 6, 9)
    await screen.flush()
    expect(screen.serialize()[0].startsWith("new")).toBe(true)
    expect(screen.serialize()[0].startsWith("newv1")).toBe(false)
    screen.dispose()
  })
})
