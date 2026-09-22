import { afterEach, describe, expect, it } from "bun:test"
import { promises as fs } from "fs"
import os from "os"
import path from "path"
import plugin from "../../src/server/plugin"
import { createGoal } from "../../src/domain/goal"
import { createRuntimeState } from "../../src/domain/runtime"
import { readState, writeState } from "../../src/infrastructure/state-repository"

describe("Server Plugin Startup", () => {
  const directories: string[] = []

  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })))
  })

  it("does not reconcile sessions while plugin initialization is blocking startup", async () => {
    const directory = path.join(os.tmpdir(), `loopd-plugin-test-${crypto.randomUUID()}`)
    directories.push(directory)
    await fs.mkdir(directory, { recursive: true })

    const state = await readState(directory)
    const goal = createGoal({
      id: crypto.randomUUID() as any,
      name: "stale",
      objective: "test startup",
      status: "active",
      ownerSessionID: "owner-1",
    })
    state.goals.push(goal)
    state.runtimes.push(createRuntimeState(goal.id))
    await writeState(directory, state)

    let createCalled = false
    const hooks = await Promise.race([
      plugin.server({
        client: {
          session: {
            create: () => {
              createCalled = true
              return new Promise(() => {})
            },
          },
        },
        directory,
      } as any),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 100)),
    ])

    expect(hooks).not.toBeNull()
    expect(createCalled).toBe(false)
    await hooks?.dispose?.()
  })

  it("passes configured default agent and checks to goal creation", async () => {
    const directory = path.join(os.tmpdir(), `loopd-plugin-defaults-${crypto.randomUUID()}`)
    directories.push(directory)
    await fs.mkdir(directory, { recursive: true })

    let createdAgent: string | undefined
    const hooks = await plugin.server({
      client: {
        session: {
          create: ({ body }: any) => {
            createdAgent = body.agent
            return Promise.resolve({ data: { id: "worker-defaults" } })
          },
          promptAsync: () => Promise.resolve({ data: {} }),
        },
      },
      directory,
    } as any, {
      defaultAgent: "smart-agent",
      defaultChecks: ["bun test"],
    })

    const result = await hooks.tool!.loopd_create_goal.execute({
      name: "plugin-defaults",
      objective: "Fix the TypeScript source code.",
    }, { sessionID: "owner-1" } as any)
    const output = JSON.parse(result.output)

    expect(output.ok).toBe(true)
    expect(output.defaultsApplied).toEqual({ agent: true, model: false, checks: true })
    expect(createdAgent).toBe("smart-agent")
    await hooks.dispose?.()
  })
})

describe("Server Plugin V2", () => {
  it("registers every tool and lifecycle hook and disposes them on cleanup", async () => {
    const toolIDs: string[] = []
    const hookNames: string[] = []
    const disposed: string[] = []
    let eventSubscriptionAborted = false

    const registration = (name: string) => ({
      async dispose() {
        disposed.push(name)
      },
    })
    const context = {
      location: { directory: os.tmpdir() },
      options: {},
      tool: {
        async transform(callback: (editor: { add(tool: { name: string }): void }) => void) {
          callback({ add: (tool) => toolIDs.push(tool.name) })
          return registration("transform")
        },
        async hook(name: string) {
          hookNames.push(name)
          return registration(name)
        },
      },
      event: {
        subscribe({ signal }: { signal: AbortSignal }) {
          return {
            async *[Symbol.asyncIterator]() {
              await new Promise<void>((resolve) => {
                signal.addEventListener("abort", () => {
                  eventSubscriptionAborted = true
                  resolve()
                }, { once: true })
              })
            },
          }
        },
      },
      session: {},
    }

    const cleanup = await plugin.setup(context as any)

    expect(toolIDs).toEqual([
      "loopd_create_goal",
      "get_goal",
      "report_goal_progress",
      "complete_goal",
      "block_goal",
      "list_background_goals",
      "inspect_background_goal",
      "read_goal_transcript",
      "send_goal_input",
      "pause_goal",
      "resume_goal",
      "nudge_goal",
      "abort_goal_worker",
      "force_complete_goal",
      "force_block_goal",
      "clear_goal",
      "loopd_command_start",
      "loopd_command_list",
      "loopd_command_get",
      "loopd_command_write",
      "loopd_command_interrupt",
      "loopd_command_terminate",
      "loopd_command_remove",
      "loopd_command_await",
      "loopd_command_resize",
    ])
    expect(hookNames).toEqual(["execute.before", "execute.after"])

    await cleanup?.()

    expect(eventSubscriptionAborted).toBe(true)
    expect(disposed).toEqual(["execute.after", "execute.before", "transform"])
  })
})
