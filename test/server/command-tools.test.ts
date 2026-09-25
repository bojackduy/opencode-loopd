import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { promises as fs } from "fs"
import path from "path"
import os from "os"
import { createCommandService } from "../../src/application/command-service"
import { createFakeCommandHost } from "../../src/server/command-host"
import { commandTools } from "../../src/server/command-tools"

function tmpDir(): string {
  return path.join(os.tmpdir(), `loopd-cmdtools-test-${crypto.randomUUID()}`)
}

describe("Command tools (permissions + capabilities)", () => {
  let dir: string
  let tools: ReturnType<typeof commandTools>

  beforeEach(async () => {
    dir = tmpDir()
    await fs.mkdir(dir, { recursive: true })
    tools = commandTools({ directory: dir, commandService: createCommandService(createFakeCommandHost()) })
  })

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  function context(sessionID: string, ask: (input: unknown) => Promise<void> = async () => {}) {
    return { sessionID, ask } as never
  }

  it("denies every operation without session context (never default-allow)", async () => {
    for (const name of Object.keys(tools) as Array<keyof typeof tools>) {
      const t = tools[name] as { execute(a: never, c: unknown): Promise<{ output: string }> }
      const args: Record<string, unknown> =
        name === "loopd_command_start"
          ? { title: "x", command: "echo" }
          : name === "loopd_command_write"
            ? { command_id: "nope", input: "hi" }
            : name === "loopd_command_resize"
              ? { command_id: "nope", cols: 80, rows: 24 }
              : name === "loopd_command_get"
                ? { command_id: "nope" }
                : { command_id: "nope" }
      const r = await t.execute(args as never, {})
      const parsed = JSON.parse(r.output)
      expect(parsed.ok, `${name} allowed without session`).toBe(false)
      expect(parsed.errorCode ?? parsed.message).toBeDefined()
    }
  })

  it("start → get round-trips with capability matrix attached", async () => {
    const started = JSON.parse(
      (await tools.loopd_command_start.execute(
        { title: "demo", command: "echo", args: ["hi"] },
        context("owner-1"),
      )).output,
    )
    expect(started.ok).toBe(true)
    expect(started.capabilities.resize).toBe(false)
    expect(started.capabilities.terminalEmulation).toBe(false)
    const id = started.command.id as string

    const got = JSON.parse(
      (await tools.loopd_command_get.execute({ command_id: id }, context("owner-1"))).output,
    )
    expect(got.ok).toBe(true)
    expect(got.command.argv).toEqual(["echo", "hi"])

    const other = JSON.parse(
      (await tools.loopd_command_get.execute({ command_id: id }, context("owner-2"))).output,
    )
    expect(other.ok).toBe(false) // owner mismatch
  })

  it("resize reports unsupported instead of faking it", async () => {
    const started = JSON.parse(
      (await tools.loopd_command_start.execute({ title: "r", command: "echo" }, context("owner-1"))).output,
    )
    const id = started.command.id as string
    const r = JSON.parse(
      (await tools.loopd_command_resize.execute({ command_id: id, cols: 100, rows: 30 }, context("owner-1"))).output,
    )
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(/not supported/i)
  })

  it("interrupt → terminate → remove lifecycle via tools", async () => {
    const started = JSON.parse(
      (await tools.loopd_command_start.execute({ title: "life", command: "sleep" }, context("owner-1"))).output,
    )
    const id = started.command.id as string
    expect(JSON.parse((await tools.loopd_command_interrupt.execute({ command_id: id }, context("owner-1"))).output).ok).toBe(true)
    // Still running after SIGINT (fake host traps) — remove must refuse.
    expect(JSON.parse((await tools.loopd_command_remove.execute({ command_id: id }, context("owner-1"))).output).ok).toBe(false)
    expect(JSON.parse((await tools.loopd_command_terminate.execute({ command_id: id }, context("owner-1"))).output).ok).toBe(true)
    expect(JSON.parse((await tools.loopd_command_remove.execute({ command_id: id }, context("owner-1"))).output).ok).toBe(true)
  })

  it("summaries carry watch spec + watchState; loopd_command_watch set/replace/clear", async () => {
    const started = JSON.parse(
      (await tools.loopd_command_start.execute(
        { title: "w", command: "sleep", watch_filter: "ERROR", watch_until: "READY" },
        context("owner-1"),
      )).output,
    )
    expect(started.ok).toBe(true)
    expect(started.command.watchFilter).toBe("ERROR")
    expect(started.command.watchUntil).toBe("READY")
    expect(started.command.watchState).toMatchObject({ state: "active", matches: 0, pushes: 0 })
    const id = started.command.id as string

    const listed = JSON.parse(
      (await tools.loopd_command_list.execute({}, context("owner-1"))).output,
    )
    expect(listed.commands[0].watchState).toMatchObject({ state: "active" })

    // Replace resets (until dropped, counters fresh)
    const replaced = JSON.parse(
      (await tools.loopd_command_watch.execute({ command_id: id, watch_filter: "WARN" }, context("owner-1"))).output,
    )
    expect(replaced.ok).toBe(true)
    expect(replaced.command.watchFilter).toBe("WARN")
    expect(replaced.command.watchUntil).toBeUndefined()
    expect(replaced.command.watchState).toMatchObject({ state: "active", matches: 0, pushes: 0 })

    // Clear drops everything
    const cleared = JSON.parse(
      (await tools.loopd_command_watch.execute({ command_id: id, clear: true }, context("owner-1"))).output,
    )
    expect(cleared.ok).toBe(true)
    expect(cleared.command.watchFilter).toBeUndefined()
    expect(cleared.command.watchState).toBeUndefined()

    // Owner mismatch fails closed
    expect(JSON.parse(
      (await tools.loopd_command_watch.execute({ command_id: id, watch_filter: "x" }, context("owner-2"))).output,
    ).ok).toBe(false)

    // Invalid regex fails closed
    expect(JSON.parse(
      (await tools.loopd_command_watch.execute({ command_id: id, watch_filter: "(unclosed" }, context("owner-1"))).output,
    ).ok).toBe(false)
    expect(JSON.parse(
      (await tools.loopd_command_watch.execute({ command_id: id, watch_until_action: "bogus" }, context("owner-1"))).output,
    ).ok).toBe(false)
  })

  it("loopd_command_watch rejects terminal commands (watch is meaningless after exit)", async () => {
    const started = JSON.parse(
      (await tools.loopd_command_start.execute({ title: "short", command: "echo" }, context("owner-1"))).output,
    )
    const id = started.command.id as string
    expect(JSON.parse((await tools.loopd_command_terminate.execute({ command_id: id }, context("owner-1"))).output).ok).toBe(true)
    const r = JSON.parse(
      (await tools.loopd_command_watch.execute({ command_id: id, watch_filter: "x" }, context("owner-1"))).output,
    )
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(/meaningless after exit/)
  })

  it("requests bash permission before spawning and fails closed on rejection", async () => {
    const requests: unknown[] = []
    const allowed = await tools.loopd_command_start.execute(
      { title: "allowed", command: "echo", args: ["hello world"] },
      context("owner-1", async (input) => { requests.push(input) }),
    )
    expect(JSON.parse(allowed.output).ok).toBe(true)
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({ permission: "bash", patterns: ["echo hello world"] })

    const denied = await tools.loopd_command_start.execute(
      { title: "denied", command: "rm", args: ["-rf", "/tmp/nope"] },
      context("owner-1", async () => { throw new Error("permission denied") }),
    )
    expect(JSON.parse(denied.output)).toMatchObject({ ok: false, message: "permission denied" })
  })
})
