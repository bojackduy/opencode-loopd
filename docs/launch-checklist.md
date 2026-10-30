# Launch Checklist — opencode-loopd

Prepared 2026-10-30. Status markers: [x] done · [ ] todo · [~] partial.

## Product / positioning
- [x] Product positioning doc (`docs/positioning.md`)
- [x] README value proposition + badges + install + quick start
- [x] Lifecycle contract doc (`docs/lifecycle-contract.md`)
- [x] File-scope ownership doc (`docs/file-scope-ownership.md`)
- [ ] Demo GIF/video (currently `assets/demo.png` only)
- [ ] 2-3 screenshots: dashboard, fullscreen terminal, goal completion

## GitHub
- [x] Public repo, description set
- [x] Topics set (autonomous, background-agent, claude-code, codex, goal, loop, opencode, opencode-plugin, subagent, tui, autonomous-agent, background-tasks, cli, developer-tools, agent)
- [x] License (AGPL-3.0-or-later, LICENSE present)
- [x] README renders on GitHub
- [x] GitHub Pages live (https://bojackduy.github.io/opencode-loopd/, 200)
- [x] Releases v1.14.2..v1.14.6 with notes
- [ ] Pinned repo on profile (manual)
- [ ] Social preview image (1280x640) — currently demo.png 1200x675

## npm
- [x] Published @bojackduy/opencode-loopd@1.14.6
- [x] publishConfig access public
- [x] GitHub Actions workflow (.github/workflows/npm-publish.yml) with lifecycle smoke
- [x] Trusted publishing (id-token: write)
- [ ] Verify `npm install @bojackduy/opencode-loopd` clean in a fresh dir (manual)
- [ ] README renders on npmjs.com (check)

## Landing page (docs/index.html)
- [x] Hero, features, install, FAQ, footer, meta, OG, Twitter, JSON-LD
- [x] robots.txt + sitemap.xml (lastmod updated 2026-10-30)
- [ ] Mobile QA screenshots
- [ ] Lighthouse run (perf/a11y/SEO)
- [ ] Add demo GIF to hero

## Branding
- [x] demo.png
- [ ] Logo SVG
- [ ] Favicon (currently emoji SVG data URI)
- [ ] OG image 1200x630 (reuse demo.png for now)
- [ ] Social banner

## SEO
- [x] Title, description, keywords, canonical, robots, sitemap, JSON-LD
- [ ] Submit sitemap to Google Search Console (manual, needs account)
- [ ] OpenSEO project + audit (tool not available in this session)

## Analytics
- [ ] PostHog project (not configured in this session; tool unavailable)
- [ ] Events: landing_page_view, hero_cta_clicked, github_clicked, npm_install_clicked
- [ ] Conversion funnel

## Content / launch
- [ ] 30-day content calendar (Notion not available; draft below)
- [ ] Launch posts: X, Reddit (r/programming, r/LocalLLaMA), HN, Product Hunt
- [ ] Technical blog post: "How we fence a shared workspace without killing parallelism"
- [ ] Demo video/GIF

## 30-day content calendar (draft)

Week 1 — Introduce
- Day 1: "What is opencode-loopd" — problem (blocked chats) + solution (background goals)
- Day 3: "How a goal loops" — engine, worker, checks, parent notification
- Day 5: "Command sessions vs bash" — fullscreen terminal, watches, timeouts
- Day 7: "Scheduled intervals" — 5s poll, skip-if-running

Week 2 — Deep dives
- Day 9: "Host-run checks, not model self-report" — why verification gates matter
- Day 11: "Scoped file ownership" — exact files, conflict detection, claim_goal_scope
- Day 13: "Mid-run identity switching" — model/agent swap with rollback
- Day 15: "Mid-goal grants" — unblocking workers without recreating goals

Week 3 — Launch prep
- Day 17: "From PTY spawn failure to reject-proof args" — war story
- Day 19: "Why we fence (and when we don't)" — scope design, single-human concurrency
- Day 21: "The trace log that exonerated the plugin" — debugging story
- Day 23: "v1.14.6 release notes" — scrollback, detached servers, grants

Week 4 — Launch
- Day 25: "Launch day post" (HN/Reddit/X)
- Day 27: "Tutorial: your first background goal"
- Day 29: "Lessons from 14 blocked goals" — honesty about model limits
- Day 31: "What's next" — roadmap

## Launch post drafts (short)

### Hacker News (Show HN)
Title: Show HN: opencode-loopd – background goals with verified completion for OpenCode
Body: OpenCode plugin that runs long tasks as autonomous child sessions while
the main chat stays free. Goals loop until host-run checks pass (not model
self-report). Scheduled intervals, mid-run model switching, fullscreen
terminal for background processes, modal TUI dashboard. AGPL, npm published.
Feedback welcome on the scope/fence design — we just loosened it after
real usage.

### Reddit (r/LocalLLaMA / r/programming)
Title: I built a "Claude Code loop" for OpenCode — background agents with
verified completion and scheduling
Body: ... (link, install one-liner, 3 GIFs)

## Approval gates (do NOT do without explicit approval)
- npm publish (already automated via tags; next release needs tag push)
- Public launch posts (drafts ready above)
- Repository visibility change
- Paid services / ads
- Deleting branches or history

## Next 5 highest-impact activities
1. Demo GIF/video in hero (biggest conversion lever).
2. Publish launch posts (HN + Reddit + X) — drafts above.
3. Add PostHog analytics + conversion funnel (once project is set up).
4. OpenSEO audit + fix top issues.
5. README "5-minute quickstart" with a real terminal recording.
