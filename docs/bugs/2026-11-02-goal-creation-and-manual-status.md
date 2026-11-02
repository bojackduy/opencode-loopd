# Goal creation and misleading manual status

## Observed incident

The project-dropdown goal was created with an explicit directory matching the current project. Creation nevertheless enabled manual mode because the boundary checked whether the argument existed, not whether the directory differed. The worker continued executing while the table and inspector displayed “Awaiting input”: both rendered the scheduling flag without checking runtime activity.

The objective said to preserve `AGENTS.md`. Automatic scope inference interpreted that reference as write authority, initially granting only that file. The owner then granted the actual implementation paths separately. Those known paths could have been supplied in the original creation call. The installed skill and repository skill disagreed about scope inference.

## Changes

- Creation is autonomous by default in every directory. Only explicit `interactive:true` selects manual scheduling. Existing goals keep their settings.
- File scope comes only from explicit configuration. Omission retains legacy exclusive ownership; `[]` starts scoped exploration. Objective prose is not authority.
- Table, inspector and details share a runtime-aware active label. Running manual workers show Working. Confirmed idle manual workers with no active run or queued receipt show Awaiting input. Queued input and unknown idle states remain distinct.
- Tool descriptions and both repository and installed Loopd skills explain creation-time scope, later expansion, autonomous defaults and workspace-relative approved-command `cwd`.

## Verification

`bun run typecheck`, `bun run build` and `git diff --check` passed. A shell shelf check using the completed dropdown goal's stored data displayed Working for running manual execution, Awaiting input for confirmed idle, Input queued for a queued receipt, and Manual for unknown idle execution. No test files were created, edited or run.

The dropdown worker completed independently with host checks passing. Its diff was reviewed. Actual visual layout and keyboard/Escape interaction remain unverified; compilation is not a substitute for that check. Existing goals were not recreated or changed to repair the defaults.
