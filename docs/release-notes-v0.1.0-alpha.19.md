# GoTavern v0.1.0-alpha.19 — the Real-Interaction Oracle release

`v0.1.0-alpha.19` is the release in which GoTavern's compatibility claim stops resting only on synthetic corpora
and starts resting on a data tree that was **actually used through the unmodified pinned SillyTavern UI**, replayed
on both subjects and compared on five observable layers. It also ships the product fixes that the new oracle found,
the performance work measured on top of alpha.18, and a fourteenth required release gate that makes the new oracle
part of the release bar rather than a one-off experiment.

## What changed

**A Node-UI-Originated Complex User Corpus.** A long-lived browser session against pinned SillyTavern 1.19.0
(`06bde939…`) created the corpus through the product's own controls: 30+ character cards (bulk imports through the
real import control plus hand-created/edited cards), 10 world books with 150+ entries (real lorebook import and
entry editor), 10 presets (real preset import + UI edit), 51 independent chats with 1,168 persisted
user/assistant messages, 5 group chats, personas, themes, Quick Replies, Regex and a pinned Tavern Helper /
JS-Slash-Runner installation whose state was exercised. The corpus is finalized with a SHA-256 manifest
(file/byte counts, tree digest, created-vs-seeded counts) and is consumed as a read-only input; it is never booted
in place.

**A re-runnable five-layer live oracle.** `tests/browser/a19-live-oracle.mjs` copies the immutable corpus once per
subject, boots pinned Node and GoTavern on their own copies, drives the same journey with one recording peer, then
restarts and hands the trees back in both directions. It compares browser state (DOM, decoded image pixels,
selection state, console/page errors, event order, final chat), HTTP (method, raw target, request/response bytes,
SSE framing), the provider wire (raw request bytes, byte-oriented), persistence (corpus census before/after,
JSONL, settings, cards, worlds, presets, extension state, cross-restart reads) and lifecycle (reload, restart,
chat switch, hand-back). Every normalisation is a named decision with its pinned evidence, field, test and
negative case; the comparator's teeth mutate its own leg artifacts and require each guard to go red by name.

**A fourteenth required release gate.** `GoTavern real-UI oracle differential` is a required workflow in
`docs/release-manifest.json`. It regenerates a UI-originated corpus in CI, runs the oracle at `mode=all`, and
uploads a fixed-name artifact whose embedded `release-evidence.json` must carry the candidate SHA, the pinned
commit, `corpus.origin=ui`, `selection.mode=all`, and five matched layers with both the manifest-file and walked-tree
digests. A mutation-tested verifier (`scripts/verify-a19-evidence.mjs`) refuses a narrowed, local, generated or
malformed document. A release now needs **14/14** same-SHA gates.

**Product fixes found by the oracle, not guessed from it.** GoTavern now answers conditional `GET`/`HEAD` with
pinned Express's 304 face on `/api/extensions/discover`, `/api/sprites/get`, `/api/data-maid/view` and
`/api/users/me` (ETag preserved, no Content-Type, no body, `Vary: Origin` only; `Cache-Control: no-cache` still
200). `pinnedChatConfigFromDirectories` parses `config.yaml` once per process like pinned instead of re-reading and
re-parsing it per request (a measured 23.2% → 1.28% of the relay window's CPU), and the runtime-mutation divergence
that came with per-request reads is removed. A streaming cancel-watchdog goroutine that leaked on a nil
`context.Done()` is fixed and bounded by a test.

**Measured performance, on top of alpha.18's hotspot work.** The 10,000-card `/api/characters/all` path now
allocates 403,148,557 B/op (was 619,914,794 at alpha.18; −35.0%) and 1,733,652 allocs/op (was 3,193,663;
−45.7%), with the cold path at −24.6% B/op and −41.7% allocs and no measured arm regressed. The changes:
an ordered-JSON fast path that avoids a per-object copy and stable sort when no member key is an array index, a
pre-sized response buffer, one chats-root listing per character-list request instead of one per card, the
differentially-pinned JSON escaper shared on the generic ordered-JSON routes, and the startup-only config cache.
Each change carries a before/after profile and a byte-identity test against the pre-change writer; rejected
attempts are recorded rather than hidden. A same-host ABBA run against the clean alpha.18 tree measured the
process-level half: warm `GET /api/characters/all` p50 on 10,000 cards 1,692.26 → 1,139.65 ms (−32.7%, every
candidate round below every baseline round), warm data-request max −32.9%, and cold peak RSS 628.07 → 361.89 MB
(−42.4%); the ABBA wrapper's own same-binary self-test passes (all metrics not-separable), and metrics it cannot
separate are reported as not separable rather than as wins. Local numbers are Layer A; the release performance
claim is the Linux `GoTavern smoke metrics` paired gate.

**Stability.** The 39-minute package-test hang was root-caused to a test peer that answered without reading the
request body (RST discarded unread bytes → a legitimate truncation → pinned-parity stall against an unbounded client
read) and fixed; the streaming path's goroutine leak was a real product defect and is fixed. A reset/save storm
test's retry bound was raised after establishing from pinned source that a 500 during the reset window is pinned
behaviour; every corruption assertion is unchanged.

## Verification

The release is published only after all fourteen required workflows complete successfully at the tag's commit,
with the full selections the manifest records; the publish step re-runs the same fail-closed verifier and appends
the same-SHA evidence table (run ids, target commit, artifact evidence) to this release's body. The local
release-admissible oracle run and its artifact paths are recorded in `docs/alpha19/`.

## Known limitations

- **`GOAL.md` §14 is not upgraded by this release.** The corpus is a tree the agent actually used through the real
  UI, but it is not a real person's years-old private directory. The §14 conditions are recorded honestly in
  `docs/alpha19/`; the strong drop-in bar remains NOT MET until a real user directory is qualified.
- **Message provenance is mixed and disclosed.** Of 1,168 persisted messages, 396 were produced through real UI
  turns and 772 were appended through the product's own `saveChatConditional` path (the prompt allows normal API
  paths as a data source). The manifest carries the split; the corpus is not claimed to be 100% UI-turn-originated.
- **Peer coverage.** The installed pinned Tavern Helper / JS-Slash-Runner state is exercised, but this round does
  not re-run the whole third-party extension corpus beyond its existing dedicated gate, and arbitrary Node server
  plugins remain the documented ecosystem exclusion.
- **Performance scope.** Peak RSS now has one paired Layer A observation (cold peak −42.4%) but it is not the
  release claim; boot-latency and readiness-RSS rows were not separable on this host and are reported as not
  separable. The Node control, ≥8-user concurrency and long-run soak steps are recorded only to the extent they
  ran; p99 on the real-UI corpus is not measured. Local ABBA numbers are Layer A; the release claim is the Linux
  `GoTavern smoke metrics` gate.
- **Platforms.** `-race` is unavailable on the Windows development host (the Linux CI `race` job is the
  concurrency gate); darwin/arm64 runtime remains the previously recorded downgrade, not a pass.

## Artifacts

Six canonical archives (`gotavern-linux-amd64`, `gotavern-linux-arm64`, `gotavern-darwin-amd64`,
`gotavern-darwin-arm64`, `gotavern-windows-amd64`, `gotavern-windows-arm64`) plus `checksums.txt`. Installers
verify the published checksum and preserve user data, config, extensions and certificates.

## Checksums

The published `checksums.txt` asset is authoritative. This note deliberately carries no copied digest: the
publish step validates every digest it writes against the checksums it produced for these exact archives.
