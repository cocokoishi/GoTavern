# alpha.20 audit ledger

One row per investigated defect. `CONFIRMED` means reproduced with a real reproducer; `FIXED` means the fix
is on `main` and the RED/GREEN evidence exists in the commit. Unverified suspicions live in the working
notes, never here. Severity: Critical / High / Medium / Low.

| ID | Severity | Area | State | Evidence |
|---|---|---|---|---|
| A20-F001 | High | chats: `chat_metadata.integrity` not enforced on save | **FIXED** (`fb24983`) | [A20-F001](A20-F001-chat-integrity.md) |
| A20-F002 | High | chats: group save never scheduled the pinned backup | **FIXED** (`fb24983`) | [A20-F002](A20-F002-group-save-backup.md) |
| A20-F003 | High | SD/text-completion: socket-close interrupt fired after every completed request | **FIXED** (`188b34d`, author: source-audit lane) | [A20-F003](A20-F003-socket-close-interrupt.md) |
| A20-F004 | Medium | userdata: `sanitize-filename` replacement mode diverges (COM0/LPT0, reserved-name replacement, trailing dot+space) | CONFIRMED, fix in progress (`a20/audit`) | source-audit lane report |

## Candidate observations not promoted to findings

- `TestAccountResetInterleavedWithSavesDoesNotCorruptOrCrossUserData` failed once in a full-package run
  (`TempDir RemoveAll cleanup: The directory is not empty`) under two co-tenant CPU-heavy lanes, and passes
  in isolation (`ok 47.3s`). Classified as the known harness cleanup race documented in
  `docs/alpha19/findings/reset-save-test-flake.md`; no data-safety assertion failed. If it fails again
  without co-tenant load it gets promoted and fixed.
- `internal/server/access_log.go` knownIPs growth: inherited pinned behaviour; being evaluated as an
  inherited-property note rather than a defect (source-audit lane).

## Closed M1 gaps (not defects, feature parity)

| Item | Decision | Record |
|---|---|---|
| `chat_metadata.integrity` + `force` | implemented | A20-F001 |
| group-save backup scheduling | implemented | A20-F002 |
| Brotli response negotiation | keep the exact disclosed difference (decoded bytes identical; new pure-Go dependency + outbound decoder outranks the benefit); cost recorded from real captures | `docs/alpha20/decision-log.md` D-02 |
| `_cache/characters` read/write cache | keep verify-only parity (derived cache, second persistent store forbidden, measured startup cost is the verify pass); record format evidence kept | D-03 |
| dominantColor ±1 / 26 normalisations / 6 notCompared | re-decided at M1: keep the named normalisations, no comparator widening; see oracle lane report | `docs/alpha20/oracle/` |
