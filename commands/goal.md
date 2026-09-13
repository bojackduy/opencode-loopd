---
description: Create a new background loop goal. Asks clarifying questions, then spawns an autonomous worker session via loopd.
---

Create a new background loop goal using the `loopd_create_goal` tool.

A goal is a **contract**: `objective` (semantic requirements) + `checks` (deterministic host acceptance) + `agent`/`model`/`workspaceWrite`/`checkCwd`/`limits`. The host is the acceptance authority; the worker proposes completion and the host rejects it if `checks` fail (free retry <3, `blocked` after 3).

First, gather what you need to craft a good contract:
- If the user gave a vague objective, ask 1–3 short clarifying questions (what to accomplish, where, and how they'll verify it — i.e., what `checks` should be).
- If the user was specific, skip straight to creating it.

When you have enough to write a concrete contract:
1. Call `loopd_create_goal` with:
    - `name` — a short slug (e.g. "pdf-notes")
    - `objective` — a precise, self-contained statement including verification criteria
    - `agent` — any OpenCode agent name: built-in (`general`, `explore`), `~/.config/opencode/agents/*.md`, or `opencode.jsonc` `agent.*`. Discover with `opencode agent list`. Prefer `subagent`-mode agents for workers; `primary`-mode agents work but may expect user interaction. Optional unless no `defaultAgent` is configured.
    - `model` — any model as `"providerID/modelID"` (e.g. `openai/gpt-5.6-sol`, `ollama/qwen3.8:27b`). Discover with `opencode models [provider]`. Sent on every worker prompt; omit to use the agent/session default, or configure `defaultModel` in `opencode.jsonc`.
    - `checks` — shell commands that must pass before `complete_goal` is accepted; **mandatory when `workspaceWrite:true`** (the default) — or configure `defaultChecks` in `opencode.jsonc`
    - `workspaceWrite` — default `true` (safe — may touch the shared repo; only one active writer allowed — second `start`/`resume` fails with `already active`); set `false` explicitly for artifact-only/read-only work to allow concurrency
    - `checkCwd` — optional directory where `checks` run; writers default to project root, artifact-only jobs default to their `artifactDir`
    - `progressFile` — optional path to a markdown progress file (defaults to `<artifactDir>/progress.md`)
    - `costBudget` — max dollars before `budget_limited` (e.g. `0.5`); enforced continuously, worker aborted mid-turn when exceeded
    - limits — optional `maxTurns` (default 50), `maxNoProgress`, `maxFailures`, `compactEvery`, `timeoutMs` (also `costBudget` / `tokenBudget` for hard caps)
2. After it returns (`ok:true` with `goalID`/`artifactDir`/`defaultsApplied`, or `ok:false` with `errorCode: "missing_agent"|"missing_checks"|"already active"`), tell the user the goal is running in the background and they can monitor it with `/loop` (or <leader>o). On `missing_*`, explain the contract violation and ask for the missing piece; on `already active`, tell them to `pause`/`clear` the current writer or use `workspaceWrite:false`.

Important: the worker session runs autonomously — do not try to do the goal's work in this chat. This chat only creates the goal. Completion is host-judged: if `checks` fail, the worker will see `HOST VERDICT: COMPLETION REJECTED` with exact `stderr` and must fix the behavior (not just rewrite evidence) before retrying.
