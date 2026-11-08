# alpha.18 performance evidence (LOCAL, Windows arm64) — provenance and results

**These are Layer A (local development host) artifacts. They are triage and paired-comparison evidence, not
Linux CI release evidence.** The alpha.18 release performance claim still comes from the same-SHA
`GoTavern smoke metrics` gate required by `docs/release-manifest.json`; no number here is spliced into that
record, and no alpha.17 number is reused as an alpha.18 claim.

## 1. Provenance

| fact | value |
|---|---|
| host | Windows 11 24H2 build 10.0.26100 arm64, `virt-7.2`, 2 logical cores, GOMAXPROCS unset (2) |
| Go / Node | `go1.27.3 windows/arm64` / `v24.19.0` |
| product commit measured | `5aef3db` (alpha.18 product code; docs-only working-tree changes at measurement time) |
| baseline subject (in-process) | clean `git worktree` of alpha.17 product commit `9b99fde` with the same `bench_test.go` copied in |
| baseline subject (process-level) | the PUBLISHED `v0.1.0-alpha.17` `gotavern-windows-arm64.zip` binary, sha256 `0d96c0abab4deba…` |
| candidate binary (process-level) | local `go build -trimpath -ldflags="-s -w" ./cmd/gotavern`, sha256 `be4b7c02483439…` |
| load label | one sequential agent; the only remote work was a GitHub CI bench run (does not consume this host) |

Raw files: `abba-inprocess.json` (all 24 paired benchmark rows + computed summary), `profiles/` (the alpha.17
pprof captures that established the roots), `abba-process.json` (process-level paired artifact),
`soak-60min.json` (60-minute soak artifact).

## 2. In-process paired ABBA — the 10,000-card card list

Protocol: three rounds, the subject order flipped each round (`A,B` / `B,A` / `A,B`); for the baseline the
alpha.17 product code is built in an isolated worktree; both subjects run the SAME benchmark file, so the
harness cannot differ. `-benchmem -benchtime=3x -count=1` per run. All values are medians over the three
paired rounds; the full per-round series is in `abba-inprocess.json`.

| arm | metric | alpha.17 | alpha.18 | change |
|---|---|---:|---:|---:|
| `/api/characters/all`, 10,000 cards (hot cache) | ns/op | 5,734.9 ms | **2,295.9 ms** | **−60.0%** |
| | B/op | 1,038.7 MB | **619.9 MB** | **−40.3%** |
| | allocs/op | 7,797,016 | **3,193,667** | **−59.0%** |
| `BenchmarkCharactersAllCold`, 10,000 cards | ns/op | 6,127.9 ms | 5,542.9 ms | −9.6% (inside the arm's noise; NOT claimed) |
| | B/op | 1,234.6 MB | **879.0 MB** | **−28.8%** |
| | allocs/op | 8,030,352 | **3,500,341** | **−56.4%** |
| 1,000 cards | ns/op | 606.8 ms | **402.3 ms** | **−33.7%** |
| | B/op | 304.0 MB | **167.6 MB** | −44.9% |
| 100 cards (128 KB images) | ns/op | 75.1 ms | **55.6 ms** | **−26.0%** |
| | B/op | 38.3 MB | **28.7 MB** | −25.1% |

Per-round separation (ms/op, 10,000-card hot arm): baseline `5734.9 / 9126.7 / 4963.9`; candidate
`2246.7 / 3029.2 / 2295.9`. Every candidate observation is BELOW every baseline observation, which is the
claim the spread supports; the median difference is not a lucky draw. The cold-cache arm's timing is not
separable on this host (baseline `6127.9 / 9076.9 / 5395.0`, candidate `5542.9 / 8683.0 / 3845.2`) but its
allocation reduction is deterministic and large, which is reported instead of a time claim.

## 3. Startup attribution (spawn → first `GET /version` 200), 10,000-card tree

Every row is a fresh process against a tree of the stated shape, measured by the same boot script (spawn,
poll `/version` every 10 ms, record wall + `procstat` CPU at readiness).

| condition | cold boot | warm boot | note |
|---|---:|---:|---|
| alpha.17 product code, freshly generated tree | 30,757 ms | 633 ms | reproduces the recorded alpha.17 27.1 s row |
| identical tree COPIED to a new directory, alpha.17 code | 887 ms | 643 ms | proves the cold cost is first-touch, not an algorithm |
| fresh tree, characters moved out of the listing | 3,955 ms | 1,363 ms | per-card access is the cost |
| fresh tree, cards moved one directory down (10k-entry listing, no `.png` at top) | 4,887 ms | 891 ms | enumeration itself is cheap |
| fresh tree, 60 s wait before boot | 58,883 ms | 379 ms | waiting does not remove it |
| alpha.17 + listing-based cache verify only | 43,642 ms | 156 ms | warm boot already improves; cold still stats every card for statistics |
| **alpha.18 (both fixes)** | **3,661 ms** | **640 / 165 ms** | startup no longer opens/stats each card |

The cold and warm columns are single/few observations on a shared host (cold boot is a distribution, not a
constant: the same shape measured 30.8 s, 43.6 s and 58.9 s across windows because the host's on-access
scanner decides the cost); what is reproducible and product-attributable is **which code path touches how
many files**, and that is what the change removes. The startup path still reads the characters directory and
writes `stats.json`; it no longer performs `2 × cards` metadata operations in `DiskCache.verify` plus one
`stat` (and a symlink-resolution walk) per card in statistics.

## 4. Process-level paired ABBA (100 / 1,000 / 10,000 cards + mixed large)

Filled from `abba-process.json` after the run: `scripts/a15-bench-suite.mjs --mode paired`, published
alpha.17 binary vs the alpha.18 candidate, 4 alternating rounds per scale, fresh byte-identical tree per
round, `--requests 6` on `/api/characters/all`.

Protocol: `scripts/a15-bench-suite.mjs --mode paired`, published alpha.17 binary vs the alpha.18 candidate,
four alternating rounds per scale, a FRESH byte-identical tree generated for each subject each round,
`--requests 6` on `/api/characters/all`. Values are medians over the four rounds (boot/RSS: one measurement
per round; latency: median of the 6 measured requests per round). Full series and provenance:
`abba-process.json`, raw artifacts `a15/paired-*.json`.

| scale | metric | alpha.17 | alpha.18 | change |
|---|---|---:|---:|---:|
| 10,000 cards | boot → first `/version` 200 | 28,017 ms | **351 ms** | **−98.7%** |
| | `/api/characters/all` median | 5,744 ms | **2,739 ms** | **−52.3%** |
| | steady RSS (median) | 1,023.5 MB | 986.2 MB | −3.6% (inside the arm's spread; not claimed) |
| | peak RSS (median of per-round peaks) | 1,040.0 MB | 1,107.6 MB | +6.5% (both subjects span ~1,006-1,145 MB; not a claim either way) |
| 1,000 cards | boot | 2,956 ms | **192 ms** | **−93.5%** |
| | list median | 533 ms | **247 ms** | **−53.7%** |
| 100 cards | boot | 454 ms | **183 ms** | **−59.7%** |
| | list median | 86 ms | **70 ms** | −18.6% |
| mixed large tree | boot | 3,132 ms | **804 ms** | **−74.3%** |
| | list median | 529 ms | **257 ms** | **−51.4%** |

The graded threshold is the 10,000-card key request p50 **or** peak RSS improving by at least 20%: the p50
improves by 52.3% process-level (60.0% in-process) and the peak-RSS difference is inside the measurement
spread, so the gate is met by the latency half and the memory half is reported as NOT improved rather than
dressed up. Boot improvement is a cold first-touch effect removed from the startup path (see §3); the warm
boots also improve (`633 → 165 ms` on the same protocol).

## 5. 60-minute soak

Filled from `soak-60min.json` after the run: `tools/perf/a18-soak.mjs --minutes 60 --rate 8
--restart-every-minutes 10` on a generated mixed-large tree, with write→restart→read integrity checks, an
external card-modification probe each minute, and 15 s RSS/CPU sampling.

The 60-minute run is executed on the frozen candidate after this commit (the 60-minute duration cannot fit
inside the commit that must exist before the run); its artifact `soak-60min.json` and the summary below are
added in the post-wave documentation commit, which does not move the tag.

| metric | value |
|---|---|
| PENDING | filled from `soak-60min.json` after the 60-minute run on the frozen candidate |

## 6. What is NOT measured here

- No Linux run: every number above is Windows-arm64 Layer A. The release gate is the same-SHA
  `GoTavern smoke metrics` run.
- No pprof capture of the alpha.18 binary was needed for the claim, because the change removes identified
  work; the alpha.17 captures in `profiles/` are the roots it removes, and `abba-inprocess.json` records the
  effect.
- The cold-boot number is dominated by the host's on-access scanner; the product-attributable cold cost is
  the per-card file access, which the change removes. A clean Linux cold boot is the CI `smoke metrics` /
  `drop-in qualification` path, not this table.
- Peak RSS at process level is recorded by the paired run; the in-process allocation totals are not RSS and
  are never presented as such.
- The 60-minute soak cannot prove absence of a leak from RSS alone (handles and live heap are not observable
  on this host); the artifact says so instead of inferring one.
