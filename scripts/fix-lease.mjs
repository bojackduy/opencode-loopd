import { mutateState } from "../src/infrastructure/state-repository.ts"
const dir = "/Users/duytrinh/Code/opencode-loopd"
const id = "54118aa8-ff7b-471c-b9f4-eab9cf537c41"
await mutateState(dir, "fix-lease", async (s)=>{
  const r = s.runtimes.find(x=>x.goalID===id)
  if (r) {
    r.leaseExpiresAt = undefined
    r.turnStartedAt = undefined
    r.activeRunID = undefined
    r.activePromptMessageID = undefined
    console.log("cleared lease", r.phase, r.leaseExpiresAt)
  }
  return s
})
console.log("fixed")
