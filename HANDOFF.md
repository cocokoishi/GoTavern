# HANDOFF

Written at a checkpoint rather than the end of a session. Read this before touching anything. It records
where the project actually stands, what is red and why, what is unowned, and the invariants that cost the
most to learn.

Baseline: SillyTavern `1.19.0` @ `06bde939fb1e9c4c8d8641d810f0a916b5bce127`. Oracle checkout lives beside
this repository at `../SillyTavern` and is READ-ONLY.

## 1. Where the project stands

**Route accounting is CLOSED.** `docs/api-inventory.md` has ZERO routes in the bare `not implemented`
state. All 339 inventoried routes are either implemented with a recorded differential or are one of the
ELEVEN decided exclusions, so the reachable ceiling of 339 - 11 = 328 is fully implemented. That is a
statement about ROUTES. It is not a release-ready claim: almost every area is still `partial` because the
E (browser events/final state) and C (cancel/streaming) surfaces are measured for few of them, and
because the release path itself has only just begun to be EXECUTED.

The eleven exclusions, unchanged in kind: five local in-process ML (`/api/extra/{caption,classify,
classify/labels}`, `/api/speech/{recognize,synthesize}`), two Jimp re-encoding (`/api/avatars/upload`,
`/thumbnail/<computed>`), three package-owned protocols (`/api/translate/{google,bing}`,
`/api/google/generate-voice`), and `/api/search/visit` (needs the shared private-address transport
policy; `search_test.go` asserts it stays 404).

`docs/api-inventory.md` is GENERATED (header) but its **status column is hand-maintained**: the generator
reads existing statuses and keeps them. Only the header is generator-owned; a hand-written header
paragraph is silently overwritten and fails the zero-diff gate.

## 2. What the observer surfaces actually have

- **`compatible`**: THREE areas now -- chat-completions generation for the custom/OpenAI-compatible
  source (all five surfaces; its artifact was re-recorded after the `dryAfterData` red was traced to a
  RECORDING WINDOW rather than to the product -- see section 5), **Backgrounds** and **Quick replies**,
  both promoted once each browser drive ASSERTED its own gate (the Backgrounds panel that binds the
  upload handler, and `globalThis.quickReplyApi`). A drive that cannot reach its gate reports which
  precondition is missing instead of looking like a product gap.
  EMBEDDED tree), `/lib.js` byte-identical, one non-row path difference with a reason (`/thumbnail`).
- **E, both canaries**: `tests/browser/extension-littlewhitebox-comparison.json` is committed and gated
  too -- 452 rows all equal, same single non-row difference (`/thumbnail`). It was WITHHELD for one
  round on purpose: its one real difference was `/user/files/LittleWhiteBox_User.json` answering 404
  because `/user/files/*` and `/user/images/*` DID NOT EXIST. Those routes were implemented (pinned
  `users.js:1217-1218`) and the pair re-recorded, which is the rule in action: a defect gets a fix, not a
  `knownReason`. `writtenUserFiles` records what each extension WROTE; LittleWhiteBox's 626-byte JSON is
  compared by size and JSON skeleton and its digest is classified `shape` with the measured reason (a
  per-run `tx-<uuid>`), and Tavern Helper writes none -- stated, rather than passing vacuously over an
  empty list.
- **The rollback direction, newly measured**: `tests/oracle/sillytavern-1.19.0-runtime-roundtrip.json`.
  Pinned boots over a GoTavern-written tree and changes NOTHING (0 added / 0 changed / 0 removed) and
  READS it back (characters, both chat messages, the world entry verbatim). A second boot of either
  subject changes nothing. Two exclusions exist because two recordings disagreed, and the card exclusion
  is decided from the BYTES so the seeded card is still compared byte for byte.

## 3. Release path: what is now executed, and what still is not

`.github/workflows/release-qualification.yml` (tag or dispatch) builds TWO archives from the same source
with different version strings, asserts their contents and modes, runs `assets verify` FROM THE EXTRACTED
ARCHIVE, boots it, proves idempotence, extracts archive B over the install directory, then archive A back
again, requiring a user file and `config.yaml` to survive and the server to answer each time.

`scripts/qualify-install.sh` then runs the INSTALLER real users run against the same two archives over a
loopback mirror, asserting: the mirror SERVED the requests (an ignored seam shows as a missing request),
a tampered archive ABORTS and installs nothing, `assets verify` passes from the installed prefix BEFORE
AND AFTER an upgrade, and a re-install and a rollback both preserve a user file and `config.yaml` byte
for byte, and the launcher the installer WRITES starts a server.

**The finding that justified it**: `install.sh`/`install.ps1` never installed `tokenizers/`, so the
documented PRIMARY install path produced a prefix whose own `assets verify` FAILS and whose tokenizer
routes count every prompt ~25% high while still answering. Fixed (staged-and-swapped immutable
directory, and an archive without it is refused).

**Still not executed anywhere**: `install.ps1` (no PowerShell on a Linux runner), cross-baseline
upgrades, replacing a binary under a running server, proxy/TLS against the real github.com path, and
`gotavern migrate` -- which DOES NOT EXIST (docs/INSTALLATION.md section 6 now says so; its required
capabilities are a tracked increment).

## 4. The working model (this is what makes the CI budget survivable)

The development host cannot carry the build load and its Go cache once filled a 149 GB disk.

- **Per-lane worktrees and per-lane Actions.** Each lane works in `wt-<name>` on branch `lane/<name>` and
  verifies in `.github/workflows/lane.yml` (`gofmt`, `go build ./...`, `go vet ./...`, `go test ./...`
  with a proof that tests EXECUTED). The Lead merges green lanes and pushes main ONCE per batch, because
  a main push that touches fixtures triggers the oracle.
- **No local Go builds.** Lanes download a CI-built binary (`gotavern-lane-binaries`, linux + windows)
  and pass `GOTAVERN_BINARY`. The oracle job builds its own linux binary.
- **Pinned boots are serialised** by `tools/pinned-boot-lock.mjs run -- <cmd>`; the lock lives in the git
  COMMON directory so it works across worktrees. Without it, concurrent boots run concurrent pruned
  webpack compiles and every other lane dies on a 180 s readiness deadline.
- **The oracle is narrowed**: `GOTAVERN_ORACLE_PROBES` re-records only the probes a push can affect
  (full set on schedule/dispatch and for `tools/lib/**`, the generator, or `upstream/**`). The zero-diff
  check still covers every fixture -- narrower, not weaker.
- Docker runs on its own workflow (Dockerfile/installer paths, weekly, or dispatch), not per push.

## 5. Rules learned the expensive way this session

These are now also in `AGENTS.md`; the instances below are what they cost.

- **A fixed sleep is not a state.** `dryAfterData` gotavern=1 / pinned=2 sat inside a `compatible` row as
  an unexplained red. The cause was the probe attaching its recorder a few statements before the send
  click, so on the slower leg the tail of the prompt-manager dry generation landed inside the window.
  Proof it was a window: the pinned record held a dry `GENERATE_AFTER_DATA` with NO dry
  `GENERATION_STARTED` (impossible per `script.js:4299/5318/5320`), both legs' own logs recorded the same
  invocation count, and the asymmetry moved to whichever leg was slower across four pairs. The drive now
  waits for QUIESCENCE before the send and closes the window at `GENERATION_ENDED`; the compare script
  exits 1 on a false window guard AND the committed-artifact gate checks those guards, because otherwise a
  false guard could be committed with CI green.
- **A gate that is not read is decoration.** `verify-browser-comparisons.mjs` did not read the extension
  artifact until this session. Its first generic version would also have described a real 404-vs-200 as
  "an asset fetched by only one page load"; a status difference where BOTH drives issued the request is
  now `SERVER RESPONSE DIFFERENCE, not decided`, and a reason naming no mechanism is rejected. Proved by
  swapping the LittleWhiteBox comparison into the artifact slot and getting exit 1 with the path named.
- **A red run must be able to name its failing test.** `lane.yml` piped `go test -v` through
  `tee ... >/dev/null` under `set -e`; a failing test aborted at the pipe and printed nothing. Two lanes
  reported it. The status is now captured first and the tail always printed.
- **A shared `%TEMP%` filename is shared mutable state.** One lane's commit message landed on another
  lane's commit through `%TEMP%\lane-commit-msg.txt`; use a lane-unique path.
- **A lib change is a global claim.** `holdOpen` in `tools/lib/pinned-outbound.mjs` was held until its
  author proved the fixture double-recorded byte-identically AND an untouched probe (`probe-nanogpt`)
  re-recorded unchanged with the change in place.
- **Stale negatives are the most expensive doc error.** This session corrected: "extension static serving
  is unimplemented" (its row compared 43 responses), "the data-domain comparison is not gated" (the block
  was added in the same commit as the artifact), "none of the 19 SD generate routes is registered" (all
  were), `INSTALLATION.md` promising `gotavern migrate`, and a malformed matrix row.
- **Disk is a shared resource.** At 0.32 GB free, `go build` failed with a `link.exe` truncate error and a
  pinned boot failed readiness, which reads as a code defect. `go clean -cache` plus stale `%TEMP%`
  sweeps freed 31.5 GB; check free space BEFORE diagnosing a readiness failure.
- **Measure like-for-like.** One lane reported "9,454 ms vs 25 ms" for `/api/backgrounds/all`; it was
  cold-vs-warm. The real numbers were 8,769 vs 4,077 cold. The defect was still real (over the
  frontend's ~5 s window) and the fix (no per-pixel heap allocation) makes it 3,422 ms. Reporting the
  correction rather than the convenient figure is what made the fix trustworthy.

## 6. Next actions, in the order the evidence supports

1. **C for OPENROUTER** (streamed + abort): the last surface that source is missing. The paced SSE peer
   exists for the custom source and the seam pair exists from the OpenRouter work; the drive must assert
   on BOTH legs that the client disconnect reached the provider, because "the page stopped rendering" is
   not cancellation.

2. **The next source transports.** FOUR of 25 chat-completion sources are real (openai, custom, openrouter,
   claude); every other answers 501 so an unimplemented branch stays distinguishable from a refused one.
   Each source needs its own provider-wire scenarios, and the first question for each is which KIND it is:
   a base-URL variant, a shared-helper variant, or a branch with its own body AND response transform. Both
   source lanes so far had that answer wrong in the brief (OpenRouter was assumed to be "OpenAI with a
   different URL"; Claude was assumed to be reachable through the generic plan path).

3. **`docs/compat-matrix.md` row by row** is being audited because a docs audit of two OTHER files found
   seven false claims, two of which would have cost a user real time. The matrix is the file that tells a
   reader what is compatible, and a stale row is indistinguishable from a verified one at a glance.

4. **The named gaps inside the two new sources**, each recorded rather than implied: OpenRouter media
   embedding, reasoning signatures, the config-gated prompt-cache transforms and the gemini
   `isOpenRouterModelCacheable()` `/models` probe (deliberately deferred because it changes the request
   COUNT); Claude's caching helpers and `promptPlaceholder`; Mistral's `mistral.enablePrefix`.

5. **The Windows-only installer behaviours** that no runner can execute -- replacing a RUNNING
   `gotavern.exe` (the branch Windows users actually hit on update), path separators, registry/shortcuts,
   `cmd.exe` -- remain named in three places and unverified everywhere.

6. **A cross-baseline upgrade** is still unexecuted, and so is a running-server replacement test.
## 7. Working agreements

- Teammates own their lane branch and push it; the Lead merges and pushes main in batches.
- Compute belongs on GitHub Actions. Locally: `gofmt`, `node --check`, probe recording, and nothing Go.
- Never run `tools/build-generated-lib.mjs` locally.
- When a lane cannot be finished, contribute the READ you did (what you verified, what you corrected,
  what is still unread) rather than a stub. Several of the best findings arrived that way.
