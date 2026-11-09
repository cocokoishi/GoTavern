# alpha.19 performance changes — one record per approved optimization

Every section here is one commit. Each carries the before/after allocation rows (deterministic, load-independent),
the byte-identity proof, the targeted semantic evidence and the explicit regressions. Timing rows are Layer A and
are reported only when the ABBA separation rule holds; the release performance claim stays the Linux
`GoTavern smoke metrics` paired gate. Targets and claim rules: [`targets.md`](targets.md). Hotspot attribution:
[`hotspots.md`](hotspots.md).

## C1 — allocation-free member ordering for the ordered-JSON marshal (commit e7be70f)

**Approved scope:** `internal/server/image_metadata_index.go`, new `internal/server/a19_perf_pins_test.go`.
**What changed:** `orderedNodeJSON.entries` now returns the object's own entry slice when no member key is a
JavaScript array index (JSON.stringify's ordering rule then equals insertion order, so the copy+stable-sort was
an identity permutation); when an index IS present the pre-existing stable sort still runs. `nodeArrayIndex` is
now a digit-only check that cannot allocate, replacing `strconv.ParseUint` + `FormatUint` + the 4294967295
exclusion with an exactly equivalent predicate (a `*strconv.NumError` was allocated for every non-numeric key —
24.5% of the route's allocation objects in the profile).

**Before/after allocation rows** (same command, same host, `GOMAXPROCS=2`, `-benchmem -benchtime=3x -count=1`;
raw before [`raw/alpha18-baseline-inprocess-charactersall.txt`](raw/alpha18-baseline-inprocess-charactersall.txt),
after [`raw/c1-after-inprocess.txt`](raw/c1-after-inprocess.txt)):

| arm | rows | BEFORE B/op | AFTER B/op | B/op change | BEFORE allocs/op | AFTER allocs/op | allocs change |
|---|---|---:|---:|---:|---:|---:|---:|
| `BenchmarkCharactersAllScale/cards_100_128KB_image` | 28,743,157 → 27,957,050 B; 32,860 → 18,465 allocs | 28,743,157 | 27,957,050 | −2.7% | 32,860 | 18,465 | **−43.8%** |
| `cards_1000_32KB_image` | 167,573,736 → 159,709,717 B; 324,973 → 180,969 allocs | 167,573,736 | 159,709,717 | −4.7% | 324,973 | 180,969 | **−44.3%** |
| `cards_10000_4KB_image` | 619,914,794 → 541,274,656 B; 3,193,663 → 1,753,661 allocs | 619,914,794 | 541,274,656 | −12.7% | 3,193,663 | 1,753,661 | **−45.1%** |
| `cards_100_640KB_image` | 90,694,058 → 89,908,144 B; 33,140 → 18,737 allocs | 90,694,058 | 89,908,144 | −0.9% | 33,140 | 18,737 | **−43.5%** |
| `BenchmarkCharactersAllCold` | 879,836,722 → 801,197,144 B; 3,500,332 → 2,060,330 allocs | 879,836,722 | 801,197,144 | −8.9% | 3,500,332 | 2,060,330 | **−41.1%** |

Against [`targets.md`](targets.md): the allocation-count targets were met/exceeded on every arm (T1 allocs
≤2,100,000 → 1,753,661; T2 allocs ≤220,000 → 180,969); the **B/op targets were NOT met** (T1 ≤465 MB →
541.3 MB; T2 ≤130 MB → 159.7 MB). Reported as not met. The residual B/op is dominated by the per-card JSON
decode and the response buffer, which C1 does not touch (C4 addresses the buffer; the decode is deferred as
C6). The `ns/op` columns are omitted on purpose: the before run was made while other lanes pinned both cores at
100% (4,827 ms at 10,000 cards) and the after run on a less loaded host (2,154 ms); that difference is host
load, not the change, and no timing claim is made without the ABBA separation rule.

**Byte-identity proof** (`internal/server/a19_perf_pins_test.go`, run with `-count=1`):
- `TestA19OrderedJSONFastPathMatchesNodeStringify` — 18 ordering vectors whose expected bytes are the recorded
  output of `JSON.stringify(JSON.parse(doc))` on the pinned Node runtime (v24.19.0), covering mixed integer-like
  and insertion keys, ascending numeric order, leading zeros, the `4294967294`/`4294967295`/`4294967296`
  boundary (with discriminating vectors where the boundary key is NOT first), look-alike keys, empty/space
  keys, Unicode keys, nesting, arrays of objects and duplicate-key parses.
- `TestA19EntriesFastPathMatchesReferenceBytes` — the PRE-CHANGE implementation is kept in the test file
  (copy + stable sort + `ParseUint` predicate) as the reference; both the character-domain writer and the
  generic ordered-JSON writer are compared byte-for-byte against it over 21 torture documents, including
  `undefined`-member omission.
- `TestA19NodeArrayIndexMatchesReference` — the fast predicate against the `ParseUint` predicate over the
  boundary/key-shape corpus (`""`, `"0"`, `"007"`, `"4294967295"`, `"4294967296"`, `"10000000000"`, signs,
  whitespace, non-ASCII digits, NUL).
- `TestA19CharactersAllResponseBytesMatchReferenceForGeneratedLibraries` — at **1 / 100 / 1,000 / 10,000**
  generated cards, the `/api/characters/all` RESPONSE bytes equal both the production marshal and the reference
  pre-change writer over the nodes the route projects (cards carry a fixed `chat`/`create_date`, so the
  response is deterministic for the tree). Measured runtime: 0.03 s / 0.50 s / 5.03 s / 15.10 s (20.67 s total,
  Windows arm64; most of it is writing the 10,000-card tree).

**Teeth** (observed, then restored; transcript [`profiles/c1-mutation-teeth.txt`](profiles/c1-mutation-teeth.txt)):
| mutation | observed red |
|---|---|
| treat `4294967295` as an array index | `TestA19OrderedJSONFastPathMatchesNodeStringify/boundary_4294967295_is_not_an_index`, `TestA19EntriesFastPathMatchesReferenceBytes/doc_06`, and `TestA19NodeArrayIndexMatchesReference` naming `nodeArrayIndex("4294967295") = (4294967295, true), reference = (0, false)` |
| array-index keys no longer move ahead of insertion keys | `TestA19OrderedJSONFastPathMatchesNodeStringify/{mixed_keys,numeric_ascending,leading_zeroes,array_index_boundary,boundary_4294967294_is_an_index,unicode_keys,array_of_objects}` and `TestA19EntriesFastPathMatchesReferenceBytes/doc_{02,03,04}` |
Both mutations compiled, failed by assertion name, and the file was restored from a byte copy with the SHA-256
verified identical (`380354846BAE2393…`) afterwards.

**Semantic regression:** targeted subset green (66.7 s):
`go test ./internal/server -run 'TestA19|TestCharactersAll|TestCharacterCardCache|TestCharacterJSONStringEncoding|TestChatCompletionGenerateMatchesProviderWireCapture' -count=1`.
**Full-package caveat:** `go test ./internal/server -count=1` timed out at the 2400 s package bound in
`TestBackendsTextgenGenerateStreamsWithoutBuffering` (39 m 18 s, blocked on a nil-channel receive inside
`internal/outbound.sendWireExactStreaming`); the same test passes isolated in 0.02 s and the hang is in the
text-completion streaming path, which C1 does not touch (C1 changes ordered-JSON member ordering only). The
timeout is being classified against a clean worktree; the full-suite green is **not yet claimed**.

### C1 follow-up — the `entries()` contract regression, found by the full suite and fixed

The full suite (after C4/C5 and the streaming fixes) finished in 237 s with **exactly one failure**:
`TestPinnedNodeImageMetadataCleanup`. Bisect in a clean `52883e8` worktree (only the named files swapped in):
baseline **PASS**; +`image_metadata_index.go`@C1 **FAIL**; +C4 files **PASS**; +C5 file (contains C1) **FAIL** —
so C1 caused it. The route kept `"../escape.webp":{"hash":"remove-outside"}` in `images` where pinned removes it.

**Root cause:** `entries()` used to return a defensive COPY for objects. C1's fast path returns a read-only VIEW
of the object's own member slice, which is correct for every read-only caller — but `image_metadata_cleanup.go`
iterates `images.entries()` and calls `deleteImageMetadataKey(&images, key, index)` INSIDE the loop, and
`deleteMember` shifts the shared backing array under `range`, so members were skipped. Pinned iterates
`Object.keys(...)`, a snapshot, so the faithful translation is a private snapshot.

**Call-site audit** (`entries()` has 13 call sites; all others are safe): read-only marshals/iterations —
`characters_json.go` (writeCharacterJSON), `image_metadata_index.go` (marshalOrderedNodeJSON,
marshalPrettyOrderedNodeJSON lives in image_metadata_folder_create.go, serveBackgroundFolders),
`characters_write.go` (writeCharacterJSONIndent), `deepseek_chat.go` (pinnedJSONStringifyIndent4),
`sd_generate_comfy.go` (sdComfyOutputValues), `characters_format.go` (convertWorldInfoToCharacterBook),
`openai_models.go` (spreadWithModelID builds a NEW object), `backends_textgen_generate.go` (builds a NEW object),
`image_metadata_all.go` (builds a NEW object), `image_metadata_folder_delete.go` (replaces VALUES in place; no
length change) — and `image_metadata_cleanup.go` (the ONLY structural mutation of the same object during
iteration). The function now documents the read-only contract, and the cleanup loop snapshots.

**Teeth:** removing the snapshot line again turns `TestPinnedNodeImageMetadataCleanup` red on its named assertion
(`cleanup index after mixed`); restoring the line is green. Transcript:
[`profiles/c1-cleanup-fix-teeth.txt`](profiles/c1-cleanup-fix-teeth.txt), SHA-256 of the restored file verified
identical. The pinned differential test is the gate; the regression cannot return silently.


## C4 — pre-sized response buffer for `/api/characters/all` (commit 6509639)

**Approved scope:** `internal/server/characters_read.go`, `internal/server/characters_json.go`.
**What changed:** `serveCharactersAll` accumulates `3*cardTextBytes + 512` per listed card from the `json_data`
string it already holds, and `marshalCharacterJSONPreallocated` calls `bytes.Buffer.Grow` with that estimate
before the same `writeCharacterJSON` walk. Capacity only: no byte of output changes, proven by the route-level
byte-equality test below.

**Calibration of the estimate** (measured response bodies, [`raw/boot-cards-*.json`](raw/)): 10,000 cards /
2 KB text → 58,887,196 B = 2.88× the text; 1,000 cards / 8 KB text → 23,296,711 B = 2.84×; 100 cards / 8 KB text
→ 2,329,662 B = 2.84×. The first attempt used `2*len + 2048`, which UNDER-estimated the 8 KB-card rows
(18.4 MB reserve for a 23.3 MB body) and therefore paid one geometric growth: it **regressed** the 1,000-card
arm by +3.1% B/op (159,709,717 → 164,674,989). That row is kept as [`raw/c4-attempt1-2x-estimate-inprocess.txt`](raw/c4-attempt1-2x-estimate-inprocess.txt).
The shipped estimate `3*len + 512` reserves 5-8% above the measured bodies and removes the growth.

**Before/after allocation rows** (C1 is the "before" for this change; baseline-before-both is in the C1 section;
raw after [`raw/c4-after-inprocess.txt`](raw/c4-after-inprocess.txt)):

| arm | C1 B/op | C4 B/op | C4 change | C1 allocs/op | C4 allocs/op |
|---|---:|---:|---:|---:|---:|
| `cards_100_128KB_image` | 27,957,050 | 24,181,629 | **−13.5%** | 18,465 | 18,448 |
| `cards_1000_32KB_image` | 159,709,717 | 134,470,965 | **−15.8%** | 180,969 | 180,950 |
| `cards_10000_4KB_image` | 541,274,656 | 406,486,229 | **−24.9%** | 1,753,661 | 1,753,641 |
| `cards_100_640KB_image` | 89,908,144 | 83,169,664 | **−7.5%** | 18,737 | 18,726 |
| `BenchmarkCharactersAllCold` | 801,197,144 | 666,431,621 | **−16.8%** | 2,060,330 | 2,060,316 |

**Cumulative C1+C4 against the pre-change baseline:** 10,000 cards 619,914,794 → **406,486,229 B/op (−34.4%)**
and 3,193,663 → **1,753,641 allocs/op (−45.1%)**; 1,000 cards 167,573,736 → **134,470,965 (−19.8%)**, allocs
324,973 → 180,950 (−44.3%); 100 cards 28,743,157 → 24,181,629 (−15.9%); cold 10,000 879,836,722 → 666,431,621
(−24.2%). Target check: T7 asked for window alloc_space −8% with no peak-RSS regression; the allocation half is
met, the **peak-RSS half is UNPROVEN** until the process-level ABBA (the reserve is a transient capacity of
~5-8% above the body, so a small peak-RSS movement is possible and must be measured, not assumed).

**Byte identity:** `TestA19CharactersAllResponseBytesMatchReferenceForGeneratedLibraries` compares the route's
response at 1/100/1,000/10,000 cards against both the production marshal and the pre-change reference writer
(the reference path uses a plain, un-sized `bytes.Buffer`), so a capacity hint that changed one emitted byte
would fail there. Green. Also green: the whole targeted oracle subset
`go test ./internal/server -run 'TestA19|TestCharactersAll|TestCharacterCardCache|TestCharacterJSONStringEncoding|TestChatCompletionGenerateMatchesProviderWireCapture' -count=1` (61.75 s).

**Regressions reported:** the earlier `2*len + 2048` estimate row (+3.1% on 1,000 cards) is kept as evidence
above and was replaced, not hidden. No other arm regressed in the shipped estimate.

## C5 — one escaper for the generic ordered-JSON routes (commit 65834ec)

**Approved scope:** `internal/server/image_metadata_index.go`; the C5 pin lives in
`internal/server/a19_perf_pins_test.go`, and `internal/server/characters_scale_optimization_test.go` was changed
only to keep its differential honest (see below — the reason is required by the approval and repeated in the
commit message).
**What changed:** `marshalNodeJSONString` — the string encoder behind `marshalOrderedNodeJSON`, i.e. world info,
chats and image metadata — used to build an `encoding/json` v2 encoder and run **two `bytes.ReplaceAll` passes**
over each encoded string. It now calls the alpha.18 direct, append-based escaper `writeCharacterJSONString`,
which was differentially pinned to exactly that encoder output (single-byte controls, `\b\t\n\f\r`, quote and
backslash, U+2028/U+2029 emitted raw, invalid UTF-8 replaced by U+FFFD).

**Why an existing test file changed:** `TestCharacterJSONStringEncodingMatchesReference` used
`marshalNodeJSONString` as its reference for `writeCharacterJSONString`. After C5 both are the same code, so that
comparison would pass for any implementation and could never fail. The pre-change encoder implementation is now
kept as `a19ReferenceMarshalNodeJSONStringEncoder` in this lane's pin file, the old test calls it, and a new
`TestA19GenericEscaperMatchesEncoderReference` runs the same encoder reference over the alpha.18 corpus plus
quote/backslash/HTML/control-heavy documents, CJK, emoji, lone-surrogate bytes and 4 KB strings.

**Before/after allocation windows** (same harness, same generated trees, same host; windows are startup + one
warmup + 5 profiled requests, focus on the handler; raw `.pb.gz` and top tables under
[`profiles/c5-*-{world-get-4MB,chat-get}*`](profiles/)):

| workload | window alloc_space BEFORE | window alloc_space AFTER | change | the removed line |
|---|---:|---:|---:|---|
| `/api/worldinfo/get`, one 4 MB world (6 requests) | **331.43 MB** | **256.46 MB** | **−22.6%** | `bytes.Replace` 48.02 MB (14.49%) → **0**; `marshalNodeJSONString` cumulative 71.1 MB → 7.6 MB |
| `/api/chats/get`, one 2,000-message chat (6 requests) | **149.71 MB** | **115.45 MB** | **−22.9%** | `bytes.Replace` 14.35 MB (9.58%) → **0**; `encoding/json/v2.JoinOptions` 12.0 MB → 2.0 MB; `marshalNodeJSONString` cumulative 48.6 MB → 7.6 MB |

Against [`targets.md`](targets.md): T8 asked for allocation −15% on the 4 MB world GET with a byte-identical
response — met (−22.6%), and the response bytes are unchanged because the escaper is byte-equivalent by
construction and by the two differential tests. The remaining bytes are the ordered-JSON decode and the response
buffer, which C5 does not touch.

**Regressions:** none measured on the two windows. The generic escaper is also used by the character-domain key
writer (`writeCharacterJSONString` is unchanged) and by `marshalOrderedNodeJSON` callers; the C1 route bytes and
the provider-wire replay remain the guard, and the targeted oracle subset was re-run green (55.8 s for the C5 pin
set + JSON tests).

## C3 — one chats-root listing per `/api/characters/all` request (commit e39cf18)

**Files:** `internal/server/characters_card.go` (listing + fallbacks), `internal/server/characters_read.go` (one
listing per request), `internal/server/a19_perf_pins_test.go` (equivalence + root-failure tests).
**What changed:** pinned's `calculateChatSize` performs `fs.readdirSync(chatsRoot/name)` for EVERY card. The route
now takes ONE `os.ReadDir(chatsRoot)` and answers a card from it, with these EXACT fallbacks so the classification
cannot change: an exact name hit that is a directory still goes through the same per-entry stat loop; a symlink or
non-directory entry falls back to the old `calculateChatSize` (ENOTDIR/ErrNotExist classification preserved); a
failed root listing falls back per card; a missing root (ENOENT) answers 0,0 for every card whose directory is
inside the root, because the old per-card call would also have returned ENOENT; and on case-insensitive platforms
(Windows/macOS) an exact miss consults a case-folded map first, so a differently-cased directory is still resolved
by the old path rather than reported absent. A name that appears twice under folding falls back. Per-request
value; never cached.

**Before/after CPU profile** (same 10,000-card tree, same harness; before = worktree at `65834ec`, after = the C3
tree; both windows are startup + 1 warmup + 3 profiled requests, focus `serveCharactersAll`):

| measurement | BEFORE (`65834ec`) | AFTER (C3) | note |
|---|---:|---:|---|
| `calculateChatSize` / `calculateChatSizeForRequest` cumulative CPU | **1.21 s of 5.24 s samples (23.1%)** | **0.08 s of 10.88 s samples (0.74%)** | the request no longer opens 10,000 directories |
| `os.ReadDir` cumulative CPU | 1.27 s (24.2%) | 0.12 s (1.1%) | the remaining 0.12 s is the one root listing plus the two cards that really have chat directories |
| `runtime.cgocall` share (filesystem syscalls) | 25.6% | 2.5% (this window) | host load differed between the two runs; the shares above are the claim, not absolute ms |

**First cut rejected (recorded, not hidden):** the first C3 version fell back to the per-card `os.ReadDir` on every
exact miss to be safe about case-insensitive filesystems. On a library whose chats root is an EMPTY directory every
card is a miss, so the profile still showed `calculateChatSize` at ~14.5% of the window and the optimization bought
nothing. The shipped version decides the miss without a syscall (case-folded lookup on case-insensitive platforms,
containment-checked 0,0 otherwise). Artifacts: `profiles/c3-before-cards-10000-*`,
`profiles/c3-after-cards-10000-*` (rejected first cut), `profiles/c3-after3-cards-10000-*` (shipped).

**Allocations** (deterministic, same command): 10,000 cards 406,486,229 → **403,148,557 B/op (−0.8%)** and
1,753,641 → **1,733,652 allocs/op (−1.1%)** (removing 10,000 failing opens removes their `*PathError` allocations);
1,000 cards 134,470,965 → 134,135,309 B/op; 100 cards 24,181,629 → 24,124,301; cold 10,000 666,431,621 →
663,713,360. No arm regressed. Response bytes are unchanged by construction and pinned by the equivalence test.

**Equivalence test** `TestA19ChatListingMatchesPerCardReads` builds a tree with: two cards whose chat directories
contain two JSONL files each (asserts the exact `chat_size` sum and `date_last_chat` maximum), one card whose chats
entry is a FILE (platform-dependent classification — the test asserts EQUALITY with the per-card path, not a fixed
count, because Windows maps the failed open to ErrNotExist while Linux answers ENOTDIR), one differently-cased
directory (Windows resolves it, Linux does not), and six cards with no chat directory. It asserts the route
response, the listing projection and the per-card projection are byte-identical.
`TestA19ChatListingFallsBackWhenTheChatsRootCannotBeListed` pins the failed-root branch by making the chats path a
FILE and asserting the listing reports `ok=false` and the projection equals the per-card path.




## C2 — parse the runtime config.yaml once per process (commit 8a993e8)

**Files:** `internal/server/pinned_chat_config.go` (per-path parsed-document cache) and the C2 tests in
`internal/server/a19_perf_pins_test.go`. No new production file.

**What changed:** the provider-facing config reader (`pinnedChatConfigSource`) re-read and re-YAML-parsed
config.yaml on EVERY `getConfigValue` call, several times per chat-completion request. It now parses each resolved
candidate path once and caches the PARSED document for the process lifetime, which is what pinned does
(`getConfig()`: `if (CACHED_CONFIG) return CACHED_CONFIG`, `src/util.js:61-73`). The environment override is still
evaluated before the file on every call, and unreadable/malformed files still fall through to the next candidate, so
the precedence and fallback order are unchanged.

**THIS IS A PARITY FIX, NOT ONLY A PERF WIN.** The old per-request read meant GoTavern observed a config.yaml edit
made while the server was running; pinned does not. Probe `tools/perf/a19-pinned-config-refresh.mjs` (+ artifacts):

| leg | pinned (`c2-pinned-config-refresh.json`) | GoTavern PRE-C2 (`c2-gotavern-before.json`) | GoTavern POST-C2 (`c2-gotavern-after.json`) |
|---|---|---|---|
| 1. boot with `x-a19-probe: baseline` | `baseline` | `baseline` | `baseline` |
| 2. MUTATE config.yaml to `mutated` while running, same request | **`baseline`** | **`mutated`** | **`baseline`** |
| 3. control: restart with the mutated config | `mutated` | `mutated` | `mutated` |
| verdict | STARTUP-ONLY | RUNTIME RE-READ (divergence) | STARTUP-ONLY (pinned parity) |

The observed value is the outbound provider request header `x-a19-probe`, read from `requestOverrides` — a key
pinned resolves through `getConfigValue` at REQUEST time (`src/additional-headers.js:203`), so a stale leg 2 shows
the whole document is cached, not merely a module-load constant. Leg 3 in every run makes the probe non-vacuous:
it proves the mutated value WOULD be observed by a fresh process. The GoTavern legs drive the kobold generate route,
which builds its provider request through `pinnedApplyRequestOverrides` → `pinnedChatConfigValue`, the function this
commit caches.

**CPU profile** (relay mode, 300 profiled requests + 20 warmup, same `trees/base`; before = worktree at `2e10ef3`):

| measurement | BEFORE (pre-C2) | AFTER (C2) |
|---|---:|---:|
| `pinnedChatConfigSource.fileValue` cumulative CPU | **0.29 s of 1.25 s samples (23.2%)** | not in the top list; `value`/`boolValue` **10 ms of 780 ms (1.28%)** |
| `gopkg.in/yaml.v3` parser cumulative CPU | ~9.6% + the parse helpers (each 0.8-4.8%) | absent from the top list |
| window duration | 1.17 s | 766 ms |

The absolute window durations are load-dependent and are not the claim; the cumulative shares and the disappearance
of the YAML parser from the profile are. Artifacts: `profiles/c2-before-relay-*`, `profiles/c2-after-relay-*`.

**Behaviour change (recorded, not sneaked):** mutating config.yaml while GoTavern runs no longer changes
provider-visible values; a restart is required, exactly as in pinned. This is asserted by
`TestA19PinnedChatConfigIsStartupOnlyLikePinned` (read → mutate file → read again must return the startup value; a
cleared cache then returns the mutated value, proving the file really changed) and
`TestA19PinnedChatConfigEnvironmentOverrideWinsEveryRead` (the `SILLYTAVERN_<KEY>` override still wins on every
call, including after the document is cached). **Teeth:** replacing the cache lookup with a per-read bypass turns
the first test red on its named assertion (`read after mutating config.yaml = "runtime-value", want
"startup-value"`); restoring the lookup is green, SHA-256 verified.

**Regressions:** none measured. Allocations are unchanged by construction for the card routes (the cache only
touches config reads); the config-sensitive targeted set is green (`requestOverrides`, `pinnedChat*`, tokenizer
remote, claude/google/openai media, chat backup, characters oracle — 37 matched tests, 4.5 s). The 13 other
`entries()`-era contracts are unaffected. **Not claimed:** ns/op (host load), and the cache is process-wide, so a
test that rewrote the SAME config path mid-process would now observe the first parse — no such test exists in the
tree (searched; the runtime-config tests build a fresh path per case).