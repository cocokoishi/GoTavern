# Performance and resource evidence

**Status: RELEASE DOCUMENT for alpha.19.** Every number below restates a committed artifact and is recomputed by `tools/check-perf-docs.mjs` in CI; the same-commit evidence is the `GoTavern smoke metrics` gate that `docs/release-manifest.json` requires at the alpha.18 candidate (the wave and its run ids are recorded in `docs/alpha18/same-sha-evidence.md`), and the perf-documentation checker is green at the candidate. The recorded paired baseline artifact this document restates is run `42012475880` at `f1396ce`, an ANCESTOR of the alpha.18 candidate (an artifact cannot name the commit that contains it); alpha.18's own card-scale and startup measurements are recorded in [`docs/alpha18/perf/`](alpha18/perf/README.md) and [`docs/alpha18/perf-hotspot.md`](alpha18/perf-hotspot.md), and alpha.20's fresh profile, baseline-reproduction and figure-check evidence is in [`docs/alpha20/perf/`](alpha20/perf/README.md). Rows labelled `UNPROVEN`/`REPORT-ONLY` are not claims at any status. The release-facing summary is the four-row table in [`README.md`](../README.md#performance) and the generated figure pair ([`benchmark.svg`](assets/benchmark.svg) dark, [`benchmark-light.svg`](assets/benchmark-light.svg) light); their shared provenance is [`benchmark.svg.provenance.md`](assets/benchmark.svg.provenance.md), and the one-commit baseline procedure is [`perf-baseline.md`](perf-baseline.md) §8.

This document exists because a README must stay short while the method behind its numbers must not disappear. It records the artifact identity, the method and its limits, before/after records, resource coverage, how to reproduce the record, and every row that is NOT proven. Nothing here is a second hand-copied table: the four headline values, the ratios, the p95s and the soak drifts are recomputed from the artifact, and a mismatch fails the build.

## 1. The recorded paired baseline

One GitHub Actions run measured both servers on one shared runner, from the same pinned checkout, with the same seeding and port allocator, in alternating rounds over a fresh `mkdtemp` data root per round. The downloaded artifact was recorded into the wrapper [`tests/perf/q22-baseline.json`](../tests/perf/q22-baseline.json) by `tools/record-perf-baseline.mjs`, which refuses a run/commit/runner mismatch between the two artifacts of the same run.

| field | recorded value |
|---|---|
| workflow / job | `GoTavern smoke metrics` / `paired-linux-amd64` |
| run id | `42012475880` (success, `workflow_dispatch`, `main`) |
| measured commit | `f1396cec6a26719501801846577f26d0cca0156b` (the code-complete commit this release's documentation descends from) |
| runner | `ubuntu26` `20261026.180.1`, Linux/X64, kernel `7.0.0-1017-azure`, 4 vCPU, 16,759,443,456 B RAM |
| Node (pinned subject) | `v24.22.1` |
| Go toolchain | `go.mod` directive `1.27.3`; the artifact does not record the toolchain, so this is named with its source rather than measured |
| build | `CGO_ENABLED=0`, `-trimpath`, `-ldflags="-s -w -X main.version=paired-42012475880"` |
| rounds / requests | 3 alternating rounds × 30 sequential requests per path |
| RSS sampling | `VmRSS` from `/proc/<pid>/status`, 2 samples per round after readiness and after 30 requests per path (60 per round); median of 6 samples per subject |
| latency samples | 90 sequential requests per path per subject (30 per round × 3 rounds) |
| soak | 2 × 10-minute windows, one per subject, 30 s sampling (20 samples each, both completed) |
| units | memory decimal MB, 1 MB = 1,000,000 bytes; every other number is milliseconds |
| raw artifact | Actions artifact `q22-paired-benchmark` of run `42012475880`, embedded verbatim under `report` |

The wrapper also carries the build flags, the host facts and what is **not** recorded (GOMAXPROCS is unset by the harness, so it defaults to the runner's 4 vCPU; the environment is named rather than invented). The recorded identity is `GoTavern smoke metrics` run `42012475880` at the full commit `f1396cec6a26719501801846577f26d0cca0156b`; [`docs/perf-baseline.md`](perf-baseline.md) is the method record, this document is the readable narrative and the explicit UNPROVEN ledger.

## 2. The four headline metrics

Same-machine, same-commit medians. The figure and the README table restate these cells; the gate recomputes each one from `report.summary.*`.

| Metric | Pinned Node SillyTavern | GoTavern | How it was measured |
|---|---|---|---|
| Cold start to first `/version` 200 | 14,515 ms | **165 ms** | median of 3 alternating rounds on ONE shared runner, fresh data root each round, no `config.yaml` |
| Steady-state RSS (`VmRSS` from `/proc`) | 915 MB | **40.5 MB** | median of 6 samples after readiness and 30 requests per path (60 per round) |
| `GET /version` latency | 65.55 ms | **0.429 ms** | median of 90 sequential requests (p95: 70.33 / 0.596) |
| `GET /` latency (HTML shell) | 13.78 ms | **8.59 ms** | median of 90 sequential requests; GoTavern's number includes gzip CPU |

Memory is decimal MB (1 MB = 1,000,000 bytes); every other number is milliseconds. The computed multipliers are 87.97x on cold start, 22.60x on steady-state memory, 152.9x on `/version` and 1.60x on `/`; they are derived from the two printed values, never typed in. The ten-minute soak per subject recorded GoTavern RSS drift `-0.1 MB` and p95 `+0.35 ms`, while pinned's RSS fell `-571 MB` from its startup peak and its p95 drifted `-3.29 ms` over the window.

**One cost is shown rather than hidden:** `/` carries gzip CPU because the HTML shell is compressed. That is a deliberate trade — a full 229-asset page load's wire bytes fell 67.4% in the compression work — but it is why the `/` median is not lower, and it is disclosed rather than omitted. **Regressions in the other direction are also stated:** pinned Node is faster than GoTavern on the settings-aggregation route in the local Windows/arm64 Layer-A pairing (`55.7 vs 24.5 ms` p95, recorded in [`docs/perf-baseline.md`](perf-baseline.md) §10.4). No surface claims a universal win.

## 3. What these numbers are and are not

- **They are a same-machine comparison, not a promise.** Absolute numbers move with the host; the ratio is the claim. The provenance note records historical boot medians for one subject spanning 8.8-14.6 s, which is why the figure cites ONE runner and ONE run id.
- **Boot is n=3 and varies.** The median is reported and the spread is named in [`docs/perf-baseline.md`](perf-baseline.md) §9 rather than smoothed away.
- **This release does not claim an improvement in these four headline metrics.** The previous record (`GoTavern smoke metrics` run `41777492725` at commit `4fd8ed7`) measured 163 ms / 39.8 MB / 0.403 ms / 8.28 ms for the same rows. Every delta is 1-6%, inside this harness's run-to-run variation, so the four values are published as measured.
- **Boot samples come from a cold spawn over a fresh data root with no `config.yaml`**, so first-run seeding is inside the measured window; that is the number a user experiences on first install.

## 4. Before/after: the previous release record

| Metric | Previous record (run `41777492725`, commit `4fd8ed7`) | This record (run `42012475880`, commit `f1396ce`) | Delta |
|---|---|---|---|
| Cold start to first `/version` 200 | 163 ms | **165 ms** | +1.2% |
| Steady-state RSS | 39.8 MB | **40.5 MB** | +1.8% |
| `GET /version` median | 0.403 ms | **0.429 ms** | +6.5% |
| `GET /` median | 8.28 ms | **8.59 ms** | +3.7% |

The delta column is derived from the two recorded values. All four movements are between 1% and 6%: this is the order of run-to-run variation the harness has recorded, so the release claims no improvement here. The measured optimization this round ships is at the allocation level on `/api/characters/all` (§5), where the effect is far larger than that variation.

## 5. The shipped optimization, measured where it lands

The four headline metrics are dominated by boot and an empty `/version`; they cannot show a change to a card-heavy data route. The optimization is an identity-keyed cache of decoded card text for `/api/characters/all`, keyed by absolute path plus file identity, with every per-request projection still running. It was measured with on/off arms that differ only in the read function: two test binaries, three alternating rounds, a quiet host.

| row | cold first request | repeat path | repeat allocations |
|---|---|---|---|
| 10,000 cards | 5.39 → 6.53 s (**+21%**, the cache adds a stat per card) | 4.96 → 4.10 s (**−17.4%**) | 1,216 → 968 MB (**−20.4%**) |
| 100 cards / 640 KB text | 166 → 128 ms | 170 → 98 ms (**−42.3%**) | 182 → 52 MB (**−71.3%**) |

Both halves are reported: the cache wins on repeats and allocations and loses on the cold first request. The paired CI record above does not drive that route, so the release claims no headline-metric improvement — the claim is the repeat-path CPU and allocation reduction, stated with its cost beside it. The full record, including the soak (roughly half the GC work at the same RSS drift) and the concurrency measurements that showed no headline difference, is [`docs/perf-baseline.md`](perf-baseline.md) §10.4. Those Layer-A numbers are LOCAL (Windows arm64, quiet-window) and are not spliced into the CI record.

**These are local, single-machine numbers** and are not part of the paired artifact: the in-process engineering baseline (`tests/perf/bench-baseline.txt`, a committed gate input) and the quiet-window `go test -bench` before/after arms measure one development host. They are an engineering baseline with the gate that guards them, not a product comparison; the CI gate does not validate their values, only the four recorded headline rows and the figures.

## 6. Resource analysis: what is measured, partial and missing

| metric | state | evidence / limit |
|---|---|---|
| Cold start | measured | paired artifact boot samples ×3, fresh data root |
| Steady-state RSS | measured | `VmRSS` median of 6 samples per subject |
| Peak RSS (`VmHWM`) | partial | one-off manual record in [`data-safety.md`](data-safety.md) §8.4.1; no script captures it in CI |
| CPU time | missing (in the paired artifact) | wall clock only; the runner CPU count is recorded, no process CPU time |
| p50 | measured | the median in both latency rows |
| p95 | partial | `/version` p95 only in the paired artifact; `/` p95 is not collected there |
| p99 | not collected | smoke metrics record median/p95/max/mean; p99 is UNPROVEN on both subjects |
| Request throughput | missing | all paired harnesses are sequential by design |
| GC count / pause | partial | local Layer-A gctrace only; no `NumGC`/`PauseNs` capture in the release record |
| Goroutines, file descriptors | partial | leak gates in `internal/server` soak tests and a browser probe; not in the release record |
| Long-run drift | partial | 10-minute `/version`-only soak here; 45-minute data-route soaks in the local/CI evidence rows, real-leak question UNPROVEN (§8) |
| pprof CPU/heap/trace | missing in CI | in-process profiles are local engineering evidence only |

The consequence is stated rather than implied: this is a startup, steady-memory and empty-route latency comparison, plus one data-route optimization measured locally. It is not a throughput benchmark, not a p99 tail-latency claim, and not a leak-free certificate.

## 7. How to reproduce

The release record is replaced in **one commit** that regenerates the artifact, both figures, the README table and this document; [`docs/perf-baseline.md`](perf-baseline.md) §8 is the canonical procedure. In short:

```bash
# 1. run the paired benchmark at the commit the docs will describe
gh workflow run smoke-metrics.yml
# 2. download both artifacts of that run (same run id, same commit)
gh run download <run-id> -n q22-paired-benchmark -D /tmp/q22
gh run download <run-id> -n smoke-metrics -D /tmp/smoke
# 3. record the baseline (refuses a run/commit/runner mismatch)
node tools/record-perf-baseline.mjs --q22 /tmp/q22/q22-paired-benchmark.json \
  --host /tmp/smoke/smoke-metrics.json --run-id <run-id> --commit <full sha> \
  --out tests/perf/q22-baseline.json
# 4. regenerate BOTH figure variants from that one artifact
node tools/benchmark-svg.mjs --report tests/perf/q22-baseline.json \
  --out docs/assets/benchmark.svg --out-light docs/assets/benchmark-light.svg
# 5. update README.md + this document + the provenance, then run the gate
node tools/check-perf-docs.mjs
node --test tests/docs/*.test.mjs
```

The generator is deterministic (two runs over the same inputs are byte-identical), refuses to render without a run id and a measured commit, and writes both variants in one run so they cannot disagree about the data. No SVG or table is hand-edited. `tools/check-perf-docs.mjs` fails closed, names the first mismatch with its file, line, found value and artifact field, and writes nothing.

## 8. UNPROVEN and REPORT-ONLY rows

Every skipped or unproven performance surface is listed here; none is implied to be covered by the headline table.

| row | state | why |
|---|---|---|
| `GOAL.md` §14 real private-tree drop-in claim | **NOT MET** | the evidence is synthetic/adversarial; the private channel's disposition is `PRIVATE_NOT_RUN` |
| 8-user concurrent-write latency | **REPORT-ONLY** | three repeated same-code runs spanned 1.95x (settingsSave p95) and 2.29x (chatsSave p95), tracking each host's sync-write tail; the latency gate is not ratifiable on the shared runner pool and no graded number is claimed. Correctness, isolation and error rate were green in every run |
| Soak real-leak question | **UNPROVEN** | the corrected GC-robust rule is a detection floor: a leak slower than a 10% last-third mean rise or a 4 MiB floor rise over 45 minutes would pass by design. No leak-free certificate is claimed |
| cold-guard / cold-cache row | **EXECUTED (in-process; CI baseline row present) — the process-level cold-cache SLO remains UNPROVEN** | alpha.18 adds `BenchmarkCharactersAllCold` (10,000 cards, decoded-card cache emptied before each iteration) and its row is in the regenerated `tests/perf/bench-baseline.txt`; the alpha.17 process-level records remain in [`docs/alpha17/perf/`](alpha17/perf/) and [`docs/alpha17/perf-hotspot.md`](alpha17/perf-hotspot.md), and the alpha.18 cold/warm boot attribution and paired cold arm are in [`docs/alpha18/perf/README.md`](alpha18/perf/README.md) §2-§3. The guard is an in-process benchmark, not an HTTP cold-cache SLO |
| macOS ARM64 runtime | **UNVERIFIED** | the archive is built and archive-inspected (thin arm64 Mach-O, shipped tokenizer tree checked) but NOT executed: the arm64 macOS runner has been unsupported since 2026-11-05 and the release records the platform limitation instead of waiving it |
| windows/arm64 | **BUILD-ONLY** | no hosted runner of that architecture exists; the boundary job asserts the limitation rather than implying execution |
| Real-kernel ENOSPC | **UNPROVEN** | the chaos proof shows ENOSPC and EFBIG are not conflated and identity is preserved; a real full disk was not run |
| Streaming-cancellation performance | **UNPROVEN** | functional gates exist, but no time-to-first-byte, inter-frame or cancel-to-idle metric exists |
| Real provider-relay p99 under load | **UNPROVEN** | the rows are in-process assembly and marshal; a real relay through the outbound transport under concurrency is not measured |
| Extension page-load row | no gate, no baseline | the extension-overhead harness is descriptive; it asserts nothing and is not a performance gate |
| p99 on both subjects | **UNPROVEN** | the harness records median, p95, max and mean only |

## 9. The evidence gate

`tools/check-perf-docs.mjs` (wired into `ci.yml`'s `verify` job, step "Verify the performance evidence matches the recorded artifact") enforces, with a stable named assertion per check and a non-zero exit on failure:

- the artifact's shape and provenance (run id, full commit, rounds, request count, soak window/sampling, runner image);
- the README first screen (figure pair, alt text recomputed from the artifact, shortest start block, honest scope, no stale release version) and its length budget;
- the README and this document's table rows, p95, unit rule, run id, short commit, soak drifts, computed ratios, stale-version text, relative links, duplicate sections/paragraphs and required UNPROVEN disclosures;
- the figure pair: both variants regenerated from the artifact and byte-compared, dark/light data consistency, 1200×675 canvas, `role="img"`/`<title>`/`<desc>`, no external reference, WCAG contrast computed from the committed palette, and the 12 px type floor;
- this document's provenance identity and its explicit UNPROVEN rows.

Its teeth are negative controls under [`tests/docs/`](../tests/docs/): each test tampers a temporary copy (wrong number versus the artifact, stale version token, over-budget README, broken link, duplicate section, missing alt text, low-contrast figure) and asserts the named failure, with the untampered tree green. `docs/alpha17/readme-restructure.md` carries the full contract and the observed output of each control.
