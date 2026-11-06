# M5 measurement plan - same-input before/after, the two missing rows, and the evidence the Lead dispatches

**Status: M5 PREPARATION. No benchmark has been dispatched in this task; no product code changed; no
committed baseline was edited.** Local evidence in this change is compilation/validation of a new
measurement harness only (??5.1). Before values are the committed alpha.15 baseline and the alpha.16 M0
records; after values do not exist yet and are the Lead's dispatches (??6).

Reads: `docs/alpha16-agent-execution-plan.md` ??7 (line 121), `docs/alpha16/baseline/README.md` (the M0
"before" record and the L-H1 closure), `GOAL.md` ??15.1-15.2, `tests/perf/README.md`,
`.github/workflows/bench-profiles.yml`, `.github/workflows/smoke-metrics.yml`,
`.github/workflows/third-party-extension-compat.yml`, `.github/workflows/longlived.yml`,
`tests/perf/bench-baseline.txt`, `tests/perf/q22-baseline.json`, `scripts/a15-bench-suite.mjs`.

The governing sentence is plan ??7: *"Run same-input before/after metrics on the same runner and revision
family - Report **both** improvements and regressions (alpha.15 repeat card cache improved but cold request
+21%). No performance work is complete when it improves a synthetic headline but degrades a common user
journey or changes the model-facing bytes. Derive candidate numerical thresholds from alpha.15 baselines and
run-to-run noise; record and justify thresholds before optimization, not after."*

---

## 1. The row contract (what makes a before/after admissible)

Every row below is one of four states:

| state | meaning |
|---|---|
| **EXISTING** | a committed workflow/job/row measures it today, with a comparison mechanism and a baseline to compare against |
| **EXISTING-HARNESS / UNWIRED** | the harness exists in the tree but no workflow/job/row runs it, or it has no committed baseline or gate |
| **GAP** | no harness measures it at all |
| **NEW ROW** | added by this task (`tests/perf/m5-eight-users.mjs`), execution is the Lead's dispatch |

Admissibility rules (all of them are already the repository's rules; a claim that skips one is not an M5
claim):

1. **Same subject bytes.** The binary under test is the one the before/after is about (built by the
   workflow's own step, `CGO_ENABLED=0 -trimpath`), not a local rebuild. `docs/perf-baseline.md` ??9 and
   ??10.2 record the precedent.
2. **Same runner family.** `scripts/bench-profiles.mjs` refuses a different goos/goarch/Go
   version/GOMAXPROCS/runner-image label (`tests/perf/README.md:44-47`, `:86-89`). The image *version* rotates
   weekly and is recorded, not compared (`tests/perf/README.md:88-89`). A before/after pair that straddles a
   rotation is **not comparable** and must be re-taken.
3. **Same input.** Fixtures are deterministic generators (`internal/server/bench_test.go`,
   `tests/perf/fixturegen`, `tests/perf/m5-eight-users.mjs`). A change to an input is a baseline-regeneration
   event, not a performance result.
4. **Narrowing is cost control.** A narrowed oracle run proves nothing about probes that did not run; the
   same applies here: a row that was not executed is **UNPROVEN**, never "unchanged"
   (`docs/development-loop.md:63-66`).
5. **Thresholds are recorded before the optimization** and committed in the change that starts M5 work
   (plan ??7; `GOAL.md` ??15.2). A threshold chosen after seeing the result is not a threshold.

---

## 2. The measurement matrix (plan ??7's nine required metrics)

"Workflow/job" is the exact dispatch target; "field" is where the number lives inside the artifact.

| # | required metric | today | workflow / job / artifact / field | before/after mechanism | alpha.15 has a baseline? | tolerance | state |
|---|---|---|---|---|---|---|---|
| 1 | cold + warm boot | measured | `GoTavern smoke metrics` / `measure-linux-amd64` / `smoke-metrics` ??' `smoke-metrics.json` `startup.cold.startToVersionMs`, `startup.warm.startToVersionMs` (`scripts/smoke-metrics.mjs:212-266`; `:346` marks the cold row ASSERTED) | two dispatches (before/after), same runner label+version; cold ceiling 60 s is the only asserted threshold; every other number reported | **yes**: alpha.16 M0 record run `42160114658` at `c8472c1` = 917.25 ms cold (includes fresh-install seeding) / 29.22 ms warm (`docs/alpha16/baseline/README.md:146-147`); alpha.15 paired record run `42012475880` at `f1396ce` (`tests/perf/q22-baseline.json` `provenance.runId`) | cold ceiling 60 s (existing); warm ??? +50 % provisional (??3.2) | EXISTING |
| 2 | 100 / 1,000 / 10,000 cards | measured in-process | `GoTavern bench profiles` / `bench-profiles-linux-amd64` / `bench-profiles` ??' `comparison.txt` rows `BenchmarkCharactersAllScale/{cards_100_128KB_image,cards_1000_32KB_image,cards_10000_4KB_image,cards_100_640KB_image}` (`tests/perf/README.md:15`) | **the comparison gate itself**: current medians vs committed `tests/perf/bench-baseline.txt`; two-sided per metric, fail-closed (`scripts/bench-profiles.mjs:379-383`) | **yes**: baseline regenerated deliberately at `05479fa` after the alpha.15 card cache (`tests/perf/bench-baseline.txt` header; `docs/alpha16/baseline/README.md:182-192`) | ns/op ??60 %, B/op ??15 %, allocs/op ??15 % (`scripts/bench-profiles.mjs:73-77`) | EXISTING (in-process). Process-level: EXISTING-HARNESS/UNWIRED (`scripts/a15-bench-suite.mjs --mode scale`, `:25-27`, `:802`) |
| 3 | large JSONL chats | measured in-process | same job/artifact: `BenchmarkChatSummary/chats_{10_x_2MB,100_x_256KB,1000_x_16KB}`, `BenchmarkChatsRecent/...` (`tests/perf/README.md:16-17`) | same comparison gate | **yes**: same committed baseline | same | EXISTING (in-process); process-level UNWIRED |
| 4 | 20-extension page load | measured, not gated | `Third-party extension compatibility` / `overhead` job (dispatch `mode=full` or schedule only) ??' `extension-compat-overhead` ??' `extension-overhead.mjs` conditions `gotavern-clean/gotavern-20/pinned-clean/pinned-20` (bootMs, RSS, `/version` p50, browser time-to-settings-ready, all-20 asset-load moment) (`tests/browser/extension-overhead.mjs:1-35`; `.github/workflows/third-party-extension-compat.yml:630-707`). The all-20 page load with send/cancel/reload is the `corpus` job (`:448-539`), the long-run version the `soak` job (`:541-624`) | two dispatches, four conditions each; no committed baseline; artifact is descriptive and asserts nothing (`extension-overhead.mjs:13-24`) | **no**: no committed baseline, not a release rail, artifact retention 30 days | none (descriptive); proposed provisional ??3.2 | EXISTING-HARNESS / no gate |
| 5 | **8-user concurrent writes** | **not measured**; correctness only | `tests/e2e/a15_concurrent_writers_test.go:1-17` = two processes, ONE user; `scripts/a15-bench-suite.mjs --mode concurrency` = 32/128 in-flight on ONE route as ONE user (`:836-910`); no record drives 8 accounts (`docs/alpha16/baseline/README.md:60-62`) | **NEW ROW**: `tests/perf/m5-eight-users.mjs` (??5.1). Before = first dispatch at the code-complete commit; after = second dispatch at the candidate commit | **no** (the M0 record names the gap; `settingsSaveMu` cross-user contention is an untested hypothesis, `internal/server/settings_save.go:50-75`) | provisional: route p95 ??? +25 %, error rate 0 (??3.2) | NEW ROW (implemented this task) |
| 6 | complex provider assembly | measured in-process | same bench job/artifact: `BenchmarkChatCompletionAssemble/{largest_recorded,scaled_1MB}` and `BenchmarkChatCompletionMarshal/{...}` (`tests/perf/README.md:21-22`) | same comparison gate | **yes**: same committed baseline | same | EXISTING (in-process). Real relay through `internal/outbound` under load: **GAP** (`docs/alpha16/baseline/README.md:64-65`) |
| 7 | streaming cancellation | **functional only** | functional gates: `Browser differential` streaming-framing legs + `Prove the framing gate has teeth` (`.github/workflows/browser-differential.yml:611-742`), oracle `stream-termination` fixture; **no TTFB / inter-frame / cancel latency metric anywhere** (`docs/perf-baseline.md:125` marks workload G `missing (performance)`) | none exists | **no** | none - propose TTFB/p95/cancel-to-idle as the first harness, but no number is invented here | GAP |
| 8 | 30-60 min soak | harness exists, unwired | `scripts/a15-bench-suite.mjs --mode soak --soak-minutes N --soak-rate R --data-route <route>` (mode at `:29`/`:990-1047`; usage `:151-160`). The only CI soak is q22's 10-minute `/version` soak in `smoke-metrics` / `paired-linux-amd64` (`docs/perf-baseline.md:160-211`), and the 30-minute all-20 browser soak in the `soak` job (`.github/workflows/third-party-extension-compat.yml:541-624`) | two dispatches of the same command; the artifact carries a per-15 s sample series so RSS drift and slope are computed from bytes | **no 30-60 min record** (`docs/alpha16/baseline/README.md:63`, `:167-168`) | provisional: RSS drift ??? +10 % of steady RSS and p95 drift ??? +25 %; no monotone growth across the last third (??3.2) | EXISTING-HARNESS / UNWIRED |
| 9 | extension-heavy boot (supporting row for #4/#8) | measured | `extension-overhead.mjs` conditions `-clean` vs `-20` for both subjects: `bootMs`, RSS, `/version` p50, time-to-settings-ready (`tests/browser/extension-overhead.mjs:25-35`) | same as #4 | no committed baseline | none (descriptive) | EXISTING-HARNESS |

Two rows are outside plan ??7 but are named by `GOAL.md` and the M0 baseline, so they must appear in the M5
document rather than be silently dropped: the **cold-guard row** (the committed bench baseline has no cold
arm; it lives in `scripts/a15-bench-p1-arms.mjs`, `docs/alpha16/baseline/README.md:66-69`, `:194-195`) and
**CPU/heap/block/mutex pprof + trace + benchstat** (pprof/trace exist in `bench-profiles` - 
`scripts/bench-profiles.mjs:3-12,431-500`; `benchstat` does not exist - `docs/perf-baseline.md:110`).

---

## 3. Thresholds (recorded before optimization)

### 3.1 In-process bench rows (rows 2, 3, 6) - ratified

These are already the gate's rules and are **unchanged**; M5 inherits them rather than inventing new ones:

| metric | tolerance | direction | why this number |
|---|---|---|---|
| `ns/op` | **??60 %** | two-sided | wall-clock on a shared runner moves with CPU steal; the observed same-tree spread of the regenerated baseline's first green comparison was **??'8.1 % - +1.6 %** across all 31 benchmarks (run `42165562517`, `docs/alpha16/baseline/README.md:186`); 60 % is ~7.4?- that spread, and the branch exists to catch "the benchmark stopped measuring the same work", not to police noise (`scripts/bench-profiles.mjs:69-77`, `:379-383`) |
| `B/op` | **??15 %** | two-sided | allocations do not move with CPU/kernel version (measured in the L-H1 analysis: `docs/alpha16/baseline/README.md:114`); 15 % is ~1.9?- the observed spread and remains tight enough that a real allocation change (the card cache moved B/op 181,622,014 ??' 41,035,550, ??'77.4 %) is unmissable (`:185`) |
| `allocs/op` | **??15 %** | two-sided | same argument; a missing column is a failure, not a skipped comparison (`tests/perf/README.md:55-56`) |
| a benchmark appearing / vanishing | fail | - | `tests/perf/README.md:60`; the self-test proves each class (`:69-75`) |
| host identity | fail (exit 2) | - | `tests/perf/README.md:66-67`, `:86-89` |

The M0 justification is therefore structural (B/op is deterministic per input) plus measured (the only
same-tree spread on record is ??8.1 %). **A speedup beyond ??60 % is a FAILURE, not a win**: it means the
benchmark now measures different work, and the response is a deliberate `--update-baseline` dispatch plus a
green comparison at the same tree - never a tolerance edit.

### 3.2 Product/process rows (1, 4, 5, 8) - PROVISIONAL, to be ratified after the M5 "before" run

These rows are "reported, not asserted" today (`docs/alpha16/baseline/README.md:79-80`), and the release
gate (smoke-metrics) asserts no performance number at all (M0 Lane E finding E-H2;
`scripts/smoke-metrics.mjs:403-405`). M5 needs a regression verdict, so the plan proposes thresholds now and
marks them **PROVISIONAL until two same-tree runs of each row exist**. The derivation uses the two records
the project already has at the same host family:

| observed spread between the alpha.15 record (`42012475880`, `f1396ce`) and the M0 record (`42160114658`, `c8472c1`) | value | `docs/alpha16/baseline/README.md` |
|---|---|---|
| steady RSS | 40,527,872 B vs 40,527,872 B (0 %) | `:158` vs `:162` |
| `/version` median | 0.429 ??' 0.379 ms (??'11.7 %) | `:159` vs `:148` |
| `/version` p95 | 0.516 ??' 0.596 ms (+15.5 %) | `:160` vs `:148` |
| `GET /` median | 8.59 ??' 8.026 ms (??'6.6 %) | `:161` vs `:149` |
| paired boot median | 161 ms vs 161 ms (0 %) | `:157` |
| 10-min soak RSS drift | ??'1,982,464 B | `:162` |

Proposed ceilings (regression only; an improvement is reported, ??4):

| row | metric | ceiling | derivation |
|---|---|---|---|
| 1 | cold start | **60 s** (existing, asserted) | `scripts/smoke-metrics.mjs:12-15`; a start this slow is a hang, not a slow runner |
| 1 | warm start | **+50 %** | warm boot is a thin path with high relative noise; four times the observed ??13 % latency spread |
| 1 | `/version` p50 / p95, `GET /` p50 | **+25 % / +30 % / +20 %** | ~2?- the observed per-metric spread (11.7 % / 15.5 % / 6.6 %) |
| 1 | steady RSS | **+10 %** | the only two same-family records are identical; 10 % leaves headroom for GC phase without hiding a real cache growth |
| 4 | 20-extension page readiness, boot, RSS | same as row 1, **plus** report the four-condition deltas verbatim | the harness computes `-20` minus `-clean` per subject; no earlier record exists, so the first two runs ratify |
| 5 | `settingsSave`/`settingsGet`/`chatsSave` p95 | **+25 %** per route | same latency family as row 1; ratified only after two same-tree runs of the row |
| 5 | error rate | **0** (correctness, always asserted) | a non-200 or a torn/interleaved file is a defect, not a slowdown |
| 8 | RSS drift over 30-60 min | **??? +10 % of steady RSS**, and the last-third slope must not be positive for two consecutive samples | the 10-min q22 record drifts ??'1.98 MB; the browser 30-min soak uses a broad 3?- guard (`.github/workflows/third-party-extension-compat.yml:541-544`), which is right for a shared runner |
| 8 | p95 drift | **??? +25 %** | same latency family |

**Ratification procedure** (must happen before any M5 optimization is judged): dispatch the row twice at the
SAME commit; if the two runs' deltas stay inside half the proposed ceiling, the ceiling stands; if not, widen
it to 2?- the observed spread and record both run ids. This is the M0 baseline's own rule
(`docs/alpha16/baseline/README.md:71-82`) applied to rows that had no baseline.

### 3.3 Where the thresholds live

- Rows 2/3/6: `scripts/bench-profiles.mjs:73-77` (already committed, already two-sided, already self-tested).
- Rows 1/4: this document + the M5 evidence document; no code change until ratified.
- Row 5: encoded in `tests/perf/m5-eight-users.mjs` as a **ceiling file**: `--thresholds-json <previous
  report>` derives each route's ceiling as `previous.p95 ?- 1.25` and fails by name
  (`threshold/<route>-p95`). With no previous report the row reports only and says so in
  `report.thresholds`. The first M5 run therefore produces the "before" file that the after run consumes.
- Row 8: the artifact carries the series; the verdict is written into the M5 evidence document until a gate
  exists.

---

## 4. Both-direction reporting (improvements AND regressions)

1. **A regression is reported as a regression.** Rows 2/3/6 fail closed (two-sided); rows 1/4/5/8 fail
   closed only against the ratified ceiling, and the evidence document must state any regression even when
   no gate would have caught it.
2. **An improvement is reported as an improvement, and it is not a free pass.** The alpha.15 precedent is
   the template: the identity-keyed card cache reduced repeat time by 17.4 % / allocations by 20.4 % but the
   **cold** first request became 21.1 % worse, and the release reported both halves
   (`docs/perf-baseline.md:303-315`). An M5 change that improves a headline while regressing a common
   journey is not complete (`plan ??7`).
3. **Never splice.** A before number from one runner image or commit family and an after number from another
   is two records, not a comparison (`GOAL.md` ??15.2; `docs/perf-baseline.md:210-216, 344-347`).
4. **Never move the baseline to turn red into green.** A legitimate observation change (a benchmark input or
   subject changed, or an accepted product change landed) is handled by the deliberate
   `inputs.update_baseline=true` dispatch, the `bench-baseline-candidate` artifact, a normal green comparison
   after committing it, and a commit that says why the observation changed
   (`docs/alpha16/baseline/README.md:174-192`; `.github/workflows/bench-profiles.yml:42-50`). A tolerance
   widening is never a remediation.
5. **Never hide a row in a narrowed run.** `bench-profiles` runs with explicit `rounds`; the extension rows
   require `mode=full`; a row that did not run is UNPROVEN and must be listed as such in the evidence
   document (plan ??7's "report unexecuted combinations rather than treating them as green").
6. **Model-facing bytes are part of the verdict.** A performance change that alters the provider request is
   a compatibility change, not a speedup: the same change must keep `Browser differential` and the
   combination/whole-session gates green (plan ??7: "changes the model-facing bytes").

---

## 5. The two missing rows

### 5.1 8-user concurrent writes - IMPLEMENTED (`tests/perf/m5-eight-users.mjs`)

**Why a new harness.** No existing harness drives more than one *user*: the two-process correctness test
drives one user from two processes (`tests/e2e/a15_concurrent_writers_test.go:1-17`), and the process-level
suite's concurrency mode drives one route as one user with 32/128 in-flight
(`scripts/a15-bench-suite.mjs:836-910`). `settingsSaveMu` is a single mutex held across disk persistence
(`internal/server/settings_save.go:50-75`), so eight accounts writing is the exact contention shape the M0
audit flagged as untested (`docs/alpha16/baseline/README.md:60-62`; M0 Lane E E-H13).

**What it does.** Boots the shipped binary on a fresh data root with `enableUserAccounts: true`, creates
eight accounts through the product's own admin API (`POST /api/users/create`), logs each in through
`/api/users/login` with a real CSRF token + signed cookie (the frontend's three-step handshake), then issues
six waves of, concurrently across the eight accounts:

- `POST /api/settings/save` with a ~48 KiB document whose marker names account+wave,
- `POST /api/settings/get` (the load half),
- `POST /api/chats/save` with a per-account JSONL whose marker names account+wave.

Every request's wall time is recorded per route; after the waves it reads `<dataRoot>/<handle>/settings.json`
and the chat file and asserts each account's LAST marker is present, no other account's marker appears, the
files parse, and `settings/get` serves the account its own document. The report carries
p50/p95/p99/max/count/errors per route, throughput, provisioning time, environment provenance (commit,
binary sha256 + `version --json`, Go/Node/OS/CPU/RAM/GOMAXPROCS-with-reason, `--load-label`), parameters,
thresholds source, and an explicit `unproven` array.

**What it deliberately does not do** (stated in the report and in the file header): delete/rename/import
(the E06 verbs beyond write/load/isolation are not in this row); a real provider; multi-process; and it
asserts **no latency threshold unless a previous report is supplied** (`--thresholds-json`), because the first
run of a new row has no noise estimate.

**Bounded, deterministic, self-cleaning, failing by name.** Bounded: 6 waves ?- 8 users ?- 3 routes = 144
requests, `--max-seconds 180` hard stop, 30 s per-request timeout. Deterministic: fixed handles, fixed
markers, fixed body size. Self-cleaning: `mkdtemp` under `os.tmpdir()` with a name-prefix guard before
removal; a boot failure kills the child before rethrowing (no orphan). Failing by name: every refusal is
`m5-8users/<check>`, e.g. `write/status/settingsSave`, `isolation/cross-user/<handle>`,
`provision/login/<handle>`, `boot/exited`, `bound/deadline`, `cleanup/guard`.

**Local validation performed in this task (no product, no CI):**

| evidence | command | result |
|---|---|---|
| syntax + self-test (pure logic, `percentile`/threshold/cleanup guard, then the SAME measurement code against an in-process contract stub, then three planted failures) | `node tests/perf/m5-eight-users.mjs --self-test` | **12/12 cases held, exit 0**; the planted cases are `write/status/settingsSave`, `isolation/read-own`, `provision/login/default-user`, each required by name |
| fail-by-name + red report still written + no orphan + no leftover temp dir | `node tests/perf/m5-eight-users.mjs --binary <node> --report <tmp>` (a non-GoTavern executable) | exit 1; report written with `ok=false`, `failure.check="boot/exited"`; 0 leftover `gotavern-m5-eight-users-*` dirs |
| usage refusals | no args; `--binary <missing>` | exit 2 with a named message, no work tree created |

The contract stub is **not** product evidence: it validates the harness's request sequence and its ability
to fail, and the report of a stub run says `mode: "product"` is absent. The product path itself is unexecuted
until the Lead dispatches it - that is this row's main residual risk (??8 R2).

**Dispatch (the Lead must add the job first - no workflow runs this harness yet):**

```bash
# after the workflow job builds a CGO_ENABLED=0 binary (same flags as smoke-metrics.yml:74-95)
node tests/perf/m5-eight-users.mjs \
  --binary "$PWD/.perf-bin/gotavern" \
  --report "$RUNNER_TEMP/m5-eight-users/report.json" \
  --users 8 --waves 6 --body-bytes 49152 --max-seconds 180 \
  --load-label "M5 before, quiet window: <who/what>"
# upload $RUNNER_TEMP/m5-eight-users as artifact `m5-eight-users-evidence`, then repeat at the AFTER commit
# with --thresholds-json <before report.json> to turn the provisional +25% into a named red.
```

Proposed job placement: a new `m5-measurements.yml` (jobs `eight-users`, `soak`, `scale`) or one extra job in
`bench-profiles.yml`. The Lead owns workflow writes; this document only fixes the command, the artifact name
and the parameters.

### 5.2 30-60 min soak - harness EXISTS, only wiring is missing (NOT implemented)

`scripts/a15-bench-suite.mjs --mode soak` already: boots a subject on a deterministic tree, handshakes, warms
up outside the series, drives sustained mixed load at `--soak-rate` for `--soak-minutes`, samples process
facts every 15 s (RSS/peak RSS/CPU/GC from `tests/perf/procstat`), and writes one artifact with the full
sample series and latency summary (`scripts/a15-bench-suite.mjs:990-1047`; usage `:151-160`). Child lifetime
is bounded on a hard deadline and the abrupt Windows stop is recorded rather than pretended graceful
(`scripts/a15-bench-suite.mjs:169-200`). The only missing pieces are a workflow job, a duration
above 10 minutes, and a threshold/evidence document:

```bash
node scripts/a15-bench-suite.mjs --mode soak --soak-minutes 45 --soak-rate 10 \
  --subject current="$PWD/.perf-bin/gotavern" \
  --out "$RUNNER_TEMP/m5-soak" \
  --load-label "M5 before/after soak, quiet window: <who/what>"
# artifact proposal: `m5-soak-evidence`; the series is the evidence, the drift is computed from it
```

No new code is added for this row: adding a second soak implementation beside the one that already samples
the process correctly would be a competing system (`GOAL.md` ??15.2 forbids that explicitly).

---

## 6. Dispatch commands and the run-id evidence the Lead must collect

### 6.1 Commands (workflow + job + input)

```bash
# rows 2, 3, 6 (in-process scale/JSONL/assembly) - BEFORE and AFTER, on the branch at that commit
gh workflow run bench-profiles.yml --ref <branch> -f rounds=3
#   job: bench-profiles-linux-amd64   artifact: bench-profiles
#   NEVER pass update_baseline for an M5 comparison run.
#   After an intended work change: dispatch with -f update_baseline=true ONLY to regenerate, download
#   `bench-baseline-candidate`, commit it WITH its raw run, then dispatch a normal comparison and keep both
#   run ids (the L-H1 precedent: 42164978648 regenerate, 42165562517 green comparison).

# rows 1 (cold+warm boot, paired Node-vs-Go) - BEFORE and AFTER
gh workflow run smoke-metrics.yml --ref <branch> -f requests=50
#   jobs: measure-linux-amd64, paired-linux-amd64
#   artifacts: smoke-metrics, q22-paired-benchmark

# rows 4, 8 (20-extension page load, 30-min browser/extension soak) - full dispatch, not sentinel
gh workflow run third-party-extension-compat.yml --ref <branch> -f mode=full
#   jobs: overhead (row 4 numbers), corpus (all-20 load), soak (30 min), and shard/aggregate for the
#   extension matrix. A `mode=sentinel` dispatch would NOT run any of them.

# row 5 (8-user) and a >10-minute process soak: no workflow job exists yet; the Lead adds it and runs
#   node tests/perf/m5-eight-users.mjs --binary <built binary> --report <json> --users 8 --waves 6 ...
#   node scripts/a15-bench-suite.mjs --mode soak --soak-minutes 45 --subject current=<built binary> ...
#   proposal: a new `m5-measurements.yml` with jobs eight-users / soak / scale, artifacts
#   `m5-eight-users-evidence` / `m5-soak-evidence` / `m5-scale-evidence`.

# supporting: process-level scale row (100/1k/10k cards, large JSONL) on the same new workflow
node scripts/a15-bench-suite.mjs --mode scale --subject current=<built binary> --out <dir>
```

Workflow-dispatch caveat, already measured by this repository: `workflow_dispatch` only fires for workflows
present on the default branch (`.github/workflows/browser-differential.yml:45-52`; the same measurement is recorded in
`.github/workflows/release-install-smoke.yml:76-85`). Every workflow above is already on `main`.

### 6.2 What a run-id record must contain (per row, per side)

Quote **workflow name + run id + conclusion together** - one commit produces several workflows and a bare
id is ambiguous (`AGENTS.md` rule 55). For every dispatch collect and paste into the M5 evidence document:

| field | source |
|---|---|
| workflow name, run id, conclusion | `gh run view <id> --json name,id,conclusion,event,headSha,createdAt` |
| `head_sha` and event | same |
| runner image label **and version** | `smoke-metrics.json` `host.runnerImage`, `host.runnerImageVersion`; `tests/perf/out/environment.txt` for bench-profiles |
| Go version, GOMAXPROCS, GOOS/GOARCH | `tests/perf/bench-baseline.txt` header for bench rows; `environment` block for the process rows |
| the artifact and its field | `gh run download <id> -n <artifact> -D <dir>` and quote the JSON field / `verdict.txt` line, never a retyped number |
| the dispatch inputs actually used | the command line above (rounds, requests, mode=full, users/waves, soak minutes) |
| for rows 2/3/6: the comparison verdict | `verdict.txt` (`comparison: passed`, `failures: 0`), `comparison.txt` row-level deltas |
| for row 1: the numbers | `smoke-metrics.json` `startup.*`, `memory.*`, `latency.*`; `q22-paired-benchmark.json` `summary.*`, `soak[]` |
| for row 5: the row's own report | `report.json` `results.routes.*.p95`, `throughputOpsPerSec`, `ok`, `failure.check` |
| for row 8: the series | `soak-*.json` `results[].samples[]`, `rssDriftBytes`, `latencyMs` |

**Compatibility rule for the pair:** the before and after records must agree on runner image *label*,
Go version and GOMAXPROCS; if the image *version* moved, mark the pair NOT-COMPARABLE and re-take the before
run (`tests/perf/README.md:86-89`). The before/after commits may differ (that is the point) but each side must
be same-SHA for its own dispatch.

### 6.3 What a clean M5 evidence document contains

1. **Identity:** before commit, after commit, pinned oracle, Go toolchain, `CGO_ENABLED`/build flags, runner
   image label + version, GOMAXPROCS, `--load-label` (a shared host is never silently a quiet host).
2. **Thresholds, recorded first:** a copy of ??3 with the ratification status for each provisional row and the
   run ids that ratified it.
3. **The matrix, one row per metric:** before value (artifact field + run id), after value (artifact field +
   run id), delta, direction, verdict ??? {improvement, regression, no-change, UNPROVEN}, and the noise band
   used. No number appears without its artifact field.
4. **Both-direction statement:** every regression named; every improvement named with the metric and the
   trade-off (`GOAL.md` ??15.1: which condition it speeds up, what it costs).
5. **Compatibility statement:** the model-facing bytes and the differential gates on the same commit (a
   performance change that moved provider bytes is a compatibility finding).
6. **Unexecuted rows:** each named with the reason (narrowed dispatch, harness missing, environment
   unavailable) - never implied green.
7. **Raw artifact locations** (run id + artifact name + retention) and a statement that the numbers are a
   summary of the artifacts, not the artifacts.
8. **Residual risk/UNPROVEN list** (??8).

---

## 7. What M5 must not do (from the same rules that bind this prep)

1. Do not rewrite a benchmark to make it cheaper (`GOAL.md` ??15.2: a competing measurement system is not
   created; the tools are the ones the repository owns).
2. Do not regenerate `tests/perf/bench-baseline.txt` to hide a regression or to make a speedup green; only a
   deliberate regeneration followed by a normal comparison, with both run ids and the reason
   (`docs/alpha16/baseline/README.md:174-192`).
3. Do not widen a tolerance or delete a benchmark to get green (`AGENTS.md` rule 32; the self-test would have
   to be changed too, which is the red flag).
4. Do not compare across hosts, GOOS/GOARCH, Go versions, GOMAXPROCS or runner-image versions.
5. Do not change product code in this prep: M3's fix is a separate, gated change; this task only prepared the
   instrument.

---

## 8. Residual risks and UNPROVEN items

| # | risk / item | why it is not closed now | who/what closes it |
|---|---|---|---|
| R1 | **Every M5 number is CI-only.** The development host is Windows/arm64 and is not a comparison host (`docs/alpha16/baseline/README.md:17-19`); `bench-profiles` refuses a different host; q22 reads `/proc`. | No CI dispatch is allowed in this task. | Lead's dispatches (??6). Local numbers stay `LOCAL-ONLY (Layer A)` and are never spliced. |
| R2 | **The 8-user row's PRODUCT path is unexecuted.** Locally it was validated against the contract stub only (12/12 self-test) and against a non-GoTavern binary for fail-by-name; the real account/login/CSRF/write path has not run. | No product boot allowed in this prep. | The first Lead dispatch. If it fails, the failure is named (`provision/*`, `boot/*`, `write/*`) and localisable. |
| R3 | **The 30-60 min soak has no workflow row.** The harness exists and samples correctly, but no job runs it. | Workflow writes are not in this task's scope. | Add `m5-measurements.yml`/job (??5.2) and dispatch before/after. Until then the 30-60 min requirement is **CI-PENDING**, exactly as M0 recorded (`docs/alpha16/baseline/README.md:63,167-168`). |
| R4 | **The 20-extension page load has no committed baseline and no gate.** The `overhead` job asserts nothing by design (`tests/browser/extension-overhead.mjs:13-24`) and runs only on `mode=full` dispatch/schedule. | Baseline/threshold decision belongs to the Lead; a baseline artifact would need the recorder pattern (`tools/record-perf-baseline.mjs`). | Ratify ??3.2 from two `mode=full` dispatches; then wrap the artifact like `q22-baseline.json`. |
| R5 | **Streaming cancellation has no performance harness at all** (functional gates only; `docs/perf-baseline.md:125`). | Designing TTFB/inter-frame/cancel-to-idle needs a provider peer that streams slowly - that is a new harness, not a threshold. | M5/M6 harness decision; UNPROVEN until then. |
| R6 | **Provider relay p99 under load is unmeasured**; the bench rows are in-process assemble/marshal, not a relay through `internal/outbound` (`docs/alpha16/baseline/README.md:64-65`). | Same reason as R5. | UNPROVEN. |
| R7 | **The committed bench baseline has no cold-guard row** (`docs/alpha16/baseline/README.md:66-69,194-195`). | Adding it requires a deliberate baseline regeneration on the Linux host. | Regenerate via `update_baseline` + green comparison; the cold arm currently lives in `scripts/a15-bench-p1-arms.mjs`. |
| R8 | **The release gate cannot back a performance claim.** `GoTavern smoke metrics` asserts only four structural properties and no performance number (M0 Lane E E-H2; `scripts/smoke-metrics.mjs:403-405`), and it is not a gate on rows 2-6. | Changing the release manifest/gates is a separate decision with its own evidence. | If M5 is to be release evidence, add a same-SHA performance gate only after the thresholds are ratified and a planted regression is observed red. |
| R9 | **`benchstat` is missing** (`docs/perf-baseline.md:110`); `bench-profiles` compares medians itself with per-metric tolerances. | Adding benchstat is a harness change in `scripts/` (outside this task's write scope). | Proposed in M5: `-count 5` + `benchstat` output as an artifact; until then the median comparison is the record. |
| R10 | **Provisional thresholds can be wrong in both directions.** They are derived from two records on the same host *family* but different image versions, and the boot metric is known to vary widely (160/935/213 ms in one artifact; `docs/perf-baseline.md:212-216`). | Only repeated same-tree runs give the row's own noise. | The ratification procedure in ??3.2 (dispatch twice at one commit; widen to 2?- the observed spread if needed). |
| R11 | **E06's remaining verbs (delete/rename/import) are still correctness-only**, not measured. | The 8-user row covers write/load/isolation cost. | Add weighted verb mixes later; UNPROVEN for cost. |
| R12 | **The 8-user row measures one server process**, so cross-PROCESS contention is out of its scope (covered by `a15_concurrent_writers_test.go` for correctness, not cost). | Two measurements for two questions; combining them would conflate process and account contention. | UNPROVEN for multi-process cost. |
