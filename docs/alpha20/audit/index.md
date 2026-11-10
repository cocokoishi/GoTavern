# alpha.20 audit ledger

One row per investigated defect. `CONFIRMED` means reproduced with a real reproducer; `FIXED` means the fix
is on `main` and RED/GREEN evidence exists in the commit (and in the linked record). Unverified suspicions
live in working notes, never here. Severity: Critical / High / Medium / Low.

| ID | Severity | Area | State | Record |
|---|---|---|---|---|
| A20-A | High | SD/text-completion: socket-close interrupt fired after every completed request | **FIXED** (`188b34d`, source-audit lane) | [A20-A](A20-A.md) |
| A20-B | Medium | userdata: `sanitize-filename` replacement mode diverged (COM0/LPT0, reserved-name replacement, trailing dot+space) | **FIXED** (`134500d`, source-audit lane) | [A20-B](A20-B.md) |
| A20-C | Low | outbound: provider transport followed 19 redirects where node-fetch follows 20 | **FIXED** (`60ed139`, source-audit lane) | [A20-C](A20-C.md) |
| A20-D | High | chats: `chat_metadata.integrity` not enforced on save | **FIXED** (`fb24983`, Lead) | [A20-D](A20-D-chat-integrity.md) |
| A20-E | High | chats: group save never scheduled the pinned backup | **FIXED** (`fb24983`, Lead) | [A20-E](A20-E-group-save-backup.md) |
| A20-F | Medium | characters: the card base64 decoder rejected payloads pinned's lenient `Buffer.from(text,'base64')` reads (URL-safe `-`/`_`, interior junk, `=` handling, lone leftover char) | **FIXED** (`138d177`, source-audit lane) | [A20-F](A20-F-card-base64.md) |
| A20-G | High | characters: avatar edit/replace/delete never invalidated the cached thumbnail (stale avatar rendered; delete+recreate showed the deleted character's face) | **FIXED** (`0afe330`, source-audit lane) | [A20-G](A20-G.md) |
| A20-H | Low | `/version` was the last browser-requested GET that always answered 200 where pinned's `send()` answers 304 on a matching validator | **FIXED** (`f606e94`, source-audit lane) | [A20-H](A20-H.md) |
| A20-I | Low | chat-backup download used a content-hash ETag and no `Last-Modified`/`Accept-Ranges`/`Range`/`Cache-Control` where pinned's `res.download`→`send()` uses its STAT ETag contract; the recorded oracle value already existed but the comparator only asserted ETag presence | **FIXED** (`17db9ac`, source-audit lane; gate-blind-spot noted) | [A20-I](A20-I.md) |

Audit notes on cleared areas, inherited properties and boundaries (world-info ordering is frontend-only in the
pinned baseline; extension install/update audited at parity; access-log growth is pinned's own Set) are in
[`notes-inherited-and-boundaries.md`](notes-inherited-and-boundaries.md).

## Integration notes

- The crash-atomicity scenario `chat-metadata-mutation` (`tests/e2e/chat_crash_test.go`) deliberately replaced
  `chat_metadata.integrity`, which the new pinned guard correctly refuses without `force`; the scenario now
  sends `force:true` (the pinned path a client uses to overwrite a changed chat) so it still tests the same
  crash-atomicity property. This is a REPORTED test change, not a weakened guard; the guard keeps its own
  tests (`TestA20ChatIntegrity*`). Found by the first main CI run at `aa44519` (crash-gate red).

## Candidate observations not promoted to findings

- `TestAccountResetInterleavedWithSavesDoesNotCorruptOrCrossUserData` failed once in a full-package run
  (`TempDir RemoveAll cleanup: The directory is not empty`) under two co-tenant CPU-heavy lanes, and passes
  in isolation (`ok 47.3s`). Classified as the known harness cleanup race documented in
  `docs/alpha19/findings/reset-save-test-flake.md`; no data-safety assertion failed. Promoted only if it
  reproduces without co-tenant load.
- `internal/server/access_log.go` knownIPs growth: inherited pinned behaviour; recorded as an
  inherited-property note rather than a defect (source-audit lane).
- All-JSON-GET `304` class: being MEASURED before any change; alpha.19 fixed four browser-visible routes and
  the rest are documented partial. No mass change without per-route Express evidence (source-audit lane).

## Closed M1 gaps (feature parity decisions, not defects)

| Item | Decision | Record |
|---|---|---|
| `chat_metadata.integrity` + `force` | implemented | A20-D |
| group-save backup scheduling | implemented | A20-E |
| Brotli response negotiation | keep the exact disclosed difference (decoded bytes identical on all probed resources; a new pure-Go dependency + outbound decoder outranks the benefit); measured cost recorded | `docs/alpha20/decision-log.md` D-02, oracle lane `docs/alpha20/oracle/encoding/` |
| `_cache/characters` read/write cache | keep verify-only parity (derived cache, second persistent store forbidden, measured startup cost is the verify pass); pinned record format evidence kept for a later round | D-03, oracle lane `docs/alpha20/oracle/character-cache/` |
| dominantColor ±1 / 26 normalisations / 6 notCompared | re-decided at M1: keep the named normalisations, no comparator widening | oracle lane report |
