# alpha.19 performance lane — baseline reproduction on this host (Layer A)

**Status: BASELINE REPRODUCTION MEASURED; ABBA/DELTA CLAIMS NOT YET MEASURED.** Every number here is a LOCAL
Windows/arm64 measurement (Layer A). The release performance gate remains `GoTavern smoke metrics` on Linux CI;
nothing in this directory replaces it. The repository rule that a local green is not a CI verdict applies to
every row below.

This file is the reproduction record for the immediate task: *reproduce the recorded alpha.18 in-process
baseline at the baseline commit on this host, and record fresh profiles before changing any product code.* The
hotspot attribution and the ranked candidate list are in [`hotspots.md`](hotspots.md).

## 1. Provenance

| fact | value | source |
|---|---|---|
| host | Windows 11 Enterprise LTSC 10.0.26100 (24H2) arm64, QEMU `virt-7.2`, **2 logical cores**, 12,879,790,080 B RAM | `raw/host.txt` |
| Go / Node | `go1.27.3 windows/arm64` / `v24.19.0` | `raw/host.txt` |
| GOMAXPROCS | unset (Go default = 2); benchmark runs exported `GOMAXPROCS=2` explicitly | command lines below |
| branch / HEAD measured | `alpha19/program` / `07af095` (the charter commit) | `git log -1` at measurement time |
| product code at measured HEAD | **identical to baseline `52883e8`**: `git diff --name-only 52883e8..07af095 -- internal/ cmd/` returns nothing | git |
| load label | **shared host, NOT quiet**: at least four other `node.exe` processes (other alpha.19 lanes) plus Chromium processes were running; `Get-CimInstance Win32_Processor` sampled `LoadPercentage = 100`; the harness recorded `cpuLoadPercentEnd = 100` | `raw/boot-cards-10000.json`, §4 |
| `-race` | unavailable on windows/arm64; Linux CI owns the race gate. No race claim is made here. | `docs/alpha19/CHARTER.md` §1.5 |

**How signal was separated from the load.** Go allocation totals (`B/op`, `allocs/op`) are deterministic for
the same input and binary, and they reproduced the alpha.18 record to within 0.0001% (table §2); wall-clock
`ns/op` did not (it is inflated 1.04x-2.1x in-process and far more at process level by the co-tenant lanes).
The baseline therefore stands on the allocation columns, which are *exact*, and the time columns are reported
with their load label instead of being quoted as a delta. A quiet-window ABBA run is required before any
before/after latency or RSS claim; that is scheduled with the Lead, not assumed.

## 2. In-process baseline — `internal/server` benchmarks (reproduction)

Command (raw output: [`raw/alpha18-baseline-inprocess-charactersall.txt`](raw/alpha18-baseline-inprocess-charactersall.txt), parsed rows:
[`raw/inprocess-baseline.json`](raw/inprocess-baseline.json)):

```powershell
$env:GOMAXPROCS = "2"
go test ./internal/server -run '^$' -bench 'BenchmarkCharactersAllScale|BenchmarkCharactersAllCold' `
  -benchmem -benchtime=3x -count=1 -timeout=2400s
```

| arm | measured ns/op | measured B/op | measured allocs/op | alpha.18 record (same host) | allocation reproduction |
|---|---:|---:|---:|---|---|
| `/api/characters/all`, 100 cards, 128 KB images | 56.11 ms | 28,743,157 B | 32,860 | 55.6 ms / 28.7 MB | **identical** |
| 1,000 cards, 32 KB images | 418.83 ms | 167,573,736 B | 324,973 | 402.3 ms / 167.6 MB | **identical** |
| 10,000 cards, 4 KB images (warm cache) | 4,827.08 ms | 619,914,794 B | 3,193,663 | 2,295.9 ms / 619.9 MB / 3,193,667 | **exact** (Δ allocs = 4) |
| 100 cards, 640 KB images | 464.74 ms | 90,694,058 B | 33,140 | no alpha.18 row (bench kept for the byte coefficient) | n/a |
| `BenchmarkCharactersAllCold`, 10,000 cards | 8,872.99 ms | 879,836,722 B | 3,500,332 | 5,542.9 ms / 879.0 MB / 3,500,341 | **exact** (Δ allocs = 9) |

The alpha.18 record is [`docs/alpha18/perf/README.md`](../alpha18/perf/README.md) §2 and
[`docs/alpha19/CHARTER.md`](../CHARTER.md) §7.3. The time columns are the only rows that do not reproduce, and
they are the rows the co-tenant lanes distort; the allocation columns reproduce to a handful of allocations,
which is the reproduction claim this section makes.

**Cold/warm split measured directly** (not inferred): one process measuring one request pays **884,676,824
B/op / 3,500,453 allocs/op**; the same process measuring six requests pays **553,727,185 B/op / 3,116,988
allocs/op**. Solving for the repeat row gives **≈ 484.7 MB/op warm** against 884.7 MB/op cold, i.e. the
alpha.18 card-text cache does hit after the first request and removes ~45% of the cold request's allocations.
Raw output: [`raw/cache-hit-1x-vs-6x.txt`](raw/cache-hit-1x-vs-6x.txt). This split is what makes a
"warm request" profile possible at all (§5).

## 3. Process-level startup and card-list latency

Harness: [`tools/perf/a19-boot.mjs`](../../../tools/perf/a19-boot.mjs) (new in this lane). It exists because
the A15 suite polls readiness every 20 ms, which cannot resolve the alpha.18 warm-boot row (165 ms); this
harness polls with a raw loopback TCP connect at **2 ms** granularity, boots the real binary over a
`tests/perf/fixturegen` tree, and records `spawn → first 200 on GET /version` for a cold boot (fresh tree) and
a warm boot (same tree again), plus a `tests/perf/procstat` sample at readiness and the first card-list request
(cold process cache) followed by repeats (warm).

Raw artifacts: [`raw/boot-cards-100.json`](raw/boot-cards-100.json),
[`raw/boot-cards-1000.json`](raw/boot-cards-1000.json),
[`raw/boot-cards-10000.json`](raw/boot-cards-10000.json). Command pattern:

```powershell
node tools/perf/a19-boot.mjs --binary <candidate>\gotavern.exe --scale cards --cards <n> `
  --image-bytes <b> --card-bytes <b> --rounds 3 --requests 6 --data-route characters `
  --work-dir <scratch>\boot --out <artifact>.json --load-label "<what else was running>"
```

| tree | cold boots (ms) | warm boots (ms) | load label |
|---|---|---:|---|
| 100 cards, 128 KB images | 247.5 / 580.2 / 719.6 | 273.7 / 243.4 / 218.1 | shared, 100% busy |
| 1,000 cards, 32 KB images | 510.3 / 911.7 / 662.2 | 222.4 / 168.4 / 167.8 | shared, 100% busy |
| 10,000 cards, 4 KB images | 1,851.7 / 1,309.9 | 601.0 / 1,773.2 | shared, 100% busy |

**These are not baseline claims.** The spread (a warm boot moving between 167.8 ms and 1,773.2 ms on the same
tree) is larger than every alpha.18 delta in this table, so the rows can only say "the harness works and the
host was saturated". The 10,000-card `/api/characters/all` body size is deterministic and useful:
**58,887,196 B**, recorded in `raw/boot-cards-10000.json`. The startup timing claim needs a quiet window (§6).

## 4. Startup stage attribution (non-profile evidence)

The application already has a stage tracer; running it does not require a profiler, and it is independent of
host CPU saturation in the sense that it names *which stage* absorbed the time. Captured while booting
`internal/app.Start` in-process over a freshly generated and then reused 10,000-card tree
(`docs/alpha19/perf/profiles/a19-startup-{cold,warm}-10000.json`) with `GOTAVERN_STARTUP_TRACE=1`:

| stage | cold (fresh tree) | warm (same tree, second boot) |
|---|---:|---:|
| `startup.command-line` | 53 ms | 53 ms |
| `startup.data-startup` | **1,665 ms** | **560 ms** |
| `startup.listeners` | 263 ms | 226 ms |
| `startup.routes` | 43 ms | 35 ms |
| `startup.ready` | 0 s | 0 s |
| **total (app.Start returned)** | **2,023.8 ms** | **874.9 ms** |

The cold/warm difference is the first-boot work (`stats.json` recomputation over 10,000 cards plus seeding);
the warm stage is still measurable. The CPU profile over the cold window (1.31 s of samples in 2.02 s) attributes
0.62 s (47.3%) to `runtime.cgocall` (filesystem metadata calls on a fresh tree) and 0.18 s (13.7%) to
`internal/startup.VerifyCharacterDiskCache`; the rest is runtime/GC noise from the 2-core host. This agrees
with the alpha.18 root-cause record (per-card metadata access, not enumeration) and does **not** re-open it.

## 5. Fresh profiles captured for every target workload

Tool: [`tools/perf/a19profile/`](../../../tools/perf/a19profile/main.go) (new in this lane). It calls the same
`internal/app.Start` the shipped binary calls (so startup is the real pipeline, not a benchmark stub), starts
`runtime/pprof` *before* that call for startup mode, and for request modes it performs warmup requests and only
then starts the CPU profiler — so the request profile is the **warm** path, which the existing benchmark cannot
isolate (its allocation profile always mixes one cold iteration with N-1 warm ones; §2 quantifies the split).

| workload | window | artifacts (under `profiles/`) |
|---|---|---|
| startup, cold 10,000-card tree | `app.Start` until returned | `a19-startup-cold-10000-{cpu,heap}.pb.gz`, `-cpu-top.txt`, `-alloc-{space,objects}-top.txt`, `.json` |
| startup, warm 10,000-card tree | second boot, same tree | `a19-startup-warm-10000-…` |
| `/api/characters/all` 10,000 cards, warm | 3 profiled requests (1 warmup) | `a19-http-characters-warm-10000-…` |
| `/api/characters/all` 1,000 cards, warm | 5 profiled requests | `a19-http-characters-warm-1000-…` |
| `/api/characters/all` 100 cards, warm | 8 profiled requests | `a19-http-characters-warm-100-…` |
| long chat (`/api/chats/get`, one 2,000-message chat) | 5 profiled requests | `a19-http-chat-get-2000msg-…` |
| chat summary (`/api/characters/chats`) | 5 profiled requests | `a19-http-chat-summary-…` |
| large world book (`/api/worldinfo/get`, 4 MB) | 5 profiled requests | `a19-http-world-get-4MB-…` |
| provider SSE relay (streaming, custom endpoint) | 300 profiled requests | `a19-relay-stream-small-…` |
| group-chat generation payload over the same route | 60 profiled requests | `a19-relay-group-generation-…` |

Every `.json` beside a profile records the exact startup stage lines, the request rows (status, bytes, ms),
GOMAXPROCS, Go version and the profile filenames, so a reader can check the window rather than trust it.
The attribution and the ranked candidate list are in [`hotspots.md`](hotspots.md).

**What the profiles are and are not.** CPU profiles are 100 Hz samples; a short window (e.g. the 1,000-card
card list at 760 ms) carries hundreds of samples, not millions, and is quoted with its total. Under the
co-tenant load both cores were 100% busy, which inflates `runtime.asyncPreempt` (18.6% of the warm 10,000-card
window and 17.5% of the world-get window) — that share is a load artifact, not product CPU, and is called out
wherever it appears. Allocation profiles do not depend on wall clock and are the primary evidence.

## 6. What is NOT proven here

- **No quiet-window ABBA.** The host was 100% busy from other lanes for the whole session, so no
  before/after latency, throughput or RSS claim is made from these runs. A quiet window is required and is
  being scheduled; the protocol will be A,B / B,A / A,B with cold and warm reported separately.
- **No Node control in this record.** The pinned Node comparison (boot, RSS, route latency) needs a pinned
  boot and belongs in `vs-node.md`, which this record does not claim. The CI paired record remains the release
  baseline (`tests/perf/q22-baseline.json`).
- **No peak/steady RSS claim.** `tools/perf/a19-boot.mjs` records `procstat` peak RSS and readiness RSS, but
  the only rows captured were under saturation; they are raw data, not a claim. B/op is never reported as RSS.
- **No 8-user concurrency or long-run trend.** The real-UI corpus is still being produced; that work waits for
  the corpus path from the Lead.
- **No p50/p95/p99 claim** beyond the raw request rows in the artifacts; a percentile from 3-8 samples is a
  description, not a tail-latency measurement.
- **No `-race` run**: unsupported on windows/arm64; Linux CI owns it.
- Startup profiles cover `internal/app.Start` in-process. They deliberately do not include process exec/loader
  time; `tools/perf/a19-boot.mjs` measures the process-level number separately.
