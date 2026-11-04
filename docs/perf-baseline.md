# Performance baseline and the evidence gate

**One artifact is the source of truth for the README performance table, `docs/assets/benchmark.svg` and
`docs/assets/benchmark.svg.provenance.md`.** This document records the current baseline, the unit rule, the
method and its limits, the current metric/workload coverage, and the procedure that replaces the baseline.
`tools/check-perf-docs.mjs` enforces the agreement in CI (`ci.yml#verify`, step "Verify the performance
evidence matches the recorded artifact"); no number in those three surfaces may exist only as prose.

This is M2a of the engineering ladder (`GOAL.md` §11): the evidence gate first, so that the M2 scale
benchmarks and the M7 figure restructure cannot ship numbers the repository cannot check.

## 1. The committed artifact

`tests/perf/q22-baseline.json` is a wrapper with two members:

| member | content |
|---|---|
| `provenance` | run id, full commit, workflow/job/artifact names, build flags, Go version (with its source), host facts (with their source), and what is not recorded |
| `report` | the downloaded `q22-paired-benchmark.json` artefact, embedded **verbatim**: every sample, every summary median, the soak series and the harness's own `asserted` flags |

The wrapper is written by `tools/record-perf-baseline.mjs`, never by hand. The recorder refuses an
artefact whose structural assertions are false (`everyRoundAnswered`, `sampleCountsMatch`), whose summary
metrics are missing/non-finite, whose soak is incomplete, or whose sibling smoke-metrics record belongs
to a different run id, commit or runner image. That last check is the one that matters: host facts may
only come from the same run, because GOAL §15.2 forbids splicing numbers or hosts across runs.

| field | value |
|---|---|
| workflow / job | `GoTavern smoke metrics` / `paired-linux-amd64` |
| run id | `41614844179` (success, `workflow_dispatch`, `main`) |
| measured commit | `4bf54510c747b3f257835fa1bfa86909bbb5f134` (`v0.1.0-alpha.13`) |
| runner image | `ubuntu26` (`20261026.180.1`), Linux/X64, kernel `7.0.0-1017-azure`, **4 vCPU, 16,759,443,456 B RAM** |
| Node (pinned subject) | `v24.22.1` |
| Go toolchain | `go.mod` directive `1.27.3`, read by `setup-go` via `go-version-file: go.mod`; **not recorded by the artefact** (named, not invented) |
| build | `CGO_ENABLED=0`, `-trimpath`, `-ldflags="-s -w -X main.version=paired-41614844179"` (`smoke-metrics.yml` paired job) |
| rounds / samples | 3 alternating rounds × 30 sequential requests per path; RSS median of 6 samples/subject; 90 latency samples/subject; soak 2 × 10 min, 30 s sampling, 20 samples/subject |
| GOMAXPROCS | not set by the harness (defaults to the 4-vCPU runner); the environment is not in the artefact, so it is recorded as not-recorded |
| raw artefact | Actions artifact `q22-paired-benchmark` of run `41614844179`, embedded under `report` |
| sibling host record | Actions artifact `smoke-metrics` of the **same** run, used only for the host block above |

## 2. Unit rule

**Memory is decimal MB: 1 MB = 1,000,000 bytes.** The README table, the figure and the provenance all
use this one rule; the figure prints the exact byte count beside the MB value so the rounding is
checkable, and the RSS row note states the rule. Time is milliseconds. The gate recomputes every MB from
`rssBytesMedian / 1e6` with `>= 100 → integer, thousands-separated` and `< 100 → one decimal`; it does
not accept a number that only matches under a different unit (the alpha.13 tag tree's 1,057 MB / 36.9 MB
was a MiB-style number against a decimal-MB figure, and no gate could see it).

## 3. Method (unchanged by M2a; M2b owns method changes)

`tests/perf/q22-paired-benchmark.mjs` boots pinned Node SillyTavern and GoTavern from the same pinned
checkout, in alternating rounds, each over a fresh `mkdtemp` data root, and records every sample:

- boot: spawn → first `GET /version` 200 carrying the pinned version record (`measureRound`, L123-154);
- RSS: `VmRSS` from `/proc/<pid>/status`, read after readiness and after both latency runs
  (`residentBytes`, L69-77; sampling L137,140);
- latency: 30 sequential `GET /version` and 30 sequential `GET /` per round, body fully consumed
  (`timeRequests`, L96-106);
- soak: 10 minutes per subject, 20 requests per 30 s sample, RSS and p95 recorded as a SERIES
  (`soak`, L160-211; window/sample settings L243-249);
- summary medians and sample counts (`summarise`, L253-270); the harness asserts only structural
  properties (`report.asserted`, L271-279) — a paired median on a shared runner is evidence for a
  report, not a release gate.

The single-sided record (`scripts/smoke-metrics.mjs`) is a separate harness: cold and warm boot, 50
sequential requests per path, VmRSS, host identity. It is not the baseline; it supplies the host block
for the same run.

## 4. Current baseline numbers (restated from the artifact; the gate is the authority)

| metric | pinned Node | GoTavern | unit/statistic |
|---|---:|---:|---|
| cold start to first `/version` 200 | 11,522 ms | 213 ms | median of 3 rounds |
| steady-state RSS | 1,153 MB (1,153,224,704 B) | 39.5 MB (39,544,832 B) | median of 6 samples, decimal MB |
| `GET /version` latency | 51.04 ms | 0.292 ms | median of 90; p95 59.56 / 0.424 |
| `GET /` latency | 10.72 ms | 1.49 ms | median of 90 |
| 10-minute soak | RSS drift −817.9 MB from peak, p95 +0.41 ms | RSS drift −1.6 MB, p95 +0.32 ms | last−first of 20 samples |

These are the numbers the README table and the figure must restate; the gate compares them cell by cell
and byte by byte rather than trusting this paragraph.

## 5. Current metric coverage

`exists` = measured and recorded by a committed artifact or gate; `partial` = measured only in a
different harness or not recorded; `missing` = no measurement.

| metric | state | evidence |
|---|---|---|
| cold start | exists | `q22` boot L123-154; `smoke-metrics.mjs` boot L212-266; baseline |
| ready latency (listen → first 200) | partial | `smoke-metrics.mjs` `startToListenMs` L225,265 (not in the paired artifact or README) |
| RSS (steady) | exists | `q22` L69-77,137,140; `smoke-metrics.mjs` L175-183 |
| peak RSS | partial | one-off manual before/after, `docs/data-safety.md` §8.4.1 L481-497 (552.0 → 37.7 MB peak working set); no script/CI, no `VmHWM` anywhere |
| CPU time | missing | wall-clock only; the runner CPU count is recorded but no process CPU time |
| p50 | exists | median in `q22` L108-113,262; `smoke-metrics.mjs` L300-310 |
| p95 | partial | `q22` summary version only L265; `smoke-metrics.mjs` both routes L310; browser legs in `extension-corpus-probe.mjs` L283 |
| p99 | partial | `extension-corpus-probe.mjs` L283 (browser soak API latency) only; not server routes/README |
| req/s (throughput) | missing | all harnesses are sequential by design (`smoke-metrics.mjs` L283-285) |
| ns/op, B/op, allocs/op | exists (in-process) | `internal/server/bench_test.go` benchmarks L260,270,281,291,302,316, `ReportAllocs`; no committed CI artifact (local numbers only) |
| goroutines | partial | leak gate `internal/server/server_soak_test.go` L160,174-185; browser probe attempts `/debug/pprof/goroutine` and records null (`extension-corpus-probe.mjs` L241-249) |
| GC count/pause | missing | no `runtime.MemStats.NumGC`/`PauseNs` or `GODEBUG=gctrace` capture |
| file descriptors | partial | `server_soak_test.go` L201-209,260-268 (Linux `/proc/self/fd`; `-1` elsewhere) |
| long-run drift | partial | `q22` 10-min `/version`-only soak L160-211; 30-min browser soak in `third-party-extension-compat.yml` (RSS/p95 guard); no repeated-login/file-change drift |
| `benchstat` multi-round comparison | missing | no script or workflow uses it |
| CPU/heap/block/mutex pprof capture | missing | only bench usage comments (`bench_test.go` L34-37) and a profile narrative in `internal/server/static.go` L105 |
| execution trace | missing | not captured anywhere |
| `-race` | exists | `ci.yml` job `race` (bounded package set) |

## 6. Workload coverage (A–I from the M0 audit)

| workload | state | evidence / why |
|---|---|---|
| A. first boot + frontend load | partial | boot/ready measured (§5); `GET /` shell latency; full 229-asset browser page load is measured only as an unasserted overhead leg of the extension corpus, not in the README |
| B. 100/1,000/10,000 characters | missing | benchmark tree plants one card (`bench_test.go` L67-89) |
| C. large JSONL chats with swipes/edits/branches | missing (performance) | functional e2e only; the benchmark chat is two lines |
| D. complex preset + world info + author's note + tokenizer | missing (performance) | functional differentials only |
| E. multi-user concurrency | missing | `-race` finds races; no concurrent load/throughput harness |
| F. static hot path + full browser load | partial | in-process static benchmarks L281-327; browser load only in the extension overhead leg |
| G. provider non-stream / stream / cancel | missing (performance) | functional gates + live canary per-probe latency; no TTFB/inter-frame/cancel latency |
| H. extension install/restart/recover/uninstall | partial | lifecycle differential (functional) + overhead leg; no per-phase timing |
| I. long-run repeated login + file changes | partial | `q22` soak is `/version`-only; the 30-min browser soak changes settings/reloads but has no login churn |

## 7. The gate

`tools/check-perf-docs.mjs` (wired into `ci.yml#verify`) performs these checks and stops at the first
mismatch with a readable diff naming the file, the expected value and the artefact field:

1. baseline shape and provenance (run id, full commit, rounds, request count, soak window/sampling);
2. README table: cold start, RSS, `/version` (median + p95), `/` — recomputed from `summary.*` under
   the decimal-MB rule, for **every** occurrence of the four rows (the TL;DR mini-table near the top and
   the Performance table below the figure are both release surfaces; only the Performance section also
   carries the "How it was measured" column, which is checked against the artifact's sample counts);
3. README prose: cited run id and short commit; soak drift values (`−1.6 MB`, `+0.32 ms`, `+0.41 ms`)
   recomputed from `soak[]`; the decimal-MB unit rule stated once in the section;
4. provenance: run id, full commit, runner image, rounds, request count, soak description, and the
   decimal-MB unit statement (including that the unit is stated on the row);
5. the figure: `tools/benchmark-svg.mjs` regenerated from the committed baseline into a temp file **twice**
   (determinism), byte-compared with the committed `docs/assets/benchmark.svg`; the generator must contain
   no hardcoded release version or measured commit (the pinned oracle commit is the one allowed literal) and
   the output must carry `role="img"`, `<title>`, `<desc>`, the per-metric `faster`/`lighter` verdicts, the
   decimal-MB row note, the run id/short commit, and no external font/image/script/network reference.

Teeth, observed locally on 2026-11-03 (each mutation was applied, the gate run, the file restored by copy,
and the restore verified by SHA-256; the restored tree is green):

| mutation | gate output (first line) |
|---|---|
| README performance row `11,522` → `11,523` | `README.md:26: row "Cold start to first `/version` 200": pinned cell is "11,523 ms", the artifact gives "11,522 ms" (report.summary.*.bootMsMedian (11522 / 213))` |
| baseline copy `bootMsMedian` `11522` → `11523` | `README.md:26: row "Cold start to first `/version` 200": pinned cell is "11,522 ms", the artifact gives "11,523 ms" (report.summary.*.bootMsMedian (11523 / 213))`, plus the second README table and the SVG byte diff |
| committed SVG `11,522` → `11,523` | `docs/assets/benchmark.svg:3: differs from the figure regenerated from tests/perf/q22-baseline.json: expected "<desc ... SillyTavern 11,522 ms ...", committed "<desc ... SillyTavern 11,523 ms ..."` |

CI teeth are the same assertions: the step is `node tools/check-perf-docs.mjs` in `ci.yml#verify`; a red
run names the file, line, found value, artifact-derived value and artifact field, and writes nothing.

## 8. Update procedure (ONE commit replaces the baseline and the docs it feeds)

1. Run `GoTavern smoke metrics` (`workflow_dispatch`, mode default) **at the commit the docs will
   describe**; the paired job is the baseline.
2. Download both artifacts of that run:
   `gh run download <run-id> -n q22-paired-benchmark -D /tmp/q22` and
   `gh run download <run-id> -n smoke-metrics -D /tmp/smoke`.
3. Record the baseline (the recorder verifies the two artifacts are the same run/commit/runner):
   `node tools/record-perf-baseline.mjs --q22 /tmp/q22/q22-paired-benchmark.json --host /tmp/smoke/smoke-metrics.json --run-id <run-id> --commit <full sha> --out tests/perf/q22-baseline.json`
4. Regenerate the figure from the new baseline: `node tools/benchmark-svg.mjs --report tests/perf/q22-baseline.json --out docs/assets/benchmark.svg` (the generator reads the wrapper's provenance for the run id and commit; two runs must be byte-identical).
5. Update the README table/prose and the provenance run/commit/rounds/soak fields to the new numbers.
6. `node tools/check-perf-docs.mjs` must be green; commit the baseline, the figure, the README, the
   provenance and this document in the **same commit**, so no intermediate tree claims one run's numbers
   while citing another's.

The gate cannot update anything itself: it fails closed and tells the maintainer what to fix.

## 9. Limitations and residual risk (named, not implied)

- One run, one shared runner, one image; absolute numbers are host noise. The comparison is same-host
  paired and same-commit, which is what the claim needs, but it is not a budget or a promise.
- Boot samples are n=3 and vary widely (GoTavern 160/935/213 ms in this run); the median is reported and
  the spread is not. M2b adds rounds/aggregation if a tighter claim is needed.
- The q22 artifact records the runner image only; OS/CPU/RAM come from the sibling smoke-metrics record
  of the same run (verified by the recorder). A run without that artifact cannot be recorded as a
  release baseline.
- The Go toolchain and GOMAXPROCS are named with their sources/absences rather than measured.
- The README's "profile-driven fix" table (local Windows/arm64 before/after numbers) is a **local
  engineering baseline**, not part of the paired artifact; the gate does not validate it and it is
  labelled local in the README.
- The gate checks the recorded surfaces it knows; it does not validate free-form prose beyond the
  numbers it recomputes, and it does not perform the M7 accessibility/contrast audit.
