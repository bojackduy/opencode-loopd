import { describe, it, expect } from "bun:test"
import { promises as fs } from "fs"
import path from "path"
import os from "os"
import { createHash } from "crypto"
import { mutateState, readState } from "../../src/infrastructure/state-repository"

const root = path.resolve(".opencode/loopd/goals/f788fd9a-7d81-4164-a7e8-3f763ccf7d0a/lock-tests")

describe("state lock contention", () => {
  it("times out behind a live process without stealing its aged lock, then recovers", async () => {
    const dir = path.join(root, crypto.randomUUID())
    const repository = path.resolve("src/infrastructure/state-repository.ts")
    const child = Bun.spawn([process.execPath, "-e", `
      import { mutateState } from ${JSON.stringify(repository)};
      await mutateState(${JSON.stringify(dir)}, "child holder", async (state) => {
        console.log("locked");
        await Bun.stdin.text();
        return state;
      });
    `], { stdin: "pipe", stdout: "pipe", stderr: "pipe" })
    try {
      const ready = await child.stdout.getReader().read()
      expect(new TextDecoder().decode(ready.value)).toContain("locked")
      const lock = path.join(os.tmpdir(), "loopd-locks",
        createHash("sha256").update(dir).digest("hex"), "state.lock")
      const metadata = JSON.parse(await fs.readFile(lock, "utf8"))
      metadata.acquiredAt = new Date(Date.now() - 20_000).toISOString()
      await fs.writeFile(lock, JSON.stringify(metadata))
      // Isolate virtual monotonic time in a subprocess: exercise actual wx
      // contention and expiry without making every full suite wait 30 seconds.
      const contender = Bun.spawn([process.execPath, "-e", `
        import assert from "node:assert/strict";
        import { mutateState } from ${JSON.stringify(repository)};
        let ticks = 0;
        performance.now = () => ticks++ < 2 ? 0 : 30000;
        let entered = false;
        await assert.rejects(mutateState(${JSON.stringify(dir)}, "blocked contender", async (s) => {
          entered = true;
          return s;
        }), /for "blocked contender" after 30000ms/);
        assert.equal(entered, false);
        assert.ok(ticks >= 4);
      `], { stdout: "pipe", stderr: "pipe" })
      const errors = await new Response(contender.stderr).text()
      expect(errors).toBe("")
      expect(await contender.exited).toBe(0)
      expect((await readState(dir)).revision).toBe(0)
      child.stdin.end()
      expect(await child.exited).toBe(0)
      await mutateState(dir, "after release", async (state) => state)
      expect((await readState(dir)).revision).toBe(2)
    } finally {
      child.stdin.end()
      child.kill()
      await child.exited
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it("serializes a burst beyond ten retry rounds without losing writes", async () => {
    const dir = path.join(root, crypto.randomUUID())
    try {
      const results = await Promise.allSettled(Array.from({ length: 16 }, (_, i) =>
        mutateState(dir, `contender:${i}`, async (state) => {
          // Controlled lock occupancy: even ideal scheduling requires 1.6s,
          // longer than the old 1.375s retry budget. Not a race-settling sleep.
          await Bun.sleep(100)
          return state
        }),
      ))
      expect(results.filter((r) => r.status === "rejected")).toEqual([])
      expect((await readState(dir)).revision).toBe(16)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  }, 15_000)

  it("does not serialize different directories with the same long prefix", async () => {
    const first = path.join(root, crypto.randomUUID())
    const second = path.join(root, crypto.randomUUID())
    let entered!: () => void
    let release!: () => void
    const started = new Promise<void>((resolve) => { entered = resolve })
    const gate = new Promise<void>((resolve) => { release = resolve })
    const holder = mutateState(first, "holder", async (state) => {
      entered()
      await gate
      return state
    })
    try {
      await started
      await mutateState(second, "independent", async (state) => state)
      expect((await readState(second)).revision).toBe(1)
    } finally {
      release()
      await holder
      await fs.rm(first, { recursive: true, force: true })
      await fs.rm(second, { recursive: true, force: true })
    }
  })
})
