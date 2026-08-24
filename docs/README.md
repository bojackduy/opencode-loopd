# Documentation

> All project docs live under `docs/` (kebab-case). `README.md` and `CHANGELOG.md` stay at the repo root by convention.

## Structure

```
docs/
├── README.md                    # this index
├── index.html / robots.txt / sitemap.xml  # GitHub Pages site (keep at docs/ root)
│
├── planning/                    # Plans & roadmap
│   ├── e2e-hardened-plan.md     # E2E matrix for hardened lifecycle (1da88dc)
│   ├── future-work.md           # Future workflows & event-driven ideas
│   └── remaining-work.md        # Deferred work — phases 1-2 & 4
│
├── reports/                     # Investigation reports
│   ├── final-report.md          # Final fix status + dual-entity desync (2026-08-23)
│   └── investigation-report.md  # Engine & subagent desync deep dive (2026-08-23)
│
├── bugs/
│   └── bugs-new.md              # Live-testing bugs BUG-001 … BUG-004
│
└── development/
    └── testing-context.md       # Testing & development handoff context
```

## Naming convention

- **kebab-case** for all files and folders under `docs/` (e.g. `e2e-hardened-plan.md`, `final-report.md`).
- Root exceptions: `README.md` and `CHANGELOG.md` remain at repository root.

## Quick links

- **Planning**
  - [E2E Hardened Plan](./planning/e2e-hardened-plan.md)
  - [Future Work](./planning/future-work.md)
  - [Remaining Work](./planning/remaining-work.md)
- **Reports**
  - [Final Report](./reports/final-report.md)
  - [Investigation Report](./reports/investigation-report.md)
- **Bugs**
  - [Bugs — New](./bugs/bugs-new.md)
- **Development**
  - [Testing Context](./development/testing-context.md)

## Site

`docs/index.html` is the GitHub Pages landing page (`https://bojackduy.github.io/opencode-loopd/`). Keep `index.html`, `robots.txt`, and `sitemap.xml` at `docs/` root — moving them breaks Pages.
