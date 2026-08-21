---
description: Create a new background loop goal. Asks clarifying questions, then spawns an autonomous worker session via loopd.
---

Create a new background loop goal using the `loopd_create_goal` tool.

First, gather what you need to craft a good goal:
- If the user gave a vague objective, ask 1–3 short clarifying questions (what to accomplish, where, and how they'll verify it).
- If the user was specific, skip straight to creating it.

When you have enough to write a concrete objective:
1. Call `loopd_create_goal` with:
   - `name` — a short slug (e.g. "pdf-notes")
   - `objective` — a precise, self-contained statement including verification criteria
   - `checks` — optional shell commands that must pass before the goal can be marked complete (e.g. `["npm test"]`)
   - `progressFile` — optional path to a markdown progress file
   - limits — optional `maxTurns`, `maxNoProgress`, `maxFailures`, `compactEvery`, `timeoutMs`
2. After it returns, tell the user the goal is running in the background and they can monitor it with `/loop` (or Ctrl+Shift+L).

Important: the worker session runs autonomously — do not try to do the goal's work in this chat. This chat only creates the goal.