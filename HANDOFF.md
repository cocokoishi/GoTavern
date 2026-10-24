# HANDOFF

Written at a checkpoint rather than the end of a session. Read this before touching anything. It records
where the project actually stands, what is red and why, what is unowned, and the invariants that cost the
most to learn.

Baseline: SillyTavern `1.19.0` @ `06bde939fb1e9c4c8d8641d810f0a916b5bce127`. Oracle checkout lives beside
this repository at `../SillyTavern` and is READ-ONLY.

## 0. Working mode, and what changed in this checkpoint (2026-10-24)

**The host does not build, test, probe or drive a browser.** Every one of those runs in GitHub Actions;
locally there is editing, `git`, and `node --check` on a file you just wrote. `AGENTS.md` has the full
rule and `docs/development-loop.md` has the loop. There are no pull requests: one lane branch per task,
pushed once, merged into `main` by the lead, branch deleted. That is a reaction to a real failure -- five
concurrent lanes meant five PRs and five duplicate multi-hour oracle sweeps, and the branch namespace had
grown to eighty lanes. Nothing was lost: the deleted history is archived in
`../gotavern-branches-archive-2026-10-24.bundle`.

What this checkpoint did, in order (each lane verified on its own cheap checks; the `main` run is the
verdict for the expensive ones):

1. **Released `v0.1.0-alpha.1`** from `2dde1fa`, after fixing the publish job's missing checkout. It is a
   real prerelease: six canonical assets plus `checksums.txt`, digests recomputed after download, archives
   opened and the 23 tokenizer files byte-compared against `upstream/tokenizers`, both installer parsers
   executed against the published checksum file, and `releases/latest` deliberately 404 for an alpha.
   Run ids: release `40066449948`, qualification `40066449918`, docker `40066450018`.
2. **Oracle execution core.** `doubleRunFor()` was dead code: 118 declarations ran twice in every mode and
   `GOTAVERN_ORACLE_DOUBLE_RUN` did nothing. One `executeProbe` primitive in `tools/oracle/execution.mjs`
   now sits behind both scheduling shapes, the policy is on its execution path, narrowed sweeps record
   once, a double run surfaces BOTH errors, and 29 contract tests were red before the fix.
3. **Oracle planner.** The selection rules left the YAML. `tools/oracle/manifest.mjs` derives the
   dependency graph from the declarations, `tools/oracle/plan.mjs` turns a changed-file list into a JSON
   plan, and both are table-tested. It fails CLOSED: an unattributable path is a full sweep, an unknown
   requested probe is an error, an empty selection on a needed run is an error. It closed a real fail-open:
   `internal/**`, `cmd/**` and `tools/*/main.go` used to skip the oracle although ~20 probes `go run`
   repository Go and `runtime-roundtrip` records three `"subject": "gotavern"` steps.
4. **Documentation truth.** HANDOFF's old §8 was 123 commits stale and told a reader that Gemini, Moonshot
   and eleven other sources were unimplemented; `compat-matrix.md` simultaneously claimed 73 and 187
   scenarios. Every claim was re-measured, generated counts moved into `docs/generated/facts.json` with
   marked blocks and a `--check` gate, and facts that cannot be derived are date-stamped. A real product
   bug is now recorded rather than absorbed: AI21, VERTEXAI and PERPLEXITY have no status arm and answer
   501 where the pinned closing `else` answers 400.
5. **Chat-completion dispatch.** `chat_completions.go` shrank from 1301 to 762 lines: one registry row per
   source (`chat_completions_registry.go`), 55 dead or unreachable arms deleted across the plan, response
   and status chains, the eight byte-identical response mappers collapsed, each provider's plan moved into
   its own file, and a `go/ast` scanner test that fails on a duplicated source arm. The 187 provider-wire
   scenarios replay byte-identically before and after.
6. **Browser harness.** Fifteen independent source enumerations became one driver-only catalogue
   (`tests/browser/sources.mjs`); the verifier split into generic invariants plus named hooks
   (`tools/browser-evidence/`); cancellation at the provider is now checked for 15 of 15 streaming
   artefacts instead of 11; the claude/mistral seam claim is now true instead of merely printed; and
   `.github/workflows/browser-differential.yml` re-records both legs against HEAD and diffs fresh against
   committed, which is the freshness layer the old verifier openly could not provide.

**Open, and labelled as open:** the artefacts recorded before the new verifier schema do not satisfy it
until the differential workflow re-records them (12 of 30 artefacts, 40 findings, all staleness); the
complex-preset differential does not exist yet; cohere is catalogued but never recorded; workers_ai can no
longer be driven. Those are the next slices.


## 1. Where the project stands

**Route accounting is CLOSED.** <!-- BEGIN GENERATED: routes.accounting -->`339` inventoried routes; `0` bare `not implemented`; `11` reasoned exclusions; `328` reachable.<!-- END GENERATED: routes.accounting --> That is a statement about ROUTES. It is not a release-ready claim: almost every area is still `partial` because the
E (browser events/final state) and C (cancel/streaming) surfaces are measured for few of them, and
because the release path itself has only just begun to be EXECUTED.

The reasoned exclusions, unchanged in kind: five local in-process ML (`/api/extra/{caption,classify,
classify/labels}`, `/api/speech/{recognize,synthesize}`), two Jimp re-encoding (`/api/avatars/upload`,
`/thumbnail/<computed>`), three package-owned protocols (`/api/translate/{google,bing}`,
`/api/google/generate-voice`), and `/api/search/visit` (needs the shared private-address transport
policy; `search_test.go` asserts it stays 404).

`docs/api-inventory.md` is GENERATED (header) but its **status column is hand-maintained**: the generator
reads existing statuses and keeps them. Only the header is generator-owned; a hand-written header
paragraph is silently overwritten and fails the zero-diff gate.

## 2. What the observer surfaces actually have

- **Promotions**: chat-completions generation for the custom/OpenAI-compatible source is `compatible`
  (all five surfaces; its artifact was re-recorded after the `dryAfterData` red was traced to a
  RECORDING WINDOW rather than to the product -- see section 5). **Backgrounds** and **Quick replies**
  are promoted once each browser drive ASSERTED its own gate (the Backgrounds panel that binds the
  upload handler, and `globalThis.quickReplyApi`). Chutes and Electron Hub are `compatible` for the
  flows their own rows measure. A drive that cannot reach its gate reports which precondition is
  missing instead of looking like a product gap.
- **<!-- BEGIN GENERATED: browser.sources -->`15`<!-- END GENERATED: browser.sources --> chat-completions source pairs have committed E/streaming artefacts**: the custom pair plus
  OPENROUTER, CLAUDE, MISTRALAI, GROQ, SILICONFLOW, NANOGPT, WORKERS_AI, DEEPSEEK (`POST
  /beta/chat/completions` asserted on both legs), OPENAI, CHUTES, ELECTRONHUB, AIMLAPI, AI21 and XAI --
  `tests/browser/{generation,streaming}-<source>-comparison.json`. Not all are current: the computed
  matrix in `docs/surface-coverage.md` is authoritative for which rows are current, stale pending the
  browser re-record, or have no browser drive. Cancellation is proved at the provider by
  `clientDisconnected` on both legs in each current streaming artefact; stale artefacts are listed in
  the matrix rather than counted as coverage.
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

**CUTTING THE FIRST TAG, and what a prerelease does.** `scripts/classify-version-tag.sh` decides a tag's channel
and both release workflows obey it: only a tag that is exactly `v<major>.<minor>.<patch>` is STABLE; anything else
version-shaped (`-alpha.1`, `-beta.2`, `-rc.1`, `+build`) is a PRERELEASE; a name that is not a version tag is
refused rather than guessed. For `v0.1.0-alpha.1` that means `docker.yml` publishes
`ghcr.io/cocokoishi/gotavern:v0.1.0-alpha.1` and leaves `:latest` untouched, and `release.yml` creates the GitHub
Release with `--prerelease --latest=false`, so `releases/latest/download/...` -- the URL both installers fetch --
keeps pointing at a stable release instead of an alpha. The rule is covered by
`scripts/test-classify-version-tag.sh` in the `verify` job (commit `84648b2`, run 40056851570 step 6), and the
docker decision was exercised in a real runner: dispatch run 40057381696 printed `channel: dispatch` and
`it will NOT move ...:latest`. NOT yet measured: the prerelease branch itself, which only a real tag push reaches
-- so the first tag IS the confirmation, and it should be cut from `84648b2` or later, because the tag must
contain the classifier script.

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

**MEASURED (2026-10-23)**: `install.ps1` IS executed now, and by two different mechanisms. The
`qualify-windows-amd64` job runs it ON WINDOWS -- step "Qualify install.ps1 ON WINDOWS (running exe,
separators, registry, cmd.exe)", which is the four behaviours no other runner can reach -- and the
`qualify-linux-amd64` job runs it under `pwsh` against a loopback mirror with the same assertion set
`install.sh` is held to. Both jobs are green in run 39907640873, and the gate has teeth: the mutation run
39908014487 fails it.

**NOT COVERED (each with its reason rather than a to-do)**: an existing SillyTavern install migrated IN
PLACE (the cross-baseline job below updates an older GoTavern release, not a SillyTavern tree), and
replacing a binary under a RUNNING server on Linux. `gotavern migrate` EXISTS
(`cmd/gotavern/main.go:103`, `internal/migrate/migrate_test.go:174-611`); it copies to `--dest`, which is
not an in-place migration.

**COVERED SINCE, and it used to be on that list**: proxy/TLS against the real github.com download path.
`release-install-smoke.yml` (weekly + dispatch) resolves the TAG-addressed release URL over TLS, runs
`install.sh --dir … --version <tag>` against it, requires the checksum parse to succeed, boots the
installed prefix, and requires the tokenizer ROUTES to return real ids -- plus a byte-level assertion that
`releases/latest/download/checksums.txt` never serves a prerelease. Runs 40072321355 and 40072470162
(green, 21-26 s). What it still does not reach: the PUBLISHED WINDOWS installer, which is opened and
content-asserted but never executed, because that job runs on Linux.

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
  (full set on schedule/dispatch and for `tools/lib/**`, `tools/oracle/**`, the generator,
  `upstream/**`, `tests/provider-wire/scenarios/**`). Narrower IS weaker, and the earlier text here
  said the opposite ("the zero-diff check still covers every fixture"): that gate diffs the working
  tree against the commit, so a probe that never ran leaves its fixture byte-identical by
  construction and its movement invisible. A skipped probe is unverified. Do not read a narrowed
  green as covering the oracle; the scheduled or dispatched full sweep is the only one that does.
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

1. **C for OPENROUTER is measured, not pending.** `tests/browser/streaming-openrouter-comparison.json`
   records `compatibleReady: true` and `clientDisconnected: true` on BOTH legs, with a matching non-stream
   control; `tools/verify-browser-comparisons.mjs` reads it. The remaining browser-breadth work is
   per-source depth (for example Mistral's E evidence is in its streaming artifact), not OpenRouter C.

2. **The next source transports.** All 25 implemented chat-completion sources are real; COMETAPI is the
   one pinned source that is not, because pinned throws before sending a request.
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

5. **The Windows-only installer behaviours** -- replacing a RUNNING `gotavern.exe` (the branch Windows
   users actually hit on update), path separators, registry/shortcuts, `cmd.exe` -- are EXECUTED, by the
   `qualify-windows-amd64` job in run 39907640873 (mutation 39908014487 fails it). What that measures is
   `install.ps1` on a clean Windows runner; a host with an antivirus file lock, a non-admin shell or a
   non-NTFS volume is NOT COVERED.

6. **A cross-baseline upgrade** is still unexecuted, and so is a running-server replacement test.
## 7. Working agreements

- Teammates own their lane branch and push it; the Lead merges and pushes main in batches.
- Compute belongs on GitHub Actions. Locally: `gofmt`, `node --check`, probe recording, and nothing Go.
- Never run `tools/build-generated-lib.mjs` locally.
- When a lane cannot be finished, contribute the READ you did (what you verified, what you corrected,
  what is still unread) rather than a stub. Several of the best findings arrived that way.

## 8. The honest remaining gaps (2026-10-23, re-measured on main `2dde1fa`)

Six items, restated from the tree rather than from the previous checkpoint. Each says what is closed, with
the evidence, and what is still open; none is softened into "in progress".

1. **The gemini body layer (makersuite/vertexai) is CLOSED.** `internal/server/chat_completions.go:575-586`
   routes both names to `pinnedGooglePlan` (`internal/server/google_chat.go:123`); the provider-wire fixture
   holds the `makersuite-*` and `vertexai-*` captures with non-empty `provider.requests`, and
   `internal/server/chat_completions_oracle_test.go:142-159` fails when a scenario has no capture. The
   named boundary that remains is VertexAI's service-account FULL mode (JWT + OAuth), which carries the
   pinned `400 {error:true,message}` shape rather than a fabricated credential.
2. **Moonshot wiring is CLOSED.** `internal/server/chat_completions.go:870-879` wires the plan arm,
   `internal/server/moonshot_chat.go:187` implements the status shape, and the `moonshot-*` captures are in
   the same fixture under the same missing-capture test.
3. **Preset-level equivalence is OPEN.** The <!-- BEGIN GENERATED: provider-wire.scenarios -->`187`<!-- END GENERATED: provider-wire.scenarios --> provider-wire scenarios are per-source request transforms;
   the browser drives submit ONE captured configuration (`tests/browser/capture-settings.mjs`). There is no
   complex-preset differential, no observation of world info at depth, author's note or stops through both
   legs, and no token-boundary anchor for the request body that would be compared. `tests/provider-wire/DESIGN.md:14-19`
   states that a provider-wire capture is not preset-level evidence.
4. **Cross-baseline is SPLIT.** GoTavern release-to-release update and rollback IS executed:
   `.github/workflows/release-qualification.yml:383` runs `scripts/qualify-upgrade-rollback.sh` over two
   archives built from two commits (runs 39997932741 and 39998226861, cited in `docs/INSTALLATION.md:469`).
   An existing **SillyTavern** install migrated in place is still OPEN: that job installs an older GoTavern
   archive, and `gotavern migrate` copies to a new `--dest` (`cmd/gotavern/main.go:103`).
5. **The real github.com download path is OPEN.** Every installer run resolves releases from a loopback
   mirror (`GOTAVERN_RELEASES_BASE_URL` pointing at 127.0.0.1; `scripts/qualify-install.sh:275-285`), leaving
   proxy handling, TLS and GitHub's redirect behaviour UNMEASURED. Run 39907640873 proves the installer logic,
   not the path.
6. **Package tags: the tag exists; registry state is unverified here.** `git tag -l 'v*'` returns
   <!-- BEGIN GENERATED: release.versionTags -->`v0.1.0-alpha.1`<!-- END GENERATED: release.versionTags --> at `2dde1fa`, and the release is published (run 40066449948). `:latest` is deliberately
   not moved by a prerelease (`scripts/classify-version-tag.sh`), and this host has no network, so whether the
   registry still carries stale dispatch-only tags cannot be checked offline.
