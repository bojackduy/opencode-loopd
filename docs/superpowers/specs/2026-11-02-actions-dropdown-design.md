# Actions dropdown and popup keyboard fixes

## Approved intent

Use the existing project dropdown pattern for Actions: anchor a names-and-shortcuts menu to the Actions button without unmounting the dashboard, table, or inspector. Keep action availability, direct shortcuts, commands, and destructive confirmations unchanged. Bound the list, follow selection, and open above the anchor when terminal space below is insufficient. Escape closes only the menu.

Details uses immediate one-line j/k/arrow steps and viewport-sized page steps. Coordination Tab and Shift+Tab cycle forward/backward through Writes, Verify, and Reservations with wrap. Existing direct and left/right navigation stays intact. Popup keys must precede host focus/navigation bindings.

## Approach

Reuse DashboardList/DashboardRow and host menu colors rather than introduce another popup framework or a full replacement view. Render Actions inside the inspector button's relative anchor. Route popup navigation through a high-priority host layer into the same dashboard handler, avoiding duplicate dispatch through defaultPrevented. Do not change unrelated dialogs or backend behavior.

## Diagnosis boundary

Source confirms that Details previously used two absolute lines for both line and page keys, and its low-level handler ignores events already consumed by the host. ScrollBox scrollBy updates scrollbars directly; there is no animation delay to remove. The precise reported latency has not been reproduced live, so routing and page-step corrections are not proof of a measured speedup.

## Constraints

No unit tests, dependencies, backend changes, commits, or service restart. Preserve unrelated AGENTS.md. Verify typecheck, tracked build, and diff whitespace. Live visual/input verification must be reported separately.
