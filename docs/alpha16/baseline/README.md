# alpha.16 M0 resource baseline (the "before" record for M5)

**Status: the engineering record FAILED (L-H1, stale committed baseline) and the product record is pending.** This directory is the M0 baseline that M5 compares against.
Its job is to record the numbers **before** any M4/M5 change exists, on a named tree, with the raw artifact
named — so a later "before/after" is a comparison of two records rather than of two memories.

## 1. What tree is being measured

| fact | value | how it was verified |
|---|---|---|
| lane HEAD at dispatch | `c8472c1` | `git rev-parse HEAD` |
| product code identity | `f1396ce` (alpha.15 code-complete) | `git diff --stat f1396ce..HEAD -- '*.go' ':!*_test.go' ':!tools/alpha16-graph'` is EMPTY: between the alpha.15 code commit and this baseline the only Go changes are the document-gate test's pin declarations and this round's read-only audit tool, and the alpha.15 documentation commits |
| Go module version | `go 1.27.3` | `go.mod` |
| pinned oracle | SillyTavern `1.19.0` @ `06bde939fb1e9c4c8d8641d810f0a916b5bce127` | `upstream/SILLYTAVERN_COMMIT` |
| CI runner | `ubuntu-latest` (x86_64) | the workflow files below; `docs/development-loop.md` names it the gate host |

The local development host is **not** part of the baseline: it is a Windows 11 ARM64 VM with 2 vCPU and
12 GB RAM, and `docs/development-loop.md` / `AGENTS.md` forbid presenting a Windows result as a comparison.
Local numbers, when they exist, are labelled `LOCAL-ONLY (Layer A)` and are never spliced into a CI claim.

## 2. The dispatched records

| record | workflow | run | inputs | artifact the numbers live in |
|---|---|---|---|---|
| engineering scale benchmarks, CPU/heap/block/mutex profiles, execution trace, comparison with the committed alpha.15 baseline | `GoTavern bench profiles` (`.github/workflows/bench-profiles.yml`) | **42160109620** (dispatch at `c8472c1`) | `rounds=3` | `bench-profiles-artifacts` (raw `go test -bench` output, pprof files, trace, comparison table, environment) — gitignored `tests/perf/out/` on the runner, uploaded |
| boot, warm restart, request latency, seeded-tree size, RSS; plus the paired Node-vs-Go product measurement | `GoTavern smoke metrics` (`.github/workflows/smoke-metrics.yml`) | **42160114658** (dispatch at `c8472c1`) | `requests=50` | `smoke-metrics` (`smoke-metrics.json`, boot logs) and `q22-paired-benchmark` |

Both are `workflow_dispatch` records at one SHA: the artifact's embedded identity is readable, and a later
push-triggered run cannot be mistaken for it. `scripts/bench-profiles.mjs` refuses to compare across a
different host image instead of splicing numbers, and the committed comparison baseline it uses is
`tests/perf/bench-baseline.txt` (alpha.15, same runner image).

## 3. What each record provides for M5

| M5 question | field / artifact | note |
|---|---|---|
| cold boot | `smoke-metrics.json` `coldStartToVersionMs` | spawn → first HTTP 200 from `GET /version` over an empty data root with no `config.yaml` |
| warm boot | `warmStartToVersionMs` | after a graceful SIGTERM stop over the SAME root |
| fresh-install seeded tree | `freshInstall.files`, `freshInstall.bytes`, `install.*` | the pinned startup mutation footprint |
| steady-state memory | `memory.*.rssBytes` (VmRSS from `/proc`) | Linux only; `null` with a reason elsewhere |
| request latency p50/p95/p99 | `latency.version.*`, `latency.root.*` | includes `.firstMs` (connection setup) separately |
| CPU time, allocations, B/op | `bench-profiles` `-benchmem` table for the scale benchmarks | `internal/server/bench_test.go` workload, deterministic fixtures |
| CPU/heap/block/mutex profiles and an execution trace | `bench-profiles` pprof/trace files | heap projected into `alloc_space`/`alloc_objects` |
| 100 / 1000 / 10000 cards | `BenchmarkCharactersAllScale/...` | 4 KB / 32 KB / 128 KB / 640 KB image classes |
| large JSONL chats | `BenchmarkChatSummary/*`, `BenchmarkChatsRecent/*` | 10×2 MB, 100×256 KB, 1000×16 KB |
| settings aggregation at scale | `BenchmarkSettingsGetScale/*` | 220 / 1100 documents |
| world-info listing at scale | `BenchmarkWorldInfoList/*` | 50×128 KB, 200×32 KB, 1000×8 KB |
| 229-path page load | `BenchmarkStaticPageLoad` | path count asserted |
| provider assemble/marshal | `BenchmarkChatCompletionAssemble/*`, `BenchmarkChatCompletionMarshal/*` | largest recorded + scaled 1 MB |
| paired product comparison | `q22-paired-benchmark` artifact | both subjects, alternating rounds, one runner |

## 4. What these records do NOT provide (named, not implied)

These are the M0 baseline gaps. They are **CI-PENDING**: each needs a harness decision in M1/M5 rather than
a number invented here.

1. **Extension-heavy boot and page load.** Neither record installs an extension tree. The 20-extension
   page-load and boot cost is measured today only inside the third-party extension workflow's soak job, and
   that workflow is not dispatched here.
2. **8-user concurrent writes.** The plan's E06 needs overlapping save/load/delete/rename/import and
   cross-user isolation under contention. No record above drives more than one user; `settingsSaveMu`'s
   cross-user contention is therefore an untested hypothesis, not a measured fact.
3. **30–60 minute soak.** `q22-paired-benchmark` soaks for ten minutes; the plan asks for 30-60.
4. **Provider relay p99 under load.** The bench rows are in-process assemble/marshal; a real relay through
   `internal/outbound` under concurrency is not in either record.
5. **A cold guard row in the committed bench baseline.** Recorded in `HANDOFF.md` as still open: the
   cold-guard arm lives in `scripts/a15-bench-p1-arms.mjs` because `bench-profiles.mjs` fails on a benchmark
   absent from the committed baseline. A cold-row baseline requires a deliberate regeneration on the Linux
   host, which is a change of the recorded baseline and is not made in M0.

## 5. How M5 derives thresholds (recorded now, before optimizing)

- Start from the committed `tests/perf/bench-baseline.txt` (alpha.15, same runner image) and the two records
  above; the spread between the alpha.15 record and this M0 record is the between-run noise estimate for
  that metric.
- Keep the existing two-sided comparison: ns/op tolerance 60 %, B/op and allocs/op 15 %, a vanished or new
  benchmark is a failure, and a same-input *speedup* beyond tolerance is a failure too
  (`scripts/bench-profiles.mjs` self-test already demonstrates each class).
- Product metrics (`smoke-metrics.json`) are **reported, not asserted**, except the cold-start ceiling;
  M5 may propose a threshold only after the noise estimate exists, and must state the runner image.
- No threshold is chosen after seeing the optimization result. The rule from `GOAL.md` §15.2 and the plan
  §7 is: record and justify the threshold first, then optimize.

## 6. Reproduction

```bash
gh workflow run bench-profiles.yml --ref lane/alpha16-program -f rounds=3
gh workflow run smoke-metrics.yml  --ref lane/alpha16-program -f requests=50
gh run download <run-id> -n bench-profiles-artifacts -D tests/perf/out
gh run download <run-id> -n smoke-metrics -D smoke-metrics-out
```

The artifacts are the record; the numbers below are a summary of the artifact, never a substitute for it.

## 7. First dispatch results (2026-11-06) — the engineering record is RED, and that is a finding

| record | run | result |
|---|---|---|
| `GoTavern bench profiles` | **42160109620** (`workflow_dispatch` at `c8472c1`, rounds=3) | **FAILURE** — job `bench-profiles-linux-amd64`, step `Run benchmarks, capture profiles, compare to the committed baseline` |
| `GoTavern smoke metrics` | **42160114658** (`workflow_dispatch` at `c8472c1`, requests=50) | `measure-linux-amd64` **success**; `paired-linux-amd64` **success**; `smoke-metrics.json` `verdict.passed: true` |

The bench failure is eight comparison failures (eight rows, two metrics on three rows plus two ns/op rows):

```
BenchmarkCharactersAllScale/cards_1000_32KB_image   ns/op -64.6%  B/op -34.7%  SPEEDUP
BenchmarkCharactersAllScale/cards_100_128KB_image   ns/op -72.8%  B/op -57.0%  SPEEDUP
BenchmarkCharactersAllScale/cards_100_640KB_image   ns/op -84.3%  B/op -78.4%  SPEEDUP
BenchmarkChatCompletionAssemble/scaled_1MB          ns/op -63.5%              SPEEDUP
BenchmarkChatCompletionMarshal/scaled_1MB           ns/op -66.4%              SPEEDUP
```

**This is not a product regression and it is not host noise.** The product code at `c8472c1` is identical to
`f1396ce` (`git diff --stat f1396ce..HEAD -- '*.go' ':!*_test.go' ':!tools/alpha16-graph'` is empty), and
`B/op` does not move with CPU or kernel version. It is the **accepted alpha.15 card-text cache** showing up:
the committed baseline `tests/perf/bench-baseline.txt` was recorded at `ed75eee` on 2026-11-03, its tree does
**not** contain `internal/server/characters_card_cache.go` (`git cat-file -e ed75eee:…` → 128), and the cache
landed on 2026-11-05 as `cc72384`, an ancestor of `main`. `47da1de` removed the cold-guard row "to keep the
committed-baseline gate green" and stated "no scheduled gate is left red"; the warm rows themselves moved, so
that statement was false. The workflow's last run before this dispatch was 2026-11-04, so alpha.15 shipped
without a post-cache bench run, and `GoTavern bench profiles` is not one of the 13 required release gates.

**Consequence, stated before any later M5 claim:**

1. No M5 before/after comparison may cite the committed baseline after `cc72384`. The "before" must be a
   **deliberately regenerated** Linux baseline whose tree contains the cache, committed together with its raw
   run (`node scripts/bench-profiles.mjs --update-baseline --out-dir tests/perf/out`), and then a green
   comparison run. That regeneration is a later change, not an M0 action (M0 is read-only).
2. The registration in `47da1de` — "no scheduled gate is left red" — is a claim that needs correcting where it
   is recorded, and the cold guard now lives only in `scripts/a15-bench-p1-arms.mjs`, so the committed
   baseline has no cold row.
3. The product record (`smoke-metrics`) is unaffected by the stale engineering baseline; its numbers are
   reported, not asserted, and its first same-SHA job completed green.

Lead fragment: `docs/alpha16/audit/lead.json` hypothesis `L-H1`.

## 8. The product record, as measured (smoke metrics 42160114658)

Artifact: `smoke-metrics.json` (`host.sha = c8472c1…`, `runnerImage ubuntu26`, `runnerImageVersion
20261101.186.1`, 4 vCPU, 16.8 GB, node v24.22.2) and `q22-paired-benchmark.json` from the same run. These
numbers are quoted from the artifacts; the artifacts are the record.

**Fresh-install / boot / latency (single subject, `measure-linux-amd64`):**

| metric | value |
|---|---|
| cold start → `GET /version` 200 (empty data root, no config) | **917.25 ms** (includes the first-run seeding of 203 files / 16,169,121 bytes) |
| warm start → `GET /version` 200 (same root, after SIGTERM) | **29.22 ms** |
| `GET /version` | median **0.611 ms**, p95 **1.715 ms**, first **1.999 ms** |
| `GET /` (734,837-byte shell) | median **6.457 ms**, p95 **14.274 ms** |
| RSS after cold boot / warm boot | **38,215,680 B** / **18,309,120 B** |
| install staging footprint | 27 files / 98,910,141 B; warm−cold seeded delta 0 |

**Paired Node-vs-GoTavern (3 alternating rounds, `paired-linux-amd64`, medians):**

| metric | pinned Node | GoTavern |
|---|---|---|
| boot | 13,685 ms | **161 ms** |
| steady RSS | 1,129,486,336 B | **40,527,872 B** |
| `GET /version` median | 54.919 ms | **0.379 ms** |
| `GET /version` p95 | 56.883 ms | **0.516 ms** |
| `GET /` median | 12.810 ms | **8.026 ms** |
| 10-minute soak, RSS drift | −574,287,872 B | **−1,982,464 B** |
| 10-minute soak, p95 drift | −8.415 ms | **+0.502 ms** |

Two honest notes: (a) the cold 917 ms is not the q22 `bootMs` measure — it includes the fresh-install seeding
that a real first run pays, which is why the paired record (an already-seeded root per round) reports 161 ms;
(b) the soak is **10 minutes**, not the 30–60 minutes the plan's M5 asks for, so the long-run requirement is
still `CI-PENDING` (§4 item 3). The paired record's own notes say a paired median on a shared runner is
"evidence for a report, not a release gate" — consistent with L/E-H2, which records that the smoke-metrics
release gate asserts no performance number.

**Baseline status:** the product half is recorded and green; the engineering half is still red until the
committed bench baseline is deliberately regenerated (§7).
