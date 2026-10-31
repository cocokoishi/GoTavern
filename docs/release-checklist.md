# Alpha.9 release checklist (machine-checkable)

Scope: GoTavern `v0.1.0-alpha.9`, the first **stable-channel** release (the tag keeps its historical alpha
spelling; the channel is decided by `scripts/classify-version-tag.sh`). Pinned compatibility target:
SillyTavern `1.19.0`, commit `06bde939fb1e9c4c8d8641d810f0a916b5bce127`.

This checklist is the audit trail for the Alpha.9 tag. **Every item names the command, workflow job or script
that proves it and the artefact field that must carry the evidence.** An item whose only proof would be a
self-attestation is marked `MISSING` with what would have to be built; nothing here invents a gate that does
not exist. Two items can only be satisfied after publication or by a human decision, and they say so
explicitly instead of being smoothed over.

Evidence carriers used below:

- **run** - a GitHub Actions run: `<workflow name> <run id> (<conclusion>), head <sha>`, always with the workflow
  name (a bare run id is not evidence; two workflows can share a second).
- **matrix row** - `docs/compatibility-matrix.json`'s `rows[].evidence.ci`, rendered into
  `docs/compatibility-matrix.md`.
- **scorecard Q** - `docs/goal-scorecard.md`, one `Q<n>` row with its `status` and cited run.
- **release note** - `docs/release-notes-v0.1.0-alpha.9.md` (draft body for the GitHub Release; every
  `UPPER-CASE` placeholder is a value that must be measured on the candidate run).
- **release record** - the published GitHub Release body and `docs/releases/<tag>.md`.
- **HANDOFF** - `HANDOFF.md`'s current checkpoint section.

The frozen candidate is called **CANDIDATE_SHA** below. Every run citation must name CANDIDATE_SHA; a run on an
earlier commit is not evidence for the release.

## A. Freeze the candidate

| # | item | status | exact gate | evidence field |
| --- | --- | --- | --- | --- |
| 1 | The candidate is a durable, clean commit on `main` | GATE (command) | `git rev-parse HEAD` recorded as CANDIDATE_SHA; `git status --porcelain` empty; `git log origin/main..HEAD` empty (an unpushed commit is not durable and CI has never seen it) | release note `candidate sha`; HANDOFF |
| 2 | The tag is cut on CANDIDATE_SHA, not on a later tree | GATE (command) | after tagging: `git rev-parse v0.1.0-alpha.9^{commit}` equals CANDIDATE_SHA; `git merge-base --is-ancestor CANDIDATE_SHA v0.1.0-alpha.9` | release note; release record |
| 3 | The tree is at the pinned compatibility baseline | GATE (workflow step) | `ci.yml#verify` step "Verify compatibility documents cite committed oracle fixtures" (`node tools/verify-oracle-citations.mjs`) and the baseline check inside `tools/compat-matrix/check.mjs` (`upstream/SILLYTAVERN_COMMIT` = matrix baseline) | matrix `baseline`; ci run |
| 3a | **The pinned oracle is fetched by `.github/actions/checkout-pinned`, which asserts the pin before any recording** | GATE (landed `7fbd7bf`; present at main) | The action (`.github/actions/checkout-pinned/action.yml`) (a) refuses a caller pin that disagrees with `upstream/SILLYTAVERN_COMMIT`, (b) fetches `refs/heads/release`, and (c) asserts `git rev-parse HEAD` == the pin before any recording. It is used by `ci.yml` (oracle), `browser-differential.yml`, `whole-session.yml`, `worldinfo-slots.yml` and `smoke-metrics.yml`. **A run that fails inside checkout is a HARNESS failure: it is not product evidence, it must never be recorded as a red product gate, and it leaves every oracle/browser-backed row with NO fresh evidence until the job is re-run.** | run log (the action's pin-refusal and SHA-assertion lines); `upstream/SILLYTAVERN_COMMIT`; matrix `baseline` |
| 4 | Generated document facts are current | GATE (workflow steps) | `ci.yml#verify`: `node tools/generate-doc-facts.mjs --check`, `node tools/generate-coverage-matrix.mjs --check`, `node tools/verify-oracle-citations.mjs`, `node tools/verify-browser-comparisons.mjs` (latter in `ci.yml#browser-evidence`), `bash scripts/check-commit-identity.sh` | run; matrix `derived`; `docs/generated/facts.json` |
| 5 | The compatibility matrix cannot claim what the tree does not show | GATE (workflow step) | `ci.yml#verify` step "Verify the compatibility matrix cannot claim what this tree does not show": `node tools/compat-matrix/check.mjs` (citations resolve, PASS has no gap, derived counts match a recount, Markdown equals generator output) | matrix `derived`; run |

## B. Correctness evidence at CANDIDATE_SHA

Every job in this section runs against the pinned oracle through `.github/actions/checkout-pinned` (item 3a).
The action refuses a caller pin that disagrees with `upstream/SILLYTAVERN_COMMIT`, so a hand-transcribed pin
fails at the pin instead of quietly recording against a different baseline. A checkout failure is a harness
failure, not a red product gate, and the affected row has no fresh evidence until the job is re-run
successfully.

| # | item | status | exact gate | evidence field |
| --- | --- | --- | --- | --- |
| 6 | `GoTavern CI` green, INCLUDING the full oracle | GATE (must be dispatched; a push run is narrowed) | `.github/workflows/ci.yml` jobs `oracle`, `verify`, `race`, `browser-evidence` on CANDIDATE_SHA. The `oracle` job is NARROWED on a push by the `changes` planner; the full sweep is the nightly schedule or `workflow_dispatch` with an empty `probes` input. Cite the full one | matrix rows citing `ci.yml#oracle`; release note `CANDIDATE-RUN: GoTavern CI`; HANDOFF |
| 7 | Go suite, vet, build, gofmt (the `verify` job) | GATE (workflow job) | `ci.yml#verify` runs `go test ./...`, `go vet`, `go build`, `gofmt -l`, `gotavern assets verify`, the oracle-execution-core node tests, the classifier table, and six cross-compiles (the cross-compiles are BUILD evidence only, item 19) | run; release note `CANDIDATE-RUN: GoTavern CI, verify job` |
| 8 | Race detector | GATE (workflow job) | `ci.yml#race` on CANDIDATE_SHA (bounded package subset: handler, outbound transport, retry helper, egress guard; `-race` cannot run on the Windows development host) | run; release note |
| 9 | Full browser differential, all surfaces | GATE (must be `mode: all`) | `.github/workflows/browser-differential.yml` job `differential` at CANDIDATE_SHA with workflow input `mode: all` (a push run narrows itself to assets/helper; the nightly schedule is the full sweep). Steps "Record/Compare the generation legs", "Compare the streaming framing legs", "Compare the Q20 legs", "Judge the Q20 regenerate legs", "Judge the Q20 continue legs", "Judge the hand-back" | matrix rows citing `browser-differential.yml#differential`; release note `CANDIDATE-RUN: Browser differential`; scorecard Q20/Q21 |
| 10 | Q20: reload / swipe / regenerate / continue preserve equality | GATE (steps in item 9) | steps "Record the Q20 legs (save -> reload -> swipe, on both subjects)", "Compare the Q20 legs", "Record/Compare/Judge the Q20 regenerate legs", "Record/Compare/Judge the Q20 continue legs", "Prove the Q20 continue comparator has teeth" | `docs/goal-scorecard.md` Q20 must cite the CANDIDATE_SHA run id, not 40977195387 |
| 11 | Q21: a tree written by GoTavern is handed back to pinned Node and keeps running (both directions) | GATE (steps in item 9) | steps "Hand GoTavern's own tree back to pinned Node (Q21)", "Judge the hand-back", "Prove the pinned card write path can emit the Q21 fixture (no browser)"; the judge must print `hand-back verdict: match` with every row count non-zero | `docs/goal-scorecard.md` Q21 cites the CANDIDATE_SHA run id |
| 12 | Streaming SSE framing, incremental render and cancellation | GATE (item 9 + transport tests) | browser step "Record the streaming framing legs (relayed control and mid-stream cut, both subjects)" + "Compare the streaming framing legs"; committed `tests/browser/streaming-*-comparison.json`; `ci.yml#verify` runs `TestProductionTransportPreservesProviderFrameOrder`, `TestProductionTransportDeliversACancelledStreamAsAnOrderedPrefix`, `TestProductionTransportTreatsAGracefulTLSShutdownMidStreamAsTruncation` | matrix row `streaming-and-cancel` (PASS); release note `CANDIDATE-RUN: Browser differential` |
| 13 | **The whole-session differential is GREEN** (the only matrix FAIL) | GATE, CURRENTLY RED | `.github/workflows/whole-session.yml` job `whole-session` dispatched at the EXACT CANDIDATE_SHA; it boots both subjects over one stock tree each with one browser lineage, then a restarted process, and the comparator must report every guard green (`completion-1-equal` and `completion-2-equal` are the two that failed in run 41015209900) | matrix row `whole-session-e2e`: status PASS, its `evidence.ci` citing the fresh run id; release note `CANDIDATE-RUN: GoTavern whole-session differential`; `docs/goal-scorecard.md` Q1/Q20/Q21 where relevant |
| 14 | Drop-in qualification: a packaged archive boots a stock SillyTavern tree | GATE | `dropin-qualification.yml#dropin-current-head` (Linux, both layouts and config modes) and `#windows-inputs` + `#dropin-windows` (Windows archive executed on windows-latest: `Start.cmd`, pristine-config, trimmed-config, exe-direct) at CANDIDATE_SHA; also `release-qualification.yml#qualify-dropin-linux` | matrix row `packaging-release`; release note `CANDIDATE-RUN: GoTavern drop-in qualification`; `docs/dropin-qualification.md` |
| 15 | Release qualification: archive contents, fresh boot, idempotence, update, rollback, installers, cross-baseline | GATE (tag/dispatch-only, so COLD) | `release-qualification.yml` jobs `qualify-linux-amd64` (steps "Assert the archive contents and modes", "assets verify from the EXTRACTED archive", "Fresh boot, idempotence, update and rollback over the same data root", "Qualify the INSTALLER against the archives this run just built", "Qualify install.ps1 against the same archives, under pwsh"), `qualify-windows-amd64`, `qualify-upgrade-rollback`, `qualify-dropin-linux` at CANDIDATE_SHA | matrix rows `packaging-release`, `tokenization`, `startup`; release note; `docs/INSTALLATION.md` §11 |

## C. Artefacts, channel and publication

| # | item | status | exact gate | evidence field |
| --- | --- | --- | --- | --- |
| 16 | Docker image builds, verifies and smokes at CANDIDATE_SHA | GATE | `.github/workflows/docker.yml` job `docker` at CANDIDATE_SHA (`workflow_dispatch` with `push_image: false` for the pre-tag run): steps "Build the release image", "Verify embedded assets and the installed tokenizers tree", "Start the container and assert it serves a pinned route" | matrix row `packaging-release` (`docker.yml#docker`); release note |
| 17 | Six canonical archives are built with the canonical names | GATE (`release.yml#build`) | `release.yml#build` matrix builds `gotavern-linux-amd64.tar.gz`, `gotavern-linux-arm64.tar.gz`, `gotavern-darwin-amd64.tar.gz`, `gotavern-darwin-arm64.tar.gz`, `gotavern-windows-amd64.zip`, `gotavern-windows-arm64.zip`; `release.yml#publish` step "Fail if a canonical asset name is missing" re-asserts the set | release run; release note `assets` |
| 18 | `checksums.txt` is complete and in the installer's exact format | GATE (`release.yml#publish`) | step "Generate checksums.txt in sha256sum format" (`sha256sum *.tar.gz *.zip`, bare names, no `./` prefix) + "Fail if a canonical asset name is missing" (every asset has an entry); `release-install-smoke.yml` step "Download the published assets and verify every digest" | release run; release record; release note |
| 19 | Platform coverage is stated, not implied: **runtime-qualified vs BUILD-ONLY** | PARTIAL, and MUST be stated in the release notes | Runtime execution exists only for **linux/amd64** (release qualification + drop-in jobs) and **windows/amd64** (dropin-windows + qualify-windows-amd64). **linux/arm64, darwin/amd64, darwin/arm64 and windows/arm64 are BUILD-ONLY**: `release.yml#build` compiles and packs them, `ci.yml#verify` cross-compiles them, and no job executes them. There is no runner of those architectures in this repository; adding one is the only thing that would change this | release note "Supported platforms" section; `docs/compatibility-matrix.md` `packaging-release`; `docs/INSTALLATION.md` |
| 20 | The channel classifier says `v0.1.0-alpha.9` is `stable` | GATE (workflow step + command) | `ci.yml#verify` step "Verify the release channel classifier decides tags correctly" (`bash scripts/test-classify-version-tag.sh`, which asserts the historical-graduation case from both sides); the one-word contract: `bash scripts/classify-version-tag.sh v0.1.0-alpha.9` prints exactly `stable` | release note; run; release record |
| 21 | GitHub and Docker agree about the channel (one rule, two consumers) | GATE (shared script) and POST-PUBLISH observation | `release.yml#publish` and `docker.yml`'s "Decide what may be published" both call `scripts/classify-version-tag.sh`; the tag-time docker run must print `channel=stable` and move `:latest`, and the publish step must take the non-prerelease branch. Post-publish, `gh release view v0.1.0-alpha.9 --json isPrerelease` must be `false` and `docker pull ghcr.io/cocokoishi/gotavern:latest` must resolve the tagged image (the docker job pulls the pushed reference back after removing the local image) | docker run log; release run log; release record |
| 22 | The release is published as a STABLE release (`prerelease=false`) and `releases/latest` is correct | GATE at tag time + POST-PUBLISH assert | `release.yml#publish` step "Publish the release" takes the `stable` branch (no `--prerelease`); after publication `release-install-smoke.yml#smoke-published-linux-amd64` step "Assert the release that releases/latest serves, in the direction the channel requires" requires `releases/latest`'s `tag_name` to be this tag, its `prerelease` false, and `latest/download/checksums.txt` to be this release's own bytes; step "Resolve the release tag and refuse one that is not a version tag" cross-checks the classifier against GitHub's recorded channel | release record; smoke run |
| 23 | The PUBLISHED release installs over the real network, and the bare (no-version) installer resolves it | POST-PUBLISH GATE; pre-tag only mirror-limited | `release-install-smoke.yml#smoke-published-linux-amd64`: step "Install the published release with install.sh over TLS", "Boot the installed binary and require /version", "Require the tokenizer routes to load a REAL model, not the guesstimate fallback", and the `releases/latest` assertion. Pre-tag, `release-qualification.yml#qualify-linux-amd64` step "Qualify the INSTALLER against the archives this run just built" proves both installers against a loopback mirror only. **This item cannot be green before publication; if it fails after publication the release is not installable by a stranger and must be withdrawn, not footnoted** | smoke run; release record; release note |
| 24 | Resource benchmark recorded at CANDIDATE_SHA | GATE, but COLD (weekly/dispatch, never push) | `.github/workflows/smoke-metrics.yml` job `measure-linux-amd64` (and `paired-linux-amd64` for the Node comparison) dispatched at CANDIDATE_SHA; artefact `smoke-metrics` carries the runner image identity; only the 60 s cold-start ceiling is asserted, every other number is reported | release note performance block; `README.md` § Performance (run id); scorecard Q22 |

## D. Documents and notes

| # | item | status | exact gate | evidence field |
| --- | --- | --- | --- | --- |
| 25 | The compatibility matrix states `FAIL = 0` at CANDIDATE_SHA | GATE (`ci.yml#verify`) + the whole-session run | `node tools/compat-matrix/check.mjs` green AND `whole-session-e2e` PASS with a fresh CANDIDATE_SHA run id in `evidence.ci`; regenerated with `node tools/compat-matrix/render.mjs --emit` (never hand-edited) | matrix `derived.rows`; `docs/compatibility-matrix.md`; run |
| 26 | The release notes contain no unmeasured placeholder | **MISSING as a wired gate**; the command is machine-checkable | `grep -nE '<[A-Z][A-Z0-9_-]+:' docs/release-notes-v0.1.0-alpha.9.md` must print nothing, and every `run <id>` in the notes must name CANDIDATE_SHA. Wiring it into `ci.yml#verify` is the missing step; until then it is a review checklist item | release note |
| 27 | `README.md` is updated LAST, and every number in it is derived or cites a run | PARTIAL: the derived numbers have a gate, the ordering is a process rule | `ci.yml#verify` `node tools/generate-doc-facts.mjs --check` proves the generated blocks are current; the ordering is checked with `git log -1 --format=%H -- README.md` (must not be older than the last evidence edit) and by reading every run id in README §Performance / §Verified questions - they must be CANDIDATE_SHA runs, not 40898332226/40977195387 | run; README; release note |
| 28 | Private offline qualification PASS (the maintainer's own long-lived tree, run offline) | **HUMAN-ONLY, by design** | No repository gate can exist: the input is the maintainer's real SillyTavern directory, which AGENTS.md 51/56 forbids committing, uploading or printing. The decision is recorded by the **release owner (Lead) in the release record and HANDOFF**, with: date, operator, the private input's `sha256` (hash only, never content), the candidate SHA, and the verdict. A CI job may never be cited for it, and a green CI run may not be substituted for it. This is the one item that remains a human decision after every machine gate above is green | release record; HANDOFF |

## E. What is MISSING and what it would need

These are the gaps in the release process itself, found while writing this checklist. They are listed so the
Lead can accept them knowingly rather than discover them after the tag.

| gap | consequence | what would close it |
| --- | --- | --- |
| `release.yml` publishes on a tag push without checking that CI / whole-session / browser-differential / drop-in runs at that commit are green | a tag can be published while a required gate is red or never ran; the only guard is the operator remembering | a `publish` precondition step with this exact query, refusing unless every required workflow has a `success` for CANDIDATE_SHA: `gh api "repos/cocokoishi/GoTavern/actions/runs?head_sha=${CANDIDATE_SHA}&per_page=100" --jq '.workflow_runs[] \| select(.name=="GoTavern CI" or .name=="GoTavern whole-session differential" or .name=="GoTavern browser differential" or .name=="GoTavern drop-in qualification" or .name=="GoTavern release qualification") \| [.name,.event,.conclusion,.id] \| @tsv'`; the decision rule must also require the FULL-sweep event for the narrowed workflows (`event` in `schedule`/`workflow_dispatch`, not `push`) where the row's evidence is the full oracle or `mode: all` browser run. **Not implemented in this lane** (workflows are release-channel's scope); the query is stated so the Lead can decide to wire it |
| No wired gate for release-note placeholders | an unmeasured value can reach the GitHub Release | add the `grep -nE '<[A-Z][A-Z0-9_-]+:'` check to `ci.yml#verify` |
| No wired gate that README / HANDOFF run citations are at CANDIDATE_SHA | a stale run id (e.g. 40898332226, 40977195387) reads as a current measurement | a small script over the documents' run-id fields, or fold the check into `generate-doc-facts.mjs` |
| `smoke-metrics` is weekly/dispatch and no release step requires it | item 24 can be skipped silently | make the publish precondition require a smoke-metrics run at CANDIDATE_SHA, or record its absence explicitly in the release notes |
| No runtime execution of linux/arm64, darwin/amd64, darwin/arm64, windows/arm64 | four of six archives are build-only (item 19) | a runner of each architecture, or an explicit "build-only" statement in the release notes - the latter is the Alpha.9 decision |
| Private offline qualification has no machine carrier | item 28 is a human decision | nothing can replace it; only the recorded owner + hash + verdict makes it auditable |

## F. Freeze rule

Freeze CANDIDATE_SHA only after items 1-28 are either green on CANDIDATE_SHA or explicitly accepted in the
release record. After the freeze, the only permitted changes are the release-notes measurement paste (item 26)
and the README update (item 27); both must leave the tree byte-identical to the tagged CANDIDATE_SHA except for
documentation, and the final commit must be pushed before the tag is cut (item 1: an unpushed commit is not
durable and CI has never seen it).
