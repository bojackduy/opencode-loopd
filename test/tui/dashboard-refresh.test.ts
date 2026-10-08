import { describe, expect, test } from "bun:test"
import { createDashboardRefresh } from "../../src/tui/dashboard-refresh"
import type { StoreState } from "../../src/infrastructure/state-repository"

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const state: StoreState = { version: 9, revision: 1, goals: [], runtimes: [] }

describe("dashboard single-flight refresh", () => {
  test("100 in-flight requests collapse to one rerun, no out-of-order publication", async () => {
    const first = deferred<StoreState>()
    let reads = 0
    let active = 0
    let peak = 0
    let events = 0
    const revisions: number[] = []
    const queue = createDashboardRefresh({
      async getState() {
        active++; peak = Math.max(peak, active)
        const result = ++reads === 1 ? await first.promise : { ...state, revision: reads }
        active--; return result
      },
      async getEvents(limit) { expect(limit).toBe(20); events++; return [] },
    }, (s) => revisions.push(s.revision), () => { throw new Error("unexpected error") })
    const flight = queue.refresh()
    for (let i = 0; i < 100; i++) expect(queue.refresh()).toBe(flight)
    expect(reads).toBe(1)
    first.resolve(state)
    await flight
    expect(reads).toBe(2)
    expect(events).toBe(2)
    expect(peak).toBe(1)
    expect(revisions).toEqual([1, 2])
    await queue.refresh()
    expect(reads).toBe(3)
  })
  test("dispose during state read prevents event read and pending rerun", async () => {
    const wait = deferred<StoreState>()
    let reads = 0; let events = 0; let publishes = 0
    const queue = createDashboardRefresh({
      getState() { reads++; return wait.promise },
      async getEvents() { events++; return [] },
    }, () => publishes++, () => { throw new Error("unexpected error") })
    const flight = queue.refresh()
    queue.refresh(); queue.dispose(); queue.dispose()
    wait.resolve(state)
    await flight; await queue.refresh()
    expect([reads, events, publishes]).toEqual([1, 0, 0])
  })
  test("last event read resolving after unmount never publishes", async () => {
    const wait = deferred<Record<string, unknown>[]>()
    const entered = deferred<void>()
    let publishes = 0
    const queue = createDashboardRefresh({
      async getState() { return state },
      getEvents() { entered.resolve(); return wait.promise },
    }, () => publishes++, () => { throw new Error("unexpected error") })
    const flight = queue.refresh()
    await entered.promise
    queue.dispose(); wait.resolve([]); await flight
    expect(publishes).toBe(0)
  })
  test("error releases flight, pending requests and subsequent refresh can retry", async () => {
    const wait = deferred<StoreState>()
    let reads = 0; let errors = 0; let publishes = 0
    const queue = createDashboardRefresh({
      getState() { return ++reads === 1 ? wait.promise : Promise.resolve(state) },
      async getEvents() { return [] },
    }, () => publishes++, () => errors++)
    const flight = queue.refresh(); queue.refresh()
    wait.reject(new Error("read failed")); await flight
    expect([reads, errors, publishes]).toEqual([2, 1, 1])
    await queue.refresh()
    expect([reads, errors, publishes]).toEqual([3, 1, 2])
  })
  test("late rejection after disposal never changes status", async () => {
    const wait = deferred<StoreState>()
    let errors = 0
    const queue = createDashboardRefresh({ getState: () => wait.promise, getEvents: async () => [] },
      () => { throw new Error("unexpected publication") }, () => errors++)
    const flight = queue.refresh(); queue.dispose()
    wait.reject(new Error("late failure")); await flight
    expect(errors).toBe(0)
  })
})
