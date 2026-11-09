# alpha.19 performance summary — cumulative evidence (Layer A, Windows host)

Status: **local evidence only.** Every number below was measured on the development host (Go 1.27.3
windows/arm64, 2 logical cores, shared with two other lanes), where the wall-clock rows are load-inflated. The
deterministic rows (B/op, allocs/op) are load-independent and are the ones the claim rests on. **The release claim
is the Linux `GoTavern smoke metrics` paired gate, not this file.** Nothing here is a CI verdict.

Companions: [`README.md`](README.md) (reproduction + provenance), [`hotspots.md`](hotspots.md) (attribution),
[`targets.md`](targets.md) (targets/claim rules), [`changes.md`](changes.md) (per-change records, including the
rejected attempts), raw artifacts in [`raw/`](raw/) and [`profiles/`](profiles/).

## 1. Cumulative allocation table — `/api/characters/all` (in-process, `-benchmem -benchtime=3x -count=1`)

One tree, one command, arms run in one process: 100 / 1,000 / 10,000 cards, a 640 KiB single card, and the cold
(uncached) 10,000-card arm. Rows are cumulative: each column is the tree at that commit.

| arm | alpha.18 baseline | +C1 | +C4 | +C3 (current) | cumulative vs baseline |
|---|---:|---:|---:|---:|---|
| 100 cards B/op | 28,743,157 | 27,957,050 | 24,181,629 | **24,124,301** | **−16.1%** |
| 100 cards allocs/op | 32,860 | 18,465 | 18,448 | **18,247** | **−44.5%** |
| 1,000 cards B/op | 167,573,736 | 159,709,717 | 134,470,965 | **134,135,309** | **−20.0%** |
| 1,000 cards allocs/op | 324,973 | 180,969 | 180,950 | **178,954** | **−44.9%** |
| 10,000 cards B/op | 619,914,794 | 541,274,656 | 406,486,229 | **403,148,557** | **−35.0%** |
| 10,000 cards allocs/op | 3,193,663 | 1,753,661 | 1,753,641 | **1,733,652** | **−45.7%** |
| 640 KiB card B/op | 90,694,058 | 89,908,144 | 83,169,664 | **83,136,538** | **−8.3%** |
| 640 KiB card allocs/op | 33,140 | 18,737 | 18,726 | **18,531** | **−44.1%** |
| cold 10,000 B/op | 879,836,722 | 801,197,144 | 666,431,621 | **663,713,360** | **−24.6%** |
| cold 10,000 allocs/op | 3,500,332 | 2,060,330 | 2,060,316 | **2,040,317** | **−41.7%** |

Artifacts: [`raw/alpha18-baseline-inprocess-charactersall.txt`](raw/alpha18-baseline-inprocess-charactersall.txt),
[`raw/c1-after-inprocess.txt`](raw/c1-after-inprocess.txt), [`raw/c4-after-inprocess.txt`](raw/c4-after-inprocess.txt),
[`raw/c3-after-inprocess.txt`](raw/c3-after-inprocess.txt). Cold is separate from warm by construction (fresh
process, first request); it is not a warm-up effect of the same number.

**Per-change attribution:** C1 removes the member-ordering copy + comparison sort per object (allocs −43..−45%,
B/op −10..−13%); C4 pre-sizes the response buffer from the summed card text (−19..−25% B/op on warm arms, −24% cold);
C3 removes 10,000 failing `ReadDir` calls per request (allocs −1.1%, B/op −0.8%, and the CPU win below). Adding
C1+C4+C3 is multiplicative on objects because C3's failing opens were also objects.

**Remaining bytes on the 10,000-card arm (403.1 MB/op):** the response body alone is 58,887,196 B, and the route
still materialises (a) the decoded card documents (`encoding/json` string unescaping, [`hotspots.md`](hotspots.md)
ranks it first), (b) the escaped JSON Body buffer (`writeCharacterJSONString`, C5's target), (c) the ordered-node
projection copies, and (d) one gzip pass. The largest remaining single lever is the per-card decode + escape pair;
the next candidate list (C6/C7) is in [`hotspots.md`](hotspots.md) and was **not** approved.

## 2. CPU attribution — C5 (generic ordered-JSON escaper) and C3 (chats listing)

| window | before | after | claim |
|---|---:|---:|---|
| C5 world-get (4 MB) window | 331.43 MB allocated CPU·time | **256.46 MB (−22.6%)** | `bytes.Replace` 48.02 MB → 0 |
| C5 chat-get window | 149.71 MB | **115.45 MB (−22.9%)** | `bytes.Replace` 14.35 MB → 0 |
| C3 10,000-card request window, `calculateChatSize` cumulative CPU | 1.21 s of 5.24 s samples (**23.1%**) | **0.08 s of 10.88 s (0.74%)** | 10,000 failing directory opens removed |
| C3 `os.ReadDir` cumulative CPU | 1.27 s (24.2%) | **0.12 s (1.1%)** | one root listing + cards that really have dirs |
| C2 chat-completion relay window (300 requests), config reader cumulative CPU | 0.29 s of 1.25 s samples (**23.2%**) | **10 ms of 780 ms (1.28%)** | YAML parser leaves the profile |

The CPU rows are shares of their own window (host load differed between before/after runs, so absolute
milliseconds are not comparable); the allocation rows above are exact. Gzip (`compress/flate`, 13.8–21.4% of large
response windows) is **excluded as parity-bound**: the pinned server compresses the same responses at the HTTP layer
with the same default settings, so changing it would change bytes on the wire rather than cost.

## 3. Stability — what was found, and whose defect it was

| finding | class | evidence |
|---|---|---|
| streaming cancel-watcher goroutine leaked per send when the caller's context had no `Done` (nil channel) | **PRODUCT leak** | RED: 50 sends → 50 leaked watchers (baseline 3); GREEN: 0 leaked. `internal/outbound/raw_test.go`, commit `191818a` |
| truncated responses were silent (no reason, no error class) | **PRODUCT diagnosability gap** | `Response.TruncatedBy` + opt-in `GOTAVERN_TRUNCATION_TRACE`, commit `5f8cdc8` |
| the 39-minute full-suite hang: the test provider answered without reading the POST body → RST discarded unread response bytes → a *legitimate* truncation → the client waited for EOF (pinned-parity stall) | **TEST defect presenting as a product hang** | bounded read + peer body drain; 80/80 bounded repetitions pass where 3/6 batches hung before, commit `28831ed`, findings in `../findings/a19-textgen-stream-stall.md` |
| C1 changed `entries()` from a defensive copy to a read-only view; the image-metadata cleanup loop deleted members while ranging over it | **PRODUCT regression caught by the full suite** | pinned differential `TestPinnedNodeImageMetadataCleanup` red on C1 only (bisect PASS/FAIL/PASS/FAIL); one-line snapshot + read-only contract + 13-call-site audit; teeth shown, commit `27f504e` |

## 4. ABBA rows (process-level latency + RSS) — **NOT YET MEASURED**

`tools/perf/a19-abba.mjs` is written and its same-binary self-test is the first step (identical subjects must come
out "not separable", otherwise the harness is reported as broken). Both need a quiet window: the host is shared
with two other lanes' Node/Chromium work and the alpha.19 warm-boot spread (167.8–1,773.2 ms across repeated
runs of one binary) makes any unpaired number meaningless. **Peak RSS remains UNPROVEN until these rows exist**, and
the C1+C4 "peak-RSS half" in `changes.md` stays labelled UNPROVEN regardless of what these rows later show.

## 5. Node control (pinned-vs-Go same-load comparison) — **NOT YET MEASURED**

Same quiet-window dependency: pinned must be booted (webpack compile included) on the same machine while GoTavern
serves the same generated tree. The C2 probe's pinned boots prove the harness can drive pinned unmodified; the
control rows belong in a `vs-node.md` with per-route p50/p95, not in this file.

## 6. Explicit regressions and rejected attempts (nothing hidden)

- **C4 attempt 1** pre-sized with `2*len(cardText)+2048` and REGRESSED the 1,000-card arm from 159,709,717 to
  164,674,989 B/op (+3.1%). Rejected; the shipped estimate is `3*len+512`. The rejected row is kept in `changes.md`
  and `raw/c4-attempt1-2x-estimate-inprocess.txt`.
- **C3 attempt 1** fell back to the per-card `ReadDir` on every exact miss (case-insensitive caution) and bought
  nothing on an empty chats root (~14.5% of the window still in `calculateChatSize`). Rejected; the shipped version
  decides the miss without a syscall. Both profiles kept (`profiles/c3-after-cards-10000-*` vs `-after3-*`).
- **C1 regression** (above) — the only behaviour regression found, fixed and gated by the pinned differential.
- **C2 behaviour change** — runtime `config.yaml` edits are no longer observed without a restart; this is pinned
  parity (probe artifact), recorded as a parity fix, not a perf side effect.
- No measured allocation regression remains on any arm. No output/order/Unicode/provider-wire change shipped.

## 7. Claim rules (repeat of targets.md, because reports outlive context)

1. B/op and allocs/op are the claim; they are deterministic. Never report ns/op without every-round separation.
2. Cold and warm are separate rows. CPU and memory are separate rows. **Never report B/op as Peak RSS.**
3. A regression is listed even when the cumulative number improved.
4. Local numbers are Layer A; the release claim cites the Linux `GoTavern smoke metrics` paired gate.
5. `unproven` stays `unproven`: peak RSS, p99 under the real UI corpus, Node control, real-provider latency.

## 8. 8-user concurrency + long-run trend — harness reuse plan (prepared, NOT run)

Reuse rather than write: `tests/perf/m5-eight-users.mjs` already drives ONE real binary, accounts enabled, EIGHT
accounts with the pinned three-step session handshake, overlapping `settings/save`, `settings/get` and `chats/save`
waves, and asserts on-disk per-account markers + no cross-user marker at the end; it records per-route
p50/p95/p99/max and throughput. Run plan for this lane (needs the quiet window and A's real-UI corpus root):

```
# 8 accounts x 6 waves (the harness creates and owns its fresh data root/accounts); --report is the artifact flag
node tests/perf/m5-eight-users.mjs --binary <built gotavern.exe> --report docs/alpha19/perf/raw/eight-users.json
# 60-minute soak over the generated/corpus tree; --data-root/--config are the harness flags, rate 8 req/s
node tools/perf/a18-soak.mjs --binary <built gotavern.exe> --data-root <corpus>/data --config <corpus>/config.yaml \
     --minutes 60 --rate 8 --restart-every-minutes 10 --out docs/alpha19/perf/raw/long-run-soak.json
```

The long-run resource trend comes from the soak's RSS/handle/goroutine samples (its `--minutes 60` run is the
release-qualification shape), and the 8-user row contributes the p99 spread under contention. **Neither has been
run in this lane yet**; no number above is a concurrency measurement, and the older single-user 32/128-in-flight
concurrency mode is NOT a substitute for eight accounts (it cannot exercise cross-account `settingsSaveMu`
contention).
