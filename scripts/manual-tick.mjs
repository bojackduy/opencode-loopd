import { readState } from "../src/infrastructure/state-repository.ts"
import { createScheduleWorker } from "../src/application/schedule-worker.ts"
import { createGoalService } from "../src/application/goal-service.ts"
const dir = "/Users/duytrinh/Code/opencode-loopd"
const mockHost = { createWorker: async()=>{}, promptWorker: async()=>{}, sessionStatus: async()=>"idle", abortSession: async()=>{}, readMessages: async()=>[], compactSession: async()=>{}, notifyOwner: async(e)=>console.log("notify",e)}
const svc = createGoalService(mockHost)
svc.continueTurn = async (d, id)=>{ console.log("continueTurn", id)}
const w = createScheduleWorker({directory: dir, goalService: svc})
const state = await readState(dir)
for (const g of state.goals) if (g.id==="54118aa8-ff7b-471c-b9f4-eab9cf537c41") console.log("goal", g.config.schedule, state.runtimes.find(r=>r.goalID===g.id))
console.log("tick...")
const n = await w.tick()
console.log("resurrected", n)
const after = await readState(dir)
console.log("after", after.goals.find(g=>g.id==="54118aa8-ff7b-471c-b9f4-eab9cf537c41").status, after.runtimes.find(r=>r.goalID==="54118aa8-ff7b-471c-b9f4-eab9cf537c41"))
