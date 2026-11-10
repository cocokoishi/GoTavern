# alpha.20 decision log

Decisions that shape the round; each records the evidence it rests on and what it forbids a later reader
from re-litigating. Superseded decisions stay, marked.

## D-01 — Baseline stays pinned; no upstream bump
SillyTavern stays `1.19.0` @ `06bde939fb1e9c4c8d8641d810f0a916b5bce127`. alpha.20 may not bump it; a bump is
its own change carrying pinned-source evidence for every observable it moves. The oracle checkout is
read-only.

## D-02 — Brotli response negotiation: keep the exact disclosed difference
Pinned (compression middleware, Node 24) answers `br` for browser-like `Accept-Encoding`; GoTavern answers
`gzip` and a `br`-only client gets identity. The oracle lane measured raw `node:http` captures: decoded
representations are IDENTICAL on all seven probed resources (so this is a codec-only difference), e.g.
`/script.js` pinned br 118,271 B vs Go gzip 124,918 B (+5.62%) and a br-only client receives 497,669 B
identity; the threshold bracket is 1,023 vs 1,029 B. Implementing br needs a new pure-Go dependency plus an
outbound decoder for `/proxy`; that cost (dependency, binary size, maintained decoder) outranks the benefit of
a codec-only difference whose decoded bytes already match. **Decision: keep the disclosed difference; do not
add the dependency in alpha.20.** Evidence: `docs/alpha20/oracle/encoding/`.

## D-03 — `_cache/characters`: keep verify-only parity, do not add the read/write cache
Pinned writes node-persist records `<abs path>-<mtimeMs>` (filename `sha256(key)`, value = card text) and a
pinned quirk makes its `verify()` prune almost nothing; GoTavern reproduces the directory creation and the
`verify()` behaviour (`internal/startup/character_disk_cache.go`). The read/write cache is NOT implemented
because: it is a derived cache holding no user byte; a second persistent store is exactly the invented-DB
shape the product contract forbids; and the measured startup cost is the verify pass (profile: 31.4% of cold
10k-card boot), which the cache does not remove. The record-format evidence is kept so a later round can
revisit the decision with data. Evidence: `docs/alpha20/oracle/character-cache/`.

## D-04 — Chat integrity and group-save backup: implement pinned semantics exactly
Both gaps recorded in alpha.18/19 are closed (`fb24983`). The pass/fail table, `force` JavaScript truthiness,
config-read-at-boot, readFirstLine/BOM/strict-equality details and the group backup key are implemented from
pinned source and cross-checked against real pinned runs. Do not "improve" this: the check exists to REFUSE
an overwrite, so a convenience fallback or a normalisation here is a compatibility defect. Remaining disclosed
limit: pinned's console.error diagnostics for these branches are not reproduced.

## D-05 — Socket-close interrupt: one watcher type, not per-route goroutines
The pinned `!response.writableEnded` guard is expressed by a completion flag published before `ServeHTTP`
returns (`internal/server/socket_close_watcher.go`), used by all four routes. A bare `<-ctx.Done()` watcher is
forbidden by this decision: it fires on normal completion, which cancels generations. The control test that a
real in-flight disconnect still interrupts is part of the guard, not a nicety.

## D-06 — Performance: profile first, one append-buffer serializer, no cache-everything
A representative hotspot must show >=30% improvement and two more >=15% (or `NOT SEPARABLE`), with same-input
ABBA and an A/A self-test. Approved approach: replace `marshalOrderedNodeJSON`'s per-node `bytes.Buffer` +
per-string allocation with a single append-based buffer and an optional size hint that may only pre-size
(wrong hints must produce identical bytes). REJECTED: a parsed card-tree cache (C6) and any "keep parsed data
in memory" scheme — they trade memory and staleness for benchmark numbers and hide the real cost. Byte
identity is the acceptance gate, not a benchmark delta.

## D-07 — README and figure: product homepage, evidence in docs
README's first screen (everything above `## Release status`) must shrink by >=40% against alpha.19's 11,170
chars while keeping the install commands and the honest limits block; methodology, gates and SHA evidence move
to `docs/`. The performance figure is hand-authored SVG (dark+light) generated from validated artifacts by a
script, with honest zero-based axes, readable labels and colour-blind-safe encoding; numbers may not be
hand-edited, and the data source is recorded beside the figure. No CI/SHA/gate jargon above the fold.

## D-08 — Release rails: keep the 14 gates, do not add a fifteenth without the five justifications
alpha.20 keeps every existing required workflow, fail-closed verifier and evidence contract. A new gate is
allowed only with: the behaviour existing gates cannot prove, its single responsibility, how it prevents false
positives, its maintainer, and its CI cost. No weakened filters, skipped jobs, renamed tests or removed
assertions to get a green. The full wave must run at ONE candidate SHA; runs from other SHAs are never spliced.

## D-09 — Corpus provenance counters are separate and never merged
UI-created, UI-interacted, product-native-save, generated-stress-only and imported-native data are counted
separately in every corpus report. Volume chats/messages created by the product function behind the New Chat
control are product-native, not "UI-created"; a UI-created sample is reported as a sample. Achieved counts and
the exact boundary are reported when a tier target is unreachable. No meaningless duplicate filler.

## D-10 — Findings require reproducers; a co-tenant test failure is not a product defect
A finding enters `docs/alpha20/audit/` only with a real reproducer, pinned source/behaviour where applicable,
RED/GREEN evidence and a named regression guard. A test that fails under co-tenant CPU load but passes in
isolation and shows a TempDir-cleanup race (not a data-safety assertion) is classified as the recorded
harness race, with the evidence written down; it is promoted only if it reproduces without co-tenant load.
