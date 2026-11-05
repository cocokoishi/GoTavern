# GoTavern v0.1.0-alpha.15 — the final engineering-audit release

`v0.1.0-alpha.15` is the stable-channel release that ends the 0.1.0 line's engineering program with an
audit rather than a feature: the gates were first proven able to fail, then used. It keeps the same
SillyTavern 1.19.0 baseline and the same compatibility contract as alpha.14.

Three things were delivered, and the order matters. **First, the test machinery was audited for the ways it
could report success while proving nothing** — fourteen such holes were found and closed, each by reproducing
the old false PASS and then showing the new refusal by name. **Second, the audit was applied to the product
and to the data paths**, which produced two real defects (both credential/transport, both reproduced before
the fix), a set of data-safety gates that kill real processes and provoke real kernel write failures instead
of asserting on returned errors, and browser lanes for four user actions that had no probe at all. **Third,
one optimization was accepted and measured**, and two were declined or deferred with their measurements
recorded rather than quietly dropped.

## What changed

**Two real defects, both in the provider transport.**

- A redirect that changes **protocol** no longer carries credentials. Pinned's provider client is
  node-fetch 3.3.2, which deletes `authorization`, `www-authenticate`, `cookie` and `cookie2` when a redirect
  changes the domain **or the protocol**; Go's `net/http` only compares hostnames, so a same-host
  `https → http` redirect forwarded the bearer token to the plaintext target. The reproducer was red before
  the fix and names the leaked value.
- The redirect **follow limit** was our number (5), not pinned's (20). A twelve-hop CDN chain failed where
  pinned succeeds.

**Data safety, proven by killing processes.** Settings and chat writes killed mid-write leave a complete old
or complete new document (byte equality, not "parseable"); a Linux-only launcher sets `RLIMIT_FSIZE` and
execs the shipped binary so its own write fails with a real `EFBIG` from the kernel, with the old document
surviving byte-identically; readers during a save can only ever observe old XOR new, and a partial observation
is the FIRST assertion rather than being excused by a later count; corrupt chats, worlds and settings boot
without being rewritten; two real processes on one data root end as one writer's complete document; an
interrupted migration re-runs with its source byte-identical; `migrate --force` keeps a bootable old runtime;
and spaces/CJK/emoji in the data root and config path are the directories actually written. Ten mutations
were each observed red and restored by byte copy.

**Four user actions that had no probe.** Swipe right/left, edit a message, delete a message through the real
confirm popup, and a `/sys` slash command are now driven through the unmodified pinned frontend with real
pointer/key events, and the provider requests are compared byte-wise. The probe records five DIFFERENT
evidence classes per step — page loaded, control actually pressed, chat DOM, request sha256, disk after save
and after reload — and a step cannot borrow another class's evidence. The differential closed with four
provider requests byte-identical, eight per-step snapshots equal, and the persisted chat equal after
save+reload. Seven driver mutations were each observed red.

**The release gate now reads jobs, artifacts and their content.** A green workflow run whose required job was
skipped (the default long-lived dispatch leaves its medium tier skipped while the RUN is green) can no longer
count; a required fixed-name artifact must exist and not be expired; and the artifact's embedded evidence
document is read out of its ZIP and checked for kind, schema version, tier marker, embedded head SHA and
sha256 digests. Two independent evidence surfaces were promoted into the manifest: the long-lived corpus at
its MEDIUM tier, and the Node stock-tree round trip. Fifty-five governance tests, thirty-four of them
fabricated-API refusals, and four mutations prove the verifier refuses rather than passes.

**One deterministic corpus, or two?** Answered with code: both shipped generators now emit one shared schema
for the initial tree (per-file path/size/sha256/class, counts, feature flags, markers, tree digest), a
verifier checks any tree against either manifest, and a comparison tool measured why the corpora stay two:
`TWO_CORPORA_SHARED_SCHEMA`, `byteIdentical: false`, `separateCorporaJustified: true`, with 67 named
difference classes — the Go corpus owns ten surfaces the JS corpus lacks (legacy migration input, sprites,
extension state, moving UI, text presets, chat backups, binary unknown files, `is_system` messages and
embedded books, secrets, regex-keyed world entries) and the JS corpus owns two the Go one lacks plus the long
branch/swipe/deleted-turn histories. Collapsing them would delete coverage, so the bridge proves schema
identity instead of claiming corpus identity.

**The optimization, and the two that are not here.** The accepted change is an identity-keyed cache of the
decoded card text for `/api/characters/all`, keyed by absolute path plus file identity, with no TTL, bounded
by entries and bytes, LRU one-at-a-time, and every per-request projection still running. Its measured effect
is an allocation reduction on every warm row (−10.4% at 10 000 cards, −39.6% for large card text) with a
strong ns win at the small-card scales; a 10 000-card ns win is NOT claimed, because on the shared host the
before/after spread exceeded the delta, and the quiet-host paired arms decide the wording. The first Linux
`-race` run found a REAL data race in the new cache's lookup (it read mutable entry fields after dropping the
mutex while a store replaced them) and the fix is one critical section: the development host cannot run
`-race` at all, which is precisely why that job exists. A compressed static-asset response cache was
**declined**: it sits in the protected frontend-serving area and would move the page-load figure the evidence
gate is built on — its measured ROI is recorded for a future release. A chat-search matcher change was
**deferred** until an oracle fixture can decide JavaScript's context-sensitive case mapping.

## Performance

## Compatibility

The compatibility claims are unchanged from alpha.14 and are re-run at this release's commit: the packaged
archive boots a stock tree on Linux and Windows, the browser differential drives the pinned frontend (now
including the conversation-editing lane), the 20 pinned third-party extensions each install, activate, persist
a setting across a restart, disable, re-enable and uninstall on both subjects, the long-lived corpus is
qualified at its medium tier, the Node stock-tree round trip is a release gate, and every provider-wire
capture is compared byte for byte. The two-corpus schema bridge proves which initial tree each leg drove.

## Known limitations

- **The strong drop-in claim in `GOAL.md` §14 is still NOT MET, and this release does not claim it.** The
  evidence covers two synthetic corpora (one built by Go, one by Node), a packaged archive over a derived
  stock tree, the 20-extension corpus and the browser/provider-wire differentials. No real, long-used user
  directory has been qualified: this round's disposition for the private channel is `PRIVATE_NOT_RUN`,
  because no authorised original is present on the qualification host. `docs/real-user-input-audit.md` §8
  records which items are unrun, which are partial, and why the instruments remain canaried-only.
- **Full-disk `ENOSPC` itself is unproven by policy.** Reproducing it needs a privileged small mount and this
  round forbids elevation, so the kernel write-failure class is proven with `EFBIG` instead. That is recorded
  as `unproven (policy: no elevation)`, not as a defect.
- **M4 stays partial**, unchanged from alpha.14: the `orderedjson` extraction is refused with its measurement
  (152 files / 1 463 references to unexported fields), and the two move-only extractions landed after the
  tag.
- **No brotli encoder.** A `br`-only client receives identity; a dual-offer client receives gzip. Reversible.
- **Node's `requestTimeout` is not mapped.** A whole-request deadline would put a deadline under every
  upload; cancellation is proven to reach the provider connection instead.
- **Windows account-cache boundary.** A same-size, timestamp-preserving external restore while the server runs
  can serve a stale record until mtime/size changes, eviction or restart. The Unix path detects it via ctime.
- **The character-card disk cache pinned maintains is not implemented.** It is a derived, rebuildable cache
  pinned writes under `<dataRoot>/_cache/characters`; no user byte depends on it. Recorded as `partial`, not
  as a defect.
- **A 301/302 redirect with PUT/DELETE keeps its method under node-fetch but not under `net/http`.** No
  provider path issues PUT/DELETE on a redirect; recorded rather than rewriting redirect handling for it.
- **Environment proxies are honoured even when the request-level proxy option is disabled.** This is a
  deliberate divergence: `AGENTS.md` rule 29 makes proxy awareness a product requirement. Recorded so an
  operator can see it.
- **Verifier gap classes that remain open:** a shape-classified row is still counted as `equal` (F17; fixing it
  re-records a committed observation), committed browser artefacts carry no head SHA / workflow / run id /
  mode, and group-chat / Quick Reply CREATION through the UI and `in_use` on an ordinary turn are named
  `not-asserted-through-the-UI` / `covered-by-helper-path` rather than silently passed.
- **Moving UI browser persistence and the opened-card editor image are UNPROVEN at this release.** Both have a
  committed probe with the five evidence classes labelled, and both are blocked by a named harness
  precondition (the probe's page renders no character rows although the API serves them, while the existing
  asset probe on the same tree renders them), so the probe refuses to report product findings and its
  mutations are listed as owed rather than run. The Go long-lived test locks the Moving UI preset FILE, which
  is a different claim from "a user sees the layout restored after a restart".
- **Every browser probe's page init reached the live network at this baseline.** The shipped default
  `main_api` makes the pinned frontend fetch a model list during page init, and the server-side branch fetches
  the public Horde endpoints; the harness seam to redirect them exists but no probe used it. Recorded as an
  isolation finding with the exact endpoints and left OPEN rather than improvised in a release freeze.
- **The large long-lived tier is not a browser gate, by design.** The driver refuses more than 100 MB /
  5 000-message chats; the nightly rail covers generator determinism, the loader and the Go boot.
- **A narrowed oracle dispatch is not the full oracle.** Only the scheduled full sweep covers every probe.
- The alpha.13 non-claims stand: arbitrary Node server plugins, local in-process ML, remote provider
  embeddings, wire formats inside third-party npm packages, per-chat backups and VertexAI service-account
  mode remain out of scope for the stated reasons.

## Artifacts

Six prebuilt archives (`gotavern-linux-amd64.tar.gz`, `gotavern-linux-arm64.tar.gz`,
`gotavern-darwin-amd64.tar.gz`, `gotavern-darwin-arm64.tar.gz`, `gotavern-windows-amd64.zip`,
`gotavern-windows-arm64.zip`) plus `checksums.txt` are attached to this release; verify with
`sha256sum -c checksums.txt`. The Docker image `ghcr.io/cocokoishi/gotavern:v0.1.0-alpha.15` is published by
tag, and `:latest` moves to it because this tag classifies as stable.

Runtime-qualified vs build-only, stated rather than implied: linux/amd64 and windows/amd64 are executed by
the qualification jobs; linux/arm64, darwin/amd64, darwin/arm64 and windows/arm64 are BUILD-ONLY (compiled and
packed, never executed) because this repository has no runner of those architectures.

## Evidence

The same-commit required-gate table is appended to this body by the publish job, so every claim above is
checkable against the run that produced it. `docs/audit-v0.1.0-alpha.15.md` is this round's blind-spot ledger
(eighty rows, the false greens that were killed, and everything still unproven), `docs/goal-scorecard.md` is
the per-question ledger, and `HANDOFF.md` is the current checkpoint.
