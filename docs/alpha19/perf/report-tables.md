# alpha.19 report-ready tables — quote verbatim

These are the rows the final report and release notes may quote, in the exact wording the evidence supports.
Source of truth: [`summary.md`](summary.md) plus the artifacts named per table. **All numbers are Layer A** (Windows
development host, Go 1.27.3, 2 logical cores); the release claim is the Linux `GoTavern smoke metrics` paired gate.
Do not upgrade a row's wording when copying it.

## Table A — cumulative allocations, `/api/characters/all` (deterministic)

In-process, one tree, `-benchmem -benchtime=3x -count=1`. Cumulative: baseline (`52883e8`) → C1 (`e7be70f`) →
+C4 (`6509639`) → +C3 (`e39cf18`); C5 (`65834ec`) and C2 (`8a993e8`) do not touch these arms. Artifacts:
`raw/alpha18-baseline-inprocess-charactersall.txt`, `raw/c1-after-inprocess.txt`, `raw/c4-after-inprocess.txt`,
`raw/c3-after-inprocess.txt`.

| arm | baseline B/op | current B/op | delta | baseline allocs | current allocs | delta |
|---|---:|---:|---:|---:|---:|---:|
| 100 cards | 28,743,157 | 24,124,301 | −16.1% | 32,860 | 18,247 | −44.5% |
| 1,000 cards | 167,573,736 | 134,135,309 | −20.0% | 324,973 | 178,954 | −44.9% |
| 10,000 cards | 619,914,794 | 403,148,557 | −35.0% | 3,193,663 | 1,733,652 | −45.7% |
| 640 KiB single card | 90,694,058 | 83,136,538 | −8.3% | 33,140 | 18,531 | −44.1% |
| cold 10,000 cards | 879,836,722 | 663,713,360 | −24.6% | 3,500,332 | 2,040,317 | −41.7% |

Quote as: *"On the 10,000-card arm the response path allocates 403.1 MB/op in 1,733,652 objects, down from
619.9 MB and 3,193,663 objects (−35.0% bytes, −45.7% objects); the cold arm drops 24.6% of bytes and 41.7% of
objects. Warm and cold are separate rows."*

## Table B — quiet-window ABBA, process level

One window, same generated 10,000-card tree, order-alternated A,B / B,A / A,B, three rounds per subject, after a
same-binary self-test that came out all-not-separable (`raw/abba-self-test-quiet.json` — the gate that licenses the
rows). base = clean `52883e8` build (sha256 `261d42e7…`), cand = HEAD build (sha256 `BF7F7FD6…`). Artifact:
`raw/abba-cumulative.json`. Lower is better; effect floors are 5% latency / 15% ready RSS / 25% peak RSS.

| metric | base median | cand median | effect | verdict |
|---|---:|---:|---:|---|
| warm `/api/characters/all` p50, 10k cards | 1,692.26 ms | **1,139.65 ms** | **−32.7%** | candidate-better |
| warm data-request max | 1,823.26 ms | **1,223.44 ms** | **−32.9%** | candidate-better |
| cold PEAK RSS | 628.07 MB | **361.89 MB** | **−42.4%** | candidate-better |
| cold boot (spawn → first `/version` 200) | 542.22 ms | 543.06 ms | +0.2% | not separable |
| warm boot | 160.23 ms | 170.13 ms | +6.2% | not separable |
| cold first data request | 5,660.97 ms | 5,254.32 ms | −7.2% | not separable |
| RSS at cold readiness | 32.19 MB | 40.62 MB | +26.2% | not separable |
| RSS at warm readiness | 28.24 MB | 26.80 MB | −5.1% | not separable |

Quote as: *"On the quiet window the 10,000-card `/api/characters/all` warm p50 was 1.14 s against 1.69 s for the
alpha.18 tree (−32.7%), with every candidate round faster than every baseline round, and cold peak RSS was 362 MB
against 628 MB (−42.4%). These are Layer A, one paired observation, not the release gate."*

**The not-separable rows must be quoted as not separable, never as improved or regressed:**
cold boot, warm boot, cold first data request, RSS at cold readiness, RSS at warm readiness. In particular the
cold-boot row contains one 932 ms outlier round (candidate spread 73.8%) and the cold-readiness RSS row has a 47.4%
candidate spread; neither supports a direction.

## Table C — CPU attribution per change (shares of their own window)

| change | window | before | after | claim |
|---|---|---|---:|---|
| C1 | 10k in-process allocations | 619.9 MB / 3,193,663 objects | 541.3 MB / 1,753,661 objects | −12.7% bytes, −45.1% objects (member-ordering copy + sort removed) |
| C4 | 10k in-process allocations | 541.3 MB/op | 406.5 MB/op | −24.9% bytes (pre-size from summed card text) |
| C3 | 10k request CPU (`calculateChatSize` cumulative) | 1.21 s / 5.24 s samples (23.1%) | 0.08 s / 10.88 s (0.74%) | 10,000 failing directory opens removed |
| C5 | world-get window | 331.43 MB CPU·time | 256.46 MB (−22.6%) | `bytes.Replace` 48.02 MB → 0 |
| C5 | chat-get window | 149.71 MB | 115.45 MB (−22.9%) | `bytes.Replace` 14.35 MB → 0 |
| C2 | chat-completion relay window (300 requests) | 23.2% in config reader + YAML parser | 1.28% | one parse per process (pinned parity) |

## Table D — what the release notes may say, and what they may not

May say (each already evidenced above, Layer A labelled):
1. allocation totals per arm (Table A), warm and cold separately;
2. warm 10k `/api/characters/all` latency −32.7% p50 and cold peak RSS −42.4% on the quiet window (Table B), as
   Layer A, one window, self-test-gated;
3. the stability findings by class: watchdog goroutine leak (product, RED 50 → GREEN 0), 39-minute hang (test
   defect: peer did not drain the request body), C1 `entries()` regression (product, caught by the pinned
   differential, fixed and teeth shown);
4. the C2 behaviour change as a PARITY fix (runtime `config.yaml` edits are not observed without a restart, as in
   pinned — probe artifact `raw/../profiles/c2-pinned-config-refresh.json`).

## Table E — Node control (one shared window, NOT an ABBA pair)

Artifact `raw/node-control.json` (commit `cb7080f`); harness `tests/perf/q22-paired-benchmark.mjs`, 3 alternating
rounds × 30 requests + its own 10-minute soak window per subject; zero assertion failures.

| measurement | pinned Node 1.19.0 | GoTavern |
|---|---:|---:|
| boot, spawn → ready | 34,598 ms (includes per-boot webpack compile) | 1,088 ms |
| `GET /version` median / p95 | 812.88 ms / 995.60 ms | 15.31 ms / 21.20 ms |
| `GET /` | 36.72 ms | 32.05 ms |
| 10-min soak request median | ~735–849 ms (p95Drift +249.7 ms) | 15.1–15.9 ms (p95Drift −0.8 ms) |

Quote as: *"In one shared window on the development host, GoTavern booted in 1.1 s against pinned's 34.6 s
(which includes pinned's boot-time frontend compile) and answered `GET /version` in 15.3 ms against 812.9 ms, with
the 10-minute soak window flat on both sides; RSS was not measurable on this host (the harness reads Linux
`/proc`), so no memory comparison is claimed."* Layer A, not the release gate.

Also measured post-release (see `raw/README-alpha19-window.md`):
- 8-user smoke: PASS, 8 accounts × 3 waves, 72 ops, 0 non-200, isolation checks pass, 58.065 ops/s, settingsSave
  p50 285.5 ms / chatsSave p50 246.6 ms (no latency threshold asserted; delete/rename/import not driven).
- 10-min corpus soak on the COPY: 4,850 requests / 0 errors, 8.081 req/s, p50 21.4 / p95 35.4 / p99 48.9 ms,
  RSS peak 29.3 MB and flat, leak UNPROVEN (RSS-only), integrity checks pass, original corpus byte-identical.
Quote the soak only as "no visible resource growth in 10 minutes", never as "no leak".

May NOT say yet (not measured at this commit):
- any long-run MEMORY comparison: the Node control artifact's RSS is `null` because the harness reads Linux
  `/proc`, so there is no memory row from it; the soak's RSS is a Windows single-process series, not a
  Go-vs-Node comparison;
- anything about restart behaviour (the 10-min run ended before its restart interval);
- ≥8-user concurrency or long-run resource trend (harness reuse plan exists in `summary.md` §8, nothing ran);
- p99 over the real-UI corpus, or any real-provider latency;
- any boot-time improvement or regression (all boot rows are not separable);
- any claim whose wording lifts a row out of its table (e.g. "35% faster" from the allocation table — that is
  bytes, not time).
