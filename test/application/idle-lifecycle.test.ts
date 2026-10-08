import { expect, test, spyOn } from "bun:test"
import { promises as fs } from "fs"
import path from "path"
import os from "os"
import { createFakeHost } from "../../src/server/host-adapter"
import { createGoalService } from "../../src/application/goal-service"
import { createLoopEngine } from "../../src/application/loop-engine"
import { createScheduleWorker } from "../../src/application/schedule-worker"
import { createControlWorker } from "../../src/application/control-worker"
import { readState, mutateState } from "../../src/infrastructure/state-repository"

test("idle services don't multiply timers on repeat start and leave empty state unchanged", async () => {
  const root = process.env.LOOPD_TEST_TMPDIR ?? os.tmpdir()
  await fs.mkdir(root, { recursive: true })
  const directory = await fs.mkdtemp(path.join(root, "idle-test-"))
  const host = createFakeHost()
  const goalService = createGoalService(host)
  const engine = createLoopEngine({ directory, host, goalService, pollIntervalMs: 60000 })
  const schedule = createScheduleWorker({ directory, goalService, intervalMs: 60000 })
  const control = createControlWorker({ directory, goalService, pollIntervalMs: 60000 })
  const intervals = spyOn(globalThis, "setInterval")
  const cleared = spyOn(globalThis, "clearInterval")
  try {
    await mutateState(directory, "seed", async (s) => s)
    const before = await readState(directory)
    await engine.preloadWorkerSessions()
    engine.start(); engine.start(); schedule.start(); schedule.start(); control.start(); control.start()
    expect(intervals.mock.calls.length).toBe(3)
    expect(await schedule.tick()).toBe(0)
    expect((await readState(directory)).revision).toBe(before.revision)
    const timers = intervals.mock.results.map((r) => r.value)
    engine.stop(); engine.stop(); schedule.stop(); schedule.stop(); await control.stop(); await control.stop()
    for (const timer of timers) expect(cleared.mock.calls.some(([id]) => id === timer)).toBe(true)
    expect([engine.isRunning(), schedule.isRunning(), control.isRunning()]).toEqual([false, false, false])
  } finally {
    engine.stop(); schedule.stop(); await control.stop()
    intervals.mockRestore(); cleared.mockRestore()
    await fs.rm(directory, { recursive: true, force: true })
  }
})
