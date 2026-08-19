import { describe, it, expect } from "bun:test"
import { parseCommand, commandHelp } from "../../src/tui/command-parser"

describe("Command Parser", () => {
  it("parses simple command", () => {
    const result = parseCommand("pause")
    expect(result).toBeTruthy()
    expect(result!.command).toBe("pause")
    expect(result!.positional).toEqual([])
  })

  it("parses goal start with positional args", () => {
    const result = parseCommand("goal start my-project")
    expect(result).toBeTruthy()
    expect(result!.command).toBe("goal")
    expect(result!.positional).toEqual(["start", "my-project"])
  })

  it("parses goal start with objective flag", () => {
    const result = parseCommand('goal start my-project --objective "Convert all PDFs"')
    expect(result).toBeTruthy()
    expect(result!.command).toBe("goal")
    expect(result!.positional).toEqual(["start", "my-project"])
    expect(result!.args.objective).toBe("Convert all PDFs")
  })

  it("parses quoted strings with spaces", () => {
    const result = parseCommand('goal start "my project" --objective "do things"')
    expect(result).toBeTruthy()
    expect(result!.command).toBe("goal")
    expect(result!.positional).toEqual(["start", "my project"])
    expect(result!.args.objective).toBe("do things")
  })

  it("parses --key=value format", () => {
    const result = parseCommand("goal start foo --name=bar")
    expect(result).toBeTruthy()
    expect(result!.args.name).toBe("bar")
  })

  it("parses --flag without value as true", () => {
    const result = parseCommand("goal start foo --verbose")
    expect(result).toBeTruthy()
    expect(result!.args.verbose).toBe("true")
  })

  it("returns null for empty input", () => {
    expect(parseCommand("")).toBeNull()
    expect(parseCommand("  ")).toBeNull()
  })

  it("handles escaped characters", () => {
    const result = parseCommand('goal start foo --objective "hello \\"world\\""')
    expect(result).toBeTruthy()
    expect(result!.args.objective).toBe('hello "world"')
  })

  it("parses close and q commands", () => {
    expect(parseCommand("q")!.command).toBe("q")
    expect(parseCommand("close")!.command).toBe("close")
  })

  it("parses help command", () => {
    expect(parseCommand("help")!.command).toBe("help")
  })

  it("commandHelp returns a string", () => {
    const help = commandHelp()
    expect(typeof help).toBe("string")
    expect(help).toContain(":goal start")
    expect(help).toContain(":pause")
    expect(help).toContain(":help")
  })
})
