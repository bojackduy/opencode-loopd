# Trust-First Product Spec

> **Status:** Draft for product engineering
> **Date:** 2026-09-03
> **Decision:** Fix unattended trust and resource efficiency before expanding features or acquisition.
> **Precedence:** This spec governs current roadmap priority when older planning
> documents conflict with it.

## 1. Executive Decision

Loopd should not be positioned as a background-agent engine, scheduler, or TUI.
Its product promise is:

> Give OpenCode an outcome, keep using the main session, and hear back only when
> the outcome is verified or a genuinely human decision is required.

The user should be able to forget that loopd is running. If they must inspect,
nudge, resume, decode a runtime state, or notice provider limits themselves,
loopd has returned ownership of the work to the user and broken the promise.

The immediate priority is therefore not more workflows, schedules, templates,
or dashboard controls. It is making one delegated goal finish reliably without
supervision and without spending materially more model usage than the same work
performed manually.

Daily use is not itself the target. Daily use should emerge for developers who
have a multi-step, verifiable task most days. The product metric is unattended
work delivered, not command frequency.

The core hypothesis is that developers who experience bounded, verified work
with zero babysitting and low orchestration overhead will voluntarily delegate
again. If that is false, more features will not create durable retention.

## 2. Why Now

An initial npm download spike shows launch curiosity. It does not show active
usage, successful activation, churn, or retention. Package downloads also
include reinstalls, CI, caches, bots, and version checks.

A live dogfood run on 2026-09-03 provides stronger evidence about the current
product experience.

| Observation | Result |
|---|---:|
| Goal duration | About 66 minutes |
| Durable milestones completed | 14 |
| False worker-unreachable notifications | 8 |
| Manual `nudge_goal` recoveries | 7 |
| Final manual intervention | Pause after provider usage limit |
| Parent loopd-management tool calls | 21 |
| Parent input tokens caused by false recovery turns | 1,828,299 |
| Parent cache-read tokens caused by false recovery turns | 6,591,618 |
| Worker input tokens | 420,519 |
| Worker cache-read tokens | 24,048,128 |
| Tokens reported by loopd state | 0 |

The worker was productive. The orchestration made healthy progress appear
unhealthy, repeatedly woke the parent agent, and hid real resource use.

### Confirmed status-semantics defect

OpenCode's `GET /session/status` response is a sparse map. Idle sessions are
removed from the map; normally only `busy` and `retry` sessions are present.
Loopd currently interprets a missing worker entry as `unknown`, then warns the
parent that the worker is unreachable. In the dogfood run, the parent inspected
and force-nudged a healthy idle worker after each false warning.

Authoritative upstream behavior:

- OpenCode status implementation: <https://github.com/anomalyco/opencode/blob/4b7e19e315cca414121ba1d61523fef74bb3ae8b/packages/opencode/src/session/status.ts#L26-L48>
- OpenCode session endpoint: <https://github.com/anomalyco/opencode/blob/4b7e19e315cca414121ba1d61523fef74bb3ae8b/packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts#L77-L79>

### Other confirmed trust gaps

- `noProgressCount` is reset but never incremented, so the no-progress guard
  cannot detect an unproductive loop.
- Goal and turn token fields are initialized but never populated, so resource
  limits and the dashboard cannot protect the user.
- A provider usage-limit 429 is handled as a generic failure even though the
  domain already defines `usage_limited`.
- Continuation prompts repeat the objective, all progress history, and recent
  transcript excerpts inside a session that already retains its transcript.
- Routine health notifications are sent through `promptAsync` to the parent,
  starting an expensive parent-model response instead of delivering a passive
  status update.
- Completion checks run only when the worker chooses to call `complete_goal`.
  A worker can continue past an already sufficient stopping point.

## 3. Target User And Job

### Primary user

A developer who already uses a coding agent throughout the day and regularly
has tasks that require multiple tool steps, retries, or verification.

### Job to be done

> When a task will take sustained agent work, let me delegate the outcome and
> continue with something else, so I receive verified work without managing the
> agent's execution loop.

### High-frequency wedge

Loopd should first become excellent at common, bounded engineering outcomes:

- Fix a failing test or CI check until it passes.
- Implement a scoped change and run the repository's verification commands.
- Reproduce, diagnose, fix, and verify a reported bug.
- Complete a mechanical migration across a repository and validate it.
- Produce a bounded research or analysis artifact with explicit evidence.

Large open-ended batch jobs remain supported, but they are not the first-run
experience or the reliability benchmark.

### Not the primary user

- Someone running a one-step or conversational task.
- Someone who wants a general cron system.
- Someone who cannot define or infer any observable completion evidence.
- Someone expecting absolute correctness where no verifier exists.

## 4. Product Promise

A loopd goal owns four responsibilities that would otherwise belong to the
user:

1. **Continue:** keep working while useful work remains.
2. **Adapt:** use failure evidence to change the next action, not repeat blindly.
3. **Verify:** finish only against an explicit definition of done.
4. **Escalate:** involve the user only for a decision or dependency the system
   cannot resolve itself.

The promise is not "retry forever." It is "persist economically while progress
is possible, suspend safely when capacity is unavailable, and never pretend a
system failure requires human judgment."

## 5. Trust Requirements

The following are release-blocking requirements, not optional polish.

### TR-1: No babysitting

A healthy goal must not require `inspect`, `nudge`, `resume`, dashboard polling,
or repeated parent-agent responses.

### TR-2: Silence is actionable

No news means the goal is still owned by loopd. Every interruptive notification
must either report verified completion or request a specific human decision.
Non-actionable capacity and progress information may remain passively visible.

### TR-3: State reflects reality

User-visible status must be based on confirmed worker/session evidence. An
absent sparse-status entry is not evidence that a worker is unreachable.
`unknown` is an internal observation, not a user-facing terminal state.

### TR-4: Correctness is explicit

"Done" means the agreed `done_when` conditions passed. Loopd must not market
absolute correctness beyond those conditions.

### TR-5: Persistence is economical

Every continuation must have a concrete reason: new durable progress, new
failure evidence, a changed strategy, new user input, or a final verification
step. Repeating the same context and strategy is not persistence.

### TR-6: Limits are honest and recoverable

Usage, token, time, and provider-capacity states must be visible and accurate.
Known reset windows should suspend work and resume automatically rather than
burn retries or require manual recovery.

### TR-7: Restarts preserve ownership

After an OpenCode or plugin restart, loopd must reconstruct the worker and goal
state without losing the contract, durable progress, pending input, or next
action.

## 6. Desired User Experience

### Start

The user writes a natural outcome:

```text
/goal fix the checkout race and keep going until its regression test passes
```

The parent agent compiles the request into a goal contract. It should infer the
agent, workspace mode, repository checks, and safe defaults. It asks a question
only when two plausible definitions of done would materially change the work.

The receipt is brief and concrete:

```text
Working in the background. Done when the focused regression test and repository
test suite pass. I will notify you only if it finishes or needs your decision.
```

The user should not need to understand `workspaceWrite`, `checkCwd`, leases,
generations, retries, or evaluator limits.

### Run

- The main session remains available.
- Progress is persisted and inspectable but quiet by default.
- Normal idle transitions continue internally.
- Failed checks become worker evidence for the next strategy.
- Infrastructure failures back off internally.
- Provider capacity limits suspend until reset.
- A no-progress sequence triggers strategy escalation before involving the user.

### Finish

Completion communicates outcome, proof, and changed artifacts in one compact
handoff:

```text
Goal complete: checkout race fixed.
Verified: focused regression test and full test suite pass.
Changed: 3 files.
```

### Needs the user

The user receives one question that explains the unresolved fork and the
consequence of each choice. Internal diagnostics remain available but are not
the primary message.

## 7. Goal Contract

Natural language remains the input. Internally, creation must produce one
coherent source of truth:

```ts
interface GoalContract {
  outcome: string
  doneWhen: Array<{
    requirement: string
    verifier: "command" | "artifact" | "semantic"
    evidence?: string
  }>
  constraints: string[]
  nonGoals: string[]
  resourcePolicy: "normal" | "extended"
}
```

This shape is illustrative; compatibility with the current persisted model is
an implementation decision.

### Contract rules

- `outcome` and `doneWhen` cannot contradict each other.
- Every required outcome must map to at least one verifier or be explicitly
  labeled semantic-only.
- Minimum checks cannot silently replace a broader outcome. "Process every
  project" and "at least 10 archives exist" require clarification or an explicit
  partial-completion rule.
- The generated contract is shown as a one- or two-line receipt, not a setup
  form.
- Advanced users may override inferred checks and limits.
- The host owns deterministic command and artifact verification.
- Semantic completion must cite concrete artifacts and disclose that it is a
  model judgment.

### Completion behavior

- The host may pre-run cheap deterministic verifiers at an idle boundary.
- If all deterministic verifiers pass, the next prompt is a bounded final
  semantic review, not another open-ended work prompt.
- Failed verifiers return exact evidence to the worker and keep the goal active.
- Repeated verifier failure triggers a strategy reset before `needs_user`.
- An arbitrary rejection count is not, by itself, a human blocker.

## 8. Lifecycle Semantics

User-facing states should describe ownership, not engine internals.

| Condition | User-facing state | Required behavior | Notify? |
|---|---|---|---|
| Worker is busy | Running | Observe; do not prompt concurrently | No |
| Worker becomes idle with work remaining | Running | Confirm the completed turn, then continue | No |
| Worker is absent from sparse active-status map | Running | Treat as inactive/idle evidence, not unreachable | No |
| Prompt or network call fails transiently | Waiting to retry | Back off and retry with the same contract | No |
| Provider usage limit has a reset time | Waiting for capacity | Set `usage_limited`, wait, then auto-resume | No interrupt; show in status |
| Completion verifier fails | Repairing | Feed exact failure to the worker and change next action | No |
| One turn makes no durable progress | Recovering | Send a focused corrective instruction | No |
| Repeated turns make no progress | Recovering | Compact or start a fresh worker from durable state | No |
| Strategy resets cannot progress | Needs you | Ask one specific decision with evidence | Yes |
| External credential, permission, or product decision is required | Needs you | Preserve state and wait | Yes |
| User pauses | Paused | Stop model work and preserve state | Confirmation only |
| All `doneWhen` conditions pass | Done | Persist evidence and hand back the result | Yes |

`running`, `waiting`, and `recovering` are loopd-owned states. They must not ask
the parent agent to operate the goal.

## 9. Resource-Efficiency Contract

### Context

Each continuation prompt should contain only:

- Goal identity and a compact contract summary.
- Latest durable progress summary.
- The next concrete action.
- New owner input since the previous turn.
- The latest relevant failure or verifier result.

Full progress history and transcript tails remain persisted for inspection, but
must not be replayed on every turn. A fresh worker or post-compaction recovery
receives one compact checkpoint, not an unbounded event history.

### Usage accounting

- Capture input, output, reasoning, cache-read, and cache-write tokens from
  completed assistant messages.
- Attribute usage to the goal and run generation without double counting.
- Show real totals and per-turn deltas.
- Never display zero when usage is unknown; display `unavailable` instead.
- Classify provider quota errors separately from ordinary transient failures.
- Strip response headers, tokens, paths, and prompt content from user-facing
  quota diagnostics.

### Parent isolation

- Health and progress delivery must not call `promptAsync` on the parent.
- Use a passive TUI event, toast, persisted inbox item, or equivalent transport.
- Waking the parent model is reserved for an explicit user request or a single
  terminal handoff where model synthesis is intentionally enabled.
- Automatic recovery occurs in the worker/engine, never through a parent-agent
  inspect-and-nudge loop.

## 10. Success Metrics

### North star

```text
Unattended verified completion rate
= verified completed goals with zero owner recovery actions
  / all started goals with a valid contract
```

An owner recovery action is `inspect`, `nudge`, `resume`, contract repair, or
manual status diagnosis performed because loopd failed to maintain ownership.
Voluntary inspection does not count unless it is followed by recovery.

### Trust metrics

| Metric | Initial target |
|---|---:|
| False unhealthy notifications | 0 |
| Median owner recovery actions per completed goal | 0 |
| Unattended verified completion rate in controlled suite | At least 90% |
| Goals falsely marked done in controlled suite | 0 |
| Known usage-limit events classified correctly | 100% |
| Restart recovery success | 100% in integration suite |

### Efficiency guardrails

| Metric | Initial target |
|---|---:|
| Extra model usage versus manual execution of the same task | No more than 20% |
| Continuations with progress, new evidence, or changed strategy | At least 90% |
| Parent model turns caused by non-terminal loopd events | 0 |
| Goal usage totals missing or falsely reported as zero | 0 |

The manual comparison must use the same model, repository state, task contract,
and verification commands. Cached and uncached tokens are reported separately.

### Activation and retention

- **Activated:** first goal reaches verified completion without an owner recovery
  action.
- **Early retained:** at least one unattended verified completion on two distinct
  days within seven days of activation.
- **Habit signal:** the user starts a suitable goal without being reminded and
  would choose loopd over manually supervising the same task.

Npm downloads are an acquisition signal only and must not be used as a
retention denominator.

## 11. Measurement And Privacy

P0 uses the existing local event ledger and OpenCode message usage to validate
reliability. Add a redacted diagnostic export before adding remote telemetry.

The diagnostic bundle may include:

- Plugin and OpenCode versions.
- Goal/run counts and state transitions.
- Durations and aggregate token counts.
- Verifier pass/fail counts.
- Owner recovery action counts.
- Error category and retry timing.

It must exclude:

- Objectives, prompts, summaries, and model output.
- File paths, filenames, repository names, and command text.
- Environment values, credentials, response headers, and provider tokens.
- Source files and generated artifacts.

Remote product telemetry, if introduced, must be consented to and follow the
same redaction boundary. Until then, use opt-in diagnostic bundles and direct
dogfood interviews rather than pretending npm traffic measures retention.

## 12. Delivery Plan

### P0: Restore trust in the control loop

1. Correct sparse status semantics: missing means not active, not unreachable.
2. Keep explicit `unknown` only for request failure or invalid response data.
3. Remove parent-model wakeups from health and recovery paths.
4. Implement real no-progress accounting and strategy escalation.
5. Track real per-goal usage from message events.
6. Classify provider usage limits as `usage_limited` and auto-resume when a
   trustworthy reset time is available.
7. Add regression tests and one live bounded E2E run.

P0 is successful when a three-milestone goal crosses every idle boundary,
finishes, and notifies the user with zero false alerts, zero nudges, and zero
parent model turns during execution.

### P1: Make completion decisive and efficient

1. Compile natural language into a coherent `outcome` and `doneWhen` contract.
2. Reject or clarify contradictory stopping conditions before starting.
3. Pre-run cheap deterministic checks at idle boundaries.
4. Bound continuation context to the latest checkpoint and new evidence.
5. Recover from compaction or a fresh worker using durable state.
6. Run a same-model manual-versus-loopd benchmark suite.

P1 is successful when at least 9 of 10 representative engineering goals finish
without owner recovery and loopd adds no more than 20% model usage over manual
execution.

### P2: Earn habitual use

1. Let the parent agent recognize suitable long-running tasks without requiring
   the user to remember `/goal`.
2. Make the first-run example a real fix-until-green task, not a novelty demo.
3. Present one compact contract receipt and one terminal handoff.
4. Add history or reusable recipes only after repeated task patterns are
   observed in dogfood data.
5. Pilot with five agent-heavy developers for seven days.

P2 is successful when users voluntarily delegate again after a successful goal,
not when the package receives another launch download spike.

### P3: Expand only after trust holds

Candidates include scheduled goals, custom workflows, dependencies, templates,
and deeper dashboards. Existing capabilities remain available, but they do not
drive roadmap priority until unattended completion and efficiency targets hold.

## 13. Validation Suite

The first controlled suite should include:

1. A focused test failure that requires one code fix and deterministic checks.
2. A multi-file refactor with a full typecheck and test suite.
3. A bug investigation that must reproduce before fixing.
4. A bounded three-item batch task with one idle boundary per item.
5. A verifier rejection that requires a changed implementation.
6. A transient prompt failure with automatic backoff.
7. A provider usage-limit response with a known reset time.
8. A no-progress worker that repeats its approach.
9. An OpenCode restart between milestones.
10. A genuine external blocker requiring one user decision.

For each task, capture:

- Outcome and verifier result.
- User-visible state transitions and notifications.
- Owner recovery actions.
- Worker and parent model steps.
- Input, output, reasoning, and cache tokens.
- Time to first durable progress and verified completion.
- Whether each continuation introduced progress, evidence, or a new strategy.

## 14. Non-Goals For This Cycle

- Redesigning the modal dashboard.
- Adding more status colors or runtime counters without fixing their truth.
- Adding cron syntax, dependencies, or workflow DSLs.
- Optimizing README conversion or npm download volume.
- Supporting multiple concurrent workspace writers.
- Promising correctness for outcomes that have no observable verifier.
- Retrying unchanged work indefinitely.

## 15. Product Decisions

The following decisions are made by this spec:

- Trust and efficiency precede feature breadth and growth work.
- The dashboard is an advanced control surface, not the core experience.
- Missing session status-map entries are not treated as unreachable workers.
- Routine loopd events do not invoke the parent model.
- Usage limits suspend and resume; they are not generic failures.
- Repeated verification failures trigger strategy change before user escalation.
- Natural-language contract compilation is a product responsibility, not a form
  the user must fill out.
- Npm downloads are not a retention metric.

## 16. Launch Gate

Do not run another acquisition push until all of these are true:

- The status-semantics regression is fixed and covered by an adapter test.
- Twenty consecutive controlled or dogfood goals produce zero false unreachable
  notifications.
- At least 90% of valid-contract goals complete with zero owner recovery actions.
- Provider usage-limit behavior is safe, visible, and tested.
- Goal usage accounting no longer reports false zeroes.
- The same-model benchmark stays within the 20% efficiency guardrail.
- Five external users can explain the promise as "it owns the task until it is
  verified," without mentioning the dashboard or engine internals.

If these gates fail, improve the ownership loop. Do not compensate with more
controls, more documentation, or another launch spike.

## 17. Open Decisions

These questions do not block P0 unless stated otherwise:

- Which OpenCode surface can deliver passive status without invoking the parent
  model? This blocks removal of `promptAsync` notifications.
- Which provider error fields can supply a trustworthy quota reset time without
  persisting sensitive headers? Unknown reset times should remain safely paused.
- When does semantic completion justify an independent reviewer rather than the
  existing worker? Decide from benchmark quality and cost, not intuition.
- Which ten tasks form the stable manual-versus-loopd benchmark? Freeze their
  contracts and fixtures before using them for roadmap decisions.
- What usage overhead is acceptable after separating cache reads from newly
  billed input? The initial 20% guardrail is a hypothesis to validate.

## 18. Evidence Trace

The 2026-09-03 dogfood findings came from these local records:

- Goal ID: `3775aee0-ec3e-4aab-9003-d481d314e605`
- Worker session: `ses_f99cfc41effeNNAyNz7J6ZkidJ`
- Owner session: `ses_f9a42097cffeR6yNjnwRjBPCe9`
- Goal state: `~/.opencode/loopd/state.json`
- Goal events: `~/.opencode/loopd/events.ndjson`
- Engine log: `/tmp/loopd-server.log`
- OpenCode messages and token usage: `~/.local/share/opencode/opencode.db`

These raw records remain local because they can contain prompts, paths, and
artifacts. The spec records only aggregate evidence needed for product decisions.
