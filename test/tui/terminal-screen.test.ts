// Terminal screen emulation fixtures (headless, bun:test).
import { describe, expect, test } from "bun:test"
import { createCommandScreenFeed, createTerminalScreen, type ScreenCell } from "../../src/tui/terminal-screen"

function rowText(cells: ScreenCell[], cols: number, y: number): string {
  return cells
    .slice(y * cols, (y + 1) * cols)
    .map((c) => c.text)
    .join("")
    .replace(/\s+$/, "")
}

describe("terminal-screen", () => {
  test("cursor positioning + overwrite", async () => {
    const screen = createTerminalScreen(20, 5)
    screen.write("hello")
    await screen.flush()
    // CUP to row 1 col 1 (1-based), overwrite with "XY".
    screen.write("\x1b[1;1HXY")
    await screen.flush()
    const cells = screen.readScreen()
    expect(cells.length).toBe(20 * 5)
    expect(rowText(cells, 20, 0)).toBe("XYllo")
    screen.dispose()
  })

  test("SGR fg/bg/bold", async () => {
    const screen = createTerminalScreen(20, 5)
    // Red fg (31), then bold blue-on-green.
    screen.write("\x1b[31mR\x1b[0mN\x1b[1;34;42mB\x1b[0m")
    await screen.flush()
    const cells = screen.readScreen()
    expect(cells[0].text).toBe("R")
    expect(cells[0].fg).toBe("#cd0000") // palette 1
    expect(cells[1].text).toBe("N")
    expect(cells[1].fg).toBeUndefined()
    expect(cells[2].text).toBe("B")
    expect(cells[2].bold).toBe(true)
    expect(cells[2].fg).toBe("#0000cd") // palette 4
    expect(cells[2].bg).toBe("#00cd00") // palette 2
    screen.dispose()
  })

  test("erase line", async () => {
    const screen = createTerminalScreen(20, 5)
    screen.write("hello")
    await screen.flush()
    // CR + erase entire line (CSI 2 K).
    screen.write("\r\x1b[2K")
    await screen.flush()
    const cells = screen.readScreen()
    expect(rowText(cells, 20, 0)).toBe("")
    screen.dispose()
  })

  test("scrolling region preserves outside lines", async () => {
    const screen = createTerminalScreen(10, 5)
    // Fill rows: A B C D E (each + newline; cursor ends on row 5).
    screen.write("A\nB\nC\nD\nE")
    await screen.flush()
    let cells = screen.readScreen()
    expect(rowText(cells, 10, 0)).toBe("A")
    // Restrict scrolling to 1-based rows 2..4, park cursor on row 4, feed LFs.
    screen.write("\x1b[2;4r\x1b[4;1H\n\n\n")
    await screen.flush()
    cells = screen.readScreen()
    // Row 1 (outside the region) is untouched; the region scrolled.
    expect(rowText(cells, 10, 0)).toBe("A")
    // Reset margins for cleanliness.
    screen.write("\x1b[r")
    await screen.flush()
    screen.dispose()
  })

  test("line wrap at cols", async () => {
    const screen = createTerminalScreen(10, 4)
    screen.write("0123456789AB")
    await screen.flush()
    const cells = screen.readScreen()
    expect(rowText(cells, 10, 0)).toBe("0123456789")
    expect(rowText(cells, 10, 1)).toBe("AB")
    screen.dispose()
  })

  test("alt-screen enter/exit isolation", async () => {
    const screen = createTerminalScreen(20, 5)
    screen.write("normal-content")
    await screen.flush()
    expect(screen.activeBuffer).toBe("normal")
    // Fullscreen app takes over (?1049h): active buffer switches, normal
    // content hidden while alt is active. The app homes the cursor (?1049h
    // preserves it), like vim/less do.
    screen.write("\x1b[?1049h\x1b[HALT-APP")
    await screen.flush()
    expect(screen.activeBuffer).toBe("alternate")
    let cells = screen.readScreen()
    expect(rowText(cells, 20, 0)).toBe("ALT-APP")
    // Exit (?1049l): normal buffer restored.
    screen.write("\x1b[?1049l")
    await screen.flush()
    expect(screen.activeBuffer).toBe("normal")
    cells = screen.readScreen()
    expect(rowText(cells, 20, 0)).toBe("normal-content")
    screen.dispose()
  })

  test("resize preserves content best-effort", async () => {
    const screen = createTerminalScreen(20, 5)
    screen.write("keepme")
    await screen.flush()
    screen.resize(30, 8)
    expect(screen.cols).toBe(30)
    expect(screen.rows).toBe(8)
    await screen.flush()
    const cells = screen.readScreen()
    expect(cells.length).toBe(30 * 8)
    expect(rowText(cells, 30, 0).startsWith("keepme")).toBe(true)
    // Invalid resizes are ignored, never throw.
    screen.resize(0, -1)
    expect(screen.cols).toBe(30)
    screen.dispose()
  })

  test("inverse resolves into fg/bg with flag retained", async () => {
    const screen = createTerminalScreen(20, 5)
    screen.write("\x1b[31;42mX\x1b[0m")
    await screen.flush()
    // Without inverse: fg red, bg green.
    expect(screen.readScreen()[0]).toMatchObject({ text: "X", fg: "#cd0000", bg: "#00cd00" })
    screen.reset()
    screen.write("\x1b[31;42;7mY\x1b[0m")
    await screen.flush()
    // With inverse: swapped for display, flag still reported.
    expect(screen.readScreen()[0]).toMatchObject({
      text: "Y",
      fg: "#00cd00",
      bg: "#cd0000",
      inverse: true,
    })
    screen.dispose()
  })
})

describe("command-screen-feed", () => {
  test("snapshot → delta → resync never duplicates bytes", async () => {
    const screen = createTerminalScreen(40, 6)
    const feed = createCommandScreenFeed(screen)
    // Snapshot baseline: bytes [0,5) = "hello".
    feed.applySnapshot("hello", 0, 5)
    await screen.flush()
    expect(rowText(screen.readScreen(), 40, 0)).toBe("hello")
    // Exact-continue delta [5,11) appends once.
    expect(feed.applyDelta(" world", 5, 11)).toBe(true)
    await screen.flush()
    expect(rowText(screen.readScreen(), 40, 0)).toBe("hello world")
    // Redelivered/overlapping delta is ignored (stream client resyncs).
    expect(feed.applyDelta(" world", 5, 11)).toBe(false)
    await screen.flush()
    expect(rowText(screen.readScreen(), 40, 0)).toBe("hello world")
    // Resync arrives as a fresh snapshot: reset + re-feed, not append.
    feed.applySnapshot("hello world!", 0, 12)
    await screen.flush()
    expect(rowText(screen.readScreen(), 40, 0)).toBe("hello world!")
    expect(feed.endOffset).toBe(12)
    screen.dispose()
  })

  test("delta before snapshot is refused", async () => {
    const screen = createTerminalScreen(40, 6)
    const feed = createCommandScreenFeed(screen)
    expect(feed.applyDelta("late", 0, 4)).toBe(false)
    await screen.flush()
    expect(rowText(screen.readScreen(), 40, 0)).toBe("")
    screen.dispose()
  })
})
