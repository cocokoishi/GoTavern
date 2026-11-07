# Alpha.17 niche suites — new-test evidence

Status: implemented and executed on the Windows host (`windows/arm64`, Go 1.27.3) as **Layer A** evidence.
The Linux CI gate (`GoTavern CI` → `verify` → `go test ./...`) has **not** run this branch yet; a local
green is not a CI verdict (AGENTS.md working mode). Every row below names the exact command and the
observed result on this host.

Base: `HEAD c02eed109ceba32ba710948a0420425f8ce58b1f` plus **new untracked files only** (no existing file,
fixture, product file or workflow was modified). Working tree at time of writing:
`tests/e2e/niche_support_test.go`, `niche_fs_test.go`, `niche_data_test.go`, `niche_http_test.go`,
`niche_streaming_test.go`, `niche_persistence_test.go`, `niche_teeth_test.go`, this document.

Test volume: **33 new top-level test functions**, **5 of them containing 5 named crash-stage subtests**, plus
one teeth test that proves **20 planted defects** are caught by name — 38 named live cases + 20 controls.

Scenario IDs: `docs/alpha17/niche-scenario-catalog.md` does not exist in this tree; another lane published
`docs/alpha17/catalog/01-fs.md` (status PROPOSED) while this round was running. That proposal uses the same
`FS-001..FS-010` IDs and the same test names/lines for the filesystem domain, so this document cites those
IDs directly. **One row of that proposal is stale and needs its owner's correction:** FS-009 says "junction
resolving outside the user root is refused" — the measured product behaviour is that the junction is
FOLLOWED (pinned `fs` semantics; see the FS-009 row and bring-up finding 1), and this round's test was
corrected to pin the measured behaviour. `DATA/HTTP/SSE/PE/TEETH` IDs are introduced by this round (no
other catalogue rows existed for them at the time of writing).

**SHARED-TREE WARNING (read before trusting the binaries driven here).** The lane works in a shared
checkout. During these runs another lane added `internal/server/cors_proxy.go` / `cors_proxy_test.go` and
modified `internal/server/routes_registry.go` / `routes_registry_test.go` (visible in `git status`; **not
this lane's files and not touched by it**). The harness builds `cmd/gotavern` from the working tree, so the
binaries these results describe include those in-flight changes. The test files and this document are the
only files this lane wrote; a CI run after the other lane's changes land (or on an isolated worktree) is
required before these greens are a verdict on a pinned tree.

Harness reuse: every live case boots the REAL `cmd/gotavern` binary through `tests/e2e/harness_test.go`
(`bootServerIn`, `openSession`, `requireProductionTransport` is enforced by the package's existing guard
tests), writes through the product routes (`/api/settings/save`, `/api/settings/get`, `/api/chats/save`,
`/api/chats/get`, `/api/secrets/write`), and asserts on the **filesystem bytes** as well as the HTTP
response. The crash matrix reuses `buildFaultBinary`/`importBody`/`postTolerantJSON` and the
`-tags gotavern_faults` seam from `chat_crash_harness_test.go`; the streaming cases reuse
`tests/mockprovider` and the recorded DEEPSEEK driver body/seam from `deepseek_generate_test.go`, so the
request sent is the captured one (`driverBody` re-checks the capture's sha256).

## Commands and actual results

| # | command | result on this host |
|---|---|---|
| 1 | `go vet ./tests/e2e` | exit 0, no output (run twice: before and after the final edits) |
| 2 | `go test ./tests/e2e -run 'TestNicheFS\|TestNicheData\|TestNicheHTTP' -count=1 -v` | first run **FAIL**: 3 defects found in the NEW tests during bring-up (junction behaviour, 204 Content-Length, Go client following a redirect). All three were test defects, fixed, see "Bring-up findings" |
| 3 | `go test ./tests/e2e -run 'TestNicheFS\|TestNicheHTTP' -count=1` | `ok github.com/cocokoishi/gotavern/tests/e2e 86.756s` |
| 4 | `go test ./tests/e2e -run 'TestNicheData\|TestNicheTeeth' -count=1` | first run: 19/20 planted defects; one mutation was mis-worded (a test defect in the teeth table, fixed). After the fix `TestNicheTeeth` → `PASS`, log line `[teeth] 20/20 planted defects produced their NAMED red …` |
| 5 | `go test ./tests/e2e -run 'TestNicheStreaming' -count=1 -v` | `ok github.com/cocokoishi/gotavern/tests/e2e 25.968s`, 4/4 PASS (first attempt failed 4/4 because the provider key was not written; see bring-up) |
| 6 | `go test ./tests/e2e -run 'TestNichePersistence' -count=1 -v` | first run: PE-001 3/3 PASS (18.18 s), PE-002 0/2 (helper fatal on the expected transport error — test defect), PE-003 failed (control import path wrong — test defect). After fixes: PE-002 2/2 PASS (9.80 s), PE-003 `PASS (7.02s)` |
| 7 | `go test ./tests/e2e -run 'TestNicheData\|TestNichePersistence' -count=1` | `ok github.com/cocokoishi/gotavern/tests/e2e 80.019s` (final green for both domains in one invocation) |
| 8 | `go test ./tests/e2e -run 'TestNicheFS\|TestNicheData\|TestNicheHTTP' -count=1 -v` | second full run after fixes: data domain PASS (the only failure was the Windows empty-array race sample, then pinned as a recorded host finding); FS/HTTP re-run as command 3 |
| 9 | `go test ./tests/e2e -run 'TestNicheDataConcurrentChatReadWhileWritingIsNeverTorn' -count=1 -v` | `PASS (5.60s)` with `race: reads=71 old=36 new=35 empty-array-reads=0 non-complete=0 saveFailures=0` |
| 10 | `go test ./tests/e2e -run 'TestNicheTeeth' -count=1 -v` | `PASS (0.00s)` `20/20` |

The whole new suite was measured at ≈ **210 s** on this host across the domain invocations (≈35 real binary
boots; each boot ≈5 s because the harness rebuilds the binary into the per-test install root). That is over
the original ~3-minute budget target for a single CI invocation; see "Residual risk / unexecuted".

## Domain A — filesystem / path extremes (`tests/e2e/niche_fs_test.go`)

| ID | test (file:line) | scenario | assertions (comparators) | negative control |
|---|---|---|---|---|
| FS-001 | `TestNicheFSCJKEmojiAndZeroWidthChatNamesRoundTrip` (niche_fs_test.go:33) | save/read chats named `对话记录`, `chat🚀😀`, `zero​width` | status, exact body == product-written JSONL array (`nicheCheckBody`), marker present (`nicheCheckContains`), 3 distinct files | TEETH-01/02/03 message order/drop/extra use the same `nicheCheckOrderedChat`; `wrong-body` uses `nicheCheckBody` |
| FS-002 | `TestNicheFSNFCAndNFDNamesAreDistinct` (:76) | NFC `café` vs NFD `café` must be two chats | 2 directory entries, each reads back its own marker | same `nicheCheckBody`/`nicheCheckContains` controls |
| FS-003 | `TestNicheFSLongReservedAndTraversalNamesStayContained` (:123) | 300-byte name, reserved `CON`, `../escape` | truncation ≤255 bytes, no separator in derived name (`nicheCheckFilenameContained`), reserved write refused, nothing beside the card dir | TEETH-18 unsafe-derived-filename |
| FS-004 | `TestNicheFSExternalAtomicReplaceIsObservedOnNextRead` (:194) | external temp+rename of settings.json and a chat file | new bytes served, old marker gone (`nicheCheckContains`/`nicheCheckNotContains`); chat body exact | TEETH-15/16 cache-identity; wrong-body |
| FS-005 | `TestNicheFSSettingsCacheSameSizeSameMtimeResidualIsPinned` (:248) | same size + restored mtime is the documented residual; moving mtime clears it | `nicheCheckCacheIdentity(stale=true)` and `(stale=false)`, exact served body, marker absent/present | TEETH-15/16 (both directions) |
| FS-006 | `TestNicheFSUnknownFileAndFieldsSurviveSaveReloadRestart` (:305) | unknown binary file, unknown settings member, unknown chat member across restart | file bytes equal, settings marker present, exact chat body, JSONL valid | TEETH-04 unknown-member-dropped, TEETH-09 corrupted JSONL |
| FS-007 | `TestNicheFSEightSessionsCreateChatsWithoutLoss` (:361) | 8 concurrent sessions create 8 chats | 8 files, each exact body and marker | same body/marker controls |
| FS-008 | `TestNicheFSSymlinkedSettingsFileIsFollowedForReadAndReplacedOnWrite` (:425) | symlinked settings.json: read follows, atomic rename replaces the link | served target bytes; external target unchanged; `Lstat` is not a symlink | **DECLARED SKIP on this Windows host** (`os.Symlink` → "A required privilege is not held by the client"); runs on Linux CI. Portability note below |
| FS-009 | `TestNicheFSJunctionOutsideTheUserRootIsFollowed` (:465) | Windows junction where a chat will be written | save 200, file lands in junction target, read-back marker, JSONL valid | Windows-only (declared skip on Linux). The first assertion was written as "must be refused" and the run showed the product FOLLOWS a junction (pinned fs semantics); the test was corrected to pin the measured behaviour — see bring-up findings |
| FS-010 | `TestNicheFSSettingsUnknownMembersAndOrderArePreserved` (:504) | unknown settings members + key order across save/reload/restart | first/last member index order, exact served == on-disk document, 3 members after restart | `nicheCheckBody` wrong-body control |

## Domain B — JSON / JSONL extremes (`tests/e2e/niche_data_test.go`)

| ID | test (file:line) | scenario | assertions | negative control |
|---|---|---|---|---|
| DATA-001 | `TestNicheDataZeroByteAndWhitespaceSettingsAreRefusedWithoutLoss` (niche_data_test.go:33) | `""` and `"   \n\t "` settings bodies | 400 (`nicheCheckStatus`), file unchanged, previous marker still served | wrong-status control |
| DATA-002 | `TestNicheDataBOMSettingsBodyRefusedAndOnDiskBOMPreserved` (:59) | BOM body refused; BOM already on disk served raw | 400; on-disk served string has the U+FEFF prefix and marker | wrong-status / content-missing controls |
| DATA-003 | `TestNicheDataDuplicateJSONKeysLastValueWins` (:96) | `{"dup":"first","dup":"second"}` | `dup == "NICHE-DATA-003-SECOND"`, `"first"` absent | TEETH-13 wrong-settings-value |
| DATA-004 | `TestNicheDataNullFalseZeroSettingsRoundTrip` (:113) | null/false/0/""/[]/{} | each member raw JSON equal (`nicheCheckMember`) | TEETH-14 wrong-member-value |
| DATA-005 | `TestNicheDataHugeIntegersAndFloatsFollowJavaScriptSemantics` (:138) | 2^53+1 and a 19-digit decimal | re-emitted `9007199254740992` / `1.2345678901234567` (float64/JS semantics) | member-mismatch control |
| DATA-006 | `TestNicheDataDeepNestingPreservedAt1000AndRefusedAt10000` (:159) | depth 1000 accepted, 10000 refused | 200 then 400, stored document unchanged after refusal | wrong-status + content-missing |
| DATA-007 | `TestNicheDataHugeStringAndUnknownFieldsSurvive` (:183) | 1 MiB string + unknown nested object | byte length and bytes preserved; member equality | member-mismatch |
| DATA-008 | `TestNicheDataChatJSONLEdgeLines` (:213) | CRLF, missing final newline, empty middle line, truncated final line, BOM first line, duplicate keys, JS-falsy lines, zero-byte | exact array body per case (`nicheCheckBody`), product-written file lines all valid JSON (`nicheCheckJSONLLines`) | TEETH-09 corrupted-jsonl; TEETH-08 wrong-body |
| DATA-009 | `TestNicheDataConcurrentChatReadWhileWritingIsNeverTorn` (:267) | reader loop vs 8 alternating chat saves | every 200 response is exactly old XOR new; both observed; no non-complete body | TEETH-10/11 stream controls; `[]` host finding recorded separately (below) |

## Domain C — HTTP boundaries (`tests/e2e/niche_http_test.go`)

| ID | test (file:line) | scenario | assertions | negative control |
|---|---|---|---|---|
| HTTP-001 | `TestNicheHTTPMethodMatrixAndResponseShape` (niche_http_test.go:95) | GET/HEAD/POST/PUT/DELETE on `/version`, GET on `/api/chats/get`, missing CSRF | status, Content-Type/ETag/security headers, HEAD body empty + same Content-Length, wrong methods answer **404 not 405**, 403 has CSP `default-src 'none'` | TEETH-05/06/07 |
| HTTP-002 | `TestNicheHTTPJSONBodyShapes` (:174) | malformed JSON, array, number, string, null, empty body, `{}` | 400 + `text/plain` + `Bad Request`; 200 + `application/json` + `{}` | status/header/body controls |
| HTTP-003 | `TestNicheHTTPCSRFBoundaries` (:220) | missing, wrong, duplicate token header, tampered session cookie, duplicate session cookie | 403/403/403/403, valid 200, duplicated cookie 200 | status control |
| HTTP-004 | `TestNicheHTTPCORSAndPreflight` (:277) | OPTIONS no Origin, `Origin: null`, foreign origin; GET with `Origin: null` | 204, `Allow-Methods: OPTIONS`, ACAO only for `null`, no Content-Length on 204, Vary contains Origin | TEETH-06/07 header controls |
| HTTP-005 | `TestNicheHTTPStaticValidatorsRangesAndEmbeddedResidual` (:329) | disk static asset (seeded under `installRoot/public`) and embedded `/script.js` | 200 body, ETag/Last-Modified/Accept-Ranges/Cache-Control, HEAD, `Range 0-3` → 206 + `bytes 0-3/20`, beyond → 416 + `bytes */20`, stale If-None-Match → 200, future If-Modified-Since → 304, embedded 206 with **no ETag** (recorded residual) | header/status/body controls |
| HTTP-006 | `TestNicheHTTPPathEncodingsAndTraversalRefusals` (:428) | `/version/`, `//version`, `/%76ersion`, duplicate query, `..` via `%2F` and `%2e%2e` | 404, 307 + Location, 200 JSON, duplicate query body equals single, 403 text/plain `Forbidden`, 404 for the root static escapes | status/header/body controls |

Body-limit ±1 byte: **UNEXECUTED** (see below).

## Domain D — SSE/streaming torture (`tests/e2e/niche_streaming_test.go`)

| ID | test (file:line) | scenario | assertions | negative control |
|---|---|---|---|---|
| SSE-001 | `TestNicheStreamingChunkBoundariesAndFrameContentAreByteExact` (niche_streaming_test.go:64) | one frame split across 3 chunks, 2 frames in 1 chunk, UTF-8 rune split, CRLF split, multiline/comment/event-id, invalid+empty data (no `[DONE]`), all through the PRODUCTION transport against `tests/mockprovider` | each leg: status 200, exact bytes (`nicheCheckStreamBytes`), one provider request per leg, provider body digest recorded | TEETH-10 truncated-stream-frame / TEETH-11 invented-stream-tail |
| SSE-002 | `TestNicheStreamingUpstreamTruncationForwardsPartialBytesThenEndsOnCancel` (:160) | provider aborts mid-stream (`TruncateAfterFrames`) | partial prefix exact, response stays open until client cancel, **no bytes after cancel**, server alive afterwards | stream comparators |
| SSE-003 | `TestNicheStreamingClientCancelAbortsTheUpstreamRequest` (:226) | client cancel on a held-open stream | peer observes `ClientDisconnected` (`nicheCheckCancelPropagation`), no test-process goroutine leak (`nicheCheckGoroutines`), server alive | TEETH-12 cancel-not-propagated, TEETH-19 goroutine-leak |
| SSE-004 | `TestNicheStreamingUpstreamErrorStatusIsForwarded` (:318) | streaming request, provider answers 503 + JSON body | status 503, exact body, one request | status/body controls |

Goroutine scope: the server is a SUBPROCESS, so `runtime.NumGoroutine` measures only the test process. The
server-side release is asserted through the peer's `ClientDisconnected` and post-cancel liveness; this is a
scope limitation, not a full leak proof (see residual risk).

## Domain E — persistence fault injection (`tests/e2e/niche_persistence_test.go`)

| ID | test (file:line) | seams exercised | assertions | negative control |
|---|---|---|---|---|
| PE-001 | `TestNichePersistenceSettingsSaveCrashStages` (niche_persistence_test.go:159) + 3 subtests | `atomicReplace.after-temp-write`, `.after-temp-sync`, `.after-rename` on `/api/settings/save` | exact OLD (first two) / exact NEW (rename) document; `nicheCheckCrashState`; dot-prefixed scratch present for the temp stages; no non-dot scratch; other user's tree unchanged; restart serves the crashed bytes and a later save works | `nicheCheckCrashState` partial-crash control (TEETH-17); exact-body control |
| PE-002 | `TestNichePersistenceChatSaveCrashStages` (:252) + 2 subtests | `chats.save.before-write`, `chats.save.after-write` | OLD / NEW exact chat, JSONL valid, no non-dot scratch, restart unchanged and readable | TEETH-09/17 |
| PE-003 | `TestNichePersistenceChatImportCrashStage` (:338) | `chats.import.after-write` | control import proves the route reaches the writer; crash leaves a complete imported file, JSONL valid, restart readable, no non-dot scratch | JSONL/content comparators |

Seams with **no** seam, recorded instead of faked: settings-save body-read/validation (no stage), settings
BACKUP snapshot write (timer-scheduled, no per-stage seam), group-chat append path (`chats.group.save.after-write`
exists but no case in this round; **UNEXECUTED**).

## Negative controls (`tests/e2e/niche_teeth_test.go`, TEETH-01..20)

`TestNicheTeeth` first proves **every comparator is silent on correct data** (22 checks), then plants 20
defects and requires each to be caught by its NAMED assertion through the SAME function the live tests use:

| ID | mutation | named red |
|---|---|---|
| TEETH-01 | messages reordered | `message-order-swapped:` |
| TEETH-02 | message dropped | `message-dropped:` |
| TEETH-03 | extra message | `message-extra:` |
| TEETH-04 | unknown member missing from served document | `content-missing:` |
| TEETH-05 | wrong status | `status-mismatch:` |
| TEETH-06 | wrong header | `header-mismatch:` |
| TEETH-07 | header that must be absent is present | `header-unexpected:` |
| TEETH-08 | wrong body | `body-mismatch:` |
| TEETH-09 | corrupted JSONL line 2 | `jsonl-invalid:line-2` |
| TEETH-10 | truncated stream | `stream-truncated:` |
| TEETH-11 | invented stream tail | `stream-frame-mismatch:` |
| TEETH-12 | cancel did not propagate | `cancel-not-propagated:` |
| TEETH-13 | wrong settings string value | `settings-value-mismatch:` |
| TEETH-14 | wrong raw member value | `member-mismatch:` |
| TEETH-15 | documented cache residual no longer served | `cache-identity-mismatch:` |
| TEETH-16 | stale body served after a real edit | `cache-identity-mismatch:` |
| TEETH-17 | partial crash document | `crash-state-partial:` |
| TEETH-18 | derived filename carries a separator | `unsafe-filename:` |
| TEETH-19 | goroutine leak | `goroutine-leak:` |
| TEETH-20 | required file missing | `file-missing:` |

Result line: `[teeth] 20/20 planted defects produced their NAMED red through the same comparators the live
niche tests use`.

## Mutation evidence for representative LIVE assertions (edit → red by name → restore → green)

Each row mutated a value in the NEW test file (never product code, never an existing file), ran the exact
test with `-count=1`, captured the named failure, restored the value with the editor, and re-ran green.

| # | mutation | command | observed red (verbatim) | restored |
|---|---|---|---|---|
| 1 | DATA-008 CRLF expectation reordered to `[b,a]` | `go test ./tests/e2e -run 'TestNicheDataChatJSONLEdgeLines' -count=1 -v` | `niche_data_test.go:250: body-mismatch: chats/get crlf: got 25 bytes "[{\"mes\":\"a\"},{\"mes\":\"b\"}]", want 25 bytes "[{\"mes\":\"b\"},{\"mes\":\"a\"}]"` → `--- FAIL` | `--- PASS: TestNicheDataChatJSONLEdgeLines (5.29s)` |
| 2 | HTTP-001 expected `X-Frame-Options: DENY` | `go test ./tests/e2e -run 'TestNicheHTTPMethodMatrixAndResponseShape' -count=1 -v` | `niche_http_test.go:117: header-mismatch: GET /version: X-Frame-Options = "SAMEORIGIN", want "DENY"` → `--- FAIL` | `--- PASS: TestNicheHTTPMethodMatrixAndResponseShape (5.20s)` |
| 3 | SSE-001 leg-2 expected body replaced with leg-1's | `go test ./tests/e2e -run 'TestNicheStreamingChunkBoundariesAndFrameContentAreByteExact' -count=1 -v` | `niche_streaming_test.go:135: stream-frame-mismatch: two frames in one chunk: the delivered bytes diverge from the provider's bytes (got "data: {\"n\":1}\n\ndata: {\"n\":2}\n\n", want "data: {\"text\":\"split frame\"}\n\n")` → `--- FAIL` | `--- PASS: TestNicheStreamingChunkBoundariesAndFrameContentAreByteExact (5.31s)` |

No mutation remains in the tree (the final `go vet` and the final green runs above were produced after the
restores; `git status` shows only the new files listed at the top).

## Product defects found (reported, NOT fixed)

### DEF-001 — a settings body containing a JSON number that overflows float64 is refused (400) where pinned accepts it and stores `null`

- **Minimal reproducer (real binary, default data root):**
  1. boot the shipped binary as the harness does (`bootServerIn`), open a session (`GET /csrf-token`),
  2. `POST /api/settings/save` with `Content-Type: application/json`, valid cookie + `X-CSRF-Token`, body
     `{"f":1e400}`.
- **GoTavern (measured 2026-11-07, this host):** `400 Bad Request`, body `Bad Request`; settings.json is not
  written.
- **Pinned oracle:** `src/endpoints/settings.js:209` writes
  `writeFileAtomicSync(pathToSettings, JSON.stringify(request.body, null, 4), 'utf8')`. Node's
  `JSON.parse('{"f":1e400}')` produces `Infinity` and `JSON.stringify` emits `{"f":null}` (verified on
  Node v24.19.0: `1e400 parsed: Infinity stringified: {"f":null}`). So pinned answers `{"result":"ok"}`
  and stores `{"f": null}`.
- **Consequence:** a settings document the pinned server accepts (and the frontend can produce only through
  a hand-edited/imported file, since `JSON.stringify` on the browser side already turns Infinity into null)
  is refused by GoTavern. User-visible only for imported/edited settings; not silently corrupted — the
  refusal is safe.
- **Not fixed** (per lane rule). This is a **body-parser/JSON-decoder range difference**, not a data-safety
  bug. A test pins the current Go status only where the case is runnable without ambiguity; DATA-006 records
  the deep-nesting refusal separately and no test enshrines DEF-001 as "correct".

### Recorded behaviour differences, not counted as defects

- **Deep nesting 10000:** GoTavern refuses at parse time (400); pinned's `JSON.parse` succeeds and
  `JSON.stringify` throws `RangeError: Maximum call stack size exceeded` (Node verified), which the pinned
  handler catches and passes to `response.send(err)`. Both refuse the document; the statuses differ. Pinned's
  status was not captured (no oracle run in this round), so this is **not** claimed as a parity defect.
- **Windows junction:** a user-created junction inside the data tree is FOLLOWED by the product writer
  (measured 200 + file in the junction target), which matches pinned's `fs` semantics. The first version of
  FS-009 asserted a refusal; the run refuted that assumption and the test was corrected to pin the measured
  behaviour. No product change requested.
- **Windows concurrent-read empty chat:** under an in-flight atomic save, the server's own chat reader can
  hit a Windows sharing race; pinned's `getChatData` maps a read error to `[]`, so `/api/chats/get` answered
  `[]` twice in 43 reads in one run (`empty-array-reads=2`). This is the same host class the A15 reader case
  records (`docs/local-red-triage.md`, `a15_reader_during_write_test.go`), it is a pinned fallback rather
  than a torn byte sequence, and DATA-009 records it on Windows while **failing** on non-Windows hosts, where
  rename-over-open cannot produce it.

## Bring-up findings (test defects caught by running, all fixed)

1. **FS-009 assumed a refusal that does not happen.** The first run failed with
   `the product wrote a chat through a junction resolving outside the user root`. The product follows the
   junction (pinned `fs` semantics); the assertion was rewritten to pin the measured behaviour.
2. **HTTP-004 assumed `Content-Length: 0` on a 204.** The run showed `Content-Length = ""`: `net/http`
   strips the header on a bodyless 204. The case now asserts the header is absent.
3. **HTTP-006 let Go's client follow the 307.** `//version` came back 200 because the default client followed
   the redirect. Added `nicheDoNoRedirect` (a copy of the session client with `CheckRedirect`) and the case
   now asserts `307 + Location: /version`.
4. **SSE-001..004 were 400 `{"error":true}`** because the DEEPSEEK secret was never written; fixed by calling
   the harness's `writeSecret` after boot, the same step the browser performs.
5. **PE-002 fataled on the expected transport error** because the save helper calls `t.Fatalf` on a dropped
   connection; added `nicheSaveChatTolerant` for the crash request only.
6. **PE-003 assumed the import file name.** `/api/chats/import` generates
   `<character> - <humanized timestamp> imported.jsonl`; the case now runs an unarmed CONTROL import first,
   finds the generated file, and only then arms the seam.
7. **TEETH message-order mutation was mis-worded** (used `m0` against JSON strings), so it produced
   `message-dropped:`; fixed to permute the correct JSON values; 20/20 after.

## Portability notes (Linux CI vs this Windows host)

- Paths/temp dirs: all cases use `t.TempDir()`, `filepath.Join` and the harness's release-shaped install
  root. No hardcoded paths.
- Network: loopback only; the dev harness sets `Proxy: nil` on its clients; the mock provider binds
  `127.0.0.1:0`. No live network, no pinned Node, no browser.
- **FS-008 (symlink):** runs on Linux CI; **DECLARED SKIP** on this Windows host because `os.Symlink`
  returns "A required privilege is not held by the client". The skip message names the reason, so the Linux
  gate is the place this row is proven.
- **FS-009 (junction):** Windows-only by definition (junctions are NTFS reparse points); **DECLARED SKIP**
  on Linux. Proven on this host.
- **DATA-009:** empty-array reads are tolerated + logged on Windows and fatal on other hosts; the
  old-XOR-new invariant is asserted everywhere.
- No POSIX-only file semantics are assumed by the other cases. `SanitizeUserFilename` is host-independent
  (it reproduces the JS library's Windows reserved-name rules on every host), which is why FS-003's `CON`
  refusal is asserted cross-platform.
- CI workflow that will run these tests: `GoTavern CI` → job **`verify`** → `go test ./...` (the package is
  `tests/e2e`; the frozen baseline `v0.1.0-alpha.16` product commit is `c1886d70…`, and this change touches
  test files only).

## Residual risk / UNEXECUTED

1. **Linux CI has not run this branch** — the only verdict in this document is the Windows Layer A run.
2. **Full second determinism pass of the complete new suite was not run** under the environment's resource
   cap. Individual domains and the three mutated tests were re-run at least twice
   (FS/HTTP: two full passes; data: two full passes; streaming: one full green pass + three targeted re-runs;
   persistence: one full green pass + targeted re-runs; teeth: two passes). A single `go test ./tests/e2e
   -run TestNiche -count=1` full-suite run is the next thing to do in CI.
3. **Body-limit ±1 byte is UNEXECUTED.** Both limits found in the code are `500 << 20` bytes
   (`internal/server/settings_save.go:13 settingsSaveBodyLimit`, `internal/server/files_sanitize.go:15
   pinnedBodyParserLimit`); sending limit+1 would transfer 500 MiB per request, far outside the runtime
   budget. The limit is recorded from source, not exercised. A smaller seam/fixture would be needed to test
   the 413 branch.
4. **No 405 case exists by design**: GoTavern reproduces Express's final-404 stack, so wrong methods answer
   404 (asserted), not 405. A future route-level method gate would change this observable.
5. **Streaming goroutine leak is only measured in the test process**; the subprocess servers' goroutines are
   not observable portably (no `/proc` on Windows, no handle-count portability). The peer's
   `ClientDisconnected` plus post-cancel liveness are the server-side observables used.
6. **Settings backup snapshot stage and the group-chat append seam are UNEXECUTED** (see PE section).
7. **The 1e400 divergence (DEF-001) needs a product decision**; this round records it and does not fix it.
