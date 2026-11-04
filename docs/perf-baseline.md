# Performance baseline and the evidence gate

**One artifact is the source of truth for the README performance table, the two figure variants
(`docs/assets/benchmark.svg` for dark GitHub and `docs/assets/benchmark-light.svg` for light) and
`docs/assets/benchmark.svg.provenance.md`.** This document records the current baseline, the unit rule, the
method and its limits, the current metric/workload coverage, and the procedure that replaces the baseline.
`tools/check-perf-docs.mjs` enforces the agreement in CI (`ci.yml#verify`, step "Verify the performance
evidence matches the recorded artifact"); no number in those surfaces may exist only as prose.

This is M2a of the engineering ladder (`GOAL.md` §11): the evidence gate first, so that the M2 scale
benchmarks and the M7 figure restructure cannot ship numbers the repository cannot check. M7 later added the
second (light) figure variant and the first-screen structure checks to the same gate; no measured value was
added by that change.

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

## 4. Where the numbers live (deliberately not restated here)

This document records the baseline's IDENTITY and its method; it does **not** restate the four performance
numbers or the soak drift values, because a second hand-copied table is the defect class this gate exists to
remove (the alpha.13 tag tree's README RSS row drifted from the run it cited precisely because the numbers were
retyped). The numbers live in exactly two kinds of committed surface, both recomputed from `report.summary` and
`report.soak` by `tools/check-perf-docs.mjs`:

- the README Performance table and paragraph, plus the first-screen figure's alt text (the README no longer keeps
  a second mini-table; the first screen has the figure and the detailed section has the text table);
- `docs/assets/benchmark.svg` and `docs/assets/benchmark-light.svg`, both regenerated from the artifact and
  byte-compared in CI.

The unit rule those surfaces use is stated in §2; the identity a new baseline must match is in §1 and §8.

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
2. **this document's identity only** — run id, full commit, rounds/requests, CPU/RAM and the unit rule; §4
   deliberately does not restate the performance numbers, and the gate fails if a measured value is added
   back here (a second hand-copied table is the defect class), while the §7 teeth section is exempt because
   it quotes the gate's own observed failure strings;
3. README **first screen**: it must be delimited by the `## Release status` heading, reference BOTH figure
   variants through a `<picture>`/`prefers-color-scheme` pair, carry the shortest install+start commands for
   Linux/macOS and Windows, link the detailed sections, state the synthetic scope of the evidence and the unmet
   strong drop-in claim (`GOAL.md`, "not met", "synthetic" in the same place as the claim), and hardcode no
   GoTavern release version. The figure's alt text is a number surface too, so its four pinned values, four
   GoTavern values and four computed ratios are recomputed from the artifact and must appear in it. The whole
   README is also refused if it claims perfect compatibility;
4. README table: cold start, RSS, `/version` (median + p95), `/` — recomputed from `summary.*` under
   the decimal-MB rule, for **every** occurrence of the four rows (the first screen no longer carries a
   second mini-table; the Performance table is the text surface, with its "How it was measured" column
   checked against the artifact's sample counts);
5. README prose: cited run id and short commit; soak drift values (`−1.6 MB`, `+0.32 ms`, `+0.41 ms`)
   recomputed from `soak[]`; the decimal-MB unit rule stated once in the section;
6. provenance: run id, full commit, runner image, rounds, request count, soak description, the decimal-MB
   unit statement (including that the unit is stated on the row), both figure filenames, the shared 1200 x
   675 canvas, the contrast audit, the 12 px type floor, and an update procedure that regenerates both
   variants (`--out-light`);
7. the figures: `tools/benchmark-svg.mjs` regenerated from the committed baseline into temp files **twice**
   (determinism), both variants byte-compared with the committed `docs/assets/benchmark.svg` and
   `docs/assets/benchmark-light.svg`; the generator must contain no hardcoded release version or measured
   commit (the pinned oracle commit is the one allowed literal); each figure must be 1200 x 675 with a matching
   viewBox, carry `role="img"`, `<title>`, `<desc>`, the per-metric `faster`/`lighter` verdicts in both the
   drawing and the description, the decimal-MB row note, the run id and short commit, the derived-ratio marks,
   no external font/image/script/network reference, and **no declared type size below 12 px at 1:1**. The
   generator additionally refuses to render when its own WCAG contrast audit is below threshold, so the gate
   inherits that refusal as a red.
Teeth, observed locally on 2026-11-03 (each mutation was applied to a COPY, the gate run against the copies, the
file restored by copy, and the restore verified by SHA-256; the restored tree is green):

| mutation | gate output (first problem, observed 2026-11-03 on copies) |
|---|---|
| README performance row `11,522` → `11,523` | `readme.md:162: row "Cold start to first `/version` 200": pinned cell is "11,523 ms", the artifact gives "11,522 ms" (report.summary.*.bootMsMedian (11522 / 213))` |
| baseline copy `bootMsMedian` `11522` → `11523` | `readme.md:162: row "Cold start to first `/version` 200": pinned cell is "11,522 ms", the artifact gives "11,523 ms" (report.summary.*.bootMsMedian (11523 / 213))`, then the dark and light SVG byte diffs |
| committed dark SVG `11,522 ms` → `11,523 ms` | `dark.svg:3: differs from the dark figure regenerated from ...: expected "<desc ... 11,522 ms ...", committed "<desc ... 11,523 ms ..."` |
| committed light SVG `39.5 MB` → `39.6 MB` | `light.svg:3: differs from the light figure regenerated from ...` (the pair cannot disagree) |
| first-screen honesty sentence `is not met yet` → `is met` | `readme.md: first screen: does not contain "not met" (must state that the strong drop-in claim is not met yet)` |
| figure alt text `213 ms` → `214 ms` in a README copy | `readme.md: first screen: figure alt text does not carry "213 ms" recomputed from report.summary.*.bootMsMedian; a hand-copied number in the first screen can drift from the recorded artifact` |
| `<picture>` element removed from a README copy | `readme.md: first screen: has no <picture> element, so the figure cannot be the one image of the first screen` |
| type floor lowered to 11 px in a generator copy (both figures regenerated) | `dark.small.svg:12: dark figure: declares a 11px type size; the minimum at 1:1 is 12 px` |

Every mutation was applied to a COPY in a scratch directory, the gate run against the copies with its
`--readme/--svg/--svg-light/--generator/...` overrides, and the copy restored from a pristine file copy before the
next mutation; the restored tree ran green, and the SHA-256 of every real file in the repository was identical
before and after the whole sequence (the repository itself was never mutated).

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
4. Regenerate BOTH figure variants from the new baseline in one run:
   `node tools/benchmark-svg.mjs --report tests/perf/q22-baseline.json --out docs/assets/benchmark.svg --out-light docs/assets/benchmark-light.svg`
   (the generator reads the wrapper's provenance for the run id and commit; two runs must be byte-identical, and
   one run writes the pair so the variants cannot disagree).
5. Update the README table/prose and the provenance run/commit/rounds/soak fields to the new numbers, and the
   first-screen alt text if a number changed there.
6. `node tools/check-perf-docs.mjs` must be green; commit the baseline, both figures, the README, the
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
  numbers it recomputes, and it does not judge the picture's aesthetics.
- **The M7 accessibility audit is computed, and it is a generator property, not a second hand-copied table.**
  The generator measures WCAG contrast from its own palette constants and refuses to render when a text pair is
  below 4.5:1 (bar fills 3:1), and the gate checks the committed SVGs for a 12 px type floor. The recorded ratios
  in `docs/assets/benchmark.svg.provenance.md` are a restatement of that computed output for reviewers; they are
  not a gate input. Device-specific rendering (font fallback on a machine without the declared system families,
  GitHub's own image downscaling on a narrow viewport) is not checked — the 420/640 CSS-px renders taken during
  M7 show the 16:9 figure scaling below comfortable reading size, which is why the text table stays under the
  figure. Both figure variants were rendered to PNG at 1x for visual review; that render is a review artefact and
  is not committed.
