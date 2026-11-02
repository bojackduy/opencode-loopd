# Project dropdown overlay

## Approved intent

Replace the project panel with a compact dropdown anchored beneath the toolbar's
project selector. The dashboard remains mounted and unchanged behind the dropdown.
Show only project names and the current selection, never counts, statuses, or details.
The user approved this direction before implementation; no further interview is needed.

## Approach

Use an absolutely positioned, host-themed box inside the selector's toolbar anchor.
Reuse the dashboard's bounded scrolling list and selected-child following behavior.
A replacement panel would hide the dashboard; a host dialog would not anchor to
the selector. Neither matches the approved interaction.

## Behavior and constraints

- `P` or selector click opens the dropdown in Project and Commands.
- Project lists managed directories by basename. Commands prepends `All projects`.
- Opening highlights the current scope without changing it.
- `j/k` or arrows move the highlight; Enter or row click applies the choice.
- Escape consumes the event and closes only the dropdown, including in the Commands panel.
- Cancellation preserves the table mount, selection, filter, and scroll position.
- Bound height and width to available terminal space. Scroll follows the highlighted row.
- Builder positioning choice: open above the selector only when fewer than three
  terminal rows remain below it, keeping the names-only list usable on short terminals.
- Use existing host-theme surfaces and text. Add no dependencies or backend changes.
- Preserve unrelated `AGENTS.md`. Do not create, edit, or run unit tests.
- Verify with typecheck, build, and diff-check. Rebuild tracked distribution output.
- Do not commit or restart the service. Report live verification limitations explicitly.
