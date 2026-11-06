# M5 evidence — same-input before/after, the two new rows, and what remains unproven

**Status: M5 EVIDENCE RECORD. Documentation only. No dispatch was made for this document, no product code
changed, no committed baseline was edited, and no git operation was run.** Every number below was read out of
a downloaded CI artifact with `gh run download`; the artifacts are the record and this file is their summary.
No local (Windows/arm64, Layer-A) number appears anywhere in a CI claim — the plan's local numbers
(`docs/alpha16/m5-measurement-plan.md` §5.1, §8 R1) are deliberately not used.

Read at lane `2e36302` (2026-11-06). Governing plan: `docs/alpha16/m5-measurement-plan.md` (section 7 matrix,
thresholds, both-direction rule); "before" record: `docs/alpha16/baseline/README.md` §8-§9.

## 0. Run identities, artifacts and comparability

Every row quotes **workflow name + run id + conclusion** together (`AGENTS.md` rule 55).

| # | row | workflow | run | conclusion | event | headSha | artifacts (retention 30 d) |
|---|---|---|---|---|---|---|---|
| 1 | 100/1k/10k cards, large JSONL, provider assemble/marshal | **GoTavern bench profiles** | **42200357353** | **completed / success** | workflow_dispatch | `0` | `bench-profiles` |
| 2 | cold + warm boot, `/version` + `/` latency, RSS, fresh install | **GoTavern smoke metrics** | **42200361137** | **completed / success** | workflow_dispatch | `0` | `smoke-metrics`, `q22-paired-benchmark` |
| 2b | the same row's M0 "before" record | **GoTavern smoke metrics** | **42160114658** | **completed / success** | workflow_dispatch | `c` | `smoke-metrics`, `q22-paired-benchmark` |
| 3 | 8-user concurrent writes (BEFORE) | **M5 measurements** | **42212715040** | **completed / success** | workflow_dispatch | `2` | `m5-eight-users-evidence` |
| 4 | 30-60 min soak (first attempt) | **M5 measurements** | **42209244735** | **completed / failure** | workflow_dispatch | `6` | `m5-soak-evidence` |
| 4b | 30-60 min soak (re-run) | **M5 measurements** | **42226780977** | **CI-PENDING — status `in_progress`, job `soak` `in_progress` at 2026-11-06T13:47Z** | workflow_dispatch | `2` | (none yet) |
| — | first 8-user dispatch (pre-readiness-fix; context only, **not evidence**) | **M5 measurements** | **42209241061** | **completed / failure** | workflow_dispatch | `6` | — |

Reproduce (any reader must be able to re-derive this file rather than trust it):

```bash
for id in 42200357353 42200361137 42160114658 42212715040 42209244735; do
  gh run download "$id" -D "/tmp/m5-evidence/$id"
done
gh run view 42226780977 --json status,conclusion,jobs   # CI-PENDING check
```

**Runner family (plan §1 rule 2; `tests/perf/README.md:86-89`):** rows 1, 2 and 2b all ran on
`runnerImage ubuntu26`, `runnerImageVersion 20261101.186.1`, kernel `7.0.0-1019-azure`, 4 vCPU, Go
`go1.27.3 linux/amd64`, GOMAXPROCS `default(4)`. The bench baseline was recorded on the **same** image
label+version (`tests/perf/bench-baseline.txt:25-26`). The M0 smoke record and the new smoke record share the
image label AND version, so that pair is same-image; it is still two single runs on two shared-runner
instances, so absolute values stay runner-relative.

## 1. Rows 2/3/6 — in-process scale, large JSONL, provider assembly (`GoTavern bench profiles` run 42200357353, success)

### 1.1 Verdict from the artifact

`verdict.txt`: `mode: all`, `rounds: 3`, `bench selection: Benchmark`, **`comparison: passed`**, **`failures: 0`**.
The comparison is the current run (`0b577de`, clean tree, `environment.txt`) against the committed gate input
`tests/perf/bench-baseline.txt` (recorded `2026-11-06T04:52:04Z` at commit `05479fa…`, same runner image,
4 vCPU, clean tree). All **31** benchmarks are `PASS`; 26 moved faster, 5 moved slower or flat.

### 1.2 Both directions (deltas as printed in `comparison.txt`, verified by recomputing medians from `bench-current.txt` + the committed baseline)

Improvements (ns/op):

| benchmark | ns/op delta | B/op delta | allocs delta |
|---|---|---|---|
| `BenchmarkStaticPageLoad` | **-10.8%** | +0.0% | +0.0% |
| `BenchmarkChatCompletionAssemble/scaled_1MB` | **-6.8%** | -0.0% | +0.0% |
| `BenchmarkChatCompletionMarshal/scaled_1MB` | -3.7% | -0.0% | +0.0% |
| `BenchmarkCharactersAllScale/cards_1000_32KB_image` | -3.7% | -0.0% | +0.0% |
| `BenchmarkScriptJSCompressed` | -3.2% | -1.6% | +0.0% |
| `BenchmarkWorldInfoList/worlds_1000_x_8KB` | -3.2% | -0.5% | -0.3% |
| `BenchmarkChatSummary/chats_1000_x_16KB` | -3.1% | +0.0% | +0.0% |
| `BenchmarkCharactersAllScale/cards_100_128KB_image` | -2.9% | -0.2% | -0.0% |
| `BenchmarkChatSummaryLargeCharacters` | -2.4% | +0.0% | +0.0% |
| `BenchmarkCharactersAllScale/cards_10000_4KB_image` | -2.4% | +0.0% | +0.0% |
| `BenchmarkCharactersAllScale/cards_100_640KB_image` | -2.1% | -0.4% | -0.0% |

The remaining 15 faster rows are between 0% and -2.4% (e.g. `BenchmarkChatSummary/chats_10_x_2MB -1.7%`,
`BenchmarkWorldInfoList/worlds_50_x_128KB -1.6%`, `BenchmarkSettingsGetScale/files_per_dir_100 -1.2%`).

Regressions (`ns/op` positive only; every one is inside the two-sided tolerance):

| benchmark | ns/op delta | B/op delta | allocs delta |
|---|---|---|---|
| `BenchmarkFrontendIndex` | **+0.7%** | +0.0% | +0.0% |
| `BenchmarkFrontendAsset` | **+0.5%** | +0.0% | +0.0% |
| `BenchmarkChatCompletionAssemble/largest_recorded` | +0.2% | +0.0% | +0.0% |
| `BenchmarkManyFrontendAssets` | +0.1% | +0.0% | +0.0% |
| `BenchmarkChatCompletionMarshal/largest_recorded` | +0.0% | +0.0% | +0.0% |

Allocation columns: the largest `B/op` movement is `BenchmarkPageLoadGzip **+2.2%**`, then
`BenchmarkScriptJSCompressed **-1.6%**`; every other `B/op` delta is within ±0.5% and every `allocs/op` delta
within ±0.3%.

### 1.3 Tolerance check (ratified thresholds, plan §3.1)

| metric | ratified tolerance (two-sided) | observed max | result |
|---|---|---|---|
| `ns/op` | ±60% | 10.83% | PASS |
| `B/op` | ±15% | 2.18% | PASS |
| `allocs/op` | ±15% | 0.29% | PASS |

A missing or appearing benchmark also fails (`tests/perf/README.md:55-60`); the same 31 benchmarks appear in
both the baseline and the comparison. **A speedup beyond ±60% would itself be a failure** (it means the
benchmark stopped measuring the same work — plan §3.1); this run is far inside, so it is a genuine same-work
comparison, not a redefinition.

### 1.4 The alpha.15 repeat-card-cache precedent: what these artifacts show and do not show

The committed baseline **already contains** the accepted alpha.15 card-text cache. The baseline's own record
is `cards_100_640KB_image` B/op **181,622,014 → 41,035,550 (-77.4%)** and ns/op **97,246,124 → 27,743,964
(-71.5%)**, regenerated at `05479fa` (`GoTavern bench profiles` run 42164978648, then a green comparison at
`39cec62`, run 42165562517, `docs/alpha16/baseline/README.md:182-192`). This run's `cards_100_640KB_image`
rows are **-2.1% ns/op, -0.4% B/op** against that already-cache-included baseline — i.e. the cache win is *in
the baseline*, not re-earned here.

The **cold-request +21.1% half** of that precedent is **not in these artifacts**: there is no cold-request
benchmark row in the committed set (the baseline has no cold-guard arm,
`docs/alpha16/baseline/README.md:194-195`; plan §8 R7), so no artifact here can confirm or refute it. The only
record of that half is the prose precedent in `docs/perf-baseline.md:303-315` (repeat -17.4%/allocations
-20.4%, cold first request +21.1% worse), quoted by plan §4.2. **Cold-request performance remains UNPROVEN for
this cycle.**

### 1.5 Artifact-shape caveats (read before quoting)

- `comparison.txt` prints `-` in its `ns/op base` and `ns/op cur` columns; only the deltas and verdicts are
  populated. The absolutes live in `bench-current.txt` (the raw three-round `go test -bench` output) and in the
  committed baseline; recomputing the 31 medians from those two sources reproduces every printed delta within
  0.15 percentage points (verified for this document).
- These are medians of **3** rounds of `go test -bench` on a shared 4-vCPU runner. There is **no `benchstat`**
  and no significance test (plan §8 R9; `docs/perf-baseline.md:110`), so a sub-percent delta is noise.
- Absolute values are runner-relative and are not a claim about user hardware; the gate's purpose is "the same
  work at the same scale", not a machine benchmark.

## 2. Row 1 — cold/warm boot and request latency (`GoTavern smoke metrics` run 42200361137, success) vs the M0 record (`GoTavern smoke metrics` run 42160114658, success)

Both sides were **downloaded as artifacts** (not retyped from prose); `docs/alpha16/baseline/README.md:138-151`
carries the same M0 numbers as its document record.

### 2.1 Numbers, both directions (new vs M0; negative = better)

| metric (artifact field) | M0 run 42160114658 (`c8472c1`) | new run 42200361137 (`0b577de`) | delta |
|---|---|---|---|
| cold start → `/version` 200, `startup.cold.startToVersionMs` | 917.248724 ms | **273.587419 ms** | **-70.2%** |
| cold start → listener, `startup.cold.startToListenMs` | 898.947702 ms | **192.016572 ms** | **-78.6%** |
| warm start → `/version` 200, `startup.warm.startToVersionMs` | 29.218082 ms | 26.909004 ms | -7.9% |
| warm start → listener, `startup.warm.startToListenMs` | 14.539719 ms | 15.206720 ms | **+4.6%** |
| `GET /version` median, `latency.version.medianMs` | 0.610684 ms | 0.767583 ms | **+25.7%** |
| `GET /version` p95, `latency.version.p95Ms` | 1.714889 ms | 1.958748 ms | **+14.2%** |
| `GET /version` max, `latency.version.maxMs` | 1.999135 ms | 3.909602 ms | **+95.6%** |
| `GET /` (734,837 B shell) median, `latency.root.medianMs` | 6.456961 ms | 7.963852 ms | **+23.3%** |
| `GET /` p95, `latency.root.p95Ms` | 14.273553 ms | 14.505310 ms | +1.6% |
| `GET /` max, `latency.root.maxMs` | 24.688544 ms | 19.311664 ms | -21.8% |
| RSS after cold boot, `memory.cold.rssBytes` | 38,215,680 B | 38,105,088 B | -0.3% |
| RSS after warm boot, `memory.warm.rssBytes` | 18,309,120 B | 19,320,832 B | **+5.5%** |
| fresh-install seeds, `freshInstall.files` / `.bytes` | 203 / 16,169,121 B | 203 / 16,169,121 B | **identical** |
| install staging, `install.filesAfterColdBoot` / `.bytesAfterColdBoot` | 27 / 98,910,141 B | 27 / 98,910,141 B | **identical**; warm−cold seeded delta 0 |

**Improvements:** cold boot is ~3.4x faster and cold-to-listener ~4.7x faster; warm start to version -7.9%;
cold RSS flat; fresh-install seeding byte-identical (a determinism win worth stating: the same 203 files /
16,169,121 bytes and the same 27-file staging footprint on both sides).

**Regressions:** `/version` p50 +25.7%, p95 +14.2%, max +95.6%; `/` p50 +23.3%; warm start-to-listen +4.6%;
warm RSS +5.5%. Two of these (the two p50s) are **above the provisional ceilings** proposed in plan §3.2
(`/version` p50 +25%, `/` p50 +20%) — but those ceilings are PROVISIONAL, derived from two *different-commit*
records on the same host family (plan §3.2, §8 R10), and this pair itself is one cross-commit pair, so these
are reported observations, not gate failures and not ratifications (see §6.3). The smoke-metrics gate asserts
only four structural properties and **no performance number** (M0 Lane E E-H2; plan §8 R8), so no gate would
have caught these either way.

### 2.2 Provenance and the runner-image caveat

| field | M0 42160114658 | new 42200361137 |
|---|---|---|
| `host.runnerImage` / `host.runnerImageVersion` | `ubuntu26` / `20261101.186.1` | `ubuntu26` / `20261101.186.1` |
| `host.kernel` | `7.0.0-1019-azure` | `7.0.0-1019-azure` |
| `host.cpuCount` / `host.totalMemoryBytes` | 4 / 16,759,439,360 | 4 / 16,759,435,264 |
| `host.nodeVersion` | v24.22.2 | v24.22.2 |
| `product.binaryBytes` | 62,640,288 | 62,640,288 |
| `product.versionEndpoint` | 1.19.0 / `06bde939f` / release | 1.19.0 / `06bde939f` / release |
| `host.sha` | `c8472c1…` (M0 record) | `0b577de…` (this run) |

The image **label and version match**, which is the plan's compatibility rule for a before/after pair
(`tests/perf/README.md:86-89`); the *commit* differs, which is the point of an after measurement. Caveat: one
run per side on shared-runner instances, so a ±10-25% latency delta at sub-10 ms scale cannot be separated
from runner noise without the two-run ratification in §6.3. The cold number includes first-run seeding of the
203 files (`docs/alpha16/baseline/README.md:146`, `:165-166`), so it is not the q22 `bootMs` measure.

### 2.3 What this row does and does not prove

Proven: cold/warm boot to `/version`/listener, `/version` and `/` latency distributions (p50/p95/max), RSS
after cold/warm boot, fresh-install and staging footprints, and the binary/version identity — all from one
same-image side. **Not collected: p99.** `scripts/smoke-metrics.mjs` records `medianMs`/`p95Ms`/`maxMs` (and
`firstMs`/`minMs`/`meanMs`) but **no p99 field** (`scripts/smoke-metrics.mjs:310` defines `p95Ms`; the artifact
schema has no p99 member), so p99 for
`/version` and `/` is **UNPROVEN/not collected** for both sides. The q22 paired Node-vs-Go artifact from both
runs was downloaded but is **not used** in this row set (paired comparisons are a separate record; plan row 1,
§2).

## 3. Row 5 — 8-user concurrent writes, BEFORE (`M5 measurements` run 42212715040, success)

**This is the row's BEFORE, not an after and not a gate.** It was dispatched with `which=eight-users`, so the
workflow's `soak` and `scale` jobs are `completed / skipped` in the same run and this run is **not** soak or
scale evidence. `report.thresholds` is `null` by design: the first run of a new row has no noise estimate, so
it asserts correctness only (plan §3.2 row 5; `tests/perf/m5-eight-users.mjs:60-69`, `:89`).

### 3.1 Identity and verdict

- `report.json`: `ok: true`, `failure: null`, `mode: "product"`, `surface: "m5-eight-users"`.
- `parameters`: users **8**, waves **6**, bodyBytes **49,152**, routes `/api/settings/save`, `/api/settings/get`,
  `/api/chats/save`, requestTimeoutMs 30,000, maxSeconds 180, stopMode `sigterm`.
- `results`: **144 operations** (8 x 6 x 3), `errorRate: 0`, `throughputOpsPerSec: 287.425`, `wallMs: 501`,
  `provisionMs: 5627` (account creation + login handshakes, outside the measured waves).
- subject: `bootMs: 221`, `pkgVersion: 1.19.0`, `versionRequiresLogin: true`, binary
  `sha256 3dc29318282d5006159b662a4`, 69,619,570 B.
- environment: commit `2b87703…`, `loadLabel: "alpha16-m5-before"`, Node v24.19.0, linux/x64, kernel
  `7.0.0-1019-azure`, 4 logical cores, Intel Xeon Platinum 8573C, 16,758,398,976 B RAM, `gomaxprocs: null`
  with the recorded reason that the subject was not given GOMAXPROCS so Go defaults to the runner CPU count.

**`bootMs` semantics:** it is the harness's wall clock from spawning the subject to the first successful
auth-aware readiness read — public `GET /csrf-token` plus the pinned version record read through the seeded
`default-user` admin session when the anonymous `GET /version` is gated
(`tests/perf/m5-eight-users.mjs:576`, `:620`, `:913`). It is **not** the product's own cold-start number and
not the smoke-metrics `startToVersionMs`.

**`versionRequiresLogin: true` is the pinned contract, not a boot failure.** With `enableUserAccounts: true`,
pinned mounts `requireLoginMiddleware` before `/version` and answers 403 anonymously
(`src/server-main.js:248`, `:272`; `src/users.js:1027-1030`), recorded in the oracle as
`unauthenticatedVersion` = 403 `"Forbidden"`; GoTavern reproduces it and the report's
`boot/auth-readiness` check states it (`plan §5.1`; `internal/server/http.go:612-614`,
`internal/server/accounts_test.go:196-201`).

### 3.2 Per-route latency (all inside the waves; count 48 each)

| route | count | min ms | p50 ms | p95 ms | p99 ms | max ms |
|---|---|---|---|---|---|---|
| `/api/settings/save` | 48 | 13.718 | **58.871** | **65.346** | **66.956** | 66.956 |
| `/api/settings/get` | 48 | 13.271 | **28.440** | **38.928** | **39.367** | 39.367 |
| `/api/chats/save` | 48 | 9.619 | **37.299** | **87.728** | **100.784** | 100.784 |

All eight accounts wrote their own last marker (wave 6) and no other account's marker; `settings.json` is
49,245 bytes for each account and each account's chat has 2 messages; the four checks are green:
`boot/auth-readiness`, `write/status` (144 requests, 0 non-200), `isolation/disk-and-cross-user` (8 accounts,
own markers present, no cross-user marker), `isolation/read-own` (8 accounts served their own document).

These are the numbers that a **provisional +25% per-route p95 ceiling** would be measured against on the AFTER
run (plan §3.2 row 5; §6.3). They are **not** thresholds today: the BEFORE report carries no threshold source.

### 3.3 The AFTER procedure (what turns this into a before/after row)

The BEFORE is this artifact (`m5-eight-users-evidence` from run 42212715040). The AFTER is a second dispatch of
the same workflow at the change under test, with the BEFORE run id supplied
(`.github/workflows/m5-measurements.yml:28-34`, input at `:79`, download at `:157-164`, fail-closed check at
`:166-178`, run at `:181-193`):

```bash
# AFTER: the change under test, same row, same parameters
gh workflow run m5-measurements.yml --ref <branch> \
  -f which=eight-users -f users=8 -f waves=6 \
  -f thresholds_from_run=42212715040 \
  -f load_label="M5 after, quiet window: <who/what>"
```

The job downloads run 42212715040's `m5-eight-users-evidence`, refuses by name if `report.json` is absent or
the BEFORE run was not `ok`, and passes `--thresholds-json`. The harness derives each route's ceiling as
previous p95 x 1.25 (`DEFAULT_THRESHOLD_TOLERANCE = 0.25`,
`tests/perf/m5-eight-users.mjs:89`, `:155`, `:1044-1054`) and fails closed by name (`threshold/<route>-p95`).
The AFTER report will then carry non-null `thresholds`, which is how the two artifacts are distinguishable.
**The AFTER does not exist yet: row 5 is BEFORE-only.**

### 3.4 Limits of this row (stated, not implied)

The subject is a CI-built `CGO_ENABLED=0 -trimpath` binary copied by the harness into a scratch install root;
the harness copies only the binary, so **tokenizer assets are absent** and tokenizer routes take the pinned
fallback — the three measured routes do not tokenize, so that is a limit, not a defect. The row is the
write/load/isolation **cost** row: **delete/rename/import are not driven** (E06 verbs beyond this row), one
server process only (multi-process cost out of scope), no real provider, and absolute numbers are
runner-relative. These limits are also recorded in the artifact's own `unproven` array.

## 4. Row 8 — 30-60 minute soak (`M5 measurements` run 42209244735, **failure**; re-run 42226780977 CI-PENDING)

### 4.1 Identity and the fail-closed verdict

- Job `soak`: `completed / failure`; `eight-users` and `scale`: `completed / skipped` (this dispatch selected
  the soak row only).
- Artifact `m5-soak-evidence`: `mode: soak`, batch 45 minutes, `loadLabel: alpha16-m5-soak`, subject
  `current` (GoTavern `0.0.0-dev`, sha256 `0743fa66…`, 69,619,570 B), commit `6077405…`.
- The workflow's fail-closed step wrote the verdict into the job log, verbatim:
  `m5-soak current: samples=180 lastThird=60 rssFirst=44486656 rssLast=49143808 slope=39.8 B/s drift=-8474624 min=45`,
  then `::error::m5-soak/rss-slope: current: last-third RSS slope is POSITIVE (+39.8 B/s, 44486656 -> 49143808 B)`
  and `::error::m5-soak/verdict: the soak is red (fail closed); re-run once on a quiet host before treating a
  small slope as a product signal` (the `Fail closed on the soak RSS slope` step,
  `.github/workflows/m5-measurements.yml:323-379`).

So the run is a **fail-closed red on the last-third RSS slope**, computed from the artifact's own 15-second
sample series. Every number below is from `soak-evidence.json`; the slope (39.83 B/s by least squares over the
last 60 samples) matches the job's printed +39.8 B/s.

### 4.2 The artifact numbers

| field | value |
|---|---|
| `payload.results[0].samples` | **180** samples at ~15 s spacing (~2,685 s = 44.75 min) |
| `requests` | **13,500** |
| `latencyMs` | count 13,500; min 22.010; median 27.703; **p95 34.906**; p99 38.202; max 116.078 |
| RSS first sample / last sample / overall drift | 49,799,168 B / 41,324,544 B / **-8,474,624 B (-17.0%)** |
| peak RSS (`peakRssBytes`) | **57,348,096 B** |
| last-third window RSS | 44,486,656 → 49,143,808 B; window min 33,570,816 / max 49,631,232 |
| GC (`gc`) | **6,699** GCs; pause sum 33,266.523 ms; last heap 16 MB → goal 11 MB |
| CPU (`cpu`) | user 269,860 ms, system 87,470 ms (~10.0% / 3.2% of one core over ~2,700 s) |

The honest shape of this red: the **overall** drift is negative (the process shrank by 8.47 MB over the run),
while the **last third** trends upward at +39.8 B/s. It is a slope signal, not (yet) a leak verdict.

### 4.3 The re-run: **CI-PENDING**

`M5 measurements` run **42226780977** (`headSha 2b87703…`, dispatch 2026-11-06T13:35:54Z) is **`in_progress`**
with job `soak` `in_progress` as of 2026-11-06T13:47Z. No artifact exists yet. **This document must not be
read as a soak verdict until that run completes**: if it is green, the pair is "one positive-slope red + one
flat/non-positive re-run"; if it is red again, the signal is repeatable at two commits and moves to
investigation. The re-run is at a **different commit** (`2b87703` vs `6077405`), so even a clean second run is
not a same-commit ratification (see §6.3).

### 4.4 The documented re-run rule (why one red is not a product finding)

The workflow's own verdict text encodes it: **a positive-slope red must be re-run once on a quiet host before
being treated as a product signal** (`.github/workflows/m5-measurements.yml:371-379`). This is the M5 plan's
soak ceiling too — "the last-third slope must not be positive for two consecutive samples" (plan §3.2 row 8) —
and consistent with the alpha.15 precedent where the 10-minute q22 soak drifted -1.98 MB with +0.5 ms p95
drift and was reported, not gated (`docs/alpha16/baseline/README.md:162-168`).

### 4.5 Rate semantics caveat (read the `requests` field, not the input)

The dispatch used `--soak-rate 10`, but the harness floors the inter-request interval at 200 ms
(`scripts/a15-bench-suite.mjs:1010`), so the achieved rate is ~5.0 rps: 13,500 requests over ~2,700 s. The
artifact's `requests: 13500` is the measurement; "10 rps" is not what ran. (The plan's command text says
`--soak-rate 10`, plan §5.2/§6.1; the artifact is authoritative about what happened.)

### 4.6 Provenance caveat: dirty working tree recorded

The a15 artifact's `environment.git` for run 42209244735 records `commit: 6077405…`, `branch: main`,
`dirty: true`, `dirtyFileCount: 1` (the harness counts `git status --porcelain` lines,
`scripts/a15-bench-suite.mjs:255-256`). The artifact does **not name** the dirty entry (UNPROVEN detail). The
workflow's checkout does create one untracked directory, `.perf-bin/` (the subject build output), and
`.gitignore` lists only `/.browser-bin/`, not `.perf-bin/` — so the most plausible single entry is that build
output, not a modified source file. Stated as a caveat, not as a claim: the soak's subject is a locally built
binary from `6077405` plus untracked build output, and the eventual release evidence must come from a
clean-tree dispatch of the same row.

## 5. Plan-section-7 matrix — every required metric, its evidence row, or a named GAP

| # | required metric (plan §2) | workflow / job / artifact field | state in this evidence set |
|---|---|---|---|
| 1 | cold + warm boot | **GoTavern smoke metrics** run **42200361137** (success), job `measure-linux-amd64`, `smoke-metrics.json` `startup.cold|warm.*`; M0 42160114658 (success) | **EXISTING, reported both directions** (§2); p99 UNPROVEN |
| 2 | 100 / 1,000 / 10,000 cards | **GoTavern bench profiles** run **42200357353** (success), `comparison.txt` `BenchmarkCharactersAllScale/*` | **EXISTING in-process, PASS**; process-level `scale` row exists in `m5-measurements.yml` but was **not dispatched → UNPROVEN** |
| 3 | large JSONL chats | same run, `BenchmarkChatSummary/chats_*`, `BenchmarkChatsRecent/chats_*` | **EXISTING in-process, PASS**; process-level UNPROVEN |
| 4 | 20-extension page load | Third-party extension compatibility `overhead` job (dispatch `mode=full`/schedule only), artifact `extension-compat-overhead` | **EXISTING-HARNESS / no gate / no baseline**, and **no M5 dispatch in this set → UNPROVEN** (plan §8 R4) |
| 5 | 8-user concurrent writes | **M5 measurements** run **42212715040** (success), `m5-eight-users-evidence/report.json` | **NEW ROW, BEFORE only** (§3); AFTER pending → **PARTIAL/UNPROVEN for the pair** |
| 6 | complex provider assembly | **GoTavern bench profiles** run **42200357353** (success), `BenchmarkChatCompletionAssemble|Marshal/*` | **EXISTING in-process, PASS**; real relay through `internal/outbound` under load is a **GAP** (plan §8 R6) |
| 7 | streaming cancellation | functional gates only (`Browser differential` streaming-framing legs) | **GAP — no performance harness, no TTFB/inter-frame/cancel metric** (plan §8 R5; `docs/perf-baseline.md:125`) |
| 8 | 30-60 min soak | **M5 measurements** run **42209244735** (failure, fail-closed slope) + run **42226780977** (CI-PENDING) | **EXISTING-HARNESS + wired; first run red signal, re-run CI-PENDING** (§4) |
| 9 | extension-heavy boot (supporting) | `extension-overhead.mjs` conditions `-clean` vs `-20` | **EXISTING-HARNESS, descriptive, no baseline → UNPROVEN (no gate)** |

Outside plan §7 but named by `GOAL.md`/M0 and therefore listed rather than dropped: **cold-guard benchmark
row** — absent from the committed baseline (lives in `scripts/a15-bench-p1-arms.mjs`,
`docs/alpha16/baseline/README.md:66-69`, `:194-195`) → UNPROVEN; **CPU/heap/block/mutex pprof + execution
trace** — present in the `bench-profiles` artifact (pprof files and trace, retention 30 d); **`benchstat`** —
does not exist (plan §8 R9) → no statistical comparison, medians only.

## 6. Thresholds

### 6.1 Ratified (in-process bench rows; unchanged by M5, recorded before any optimization)

| metric | tolerance | direction | source |
|---|---|---|---|
| `ns/op` | **±60%** | two-sided, fail-closed | `scripts/bench-profiles.mjs:73-77`, `:379-383`; plan §3.1:86,92-95 |
| `B/op` | **±15%** | two-sided | same; plan §3.1:87 |
| `allocs/op` | **±15%** | two-sided | same; plan §3.1:88 |
| missing/extra benchmark | fail | — | `tests/perf/README.md:55-60` |
| host identity (goos/goarch/Go/GOMAXPROCS/runner-image label) | fail (exit 2) | — | `tests/perf/README.md:66-67`, `:86-89` |

The justification is structural (B/op is deterministic per input) plus measured: the only same-tree spread on
record is -8.1% … +1.6% across all 31 benchmarks (`GoTavern bench profiles` run 42165562517,
`docs/alpha16/baseline/README.md:186`). This run's max movements (10.8% ns, 2.18% B/op, 0.29% allocs) are
inside the ratified bands, so the 31-row PASS is a same-work comparison. **A speedup beyond ±60% is a failure**
(it means the benchmark now measures different work), never a win (plan §3.1:93-95).

### 6.2 PROVISIONAL product/process ceilings (reported, not asserted; plan §3.2:97-126)

| row | metric | provisional ceiling | derivation in plan §3.2 |
|---|---|---|---|
| 1 | cold start | 60 s (existing, **asserted**) | a start this slow is a hang, not a slow runner (plan §3.2:118); default 60000 (`scripts/smoke-metrics.mjs:63`) |
| 1 | warm start | +50% | warm boot is a thin, noisy path |
| 1 | `/version` p50 / p95, `GET /` p50 | **+25% / +30% / +20%** | ~2x the observed alpha.15-vs-M0 per-metric spread |
| 1 | steady RSS | +10% | the only two same-family records were identical |
| 4 | 20-extension readiness/boot/RSS | same as row 1 **plus** verbatim four-condition deltas | no earlier record exists |
| 5 | `settingsSave`/`settingsGet`/`chatsSave` p95 | **+25% per route** | same latency family as row 1; ratified only after two same-tree runs |
| 5 | error rate | **0** (correctness, always asserted) | a non-200 or torn/interleaved file is a defect, not a slowdown |
| 8 | RSS drift over 30-60 min | **≤ +10% of steady RSS**, and the last-third slope **must not be positive** | the 10-min q22 record drifted -1.98 MB |
| 8 | soak p95 drift | **≤ +25%** | same latency family |

These are PROVISIONAL until the next section's procedure runs; nothing in this document turns one of them into
a gate. **The only performance number any current release gate asserts is the 60 s cold ceiling**
(`scripts/smoke-metrics.mjs:346` marks it ASSERTED; the plan records that the gate asserts no performance
claim, plan §8 R8).

### 6.3 The two-run ratification procedure and its current status

**Procedure (plan §3.2:128-131):** dispatch the row **twice at the SAME commit**; if the two runs' deltas stay
inside **half the proposed ceiling**, the ceiling stands; if not, widen it to **2x the observed spread** and
record both run ids. A pair that straddles a runner-image **version** rotation is not comparable and must be
re-taken (plan §1 rule 2; `tests/perf/README.md:86-89`).

Status by row — **no provisional row is ratified by this evidence set**:

| row | runs available | same commit? | ratification status |
|---|---|---|---|
| 1 (smoke) | 42160114658 (`c8472c1`) vs 42200361137 (`0b577de`) | **no** (same image label+version) | **NOT RATIFIED** — a cross-commit, same-image observation (§2); needs two dispatches at one SHA |
| 5 (8-user) | 42212715040 (`2b87703`) only | — | **NOT RATIFIED** — BEFORE-only; a second same-SHA BEFORE would ratify the ceilings |
| 8 (soak) | 42209244735 (`6077405`, red) + 42226780977 (`2b87703`, CI-PENDING) | no; one in progress | **NOT RATIFIED** — needs two completed same-SHA soaks |
| 4 (20-ext) | none in this set | — | **NOT RATIFIED, no baseline** |

What would ratify them (exact dispatches, same commit each):

```bash
# row 1: twice at the candidate SHA
gh workflow run smoke-metrics.yml --ref <branch> -f requests=50
gh workflow run smoke-metrics.yml --ref <branch> -f requests=50
# row 5: twice at the SAME SHA (a BEFORE and its repeat; the AFTER is a different commit by definition)
gh workflow run m5-measurements.yml --ref <branch> -f which=eight-users -f users=8 -f waves=6
gh workflow run m5-measurements.yml --ref <branch> -f which=eight-users -f users=8 -f waves=6
# row 8: twice at the SAME SHA
gh workflow run m5-measurements.yml --ref <branch> -f which=soak -f soak_minutes=45
gh workflow run m5-measurements.yml --ref <branch> -f which=soak -f soak_minutes=45
# row 4: two mode=full dispatches of the third-party workflow
gh workflow run third-party-extension-compat.yml --ref <branch> -f mode=full
```

Each pair must be recorded with both run ids in this document before any M5 optimization is judged.

## 7. UNPROVEN / GAP (explicit)

1. **Streaming-cancellation performance** — functional gates only; no TTFB, inter-frame or cancel-to-idle
   metric exists (`docs/perf-baseline.md:125`; plan §8 R5). UNPROVEN.
2. **Real provider-relay p99 under load** — the bench rows are in-process assemble/marshal, not a relay
   through `internal/outbound` (`docs/alpha16/baseline/README.md:64-65`; plan §8 R6). UNPROVEN.
3. **20-extension page load has no gate and no baseline** — `extension-overhead.mjs` is descriptive and
   asserts nothing (`tests/browser/extension-overhead.mjs:13-24`; plan §8 R4), and no `mode=full` dispatch is
   in this evidence set. UNPROVEN.
4. **8-user AFTER is not run** — only the BEFORE exists (run 42212715040); the +25% p95 ceiling is untested
   until a change under test is dispatched with `thresholds_from_run=42212715040` (§3.3). UNPROVEN/PARTIAL.
5. **Soak cross-run comparison is human-only** — the workflow fail-closes on a single last-third slope, but no
   gate compares drift or p95 across soak runs; the comparison lives in this document and one side is
   CI-PENDING (§4.3). UNPROVEN until 42226780977 completes and the pair is read together.
6. **No `benchstat`** — medians of 3 rounds, no significance test (plan §8 R9; `docs/perf-baseline.md:110`);
   sub-percent deltas are noise and are not claimed as wins. UNPROVEN as a statistical claim.
7. **Absolute numbers are runner-relative** — all rows ran on shared `ubuntu26 / 20261101.186.1` 4-vCPU GitHub
   runners; the comparisons are same-image but not same-instance, and nothing here is a claim about user
   hardware (plan §1 rule 2; §8 R10).
8. **8-user subject limits** — the harness copies only the binary, so tokenizer assets are absent (tokenizer
   routes take the pinned fallback; measured routes do not tokenize), and **delete/rename/import are not
   driven** (E06 verbs beyond this cost row); one server process only (§3.4; plan §8 R11-R12).
9. **`p99` for row 1 is not collected** — `smoke-metrics.mjs` records median/p95/max/mean, no p99; p99 for
   `/version` and `/` is UNPROVEN for both sides (§2.3). The task's requested p99 exists only for the 8-user
   and soak rows, where the harness records it.
10. **Process-level scale row (100/1k/10k cards and large JSONL through the real process) is not dispatched** —
    the `m5-measurements.yml` `scale` job exists (`:420-486`) but no run of it is in this evidence set; only the
    in-process bench rows exist. UNPROVEN.
11. **Cold-guard benchmark row is absent** from the committed baseline (plan §8 R7;
    `docs/alpha16/baseline/README.md:66-69`, `:194-195`); the cold-request half of the alpha.15 cache
    precedent cannot be confirmed from these artifacts (§1.4).
12. **The first 8-user dispatch (run 42209241061, failure at `6077405`) is not evidence** — it failed before
    the measurement at boot readiness (pre-fix harness; plan §5.1) and is listed only as context. The soak
    run's dirty-file identity is also UNPROVEN (`environment.git.dirtyFileCount = 1`, unnamed — §4.6).
13. **The q22 paired Node-vs-GoTavern artifact from runs 42200361137 and 42160114658 was downloaded but is not
    compared here** — this row set claims the single-subject smoke row only (plan row 1's paired baseline is
    alpha.15 run 42012475880). No paired claim is made.
14. **No local number is spliced** — the M5 plan's local Windows/arm64 Layer-A numbers (plan §5.1, §8 R1) are
    not used in any CI claim here; every number above came from `gh run download` of the run cited beside it.

## 8. Residual risks

1. **Single-run noise.** Rows 1 and 2 are one run per side; a ±10-25% sub-10 ms latency delta is within what a
   shared 4-vCPU runner can produce. The provisional ceilings are not ratified (§6.3), so the regressions in
   §2.1 are **reported, not adjudicated**.
2. **The soak red is a signal, not (yet) a verdict.** A negative overall drift (-8.47 MB) with a positive
   last-third slope (+39.8 B/s) is the shape that a GC phase or allocator growth can produce; the re-run rule
   exists for exactly this (§4.4) and the re-run is CI-PENDING (§4.3).
3. **The soak's effective rate is ~5 rps, not the requested 10** (§4.5); any comparison to a later soak must
   use the artifact's `requests`, not the dispatch input.
4. **Baseline-vs-current is not alpha.15-vs-current for every row.** The committed bench baseline was
   regenerated at `05479fa` **after** the alpha.15 cache, so the cache win is in the baseline (§1.4); the
   "before" for the bench row is the gate input, not the alpha.15 release binary.
5. **Artifact retention is 30 days** for every artifact cited (bench-profiles.yml:117/128,
   smoke-metrics.yml:194, m5-measurements.yml:228/414/533). This document is the durable summary; the
   artifacts remain the record and must be re-downloadable while they live.
6. **The 8-user BEFORE is at `2b87703`**, not at the eventual release candidate; the AFTER must be taken at the
   change under test, and each side is same-SHA for its own dispatch (plan §6.2) — a before from one commit
   and an after from another is the design of the row, not a splice, because the harness pairs its own
   within-run observations and the threshold comes from the BEFORE's own route p95s.
7. **No product code changed for this document.** The measured commits (`0b577de`, `2b87703`, `6077405`) are
   lane commits; this evidence does not re-claim the differential/compatibility gates for them (M5 is an
   instrument, not a product change). A performance change that also moved model-facing bytes would need the
   differential gates green and would be reported as a compatibility finding (plan §4.6).

## 9. What this document is, and is not

It is the M5 evidence **summary**: one row per required metric, each number traced to a workflow name + run id
+ conclusion and an artifact field, with improvements and regressions reported both ways, the thresholds and
their ratification status, and an explicit list of what is unproven. It is **not** the artifacts (they are the
record, retained 30 days and re-downloadable), not a release gate (the only asserted performance number in the
pipeline is the 60 s cold ceiling), and not a claim about user hardware — every number is runner-relative and
same-image only.
