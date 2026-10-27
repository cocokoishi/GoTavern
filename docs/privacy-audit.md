# Lane privacy: the real fixture, the gates around it, and what is still unproven

Written 2026-10-26 from a lane whose whole purpose was AGENTS.md rule 56: **a real user's card and preset never enter
this repository or any artifact — only a desensitised derivation does.** The lane was required to work from
METADATA (chunk types, byte counts, hashes, key counts) and never to read the user's material into a log, a commit
or an agent's context. Nothing in this document quotes, transforms or reproduces user content; every statement below
is a measurement of a file that is already committed, or of a program's behaviour.

It exists because "audited" is not evidence. Each section says what is PROVEN, by what, and what would make it
fail; then what is NOT proven, in the same voice.

---

## 1. The carrier audit: what an 18.5 MB committed PNG can carry

### 1.1 The gap that existed before this lane

`tools/check-fixture-watermarks.mjs` scanned a card as (a) the decoded `chara`/`ccv3` JSON and (b) the file's raw
bytes viewed as Latin-1. Three carriers were therefore outside every check:

| # | Carrier | Why the text scanner could not see it |
|---|---|---|
| 1 | the **IDAT pixel data** | the raw pass reads the *compressed* stream; a watermark in the decoded pixels matches nothing |
| 2 | any **ancillary chunk** other than `chara`/`ccv3`/`trAc` | `eXIf` and `zTXt`/`iTXt` carry binary or compressed bytes; the derivation *preserved* unknown chunks verbatim "because the reader tolerates it" |
| 3 | a **declarable chunk's identity** (`trAc`) | re-encoded at the *same byte length*, so a length check cannot distinguish the derivation from the original |

Carrier 2 was the sharp one: the derivation's own comment said unknown chunks stay "byte for byte, because the
reader's tolerance of an unknown chunk is part of what the fixture is for". That is the correct *fixturing*
argument and the wrong *privacy* one — it would have carried an author's EXIF comment into a public repository
under a rule that reads like due diligence.

### 1.2 What now exists

`tools/png-carriers.mjs` audits every chunk and returns one of a **closed set** of verdicts, so a chunk type added
later cannot fall through a gap:

| Verdict | Meaning | Gate |
|---|---|---|
| `structure` | IHDR / IEND / PLTE; an unknown **critical** chunk is refused | refused if unknown |
| `content` | a `chara`/`ccv3` text chunk | the text scanner; the count must match what was decoded and scanned |
| `image` | the IDAT stream | must **decode to one colour** |
| `metadata` | `tEXt`(non-card), `zTXt`, `iTXt`, `eXIf`, `tIME`, `pHYs`, `gAMA`, `cHRM`, `sRGB`, `sBIT`, `bKGD`, `hIST`, `tRNS`, `sPLT`, `acTL`/`fcTL`/`fdAT` | **refused** |
| `declarable` | `trAc` (and anything the caller declares) | must equal the **manifest-recorded sha256** |
| `unknown` | any other ancillary chunk | **refused** |

The IDAT test is a property of the **decoded** data, not of a length: every pixel must equal the first, every row
must use filter type 0, and a palette image must have exactly one PLTE entry. A generator that hid the original in
the low bits of a solid image, in an interlace order, or behind an unused palette entry fails it.

### 1.3 The measurement on the committed card (metadata only)

`node tools/png-carriers.mjs tests/browser/fixtures/real/card-a.png` → exit 0:

| # | Type | Payload bytes | Verdict |
|---|---|---|---|
| 0 | IHDR | 13 | structure |
| 1 | IDAT | 3,197 | image |
| 2 | tEXt | 9,251,658 | content (`chara`) |
| 3 | tEXt | 9,251,657 | content (`ccv3`) |
| 4 | trAc | 303 | declarable |
| 5 | IEND | 0 | structure |

Decoded image: **512×768, colour type 6, one colour `#808080ff`.** The manifest records the original IDAT as
**589,824 B in 1 chunk**; the committed file's is **3,197 B**. The swap is therefore real and the picture is not
the author's art. `trAc` is 303 B and matches its recorded digest.

**What this proves:** the committed card carries no metadata carrier, its image is a re-encoded single colour, and
its only identity-bearing chunks are the two the text scanner reads and the one a digest anchors.
**What would make it fail:** any `eXIf`/`zTXt`/`iTXt`/unknown chunk; a second colour in the decoded pixels; a
`trAc` whose digest is not the manifest's; a `chara` chunk the text pass did not decode.

### 1.4 The canary tests, and the defect in my first version

`tools/fixture-gate-selftest.mjs` (run by CI: `ci.yml` step "Prove the fixture gates can refuse"; `lane.yml` step
"Prove the fixture gates can refuse, and the asset guards can fail") now plants a marker in each carrier and
requires the scanner to refuse, with a clean control card that must pass.

**The first version was decoration and the isolation assertion caught it.** Seven of the eleven cases were already
red from the *text* scanner, because the planted marker was readable Latin-1 — so deleting the carrier phase
entirely left them red, and they proved nothing about the carrier. Each case now re-runs with `--no-carriers` and
**must pass**, so the refusal can only come from the carrier phase. The markers are deliberately broken ASCII
(`…/MARK 009999`) so the text pass cannot match them.

Measured locally, then to be re-run in CI (see §5):

| Mutation | Cases killed |
|---|---|
| delete the carrier call | 10 of 10 carrier cases |
| disable the single-colour pixel test | the pixel case |
| disable the manifest digest comparison | the digest case |

Restored: **158/158 cases green.**

---

## 2. Where the gates run — and the build path as a carrier

### 2.1 Where the scanner executes today

| Path | File:line | Trigger |
|---|---|---|
| CI, on every push to `main` | `ci.yml:374-400` (`browser-evidence` job) | `push: branches:[main]`, schedule, dispatch |
| Lane CI | `lane.yml:181-197` | every lane push |
| The generator, in-process | `tools/build-real-fixtures.mjs` | every card it writes |
| Gate self-tests | `ci.yml:373`, `lane.yml:187` | as above |

### 2.2 The build path

| Surface | Scope | Carries the card? |
|---|---|---|
| `Dockerfile:10` `COPY . .` | the whole build context **minus `.dockerignore`** | **No** — `.dockerignore:9` excludes `tests` |
| `Dockerfile:27,40,41` runtime `COPY` | binary, tokenizers, LICENSE, notices | **No** |
| `go:embed` (`upstream/assets.go:9`) | `public default generated manifests` + two version files | **No** — the only embed directive in the tree |
| Release archive (`release.yml:99-121`) | an explicit allowlist: LICENSE, notices, launcher, binary, `upstream/tokenizers` | **No** — nothing under `tests/` is staged |
| Actions artifact (`browser-differential.yml:1032-1035`) | `tests/browser/*-comparison.json`, `tests/browser/fixtures/preset-*.json`, `$RUNNER_TEMP/**` | **Presets yes, card no** — the card is not in any upload glob |
| Docker build context at all | `.dockerignore` | **No** |

### 2.3 "A tracked file does not stop being uploaded because `.gitignore` changed" — and its three real instances

The failure mode is **intent does not constrain the set**. Three surfaces in this repository have that shape, and
each one is a *different set*:

| Surface | The set | Why intent does not govern it | Observed instance |
|---|---|---|---|
| **commit set** | everything staged | `git add -A` stages every modified and untracked file in the tree, including other lanes' unpublished work | **incident 2026-10-26**: a mutation commit's `git add -A` absorbed four other lanes' in-flight files; the history had to be rebuilt so each lane started from `main@a5660b6` with only its own work (16 paths in the stat, 8 of them another lane's). Cited as an incident, not as a commit: it no longer exists in any lane's history. |
| **build-context set** | whatever `.dockerignore` does not exclude | `COPY . .` copies the directory; the exclusion list is the only control | not observed for the card (`.dockerignore:9` excludes `tests`), but nothing *in the Dockerfile* records that the card is safe — the safety lives in a different file |
| **artifact set** | every path matching an upload glob | `tests/browser/fixtures/preset-*.json` matches any future `preset-*` file, whatever it contains | not observed; a future `preset-real-<user>.json` would be uploaded without any glob changing |

The remedy for all three is the same and is what the gates above already do: **an allowlist with a digest**, plus a
check that refuses what the list does not name. For the commit set that is the per-lane path list; for the build
context it is the explicit `COPY` of the release archive; for artifacts it is the fact that the card appears in no
glob.

---

## 3. CI selection: what an ordinary push actually runs

### 3.1 The routing, exactly

`browser-differential.yml:309`, inside the `differential` job:

```
MODE: ${{ inputs.mode || (github.event_name == 'push' && 'assets' || 'all') }}
```

and the same expression repeated at `:303`, `:441`, `:487`, `:684`, `:713`, `:724`, `:770`, `:796`, `:836`, `:852`,
`:882`, `:897`, `:925`, `:945`, `:988`.

Because `inputs.mode` is empty on a `push`, the first operand does not short-circuit and the expression evaluates to
`'assets'`. Every `preset`-gated step compares against `'preset'` or `'all'`, so **on an ordinary push none of them
runs**. The `helper` surface is separate and *does* run on push (`MODE_HELPER` at `:159` uses `'helper'`).

| Line | Step | Runs on push? |
|---|---|---|
| 303/309 | Record the selected drives (generation/stream) | no (`assets` is excluded at :303) |
| 441, 487 | asset legs | **yes** |
| 519, 586 | helper legs / compare | **yes** (`MODE_HELPER`) |
| 684, 713, 724, 770 | complex-preset capture, boundary search, pair, compare | **no** |
| 796, 836 | **REAL-preset legs (A and B)** + compare | **no** |
| 852, 882 | **Q20 persistence legs** + compare | **no** |
| 897, 925 | **Q21 hand-back** + judge | **no** |
| 945 | preset gate self-test | **no** |

The comment at `:46-51` describes the intent — "A push run therefore narrows itself to the asset surface" — and the
header at `:46` still says "this workflow has no `push` trigger", which stopped being true at `:52`. The comment is
stale, not the code; the *behaviour* matches the narrowing.

### 3.2 Which scorecard rows therefore rest on a dispatch or the nightly sweep

Verified against the GitHub API (`gh api repos/cocokoishi/GoTavern/actions/runs/<id>`), not from the document:

| Row | Cited run | Event | Consequence |
|---|---|---|---|
| Q3, Q4, Q5, Q6, Q7, Q15 | `40325398585` | **push** | sound — this is the asset surface, which a push does run |
| Q9 | `40378609525` | **workflow_dispatch** | rests on a dispatch, and its verdict was FAILURE |
| Q12 | `40277640647` | **workflow_dispatch** | rests on a dispatch |
| Q13, Q14 | `40274214952` | **workflow_dispatch** | rests on a dispatch |
| Q19 | `40331271988` | **push** (failure) | relayed leg only; the push runs that leg |
| Q20 | `40387864205` | **workflow_dispatch** | rests on a dispatch |
| Q10 | `40250495167` | **push** | sound — helper legs |
| Q8, Q11 | no run id (prose) | — | not checkable from this table |
| Q21 | — | — | `unproven`; the step that would produce evidence exists at `:897` and never runs on push |

**Rows that claim more than a push proves:** Q12, Q13, Q14, Q20 depend on a mode an ordinary push cannot select;
Q9's run judged FAILURE. A nightly `all` sweep does cover them, so the claim "proven" is not false — but its
durability depends on the cron, not on the push.

**Not changed by this lane.** Another lane owns a `regex` mode addition to those expressions; two lanes editing
them would conflict, so this section reports the routing and does not alter it.

---

## 4. Egress: can a probe reach the real network?

### 4.1 What AGENTS.md rule 14 requires, and what was actually asserted

Rule 14: *"Replace EVERY egress path — the module, the global `fetch`, and any SDK client — and make the assertion
say the peer received exactly the requests the fixture claims."*

| Egress path | Used by | Assertion before this lane | After |
|---|---|---|---|
| pinned `node-fetch` module | every provider route | replaced by `tools/lib/pinned-outbound.mjs` (a module-resolution hook) | unchanged |
| pinned global `fetch` | the AI Horde SDK — **the rule-14 incident** | replaced (the stub assigns `globalThis.fetch`) | unchanged |
| pinned `http`/`https`/`WebSocket` | no probe uses one | none | **unproven** (see §4.4) |
| pinned child processes | `git` routes | none; `git` does its own egress | **unproven** |
| the Go binary's transport | every replay | `mockprovider` records what it *receives*; **nothing observes a request that goes elsewhere** | partially — see §4.2 |
| the Go binary's **boot** | every replay | undeclared | **unproven** |

Coverage measured across `tools/probe-*.mjs`: **34** use the pinned outbound stub, **31** assert on
`server.outbound()`, **3** did not (`probe-images`, `probe-sprites`, `probe-vector`).

### 4.2 What this lane added

**Go side — `tests/egressguard` (new package, its own test binary).** It provides a `net.Dialer.Control` hook that
refuses any address the harness did not declare (an escape becomes `*EgressDenied`, a distinct type, so it cannot
be confused with a peer that is simply down), a **real recording HTTP proxy** the shipped transport reaches through
`http.ProxyFromEnvironment`, and `Compare`/`Assert` implementing "exactly the claimed requests": both a MISSING
claim and an UNEXPECTED arrival are failures. Its own tests prove the refusal fires on a TEST-NET-1 address, that a
CONNECT tunnel is refused and recorded, and that `outbound.Send` — the shipped client — reaches an installed proxy.

**A limitation this package found and now refuses to paper over:** `internal/outbound` exposes **no way to supply a
dialer**, and `transportFor` caches the client per TLS config while `net/http` caches the environment once per
process. A test that installed a hook after any provider request would therefore be asserting on a dialer the route
never used. `Install` returns `ErrClientAlreadyBuilt` in that situation rather than silently measuring nothing.

**One provider probe end to end — `internal/server/chat_completions_egress_test.go`.** It drives the real
`POST /api/backends/chat-completions/generate` route through the shipped transport at a declared recorder via the
`GOTAVERN_OPENAI_CHAT_URL` seam, and fails **by name as an egress finding** (not as a product defect) when the peer
receives nothing, and fails on a wrong count, method or raw target.

**The three probes that asserted nothing now do:**

| Probe | Claim now asserted |
|---|---|
| `probe-vector.mjs` | boot makes zero requests, and **every step** makes zero |
| `probe-sprites.mjs` | **every step** makes zero (local file surface) |
| `probe-images.mjs` | **every scenario** makes zero (local file surface) |

Each had a comment saying exactly this and no assertion behind it.

### 4.3 What an operator can rely on, and what not

**Rely on:** the committed card carries no metadata or pixel carrier (§1.3); a card carrying one is refused at
build time and at the CI step (§1.4); the binary, the Docker context and the release archive cannot carry the
fixtures (§2.2); the pinned provider probes fail loudly if a request leaves for an undeclared host (§4.2).

**Do not rely on:** that a Go replay would notice an escaped request in *every* test binary (the proxy observation
needs its own process, §4.2); that the preset/Q20/Q21 evidence is refreshed by a push (it is not, §3.2); that a
`git` subprocess or a browser probe cannot reach the network (nothing asserts it, §4.4).

### 4.4 Named gaps, not fixed in this lane

1. **Go boot egress.** No replay asserts that the Go binary's startup makes zero requests. The pinned side records
   `bootOutbound` and most probes ignore it.
2. **`http`/`https`/`WebSocket` inside the pinned server.** Replacing `node-fetch` and `fetch` covers the two
   functions pinned's provider routes use; a module that imports `node:https` directly would bypass both. No probe
   scans for such an import.
3. **Child processes.** The `git`-backed extension routes make network calls in a subprocess the stub cannot see.
4. **Browser probes.** The Playwright legs are outside this enumeration entirely.
5. **A syscall-level socket.** A library calling `syscall.Socket` bypasses `net.Dialer` and therefore the guard;
   covering it needs seccomp and is out of scope.

---

## 5. Evidence status

| Item | Status |
|---|---|
| carrier audit on the committed card | **measured locally**, reproducible with `node tools/png-carriers.mjs` |
| gate self-tests (158/158) | **measured locally**; CI re-run pending |
| mutation evidence (three mutations, all restored) | **local only — not evidence until CI run ids exist** (AGENTS.md verification rule 1) |
| CI-selection table (§3) | from the workflow source plus `gh api` run metadata |
| egress additions | **syntax-checked and formatted (`gofmt -e`), not compiled** — this host may not run `go build`/`go test`/`go vet` (AGENTS.md "Working mode") |

The mutation rows in §1.4 are the ones to re-read once CI has run: until a run exists with the red and the green,
they describe what happened on a development host, which this repository has already established is not the gate.
