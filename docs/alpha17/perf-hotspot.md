# alpha.17 hotspot record — hypothesis, RED evidence, and the UNEXECUTED change

**Status: PROFILE/HOTSPOT IDENTIFIED — PRODUCT CHANGE UNEXECUTED.** No product code was changed in this
round. The freeze instruction for this lane was: if a safe, provable change cannot be completed in the
window, record the profile and the hottest allocation site as the named next step and mark the step
UNEXECUTED rather than fabricate a change. That is what this document does. The missing half is
explicitly named below, not implied.

All numbers are **LOCAL (Windows arm64)** from `docs/alpha17/perf/` and are not Linux CI evidence.
Subject: local release-style binary sha256 `7ae492913fd46d0a02d10c51f0237a62ebaac881c81e8945be3f333f7e4fc131`
built with `go build -trimpath -ldflags="-s -w"`, Go 1.27.3 windows/arm64, 2 logical cores, GOMAXPROCS 2.

## 1. Hypothesis

`GET /api/characters/all` over a 10,000-card data root is the highest-ROI, lowest-risk hotspot in the
measured matrix: it is the only row where one route's cost dominates the whole process footprint (CPU,
RSS, peak RSS and latency all move together), and the alpha.15 card-text cache already exists, so the
question is whether its use in the 10k-card list path is costing more than it saves (cache identity
resolution, per-card stat, and the retained text) or whether the cost is the JSON aggregation itself.

Candidate cost sites, read from the tree (not yet profiled):

| site | file:line | why it is a candidate |
|---|---|---|
| strict card read behind the alpha.15 cache | `internal/server/characters_card.go:268` (`readCharacterDataStrict`) with the cache hit at `:271`/`:284` | one `os.Stat`-derived identity + path resolution per card per request; the alpha.16 precedent measured the cold first request **+21.1%** worse at 10k cards because of exactly this (`docs/perf-baseline.md` §10.4) |
| cache lookup/store | `internal/server/characters_card_cache.go:126` (`loadCharacterCardTextCache`), `:149` (`storeCharacterCardTextCache`), `:209` (`characterCardCacheMemoryCost`) | capacity/eviction and cloning policy decide whether 10k card texts are retained (memory) or re-read |
| character list aggregation | `internal/server/characters.go:159` (`readCharactersBody`), `:223` (`readCharactersRequest`) | builds the `orderedNodeJSON` list body for every card on every request — allocation-heavy at 10k |
| uncached fallback | `internal/server/characters_card.go:252` (`readCharacterData`) | cold path when the cache misses |

The existing in-process detectors that would pin a change are `BenchmarkCharactersAllScale`
(`internal/server/bench_test.go:645`, arms `cards_100_128KB_image`, `cards_1000_32KB_image`,
`cards_10000_4KB_image`, `cards_100_640KB_image`) and `BenchmarkCharactersAll` (`:330`).

## 2. RED evidence (measured, LOCAL)

From `docs/alpha17/perf/a15/scale-2026-11-07T13-21-47-605Z.json` (10,000 cards, 10,002 files /
96,640,626 B, data route `/api/characters/all`, one boot, `--requests 3`) versus
`scale-2026-11-07T13-20-32-786Z.json` (1,000 cards) and the 100-card smoke row:

| scale | boot to first `/version` 200 | RSS steady | peak RSS | `/api/characters/all` p50 | p95 | p99 |
|---|---|---|---|---|---|---|
| 100 cards (smoke, median of 6 boots) | 445 ms cold / 137 ms warm | 30.2 MB | 37.4 MB | 68.5 ms | 84.6 ms | 94.0 ms |
| 1,000 cards (1 observation) | 2,966.7 ms | 91.2 MB | 95.7 MB | 511.5 ms | 513.6 ms | 513.6 ms |
| **10,000 cards (1 observation)** | **27,099.2 ms** | **925.2 MB** | **1,024.2 MB** | **5,481.3 ms** | **6,305.0 ms** | **6,305.0 ms** |

The 10k row is 9.1× the 1k row's boot time, 10.1× its RSS, 10.4× peak RSS and 10.7× its route p50 — the
cost scales with card count, not with a constant. This is a real, measured cost signal (RED in the sense
that the current behaviour is the thing a change must improve); it is **one observation on a shared
2-core host** and the boot component is not attributed, so it is a hypothesis with a measured magnitude,
not a root cause.

Honest caveats: (a) n=1 for each scale row — no spread, no threshold (`docs/alpha17/performance-plan.md`
§8.2); (b) the host was shared with other lanes; (c) boot time includes reading/generating page-cache
state for a 96 MB / 10,002-file tree, so it may be dominated by filesystem traversal rather than by the
route handler, which is exactly why it must be profiled before it is changed.

## 3. Root cause — NOT YET ESTABLISHED (profile is the next step)

The measurement localizes the cost to "the 10k-card character list", not to a function. No pprof capture
was made in this window, so no line is claimed as the root cause. The exact next step is recorded in §6 so
the next round does not rediscover it.

## 4. Patch summary — NONE (UNEXECUTED)

- Product files changed: **none**.
- Tests changed: **none**.
- `go build ./...` / `go test ./internal/server -run '...'`: **not run for a product change because there
  is no product change**. The repository builds as it did before this lane; the only additions are
  `docs/alpha17/**` and `tools/perf/fingerprint.mjs`.

## 5. Before/after — NOT PAIRED (UNEXECUTED)

There is no after arm, so no before/after median table exists and none is implied. A valid pair for the
next round is defined by `docs/alpha17/performance-plan.md` §5: same host, same binary build flags, same
sha256 for the baseline arm and the candidate arm's sha256 recorded, fresh byte-identical 10,000-card tree
per round, `--requests`/`--data-route` fixed, ABBA order (baseline, candidate, candidate, baseline) with
≥3 rounds, published medians and the full per-round series, both directions reported.

## 6. Named next steps (in order)

1. **Profile before changing.**
   `go test ./internal/server -run=NONE -bench='BenchmarkCharactersAllScale/cards_10000_4KB_image' -benchmem -count=3 -cpuprofile="$env:TEMP\a17\cpu.out" -memprofile="$env:TEMP\a17\mem.out" -memprofilerate=1` (and the 1,000-card arm), then
   `go tool pprof -top` + `-alloc_space`/`-alloc_objects`. Record the top sites with file:line under
   `docs/alpha17/perf/profiles/`.
2. **Attribute the 27.1 s boot separately** from the route cost: a boot-only measurement over a caller-
   supplied 10,000-card tree (`--data-root`) with no request traffic, plus a `strace`-equivalent file
   count/duration tally, to decide whether startup traverses the card tree and whether that traversal is
   defensive or necessary.
3. **Then, and only then, one minimal change** — the lowest-risk shapes to test first are (a) removing a
   redundant per-card `os.Stat` in the cached path if the profile shows it material, or (b) preallocating
   the list body capacity if the allocation profile shows slice growth. Each must keep response bytes
   unchanged (the card list body is the pinned surface; observable bytes must be identical, and the
   existing character differential fixtures are the compatibility gate) and must be measured with the
   ABBA protocol in §5.
4. **Gate:** `BenchmarkCharactersAllScale` rows in `tests/perf/bench-baseline.txt` (regenerated
   deliberately on the CI runner image via `node scripts/bench-profiles.mjs --update-baseline`, committed
   with its raw run) + the focused existing tests that cover the touched code, e.g.
   `go test ./internal/server -run 'TestCharacter|TestCharacters|BenchmarkCharacters' -count=1`, plus
   `go test ./internal/server -run 'TestCharacterCardCache' -count=1`.
5. **Cold-cache guard** (alpha.16 gap): add `BenchmarkCharactersAllCold` as described in
   `docs/alpha17/performance-plan.md` §10.2, so the cold half of the alpha.15 cache precedent stops being
   prose.

## 7. Compatibility statement

No product change ⇒ observable behaviour is unchanged by construction; the alpha.17 binary under test is
the unmodified tree, and the measured artifacts are of that unmodified binary. When the change is made, the
compatibility statement required by `GOAL.md` §15.1 is: the card-list response body bytes are the pinned
surface (`internal/server/characters.go`) and must remain byte-identical; the existing character
read/differential fixtures must stay green on the same commit; the cache's identity key, eviction and
external-modification handling (`internal/server/characters_card_cache.go`) must not change unless the
change is exactly about them.

## 8. Cost, rollback, residual risk of the NOT-YET-MADE change

- **Cost:** a cache/preallocation change adds no new persistent state if it is a preallocation or a removed
  redundant stat; if it touches the card-text cache it inherits the cache-discipline obligations of
  `GOAL.md` §15.3 (key, value, owner, lifetime, capacity, eviction, invalidation, external modification,
  concurrency, rebuild, fallback) — which is why the cache is the *second* candidate, not the first.
- **Rollback:** revert the single commit; no data/format migration is involved in the candidate shapes.
- **Residual risk:** the 10k-card boot number may be dominated by page-cache/filesystem traversal, in
  which case the route-side change improves the route (measured p50 5.48 s) but not boot; the profile in
  §6.1 is what separates them. A change that improves RSS by shrinking retained card text trades repeat
  latency for memory, and both directions must be published.

## 9. What this document does NOT claim

- It does not claim a 10k-card defect: one observation on a loaded host cannot distinguish a product cost
  from a host cost — the pprof capture and the same-input ABBA pair are what would.
- It does not claim any CI number, and it does not splice alpha.16/Linux numbers into a local claim. The
  alpha.16 cache precedent (`docs/perf-baseline.md` §10.4: repeat -17.4%, cold +21.1%) is quoted only as
  prior expectation, not as a measurement of this build.
- It does not claim the alpha.16 cold-guard row is closed; it is still absent (`docs/alpha17/performance-plan.md`
  §9 row 17, §10.2) and is a named next step, not an executed guard.
