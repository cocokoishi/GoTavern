# `tests/perf` — the engineering performance gate

This directory holds the same-host benchmark baseline and the tooling notes for the M2 "performance baseline"
milestone. The paired product-level measurement against pinned Node lives in
`tests/perf/q22-paired-benchmark.mjs`; the in-process engineering measurement lives in
`internal/server/bench_test.go` and is driven by `scripts/bench-profiles.mjs`.

## What is measured

| benchmark | subject |
|---|---|
| `BenchmarkVersion`, `BenchmarkFrontendIndex`, `BenchmarkFrontendAsset`, `BenchmarkManyFrontendAssets` | the tiny/hot static HTTP surfaces that already existed |
| `BenchmarkSettingsGet` | the small-tree aggregation route (existing) |
| `BenchmarkCharactersAll` | the one-card character route (existing) |
| `BenchmarkCharactersAllScale/{cards_100_128KB_image,cards_1000_32KB_image,cards_10000_4KB_image,cards_100_640KB_image}` | `/api/characters/all` at 100/1000/10000 generated cards, plus the per-image-byte coefficient |
| `BenchmarkChatSummary/{chats_10_x_2MB,chats_100_x_256KB,chats_1000_x_16KB}` | `/api/characters/chats` — `getChatInfo` per JSONL file |
| `BenchmarkChatsRecent/{...}` | `/api/chats/recent` — enumerate + stat + sort + summarize |
| `BenchmarkSettingsGetScale/{files_per_dir_20,files_per_dir_100}` | settings aggregation over 220/1100 generated preset/theme/QR documents |
| `BenchmarkWorldInfoList/{worlds_50_x_128KB,worlds_200_x_32KB,worlds_1000_x_8KB}` | `/api/worldinfo/list` |
| `BenchmarkStaticPageLoad` | all 229 paths from `docs/frontend-startup-calls.md`, count asserted |
| `BenchmarkChatCompletionAssemble/{largest_recorded,scaled_1MB}` | decode browser body + pinned plan + marshal provider body |
| `BenchmarkChatCompletionMarshal/{largest_recorded,scaled_1MB}` | `marshalOrderedNodeJSON` over the produced provider body |

Every fixture is generated in `bench_test.go` from fixed constants (xorshift64\* for noise, no `math/rand`,
no private data), so the same bytes are produced on every host. The character-card PNGs are real PNGs with a
real `chara` tEXt card; the avatar payload is one valid ancillary chunk of deterministic pseudo-random bytes
of the same size, because the reader copies chunk bytes but never decodes them — the card-shape rationale is
in the section header of `internal/server/bench_test.go`.

## Baseline and regeneration

* Committed baseline (medians of `--rounds` rounds, plus host facts): `tests/perf/bench-baseline.txt`.
* The raw `go test -bench` output that produced it: `tests/perf/bench-baseline-raw.txt`.
* Artifacts from a run (raw output, pprof files, trace, comparison table, environment): `tests/perf/out/`,
  uploaded by `.github/workflows/bench-profiles.yml`. That directory is gitignored.

Regenerate ONLY when the observation legitimately changed (a benchmark's input or subject changed, or a real
product change landed and the new cost is the accepted cost):

```bash
node scripts/bench-profiles.mjs --update-baseline --out-dir tests/perf/out
```

Use a clean tree, on the same runner image as the comparison (`ubuntu-latest` for the committed baseline), and
commit the baseline together with its raw run. The script records the commit, Go version, GOOS/GOARCH,
GOMAXPROCS and runner image in the baseline header, and the workflow refuses to compare numbers from a
different host (exit 2) instead of splicing them.

## The comparison rules (why a green means something)

`node scripts/bench-profiles.mjs` builds the package test binary once, then:

1. runs the benchmark set for `--rounds` rounds with `-benchmem`, takes the median per metric, and compares
   with the committed baseline;
2. fails when a baseline metric is missing from the current output (the `b.ReportAllocs` teeth: a missing
   column is a failure, never a skipped comparison);
3. fails on a **two-sided** change beyond the tolerances — ns/op 60 %, B/op 15 %, allocs/op 15 %. A dramatic
   speedup fails too, because on identical input it means the benchmark stopped measuring the same work; the
   baseline then has to be regenerated deliberately;
4. fails when a benchmark appears in or disappears from the current run;
5. runs the same set with `-cpuprofile`, `-memprofile`, `-blockprofile` and `-mutexprofile`, projects the
   heap profiles into `alloc_space`/`alloc_objects` top tables, and runs a bounded subset with `-trace` (the
   trace is proven readable by projecting its scheduler profile through `go tool pprof`, because Go 1.27's
   trace CLI has no `-tool=dump`).

A local run on another OS/arch cannot compare against the CI baseline by accident; use `--ignore-host` only
for triage and say so in the report.
