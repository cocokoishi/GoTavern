# alpha.20 oracle / corpus lane (`a20/oracle`)

This directory is the evidence home of the alpha.20 **pinned-behaviour probes**, the **multi-tier UI-originated
corpora** and the **oracle strengthening** work. It is human-readable provenance next to the raw evidence each
probe writes; a claim here without a probe row is a bug.

## Pinned-behaviour probes (M1 disclosed gaps → real captures)

| probe | question | state | evidence |
|---|---|---|---|
| [chat-integrity.md](chat-integrity.md) | `chat_metadata.integrity` + `body.force`: statuses, error bodies, file/backup changes | **CONFIRMED** (14 rows) | [`chat-integrity/evidence.json`](chat-integrity/evidence.json) |
| [group-save-backup.md](group-save-backup.md) | `/api/chats/group/save` vs normal save: path, backup naming, throttle, retention sharing, flush-on-close, failure, restart, no invented `.bak` | **CONFIRMED** | [`group-save-backup/evidence.json`](group-save-backup/evidence.json) |
| [encoding-negotiation.md](encoding-negotiation.md) | Accept-Encoding / Brotli: raw pinned vs GoTavern responses, representation sizes, cost/benefit | **CONFIRMED + DIFFERENT (disclosed)** | [`encoding-negotiation/evidence.json`](encoding-negotiation/evidence.json) |
| [character-cache.md](character-cache.md) | `_cache/characters`: key/filename derivation, create/hit/invalidate/update/delete/corrupt/concurrent/restart/external modification/Node→Go→Node — including the pinned misaddressed-key verify quirk | **CONFIRMED** | [`character-cache/evidence.json`](character-cache/evidence.json) |
| [pinned-data-template.md](pinned-data-template.md) | the measured pinned fresh-install template the probes copy (product-produced, never hand-authored) | **CONFIRMED** | [`pinned-data-template/evidence.json`](pinned-data-template/evidence.json) |

All probes boot the READ-ONLY pinned checkout at
`06bde939fb1e9c4c8d8641d810f0a916b5bce127`, never write it, and write evidence with sorted keys so two runs
diff cleanly. Every probe records the exact command, the pinned identity, the data-root template digest and
the raw request/response bytes (or their digests and lengths where the body is large).

Decision records taken on the M1 gaps are in [`decisions.md`](decisions.md) (Brotli kept as the exact
disclosed difference; `_cache/characters` kept at verify-only parity).

## Multi-tier UI-originated corpora (M2)

Targets and the driver: `tests/browser/a20-corpus-tiers.mjs` (orchestrator), `a20-corpus-topup.mjs`
(category shortfall through real UI controls), `a20-corpus-fill.mjs` + `a20-corpus-catchup.mjs` (chat and
message minimums; product-native layers counted separately), `a20-corpus-provenance.mjs` (message
provenance derived from the persisted JSONL bytes), the existing `a19-corpus-builder.mjs` base rounds,
`a19-message-topup.mjs` and `a20-corpus-report.mjs` (target/achieved counts + provenance layers). The corpus
tree itself stays outside the repository; only the manifest and this report are committed candidates.

**Status: a medium-tier tree was built and its counts were measured, but the final manifest/report were
deferred by the Lead's quiet window and are NOT claimed here until they are written.** The remaining
documents for this lane (`corpus-tiers.md`, `pinned-data-template.md`, `oracle-strengthening.md`) are
written only when the measurement they describe has run.

## Oracle strengthening (M3)

The five-layer framework (`a19-live-oracle.mjs` + `a19-compare-live-oracle.mjs` + `a19-oracle-teeth.mjs`) is
extended additively; no second oracle framework is created.

- `tests/browser/a20-probe-differential.mjs` runs the probe-(a)/(b) scenario matrices on BOTH subjects and
  compares the observable tuple. Its pre-fix result is kept as
  `chat-integrity/differential-before-fb24983.json` / `group-save-backup/differential-before-fb24983.json`
  (the branch was still pre-`fb24983` when it ran): the pre-fix binary differs on 11/14 chat and 7/11 group
  scenarios, which is the RED half of a RED→GREEN pair. **The post-fix rerun was stopped by the quiet
  window and is NOT claimed until it runs.**
- `tests/browser/a20-differential-teeth.mjs` applies one adversarial mutation at a time to the recorded
  differential legs (status, response body, chat file, backup bytes, backup name, dropped row, added row,
  flush counts, retention, restart read-back), requires the named field to go RED and the pristine artifact
  to be byte-unchanged; a negative case proves the single documented normalisation (wall-clock backup
  timestamp) is not over-broad. **It is written but NOT executed yet** (it refuses to run on a non-green
  baseline), and is reported as NOT EXECUTED until it has run.

## Method rules this lane follows

- Pinned source is read first, then a real run confirms the branch; a status code is never assumed from
  memory.
- Filesystem corruption/modification rows are labelled as probe setups; product actions are never simulated
  and presented as product behaviour.
- No fake evidence: `evidence.json` files are written by the probe that ran, not edited by hand.
- A probe that cannot reach a branch marks it `UNPROVEN` with the reason rather than asserting it.
