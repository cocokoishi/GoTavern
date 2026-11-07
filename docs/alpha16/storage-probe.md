# alpha.16 storage lane: D-H17 atomic tokenizer cache and the B-H4 reset-vs-save probe

Lane: `a16/storage`, branch `a16/storage`, based on `main` `f769b5f`. This document records what
was measured, not what was intended: every claim names the test or command that produced it, and
the residual risks are listed rather than implied.

## 1. D-H17: the tokenizer cache is only ever absent or complete

### 1.1 The defect and the pinned oracle

Pinned SillyTavern imports `write-file-atomic` and uses `writeFileAtomicSync` for every tokenizer
cache write:

- `src/endpoints/tokenizers.js:9` -- `import { sync as writeFileAtomicSync } from 'write-file-atomic'`
- `:116` -- the compressed manual download is decompressed and written atomically
- `:136` -- a downloaded `.gz` payload is decompressed and written atomically
- `:140` -- a downloaded uncompressed payload is written atomically

`write-file-atomic` creates a unique temporary file in the destination directory, fsyncs it,
closes it and renames it over the destination, so a crash, a full disk or a concurrent reader can
never observe a partial cache file.

GoTavern wrote the same cache with `_ = os.MkdirAll(...)` plus `_ = os.WriteFile(target, raw, 0o644)`
(`internal/server/tokenizers.go`, old lines 376-378 and 387-389). `os.WriteFile` opens the
destination with `O_TRUNC` and writes in place: a failure part-way through left a truncated file
where the tokenizer cache used to be, and a concurrent reader could read that prefix as a
tokenizer. Both errors were discarded.

### 1.2 Failure semantics taken from pinned, not invented

The write is inside `getPathToTokenizer`'s `try` block. When `writeFileAtomicSync` throws, the
`catch` logs and **returns the fallback model** (`tokenizers.js:144-146`), and every externally
fetched `WebTokenizer` is constructed with `src/tokenizers/llama3.json` as its fallback
(`:279-284`). The route therefore answers with llama3's tokenization, not with the tokenizer whose
cache write failed. GoTavern previously returned the bytes it failed to persist. The fix now falls
back to `webBytes(llama3)` on a cache-write failure.

Deliberate difference, recorded in the source comment: pinned logs `console.error` on that
fallback; the Go tokenizer path is silent on every fallback (the pre-existing cold-cache fallback
is silent too), because `tokenizerSet` does not carry the options writer. Second deliberate
difference: a failed `unlink` of the `.gz` after a successful write falls back to llama3 in pinned
(`:117`) and is ignored here, because the uncompressed cache file already exists and the next
request uses it either way.

### 1.3 The fix

`writeTokenizerCacheFile` now: takes a unique temporary file in the SAME directory
(`O_WRONLY|O_CREATE|O_EXCL`), writes through the `tokenizerCacheTempWrite` seam, fsyncs, closes,
then renames over the destination (`internal/fsretry` retries the Windows sharing violation a
concurrent reader causes), then fsyncs the directory. The destination is never opened for
truncation, and the temporary file is removed on every error path. `publishCacheFile` keeps
pinned's `mkdirSync(CACHE_PATH, {recursive:true})` (`:97-99`) step and propagates its error into
the same llama3 fallback.

The helper does not forward to `internal/startup`'s `WriteFileAtomic` -- the same algorithm -- for
two recorded reasons: the cache directory may not exist yet (pinned mkdirs first), and the
red-first test needs the write step as a seam, while `internal/startup`'s seam is deliberately
unexported in a package marked do-not-refactor.

### 1.4 Red-first evidence (observed before the fix, `-count=1`)

The pre-fix body was preserved behind the same seam and the three tests below were run against it.
Exact failure text, `go test ./internal/server -count=1 -run 'TestTokenizerCache(WriteFailure|Reader)' -v`:

```
--- FAIL: TestTokenizerCacheWriteFailureLeavesThePreviousCacheOrNothing (0.16s)
    tokenizers_cache_atomic_test.go:129: a failed tokenizer cache write left a 2377322-byte file at
    ...\_cache\qwen2.json; the complete payload is 4754645 bytes. The cache must be absent or
    complete, because the next request reads this file as a tokenizer.
--- FAIL: TestTokenizerCacheWriteFailurePreservesThePreviousCompleteFile (0.01s)
    tokenizers_cache_atomic_test.go:172: a failed tokenizer cache write replaced the previous
    complete 33-byte file with 32768 bytes (a truncation window a concurrent reader would then
    tokenize from)
--- FAIL: TestTokenizerCacheReaderNeverObservesPartialBytes (0.02s)
    tokenizers_cache_atomic_test.go:253: a concurrent reader observed 65536 cache bytes that are
    not a complete payload (the complete payloads are 33 and 524288 bytes); the cache must be
    published atomically
```

The tests inject the mid-write failure through `tokenizerCacheTempWrite` (the seam the production
helper calls) with a prefix-then-error write, which is the shape a full disk or a killed process
produces, and one test injects a slow chunked writer while a reader polls the destination. Test A
drives the REAL `webBytes` path (compressed cache file -> decompress -> materialize) and asserts
three things: the destination is absent or byte-identical to the complete payload; no
`.gotavern-tokenizer-*` scratch file is left; the returned bytes are llama3's (pinned's fallback),
with a discrimination check that qwen2's and llama3's vendored bytes differ, so "fell back" cannot
pass for the wrong reason.

### 1.5 Green result

Same three tests after the fix: all PASS. The whole tokenizer suite is green as well
(`go test ./internal/server -count=1 -run 'Tokenizer'` -> `ok ... 27.4s`).

## 2. B-H4: recursive account reset vs concurrent saves

### 2.1 What was probed

`internal/server/account_reset_save_race_test.go` runs three seeds. Each seed builds a data root
with two accounts (`alpha-user` A, `beta-user` B), logs both in through the real login route,
seeds complete settings and chat files for both, writes three unrelated-file sentinels (one
global, one inside B's tree, one inside A's tree), snapshots the account store, then starts EIGHT
writer goroutines -- `/api/settings/save` and `/api/chats/save` for A and for B, two goroutines
per route per user, six iterations each, distinct payloads with unique markers. Two milliseconds
into the storm, A's data is reset through the REAL handler path: `POST /api/users/reset-step1`
then `POST /api/users/reset-step2` with the issued code. A reader goroutine polls A's and B's
settings and chat files throughout and records the first observation that is not a complete
document.

Every save response is recorded. Afterwards the probe asserts:

1. every remaining `.json` file parses and every remaining `.jsonl` file has only valid lines, in
   both user trees;
2. no A marker appears under B's tree and no B marker under A's tree (reader and post-run walk);
3. every save answered 200 or 500; no 200 is accompanied by a torn file (the reader observed none
   and the final files are complete);
4. the global sentinel and B's sentinel are byte-identical, A's inside-tree sentinel is gone
   (pinned's `rm(root, {recursive:true})` removes the whole tree), and the account store under
   `_storage/` is byte-identical;
5. a post-storm settings save succeeds for BOTH users.

### 2.2 Pinned citations the verdict is compared against

- Reset: `src/endpoints/users-private.js:288-292` -- `await fsPromises.rm(request.user.directories.root,
  {recursive:true, force:true})`, then `await ensurePublicDirectoriesExist()`, then
  `await checkForNewContent([request.user.directories])`. The rm is async, and the synchronous
  `writeFileAtomicSync` handlers run on the same event loop, so between the rm and the reseed a
  concurrent save CAN interleave and legitimately recreate a file the reset removed.
- Settings save: `src/endpoints/settings.js:206-214` -- `writeFileAtomicSync(pathToSettings, ...)`;
  a throw is caught and answered with `response.send(err)` (200 carrying the error object).
- Chat save: `src/endpoints/chats.js:541,545-566` -- `tryWriteFileSync(filePath, jsonlData)`
  (write-file-atomic); a throw is answered 500.
- Delete-user / characters delete with chats are the same class of recursive destructive route
  (`internal/server/accounts.go:1340-1345`, `characters_write.go:874-882`); this probe measures
  the reset route, the strongest one.

### 2.3 Observed result (windows/arm64, `go test ./internal/server -count=1 -run
TestAccountResetInterleavedWithSavesDoesNotCorruptOrCrossUserData -v`, 3 seeds, 48 save requests
per seed)

PASS, with these measurements logged by the probe itself:

```
seed 1: reset A completed on attempt 2 (statuses [500 204])
seed 1: 48 save responses, reset attempts 2, status counts
        map[alpha-user /api/chats/save 200:11 alpha-user /api/chats/save 500:1
            alpha-user /api/settings/save 200:12 beta-user /api/chats/save 200:12
            beta-user /api/settings/save 200:12]
seed 2: same shape; seed 3: same shape
```

Interpretation of each observation:

- The storm genuinely overlapped the reset: one A chat save answered 500 (its tree was removed
  under it), and other A saves answered 200 both before and after the reset (post-reset writes
  recreate files in the reseeded tree). No file was ever observed torn. This is the pinned
  interleaving from 2.2: the reset empties the tree, and a later save repopulates it; both
  implementations have that window because neither pins the rm against saves.
- No corrupted JSON/JSONL and no cross-user data was observed in any seed, at any reading.
- Unrelated files and the account store were byte-identical; only A's tree was removed.
- The reset's FIRST attempt answered 500 on all three seeds on this Windows host and the second
  answered 204. This is a host-level failure mode, not a data-safety one: `os.RemoveAll` cannot
  delete a file another handle has open without FILE_SHARE_DELETE, so an in-flight save's
  temporary file can fail the rm; pinned Node opens with FILE_SHARE_DELETE and its async rm
  succeeds. The probe retries this bounded (3 attempts, counted and logged); if all attempts fail
  it fails rather than passing vacuously. On Linux (the CI gate) unlink of an open file succeeds,
  so the first attempt is expected to be 204.
- One save-level status divergence was reconfirmed: Go's settings save answers 500 when the tree
  is absent, pinned's answers 200-with-error (`settings.js:212`). It is a route-status difference,
  not data destruction, and is outside this task's scope; recorded here so it is not re-derived.

### 2.4 Probe faithfulness correction (recorded because it first produced a false finding)

The probe's first version used `os.ReadFile` for the concurrent reader. On Windows that opens
without FILE_SHARE_DELETE, so the READER made the reset's `os.RemoveAll` fail with a sharing
violation and every seed needed three reset attempts. The first run therefore presented as "the
reset fails under concurrency" -- a probe defect, not a product finding (AGENTS.md verification
rule 10). The reader now opens with the share modes Node uses
(`internal/server/account_reset_save_race_windows_test.go`, `FILE_SHARE_READ|WRITE|DELETE`; POSIX
keeps `os.ReadFile`, where unlink of an open file always succeeds). After that correction the
reset still needs a retry on this host for the WRITER-side temp file, and the probe logs it as
above.

### 2.5 Verdict

**No locking/coordination was added for B-H4.** The probe demonstrates:

- no corrupted file, no partial publication, and no cross-user data on the reset-vs-save
  interleaving;
- the only "destroyed" writes are writes that lost their tree and reported 500 (a save failure
  the user can see, not a silent 200), plus post-reset saves that legitimately recreate files in
  the reseeded tree, which pinned's own async rm + synchronous saves also produce;
- the surviving-tree differences from the post-reset state are the ones pinned's interleaving
  defines (rm removes the tree, reseed recreates defaults, a save after the reseed recreates the
  saved file).

Therefore B-H4 is **pinned-parity interleaving, not a Go-only data-destruction defect**. Per R3
(`docs/alpha16/m4-refactor-decisions.md:208-221,420-422`) a single route without a demonstrated
divergence is not an IMPLEMENT bar, and adding a lock would be safer-but-different ordering that
changes what pinned observably does (a reset that waits for saves, or a save refused by a reset).
The deliverable is the probe plus this verdict.

## 3. Residual risks and unfinished items

- **Windows reset-vs-save 500 (not fixed).** A reset racing an in-flight save can answer 500 on
  Windows because `os.RemoveAll` cannot unlink the save's open temporary file. Pinned does not
  fail there. This is a transient, user-visible status difference, not data loss; it is the
  documented Go-vs-Node file-sharing class (`internal/fsretry` package comment), and fixing it
  would mean either retrying `RemoveAll` in the reset route (a bounded hardening) or taking the
  per-user lock in the reset (safer-but-different ordering). Both are product decisions outside
  the D-H17/B-H4 scope; CI (Linux) cannot see this failure.
- **Settings-save status divergence.** Go answers 500 where pinned answers 200 with an error body
  (`settings.js:206-214`). Pre-existing, route-level, unrelated to data safety; recorded, not
  changed.
- **Tokenizer cache residual.** The same-directory temp file is visible to other processes while
  it is being written (`<DataRoot>/_cache/.gotavern-tokenizer-*.tmp`), exactly as pinned's
  `write-file-atomic` temp files are; it is never the destination name. The helper relies on
  `os.Rename` atomicity and on `fsretry` for the Windows reader/rename race; a rename that fails
  after 20 attempts leaves the previous complete file (and is reported as an error to the caller,
  which falls back to llama3).
- **Not probed:** `characters/delete` with `delete_chats` and delete-user, the other two recursive
  destructive routes (same class; the probe covers the reset route the audit named first). A
  seeded probe for them would be the next step if the integrator wants the whole family covered.
