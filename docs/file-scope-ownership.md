# Exact-file goal ownership

`loopd_create_goal` accepts `write_scope`:

| Contract | Shared-source ownership |
| --- | --- |
| `workspaceWrite: true`, scope omitted | Legacy whole-workspace exclusivity |
| `write_scope: []` | Exploration only; no source writes until claimed |
| `write_scope: ["src/a.ts"]` | Exact files; disjoint owners may run concurrently |
| `workspaceWrite: false` | Read-only source; own goal artifacts only |

Paths can name new files. They are canonical workspace-relative files, not
globs or directories. Existing symlinks and new-file parents are resolved;
outside-root and dangling-symlink claims are rejected. Scope never authorizes
changing a directory/symlink to redirect future writes. All writers must use
the enforcing plugin in the same canonical workspace.

## Worker workflow

1. Read `get_goal`, then explore using reads/search.
2. Call `claim_goal_scope({ paths: ["src/a.ts"], runGeneration })`, using the
   generation from `get_goal`. Claim the smallest useful set.
3. Edit using structured `edit`, `write`, or `apply_patch`. Expansion must be
   claimed first; rename requires ownership of both old and new paths.
4. Call `run_goal_checks` to execute configured verification, then report
   progress or propose completion. `complete_goal` checks use the same lock.

Claims are additive and all-or-nothing in persisted transactions. Creation,
resume, claim, and scheduled activation use the same conflict rules. Failed
expansion retains only previously acquired files, never a partial expansion.
The error names the path, owning goal, and owner session. Listing goals is
owner-scoped; the conflicting goal may belong to another session.

**Initial conflict policy:** fail immediately, `kind: initial`, with no automatic
waiting queue. Expansion returns `kind: expansion`. Both return
`coordinate_then_retry`; coordinate with the owner, then retry after release.
Do not sleep, repeatedly prompt workers, or poll claims. No event-driven claim
queue is implemented: a queued initial request would need additional worker
parking/cancellation semantics; immediate failure avoids hidden ownership and
hold-and-wait deadlocks.

## Execution boundaries

Before execution, every touched file of a multi-file patch is validated in one
transaction, including additions, deletion, and both rename endpoints. If any
file is denied, the tool executor must not run. Known structured writes reserve
their paths until execution finishes. The parent can edit unclaimed files, but
cannot edit another goal's live claims.

Under scoped/read-only contracts, arbitrary shell, standalone command start or
stdin, unknown custom tools, batch, and write-capable subagents are denied.
Read/search and goal contract tools remain available. Unknown child sessions
cannot acquire source-write authority. The command service applies the guard
even on dashboard/control calls without a model-tool hook. Existing running
command processes and in-flight uncontrolled tools prevent protected activation.

Configured checks are **trusted contract commands**, not an OS/filesystem
sandbox. Their workspace-wide operation reservation excludes source edits and
other checks, and cannot start over in-flight source writes. Configure builds
with shared outputs as checks; no arbitrary shell escape hatch is provided.
Git commit/release tools are denied under protected ownership; perform such
operations only after goals/writes are quiescent and ownership is released.
The plugin does not authorize commits or releases on a worker's behalf.

V2 wraps the supported tool editor's execution surface in addition to hooks:
the installed Promise SDK represents hook errors as Effect defects, so relying
on a before-hook error alone is insufficient. A host without editor list/update
support fails plugin setup. The installed SDK conversion is integration-tested
through its real Promise-to-Effect adapter. V1 hook errors are propagated outside
tracking's best-effort catch, but its deployed runtime veto contract cannot be
established from SDK types alone. **Explicit scopes/claims are therefore refused
on v1**; only legacy exclusive goals are supported there. Loading persisted
scoped workers on an unsupported host blocks/fences them rather than prompting
them. Old read-only/unscoped contracts retain their legacy behavior; their v1
hooks are not advertised as a filesystem sandbox or guaranteed parallel guard.

External editors, detached processes spawned outside the coordinated execution
surface, malicious/replaced plugins, and direct filesystem access are not
sandboxed. Do not run them concurrently against claimed files. A missing command
handle is not proof of process exit: persisted orphan-process fences survive
log removal, and protected activation is denied while the PID may still exist
(including inaccessible/reused PIDs). Stop/verify orphan processes externally.

Explicit non-goals (documented, not enforced): hardlink aliases (two paths to
one inode are not collapsed by symlink canonicalization), and TOCTOU races
(symlink or path retargeting between pre-execution validation and the tool's
own write). Scope never authorizes changing a directory/symlink to redirect
future writes, but the guard is a coordination mechanism over the plugin
execution surface, not a filesystem sandbox.

Error-path note: the v2 wrapped executor releases its reservation in a
`finally`, so a failed tool frees the file. The v1 host has no error hook and
skips its after trigger when execution fails, so a failed call's reservation
remains until host restart or manual state recovery. The direction is
fail-closed (later writes are denied, never silently allowed); reservations
carry an `at` timestamp for diagnosis. Explicit scopes are refused on v1, so
this only affects read-only-artifact and unscoped reservations there.

## Release, restart, and inspection

Pause fences new writes before abort. In-flight calls retain the goal's entire
scope, not just the currently written file. Completion, block, and budget status
changes likewise retain ownership while calls remain. Clear keeps an ownership
tombstone until writes/checks drain. If a host never reports completion after a
crash, reservations remain fail-closed; restart does not invent proof of exit.

Resume/retry of explicit scoped goals reacquires atomically and rotates worker
sessions. Retired session tombstones deny delayed write tools. Legacy unscoped
workers retain their existing lifecycle/session behavior. Scoped nudge/abort
also rotates; owner input queues for the next quiescent turn instead of forcing
overlapping prompts.

Combined identity-switch `resume` is unsupported for explicit scoped goals:
use `resume_goal` to reacquire/rotate first, then switch identity on the active
worker. This prevents an identity shortcut from reviving a retired session.

`get_goal`, owner inspection, and the dashboard show scope and closing state.
There is no automatic claim-wait state. Conflict responses carry owner/path
diagnostics, and inspection exposes the coordination-only retry policy.
