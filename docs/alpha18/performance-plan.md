# alpha.18 performance plan and measurement protocol

This is the method record behind the numbers in `docs/alpha18/perf/README.md`,
`docs/alpha18/perf-hotspot.md` and `docs/alpha18/perf/abba-inprocess.json`. It exists so a reader can judge
the claim from the protocol, not from the report.

## 1. Question and thresholds

- **P0 (graded):** on a 10,000-card data root, the key request (`POST /api/characters/all`) p50 **or** the
  process peak RSS improves by **at least 20%** with a statistically discernible separation, and the other key
  metrics (100/1,000-card request, boot, steady RSS) do not regress beyond measurement spread.
- **Attribution requirement:** the change must be traceable to a profile or a controlled experiment, not to a
  guess; the interface contract (response bytes, provider prompts) must be unchanged.
- **Honesty requirement:** a missing or noisy measurement is reported as such (UNPROVEN), never as a pass; a
  local result is never presented as a Linux CI result.

## 2. Layers and what each answers

| layer | tool | what it can claim |
|---|---|---|
| in-process micro/scale | `internal/server/bench_test.go` (`BenchmarkCharactersAllScale`, new `BenchmarkCharactersAllCold`) | ns/op, B/op, allocs/op on identical generated fixtures; deterministic allocation totals |
| startup attribution | boot script over a generated tree (spawn → first `/version` 200, `procstat` CPU at readiness) + controlled tree variants | which code path touches how many files; cold vs warm first-touch cost |
| process-level paired A/B | `scripts/a15-bench-suite.mjs --mode paired` (published alpha.17 binary vs candidate) | boot ms, steady/peak RSS, HTTP latency p50/p95 on the same host and identical trees, with the subject order alternated per round |
| 60-minute soak | `tools/perf/a18-soak.mjs` | request/error counts, latency distribution, RSS drift with per-segment slope, restart integrity, external-modification handling |
| CI release gate | `GoTavern smoke metrics` at the candidate SHA | the release's graded paired performance record and soak (required by `docs/release-manifest.json`) |

## 3. In-process paired ABBA protocol (executed)

1. Build/obtain two subjects: the candidate tree and a clean `git worktree` of the alpha.17 product commit
   `9b99fde` with the SAME `bench_test.go` copied in, so the benchmark harness is identical across subjects.
2. Three rounds; each round runs both subjects over the same arms, and the order flips every round
   (`A,B` / `B,A` / `A,B`).
3. Per run: `go test ./internal/server -run=NONE -bench=<arm> -benchmem -benchtime=3x -count=1 -timeout=900s`.
4. Parsing: a benchmark's name line may carry an interleaved product log line, so the numbers are read from
   the next line and the run REFUSES to report if any arm produced no row (no silently missing arm).
5. Report: per-round series, median, min/max and the change of medians; the claim must survive the spread
   (every candidate observation below every baseline observation), not just the median.

Arms: 10,000 cards 4 KB image (hot), `BenchmarkCharactersAllCold` (10,000 cards, decoded-card cache emptied
per iteration), 1,000 cards 32 KB image, 100 cards 128 KB image.

## 4. Startup attribution protocol (executed)

For each condition: generate a fresh tree, boot the binary with `--dataRoot`/`--port`/`--listenAddressIPv4
127.0.0.1`, poll `/version` every 10 ms, record wall time to the first 200 and a `procstat` CPU/RSS sample at
readiness, then kill. Conditions: alpha.17 code on a fresh tree; the same tree copied to a new directory;
cards moved out of the listing; cards moved one directory down; a 60 s wait before boot; and each partial fix.
The point is to separate product work (file touches) from host first-touch cost, not to publish a cold-boot
SLO.

## 5. Process-level paired protocol (executed on the candidate)

`node scripts/a15-bench-suite.mjs --mode paired --subject a17=<published alpha.17 binary> --subject
a18=<candidate> --scale <cards|mixed-large> --scale-args … --rounds 4 --requests 6 --data-route characters`.
Each round generates a FRESH identical tree per subject and alternates the subject order; boot, steady RSS,
peak RSS and HTTP p50/p95 are recorded per round. `--load-label` records the host state. This is Layer A
evidence; the same-SHA `GoTavern smoke metrics` gate is the CI record.

## 6. 60-minute soak protocol (executed on the candidate)

`node tools/perf/a18-soak.mjs --binary <candidate> --data-root <generated mixed-large tree>/data --config …
--minutes 60 --rate 8 --restart-every-minutes 10 --out docs/alpha18/perf/soak-60min.json`. One request in
flight, weighted mixed storage routes, a create+overwrite chat saved and re-read across every restart with
HTTP-content AND on-disk sha256 comparison, an `fs.utimes` card-modification probe each minute, 15 s
`procstat` samples, availability checks. The artifact records what is NOT measurable from outside the process
(handles/FDs, goroutines, live heap, graceful shutdown through a Windows console kill) and reports the leak
verdict as UNPROVEN rather than inferring it from RSS.

## 7. Rules applied

- Same host, same commit, same inputs, same build flags for a before/after; different-host numbers are never
  spliced into one claim.
- Every published number names its artifact and layer; LOCAL numbers are labelled LOCAL.
- A measured regression is reported as a regression (the cold-cache arm's timing was not separable and is
  reported as not claimed).
- The release performance claim is the CI gate, not the local spreadsheet.
- `tools/check-perf-docs.mjs` keeps the release-facing surface consistent with the recorded artifact and fails
  the build on drift; its 15 negative controls live in `tests/docs/check-perf-docs.test.mjs`.
