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

What has landed since the previous checkpoint (latest first; every count below is from the generated
facts or a named fixture):

0. **`v0.1.0-alpha.2` is published** (annotated tag at `d3198b8`, release run `40149842943`, docker
   `40149842928`, qualification `40149842917`, install smoke `40150649597`). Six canonical archives plus
   `checksums.txt`, all six listed in the checksums, `releases/latest` still 404 for a prerelease, and the
   published `gotavern-linux-amd64.tar.gz` downloaded and SHA-256-matched against the published checksums
   (`2b96d087…`). Its `BUILD-INFO.txt` names the release and the pinned baseline. The tree also gained, in
   the pre-release audit: every recorded provider request compared and its COUNT asserted (the
   `azure-openai-status-ok` capture records a models GET and a 95-byte chat POST, and only the first was ever
   compared), a `timeout-minutes` on all ten jobs in the five workflows (the rule in AGENTS.md was not true
   of three of them), one BOM removed, four CP1252-round-tripped comments repaired, and eleven documentation
   claims corrected — see item 7 for the one measured limit that is still open.

1. **Provider-wire breadth is now <!-- BEGIN GENERATED: provider-wire.scenarios -->`219`<!-- END GENERATED: provider-wire.scenarios --> recorded scenarios** (was 205 before the final sweep). The fixture is `tests/oracle/sillytavern-1.19.0-provider-wire.json`; `TestChatCompletionGenerateMatchesProviderWireCapture` replays every scenario input.
2. **The status fall-through is CLOSED.** AI21, VERTEXAI and PERPLEXITY now answer the pinned closing-else `400 {"error":true}` with ZERO outbound, not 501. The six new observations are `status.{ai21,vertexai,perplexity}.{noBranch,reverseProxy}` in `tests/oracle/sillytavern-1.19.0-backends.json`, which moved from 110 to 116 observations. The route is `internal/server/backends_status.go` (the no-arm set and the shared refusal at `:75-84`).
3. **The route-wide request gaps are recorded.** `custom_prompt_post_processing` is observed by `openai-custom-prompt-post-processing`; the OPENAI reasoning-effort/verbosity tables by `openai-reasoning-effort-{fixed,map,outside-table}`; OpenRouter audio embedding by `openrouter-media-audio-embed` and `-passthrough`; OpenRouter reasoning signatures by `openrouter-reasoning-signatures*`. The Go side is `chat_completions.go:176-219` (post-processing) and `:423-534` (tables), plus `openrouter_media.go`.
4. **ZAI has two per-literal seams.** `GOTAVERN_ZAI_CHAT_URL` targets the common literal and `GOTAVERN_ZAI_CODING_CHAT_URL` the coding literal (`internal/server/zai_chat.go:51-90`); `zai-coding-endpoint` records the path split. A single seam had made the two modes byte-identical.
5. **The replay honours a scenario's `backendConfig`.** `internal/server/chat_completions_oracle_test.go:302-303` writes the scenario config before each leg, and `tools/probe-provider-wire.mjs:211` does the same for the pinned leg. Before this, every config-driven scenario replayed on defaults, so the flag-off reasoning-signature case could not pass for the right reason.
6. **Browser evidence is green and computed.** `tools/verify-browser-comparisons.mjs` reports 0 findings across 30 catalogued source artefacts; the generated matrix in `docs/surface-coverage.md` says 14 of 26 sources have E/streaming/cancellation, 11 have no browser drive and 1 is stale (`workers_ai`, not re-recordable today). The pinned-derived and product source lists are 25 and 25 with no mismatch (`docs/generated/coverage-matrix.json`).
7. **The complex-preset differential is MEASURED.** `tests/browser/fixtures/preset-complex-settings.json` and `tests/browser/preset-complex-comparison.json` (run `40096436669`) record `keepContext` 4260 / `dropContext` 4259, `measuredBy: 'pinned-leg'`, 24 vs 26 total messages, 12 vs 11 history turns, `providerRequestEqual: true`, empty `bodyDifferences` on both variants, verdict `match`. The measured contract does NOT assert instruct/context templates (they are set to ChatML, but the capture notes a chat-completion request must be identical with different templates), secondary WI keys, recursion/probability/outlets, or group chats; the token-budget suite's other boundaries remain unmeasured.
8. **Placeholders, Claude cache and Mistral prefix are recorded; multimodal is recorded.** All four empty-message converters (`ai21`, `claude`, `cohere`, `deepseek`) carry `[Start a new chat]`, because pinned merges `default/config.yaml:324` into the runtime config at startup, not the module's `Let's get started.` fallback. Claude's `promptPlaceholder`, `enableSystemPromptCache`, `cachingAtDepth`, `extendedTTL` and Mistral's `enablePrefix` have fixtures (`claude-*`, `mistral-prefix-*`). Makersuite inline image, video-with-mediaResolution and audio-without-it are recorded by `makersuite-inline-{image,video-resolution,audio}`; every payload is a data URL because a remote media URL is silently dropped by the pinned converter.

Earlier in this checkpoint: `v0.1.0-alpha.1` was released (run `40066449948`), the oracle execution core and planner landed, documentation counts moved to generated blocks, and the chat-completion dispatch moved to one registry row per source. The provider-wire fixture is 219 captured scenarios against 219 declared inputs. **Still open:** the preset features named above, the OpenRouter prompt-cache transform and the gemini `/models` cache probe, and cohere's BROWSER leg is catalogued but never recorded (its ten `cohere-*` provider-wire scenarios ARE recorded, with captures, in `tests/oracle/sillytavern-1.19.0-provider-wire.json`; what is missing is `generation-cohere-comparison.json`/`streaming-cohere-comparison.json`, which `tests/browser/sources.mjs` records by setting both `evidence` fields to `null`).


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
  subject changes nothing. Exactly ONE comparison exclusion is recorded: `comparisonExclusions` has the
  single key `data/_webpack/**`, because only pinned Node writes that cache, so the PATH SET legitimately
  differs between subjects. The seeded card is not an exclusion at all -- it is a `normalization` entry
  for `data/<handle>/characters/*.png`, whose reason is that the import route rewrites the stored card
  with a generated `chat` name and an ISO `create_date`: the SIZE is recorded, the BYTES are not, and the
  card content is compared by reading it back through pinned.

## 3. Release path: what is now executed, and what still is not

**CUTTING THE FIRST TAG, and what a prerelease does.** `scripts/classify-version-tag.sh` decides a tag's channel
and both release workflows obey it: only a tag that is exactly `v<major>.<minor>.<patch>` is STABLE; anything else
version-shaped (`-alpha.1`, `-beta.2`, `-rc.1`, `+build`) is a PRERELEASE; a name that is not a version tag is
refused rather than guessed. For `v0.1.0-alpha.1` that means `docker.yml` publishes
`ghcr.io/cocokoishi/gotavern:v0.1.0-alpha.1` and leaves `:latest` untouched, and `release.yml` creates the GitHub
Release with `--prerelease --latest=false`, so `releases/latest/download/...` -- the URL both installers fetch --
is never moved onto an alpha. NO STABLE RELEASE EXISTS YET for it to point at: `docs/generated/facts.json`
(`scm.versionTags`) lists exactly one tag, `v0.1.0-alpha.1`, and that tag classifies as a prerelease, so the claim
this repository can actually make is the negative one -- a prerelease is never served as `latest` -- and that is
the assertion `release-install-smoke.yml` makes on the bytes of `releases/latest/download/checksums.txt`.
The rule is covered by `scripts/test-classify-version-tag.sh` in the `verify` job (commit `84648b2`,
run 40056851570 step 6), and the docker decision was exercised in a real runner: dispatch run 40057381696
printed `channel: dispatch` and `it will NOT move ...:latest`. THE PRERELEASE BRANCH HAS RUN SINCE, which this
paragraph used to deny: the tag
push that published `v0.1.0-alpha.1` (release run 40066449948) is a `v*` tag push, which is what `docker.yml`'s
`tags: ['v*']` trigger matches, so the branch is reached by a real tag and no longer waits for a first tag to
confirm it; that tag was cut at `2dde1fa`, which contains the classifier (`84648b2`). What is STILL UNMEASURED is
the ASSERTION rather than the branch: nothing in `release.yml` or `docker.yml` re-reads `releases/latest` or
`:latest` after publishing, and the only byte-level check of `releases/latest` lives in
`release-install-smoke.yml`, which is `schedule` + `workflow_dispatch` only and is therefore NOT tag-triggered --
its runs 40072321355 and 40072470162 are weekly/dispatch runs, not the release run -- and this host has no network,
so the registry's own `:latest` tag cannot be inspected offline.

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

4. **The named gaps inside the two new sources are CLOSED, except two cache probes.** OpenRouter media
   embedding and reasoning signatures, Claude's cache/`promptPlaceholder` branches, Mistral's
   `mistral.enablePrefix`, and makersuite inline media all have recorded fixtures. OpenRouter's
   config-gated prompt-cache transform and the gemini `isOpenRouterModelCacheable()` `/models` probe
   remain open; the `/models` probe is deliberately deferred because it changes the request COUNT.

5. **The Windows-only installer behaviours** -- replacing a RUNNING `gotavern.exe` (the branch Windows
   users actually hit on update), path separators, registry/shortcuts, `cmd.exe` -- are EXECUTED, by the
   `qualify-windows-amd64` job in run 39907640873 (mutation 39908014487 fails it). What that measures is
   `install.ps1` on a clean Windows runner; a host with an antivirus file lock, a non-admin shell or a
   non-NTFS volume is NOT COVERED.

6. **A cross-baseline upgrade** is still unexecuted, and so is a running-server replacement test.

7. **The tokenizer fixture cannot decide response BYTES, and that is measured, not suspected.** The
   fixture records parsed JSON, and `tests/oracle/sillytavern-1.19.0-tokenizers.json` has **26 of 1022**
   cases whose bodies carry **129 U+FFFD** characters: a byte-level BPE tokenizer answers with chunks that
   are fragments of a multi-byte character, so six of the ten `gpt2/encode#cjk` chunks (`chunks` carries 10
   entries, `count: 10`, ten ids) are replacement characters that decode identically from DIFFERENT bytes.
   `chunks` is compared as text, so those cases
   (gpt2 and the HuggingFace `openai` family, plus three `decode#roundtrip_emoji` cases) pass for the wrong
   reason -- a green that cannot fail, and the class rule 7 names. A second, independent byte difference is
   visible in the same file: **222 of 1022** bodies contain `<` or `>` (special tokens such as `<|endoftext|>`
   inside chunks), which `encoding/json` escapes as `\u003c`/`\u003e` while Express does not, so our bytes
   differ from pinned wherever the parsed values agree. Remedy, one slice: record `bodySha256` of the pinned
   RAW bytes in `tools/probe-tokenizers.mjs::request`, assert it in the Go replay (the character-write
   fixture already gates its PNG body that way, via `ResponseSHA256`), and stop HTML-escaping in the
   tokenizer serialization. Until that lands, the tokenizer rows are `partial` on this specific ground and
   must not be read as byte parity.
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
3. **Preset-level equivalence is MEASURED for one complex scenario.** The
   <!-- BEGIN GENERATED: provider-wire.scenarios -->`219`<!-- END GENERATED: provider-wire.scenarios -->
   provider-wire scenarios are per-source request transforms and are NOT preset-level evidence
   (`tests/provider-wire/DESIGN.md:14-19`). The separate complex-preset differential is
   `tests/browser/preset-complex-comparison.json` with settings
   `tests/browser/fixtures/preset-complex-settings.json`: at the pinned-measured boundary
   (`keepContext` 4260 / `dropContext` 4259) both legs produced byte-identical provider requests
   (`providerRequestEqual: true`, empty `bodyDifferences`, verdict `match`), with 24 vs 26 total
   messages and 12 vs 11 history turns. Still OPEN: instruct/context templates, secondary WI keys,
   recursion/probability/outlets, group chats, and token-budget boundaries other than 4260/4259.
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
   <!-- BEGIN GENERATED: release.versionTags -->`v0.1.0-alpha.1`, `v0.1.0-alpha.2`<!-- END GENERATED: release.versionTags --> at `2dde1fa`, and the release is published (run 40066449948). `:latest` is deliberately
   not moved by a prerelease (`scripts/classify-version-tag.sh`), and this host has no network, so whether the
   registry still carries stale dispatch-only tags cannot be checked offline.
