# alpha.20 performance and figure evidence (Layer A, Windows arm64 development host)

Status: **local evidence only.** Every number here was measured on the development host (`go1.27.3
windows/arm64`, `virt-7.2`, **2 logical cores**, shared with the other alpha.20 lanes while they ran
browser/oracle work). The deterministic rows (B/op, allocs/op) are load-independent and are the rows a claim may
rest on; wall-clock rows are marked load-inflated and are not claims. **No number here is a CI verdict.** The
release-facing performance claim remains the Linux `GoTavern smoke metrics` paired gate and the four-row table in
[`docs/performance.md`](../../performance.md); this directory adds the alpha.20 profile set, the reproduced
baseline and the hotspot change's same-input before/after.

Companions: [`profiles/`](profiles/) (raw CPU/heap profiles plus pprof top tables and a host/load record),
[`raw/`](raw/) (in-process baseline), [`figure-checks.json`](figure-checks.json) (headless figure-check artifact),
[`docs/assets/benchmark.svg.provenance.md`](../../assets/benchmark.svg.provenance.md) (figure design and palette),
and [`docs/alpha19/perf/`](../alpha19/perf/README.md) (the alpha.19 record this one extends; it is not rewritten).

## 1. Reproduced baseline at `7d1178e`

In-process, one tree per arm, `-benchmem -benchtime=3x -count=1`, committed raw output in
[`raw/a20-baseline-inprocess-charactersall.txt`](raw/a20-baseline-inprocess-charactersall.txt):

| arm | alpha.19 recorded | alpha.20 reproduced | delta |
|---|---:|---:|---:|
| 100 cards B/op | 24,124,301 | 24,169,848 | +0.2% |
| 100 cards allocs/op | 18,247 | 18,250 | +0.02% |
| 1,000 cards B/op | 134,135,309 | 134,135,522 | +0.00% |
| 1,000 cards allocs/op | 178,954 | 178,955 | +0.00% |
| 10,000 cards B/op | 403,148,557 | 403,146,402 | −0.00% |
| 10,000 cards allocs/op | 1,733,652 | 1,733,649 | −0.00% |
| 640 KiB card B/op | 83,136,538 | 83,136,232 | −0.00% |
| 640 KiB card allocs/op | 18,531 | 18,529 | −0.01% |
| cold 10,000 B/op | 663,713,360 | 662,911,994 | −0.1% |
| cold 10,000 allocs/op | 2,040,317 | 2,040,322 | +0.00% |

The deterministic rows reproduce within 0.2%, so the alpha.19 optimization record still describes this tree.
Wall times from this run (e.g. 14.7 s/op on the 10,000-card warm arm) are **load-inflated** and must not be
compared with the alpha.19 quiet-window rows.

## 2. The fresh profile set

Captured with the unmodified alpha.19 tool [`tools/perf/a19profile`](../../../tools/perf/a19profile/main.go): a
real `internal/app.Start`, a real listening server, warmup requests, and pprof around the profiled window.
Profiles and pprof top tables are in [`profiles/`](profiles/), with the host/load and command record in
[`profiles/HOST-AND-LOAD.md`](profiles/HOST-AND-LOAD.md).

| window | profile label | what it attributes |
|---|---|---|
| startup, 10,000-card tree | `a20-startup-cold-10000` | startup stages, disk-cache verification, statistics recompute |
| `/api/characters/all`, 10,000 cards, warm | `a20-http-characters-warm-10000` | ordered-JSON projection and response encoding |
| `/api/chats/get`, 2,000-message chat | `a20-http-chat-get-2000msg` | chat JSONL decode and ordered-JSON marshal |
| `/api/worldinfo/get`, 4 MiB world book | `a20-http-world-get-4MB` | ordered-JSON decode and marshal |
| `/api/backends/chat-completions/generate` SSE relay | `a20-relay-small` | provider relay buffers and per-request work |

Attribution caveat, applied before any claim: the profiler's own HTTP client reads each response with
`io.ReadAll`, so a large share of `alloc_space` in a large-response window (630 MB in the 10,000-card window,
39.8 MB in the 4 MiB world window) is the **harness**, not the server. Those rows are named as harness
allocation in the hotspot document and are excluded from product attribution; the in-process benchmark (server
only) is the claim surface for allocation changes.

## 3. The alpha.20 hotspot

See [`hotspots.md`](hotspots.md) for the attribution and [`changes.md`](changes.md) for the approved,
measured change and its before/after, including the frozen byte-identity golden set and the A/A self-test row.
Nothing in this directory claims a product change that is not in [`changes.md`](changes.md).

## 4. Figure checks (headless only)

`tools/check-figure-a11y.mjs` is the alpha.20 addition: it renders the two committed SVG variants in a headless
Chrome/Edge, parses them as XML, measures every `<text>` bounding box against the 1200x675 viewBox at
1200/720/360 CSS px, asserts that nothing overflows or clips, checks the 13 px type floor and the 18 px hero
number at 720 px, and verifies that both `<desc>` elements and the README `alt` text restate every value
recomputed from `tests/perf/q22-baseline.json`. The artifact of the last run is
[`figure-checks.json`](figure-checks.json); it is Layer A tooling (it needs a local browser binary), while the
pure-data half of the figure contract stays in `tools/check-perf-docs.mjs` and runs in CI.

## 5. Reproduce

```powershell
# 1. build the candidate and the helpers
go build -trimpath -o "$env:TEMP\a20\gotavern.exe" ./cmd/gotavern
go build -o "$env:TEMP\a20\a15-fixturegen.exe" ./tests/perf/fixturegen
go build -o "$env:TEMP\a20\a15-procstat.exe" ./tests/perf/procstat
go build -trimpath -o "$env:TEMP\a20\a19profile.exe" ./tools/perf/a19profile

# 2. deterministic trees
& "$env:TEMP\a20\a15-fixturegen.exe" --out "$env:TEMP\a20\trees\cards-10000" --scale cards --cards 10000 --image-bytes 4096 --card-bytes 2048
& "$env:TEMP\a20\a15-fixturegen.exe" --out "$env:TEMP\a20\trees\chats-large" --scale chats-large --chats 1 --chat-messages 2000
& "$env:TEMP\a20\a15-fixturegen.exe" --out "$env:TEMP\a20\trees\world-4mb" --scale worlds --worlds 1 --world-bytes 4194304

# 3. baseline allocations and profiles
go test ./internal/server -run '^$' -bench 'BenchmarkCharactersAllScale|BenchmarkCharactersAllCold' -benchmem -benchtime=3x -count=1
& "$env:TEMP\a20\a19profile.exe" --mode http --route characters --data-root "$env:TEMP\a20\trees\cards-10000\data" `
  --config "$env:TEMP\a20\trees\cards-10000\config.yaml" --out-dir docs\alpha20\perf\profiles --label a20-http-characters-warm-10000 --warmup 1 --requests 3

# 4. the hotspot benchmark (server only; before/after binaries)
go test ./internal/server -run '^$' -bench 'BenchmarkA20Marshal' -benchmem -count 5

# 5. the figure checks
node tools/check-figure-a11y.mjs --out docs/alpha20/perf/figure-checks.json
node tools/check-perf-docs.mjs
```
