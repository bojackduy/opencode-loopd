# Future Work — opencode-loopd

Architectural improvements and feature ideas for the loop engine.

> **Roadmap note (2026-09-03):** These ideas remain candidates, but their old
> priority labels are superseded by the launch gates in
> [Trust-First Product Spec](./trust-first-product-spec.md).

---

## 1. Custom Loop Workflows

**Problem:** Currently every goal is a single-shot prompt to a subagent. The child decides how to work with no structured plan. The user has no way to define *how* the loop should iterate.

**Goal:** Let users define explicit loop workflows — what the child does each turn, in what order, with what checks.

### Proposed model

A goal accepts an optional `workflow` array in its config. Each step is a named phase with its own prompt, verification, and skip/continue logic.

```ts
interface WorkflowStep {
  name: string                  // "fetch", "transform", "verify"
  prompt: string                // injected as the step's steering text
  verify?: string[]             // shell commands that must pass
  continueIf?: string           // condition expression evaluated by child
  maxRepeats?: number           // don't loop this step more than N times
}
```

Example:

```ts
workflow: [
  { name: "fetch", prompt: "Fetch the latest 10 news items and save to raw/", verify: ["ls raw/*.json | wc -l | grep ^10$"] },
  { name: "summarize", prompt: "Read raw/*.json, write ai-news.md with 10 items", verify: ["grep -c '^##' ai-news.md | grep ^10$"] },
  { name: "verify", prompt: "Run checks and confirm file exists", checks: ["test -f ai-news.md"] },
]
```

### Steering injection

Each turn, the engine selects the next incomplete step and injects it as the primary steering block:

```
## CURRENT WORKFLOW STEP: summarize
Step 2 of 3.
Read raw/*.json, write ai-news.md with 10 items.
After completion, call report_goal_progress with summary.
If verify passes, the step advances automatically.
```

### Completion logic

- The child calls `report_goal_progress` → engine marks the step as done.
- Engine advances to the next step automatically.
- If `verify` passes and no more steps → `complete_goal`.
- If `verify` fails → step repeats (up to `maxRepeats`).

### Trigger for workflow mode

```ts
loopd_create_goal({
  name: "news-roundup",
  objective: "...",
  workflow: [...]
})
```

When `workflow` is present, the engine uses step-based steering. When absent, falls back to current freeform steering.

### Priority

High — this turns loopd from a "prompt and hope" engine into a structured automation framework.

---

## 2. Event-Driven Subagent Behavior

**Problem:** The child agent works blindly. It doesn't react to OpenCode internal events (compaction, errors, model changes, permission requests). When compaction fires, the child may continue with a degraded context and produce worse work. When the parent session changes, the child doesn't know.

**Goal:** The child should observe events and make decisions based on them — not just blindly follow the continuation prompt.

### Proposed event hooks

The engine detects OpenCode events and injects them into the child's context on the next turn:

```ts
interface EventContext {
  recentEvents: Array<{
    type: string           // "session.compacted", "session.error", "model.changed", etc.
    detail?: string
    at: string
  }>
}
```

### Event-driven decisions

The child should be steered differently based on what happened:

| Event | Current behavior | Proposed behavior |
|---|---|---|
| `session.compacted` | Continues blindly | **Evaluate quality loss.** Child should re-read key files and verify progress before continuing. |
| `session.error` | Retry/backoff | **Classify error.** If recoverable (rate limit, timeout) → retry. If semantic (bad output) → report specific fix needed. |
| `model.changed` | Ignored | **Re-check assumptions.** Model behavior may differ; child should re-verify recent work. |
| `permission.ask` | Cascades to parent | Already handled by OpenCode native. No change needed. |

### Compaction guard (highest priority)

When the engine detects a compaction event on the child session:

1. **Inject a "post-compaction review" steering:**
   ```
   The session was just compacted. Your context was compressed.
   Before continuing, re-read the key files you need:
   - <progressFile>
   - <last 3 files created>
   Verify your current state matches reality. Do not assume.
   ```

2. **If the child's next progress report is weaker** (fewer details, generic summary):
   - Engine detects degraded quality.
   - Injects: "Your last response was less detailed than before. Re-read your work before continuing."

3. **If compaction happens N times** (e.g., 3):
   - Engine suggests: "This goal has been compacted multiple times. Consider spawning a fresh goal for the next phase."
   - Child can call `complete_goal` with a handoff note.

### Implementation sketch

In `loop-engine.ts`, when `session.compacted` fires:

```ts
// existing handling
runtime.lastCompactAt = new Date().toISOString()

// new: inject compaction context into next continuation
runtime.lastCompactionTurn = runtime.turnCount
```

In `worker-session.ts` steering, check for recent compaction:

```ts
if (runtime.lastCompactionTurn && runtime.turnCount - runtime.lastCompactionTurn <= 2) {
  parts.push(`\n## POST-COMPACTION REVIEW`)
  parts.push(`The session was compacted recently. Re-read critical files and verify state before continuing.`)
}
```

### Parent notification on compaction

When compaction fires on a child, optionally notify the parent:

```
Loop goal "X": session compacted at turn N. Context compressed.
```

This lets the parent agent know the child may need guidance.

### Priority

Medium — compaction guard is high value. Full event-driven behavior is a larger feature.

---

## 3. Other future ideas (brief)

- **Goal templates**: Pre-built workflow patterns (fetch-transform-verify, test-fix-loop, etc.)
- **Goal dependencies**: Goal B starts after Goal A completes
- **Cost tracking**: Real token/cost accounting per goal
- **Scheduled goals**: Cron-like triggers (no LLM per tick)
- **Goal export/import**: Share goal configs between projects
- **Dashboard transcript pane**: Live child transcript inside the dashboard without opening child session
- **Goal history**: Browse completed goals with full replay

---

*Last updated: 2026-08-22*
