# alpha.19 hotspot attribution and ranked optimization candidates

**Status: PROFILES CAPTURED, ATTRIBUTION WRITTEN; NO PRODUCT CODE CHANGED.** Every candidate below is backed
by a profile in [`profiles/`](profiles/) whose `.json` beside it records the window, request rows and startup
stage lines. No optimization is implemented until the Lead approves a named, disjoint file list (Subagent B
also edits `internal/**`). This file is the approval input, not a results claim.

Provenance and the baseline reproduction live in [`README.md`](README.md). The measured tree is
`alpha19/program` at `07af095`, whose product code is identical to the baseline commit `52883e8`
(`git diff --name-only 52883e8..07af095 -- internal/ cmd/` is empty). Host: Windows 11 arm64, **2 logical
cores**, Go 1.27.3, shared with two other alpha.19 lanes (both cores ~100% busy during the runs). Allocation
totals are load-independent and exact; CPU *shares* are still meaningful, but `runtime.asyncPreempt` is
inflated by the co-tenancy and is called out wherever it appears.

## 0. How these profiles were produced (so a candidate can be re-tested)

```powershell
# 1. deterministic trees (the same generator internal/server/bench_test.go mirrors)
& a15-fixturegen.exe --out <scratch>\trees\cards-10000 --scale cards --cards 10000 --image-bytes 4096 --card-bytes 2048
# 2. a warm request profile: boot, warm up, THEN start runtime/pprof
& a19profile.exe --mode http --route characters --data-root <tree>\data --config <tree>\config.yaml `
  --out-dir docs\alpha19\perf\profiles --label a19-http-characters-warm-10000 --warmup 1 --requests 3
# 3. a startup profile: runtime/pprof starts BEFORE internal/app.Start; GOTAVERN_STARTUP_TRACE=1 is set
& a19profile.exe --mode startup --data-root <tree>\data --config <tree>\config.yaml --out-dir <dir> --label a19-startup-cold-10000
```

Tools: [`tools/perf/a19profile/`](../../../tools/perf/a19profile/main.go) (in-process, real `internal/app.Start`,
warm-window profiles, startup profiles, SSE relay profiles) and
[`tools/perf/a19-boot.mjs`](../../../tools/perf/a19-boot.mjs) (process-level boot/RSS with a 2 ms readiness
poll). Both are lane tooling, not product code.

## 1. Workload attribution

### 1.1 `/api/characters/all`, 10,000 cards, WARM (3 profiled requests)

Artifacts: `profiles/a19-http-characters-warm-10000-{cpu,heap}.pb.gz`; tops in
`profiles/a19-http-characters-warm-10000-{cpu,alloc-space,alloc-objects}-top.txt`; window record in
`profiles/a19-http-characters-warm-10000.json` (3 requests, 58,887,145 B response each, 13.2 s/request on this
saturated host — the time is a load artifact, the allocation shape is not).

Allocation **objects** (% of `alloc_objects`, focus `serveCharactersAll`; window also contains the startup and
the one cold warmup request, so shares are conservative):

| # | function | flat% | cumulative% | why |
|---|---|---:|---:|---|
| 1 | `strconv.syntaxError` (from the sort comparator's `nodeArrayIndex`) | 24.5% | — | `orderedNodeJSON.entries` asks `strconv.ParseUint` for EVERY key of EVERY object; a non-numeric key allocates a `*NumError` |
| 2 | `encoding/json.(*Decoder).Token` (+ `jsontext.Token.String` 8.2%) | 9.7% | 23.2% | `decodeOrderedNodeJSON` re-parses every card's JSON per request via the generic token decoder |
| 3 | `decodeOrderedNodeJSONValue` (its own slices/maps) | 9.5% | 32.7% | per-object `positions map[string]int` + token boxing |
| 4 | `orderedNodeJSON.entries` (copy + `sort.SliceStable`) | 1.9% + `reflectlite.Swapper` 1.1% | **44.4%** | allocates a copy of the object's entry slice and stable-sorts it for EVERY object, on EVERY marshal |
| 5 | `readFromV2` | 4.6% | 5.8% | 9 `nodeSet`/`nodeUnset` calls per card, each with a `[]string` literal |
| 6 | `internal/stringslite.Clone` | 15.2% | — | string clone inside the json v2 token path (part of the decode above) |

Allocation **bytes** (`alloc_space`, same focus): `bytes.growSlice` **770.5 MB (28.3%)** — the response
`bytes.Buffer` growing geometrically to a 58.9 MB body; `setMember` **188.9 MB (6.9%)** — top-level entry slices
growing as the projection adds members; the decode is **354.7 MB cumulative (13.0%)**; `entries` is **302.7 MB
cumulative (11.1%)** of which `strconv.syntaxError` alone is **149.0 MB**; `io.ReadAll` 179.8 MB is the cold
warmup read and is paid once per process, not per warm request.

CPU (window = 3 requests, 32.4 s of samples; focus `serveCharactersAll` = 21.03 s):

| line | flat% of window | note |
|---|---:|---|
| `runtime.asyncPreempt` | 18.6% | **co-tenant load artifact**, not product CPU |
| `compress/flate.(*fastEncL6).encode` (via `pinnedCompressionMiddleware`) | **13.8%** | gzip of the 58.9 MB response; parity-bound, see §2 "excluded" |
| `writeCharacterJSONString` (characters_json.go:280) | 11.6% | alpha.18's direct escaper; now the second-largest real cost after decode |
| `decodeOrderedNodeJSONValue` + `jsontext.ReadToken` | 16.8% cumulative | per-request card JSON re-parse |
| `crypto/sha1` | 2.4% | session/CSRF work per request, not per card |
| `calculateChatSize`'s `os.ReadDir` | 5.3% (mixed profile; 15.2% of the request path) | 10,000 failed per-card directory opens when a library has no chat dirs |

### 1.2 `/api/characters/all`, 1,000 cards, warm (5 profiled requests)

Same shape, which means it is not a 10,000-only artefact:
`profiles/a19-http-characters-warm-1000-alloc-objects-top.txt` — `strconv.syntaxError` 24.1% flat,
`entries` **43.9% cumulative**, `decodeOrderedNodeJSONValue` 36.8% cumulative; CPU top has gzip 21.4%,
`writeCharacterJSONString` 14.0%. The 100-card row (`profiles/a19-http-characters-warm-100-…`) shows the same
`entries`/decode order, at a scale where fixed per-request work dominates.

### 1.3 Long chat: `/api/chats/get`, one 2,000-message chat (5 profiled requests)

Artifacts `profiles/a19-http-chat-get-2000msg-*` (760 ms of samples over 5 requests, ~163 ms/request under
load, 807,776 B response). `alloc_space`: `bytes.growSlice` 17.3%; `encoding/json/v2.JoinOptions` **9.4%**
(a fresh v2 encoder option set per request); `pinnedChatData` 27.1% cumulative; `marshalNodeJSON` 21.8%
cumulative (generic escaper path); `bytes.Replace` 5.2% (`marshalNodeJSONString`'s two `ReplaceAll` passes per
string); decode of the JSONL 13.7%. This route is healthy in absolute terms; the only attributable waste is
the generic marshal/escaper path (candidate C5) and the per-request encoder options.

### 1.4 Large world book: `/api/worldinfo/get`, one 4 MB world (5 profiled requests)

Artifacts `profiles/a19-http-world-get-4MB-*` (3.08 s samples, ~717 ms/request, exactly 4,194,304 B response).
`alloc_space` (333.85 MB over 6 requests incl. warmup): `bytes.growSlice` **96.0 MB (28.8%)**;
`bytes.Replace` **48.5 MB (14.5%)** with `bytes.ReplaceAll` cumulative 14.5% and `encoding/json.(*Encoder).Encode`
14.4% — the generic `marshalNodeJSONString` path (per-string v2 encoder + two `bytes.ReplaceAll` passes);
`jsontext.decoderState.fetch` 47.6 MB + `Token.String` 24.0 MB + `slices.Grow` 24.0 MB — the ordered-JSON
decode of the 4 MB document; `os.readFileContents` 24.0 MB. CPU: gzip `fastEncL6` **14.3%**,
`jsonwire.AppendQuote` 6.8%, string consumption ~16% cumulative, `sha1block` 4.2% (ETag), `asyncPreempt` 17.5%
(load artifact).

### 1.5 Provider SSE relay and group-chat generation (`/api/backends/chat-completions/generate`)

Artifacts `profiles/a19-relay-stream-small-*` (300 requests, 19.4 ms/request under load, 411 B SSE response)
and `profiles/a19-relay-group-generation-*` (60 requests, 45.7 ms/request, 60-message payload). The relay peer
is an in-process deterministic SSE responder (`tools/perf/a19profile/main.go`), and it defines nothing about
correctness — the provider wire is owned by the committed replay fixtures.

**The largest attributable cost is not the relay at all: it is `config.yaml` being read and YAML-parsed per
request.** Cumulative CPU inside `serveChatCompletionGenerate` (1.06 s of the 5.82 s window):
`pinnedChatConfigSource.value → fileValue → os.ReadFile (0.26 s) + yaml.Unmarshal (0.45 s) = 0.71 s`, i.e.
**67% of the handler's CPU and 18.7% of the whole window**, across ~17 config lookups per request.
`alloc_space` agrees: `gopkg.in/yaml.v3.(*parser).node` 17.5 MB cumulative (22.3%) plus parser buffers, versus
`forwardPinnedChatStream` 8.2 MB (10.5%). The file's own header comment states the intended contract —
"a module-load read and a per-request read agree for a running server, because the pinned server parses
config.yaml once at startup" (`internal/server/pinned_chat_config.go:6-9`) — so the per-request re-read is not
parity, it is the port's own shape.

### 1.6 Startup, 10,000-card tree (cold and warm) — see README §4

`profiles/a19-startup-{cold,warm}-10000-*`. Cold `app.Start` 2,023.8 ms of which
`startup.data-startup` 1,665 ms; warm 874.9 ms of which `startup.data-startup` 560 ms. CPU attribution in the
cold window: `runtime.cgocall` 47.3% (filesystem metadata on a fresh tree) and
`internal/startup.VerifyCharacterDiskCache` 13.7%. This reproduces the alpha.18 root cause (per-card metadata
access, removed per *request* by the cache; the cold boot still verifies the cache on disk). No new
startup-side candidate is proposed here beyond what alpha.18 already shipped.

### 1.7 Negative results (checked, NOT hotspots on this evidence)

- `entry.Info()` in `processCharacterForDirEntry`: 20 ms of a 164.6 s profile — the Windows `os.ReadDir`
  listing metadata is effectively free (alpha.18's claim holds).
- `calculateDataSize`/`javaScriptStringLength`: 1.45 s + 0.84 s of 164.6 s (mixed profile); already the
  allocation-free implementation.
- The card-text cache is effective on repeats and should not be re-touched: warm ≈ 484.7 MB/op vs cold
  ≈ 884.7 MB/op (README §2).
- `os.ReadDir` of the characters root: one call per request; not a hotspot.
- `compress/flate` is expensive (13.8-21.4% of a large-response CPU window) but **excluded** — see §2.

## 2. Excluded on purpose: gzip compression level/algorithm

The gzip share is real and large for the 58.9 MB card list and the 4 MB world response, but changing the level
or algorithm changes the **HTTP-layer observable** (compressed body bytes and length) that the compatibility
work compares, and pinned runs the same default compression. A performance change here would need an explicit
parity decision by the Lead; it is therefore not proposed as a perf-lane optimization.

## 3. Ranked candidates (expected metric, evidence, risk, files)

| # | change | expected metric | risk | files (proposed scope) |
|---|---|---|---|---|
| **C1** | `orderedNodeJSON.entries`: return the object's own entry slice without copying/sorting when no key is an array index; replace `strconv.ParseUint` in `nodeArrayIndex` with a digit-only check that cannot allocate | `/api/characters/all`: **−35..45% allocs/op** (3.19 M → ~1.8-2.1 M), **−25..35% B/op** (619.9 MB → ~420-460 MB/op at 3x; warm ~485 MB → ~300 MB), CPU −5..12% | **low** — output order must stay byte-identical: keep the stable numeric-key-first rule and add a discriminating pin (integer-like keys mixed with insertion keys; `"00"`/`"4294967295"` boundary cases; differential marshal over a corpus) | `internal/server/image_metadata_index.go`; new pin test file `internal/server/a19_perf_pins_test.go` |
| **C2** | Identity-keyed cache of the **parsed** `config.yaml` used by `pinnedChatConfigSource` (validate path+size+mtime like the card/settings caches; environment override evaluated before the file, exactly as today) | generate/relay requests: CPU **−15..25%**, alloc −25..30% in the relay window; lower TTFT for streaming generations | **low-medium** — must preserve env-override precedence and the current "external edit is observed" behaviour (a stat-validated cache does; only the same-size+same-mtime window differs, documented like the other caches) | `internal/server/pinned_chat_config.go` (+ small cache file `internal/server/config_file_cache.go` if approved) |
| **C3** | `calculateChatSize`: take ONE listing of the chats root per request and answer each card from it, falling back to the per-card `os.ReadDir` for a symlink/non-directory entry or a failed root listing | `/api/characters/all` CPU **−10..15%** at 10,000 cards with no chat dirs (8.29 s of `os.ReadDir` in the mixed profile); no allocation or output change | **medium** — the error contract must be reproduced exactly (`errorCharacter` for a non-directory entry; symlink fallback; root-listing failure behaves like today's per-card ENOENT) | `internal/server/characters_card.go` (+ `internal/server/characters_read.go` only if the listing belongs there) |
| **C4** | Pre-size the `/api/characters/all` response buffer from the per-card text lengths already in hand (`bytes.Buffer.Grow`) | `alloc_space` **−8..15%**; removes most of `bytes.growSlice`'s 770.5 MB window share for a 58.9 MB body; small CPU memmove | **low** for semantics (capacity only); must be measured as allocation volume and reported honestly — **never** as Peak RSS; a bad estimate may briefly hold more, so measure and report the trade | `internal/server/characters_read.go` |
| **C5** | Extend the direct, append-based JSON string escaper to the generic `marshalNodeJSONString` path used by worldinfo/chats (today: one v2 encoder + two `bytes.ReplaceAll` per string) | world book get: alloc **−15..20%** (`bytes.Replace` 48.5 MB / 14.5% of that window); chat get: small; CPU small | **medium** — byte-identical requirement; extend the existing differential corpus test (single-byte controls, U+2028/29, astral runes, invalid UTF-8) to the generic escaper | `internal/server/image_metadata_index.go`; pin test in the same new `a19_perf_pins_test.go` |
| **C6** | Identity-keyed cache of the **parsed** card tree with a shallow per-request clone (decode is 32.7-36.8% of objects / 16.8% CPU cumulative) | `/api/characters/all` CPU −10..15%, alloc −10..15% | **high** — mutation aliasing (`readFromV2` mutates), and it raises resident memory by design; needs its own memory measurement and a Lead decision on the trade. Deferred; only after C1 is measured | `internal/server/characters_card_cache.go`, `internal/server/characters_card.go` |
| **C7** | Local allocation hygiene in `finishCharacterProjection`/`readFromV2`: `TrimSuffix` instead of `strings.Replace`, `setMember` instead of 1-element `nodeSet` path slices, preallocate the projection object's entry slice | accumulative single-digit % B/op and allocs/op | **low** | `internal/server/characters_card.go`, `internal/server/characters_format.go` |

Ranking rationale: C1 is the only change whose evidence is a **deterministic** metric (allocation totals) and
whose risk is confined to one function plus a byte-level output pin; C2 is the largest single CPU attribution
after the parity-bound gzip; C3 is a second deterministic CPU win on the same route; C4 and C5 are incremental;
C6 is deferred because it trades memory for CPU and needs a product decision.

## 4. What a candidate must prove before it is reported as an improvement

1. Before/after profile of the same workload, raw `.pb.gz` in `profiles/`, with the before profile being the
   one in this directory (same binary inputs, same host).
2. A same-host ABBA (A,B / B,A / A,B) with cold and warm reported separately, CPU and memory separately; for
   the allocation-deterministic candidates the allocation totals are the claim and time is reported beside
   them, not instead of them.
3. The full semantic oracle: `go test ./internal/server -count=1` plus the provider-wire replay and the
   character read fixtures; for C1/C5 specifically a byte-level JSON-output differential.
4. An explicit regression list, including anything that got worse (memory, cold path, a route not targeted).
5. No change to output order / JSON semantics / Unicode / provider requests / extension events — or the change
   is reverted.

## 5. Open items for the Lead

- **Approve a named, disjoint file list** for C1 (and, if desired, C2/C3/C4/C5) before any product edit. B is
  editing `internal/server` test files only; proposed disjoint scope for this lane:
  `internal/server/image_metadata_index.go`, `internal/server/pinned_chat_config.go`,
  `internal/server/characters_card.go`, `internal/server/characters_read.go`,
  `internal/server/characters_format.go`, `internal/server/characters_json.go` (call site only if needed) and a
  **new** `internal/server/a19_perf_pins_test.go`. No existing test file is touched.
- **A quiet window** (both cores otherwise idle, ~15 minutes) is required for the ABBA latency/RSS half; the
  allocation half can run any time. Please tell me when A and B can pause heavy jobs.
- The **real-UI corpus** path is still pending from the Lead, so the ≥8-user mixed concurrency and long-run
  resource-trend evidence has not started.
