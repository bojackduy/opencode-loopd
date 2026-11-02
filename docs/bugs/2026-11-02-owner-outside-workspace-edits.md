# Owner outside-workspace edits denied (2026-11-02)

## Symptom

With any protected (scoped) goal active, a structured edit (`edit`/`patch`/`write`)
to a file outside the project workspace — e.g. the installed skill at
`/Users/duytrinh/.config/opencode/skills/loopd/SKILL.md` — fails with:

```
Scope path is outside the workspace or names its root: <absolute path>
```

forcing the owner into a shell bypass that the worker guidance itself condemns.

## Root cause

`canonicalScopePath` (`src/infrastructure/workspace-scope.ts:24`) throws for any
path outside the workspace root. In `src/application/workspace-execution.ts` the
no-protected-goals branch catches canonicalization failure and records the call
uncontrolled/allowed — but the protected-goals branch called it bare, turning an
out-of-jurisdiction path into a hard denial even for a proven owner session.

Outside-workspace files cannot conflict with workspace tickets (no ticket can
represent them), so fencing them buys no safety, only friction.

## Fix

The protected branch now catches the outside-workspace error: a proven owner
non-worker session (`!goal && isOwner`) is recorded uncontrolled with empty paths
and allowed through — same treatment as shells and the no-protected-goals branch,
so checks still wait for quiescence. Workers, strangers, malformed in-workspace
paths, the read-only branch, and the operation lock are unchanged.

## Verification

`bun run typecheck`, `bun run build`, `git diff --check`. Live owner edit outside
the repo while a scoped goal is active remains to be exercised after restart.
