# alpha.20 program charter (Lead-owned)

This file records what the alpha.20 round must deliver, the contracts it may not break, and how "done" is
judged. It is a working document; evidence lives in `docs/alpha20/audit/`, `oracle/`, `perf/`, `findings/`,
`same-sha-evidence.md` and `release-evidence.md`.

## Baseline and constraints (non-negotiable)

- Published baseline: `v0.1.0-alpha.19` (annotated tag on `bbc5615`); `main` starts this round at `7d1178e`.
- Pinned oracle: SillyTavern `1.19.0` at `06bde939fb1e9c4c8d8641d810f0a916b5bce127`, READ-ONLY. No modification
  of pinned code or `upstream/**` frontend; no baseline bump without an explicit recorded decision.
- No invented product behaviour: no new backup files, no second persistence DB/format, no user-directory
  changes, no automatic JSON/JSONL/PNG rewrites, no extension auto-updates, no silent config semantic changes,
  no auto-opened desktop browser, no default telemetry, no fake HTTP success for missing features, no
  behaviour changes made for benchmark numbers, no unprevented removal of historical tests/capabilities.
  Existing approved exclusions keep their exact boundaries and wording.
- Root-cause fixes only. No adapter/wrapper frameworks, no duplicated test systems, no parallel old+new
  implementations, no CI dependencies without a stated reason, no new fallbacks that hide errors.
- Upstream is the oracle: every compatibility claim must come from pinned source reading and/or a real pinned
  probe, never from memory or derivation dressed as an oracle.

## Required work (M0-M12 of the user's prompt)

- **M0 source audit**: read the real production code (cmd/, internal/**, tests/e2e, tests/oracle, tools/perf,
  scripts, installers, Dockerfile). Trace input -> config -> auth -> handler -> filesystem -> provider ->
  response -> browser. Evidence-backed findings only in `docs/alpha20/audit/` with ID/Severity/Source/Root
  cause/Reproducer/Node Oracle/GoTavern/User impact/Fix/RED-GREEN/Regression guard. No unverified suspicions
  written as confirmed bugs.
- **M1 disclosed gaps re-decided**: `chat_metadata.integrity`+`force`; group-chat save/backup semantics;
  Brotli negotiation (implement only if cost-effective, else keep the exact disclosed difference);
  pinned `_cache/characters` disk cache; and the alpha.19 26 normalisations / 6 notCompared / dominantColor
  ±1 7-of-24 exclusion / platform limits / unrun lifecycle phases. Eliminate what can be eliminated; keep
  evidence and wording for what cannot. Never widen the comparator to look better.
- **M2 multi-tier UI-originated corpora**: small, medium (>=64 cards, >=12 books, >=200 entries, >=20 complex
  presets, >=100 chats, >=3000 messages, >=8 groups, personas/regex/quick replies/STscript/Tavern Helper that
  really changes variables/prompts/preset/metadata/generation/provider request), large/extreme targets as
  time allows. Created through the unmodified pinned UI; product-native save and generated stress data are
  separate, labelled layers. Deterministic replay, seeds recorded, achieved counts recorded when a target is
  unreachable. No meaningless duplicate filler.
- **M3 oracle strengthening**: keep the existing five-layer framework (do not build a second oracle); add real
  complex scenarios, adversarial mutations (each shown RED then GREEN), failure injection (mid-stream close,
  truncation, timeouts, read-only/disk-full, rename failure, concurrent writers, external modification,
  partial corruption, invalid config, restart with active requests, Windows locks, corrupt cache, expired
  session) with data-safety/no-false-success/recoverability/resource-release checks; all egress controlled.
- **M4 performance**: profile-first; production-code fixes; >=30% on one representative hotspot and >=15% on
  two more (or NOT SEPARABLE), lower 10k-card B/op and allocs, lower cold peak RSS, better tail latency, no
  binary-size blow-up, no semantic regression, no "keep everything in memory" tricks.
- **M5 fair measurement**: same host/data/config/concurrency/limits, environment recorded, cold vs warm,
  ABBA with A/A self-test, 100/1000/10000 cards, long chats, large world books, complex presets, static
  assets, 1/8/16/32 users, p50/p95/p99/throughput/errors/CPU/RSS/B-per-op/allocs/goroutines/FDs; 60-minute
  mixed-load soak on the final candidate, stating that no growth in 60 minutes is not a leak proof.
- **M6 simplification**: only where a measured cost and a smaller-code fix are both proven, and the full
  oracle still passes. Prefer deleting duplicated work/state over new abstractions.
- **M7 README + figures**: README first-screen text reduced by >=40% vs alpha.19, product-homepage shape,
  one excellent performance figure, honest axes/units, dark+light hand-authored SVG generated from validated
  artifacts with syntax/render/narrow-viewport/overflow/value/contrast checks; methodology moves to docs/.
  Keep the first screen free of CI/SHA/gate jargon. Update stale "current version" wording without rewriting
  history.
- **M8 CLI/installer/release UX**: verify first-run, config/data discovery, port conflicts, missing assets,
  permissions, invalid config, logs, graceful exit, `gotavern version`, TTY/non-TTY, reverse proxy; install.sh,
  install.ps1, launchers, Docker, manual unpack, in-place install, specific-version install, latest-stable
  install, reinstall, upgrade from alpha.19, rollback; prove existing user data is never overwritten.
- **M9 docs/alpha20 structure + fail-closed rails**: keep all 14 existing gates (no weakened filters, no
  skipped jobs, no renamed tests, no removed assertions); add a gate only with the five justifications.
  The verifier must refuse wrong SHA, spliced SHAs, missing gates/jobs/artifacts, wrong selection, stale
  artifacts, wrong digests, unexecuted tests, mismatched perf reports, broad normalisations, undisclosed
  notCompared and incomplete notes, with self-tests.
- **M10 iteration**: at least two full audit->fix->oracle->perf cycles before freeze.
- **M11 freeze**: one candidate SHA; update version metadata, classifier+test (`alpha.20` stable; `alpha.200`,
  `alpha.20-rc1`, `alpha.20+build.1` not), release notes, GOAL §16.2, HANDOFF, scorecard, manifest; run the
  full same-SHA wave; no splicing runs from other SHAs; publish only on verifier PASS.
- **M12 post-publish verification**: re-download all six archives, verify checksums and asset digests, unpack
  and run `gotavern version`, boot `/version`, `/`, character list, chat save/reload/restart, Node hand-back,
  installer latest-stable, Docker version+latest digests, historical tags unchanged; commit post-release
  evidence clearly separated from the frozen candidate.

## Honesty rules

Use exactly these states and never inflate them: CONFIRMED, FIXED, MATCH, DIFFERENT, PARTIAL, EXCLUDED,
NOT COMPARED, NOT EXECUTED, NOT SEPARABLE, UNPROVEN, BLOCKED. A window without observed growth is not a leak
proof; an agent-authored corpus is not a real user's private directory (`GOAL.md` §14 stays NOT MET and
`PRIVATE_NOT_RUN`); Linux success does not prove Windows/arm64; local green is Layer A, not a CI verdict;
committed-but-unpushed is not remote; a green workflow does not prove every required job executed.

## Work split and file ownership

- Lead: architecture/decisions, shared-tree and worktree coordination, review, integration, git/CI, releases.
- Subagent A (`source-audit`, worktree `a20-A`, branch `a20/audit`): production source audit; RE tests and
  minimal fixes proposed to Lead for cherry-pick.
- Subagent B (`oracle-corpus`, worktree `a20-B`, branch `a20/oracle`): pinned probes, multi-tier corpora,
  five-layer oracle strengthening, teeth and fault injection.
- Subagent C (`perf-release`, worktree `a20-C`, branch `a20/perf`): profiling, ABBA, soak, README/SVG,
  CLI/installer/Docker verification; product patches only after Lead approval.

Every logical unit is committed and pushed; `main` stays buildable; no force-push; no published tag moves; no
skipped hooks; no secrets/private data/full user corpora in the repo.
