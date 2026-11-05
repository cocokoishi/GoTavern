# The alpha.15 audit: what the gates could not see, and what now fails

This is the structured ledger `GOAL.md` §1c (alpha.15) requires: one row per audited surface, with the
behaviour a user observes, the upstream basis for it, the Go implementation, the test that exercises it, the
workflow that runs that test, what the assertion actually checks, whether the assertion has been shown able
to fail, and an honest state. It is a RECORD OF A ROUND, not a second scorecard: user-question states stay in
`docs/goal-scorecard.md`, and where a row here changes one of those states the row says which.

Baseline: SillyTavern `1.19.0`, pinned commit in `upstream/SILLYTAVERN_COMMIT`. The pinned checkout is
read-only and every "upstream basis" cell below is a file:line in it or a probe of it.

## 1. Method, and the rule that made this round different

Seven lanes audited disjoint areas against the same rule: **prove the gate can fail before trusting it.**
Each lane had to produce, for every gate it added or changed, a planted defect that made a NAMED assertion
go red, then restore the code by file copy (never `git checkout` on an untracked path) and show the same
assertion green with `-count=1`. A mutation that survived was treated as a suspect assertion first and a
suspect product second — three did survive and all three were test defects, which is recorded in the rows.

Every lane also had to distinguish what it could NOT do. The two recurring boundaries are stated once here
rather than repeated in forty rows: this host is Windows/arm64, so Linux-only semantics (POSIX read-only
directories, symlinked data roots, `EFBIG` via `RLIMIT_FSIZE`) run in Linux CI and are declared skips on the
host; and reproducing real `ENOSPC` needs a privileged small mount, which the round's operating rule forbids,
so it is recorded `unproven (policy: no elevation)` rather than approximated.

## 2. Summary

| measure | count |
|---|---|
| audit areas | 7 (comparators/gates; filesystem+persistence+migration; provider/HTTP/streaming; browser semantics; long-lived corpora; performance; CI+release machinery) |
| surfaces with a ledger row in this file | 80 |
| gates/tests added or hardened | 65 = 40 new Go test functions in committed lane files + 8 new browser/harness scripts + 9 new workflow steps + 8 release-verifier rails |
| false-green holes closed | 16 (each reproduced against the OLD code and shown red against the new; two of them were defects in the NEW gates, found by running those gates during qualification: the coverage rule reading the working directory instead of the commit, and the soak comparator excusing one costume of the drive's own stop signal) |
| product defects fixed | 2 (both in the provider transport, both reproduced before the fix) |
| mutations observed red, then restored green | 41 (lane A 9, B 10, C 6, D2 7, E 5, G 4) |
| gates added to `docs/release-manifest.json` | 2 workflows / 3 rails (required job, fixed-name artifact, embedded evidence) |

The two product defects are the only product-code changes this round apart from the measured optimization in
§5. That is the intended shape: an audit that finds real defects fixes them and leaves mature code alone
(`GOAL.md` §15.4).

## 3. The ledger

State values: `proven` (a gate exists, has teeth, and runs in CI at this commit's lineage), `partial` (a gate
exists but one half is unmeasured, with the half named), `unproven` (no gate; named next step), `blocked`
(cannot be executed under the round's operating rules), `inherited-pinned-behaviour` (pinned does the same
thing, recorded so an operator can see it).

### 3.1 Comparators, gates and the negative controls (lane A)

| ID | behaviour (行为) | upstream basis | product implementation | existing test | CI | assertion | negative control | state | next |
|---|---|---|---|---|---|---|---|---|---|
| A15-01 | every committed browser comparison artefact is checked by exactly one checker | n/a (harness contract) | `tools/verify-browser-comparisons.mjs`, `tools/browser-evidence/coverage.mjs` | `node tools/verify-browser-comparisons.mjs` | `ci.yml` browser-evidence | each `*-comparison.json` has one checker (catalogue, verifier surface or declared external workflow whose file/step/command still exist); 30 catalogued / 40 committed all claimed | a `zzz-unclaimed-comparison.json` copy: OLD exit 0 "coherent", NEW exit 1 naming it; deleting the group-chat workflow step is red by name | proven | keep; a new artefact with no checker is now a red |
| A15-02 | a verifier that checked nothing cannot report success | n/a | same | new `evidenceFloorProblems()` | `ci.yml` browser-evidence | empty file / empty catalogue / 0 checked / fewer than 25 committed artefacts are all refused | emptied catalogue: OLD green, NEW red | proven | keep |
| A15-03 | a declared pinned baseline is actually read | pinned commit file | same | `pinnedBaselineProblems()` | `ci.yml` browser-evidence | every declared `pinnedBaseline`/provenance commit or revision equals the pin; an undeclared surface is an explicit observation, not a pass | 40-hex-zero baseline: OLD green, NEW red naming `pinnedBaseline` | proven | keep; undeclared surfaces listed in the verifier output |
| A15-04 | guard sets are two-way (a guard cannot appear or vanish silently) | n/a | same | `guardSetProblems()` with pinned optional/excused allowlists | `ci.yml` browser-evidence | asset/helper/helper-generation/helper-variables: a recorded guard no checker reads is refused, and a required guard removed is refused; allowlists cannot go stale | `guards.mysteryGuard:true` added: OLD green, NEW `guards.mysteryGuard is recorded but NO checker reads it`; deleting `bothLegsCompleted` red | proven | keep |
| A15-05 | a self-test footer cannot claim more coverage than it computes | n/a | `tests/browser/streaming-framing-selftest.mjs` | itself | `ci.yml` browser-evidence (new step) | coverage computed FROM the comparator source: 37 cases / 34 guards; a footer claiming "every guard" without the computed numbers is refused | planted fake guard: red by name; deleted coverage section: red | proven (F15 closed) | keep |
| A15-06 | same for the regex comparator | n/a | `tests/browser/regex-gate-selftest.mjs` | itself | `ci.yml` browser-evidence | 17/17 guards expected by a case | fake guard red; missing coverage section red | proven (F15 closed) | keep |
| A15-07 | an empty extension corpus cannot PASS | n/a | `tests/browser/compare-extension-corpus.mjs` | `extension-corpus-selftest.mjs` case 13 | `third-party-extension-compat.yml` | 0 extensions: NEW exit 1 / FAIL with `expected-set-declared` and `corpus-recorded-extensions` | OLD exit 0 / verdict PASS / failed [] vs NEW FAIL | proven | keep |
| A15-08 | freshness treats `{}` and `null` as STALE | n/a | `tools/browser-evidence/freshness.mjs` | new pure cases | `ci.yml` browser-evidence | kind:"empty", identical:false | two empty documents used to read FRESH | proven | keep |
| A15-09 | `driveSupported:false` exemptions are pinned | n/a | `tools/browser-evidence/other-surfaces.mjs` | `a15-verifier-coverage-selftest.mjs` | `ci.yml` browser-evidence | the reviewed `DRIVE_EXEMPTIONS` allowlist; stale/moved/extra exemption is red | moved exemption red | proven | keep |
| A15-10 | the tokenizer comparison's three outcomes are named | n/a | `tokenizer-comparator-selftest.mjs` | itself | `ci.yml` browser-evidence | outcomes named by the self-test (F15c) | fake guard red | proven | keep |

Vacuity classes with no row (they have no committed artefact to point at) are recorded in §6: artefacts carry
no head SHA / workflow / run id / mode, so a class-6 run-id check is impossible without adding provenance to
every surface.

### 3.2 Filesystem, persistence, migration and startup (lane B)

| ID | behaviour (行为) | upstream basis | product implementation | existing test | CI | assertion | negative control | state | next |
|---|---|---|---|---|---|---|---|---|---|
| B-01 | a chat killed mid-write on disk is complete-old or complete-new | pinned uses `write-file-atomic` (`src/endpoints/chats.js`) | `internal/startup/content.go` `atomicReplace` | `tests/e2e/chat_crash_*` (pre-existing) | `ci.yml` verify | exact byte equality with old XOR new; restart serves it | pre-existing M-mutations | proven (kept) | none |
| B-02 | a settings save killed mid-write leaves a complete document | pinned settings save is one atomic document | `startup.SaveSettings` → `atomicReplace` | new `TestRuntimeSettingsWriteKilledMidWriteKeepsACompleteDocument` | `ci.yml` verify | file ∈ {old bytes, `FormatSettingsJSON(new)`}; parseable; a non-dot `.tmp` is red; restart GET returns the surviving bytes | M2: first trigger was too weak and the mutation SURVIVED (kill landed after the write); strengthened to mid-size + immediate kill + 64 MB body, then a prefix-publish mutation gave `neither the complete old nor the complete new document (33554455 bytes)` | proven | none |
| B-03 | corrupt user data does not stop boot or get rewritten | pinned `tryParse`+filter (`src/endpoints/chats.js`) | startup does not touch chats | new `TestBootDoesNotRewriteCorruptUserData` | `ci.yml` verify | `/version` reachable; every planted file sha256/bytes identical; valid control chat readable; worlds listed by filename; corrupt settings returned verbatim | M4: a startup "repair" writing `[]` made six named files red (`... was REWRITTEN by the boot`) | proven | mixed-shape JSONL sample not covered |
| B-04 | corrupt world JSON neither stops boot nor is rewritten | pinned worldinfo tolerant read | worldinfo read path | same test | `ci.yml` verify | bytes identical + both files listed | same M4 | proven | huge world / invalid UTF-8 variant |
| B-05 | corrupt `settings.json` is not rewritten | pinned settings document replacement | `settings_get` returns file text | same test | `ci.yml` verify | boot alive + bytes identical + raw text preserved | same M4 (no separate settings mutation) | proven | optional dedicated mutation |
| B-06 | legacy group metadata migration backs up a corrupt chat before rewriting | pinned `src/endpoints/groups.js:22-97` (copyFile → header → atomic write) | `internal/startup/group_metadata.go` | new `TestLegacyGroupMetadataMigrationBacksUpCorruptChatBeforeRewriting` | `ci.yml` verify | backup bytes == original corrupt bytes; rewrite parseable with `chat_metadata` header; deprecated key gone, name/chats kept | behaviour is pinned parity; no dedicated mutation this round | proven + inherited-pinned-behaviour | product decision: a louder `.corrupt` copy beside the internal backup |
| B-07 | two real processes on one data root do not tear settings | pinned has no cross-process lock; atomic writes = last writer wins | flock + `atomicReplace` | new `TestTwoProcessesOneDataRootSettingsWritesStayWhole` | `ci.yml` verify | final == one writer's complete `FormatSettingsJSON`; both processes read disk; each request inside the 10 s lock budget | M9: non-atomic publish → `round 0: settings.json is not either writer's complete document` | proven | chat same-file case B-08 |
| B-08 | same for a chat `.jsonl` | as B-07 | chat save atomic replace | new `TestTwoProcessesOneDataRootChatWritesStayWhole` | `ci.yml` verify | final == expected A/B bytes; every line `json.Valid` | shares M9's mechanism | proven | run M9 against the chat path too |
| B-09 | lock acquisition is bounded | AGENTS rule 24; P0-B record | `internal/lockacquire` | new `lockacquire_test.go` (4 tests) | `ci.yml` verify | contended lock within a 300 ms boot budget: wait ≤ ~1.05 s, `*BusyError` names purpose/path; expired budget refuses immediately; released lock reacquirable | M1: `Bound()` ignoring the budget → `Acquire waited 10.0003668s for a lock with a 300ms boot budget` | proven | two-process startup race is covered by `startup_p0b_test.go` |
| B-10 | an external preset edit invalidates the settings cache | `GOAL.md` §15.3 identity-key contract | `internal/server/settings_cache.go` (path+mtime+size) | new `TestExternalPresetEditInvalidatesTheSettingsCacheUnlessIdentityIsRestored` | `ci.yml` verify | same size + NEW mtime ⇒ B visible, A not; restoring mtime keeps B (documented residual) and never shows C; mtime change shows C | M5: identity ignoring mtime → `a same-size external edit with a NEW mtime was NOT visible through settings/get` | proven | the same-size+same-mtime residual is documented, not closed |
| B-11 | an interrupted migration leaves the source byte-identical and is re-runnable | `docs/INSTALLATION.md` §6 (source read-only) | `internal/migrate` copyTree/copyConfig/verifyCopy | new `TestInterruptedMigrationKeepsTheSourceUnmodifiedAndReruns` | `ci.yml` verify | source census identical after the interruption AND after the recovery run; recovery exits 0; migrated install serves the source marker | M3: move-instead-of-copy survived the first version (census only once); adding the post-recovery census killed it (`re-running ... failed: exit status 2`) | proven | migration destination remains non-atomic by documented design |
| B-12 | `migrate --force` keeps a bootable old runtime | `internal/migrate` `DestBackupName` contract | conflict → rename → backup | new `TestForceMigrationBackupIsABootableOldRuntime` | `ci.yml` verify | backup settings bytes equal; backup contains `config.yaml`; the backup BOOTS and serves the old marker; new target serves the source marker | M8: `RemoveAll` instead of rename → `did not move the old runtime into .../.migrate-backup` | proven | round-trip re-migration |
| B-13 | a data root with spaces/CJK/emoji is the root written and served | pinned `DATA_ROOT` semantics | `commandline/paths.go`, `app/server.go` | new `TestDataRootWithSpacesUnicodeAndEmojiIsCreatedAndServed` | `ci.yml` verify | named root exists; save lands under it with the marker; install root holds only binary + config | M6: resolver pointed at a sibling root → `the write did not land under the named data root` | proven | Windows 260-char and trailing-space cases |
| B-14 | a config path with spaces/CJK is honoured | pinned `--configPath` semantics | same | new `TestConfigPathWithSpacesUnicodeAndEmojiIsHonoured` | `ci.yml` verify | resolved directory used; save lands; no second data tree under the install root | shares M6 | proven | corrupt-config + odd-path combination |
| B-15 | a symlinked data root works through the link | pinned startup does not refuse symlinks | path resolution | new `TestSymlinkedDataRootServesAndWritesThroughTheLink` | Linux CI only | link and target read the same settings with the marker | not runnable on Windows (symlink requires privilege; declared skip with reason, and no elevation is allowed) | partial (Windows skip) | run and then add teeth on Linux |
| B-16 | a read-only user directory refuses the write without damage | `GOAL.md` §14.5 | `atomicReplace` temp-creation failure → non-200 | new Linux-only `a15_readonly_linux_test.go` | Linux CI only | control write 200; after chmod the save is non-200 and bytes unchanged; no unmarked temp; after chmod back 200 with the new marker | Linux-only by build tag, declared | partial (Windows skip) | teeth after the first Linux green |
| B-17 | readers during a save see old XOR new | pinned atomic rename | `atomicReplace` rename | new `TestReadersDuringASaveSeeOnlyCompleteDocuments` | `ci.yml` verify (POSIX assertion) | a PARTIAL observation is the FIRST assertion; vacuity guard requires a new doc observed; POSIX-only "save failures must be 0"; final disk == expected and GET serves it | M10: prefix publish → `a reader observed a PARTIAL settings document (3 sample(s) ... 131093 bytes)` | proven on Windows measurement + Linux assertion | Windows measurement recorded: saves=12 saveFailures=0 reads=213 oldReads=15 newReads=197 readErrors=1 partialSamples=0 — an open reader did NOT block rename |
| B-18 | a REAL kernel write failure refuses the save and keeps the old document | `GOAL.md` §14.5 names full disk | `atomicReplace` error path | new `TestKernelFileSizeLimitRefusesTheSaveAndKeepsTheOldDocument` (launcher sets `RLIMIT_FSIZE`=1 MiB, ignores SIGXFSZ, execs the shipped binary) | Linux CI only | launcher line proves the limit reached the subject; 16 KiB control = 200 + bytes on disk; 8 MiB save ≠ 200 and `settings.json` exactly the control bytes, parseable, no non-dot temp; server alive; restart serves the survivors | Windows = declared skip; teeth owed to the first Linux run | partial (EFBIG proven by construction; teeth owed in CI) | ENOSPC itself is `unproven (policy: no elevation)` |
| B-19 | case-collision filenames | pinned `sanitize-filename` (no case folding) | naming/dedupe path | none new | — | — | — | unproven | an e2e on a case-insensitive FS; Linux CI cannot express it |
| B-20 | path traversal cannot escape a write root | `sanitize-filename`, AGENTS 12/28 | `internal/server` + `ensureContained` | pre-existing fuzz (`FuzzPinnedPathUnderParent`, 7 224 execs) + migrate symlink refusal | `ci.yml` verify | no `..` escape; symlinked source refused | pre-existing | proven (kept) | make the fuzz corpus explicit e2e cases |
| B-21 | crashed writes leave dot-prefixed temp files only | pinned `write-file-atomic` naming | `atomicReplace`/`atomicCreate` temp naming | B-02 assertions | `ci.yml` verify | every leftover name starts `.gotavern-content-log-`; a non-dot `.tmp` is red | shares M2 | proven | whether leftovers are cleaned on the next write |

### 3.3 Provider transport, HTTP and streaming (lane C)

| ID | behaviour (行为) | upstream basis | product implementation | existing test | CI | assertion | negative control | state | next |
|---|---|---|---|---|---|---|---|---|---|
| C-01 | **a redirect that changes PROTOCOL does not carry credentials** | node-fetch 3.3.2 `src/index.js:200-213` + `utils/is.js` deletes `authorization`/`www-authenticate`/`cookie`/`cookie2` on a domain OR protocol change; `net/http/client.go shouldCopyHeaderOnRedirect` compares hostnames only | `internal/outbound/transport.go` `CheckRedirect` | new `TestProductionTransportStripsSensitiveHeadersOnCrossProtocolRedirect` | `ci.yml` verify + race | Authorization/Cookie ABSENT on https→http; present on same-origin; stripped cross-host | RED BEFORE THE FIX: `Authorization crossed an https->http redirect (value "Bearer a15-lane-c-secret")` — this is a REAL credential leak, fixed | proven (defect fixed) | none |
| C-02 | the redirect follow limit is pinned's 20, not ours | node-fetch `src/request.js:134` (follow default 20), `src/index.js:178` | same | new redirect-limit cases | `ci.yml` verify | a 12-hop chain succeeds; the limit is 20 | RED BEFORE THE FIX at the old limit of 5 | proven (defect fixed) | none |
| C-03 | cross-scheme redirects both directions | pinned follows them | same | new tests with a trusted TLS loopback peer, verification ON | `ci.yml` verify | http→https and https→http both reach the final peer | mutation: refuse all redirects → final peer received 0 requests | proven (alpha.14 limitation CLOSED) | none |
| C-04 | empty gzip body keeps the connection | net/http advertises and decodes gzip | production transport | new `TestProductionTransportDecodesEmptyGzipAndKeepsTheConnection` | `ci.yml` verify | two keep-alive requests use ONE TCP connection after an empty gzip reply | mutation: `DisableKeepAlives` → `used 2 TCP connections ... want 1` | proven (alpha.14 gzip-close boundary decided: the manual clone path is not on the production path) | none |
| C-05 | stage bounds are installed values | Node's own defaults are the reference; the bounds are ours and declared | `buildProductionClient` | new `TestProductionTransportInstallsEveryStageBound` | `ci.yml` verify | dial 30 s, TLS 15 s, response-header 120 s, idle 90 s, pool 32 | mutation: header bound 0 → `response-header bound = 0s, want 2m0s` | proven | none |
| C-06 | 429/503 are NOT retried | node-fetch has no retry loop | transport | new `TestProductionTransportDoesNotRetryProviderStatuses` | `ci.yml` verify | exactly one peer request; `Retry-After` preserved | mutation: injected retry → `the peer received 2 requests for one Send of a 429 answer ... duplicate provider charge` | proven | none |
| C-07 | cancellation aborts the upstream connection | pinned `chat-completions.js:241-244` (socket close → abort + body.destroy) | transport | new `TestProductionTransportCancelAbortsTheUpstreamRequest` on a raw TCP peer | `ci.yml` verify | caller cancel ⇒ provider connection closed | mutation removing BOTH abort paths → `the caller cancelled but the provider connection stayed open`; single-path removal survives because either path aborts (recorded) | proven | none |
| C-08 | streaming clean end vs truncation are different | pinned's [DONE] → EOF | transport/stream reader | new `TestProductionTransport...` streaming cases | `ci.yml` verify | `[DONE]` then EOF is a CLEAN end (not `Truncated`); a partial SSE frame split across writes is reassembled byte-exactly; mid-frame truncation is an ERROR not EOF | covered by the streaming observables suite | proven | none |
| C-09 | the shipped binary really uses env proxies | `AGENTS` rule 29 (proxy awareness) | transport | new e2e `TestProviderProxyFromTheEnvironmentThroughTheShippedBinary` | `ci.yml` verify | provider host does not resolve directly; the proxy sees the absolute-form target; exactly one request | mutation: force direct → proxy received 0 requests (red at 121 s) | proven | DELIBERATE divergence, see §6 |
| C-10 | the shipped binary follows a redirect | pinned follows them | transport | new e2e `TestProviderRedirectIsFollowedThroughTheShippedBinary` | `ci.yml` verify | credential and body preserved; final peer receives it | mutation: refuse redirects → final peer 0 requests | proven | none |
| C-11 | empty credential shape | pinned capture records `Authorization: Bearer ` (trailing space) | transport | raw-byte shape test | `ci.yml` verify | net/http trims trailing OWS; provider-invisible; the wire-exact client stays byte-identical | n/a (shape documented) | proven + inherited difference | none |
| C-12 | 301/302 with PUT/DELETE | node-fetch converts only POST to GET; net/http converts any non-GET/HEAD | transport | — | — | — | — | unproven (no provider path uses PUT/DELETE on a redirect) | record as a remaining limitation, do not rewrite redirect handling for it |
| C-13 | brotli decoder/encoder | pinned compression middleware | browser-response compression | pre-existing | `ci.yml` verify | a `br`-only client receives identity; a dual-offer client receives gzip | pre-existing | remaining limitation | reversible follow-up |
| C-14 | Windows account-cache boundary | — | `internal/server/accounts_cache_test.go` | pre-existing | `ci.yml` verify | same-size mtime-preserving restore can serve stale until identity change | documented | partial (Windows) | Unix path detects it via ctime |
| C-15 | Node `requestTimeout` | pinned maps it | deliberately unmapped | documented in code | n/a | `ReadTimeout` stays zero; cancellation is proven to reach the peer (C-07) | n/a | product decision | none |

### 3.4 Browser semantics (lanes D and D2)

Lane D's assets/UI/paint/persistence rows and lane D2's generation/conversation rows are listed together
because they share one rule: **load ≠ execute ≠ visible ≠ request changed ≠ saved.** Every row names which of
the five classes it proves.

| ID | behaviour (行为) | upstream basis | product implementation | existing test | CI | assertion | negative control | state | next |
|---|---|---|---|---|---|---|---|---|---|
| D2-01 | swipe RIGHT generates and persists; swipe LEFT returns without generating | `public/script.js` swipe arrow handlers | chat-completions relay + chat save | new `a15-gen-conversation-probe.mjs` | `browser-differential.yml` new conversation lane (dispatch/`all`) | peer request sha256 per step; DOM text; JSONL projection | wrong character → `character-opened` red; empty peer reply → `turn-1-provider-request` red | proven (Layer A; CI wiring landed, run id in the release evidence) | — |
| D2-02 | EDIT changes the next request's history | pinned `Generate('normal')` after edit | same | same probe | same | request after edit carries the edited text | edit fill skipped → `edit-displayed-the-edited-text` red (cascade) | proven | — |
| D2-03 | DELETE removes the message from disk and from the next request | pinned delete + confirm popup | same | same probe | same | deleted reply absent from turn-3 request; JSONL without it | delete click removed → four named reds | proven | — |
| D2-04 | `/sys` slash command inserts a System message without generating | pinned slash command box | same | same probe | same | turn-3 request carries the `/sys` message and NOT the deleted reply | slash Enter removed → three named reds | proven | — |
| D2-05 | save + reload + reopen the saved chat restores the edited history | pinned `saveChatConditional` + past-chat picker | chat save/read routes | same probe | same | JSONL after reload equals after save | saved chat not reopened → `reload-reads-the-edited-history` red; save skipped → first attempt was a probe-faithfulness alarm at the 120 s preloader bound, re-run red on `swipe-left-persisted` | proven | the pinned readiness bound must be sized on the CI runner |
| D2-06 | the comparison is byte-oriented and narrow | differential doctrine 2 | `a15-gen-compare.mjs` | itself | same | raw target + byteLength + sha256 in order, per-step page+disk snapshots, persisted chat; exactly two exclusions printed with the measurement (per-run chat filename; raw JSONL byte length 2745 vs 2747 with identical parsed messages) | comparator refuses a missing leg or an empty capture | proven | — |
| D2-07 | regenerate/continue/save-reload/group replies/QR execution/world-info/AN/regex/helper events are covered | pinned routes | existing | pre-existing probes | `browser-differential.yml` modes | per-row workflow+job cited in the lane ledger | pre-existing | proven (kept) | — |
| D2-08 | group-chat CREATION through the roster UI | pinned groups UI | groups routes | not asserted | — | — | — | unproven (`not-asserted-through-the-UI`) | named gap; creation is API-level today |
| D2-09 | Quick Reply CREATION through the settings UI | pinned QR UI | QR routes | not asserted | — | — | — | unproven (`not-asserted-through-the-UI`) | named gap; execution is clicked today |
| D2-10 | `in_use` preset mutation affecting a later ORDINARY turn | pinned: `in_use` is the helper's live settings object | chat-completions | helper `generate({preset_name:'in_use'})` path | `browser-differential.yml` helper lane | next request changes identically on both subjects | covered by helper comparator | proven via helper path (`covered-by-helper-path`); the ordinary-turn variant is a second proof of one observable | none |

Lane D's rows are recorded in `docs/browser-stability.md` §"A15 lane D: the five evidence classes, and two
surfaces that had none". Its outcome is PARTIAL and is stated as such rather than upgraded: the two surfaces
it set out to prove — the opened card image in the character editor, and Moving UI apply → disk save → reload →
NEW-process restart — have **no passing assertion at this commit**. The probe exists
(`tests/browser/a15-ui-persist-probe.mjs`, two phases, evidence classes labelled per check, egress recorder,
port lease, bounded timeouts) but it stops at a NAMED harness precondition
(`HARNESS FAITHFULNESS: the page rendered 0 character row(s) although /api/characters/all answered 200 with 2
names`), while `asset-probe.mjs` on the same tree renders 3 list avatars and 0 failed images — so the
difference is that probe's page setup, not the product, and the probe refuses to emit product findings from
it (AGENTS rule 10). Its planned mutations therefore did not run, and they are listed as owed. It is committed
but deliberately NOT wired into CI: a probe that exits on its own precondition would make the browser gate red
for a harness reason.

The same lane produced a second finding that outlives it: **every browser probe's page init reached the live
network at this baseline.** The shipped default settings set `main_api: koboldhorde`
(`upstream/default/content/settings.json`), the pinned frontend's init calls `getHordeModels(true)`
(`public/script.js:7865-7867`), and the server-side branch fetches `https://aihorde.net` and a metadata URL on
`raw.githubusercontent.com` (`internal/server/horde.go`). `grep -rn GOTAVERN_HORDE_API_URL tests/browser` is
empty, so no probe redirects it. The harness seam exists (`GOTAVERN_HORDE_API_URL` /
`GOTAVERN_HORDE_METADATA_URL`), and a blanket abort of all non-local page requests is NOT the fix (it stalls
the pinned frontend's init); the hermeticity decision — point the seam at the mock peer, or stage the leg's
settings with a non-remote `main_api` — is recorded OPEN rather than improvised.

### 3.5 The two corpora and the cross-layer bridge (lane E)

| ID | behaviour (行为) | upstream basis | product implementation | existing test | CI | assertion | negative control | state | next |
|---|---|---|---|---|---|---|---|---|---|
| E-01 | both generators emit ONE schema for the initial tree | n/a (harness contract) | `internal/longlivedfixture/corpus_schema.go`, `tools/longlived/corpus-schema.mjs` | `TestCorpusSchemaIsDeterministicAndComplete`, `TestCorpusSchemaClassifiesSharedSurfaces` | `longlived.yml` small job | per-file path/size/sha256/class, derived counts, feature flags, markers, tree digest; shared classifier agrees across languages | `class-disagreement:<path>` on a reclassified file | proven | duplicated classifier in Go and JS is drift-detected, not prevented |
| E-02 | the tree a browser leg drives is the tree its manifest describes | n/a | `tools/longlived/verify-corpus-schema.mjs` (9 named checks) | new CI step in both long-lived tiers | `longlived.yml` | `file-sha256`, `inventory-no-extra-files`, `inventory-no-missing-files`, counts, features, tree digest | one byte changed → `file-sha256`; extra file → `inventory-no-extra-files`; renamed → `inventory-no-missing-files`; changed manifest sha → `file-sha256`; non-deterministic rebuild → Go `file-sha256:<path>` | proven | — |
| E-03 | the two corpora are DIFFERENT on purpose, and the difference is measured | n/a | `tools/longlived/compare-corpora.mjs` | `TestLongLivedCorpusSchemaBridge` | `longlived.yml` small job | decision `TWO_CORPORA_SHARED_SCHEMA`, `byteIdentical: false`, `separateCorporaJustified: true`, 67 named difference classes; Go complex-small 47 files/205,516 B vs JS small 69 files/3,337,391 B; 44 Go-only files / 66 JS-only; 10 Go-only surfaces, 2 JS-only; messages 84 vs 864, branches 1 vs 8, deleted turns 0 vs 8, world entries 42 vs 242, swipes 10 vs 4 | a fabricated "same" claim would fail `byteIdentical` | proven | complex-default/medium/large measured through the same code path but not separately compared |
| E-04 | one corpus for everything | n/a | rejected | the comparison above | — | neither corpus is a superset, so collapsing them would delete coverage | n/a | decided: TWO, with a shared schema | — |

### 3.6 Performance (lane F)

| ID | behaviour (行为) | upstream basis | product implementation | existing test | CI | assertion | negative control | state | next |
|---|---|---|---|---|---|---|---|---|---|
| F-01 | the README/figure/provenance agree with the committed artifact | n/a | `tools/check-perf-docs.mjs` | itself | `ci.yml` verify | table, both SVGs and provenance restate one artifact; unit rule decimal MB | alpha.13's MiB-as-MB row is the defect the gate caught | proven (kept) | refresh the artifact at this release's code-complete commit |
| F-02 | a paired measurement can be taken between two arbitrary binaries with provenance | n/a | `scripts/a15-bench-suite.mjs`, `tests/perf/procstat`, `tests/perf/fixturegen` | harness self-check + smoke mode | not a release gate (local tool) | commit/Go/OS/CPU/RAM/GOMAXPROCS/build flags/mode/scale/concurrency/rounds/load label + each subject's sha256/size | a missing subject identity refuses the run | proven | Phase-2 numbers in `docs/perf-baseline.md` §10 |
| F-03 | identity-keyed card-text cache for `/api/characters/all` | n/a (performance, response bytes must not change) | `internal/server/characters_card_cache.go` | cache tests + oracle replay | `ci.yml` verify + `race` + `bench-profiles.yml` | response bytes unchanged; invalidation on identity change; bounded; every read of mutable entry fields inside the lock | serve-stale-on-mismatch must be red; **the first Linux `-race` run found a REAL data race in the cache lookup** (identity and text were read after dropping the mutex while `store` replaced them) and it was fixed with one critical section — the Windows host cannot run `-race` (`-race` is unsupported on windows/arm64), which is exactly why the race job exists | **measured on the quiet host with on/off arms (two test binaries differing only in `readCharacterDataStrict`, 3 alternating rounds): 10k-card repeat path −17.4% time and −20.4% B/op, large-card-text row −42.3% time and −71.3% B/op, cold first request +21% (a stat per card), 10k repeat-only ns −22.1%.** Both halves are reported; the CI paired record does not drive this route, so no headline-metric claim is made. §10.4 of `docs/perf-baseline.md` carries the table and the caveats |
| F-04 | compressed static-asset response cache | n/a | DECLINED for alpha.15 | — | — | — | — | decided: declined (GOAL §15.4 protected area + would move the page-load figure the evidence gate is built on); ROI recorded for a future release | reversible |
| F-05 | chat-search matcher re-lowercases accumulated text | JS `toLowerCase` semantics | `internal/server` chat search | — | — | — | — | unproven (deferred: needs an oracle differential for context-sensitive case mapping) | fixture first |
| F-06 | CPU time / peak RSS / 100-1000-10000 cards / large JSONL / concurrency / soak | n/a | harness above | `docs/perf-baseline.md` §10 | local | per-mode numbers with the method string and load label | — | proven as a HARNESS; the alpha14-vs-alpha15 claim is in §5 | — |

### 3.7 CI, release machinery and the release verifier (lane G)

| ID | behaviour (行为) | upstream basis | product implementation | existing test | CI | assertion | negative control | state | next |
|---|---|---|---|---|---|---|---|---|---|
| G-01 | a green RUN whose required JOB was skipped cannot satisfy a gate | measured: the default long-lived dispatch is `small` and leaves `medium-corpus` SKIPPED while the run is green | `scripts/release-governance/gates.mjs` `requiredJobs` | `scripts/release-governance.test.mjs` | `ci.yml` verify + `release.yml` publish | required job must be completed/success IN the cited run | skipped-job rail weakened → named test red | proven | — |
| G-02 | a green run without its fixed-name ARTIFACT cannot satisfy a gate | same | `requiredArtifact` | same | same | artifact present and not expired, names what it observed | artifact deleted → `missing-artifact` | proven | — |
| G-03 | an artifact's NAME is not its CONTENT | same | `artifact-evidence.mjs` bounded ZIP reader + `requiredEvidence` | same | same | evidence `kind`, `schemaVersion`, tier marker `medium`, embedded head SHA == candidate, truthy fields, sha256 digests | embedded head-SHA check disabled → named red; wrong tier/digest → `evidence-mismatch` | proven | — |
| G-04 | evidence rails require the event that may satisfy them | push runs upload the same artifact names | `validateManifest` | same | same | evidence rails without `requiredEvent` are a manifest error; `schedule` vs `workflow_dispatch` are distinct | requiredEvent-for-evidence disabled → validator test red | proven | — |
| G-05 | the medium long-lived tier is a release gate | task brief | `docs/release-manifest.json` | same | `longlived.yml` medium job | workflow + `medium-corpus` job + `longlived-medium-evidence` + embedded `size: medium`, head SHA, teeth, 20-extension digest, corpus digest | `runs-small-tier-masquerade` fixture → `job-not-green` | proven | producer half dispatch-exercised; first dispatch is the watch item |
| G-06 | the Node stock-tree round trip is a release gate | task brief | same | same | `node-stock-tree.yml` | job + `node-stock-tree-evidence` + embedded head SHA/`roundTripOk`/tree+manifest digests | missing artifact → `missing-artifact` | proven | — |
| G-07 | the publish path queries the same evidence as the verifier | n/a | `evidenceQueryNeeds()` shared by both | wiring test | `release.yml` | one selection plan for CLI and body assembler | renamed gate call → wiring test red | proven | — |
| G-08 | `v0.1.0-alpha.15` classifies stable and its neighbours do not | n/a | `scripts/classify-version-tag.sh` | `scripts/test-classify-version-tag.sh` (59 cases) | `ci.yml` verify | alpha.15 stable; alpha.16/alpha.150/alpha.15-rc1/alpha.15+build.1/alpha.09/v0.1.1-alpha.9/v0.2.0-alpha.1 prerelease; equality list, no prefix/range | any neighbour graduating breaks a named case | proven | — |
| G-09 | concurrency cannot cancel a release-evidence dispatch | measured: single per-ref group with cancel-in-progress | the two evidence workflows' concurrency groups | YAML parse + review | those workflows | tier/event in the group; dispatch not cancelled | — | proven by construction | — |
| G-10 | the verifier's own negative controls are executable | n/a | 34 fabricated-API rows in `release-governance.test.mjs` | `node --test` | `ci.yml` verify | missing/wrong/null SHA, non-required event, failed/in-progress/cancelled, skipped/absent jobs, missing/expired/wrong named artifact, missing evidence, wrong kind/schema/tier/headSHA/truthy/digest, old-SHA reuse, newer-empty-run masking, manifest refusals, corrupt ZIP, unfetched queries, positive control | each row is itself a negative control | proven (55/55) | — |
| G-11 | the 13-gate verdict on the real manifest | n/a | `scripts/verify-release-gates.mjs` | my own independent run | `release.yml` publish | all-green fixture → PASS 13/13; medium skipped → FAIL; artifact removed → FAIL | the two failure fixtures | proven | — |

### 3.8 The release itself (Lead rows)

| ID | behaviour (行为) | upstream basis | product implementation | existing test | CI | assertion | negative control | state | next |
|---|---|---|---|---|---|---|---|---|---|
| L-01 | GOAL/HANDOFF/scorecard state alpha.15 accurately and do not quote alpha.13's stale findings | `GOAL.md` §14 | the documents | `TestDocumentGateCoversTheContract`, `TestMojibakeSweepOfEveryDocument`, `TestEvidenceLedgerIsConsistent` | `ci.yml` verify | section 14's two old reasons are re-measured: compression implemented (removed), card cache still absent (partial, derived); PRIVATE_NOT_RUN recorded | the document gates refuse a wrong pin spelling, a mojibake byte, an uncited proven row | proven in-tree; re-checked at the candidate | — |
| L-02 | the private channel's disposition is honest | `docs/development-loop.md` §4 | `docs/real-user-input-audit.md` §8 | same gates | — | `PRIVATE_NOT_RUN` for the tree items; `PARTIAL` for the failure path; instruments remain canaried-only | a claim of a real-tree run would have no artefact and no gate can be satisfied by a claim | recorded | unchanged, by design |
| L-03 | every required gate runs at the tag commit | `docs/release-manifest.json` | `scripts/verify-release-gates.mjs` | G-11 | `release.yml` publish | 13 workflows, `workflow_dispatch`, same head SHA, jobs/artifacts/evidence rails | the failing fixtures above | gated at publish time | this release's run ids appear in the release body, appended by the publish job |

## 4. The false greens this round killed

Each of these printed a PASS over an observation that proved nothing. They are the reason the round exists.

1. **A closed checked set** (A15-01): three committed artefacts were never checked, and a new one escaped.
2. **Zero evidence** (A15-02): an empty catalogue read as "coherent".
3. **An unread pinned baseline** (A15-03): a declared baseline could name another oracle.
4. **One-way guard sets** (A15-04): a guard nobody read, or a required guard silently deleted.
5. **Footers claiming coverage** (A15-05/06): five framing guards and five regex guards were expected by no case.
6. **An empty corpus passing** (A15-07): zero extensions, verdict PASS.
7. **`{}` and `null` read as FRESH** (A15-08).
8. **Unpinned drive exemptions** (A15-09).
9. **`skipped` read as `success`** for a required job (G-01) — the exact masquerade the medium tier needed.
10. **An artifact's name accepted as its content** (G-03).
11. **A push run satisfying a dispatch requirement** (G-04).
12. **A write mutation that "proved" atomicity without reaching the write** (B-02, M2) — the mutation SURVIVED until the kill window was widened; the test, not the product, was wrong.
13. **A migration census taken only once** (B-11, M3).
14. **A comparison that reported `4 provider requests byte-identical` while a leg was missing** — closed by D2-06's refusal of a missing leg or an empty capture.
15. **A coverage rule that read the WORKING DIRECTORY and called it the commit** (A15-01, found by the gate's own run): `tools/verify-browser-comparisons.mjs` enumerated `tests/browser/*-comparison.json` from disk and required each to be claimed by exactly one checker. `Browser differential` 42018032414 re-records artefacts into that directory before verifying, so six freshly written files (`q20-*`, `real-preset`, `regex`, `truncation`) were reported "unclaimed or multiply claimed" and the run failed at its terminal step — while the same verifier was green on a clean checkout, which is why the code commit's `ci.yml` could not see it. Fixed by taking the committed set from `git ls-files` (fallback: the directory listing for a non-git tree); the content sweeps still read every artefact on disk. Verified both directions: the real tree is green, a tree with planted uncommitted artefacts is green, and `tests/browser/a15-verifier-coverage-selftest.mjs` still refuses a synthetic committed artefact with no checker.
16. **A soak comparator that excused ONE costume of the probe's own stop signal** (found by `Third-party extension compatibility` 42035843369): the filter matched `TypeError: Failed to fetch` (the network costume of the soak's own streaming cancel) but not `Cancelled by stop event` (the frontend costume of the same event), so a run where the frontend costume landed on GoTavern only failed `no-gotavern-only-browser-errors` with one entry. Both costumes are the drive's signal; both are now excused under the SAME condition (`apiFailures === 0`), so a real network failure still fails the guard. Teeth: self-test cases 7b/7c (network costume, both directions) plus new 7d/7e (frontend costume, both directions); the footer that said "all 13 teeth" while 20 checks ran is now COMPUTED (22 checks).

## 5. Measured optimization

`GOAL.md` §15.1 requires each accepted optimization to name its bottleneck, cost, measurement and guard.
The accepted change is the identity-keyed card-text cache for `/api/characters/all`; its before/after is in
`docs/perf-baseline.md` §10 (same host, same input, same build flags, load-labelled), and its correctness
guard is the pinned character oracle replay plus the invalidation/eviction tests, not a benchmark. One
optimization was declined with its measurement recorded (F-04), and one deferred pending an oracle (F-05).

## 6. Residual, unproven and declined

| item | state | reason |
|---|---|---|
| real `ENOSPC` | unproven (policy: no elevation) | reproducing it needs a privileged small mount; the round's rule forbids elevation. The kernel write-failure class is proven with `EFBIG` instead |
| `GOAL.md` §14 real long-used tree | `PRIVATE_NOT_RUN` | no authorised original on the host; the private channel is canaried only |
| F17 shape-classified row counted as `equal` | open | fixing it changes the classification of a committed observation and needs a re-record with its own reason |
| artefacts carry no head SHA / workflow / run id / mode | unproven | adding provenance to every surface is a re-record of all of them |
| Windows account-cache same-size restore window | partial | recorded; the Unix path detects it via ctime |
| brotli encoder | remaining limitation | a `br`-only client gets identity; reversible |
| Node `requestTimeout` unmapped | product decision | a whole-request deadline under every upload; cancellation is proven to reach the peer |
| 301/302 PUT/DELETE redirect rule | remaining limitation | no provider path uses PUT/DELETE on a redirect |
| env-proxy when `requestProxy` is disabled | DELIBERATE divergence | GoTavern honours environment proxies for its own outbound traffic; pinned only uses a proxy when its own agent is installed. Recorded as a product decision (rule 29 is the product contract) |
| case-collision filenames on a case-insensitive FS | unproven | needs an e2e on Windows; Linux CI cannot express it |
| group-chat / Quick Reply CREATION through the UI; `in_use` on an ordinary turn | unproven (named) | second proofs of observables already covered by the API-level path and the helper path |
| page-load compressed-asset cache | declined | ROI measured, but it lives in GOAL §15.4's protected area and would move the figure the evidence gate rests on |
| a cold-guard row in the COMMITTED bench baseline | deferred, with the reason measured | `scripts/bench-profiles.mjs` treats a benchmark that is not in the committed baseline as a FAILURE (not a candidate), and regenerating that baseline requires the Linux baseline host plus a workflow bootstrap pass. The cold guard therefore lives in `scripts/a15-bench-p1-arms.mjs` (on/off arms over the warm AND cold rows) instead of in `internal/server/bench_test.go`, so the scheduled `GoTavern bench profiles` gate stays green at this commit |
| large corpus browser drive | by design not a gate | >100 MB / 5,000-message chats; the driver refuses it and the nightly rail covers generator + loader + Go boot |
| narrowed oracle dispatches | process limitation | only a scheduled full sweep covers the whole oracle; a narrowed green is a statement about the selected probes |
| conversation-editing DOM duplicate (new D2 lane) | OPEN, lane NOT gating | `Browser differential` 42051169663 measured the `#chat .mes` count as 4 on GoTavern against 3 on pinned at turn-1 / swipe-right / swipe-left, while BOTH chats hold the same three messages, the same user-message fields (`swipe_id` unset, `swipes` empty) and the same reply; the extra node is a SECOND block for the user message (mesid 1, class `mes fade last_swipe`) and it disappears on the next full render (turn-2 and turn-3 agree at 5 and 7). `public/style.css:1327/:1355` uses `.last_swipe` only for chevron opacity, so if the node is real and visible it is a duplicated user bubble. The probe's own 36 step assertions pass on both subjects. Because the difference is not yet explained, the step is `continue-on-error` and the lane is recorded as UNPROVEN rather than green or red; closing it (frontend create/remove path vs the server's completion event) is alpha.16 work. Evidence: the run's `browser-differential-42051169663` artifact and a local reproduction with `domMessages` detail |
