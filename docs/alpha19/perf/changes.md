# alpha.19 performance changes — one record per approved optimization

Every section here is one commit. Each carries the before/after allocation rows (deterministic, load-independent),
the byte-identity proof, the targeted semantic evidence and the explicit regressions. Timing rows are Layer A and
are reported only when the ABBA separation rule holds; the release performance claim stays the Linux
`GoTavern smoke metrics` paired gate. Targets and claim rules: [`targets.md`](targets.md). Hotspot attribution:
[`hotspots.md`](hotspots.md).

## C1 — allocation-free member ordering for the ordered-JSON marshal (commit `<filled at commit>`)

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
