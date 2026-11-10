# alpha.20 program index (LIVE)

`CHARTER.md` is the frozen program contract for this round (the requirements, constraints and acceptance
rules). This file is the live index; it changes as evidence lands and never rewrites the charter.

## Current stage

| field | value |
|---|---|
| stage | **M0-M1 complete (five fixed findings), M2/M3 corpora+oracle in progress, M4 perf patch approved/in progress** |
| baseline | `v0.1.0-alpha.19` published; `main` moved by alpha.20 fixes (see below) |
| candidate | not frozen yet |
| subagents | `source-audit` (A), `oracle-corpus` (B), `perf-release` (C) — exactly three, long-lived |
| gates | same **14 required gates**; no gate added/removed/weakened |

## Evidence index (live)

| area | path | state |
|---|---|---|
| charter / constraints | [`CHARTER.md`](CHARTER.md) | frozen |
| decisions | [`decision-log.md`](decision-log.md) | D-01 … D-10 recorded |
| audit ledger + findings | [`audit/index.md`](audit/index.md), `audit/A20-*.md` | 5 fixed (A20-A/B/C/D/E) |
| oracle probes / corpora / strength | [`oracle/`](oracle/) | in progress (pinned probes committed; tiers building) |
| performance | [`perf/`](perf/), `docs/performance.md` | profiling done; patch in progress; ABBA/soak pending |
| findings (narrative) | [`findings/`](findings/) | open |
| same-SHA evidence | [`same-sha-evidence.md`](same-sha-evidence.md) | filled at the frozen candidate |
| release evidence | [`release-evidence.md`](release-evidence.md) | filled after publication |

## alpha.20 fixes already on main

| commit | change | record |
|---|---|---|
| `fb24983` | pinned `chat_metadata.integrity` enforced + group-save backup scheduled | A20-D, A20-E |
| `188b34d` | socket-close interrupt only on a real in-flight disconnect | A20-A |
| `134500d` | `sanitize-filename` two-pass replacement parity | A20-B |
| `60ed139` | provider transport follows node-fetch's 20 redirects | A20-C |

## How to verify the pin (any machine)
See `docs/alpha19/README.md` §"How to verify the oracle pin"; the pin is unchanged in alpha.20.
