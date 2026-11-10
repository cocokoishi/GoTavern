# alpha.20 hotspot attribution and ranked candidates

**Status: PROFILES CAPTURED AND ATTRIBUTED; the ONE approved hotspot is implemented in
[`changes.md`](changes.md).** Every candidate below is backed by a profile in [`profiles/`](profiles/) whose
`.json` beside it records the window, request rows and startup stage lines. The host is the Windows arm64
development host (2 logical cores), shared with the other alpha.20 lanes during the capture; the raw profile
set and the load record are [`profiles/HOST-AND-LOAD.md`](profiles/HOST-AND-LOAD.md).

## 0. Harness attribution caveat (applied before any claim)

`tools/perf/a19profile` boots the real server and drives it with its own HTTP client. That client reads each
response body with `io.ReadAll`, so a large share of `alloc_space` in a large-response window is the HARNESS,
not the server: 630 MB of the 10,000-card window and 39.8 MB of the 4 MiB world window are harness reads. Those
rows are named as harness allocation and excluded from product attribution. The allocation claim surface is the
in-process benchmark (`BenchmarkA20Marshal*`, server only), not a profile's total.

## 1. Workload attribution at `7d1178e`

### 1.1 `/api/characters/all`, 10,000 cards, warm (3 profiled requests, 58,887,241 B response)

`profiles/a20-http-characters-warm-10000-*`. CPU: `asyncPreempt` 17.1% (co-tenant load artefact),
`compress/flate` 18.1% (parity-bound — pinned compresses the same bytes at the HTTP layer), `writeCharacterJSONString`
14.25% cumulative, `crypto/sha1` 4.6%. `alloc_space`: `bytes.growSlice` 253.9 MB, `setMember` 203.0 MB,
`decodeOrderedNodeJSONValue` 349.7 MB cumulative, `strings.Builder.WriteByte` 88.2 MB. No safe new hotspot inside
the do-not-rewrite ordered-JSON decode in this round; the response path already carries alpha.18/19's changes
(no measured regression found).

### 1.2 `/api/worldinfo/get`, one 4 MiB world book (3 profiled requests, 4,194,304 B response)

`profiles/a20-http-world-get-4MB-*`. `alloc_space` (4 requests incl. warmup): `bytes.growSlice` 64.0 MB
(35.9%), `io.ReadAll` 39.8 MB (22.0%, HARNESS readback), `jsontext.decoderState.fetch` 31.2 MB,
`os.readFile` 16.0 MB, `Token.String` 16.0 MB. CPU: `asyncPreempt` 20.9% (load), `compress/flate` 16.6%
(parity-bound), `writeCharacterJSONString` 10.8%. **This is where the marshal's per-node buffers showed up**: the
old `marshalOrderedNodeJSON` allocated a fresh `bytes.Buffer` per object/array and a fresh `[]byte` per string,
and every nested result was copied into its parent.

### 1.3 `/api/chats/get`, one 2,000-message chat (3 profiled requests, 807,776 B response)

`profiles/a20-http-chat-get-2000msg-*`. `alloc_space`: `bytes.growSlice` 16.2 MB, `io.ReadAll` 10 MB (harness),
`pinnedChatData` 25.9 MB cumulative, `jsontext.decoderState.fetch` 6.7 MB, `Token.String` 3.1 MB. The same
per-node-buffer cost appears in the marshal of the assembled chat document.

### 1.4 Provider SSE relay (`/api/backends/chat-completions/generate`, 300 small requests)

`profiles/a20-relay-small-*`. `alloc_space`: `forwardPinnedChatCompletionStream` 13.4 MB flat (25.9%),
`bytes.growSlice` 10.5 MB, `bufio.NewWriterSize`/`NewReaderSize` ~4.5 MB. CPU is dominated by `cgocall` (54%),
which is the in-process peer and client network syscalls in this harness, not product CPU. **Second candidate,
deferred**: the relay forwarder's per-request buffers are real, but the Lead's sequencing rule is one merged
hotspot at a time, so this stays measured and unmodified.

### 1.5 Startup, 10,000-card tree

`profiles/a20-startup-cold-10000-*`: `app.Start` 1.27 s, CPU `runtime.cgocall` 51% (filesystem metadata on a
fresh tree), `startup.VerifyCharacterDiskCache` 31.4% cumulative, `statisticsTarget.recompute` 53.4% cumulative.
**Deferred**: parallelising the verification is a startup-semantics change with a real ordering/error-path risk,
and the alpha.20 round already ships one hotspot; it is recorded here as the next startup candidate rather than
attempted without its own profile pair.

## 2. Excluded on purpose

- **gzip level/algorithm** (13.8-18.1% of large-response CPU): changing it changes the HTTP-layer observable that
  pinned parity compares, and pinned runs the same default; a parity decision, not a perf-lane choice.
- **Parsed card-tree cache (alpha.19 C6)**: rejected by the Lead as the "cache everything in memory" trap before
  it was measured; it trades resident memory for CPU and needs a product decision.
- **The ordered-JSON DECODE**: `do-not-rewrite` per `GOAL.md` §15.4; the marshal is a different function with a
  frozen byte-identity corpus.

## 3. Ranked candidates

| # | change | expected metric | risk | state |
|---|---|---|---|---|
| **H1** | ordered-JSON marshal: one doubling append buffer instead of a `bytes.Buffer` per node and a `[]byte` per string; optional size hint from the world file length | world-get B/op −40..50%, allocs/op −55..60%; chat B/op −50%, allocs/op −60% | low-medium: byte identity is guarded by a frozen pre-change golden (15 documents × 4 hints + 9 strings) and the pinned differential | **IMPLEMENTED, measured in [`changes.md`](changes.md)** |
| H2 | relay forwarder per-request buffers | relay alloc/req | medium: stream framing is byte-sensitive | deferred (Lead sequencing) — profile kept |
| H3 | startup disk-cache verification parallelism | startup wall time | medium: ordering and error-path semantics | deferred — profile kept |
| H4 | characters-all projection/decode | 10k B/op | high: do-not-rewrite decode and a large call-site surface | rejected this round |

## 4. What a claim may say

1. B/op and allocs/op are the claim; they are deterministic and were identical across repeated runs of one binary
   (A/A row in [`changes.md`](changes.md)).
2. ns/op was NOT separable on this co-tenant host: the before binary's own rounds spanned 269-1,473 ms on the
   same input, and the after rounds 259-425 ms. The change is reported as an allocation win with the wall-clock
   direction stated as not separable, never as an invented speed multiplier.
3. Process-level effect (p50/p95 and RSS of `/api/worldinfo/get` on the real binary) is the ABBA window's job;
   its result goes in [`changes.md`](changes.md) only when it exists.
