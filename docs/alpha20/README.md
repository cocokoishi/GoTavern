# alpha.20 program index (LIVE)

`CHARTER.md` is the frozen program contract for this round (requirements, constraints, acceptance rules).
This file is the live index; it changes as evidence lands and never rewrites the charter.

## Current stage

| field | value |
|---|---|
| stage | **candidate frozen: full 14-gate same-SHA wave dispatched; soak + publication follow** |
| baseline | `v0.1.0-alpha.19` published; pinned SillyTavern `1.19.0` @ `06bde939…` unchanged |
| candidate | see [`same-sha-evidence.md`](same-sha-evidence.md) (filled from the wave) |
| subagents | `source-audit` (A), `oracle-corpus` (B), `perf-release` (C) — exactly three, long-lived |
| gates | same **14 required gates**; none added, removed, renamed, skipped or weakened |

## Evidence index

| area | path | state |
|---|---|---|
| charter / constraints | [`CHARTER.md`](CHARTER.md) | frozen |
| decisions | [`decision-log.md`](decision-log.md) | D-01 … D-10 |
| audit ledger + findings | [`audit/index.md`](audit/index.md), `audit/A20-*.md` | **9 findings fixed** (A20-A…I), 2 High / 3 Medium / 4 Low, each RED→GREEN + mutation |
| audit boundaries / cleared areas | [`audit/notes-inherited-and-boundaries.md`](audit/notes-inherited-and-boundaries.md) | world-info ordering is frontend-only; extension install/update at parity; access-log growth inherited |
| oracle: pinned probes | [`oracle/chat-integrity/`](oracle/), `group-save-backup/`, `encoding/`, `character-cache/` | pinned behaviour captured; Go-vs-pinned differential artifact committed |
| oracle: multi-tier corpus | [`oracle/corpus-medium-manifest.json`](oracle/corpus-medium-manifest.json), `corpus-medium-report.json`, `corpus-tiers.md` | **medium tier reached** (64 cards / 12 books / 229 created entries / 20 presets / 163 chats / 3,000 messages / 8 groups) with separate provenance counters |
| oracle: fault injection | [`oracle/fault-injection.md`](oracle/fault-injection.md) | **8 scenarios executed**; provider-wire faults and disk-full NOT EXECUTED with reasons |
| oracle: differential teeth | `docs/alpha20/oracle/` teeth driver | mutations **NOT EXECUTED** (baseline carried a harness-error row; script committed, no claim) |
| performance | [`perf/`](perf/), [`../performance.md`](../performance.md) | marshal rewrite: world −47.8% B/op, chat −52.6%; chat-get p50 −23.5% ABBA; 60-min soak pending the frozen candidate |
| release UX | [`perf/installer-and-cli-verification.md`](perf/installer-and-cli-verification.md) | installer 13/13, CLI 10/10 on the shipped alpha.19 archive; alpha.20 archive rows are post-publication |
| same-SHA evidence | [`same-sha-evidence.md`](same-sha-evidence.md) | filled from the frozen-candidate wave |
| release evidence | [`release-evidence.md`](release-evidence.md) | filled after publication |

## Fixed findings on the candidate

| ID | commit | change |
|---|---|---|
| A20-A | `188b34d` | socket-close interrupt only on a real in-flight disconnect (was firing after every completed SD request) |
| A20-B | `134500d` | `sanitize-filename` two-pass replacement parity (BYAF-imported filenames) |
| A20-C | `60ed139` | provider transport follows node-fetch's 20 redirects, not 19 |
| A20-D | `fb24983` | pinned `chat_metadata.integrity` enforced on save (stale-overwrite refusal) |
| A20-E | `fb24983` | group-save schedules the pinned auto-backup |
| A20-F | `138d177` | card base64 decoder reads what pinned's lenient `Buffer.from` reads |
| A20-G | `4d9f2c6` | character avatar edit/replace/delete invalidates the cached thumbnail |
| A20-H | `f606e94` | `/version` answers the pinned 304 face (last browser-requested GET without it) |
| A20-I | `17db9ac` | chat-backup download uses pinned `send()` ETag/Last-Modified/Range contract |

## Honest gaps carried into the release record

- Comparator mutation teeth for the alpha.20 differential: NOT EXECUTED (the committed artifact carries a
  HARNESS-ERROR scheduler row, so the teeth driver refuses the baseline; the driver is committed).
- Five-layer live-oracle rerun on the medium corpus: NOT EXECUTED this round (the CI real-UI gate still runs
  its own five-layer corpus per run).
- Provider-wire fault injection and disk-full: NOT EXECUTED with reasons.
- `GOAL.md` §14 stays **NOT MET** / `PRIVATE_NOT_RUN`; darwin/arm64 and windows/arm64 remain recorded
  platform limitations; `-race` is Linux-only.
