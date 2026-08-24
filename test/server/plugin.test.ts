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
    expect(output.defaultsApplied).toEqual({ agent: true, checks: true })
    expect(createdAgent).toBe("smart-agent")
    await hooks.dispose?.()
  })
})
