import { readState, mutateState } from "../src/infrastructure/state-repository.ts"
const dir = "/Users/duytrinh/Code/opencode-loopd"
const id = "54118aa8-ff7b-471c-b9f4-eab9cf537c41"
await mutateState(dir, "patch-schedule", async (s)=>{
  const g = s.goals.find(x=>x.id===id)
  if (g) {
    g.config.schedule = { everyMs: 10000, maxRuns: 3 }
    console.log("patched", g.config.schedule)
  }
  const r = s.runtimes.find(x=>x.goalID===id)
  if (r) {
    r.scheduleRunCount = 0
    console.log("runtime before", r.scheduleRunCount)
  }
  return s
})
const state = await readState(dir)
const g = state.goals.find(x=>x.id===id)
console.log("after", g.config.schedule)
