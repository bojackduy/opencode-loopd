import fs from "fs/promises"; import os from "os"; import path from "path"
import { createGoal } from "/Users/duytrinh/Code/opencode-loopd/src/domain/goal.ts"
import { createRuntimeState } from "/Users/duytrinh/Code/opencode-loopd/src/domain/runtime.ts"
import { mutateState, readState } from "/Users/duytrinh/Code/opencode-loopd/src/infrastructure/state-repository.ts"
import { beforeWorkspaceTool, afterWorkspaceTool, sweepStaleWorkspaceState } from "/Users/duytrinh/Code/opencode-loopd/src/application/workspace-execution.ts"

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ticket-demo-"))
await mutateState(dir, "seed", async (s) => {
  s.goals.push(createGoal({ id: "g1", name: "alpha", objective: "t", status: "active", ownerSessionID: "o", workerSessionID: "w1", config: { workspaceWrite: true, write_scope: ["src/a.ts"] } }))
  s.goals.push(createGoal({ id: "g2", name: "beta", objective: "t", status: "active", ownerSessionID: "o", workerSessionID: "w2", config: { workspaceWrite: true, write_scope: ["src/b.ts"] } }))
  s.runtimes.push(createRuntimeState("g1"), createRuntimeState("g2"))
  return s
})
console.log("1) two workers, disjoint files -> both granted in parallel")
const [r1, r2] = await Promise.allSettled([
  beforeWorkspaceTool(dir, { tool: "write", sessionID: "w1", callID: "p1" }, { filePath: "src/a.ts" }),
  beforeWorkspaceTool(dir, { tool: "write", sessionID: "w2", callID: "p2" }, { filePath: "src/b.ts" }),
])
console.log("   w1 src/a.ts:", r1.status, "| w2 src/b.ts:", r2.status)
console.log("2) third write overlaps src/a.ts -> queued, not blocked globally")
const r3 = await beforeWorkspaceTool(dir, { tool: "write", sessionID: "w1", callID: "p3" }, { filePath: "src/a.ts" })
  .then(() => "granted (unexpected)", (e) => "queued: " + e.message.split("—")[0].trim())
console.log("   w1 src/a.ts again:", r3)
console.log("3) release p1 -> queued p3 is promoted to holder")
await afterWorkspaceTool(dir, "w1", "p1")
console.log("   holders now:", (await readState(dir)).writeTickets.holders.map((h) => h.callID).join(", "))
await afterWorkspaceTool(dir, "w2", "p2"); await afterWorkspaceTool(dir, "w1", "p3")
console.log("4) crash shape: goal deleted, holder orphaned -> periodic sweep reaps it")
await mutateState(dir, "kill", async (s) => {
  s.goals = s.goals.filter((g) => g.id !== "g1")
  s.writeTickets.holders.push({ ticketID: "t-x", goalID: "g1", sessionID: "w1", callID: "dead", files: ["src/a.ts"], grantedAt: new Date().toISOString() })
  return s
})
let swept = null
await mutateState(dir, "sweep", async (s) => { swept = sweepStaleWorkspaceState(s); return s })
console.log("   sweep reaped:", JSON.stringify(swept.reapedTickets), "| holders:", (await readState(dir)).writeTickets.holders.length)
await fs.rm(dir, { recursive: true, force: true })
console.log("DONE: no global lock, no stuck ticket")
