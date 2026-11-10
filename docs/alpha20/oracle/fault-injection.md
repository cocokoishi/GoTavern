# Failure injection (M3): GoTavern persistence / config / session faults

**Status: EXECUTED — 8 scenarios, 8 executed, 0 claimed beyond what the run shows.** Evidence:
[`fault-injection/evidence.json`](fault-injection/evidence.json). Run:

```
cd C:\Users\koishi\Desktop\GoTavern\a20-B
node tests/browser/a20-fault-injection.mjs
```

The probe builds the current worktree GoTavern binary (`-trimpath`), boots it over a scratch data root copied
from the recorded pinned fresh-install template, and injects ONE real fault per scenario. Each row records the
four properties the charter requires, so "it did not crash" is not a pass:

- **data safety** — every persisted JSONL line parses and the file equals exactly one complete known payload
  (never a torn/partial write);
- **no false success** — a failed operation answers an error/non-2xx (or a disconnect), not a success status;
- **recoverability** — after the fault is removed or the server restarted, the same operation succeeds and the
  product reads the data back;
- **resource release** — a clean SIGTERM exits and a fresh process boots and serves the tree.

Egress: loopback only, local binary, no provider contacted, no browser launched.

| id | fault injected | observed | verdict |
|---|---|---|---|
| F1 | 8 concurrent writers race one chat file with 8 different payloads | all 8 answer `200 {"ok":true}`; final file is **one complete payload** (every line parses); every backup is a complete payload | CONFIRMED safe under concurrency |
| F2 | the backups directory path replaced by a regular file (rename/write failure shape) while a save runs | save still `200 {"ok":true}`, the complete payload persists; after restoring the directory a later save produces a backup again | CONFIRMED: no false failure, recoverable |
| F3 | `icacls` denies write on the character chat directory, then a save | `500 {"error":"An error has occurred, see the console logs for more information."}`; original file **byte-unchanged**; ACL restored; the same save then `200` and persists | CONFIRMED: causal denial, data safe, recoverable |
| F4 | save with **no CSRF session** | `403`; file byte-unchanged | CONFIRMED: no false success |
| F5 | `_cache/characters` replaced by a regular file | `/api/characters/all` and `/api/characters/get` still `200` | CONFIRMED: the cache is never a dependency |
| F6 | restart with a config containing a duplicate key | exit `1` with the pinned-shaped causal message (`Map keys must be unique … FATAL: Failed to read config.yaml`); full data-root census byte-identical before/after (`addedPaths: []`, `removedPaths: []`); valid config boots afterwards and the chat reads back `200` | CONFIRMED: refuse + no mutation + recoverable |
| F7 | **SIGKILL while a ~600 KB chat save is in flight** (3 attempts; killed 15–48 ms after the request) | all 3 requests were disconnected mid-flight; after restart every file is a complete valid JSONL of the **old** payload (423 B, all lines parse) — no torn write | CONFIRMED: atomic persist under mid-write termination (`atLeastOneSaveWasInterrupted: true`) |
| F8 | clean SIGTERM, then a fresh boot and read-back | clean exit; fresh process `1.19.0`; chat read-back `200`; file valid | CONFIRMED: resource release / no wedged writer |

## What this probe does NOT inject (and does not claim)

- **Provider-wire faults** (mid-SSE close, arbitrary SSE splits, a peer that never answers, a truncated
  provider body) are NOT here: a hand-posted `/api/backends/chat-completions/generate` body is not the
  product's own path (the existing probes warn against it), so the faithful way is through the five-layer
  oracle's browser legs. They are `NOT EXECUTED` for this lane and listed in
  [`oracle-strengthening.md`](oracle-strengthening.md).
- **Disk-full** is not injected: safely filling the host filesystem from inside a harness is not acceptable.
- The read-only-directory row depends on host ACL behaviour; the evidence records `restoreExitCode: 0` and a
  successful recovery save, so the row is a real observation on this host, not a portable claim.

## One real product observation from the run (not a defect)

In F3 the denied write is answered with the pinned 500 body — the same failure shape pinned's own
`/api/chats/save` catch produces. The probe did not require a nicer error; it required causal + data-safe, and
recorded the exact body so a reader can judge it.
