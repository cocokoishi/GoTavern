# alpha.20 quiet-window evidence (Layer A, Windows arm64 development host)

Status: **MEASURED IN A LEAD-COORDINATED QUIET WINDOW; local evidence only, not a CI verdict.** The window was
opened by the Lead (18:39-19:05 local, A/B told to hold heavy work). Raw files are
[`raw/quiet-window/`](raw/quiet-window/); every row below was computed from those files. Where the window's own
load sample disagrees with the "quiet" label, the disagreement is reported rather than hidden.

## 0. Subjects, order and provenance

- Lane merged `origin/main` (`e8600af`) before measuring; `git diff --name-only origin/main -- internal/ cmd/`
  listed only this lane's files (`image_metadata_index.go`, `worldinfo.go`, the two new test files and the
  golden testdata), so both subjects share one product base.
- `before` = `origin/main` build (`gotavern-before.exe`, sha256 `245A74DBEDFFB7B3B8469A6BBECC2B8A5ADA21DEABAB08C9D0065D8F44FC422A`, 60,891,648 B).
- `after` = same tree + the marshal change (`gotavern-after.exe`, sha256 `81CF0DC8CBB2FAF78AC149243D5173F5DCB46D81DE2B69037F7565634C33A9C3`, 60,913,664 B); +22,016 B (+0.04%) of binary size.
- ABBA order per subject pair: world-get `B,A / A,B / B,A`, chat-get `B,A / A,B / B,A`; a19profile `--warmup 1
  --requests 40`, request rows recorded verbatim in the per-invocation artifacts. Boot rows ran before→after

  after the ABBA rounds with the same binaries.
- **Host-load caveat, measured:** `a19-boot`'s final load sample reads `cpuLoadPercentEnd: 100` on both subjects,
  so the host was not provably idle at the end of the boot rounds (the measurement itself plus whatever resumed).
  The ABBA round-1 world `before` invocation was also slower than its later rounds (10.5 s vs 3.9-5.0 s), which
  is a cold page-cache effect, not a subject effect. Both facts are why every row below is reported with its
  spread and a NOT SEPARABLE verdict where the spread overlaps.

## 1. Process-level ABBA — request latency (a19profile HTTP windows)

p50/p95 are medians of three per-round quantiles (40 sequential requests per round). Lower is better.

| route | subject | p50 median (ms) | p95 median (ms) | p50 series | p95 series | verdict |
|---|---|---:|---:|---|---|---|
| `/api/worldinfo/get` 4 MiB world | before | 92.53 | 341.10 | 97.71 / 92.53 / 83.98 | 409.75 / 341.10 / 118.29 | — |
| | after | 85.14 | 316.88 | 89.46 / 81.60 / 85.14 | 277.49 / 316.88 / 350.30 | **NOT SEPARABLE** (p50 −8.0%, but the series overlap: the fastest before round is below two after rounds) |
| `/api/chats/get` 2,000 messages | before | 43.57 | 143.04 | 40.56 / 45.91 / 43.57 | 65.70 / 296.62 / 143.04 | — |
| | after | 33.31 | 64.23 | 31.82 / 33.31 / 38.49 | 62.30 / 64.23 / 89.09 | **p50 candidate-better, separable**: every after round beats every before round and the effect is −23.5% (15% floor); p95 is **NOT SEPARABLE** (series overlap) |

Reading rule applied: an ABBA row is "candidate-better" only when every candidate observation beats every
baseline observation AND the median effect clears the effect floor. World-get does not clear the separation
rule, so it is **NOT SEPARABLE** at the process level even though its allocation total drops 47.8% (§3); the
marshal was not the dominant share of that response's wall time (decode and gzip are). The chat row's p50 does
clear it.

## 2. Process-level boot and RSS (a19-boot, 10,000-card tree, 1 round per subject)

| row | before | after | verdict |
|---|---:|---:|---|
| cold boot, spawn → first `/version` 200 | 1,385.91 ms | 1,494.12 ms | NOT SEPARABLE (n=1 each; +7.8% is inside this host's recorded boot spread) |
| warm boot | 269.08 ms | 254.05 ms | NOT SEPARABLE (n=1; −5.6%) |
| RSS at cold readiness | 31.98 MB | 28.14 MB | NOT SEPARABLE (spread not measured) |
| **cold peak RSS** (`PeakWorkingSetSize`) | **363.80 MB** | **366.12 MB** | **NOT SEPARABLE** (+0.6%); the marshal change is not a peak-RSS lever |
| RSS at warm readiness | 31.98 MB | 31.52 MB | NOT SEPARABLE (−1.4%) |
| warm data request p50 (10,000 cards) | 1,988.59 ms | 1,949.17 ms | NOT SEPARABLE (spreads 1.89-3.79 s / 1.80-2.68 s) |
| warm data request max | 3,790.41 ms | 2,679.39 ms | NOT SEPARABLE (series overlap) |

The 10,000-card allocation row is unchanged by this patch (the route writes through `characters_json.go`), so
the boot/characters rows are reported as measured and **not** as an improvement.

## 3. Where the change does claim something (server-only benchmark, same window facts as above)

From [`changes.md`](changes.md): world 4 MiB marshal 35,351,980 → 18,472,490 B/op (−47.8%), 69,648 → 28,690
allocs/op (−58.8%); chat 2,000 messages 6,325,000 → 2,997,031 B/op (−52.6%), 42,015 → 16,015 allocs/op
(−61.9%); hinted arms 6,683,886 / 2,022,448 B/op. Those are deterministic and were identical across two runs of
one binary (A/A), so they are the claim. The process-level table above is the honest translation of that into
latency: one route's p50 separates, one route's does not.

## 4. Full `internal/server` suite on the patched tree

`go test ./internal/server -count=1 -timeout 20m` in the quiet window: **PASS**, `ok ... 265.799s`, zero
failures (`raw/quiet-window/full-suite.log`). This clears the earlier 612 s co-tenant run whose only failure,
`TestPresetSaveNeverPublishesATornJSON`, passed in isolation on both binaries; that earlier run remains classified
as a load artifact and is not used as evidence either way. **A local Windows green is Layer A, not a CI verdict**
(`AGENTS.md`); the CI gate is the same package on Linux.

## 5. 8-user mixed concurrency (report-only; no latency threshold is asserted)

`tests/perf/m5-eight-users.mjs` on the `after` binary: **ok**, 20,361 ms, 8 accounts, 144 requests, **0 non-200**,
isolation/disk-and-cross-user PASS (own markers present, no cross-user marker), isolation/read-own PASS.
Route latency (p50/p95/p99): settingsSave 538.70 / 737.27 / 795.58 ms; settingsGet 410.97 / 554.50 / 567.21 ms;
chatsSave 473.27 / 667.84 / 706.88 ms. **REPORT-ONLY**: the harness asserts no latency threshold, this is 8
accounts (not 16/32; the harness cannot drive more than the accounts it creates), and these values are not
comparable with alpha.19's post-release window on a different load pattern — the earlier run measured
settingsSave p50 285.5 ms with the same harness, and this window's own load sample ended at 100%, so the spread
is a host fact, not a product claim.

## 6. What this window does NOT prove

- **No leak proof.** It is a ~8-minute measurement window; the 60-minute soak on the frozen candidate is the
  long-run row and even it states that no growth over 60 minutes is not a mathematical leak proof.
- **No p99-over-the-real-UI-corpus claim**, no real-provider latency, no >8-user concurrency, no macOS/Linux
  runtime row.
- **The world-get process row is NOT SEPARABLE**; the allocation win is real and deterministic but it is not a
  wall-clock claim at the endpoint on this host.
- The `cpuLoadPercentEnd: 100` and cold-page-cache effects are disclosed above; a repeat window on a fully idle
  host could change the world-get verdict in either direction.

## 7. Commands and artifacts

```powershell
# both subjects were built from the merged lane tree; before from origin/main, after from the same tree + the patch
go build -trimpath -ldflags="-s -w" -o gotavern-before.exe ./cmd/gotavern     # in a detached origin/main worktree
go build -trimpath -ldflags="-s -w" -o gotavern-after.exe  ./cmd/gotavern     # in the lane worktree
go build -trimpath -o a19profile-after.exe ./tools/perf/a19profile
# ABBA, 3 alternating rounds per route/subject (order recorded per invocation)
a19profile.exe --mode http --route world-get --data-root <world-4mb>\data --config <world-4mb>\config.yaml `
  --out-dir <out>\abba\world4MB-<subject>-r<round> --label world4MB-<subject>-r<round> --warmup 1 --requests 40
# boot/RSS, one round per subject, alternating
node tools/perf/a19-boot.mjs --binary <subject>.exe --scale cards --cards 10000 --image-bytes 4096 --card-bytes 2048 `
  --rounds 1 --requests 6 --data-route characters --work-dir <work> --out boot-<subject>-r1.json --load-label "quiet window"
# suite and 8-user
go test ./internal/server -count=1 -timeout 20m
node tests/perf/m5-eight-users.mjs --binary gotavern-after.exe --report eight-users.json
```

Artifacts: `run-log.txt`, `abba-invocations.json`, `abba-summary.json`, `abba/` (per-invocation profile windows and
pprof files), `boot-invocations.json`, `boot-<subject>-r1.json` (+`.log`), `full-suite.log`, `eight-users.json`,
`isolation-*` only if they ran (they did not — the suite was green).
