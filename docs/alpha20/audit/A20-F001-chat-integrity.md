# A20-F001: `chat_metadata.integrity` was not enforced on chat save

- **Severity:** High (silent overwrite of a chat another client changed).
- **State:** FIXED (`fb24983`), tests `TestA20ChatIntegrity*`, mutation-verified.
- **Source:** pinned `src/endpoints/chats.js:532-543` (trySaveChat), `:332-369` (checkChatIntegrity),
  `:545-570` (/api/chats/save), `:922-947` (group save); `src/util.js:1560-1578` (readFirstLine),
  `:571-578` (tryParse). GoTavern before: `internal/server/chats.go` had no check and answered
  `{"ok":true}` for every well-formed body, overwriting a file changed by another client.
- **Root cause:** the pinned pre-write guard was never ported; alpha.18 implemented the backup scheduler but
  recorded this check as an intentional gap.
- **Reproducer (RED):** store a chat whose first line has
  `"chat_metadata":{"integrity":"stored"}`, then POST `/api/chats/save` with a first chat element carrying
  `"integrity":"different"`. Pinned: `400 {"error":"integrity"}`, file byte-unchanged, no backup. GoTavern
  before: `200 {"ok":true}`, file overwritten, backup scheduled. Now: pinned behaviour (test
  `TestA20ChatIntegrityRejectsAStaleOverwriteBeforeWriting`).
- **Pinned pass/fail table implemented:** missing file → pass; empty file → pass; legacy header without
  integrity → pass; non-object `chat_metadata` → pass; UTF-8 BOM stripped before parse; unparseable or
  non-object first line → FAIL; truthy slug compared with JavaScript `===` (number vs string differ,
  non-scalar references never match).
- **`force`:** `request.body.force` is JavaScript-truthy: `true`, `1`, `"false"`, `[]` bypass; `false`, `0`,
  `""`, `null` do not. `backups.chat.checkIntegrity: false` disables the check (config read once at boot,
  like pinned's module-load read).
- **Fix:** new `internal/server/chats_integrity.go` (slug extraction, bounded first-line reader, BOM strip,
  strict comparison, force truthiness) wired into `chats.go` and `chats_group.go` before any write.
- **RED/GREEN:** with the guard mutated (`if false && ...`), 7 subtests failed with `status = 200, want 400`
  and the refused-overwrite test still found the original bytes; restored → focused suite `ok`. Evidence is
  in the `fb24983` commit message.
- **Regression guard:** `TestA20ChatIntegrityRejectsAStaleOverwriteBeforeWriting`,
  `...AcceptsMatchingAndLegacyFiles`, `...RequiresConfirmationForACorruptFirstLine`,
  `...ForceUsesJavaScriptTruthiness` (8-row table), `...ConfigCanDisableTheCheck`,
  `...ComparisonIsStrict` (5-row table).
- **Remaining limit:** pinned logs `IntegrityMismatchError.message` to the console; GoTavern returns the same
  response and disk state without that diagnostic (same class as the already-disclosed backup-failure log
  difference).
- **Oracle cross-check:** the oracle lane reproduced the pinned table with real pinned runs
  (`docs/alpha20/oracle/chat-integrity/`), including `force:false == absent` and the BOM/unparseable cases.
