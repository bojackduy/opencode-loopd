import { afterEach, describe, expect, it } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import plugin from "../../src/server/plugin"
import { createGoal, type GoalID } from "../../src/domain/goal"
import { createRuntimeState } from "../../src/domain/runtime"
import { mutateState, readState } from "../../src/infrastructure/state-repository"
import { createGoalService } from "../../src/application/goal-service"
import { createFakeHost } from "../../src/server/host-adapter"
import { withWorkspaceOperation } from "../../src/application/workspace-execution"
import { ownerTools } from "../../src/server/owner-tools"
import { inferNamedFileWriteScope } from "../../src/application/goal-policy"

const roots: string[] = []
const fixtures: Array<{ hooks: any }> = []
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.hooks.dispose?.()
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

async function root(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "loopd-recovery-"))
  roots.push(dir)
  return dir
}

/** Plant a reservation as if a tool call had started and never reported back. */
async function plantCall(
  dir: string,
  call: { callID: string; sessionID: string; goalID?: GoalID; paths?: string[] },
) {
  await mutateState(dir, "test.plant", async (state) => {
    state.workspaceCalls = [
      ...(state.workspaceCalls ?? []),
      {
        callID: call.callID,
        sessionID: call.sessionID,
        goalID: call.goalID,
        generation: 0,
        paths: call.paths ?? ["owned.ts"],
        at: new Date().toISOString(),
      },
    ]
    return state
  })
}

function startWriter(service: ReturnType<typeof createGoalService>, dir: string, owner = "owner-1") {
  return service.start(dir, {
    name: "writer",
    objective: "test",
    ownerSessionID: owner,
    config: { write_scope: ["owned.ts"] },
  })
}

describe("workspace fence self-heal", () => {
  it("keeps a cleared goal's fence while its session still exists, and releases it once the host proves it gone", async () => {
    const dir = await root()
    const host = createFakeHost()
    const service = createGoalService(host)
    const { goal } = await startWriter(service, dir)
    await plantCall(dir, { callID: "leaked", sessionID: goal.workerSessionID!, goalID: goal.id })
    await service.clear(dir, goal.id)

    // Same process: real hosts interrupt sessions, they do not delete them, so
    // "goal is gone" alone is still not proof that the write finished.
    await service.reconcile(dir)
    expect((await readState(dir)).workspaceCalls).toHaveLength(1)

    // A host that never saw that session (restart against a wiped store) could
    // never finish the write, so the fence self-heals.
    const restarted = createGoalService(createFakeHost())
    await restarted.reconcile(dir)
    expect((await readState(dir)).workspaceCalls).toHaveLength(0)

    // And the project is genuinely unblocked: a new writer can start.
    await expect(startWriter(restarted, dir)).resolves.toBeDefined()
  })

  it("never releases on an unproven probe", async () => {
    const dir = await root()
    const service = createGoalService(createFakeHost())
    const { goal } = await startWriter(service, dir)
    await plantCall(dir, { callID: "leaked", sessionID: goal.workerSessionID!, goalID: goal.id })
    await service.clear(dir, goal.id)

    // A timeout/network/auth error must never be mistaken for a dead session.
    const unproven = createGoalService(createFakeHost({ sessionKnown: () => undefined }))
    await unproven.reconcile(dir)
    expect((await readState(dir)).workspaceCalls).toHaveLength(1)
  })

  it("never auto-releases a goal-less owner reservation, however old", async () => {
    const dir = await root()
    await mutateState(dir, "test.owner-call", async (state) => {
      state.workspaceCalls = [
        {
          callID: "owner-build",
          sessionID: "chat-session",
          generation: 0,
          paths: ["owned.ts"],
          at: new Date(Date.now() - 9 * 24 * 3600_000).toISOString(),
        },
      ]
      return state
    })

    // A nine-day owner build is indistinguishable from a leaked one; only the
    // explicit owner release may touch these.
    await createGoalService(createFakeHost()).reconcile(dir)
    expect((await readState(dir)).workspaceCalls).toHaveLength(1)
  })
})

describe("owner workspace release", () => {
  it("lists live reservations, then releases one this session owns", async () => {
    const dir = await root()
    const host = createFakeHost()
    const service = createGoalService(host)
    const { goal } = await startWriter(service, dir)
    await plantCall(dir, { callID: "stuck", sessionID: "w-dead", goalID: goal.id })
    const tools = ownerTools({ directory: dir, host, goalService: service })
    const ctx = { sessionID: "owner-1" } as never

    const listed = JSON.parse((await tools.loopd_release_workspace.execute({}, ctx)).output)
    expect(listed.mode).toBe("inspect")
    expect(listed.reservations.map((item: any) => item.callID)).toEqual(["stuck"])
    expect(listed.reservations[0].releasable).toBe(true)
    await expect(withWorkspaceOperation(dir, "other" as GoalID, "other-session", async () => {})).rejects.toThrow(/busy|in-flight|call/i)

    const released = JSON.parse((await tools.loopd_release_workspace.execute({ call_id: "stuck" }, ctx)).output)
    expect(released.ok).toBe(true)
    expect(released.released).toHaveLength(1)
    expect(released.remaining.reservations).toHaveLength(0)
    expect((await readState(dir)).workspaceCalls).toHaveLength(0)
    // The acceptance criterion: the project is actually usable again without
    // anyone hand-editing state.json.
    expect(await withWorkspaceOperation(dir, "other" as GoalID, "other-session", async () => "ran")).toBe("ran")
  })

  it("refuses a reservation owned by another session's live goal", async () => {
    const dir = await root()
    const host = createFakeHost()
    const service = createGoalService(host)
    const { goal } = await startWriter(service, dir)
    await plantCall(dir, { callID: "foreign", sessionID: "w-dead", goalID: goal.id })
    const tools = ownerTools({ directory: dir, host, goalService: service })

    const listed = JSON.parse(
      (await tools.loopd_release_workspace.execute({}, { sessionID: "someone-else" } as never)).output,
    )
    expect(listed.reservations[0].releasable).toBe(false)

    const refused = JSON.parse(
      (await tools.loopd_release_workspace.execute({ call_id: "foreign" }, { sessionID: "someone-else" } as never)).output,
    )
    expect(refused.ok).toBe(false)
    expect(refused.message).toContain("Refusing to release")
    expect((await readState(dir)).workspaceCalls).toHaveLength(1)
  })

  it("refuses to release a reservation held by the live worker of an active goal", async () => {
    const dir = await root()
    const host = createFakeHost()
    const service = createGoalService(host)
    const { goal } = await startWriter(service, dir)
    await plantCall(dir, { callID: "in-flight", sessionID: goal.workerSessionID!, goalID: goal.id })
    const tools = ownerTools({ directory: dir, host, goalService: service })

    const refused = JSON.parse(
      (await tools.loopd_release_workspace.execute({ call_id: "in-flight" }, { sessionID: "owner-1" } as never)).output,
    )
    expect(refused.ok).toBe(false)
    expect(refused.message).toContain("mid-write")
    expect((await readState(dir)).workspaceCalls).toHaveLength(1)
  })

  it("releases a goal-less reservation held by the caller's own session", async () => {
    const dir = await root()
    const host = createFakeHost()
    const service = createGoalService(host)
    // The common shape of a leaked fence: the writing session *is* the chat
    // session (no goal to be matched through), so only the session itself can
    // know the call that opened it is dead.
    await mutateState(dir, "test.own-call", async (state) => {
      state.workspaceCalls = [
        {
          callID: "call_abc:def",
          sessionID: "chat-session",
          generation: 0,
          paths: ["owned.ts"],
          uncontrolled: true,
          at: new Date().toISOString(),
        },
      ]
      return state
    })
    const tools = ownerTools({ directory: dir, host, goalService: service })

    const foreign = JSON.parse(
      (await tools.loopd_release_workspace.execute({ call_id: "call_abc:def" }, { sessionID: "someone-else" } as never)).output,
    )
    expect(foreign.ok).toBe(false)

    const mine = JSON.parse(
      (await tools.loopd_release_workspace.execute({ call_id: "call_abc:def" }, { sessionID: "chat-session" } as never)).output,
    )
    expect(mine.ok).toBe(true)
    expect((await readState(dir)).workspaceCalls).toHaveLength(0)
  })

  it("releases an orphaned reservation whose goal no longer exists", async () => {
    const dir = await root()
    const host = createFakeHost()
    const service = createGoalService(host)
    const { goal } = await startWriter(service, dir)
    await plantCall(dir, { callID: "orphan", sessionID: "w-dead", goalID: goal.id })
    await service.clear(dir, goal.id)

    const tools = ownerTools({ directory: dir, host, goalService: service })
    const released = JSON.parse(
      (await tools.loopd_release_workspace.execute({ call_id: "orphan" }, { sessionID: "any-session" } as never)).output,
    )
    expect(released.ok).toBe(true)
    expect((await readState(dir)).workspaceCalls).toHaveLength(0)
  })

  it("refuses an unnamed selection and reports when nothing is fencing", async () => {
    const dir = await root()
    const host = createFakeHost()
    const service = createGoalService(host)
    const tools = ownerTools({ directory: dir, host, goalService: service })
    const ctx = { sessionID: "owner-1" } as never

    const empty = JSON.parse((await tools.loopd_release_workspace.execute({}, ctx)).output)
    expect(empty.message).toContain("nothing is fencing")

    const refused = JSON.parse(
      (await tools.loopd_release_workspace.execute({ session_id: "ghost" }, ctx)).output,
    )
    expect(refused.ok).toBe(false)
    expect(refused.message).toContain("No workspace reservation matches")
  })
})

describe("read-only goals do not contend", () => {
  async function fixture() {
    const dir = await root()
    await fs.writeFile(path.join(dir, "shared.ts"), "before")
    const artifactDir = path.join(dir, ".opencode/loopd/goals/reader")
    await fs.mkdir(artifactDir, { recursive: true })
    await mutateState(dir, "fixture", async (state) => {
      state.goals.push(
        createGoal({
          id: "writer" as GoalID,
          name: "writer",
          objective: "test",
          status: "active",
          ownerSessionID: "parent",
          workerSessionID: "w1",
          config: { workspaceWrite: true, write_scope: ["shared.ts"] },
        }),
      )
      state.runtimes.push(createRuntimeState("writer" as GoalID))
      state.goals.push(
        createGoal({
          id: "reader" as GoalID,
          name: "reader",
          objective: "test",
          status: "active",
          ownerSessionID: "parent",
          workerSessionID: "w2",
          config: { workspaceWrite: false, write_scope: [], artifactDir },
        }),
      )
      state.runtimes.push(createRuntimeState("reader" as GoalID))
      state.workspaceCalls = [
        {
          callID: "w-hold",
          sessionID: "w1",
          goalID: "writer" as GoalID,
          generation: 0,
          paths: ["shared.ts"],
          at: new Date().toISOString(),
        },
      ]
      return state
    })
    const hooks = await plugin.server({ directory: dir, client: {} } as any)
    fixtures.push({ hooks })
    const before = (sessionID: string, filePath: string) =>
      hooks["tool.execute.before"]!({ tool: "write", sessionID, callID: crypto.randomUUID() }, { args: { filePath } })
    return { dir, artifactDir, before }
  }

  it("lets a read-only goal write its own artifact while a writer holds the workspace", async () => {
    const { dir, artifactDir, before } = await fixture()
    await before("w2", path.join(artifactDir, "report.md"))

    const state = await readState(dir)
    // No reservation was recorded, so the writer's fence is all that remains
    // and the read-only goal can never wedge the project.
    expect(state.workspaceCalls).toHaveLength(1)
    expect(state.workspaceCalls![0]!.callID).toBe("w-hold")
  })

  it("still denies a read-only goal any write outside its artifact directory", async () => {
    const { before } = await fixture()
    await expect(before("w2", "shared.ts")).rejects.toThrow(/outside/)
    await expect(before("w2", "custom-progress.md")).rejects.toThrow(/outside/)
  })

  it("lets a read-only goal start while a writer holds the workspace", async () => {
    const dir = await root()
    const host = createFakeHost()
    const service = createGoalService(host)
    const { goal } = await startWriter(service, dir)
    // `uncontrolled` is the old hard blocker: a goal with no shared-workspace
    // ownership used to be denied activation until every shell had exited.
    await mutateState(dir, "test.uncontrolled", async (state) => {
      state.workspaceCalls = [
        {
          callID: "w-shell",
          sessionID: goal.workerSessionID!,
          goalID: goal.id,
          generation: 0,
          paths: [],
          uncontrolled: true,
          at: new Date().toISOString(),
        },
      ]
      return state
    })
    await plantCall(dir, { callID: "w-hold", sessionID: goal.workerSessionID!, goalID: goal.id })

    const reader = await service.start(dir, {
      name: "reader",
      objective: "inspect only",
      ownerSessionID: "other-parent",
      config: { workspaceWrite: false },
    })
    expect(reader.goal.config.workspaceWrite).toBe(false)
  })
})

describe("write-scope inference from the objective", () => {
  it("extracts named files and ignores prose, URLs and versions", async () => {
    expect(inferNamedFileWriteScope("fix src/a.ts and test/b.test.ts")).toEqual([
      "src/a.ts",
      "test/b.test.ts",
    ])
    expect(inferNamedFileWriteScope("see https://example.com/docs/x.md for context")).toBeUndefined()
    expect(inferNamedFileWriteScope("bump to 1.2.3 and ship it")).toBeUndefined()
    expect(inferNamedFileWriteScope("")).toBeUndefined()
  })

  it("applies the inferred scope so independent goals can run at once", async () => {
    const dir = await root()
    const service = createGoalService(createFakeHost())
    const { goal } = await service.start(dir, {
      name: "left",
      objective: "change src/a.ts",
      ownerSessionID: "parent",
    })
    expect(goal.config.write_scope).toEqual(["src/a.ts"])

    const right = await service.start(dir, {
      name: "right",
      objective: "change src/b.ts",
      ownerSessionID: "parent",
    })
    expect(right.goal.config.write_scope).toEqual(["src/b.ts"])
  })

  it("never overrides an explicit scope or a read-only goal", async () => {
    const dir = await root()
    const service = createGoalService(createFakeHost())
    const explicit = await service.start(dir, {
      name: "explicit",
      objective: "change src/a.ts",
      ownerSessionID: "parent",
      config: { write_scope: ["chosen.ts"] },
    })
    expect(explicit.goal.config.write_scope).toEqual(["chosen.ts"])

    const readOnly = await service.start(dir, {
      name: "reader",
      objective: "change src/a.ts",
      ownerSessionID: "parent",
      config: { workspaceWrite: false },
    })
    expect(readOnly.goal.config.write_scope).toBeUndefined()
  })
})
