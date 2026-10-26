# Public adoption and distribution: prevalentWare/opencode-goal-plugin vs bojackduy/opencode-loopd

## 1. Does public evidence verify “more users”?

### Takeaway
PrevalentWare has substantially more measurable public attention, download activity, and contributor participation. **Actual unique or active users are not measured by these sources**, so “more users” remains unverified. The defensible claim is “larger observed public footprint and npm download volume.”

### Cited Findings

**Observation protocol.** Read-only GitHub calls used authenticated `gh-personal` (account identity verified); npm requests used public HTTPS endpoints. The shell returned **2026-10-18T02:07:39Z**, and npm HTTP `Date` headers independently returned **Sun, 18 Oct 2026 02:08:00–05 GMT**. Subsequent discovery checks finished around 02:09 UTC. These dates were observed from tools, not inferred from the prompt/system date. GitHub snapshot: [prevalentWare API](https://api.github.com/repos/prevalentWare/opencode-goal-plugin), [loopd API](https://api.github.com/repos/bojackduy/opencode-loopd); clock corroboration: [npm registry](https://registry.npmjs.org/@bojackduy%2fopencode-loopd).

| Public metric | prevalentWare/opencode-goal-plugin | bojackduy/opencode-loopd | Sources / interpretation |
|---|---:|---:|---|
| Stars | 488 | 2 | [Goal repo](https://github.com/prevalentWare/opencode-goal-plugin), [loopd repo](https://github.com/bojackduy/opencode-loopd); interest/bookmarks, not users |
| Forks | 38 | 0 | Same repository sources; not installations |
| Watchers / subscribers | 1 | 0 | GraphQL `watchers.totalCount`, not REST's misleading stars-like `watchers_count`; [goal subscribers](https://api.github.com/repos/prevalentWare/opencode-goal-plugin/subscribers), [loopd subscribers](https://api.github.com/repos/bojackduy/opencode-loopd/subscribers) |
| GitHub-listed contributors | 13 | 1 | [Goal contributors API](https://api.github.com/repos/prevalentWare/opencode-goal-plugin/contributors?per_page=100), [loopd contributors API](https://api.github.com/repos/bojackduy/opencode-loopd/contributors?per_page=100); all returned accounts type `User` |
| Repository created (UTC) | 2026-05-05 18:38:38 | 2026-08-21 21:14:53 | [Goal metadata](https://api.github.com/repos/prevalentWare/opencode-goal-plugin), [loopd metadata](https://api.github.com/repos/bojackduy/opencode-loopd) |
| Issues, excluding PRs | 28: 3 open / 25 closed | 1: 0 open / 1 closed | GraphQL issue connections; [goal issues](https://github.com/prevalentWare/opencode-goal-plugin/issues?q=is%3Aissue), [loopd issues](https://github.com/bojackduy/opencode-loopd/issues?q=is%3Aissue) |
| Pull requests, all states | 50 | 0 | [Goal PRs](https://github.com/prevalentWare/opencode-goal-plugin/pulls?q=is%3Apr), [loopd PRs](https://github.com/bojackduy/opencode-loopd/pulls?q=is%3Apr) |
| GitHub releases | 55 | 41 | [Goal releases API](https://api.github.com/repos/prevalentWare/opencode-goal-plugin/releases?per_page=100), [loopd releases API](https://api.github.com/repos/bojackduy/opencode-loopd/releases?per_page=100) |
| Earliest extant GitHub release publication | v0.1.10, 2026-05-08 11:43:52 UTC | v1.0.1, 2026-08-21 21:49:57 UTC | [Goal release](https://github.com/prevalentWare/opencode-goal-plugin/releases/tag/v0.1.10), [loopd release](https://github.com/bojackduy/opencode-loopd/releases/tag/v1.0.1); earliest extant release is not necessarily initial distribution |
| Latest GitHub release publication | v0.1.64, 2026-10-16 06:25:09 UTC | v1.14.2, 2026-10-16 08:41:32 UTC | [Goal release](https://github.com/prevalentWare/opencode-goal-plugin/releases/tag/v0.1.64), [loopd release](https://github.com/bojackduy/opencode-loopd/releases/tag/v1.14.2) |
| Exact npm package name, read from GitHub manifest | `@prevalentware/opencode-goal-plugin` | `@bojackduy/opencode-loopd` | [Goal pinned manifest](https://github.com/prevalentWare/opencode-goal-plugin/blob/9c52be63da06829d55e3e0b7a6580223312765b1/package.json), [loopd pinned manifest](https://github.com/bojackduy/opencode-loopd/blob/8ed75b12376150ad08b6ed1891c7331bc0158008/package.json) |
| npm downloads, last-week endpoint | 2,529 | 639 | Exact returned interval **2026-10-10 through 2026-10-16**, inclusive; [goal API](https://api.npmjs.org/downloads/point/last-week/@prevalentware/opencode-goal-plugin), [loopd API](https://api.npmjs.org/downloads/point/last-week/@bojackduy/opencode-loopd) |
| npm downloads, last-month endpoint | 16,240 | 2,970 | Exact returned interval **2026-09-17 through 2026-10-16**, inclusive, 30 days; [goal API](https://api.npmjs.org/downloads/point/last-month/@prevalentware/opencode-goal-plugin), [loopd API](https://api.npmjs.org/downloads/point/last-month/@bojackduy/opencode-loopd) |
| npm package created (UTC) | 2026-05-05 18:56:26.094 | 2026-08-21 21:28:35.561 | [Goal registry](https://registry.npmjs.org/@prevalentware%2fopencode-goal-plugin), [loopd registry](https://registry.npmjs.org/@bojackduy%2fopencode-loopd) |
| npm package age at observation, completed days | 165 | 57 | Calculated from registry `time.created` to tool-observed 2026-10-18 ~02:08 UTC; registry sources above |
| npm versions currently enumerated | 65 | 42 | Registry `versions` keys; these are not GitHub release counts; registry sources above |
| npm latest dist-tag | 0.1.64 | 1.14.2 | Registry sources above |

- Default branch commit snapshots were **`9c52be63da06829d55e3e0b7a6580223312765b1`** (`main`) for prevalentWare and **`8ed75b12376150ad08b6ed1891c7331bc0158008`** (`master`) for loopd. The prevalentWare repository manifest says version `0.1.1` at that SHA despite npm latest `0.1.64`; registry metadata, not manifest version, was used for published-version metrics. — [Goal manifest](https://github.com/prevalentWare/opencode-goal-plugin/blob/9c52be63da06829d55e3e0b7a6580223312765b1/package.json); [loopd manifest](https://github.com/bojackduy/opencode-loopd/blob/8ed75b12376150ad08b6ed1891c7331bc0158008/package.json); [goal registry](https://registry.npmjs.org/@prevalentware%2fopencode-goal-plugin).
- Returned contributor identities for prevalentWare: danyel117, jackjinke, bndnsmth, ErcinDedeoglu, baldassarreFe, GoldJohnKing, LimFang, Manaf941, ming-14, sr4dev, spencer2211, tienbac2314, fengjikui. Loopd: bojackduy. Contributor counts describe GitHub attribution, not independent customers. — [Goal contributors](https://api.github.com/repos/prevalentWare/opencode-goal-plugin/contributors?per_page=100); [loopd contributors](https://api.github.com/repos/bojackduy/opencode-loopd/contributors?per_page=100).

### Inferences
- Calculated from the table: prevalentWare has **244× stars**, **3.96× weekly downloads**, and **5.47× 30-day downloads**. The enormous star ratio is not the download ratio, much less a user ratio.
- PrevalentWare's npm package predates loopd's by approximately **108 days**. Longer exposure is a confounder in accumulated metrics. Even the shared recent download window does not remove release frequency, repeated installs, dependency/automation, or caching differences.
- More issues and contributors are consistent with broader public participation, but can also reflect maintenance practices, friction, and reporting behavior; they do not establish product quality or adoption causality.

### Gaps
- No public unique-installation, active-user, retention, paid-customer, or referral-attribution data was obtained. Downloads can include CI, reinstalls, upgrades, mirrors, or automated retrieval; stars can come from non-users. No numerical user estimate is warranted.
- Repository metrics are live observations, not immutable historical measurements. SHAs pin the manifests/source pages, not the live star/download totals. npm rolling endpoint results will change; their exact returned intervals and values are recorded above.
- Contributor API counts are GitHub's returned attributed contributors, not a forensic count of all human authors or users. Private adoption and direct GitHub/local installs are outside this measurement.

## 2. What concrete public discoverability and distribution evidence exists?

### Takeaway
Both projects have public distribution channels and mentions in the same upstream OpenCode feature thread. PrevalentWare additionally has explicit third-party usage reports and an independently maintained Nix package pointing to its exact scoped npm tarball. **The official OpenCode ecosystem entry is a different same-named plugin and must not be credited to prevalentWare.**

### Cited Findings

**Dated chronology and attributable evidence:**

| Date (UTC) | Evidence | What it establishes |
|---|---|---|
| 2026-05-05 | PrevalentWare npm package created and first version published at 18:56:26 UTC. — [Registry](https://registry.npmjs.org/@prevalentware%2fopencode-goal-plugin) | Earlier public npm availability, not proof of promotion success |
| 2026-07-05 18:41:36 | `puzanov` links prevalentWare and another goal plugin and asks which is better in the native-goal feature discussion. — [Upstream comment](https://github.com/anomalyco/opencode/issues/27167#issuecomment-4887177062) | Third-party upstream discovery/comparison link |
| 2026-07-16 13:08:08 | `faetschi`: “I've been using this goal plugin in the meantime, semi-successfully, but better than no goal feature,” explicitly linking prevalentWare. — [Upstream comment](https://github.com/anomalyco/opencode/issues/27167#issuecomment-4992224603) | Self-reported use of the exact project; not verified usage telemetry |
| 2026-08-21 | Loopd npm package created at 21:28:35 UTC. — [Registry](https://registry.npmjs.org/@bojackduy%2fopencode-loopd) | Later initial npm availability |
| 2026-08-23 07:36:45 | `bojackduy` posts an introduction with exact npm and GitHub links in that same upstream thread, invites feedback, and positions it as a plugin experiment. — [Author comment](https://github.com/anomalyco/opencode/issues/27167#issuecomment-5384870025) | Concrete owner-authored public promotion; no reach/conversion measurement |
| 2026-08-31 02:55:49 | `charleneleong-ai` links loopd in a comparison with their own plugin proposal. — [Third-party comment](https://github.com/anomalyco/opencode/issues/27167#issuecomment-5473120557) | Independent public mention; the author's maturity/quality claims are opinions, not verified facts |
| 2026-09-14 00:52:30 | `ahmedtohamy1` reports a load error explicitly naming `@bojackduy/opencode-loopd@1.9.5`. — [Loopd issue #1](https://github.com/bojackduy/opencode-loopd/issues/1) | Concrete third-party installation attempt; not evidence of successful/retained usage |
| 2026-09-17 02:57:48 | `william-ricchiuti` reports that the official ecosystem page links their old username `willytop8`, explains the account rename, and identifies their own repository. — [OpenCode issue #49456](https://github.com/anomalyco/opencode/issues/49456) | Confirms a naming/attribution trap, not an official listing for prevalentWare |
| 2026-10-10 17:03:42 | `Foxlith` reports testing exact package `@prevalentware/opencode-goal-plugin` v0.1.60 on Windows with OpenCode v1.18.35. — [PrevalentWare issue #72](https://github.com/prevalentWare/opencode-goal-plugin/issues/72) | Specific third-party package/version/platform usage report |
| 2026-10-17 22:47:31 | `zerocodefast` invites prevalentWare to submit to `hashgraph-online/awesome-ai-plugins`; body includes an outreach marker and suggested PR entry. — [Issue #80](https://github.com/prevalentWare/opencode-goal-plugin/issues/80) | Curator/outreach invitation, **not proof of accepted inclusion** or an organic user endorsement |
| 2026-10-18 01:54:47 | `SimSonic`: “I'm still using” prevalentWare, compatible with v2 but “broken sometimes. Tolerably.” — [Upstream comment](https://github.com/anomalyco/opencode/issues/27167#issuecomment-6244461781) | Recent self-reported continued use; mixed sentiment, not a blanket endorsement |

**Pinned public surfaces checked at observation:**

- Official OpenCode ecosystem source at **`c38d83c0c4f92466ff9c8e12b8a741698e811012`**, line 56, links `opencode-goal-plugin` to **`https://github.com/willytop8/OpenCode-goal-plugin`**, not prevalentWare. The rename explanation above identifies `william-ricchiuti/OpenCode-goal-plugin` as the intended project. Exact `opencode-loopd` code search scoped to `anomalyco/opencode` returned no matches. — [Pinned ecosystem page](https://github.com/anomalyco/opencode/blob/c38d83c0c4f92466ff9c8e12b8a741698e811012/packages/web/src/content/docs/ecosystem.mdx#L56); [identity explanation](https://github.com/anomalyco/opencode/issues/49456).
- `ChrisLAS/hyprvibe` maintains Nix packaging whose metadata homepage explicitly names prevalentWare. Its source JSON pins **`https://registry.npmjs.org/@prevalentware/opencode-goal-plugin/-/opencode-goal-plugin-0.1.53.tgz`**. This is a concrete external packaging/distribution reference tied to the exact npm identity. Snapshot **`97595884d589b7049defc935a0c884b016705898`**. — [Nix package](https://github.com/ChrisLAS/hyprvibe/blob/97595884d589b7049defc935a0c884b016705898/pkgs/opencode-goal-plugin.nix); [pinned source JSON](https://github.com/ChrisLAS/hyprvibe/blob/97595884d589b7049defc935a0c884b016705898/pkgs/opencode-goal-plugin-source.json).
- Loopd has a publicly reachable owner-controlled landing page with GitHub/npm links, install commands, screenshots, and related-project links. Existence was verified via live web fetch; its manifest also names this homepage. This establishes a distribution surface, not search ranking or visits. — [Live landing page](https://bojackduy.github.io/opencode-loopd/); [pinned manifest homepage](https://github.com/bojackduy/opencode-loopd/blob/8ed75b12376150ad08b6ed1891c7331bc0158008/package.json).
- GitHub code search found references in loopd owner's portfolio repository; history of `src/configs/websites.ts` has a `feat: create personal portfolio` commit dated **2026-09-21T03:19:36Z**. This date is portfolio file history, not established first promotion date for the plugin. — [Portfolio source snapshot](https://github.com/bojackduy/bojackduy.github.io/blob/69433dd93ef018e46d69f96606cfe8657ff714fb/src/configs/websites.ts); [history commit](https://github.com/bojackduy/bojackduy.github.io/commit/1dac82d523fe8d30306b58c907bffd23481da23f).
- Exact target names were not found in the current README snapshots of three curated lists checked: `awesome-opencode/awesome-opencode` **`bcc5c03cec19789b45ef9af4a969e3fe3fd7431b`**, `Heretek-AI/awesome-opencode` **`50003de1ece2420ac783f34492cbd169d2bc3f3d`**, and `hashgraph-online/awesome-ai-plugins` **`76910b950e2448a38f8b1749f4a89f8f0edf44ad`**. Additional scoped GitHub code searches for prevalentWare in the first two and loopd in Heretek returned empty results. These are bounded negative checks, not proof of absence from every list/file. — [Awesome OpenCode README](https://github.com/awesome-opencode/awesome-opencode/blob/bcc5c03cec19789b45ef9af4a969e3fe3fd7431b/README.md); [Heretek README](https://github.com/Heretek-AI/awesome-opencode/blob/50003de1ece2420ac783f34492cbd169d2bc3f3d/README.md); [AI Plugins README](https://github.com/hashgraph-online/awesome-ai-plugins/blob/76910b950e2448a38f8b1749f4a89f8f0edf44ad/README.md).
- Several broad search hits were **not counted as adoption**: an `opencode-loopd` executable in `ByBrawe/opencode-loop` belongs to that other project's script; bare unscoped `opencode-goal-plugin` config strings cannot establish the prevalentWare package identity; a commented-out config is not active use. — [Other project's executable](https://github.com/ByBrawe/opencode-loop/blob/d0091c923cbb033505bf16594683923f2e85a60a/package.json); [ambiguous config](https://github.com/AniviaFlome/nix-config/blob/0d3c6d57e2e1259efccc7a181b31779502896d44/hm-modules/programs/opencode.nix); [commented config](https://github.com/savonarola/homedir/blob/da4a4fae509011b69aac40f3b7fd668c973275c9/opencode.jsonc).

### Inferences
- The verified difference is a larger observed participation footprint for prevalentWare, plus earlier public existence and concrete independent packaging. No source establishes that packaging, promotion, timing, SEO, or a particular mention caused the metric gap.
- Both have upstream-thread visibility. It would be inaccurate to say loopd has no promotion or no outside interest; its author introduction, third-party comparison, and issue report directly contradict that claim.
- Same-name projects make raw search-hit counts unreliable. Identity was confirmed via scoped npm names, exact repository links, and pinned source references before attributing evidence.

### Gaps
- This was a bounded GitHub/npm/live-page investigation, not an exhaustive crawl of blogs, Reddit, X, Discord, or all discussion boards. No verified independent blog campaign, referral analytics, audience size, or marketing-conversion chronology was obtained.
- A search result is a lead, not a verified endorsement. No claim is made that the outreach invitation became a merged curated-list entry. No search-result totals are used as user counts.
- GitHub code search can omit forks, unindexed files, and other public material. Negative README/search checks cannot establish global absence. No API rate-limit error blocked the reported successful queries; availability does not imply search completeness.

## 3. Is loopd 1.14.2 publicly available now, and how confident are these conclusions?

### Takeaway
**Yes. Loopd 1.14.2 is publicly available from npm at this observation.** Both its version metadata and tarball endpoint returned HTTP 200. The earlier reported 404 after 25 minutes is historical user-provided context; this investigation cannot reconstruct its precise propagation window or cause.

### Cited Findings
- Public registry package metadata returned HTTP **200**, HTTP `Date` **2026-10-18 02:08:03 GMT**, and `dist-tags.latest = "1.14.2"`. It records `time["1.14.2"] = "2026-10-16T09:36:49.850Z"` and package modified `2026-10-16T09:36:50.195Z`. — [Package registry](https://registry.npmjs.org/@bojackduy%2fopencode-loopd).
- Exact public version endpoint returned HTTP **200**, HTTP `Date` **2026-10-18 02:08:05 GMT**. Version was `1.14.2`; `gitHead` was **`8ed75b12376150ad08b6ed1891c7331bc0158008`**, matching the observed default-branch SHA. — [Version endpoint](https://registry.npmjs.org/@bojackduy%2fopencode-loopd/1.14.2); [GitHub snapshot](https://github.com/bojackduy/opencode-loopd/commit/8ed75b12376150ad08b6ed1891c7331bc0158008).
- Public tarball **HEAD** request returned HTTP **200**, HTTP `Date` **Sun, 18 Oct 2026 02:08:52 GMT**. No install, execution, or tarball extraction was performed. — [Tarball](https://registry.npmjs.org/@bojackduy/opencode-loopd/-/opencode-loopd-1.14.2.tgz).
- GitHub release publication was **2026-10-16T08:41:32Z**, about **55 minutes 18 seconds before npm's recorded version publication**. These are distinct public timestamps, not proof of when an npm publish acknowledgment was received. — [GitHub release](https://github.com/bojackduy/opencode-loopd/releases/tag/v1.14.2); [npm registry](https://registry.npmjs.org/@bojackduy%2fopencode-loopd).

### Inferences
- **High confidence:** observed metrics, exact package identities, current npm metadata/tarball availability, and attribution of the official ecosystem entry to a different project; these come from primary-source APIs or pinned source pages.
- **Moderate confidence:** prevalentWare has broader observable public participation/distribution, supported by multiple independent proxy types. This is a descriptive conclusion about the examined public footprint, not quantified users.
- **Insufficient evidence:** unique/active-user superiority, product-quality superiority, and causal explanations for the gap. No marketing cause is assigned.

### Gaps
- The October 16 publish acknowledgment and earlier 404 were supplied in the assignment and were not independently recorded here. The current successful request cannot establish the first instant every registry edge became available or explain any earlier failure.
- Tarball HEAD verifies endpoint availability only; package contents, installation behavior, architecture, and onboarding were deliberately outside this research scope.
