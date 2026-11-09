# alpha.19 performance targets (set AFTER profiling, per CHARTER §7.4)

**Status: targets recorded before any product change.** The evidence that produced them is
[`hotspots.md`](hotspots.md) and the raw profiles in [`profiles/`](profiles/). Every target names the exact
input (tree shape, cache state, request count) so a later reader can re-run it. A target is a goal, not a
result; the result table is filled only after an approved change is measured.

## 0. Claim rules (from CHARTER §7.4 and the alpha.18 protocol)

1. **Allocation targets are exact.** Go reports `B/op` and `allocs/op` deterministically for the same input and
   binary; they reproduced the alpha.18 record to within a handful of allocations on this host. A change may
   claim an allocation improvement when the AFTER total is below the BEFORE total, with both raw files
   committed.
2. **Timing targets need separation.** The claim is allowed only when **every** candidate observation is better
   than **every** baseline observation across the ABBA rounds (A,B / B,A / A,B), cold and warm reported
   separately; otherwise the row is reported as "no improvement / inside noise". A 2-core host shared with two
   other lanes cannot support a weaker rule.
3. **Memory and CPU are reported separately.** `B/op` is never reported as Peak RSS. Peak RSS comes from
   `tests/perf/procstat` (`PeakWorkingSetSize` / `VmHWM`) on a real process; steady RSS is a separate row.
4. **A measured regression is listed, not hidden**, including a route the change did not target.
5. **Semantics first**: the full `internal/server` suite (`-count=1`), the provider-wire replay and the
   character-read fixtures must be green after every change; a change that moves output order / JSON semantics
   / Unicode / provider requests / extension events is reverted.

## 1. Targets by candidate

| # | input | baseline (measured on this host) | target | metric kind |
|---|---|---|---|---|
| **T1** (C1) | `/api/characters/all`, 10,000 cards @ 4 KB image / 2 KB card, warm cache, `-benchtime=3x` | **619,914,794 B/op, 3,193,663 allocs/op** (exact) | **≤ 465 MB/op (−25%)** and **≤ 2,100,000 allocs/op (−34%)** | deterministic allocation |
| **T2** (C1) | same route, 1,000 cards @ 32 KB image / 8 KB card | 167,573,736 B/op, 324,973 allocs/op | ≤ 130 MB/op (−22%) and ≤ 220,000 allocs/op (−32%) | deterministic allocation |
| **T3** (C1) | same route, 100 cards @ 128 KB image / 8 KB card | 28,743,157 B/op, 32,860 allocs/op | no regression (fixed per-request work dominates; C1 only removes per-object overhead) | deterministic allocation |
| **T4** (C1) | `/api/characters/all` 10,000 cards, process-level warm request | 58,887,196 B response; ABBA rows not yet measurable (host saturated) | warm p50 improves and **every** candidate round is below every baseline round; otherwise "no timing claim" | ABBA latency |
| **T5** (C2) | streaming generate through a custom endpoint, 300 requests | config read+parse = **0.71 s of the handler's 1.06 s CPU (67%)**, 18.7% of the relay window; yaml = 22.3% of window allocations | config share **< 2% of the window**; relay window CPU **−15%**; warm p50 **−10%** only if separable | profile share + ABBA |
| **T6** (C3) | `/api/characters/all` 10,000 cards, no chat directories | `calculateChatSize` = 8.29 s `os.ReadDir` (15.2% of the request path in the mixed profile) | card-list request-path CPU **−10%**; response bytes/order unchanged | profile share + ABBA |
| **T7** (C4) | `/api/characters/all` 10,000 cards | `bytes.growSlice` = 770.5 MB across the warm window (28.3% of its alloc_space) for a 58.9 MB body | window alloc_space **−8%**; **no increase** in process peak RSS beyond the measurement spread | deterministic allocation + process RSS |
| **T8** (C5) | `/api/worldinfo/get`, one 4 MB world, warm | 333.85 MB alloc_space / 6 requests ≈ 55.6 MB/request; `bytes.Replace` 48.5 MB (14.5%) | allocation **−15%**; byte-identical response | deterministic allocation |
| **T9** (all) | startup, cold 10,000-card tree / warm same tree | cold `app.Start` 2,023.8 ms (`data-startup` 1,665 ms); warm 874.9 ms (`data-startup` 560 ms) — under load, not a claim | **no regression**; no startup improvement is claimed in alpha.19 until a quiet-window measurement says otherwise | stage timings + process boot |
| **T10** (C6, deferred) | `/api/characters/all` 10,000 cards | decode = 32.7-36.8% of allocation objects, 16.8% of request CPU | only if the Lead accepts a memory trade: **resident memory measured**, not implied | allocation + RSS, deferred |

## 2. Explicit non-targets

- **Gzip level/algorithm.** 13.8-21.4% of large-response CPU windows, but it is a pinned-parity HTTP-layer
  observable. Excluded unless the Lead makes a parity decision; not a perf-lane change.
- **Node comparison.** Belongs in `vs-node.md` against a pinned boot; the release paired record stays
  `tests/perf/q22-baseline.json` (Linux CI). Nothing here replaces it.
- **p99/tail latency.** The current harness records full request rows and percentiles, but 3-8 samples are a
  description, not a tail measurement; a p99 claim needs the concurrency phase over the real corpus.
- **Leak-free certificate from RSS.** UNPROVEN by construction on Windows from outside the process; the soak
  instrumentation must combine heap/goroutine/handle evidence (`docs/pace` is not available on this host), and
  the verdict stays UNPROVEN until that exists.
- **24-hour run.** Either executed with recorded constraints or reported as infeasible with the platform limit
  named; a short run is never presented as a 24-hour result.

## 3. Regressions each change must check

| change | regression to check |
|---|---|
| C1, C5 | response bytes for every character/world route (fixtures + a new differential pin over the corpus) |
| C2 | config changes made externally between requests are still observed (stat-validated cache) and the `SILLYTAVERN_*` environment override still wins; startup behaviour unchanged |
| C3 | error contract for a non-directory chat entry and a symlinked chat directory; a chats root that cannot be listed |
| C4 | transient memory: peak RSS must not rise beyond the measurement spread on a real process |
| C6 | resident-memory increase measured and reported; mutation aliasing covered by tests |
| any | cold first request (`/api/characters/all` cold arm) must not regress; startup must not regress |

## 4. What changes this file

A target is replaced only by a measurement that legitimately changes the observation (a different benchmark
input, a different host class, or a shipped change that moved the baseline). A needed re-measurement is recorded
with its raw artifact beside it; a target is never silently edited to match a result.
