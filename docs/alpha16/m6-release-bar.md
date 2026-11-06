# M6 release bar - the 13 same-SHA gates, the fail-closed verifier, and what is (not) proven at this tree

**Status: M6 PREPARATION, documentation only. No workflow was dispatched, no product file changed, no git
operation was run.** Read at `0b577de` (2026-11-06, clean tree).

This document answers four questions for the alpha.16 release bar:

1. what alpha.15's thirteen same-SHA gates actually are (reconstructed from the repository's own records),
   and which of them are green at *this* program's tree;
2. what the `GoTavern release qualification` gate checks, what the fail-closed verifier refuses, and the
   exact rehearsal commands and run-id evidence a release rehearsal must produce;
3. where the combination-journey interacting scenario stands (tier wiring, independent proofs, run states)
   and the precise conditions before it can carry a release claim;
4. a fail-closed checklist over plan section 8 and the release bar, with PROVEN / UNPROVEN / BLOCKED and run ids,
   including the `GOAL.md` section 14 statement that synthetic qualification does not satisfy the real-private-tree
   claim.

## 0. Method, sources, and the run-id integrity rule

### 0.1 Sources (all read at `0b577de`)

| source | what it supplies |
|---|---|
| `docs/release-manifest.json:1-89` | the release policy: 13 required workflows, `sameShaRequired`, the event/jobs/artifact/evidence rails |
| `HANDOFF.md:45-66` | alpha.15's own same-SHA table: 13 gate run ids at tag target `95638da` + the verifier's `PASS 13/13` |
| `HANDOFF.md:93-101` | alpha.15 release identity, tag object, assets, container digest, post-publication verification, and the publish-path exception |
| `docs/release-governance.md:1-151` | the mechanism, the four rails, the teeth, the "no override flag" rule |
| `scripts/verify-release-gates.mjs:1-144`, `scripts/release-governance/gates.mjs:1-496`, `scripts/release-governance/artifact-evidence.mjs:1-154` | the fail-closed verifier and the embedded-evidence contract |
| `.github/workflows/release.yml:537-734` | the publish path, the gate call, the tag-only publish gate, the generated-facts job |
| `.github/workflows/release-qualification.yml:1-766` | the five qualification jobs |
| `.github/workflows/combination-journey.yml:1-359` + `tests/browser/compare-combination-journey.mjs`, `tests/browser/combination-journey-gate-selftest.mjs`, `tests/browser/extensions/e03e04-profile-kit.mjs`, `tests/browser/extensions/extension-install-batch.mjs` | the interacting-scenario gate, its tiers, its evidence schema, its teeth |
| `docs/alpha16/first-scenario-design.md:1-141` | the E03+E04 design, tiers, negative controls |
| `docs/alpha16/source-audit.md:146-172` | this program's recorded CI evidence and the gate findings inherited from M0 |
| `docs/alpha16/baseline/README.md:21-197` | this program's two dispatched records (bench profiles, smoke metrics) and L-H1 |
| `docs/release-notes-v0.1.0-alpha.15.md:1-172` | alpha.15's curated claim document and its named boundaries |
| `GOAL.md:417-472` (section 14), `:534-573` (section 16) | the drop-in bar and the release bar |
| `docs/alpha16-agent-execution-plan.md:125-131` (section 8) | the M6 requirements |
| git history `c256f21..0b577de` (27 commits) | program-tree run ids and their states, quoted from commit messages by hash |

### 0.2 Run-id integrity

Every run id in this document was found in the tree or in the git history at `0b577de`; none is invented.
The one exception is stated rather than fabricated:

- **`42198916430`** was verified by the Lead after this document was written: workflow `Combination journey differential`, event `workflow_dispatch`, headSha `0b577de`, conclusion **failure**. It failed at `Consume the leg-failure counter` (counter = 1); both drive legs recorded 85 steps and failed `send-blocking-overlay-handled` because a SECOND extension overlay (`div#rpg-deprecation-modal`, class `rpg-settings-popup is-open`, from rpg-companion-sillytavern) covered `#send_but` after the first one (ST-Copilot `scp-changelog-modal`) had been dismissed correctly through `scp-changelog-close`. That is a harness defect (fixed in M2g), not a product finding, but the run is NOT a full-tier green, so gate #10 stays UNPROVEN for the interacting scenario.
- All other run ids are cited as *workflow name + run id + conclusion together* (`AGENTS.md` rule 55),
  because one commit produces several workflows and a bare id is ambiguous.

### 0.3 Two different questions, kept apart

- **alpha.15 gate evidence** asks: did the 13 gates run, green, at the alpha.15 tag target commit? Answer:
  yes, all 13, at `95638da` (`HANDOFF.md:45-63`), verifier `PASS 13/13` (`HANDOFF.md:47`).
- **Current state at this program's tree** asks: has each gate been run - and recorded - at/after the
  program base `c256f21`, at an explicit candidate SHA with the full selection? Almost none has. The
  program is an in-flight lane with a deliberately read-only M0 and pre-merge M1-M5 work; the absence of
  same-SHA gate runs is expected, and correctly recorded as UNPROVEN rather than inherited from alpha.15.

---

## 1. alpha.15's 13 same-SHA gates - reconstruction

### 1.1 How the list is reconstructed

`docs/release-manifest.json` is the release policy (`release-manifest.json:4`: hand-maintained on purpose,
machine-enforced). It names **13** workflows (`requiredGates`, lines 5-88), each with
`requiredEvent: workflow_dispatch` and `sameShaRequired: true` (line 3). `HANDOFF.md:47-63` records the run
ids alpha.15 used to satisfy it, and `HANDOFF.md:47` records the verifier's own printed result. The two
lists agree exactly (13 rows).

The 13 are: GoTavern CI; GoTavern whole-session differential; GoTavern world-info slot ordering; GoTavern
drop-in qualification; Browser differential; GoTavern release qualification; GoTavern smoke metrics;
GoTavern Docker image; Helper state differential; Combination journey differential; Third-party extension
compatibility; GoTavern long-lived corpus qualification; GoTavern Node stock tree round trip.
`GoTavern Release` is deliberately **not** listed - a workflow cannot be its own precondition
(`release-manifest.json:4`).

### 1.2 The gate table

Legend: **Cand. SHA** = is the gate wired to run at an explicit candidate SHA? (all 13 are
`workflow_dispatch`-only for release evidence, and the verifier requires `head_sha == tag target`,
`gates.mjs:256-267`). **alpha.15** = the run recorded in `HANDOFF.md` (all success). **Program tree** =
state at `0b577de` from runs recorded in the tree/history, or UNPROVEN.

| # | gate (manifest) | job(s) (file:line) | what it proves (manifest `why`) | Cand. SHA | alpha.15 run + conclusion | Program-tree state |
|---|---|---|---|---|---|---|
| 1 | GoTavern CI | `changes:59`, `oracle:140`, `browser-evidence:350`, `verify:442`, `crash-gate:639`, `race:656` (`.github/workflows/ci.yml`) | verify (gofmt, generated facts, compat matrix, classifier, Go suite, vet, build, assets), race, browser evidence AND the oracle re-record (`release-manifest.json:7-10`) | yes - dispatch, and the dispatch carries the probe selection (`ci.yml:20-29`, `:124`) | `42085016500` success (all six jobs; oracle full re-record + zero-diff, 173 min) `HANDOFF.md:51` | **UNPROVEN at HEAD.** Recorded program-tree runs: `42159888005` success at `26aaa33` (`source-audit.md:169`), `42170544949` failure at `86df528` (commit `74dee31`), `42187779109` failure-at-the-intended-step as a narrowed one-probe oracle dispatch at `dbd32aa` (commit `fa5385f`). No recorded run is a dispatch at HEAD |
| 2 | GoTavern whole-session differential | `whole-session:64` (`.github/workflows/whole-session.yml`) | one stock tree per subject, one browser lineage, restart on the same tree, the guard judgement (`release-manifest.json:12-15`) | yes - dispatch, no inputs | `42085027879` success `HANDOFF.md:52` | **UNPROVEN** - no program-tree run recorded |
| 3 | GoTavern world-info slot ordering | `worldinfo-slots:50` (`.github/workflows/worldinfo-slots.yml`) | before/after/atDepth slots reach the provider request in pinned order (`release-manifest.json:17-20`) | yes - dispatch, no inputs | `42085039394` success `HANDOFF.md:53` | **UNPROVEN** - no program-tree run recorded |
| 4 | GoTavern drop-in qualification | `dropin-current-head:114`, `windows-inputs:606`, `dropin-windows:774` (`.github/workflows/dropin-qualification.yml`) | the packaged archive boots against a stock tree on Linux and Windows (`release-manifest.json:22-25`) | yes - dispatch | `42085050679` success `HANDOFF.md:54` | **UNPROVEN as release evidence.** `42160006870` success at a docs-only program tree (`source-audit.md:171-172`); the recorded event is not a release dispatch, so it cannot be cited as same-SHA dispatch evidence |
| 5 | Browser differential | `differential:246` (+ `handback-stability:2314` only in stability mode, `publish-preset:2537`) (`.github/workflows/browser-differential.yml`) | the pinned frontend's real journeys incl. the Q21 hand-back judge (`release-manifest.json:27-30`) | yes - dispatch with `mode` input (`browser-differential.yml:190-197`) | `42085061246` success, mode=all `HANDOFF.md:55` | **UNPROVEN** - no program-tree run recorded (program work was on the combination harness) |
| 6 | GoTavern release qualification | `qualify-linux-amd64:57`, `qualify-windows-amd64:316`, `qualify-upgrade-rollback:397`, `qualify-published-alpha9-upgrade:520`, `qualify-dropin-linux:638` (`.github/workflows/release-qualification.yml`) | fresh install, idempotence, update/rollback and cross-baseline survival from the extracted archive (`release-manifest.json:32-35`) | yes - dispatch (or a tag push) | `42085071573` success `HANDOFF.md:56` | **UNPROVEN** - no program-tree run recorded; section 2 gives its rails and rehearsal |
| 7 | GoTavern smoke metrics | `measure-linux-amd64:63`, `paired-linux-amd64:137` (`.github/workflows/smoke-metrics.yml`) | the paired performance record and the soak (`release-manifest.json:37-40`) | yes - dispatch (`requests` input) | `42085081862` success `HANDOFF.md:57` | **UNPROVEN at HEAD.** `42160114658` success at `c8472c1`: both jobs succeeded and the artifact verdict passed (`docs/alpha16/baseline/README.md:23-28`, `:100`; commit `44658a9`). Not at HEAD and no same-SHA dispatch at HEAD |
| 8 | GoTavern Docker image | `docker:76` (`.github/workflows/docker.yml`) | the image builds, verifies tokenizer assets and smokes a pinned route (`release-manifest.json:42-45`) | yes - dispatch; a dispatch with default `push_image=false` publishes nothing (`docker.yml:54-62`, `:168-217`) | `42085092398` success `HANDOFF.md:58` | **UNPROVEN** - no program-tree run recorded |
| 9 | Helper state differential | `helper-state:43` (`.github/workflows/helper-state.yml`) | ?...'????????? second-order state with a 30-guard judge and teeth (`release-manifest.json:47-50`) | yes - dispatch, no inputs | `42085102968` success `HANDOFF.md:59` | **UNPROVEN** - no program-tree run recorded |
| 10 | Combination journey differential | `combination-journey:85` (`.github/workflows/combination-journey.yml`) | one composed session (card ?- preset ?- helper ?- world info ?- variables ?- regex ?- QR ?- streaming ?- verbs ?- reload ?- restart ?- group ?- hand-back), byte-equal per capture (`release-manifest.json:52-55`) | yes - dispatch; **but the deposit is narrowed by the `profile` input, whose default is `none`** (`combination-journey.yml:35-44`, `:168-180`) | `42085115161` success `HANDOFF.md:60` | **UNPROVEN for the interacting scenario** - fast tier `42184268652` `match` at lane `f22cd1b`, but full tier `42186322374` failed, second full tier `42193009501` failed, and `42198916430` failed at the send-blocking-overlay guard (a second overlay, rpg-deprecation-modal, was not dismissed; M2g) |
| 11 | Third-party extension compatibility | `selftest:83`, `shard:205`, `aggregate:295`, `cross-platform:344`, `corpus:454`, `soak:545`, `overhead:630` (`.github/workflows/third-party-extension-compat.yml`) | exactly 20 pinned extensions, each installed/activated/persisted across restart/disabled/re-enabled/uninstalled, aggregator requires the observed set = lock (`release-manifest.json:57-61`) | yes - dispatch `mode=full`; `mode=sentinel` does not upload the fixed artifact, so the artifact rail refuses it | `42085125376` success, mode=full `HANDOFF.md:61` | **UNPROVEN** - no program-tree run recorded |
| 12 | GoTavern long-lived corpus qualification | `small-corpus:92`, `medium-corpus:285`, `large-corpus:486` (`.github/workflows/longlived.yml`) | medium-tier long-lived corpus resume??'send??'swipe??'switch??'reload??'restart??'continue + comparator teeth + 20-extension digest (`release-manifest.json:63-76`) | yes - dispatch `size=medium`; the fixed artifact carries the tier and head SHA | `42085136899` success, `medium-corpus` job + evidence artifact verified `HANDOFF.md:62` | **UNPROVEN** - no program-tree run recorded |
| 13 | GoTavern Node stock tree round trip | `node-stock-tree:59` (`.github/workflows/node-stock-tree.yml`) | a tree recorded by pinned Node is read/mutated/restarted/handed back to pinned Node and re-read (`release-manifest.json:77-87`) | yes - dispatch; the artifact name is also uploaded on push runs, which is why the event rail is load-bearing (`release-manifest.json:78`) | `42085148642` success, job + evidence artifact verified `HANDOFF.md:63` | **UNPROVEN as release evidence.** `42160006691` success at a docs-only program tree (`source-audit.md:171-172`); rails not verified by that run |

`HANDOFF.md:64` also lists the `GoTavern Release` dry run `42085159949` success (publish skipped: a dispatch
never publishes). It is **not** a gate.

### 1.3 What "explicit candidate SHA" means in the verifier

The verifier (`scripts/verify-release-gates.mjs:99` ??' `gates.mjs`) selects, per manifest entry, runs whose
`head_sha` equals the tag target (`gates.mjs:263-267`), then applies up to three rails per candidate run:

- **jobs** - every `requiredJobs` entry must be `completed`/`success` *in that run* (`gates.mjs:162-189`);
- **artifact** - the fixed-name artifact must be attached and not expired (`gates.mjs:191-207`);
- **evidence** - `release-evidence.json` inside the artifact ZIP must carry the contract `kind`, the
  embedded `headSha == candidate`, the required tier marker, `requireTruthy` fields exactly `true`, and
  `requireSha256` fields as lowercase 64-hex (`artifact-evidence.mjs:21`, `:62-101`, `:115-153`).

A run whose `event` is not the manifest's `requiredEvent` is refused by name as a narrowed-run refusal
(`gates.mjs:302-316`). The whole gate fails closed: any non-success row exits non-zero and publication does
not happen (`verify-release-gates.mjs:140-143`). There is no override flag (`release-governance.md:146-147`).

**Current rail coverage (the M0 finding, re-verified at this tree):** of the 13 entries, only 3 name an
artifact (`third-party:60`, `longlived:67`, `node-stock-tree:81`) and only 2 name `requiredEvidence`
(`longlived:68-74`, `node-stock-tree:82-86`). **Ten gates are judged by conclusion + event only**
(`release-manifest.json:7-55`). That is a deliberate alpha.15 design (`release-manifest.json:4`,
`artifact-evidence.mjs:75-78`), and it is also the reason section 2's release-qualification evidence schema is a
**gap**: there is nothing for the verifier to read.

### 1.4 Current-state summary at this program's tree

| classification | count | gates |
|---|---|---|
| release-admissible green run at (or after) `c256f21`, dispatch, full selection, rails verified | **0** | - |
| a recorded green program-tree run exists, but it is not a dispatch at HEAD and/or the trees are docs-only and rails unverified | 4 | CI (`42159888005`), drop-in (`42160006870`), smoke metrics (`42160114658`), node stock-tree (`42160006691`) |
| a narrowed green exists but the required tier is red/unrecorded | 1 | combination journey (fast `match` `42184268652`; full `42186322374`/`42193009501` red; `42198916430` failed at the send-blocking-overlay guard (M2g)) |
| no program-tree run recorded at all | 8 | whole-session, world-info, Browser differential, release qualification, Docker, helper state, third-party, long-lived |

The honest reading: **the 13-gate bar is proven as a mechanism at alpha.15 and unproven as evidence at this
tree.** That is expected before M6's dispatches, and it is the reason this document exists rather than an
inheritance claim.

---

## 2. `GoTavern release qualification`: jobs, artifacts, evidence schema, and the fail-closed verifier

### 2.1 The five jobs and what each proves

`.github/workflows/release-qualification.yml` (trigger: tag push `v*` or dispatch, `:38-51`):

| job (line) | timeout | what it executes | source |
|---|---|---|---|
| `qualify-linux-amd64` (`:57`) | 60 | builds TWO canonical linux-amd64 archives from the same source with different version strings; asserts archive contents/modes, `assets verify` from the extracted archive, fresh boot, idempotence, update (B over A), rollback (A back), data survival | header `:3-36` |
| `qualify-windows-amd64` (`:316`) | 60 | runs `install.ps1` on `windows-latest` over a server it started: the running-`gotavern.exe` refusal contract (non-zero exit, message, process alive, exe byte-identical, no staging file, `/version` still answering), then the update that DOES replace it; Start.cmd through `cmd /c`; the negative registry/shortcut claim | `:316-324` |
| `qualify-upgrade-rollback` (`:397`) | 60 | builds two archives from TWO DIFFERENT COMMITS (`baseline_ref` default `d00d99b`) and drives the REAL `install.sh` against a loopback mirror: install old, update, rollback, assert binary byte identity, `assets verify`, and survival of config/data/extensions/certs including state the newer release wrote | `:397-419` |
| `qualify-published-alpha9-upgrade` (`:520`) | 45 | downloads the PUBLISHED alpha.9, verifies it against the published `checksums.txt`, installs through `install.sh`, seeds the long-lived corpus, boots, updates to the candidate archive, drives the Beta 1 journey and classifies every runtime path | `:520-534` |
| `qualify-dropin-linux` (`:638`) | 25 | the user's own path: stock SillyTavern tree built by `scripts/build-stock-tree.sh`, the packaged archive unpacked over it, boot inside it with a 30 s polling bound, API smoke, no mutation of `extensions/**` or seeded data, restart and chat re-read | `:638-669` |

### 2.2 Artifacts and the evidence-schema gap

- Only two uploads exist: `published-alpha9-upgrade-<run_id>` (`:618`) and `dropin-failure-logs` (`:761`).
- **There is no fixed-name release-evidence artifact, no `release-evidence.json`, no embedded head SHA, no
  job requirement and no evidence schema.** The manifest entry for this gate names only
  `requiredEvent: workflow_dispatch` (`release-manifest.json:32-34`).
- Consequence, stated precisely: the fail-closed verifier can only check that *a* dispatch run of this
  workflow concluded success at the candidate SHA. It cannot see that `qualify-windows-amd64` ran (a green
  run with a skipped platform job would pass), cannot see which qualification jobs ran, cannot see the
  archive tests' verdicts, and cannot see any embedded identity. This is the same class the alpha.15 rails
  were built to refuse for `longlived`/`node-stock-tree` (`release-governance.md:40-58`), not yet applied
  here.
- To close it: the workflow must write `release-evidence.json` **at the artifact root** (the verifier reads
  exactly that member: `artifact-evidence.mjs:21`, `:66`), with `schemaVersion`, `kind`, `headSha`,
  `pinnedSha`, the job verdicts, the archive/checksum digests and a truthy `ok`; then the manifest entry
  gains `requiredJobs: [qualify-linux-amd64, qualify-windows-amd64, qualify-upgrade-rollback,
  qualify-published-alpha9-upgrade, qualify-dropin-linux]`, `requiredArtifact`, and `requiredEvidence`.
  No such change is made here (documentation-only task).

### 2.3 The verifier's refusal conditions (fail-closed)

From `gates.mjs` (unchanged since the program base - `git log c256f21..HEAD -- scripts/release-governance/
scripts/verify-release-gates.mjs docs/release-manifest.json` is empty):

| refusal (verdict string) | trigger | source |
|---|---|---|
| `missing` | no run of the workflow at all, no run at the candidate SHA, or runs at the SHA but none with the `requiredEvent` ("proves a narrowed selection, not the release gate") | `gates.mjs:302-316` |
| `not-green` | a run exists at the SHA but is not `completed`/`success` (in-progress, failed, cancelled) | `gates.mjs:318-323` |
| `missing-jobs` | `requiredJobs` named but the job list was not fetched | `gates.mjs:164-170` |
| `missing-job` | a required job is absent from the cited run | `gates.mjs:171-179` |
| `job-not-green` | a required job is not completed/success - a SKIPPED job is explicitly not green | `gates.mjs:181-187` |
| `missing-artifact` | the fixed-name artifact is absent or expired, or artifacts were not fetched | `gates.mjs:191-207` |
| `missing-evidence` | the artifact carries no readable `release-evidence.json` | `gates.mjs:208-215` |
| `evidence-mismatch` | wrong `schemaVersion`, `kind`, embedded head SHA ??  candidate, wrong tier marker, a `requireTruthy` field not exactly `true`, or a `requireSha256` field not lowercase 64-hex | `gates.mjs:216-229`, `artifact-evidence.mjs:125-153` |
| manifest refusals (not per-run) | unknown event name, duplicate workflow, missing `why`, evidence rails without `requiredArtifact`/`requiredEvent`, a workflow name that does not exist in `.github/workflows` | `gates.mjs:38-139`, `:487-495` |

The verifier itself is tested with fabricated API responses and refuses each class by name, including a
green run at a different SHA, a push run for a dispatch gate, a skipped required job, an expired artifact,
a wrong embedded head SHA and a corrupted ZIP (`release-governance.md:74-82`; `HANDOFF.md:32` records
"55 governance tests (34 fabricated-API refusals), 4 mutations"). It runs inside the publish job before
`gh release create`: through `scripts/assemble-release-body.mjs` when a curated note exists
(`release.yml:621-624`) and directly as `scripts/verify-release-gates.mjs` otherwise (`release.yml:631`);
publication follows at `:635-669`. The same decision function renders the published evidence table
(`assemble-release-body.mjs:1-16`).

### 2.4 Rehearsal commands (exact)

A release rehearsal is: dispatch every required gate at ONE candidate SHA with its full selection, then run
the same verifier the publish job runs, then the notes/checksums validators, then a `release.yml` dry run.
Nothing below was executed in this task.

```bash
# 0) candidate identity
candidate="$(git rev-parse HEAD)"            # must be the commit the release tag will point at

# 1) the 13 required gates, each a deliberate dispatch at the candidate
gh workflow run ci.yml                      --ref <ref> -f probes=            # empty probes = full oracle
gh workflow run whole-session.yml           --ref <ref>
gh workflow run worldinfo-slots.yml         --ref <ref>
gh workflow run dropin-qualification.yml    --ref <ref>
gh workflow run browser-differential.yml    --ref <ref> -f mode=all
gh workflow run release-qualification.yml   --ref <ref>
gh workflow run smoke-metrics.yml           --ref <ref> -f requests=50
gh workflow run docker.yml                  --ref <ref>
gh workflow run helper-state.yml            --ref <ref>
gh workflow run combination-journey.yml     --ref <ref>    # see section 3.4: for an interacting-scenario claim this must be -f profile=e03e04 -f tier=full
gh workflow run third-party-extension-compat.yml --ref <ref> -f mode=full
gh workflow run longlived.yml               --ref <ref> -f size=medium  # medium-corpus + longlived-medium-evidence
gh workflow run node-stock-tree.yml         --ref <ref>

# 2) THE GATE THE PUBLISH JOB RUNS (same program, same manifest). Needs GITHUB_TOKEN + GITHUB_REPOSITORY;
#    --runs-json is the offline/fixture mode.
GITHUB_REPOSITORY=cocokoishi/GoTavern GITHUB_TOKEN=<token> \
  node scripts/verify-release-gates.mjs --sha "$candidate" \
    --manifest docs/release-manifest.json --evidence-out /tmp/same-sha-evidence.md
# expect: "PASS: 13/13 required workflow(s) are green at this SHA." and the generated table

# 3) the artefact-side programs the publish job also runs
bash scripts/release-assemble-checksums.sh dist
node scripts/verify-release-notes.mjs docs/release-notes-v0.1.0-alpha.16.md v0.1.0-alpha.16 \
  --checksums dist/checksums.txt

# 4) the dry run: builds, executes foreign-platform archives, validates the notes and feeds the bare
#    installers through scripts/qualify-prepublish.sh; a dispatch NEVER publishes (release.yml:636-639)
gh workflow run release.yml --ref <ref> -f ref="$candidate" -f candidate_version=v0.1.0-alpha.16

# 5) only after 1-4 are green: tag push (the publish job re-runs the same verifier; no override exists)
git tag -a v0.1.0-alpha.16 -m "GoTavern v0.1.0-alpha.16" "$candidate" && git push origin v0.1.0-alpha.16

# 6) post-publication (independent of the release workflow)
gh run download <install-smoke-run> -n smoke-metrics-out            # published-install smoke run
gh run download <published-extension-run> -n published-extension-smoke-linux
git rev-parse v0.1.0-alpha.16^{commit}                               # must equal $candidate (no tag move)
```

Notes:
- `workflow_dispatch` is only available for a workflow that exists on the default branch -
  `.github/workflows/browser-differential.yml:45-52` records that measurement, and the same bootstrap
  constraint is recorded in `release-install-smoke.yml:81-90`.
- The dispatch inputs are part of the evidence: `mode=all`, `mode=full`, `size=medium` and an empty
  `probes` are what make the selection full. The verifier **cannot see dispatch inputs**
  (`gates.mjs:142-153` copies only run fields), so the run-id record must state them (section 2.5) - this is M0's
  E-H1 and it is still open.
- `release-qualification` is also triggered by a tag push; for the rehearsal use the dispatch, because the
  manifest requires `workflow_dispatch` (`release-manifest.json:32-34`).

### 2.5 Run-id evidence the Lead must collect

For each of the 13 gates, and for the release dry run, record together (never a bare id, `AGENTS.md` 55):

| field | how |
|---|---|
| workflow name + run id + conclusion | `gh run view <id> --json name,id,conclusion,event,headSha,createdAt` |
| `head_sha` == candidate | same output |
| event == `workflow_dispatch` | same output |
| dispatch inputs used | the command line from section 2.4 (GitHub does not return them) |
| required job(s) state | `gh run view <id> --json jobs` ??' name/status/conclusion, or the verifier row |
| artifact + embedded evidence | `gh run download <id> -n <artifact>`; quote `release-evidence.json` fields (kind/schemaVersion/headSha/tier/truthy/digests) - for the 10 gates without a rail, say so |
| verifier output | the printed table + `PASS 13/13` + the `--evidence-out` file |
| checksums | the six archive digests from `checksums.txt`, recomputed after download |
| container | `:v0.1.0-alpha.16` and `:latest` digests equal; the image pulled back and `assets verify` green |
| tag | tag object sha, tag target commit == candidate, and "not moved" |
| post-release | install-smoke run id, published-extension run id, post-release CI run id at `main` |

A clean M6 evidence document therefore carries: candidate SHA; the 13-row gate table (workflow + run id +
conclusion + inputs + rails); the verifier output; the archive/container/checksum identities; the tag's
target and its non-move; the post-publication runs; and the explicit skipped/UNPROVEN list (below).

---

## 3. The combination-journey interacting-scenario gate

### 3.1 Tier wiring as implemented

`Combination journey differential` is **already gate #10** (`release-manifest.json:52-55`), but the
manifest entry requires only that the workflow conclude success on a dispatch - it names no artifact, no
job and no evidence, and the workflow's own defaults dispatch the *legacy* journey. The E03+E04 profile is
the interacting-scenario addition; it is wired into the workflow but **not into the bar**.

| wiring | as implemented | source |
|---|---|---|
| trigger | `workflow_dispatch` (inputs `profile`, `tier`, `seed`, `extension_tier`) + a path-filtered push | `combination-journey.yml:29-72` |
| profile | `none` = legacy journey; `e03e04` = generated profile | `:32-39` |
| block tiers | `fast=12`, `medium=60`, `full=120` blocks, with per-block markers and a disabled-block absence control | `e03e04-profile-kit.mjs:180`; `first-scenario-design.md:109-113` |
| extension tiers | `fast=3` (Tavern Helper + first two lock entries), `medium=10` (two canaries + first eight lock entries), `full=22` (two canaries + the 20 locked extensions) | `extension-install-batch.mjs:14-34`, `:55` |
| books | all three sources are staged at every tier: global 3-slot, recursive secondary-key global, card-embedded; they are not a tier dial | `combination-journey-probe.mjs:518-589`; `first-scenario-design.md:109-113` (design says 1/2/3) |
| extension install | ONE seed install before the legs; each leg copies through `GOTAVERN_EXTENSION_SEED_ROOT` | `combination-journey.yml:192-204` |
| defaults | `profile=none`, `tier=full`, `extension_tier` follows `tier`; **a push passes no inputs, so a push runs the legacy journey** | `:35-53`, `:168-180` |
| five legs | gotavern drive, **pinned drive (oracle)**, gotavern restart, **pinned restart (oracle)**, **pinned hand-back (oracle)**; all receive the profile args | `:246-257` |
| comparator | byte-oriented per capture + observed steps + `--expect-profile e03e04`; a requested profile whose record is missing/digest-mismatched is a REFUSED run, never a downgrade | `compare-combination-journey.mjs:286-299`; `:549` |
| teeth | runs the synthetic profile suite AND, with the real legs supplied, the live mutation suite | `combination-journey.yml:293-300` |
| artifact | fixed name `combination-journey-evidence`; identity written even on failure: `kind`, `schemaVersion`, `headSha`, `pinnedSha`, `profile`, `tier`, `seed`, `extensionTier`, per-document sha256 | `:302-336`, `:347-358` |
| identity verifier | `--verify-artifact` runs in-workflow and refuses wrong kind/schema/pinnedSha, empty profile/tier/seed, missing documents or a digest mismatch | `:338-345`; `compare-combination-journey.mjs:verifyArtifactIdentity` |
| budget | 60 minutes for five browser legs + comparator + teeth | `:89-92` |
| concurrency | group `combination-journey-<workflow>-<ref>`, `cancel-in-progress: true` | `:77-79` |

Two source-level drifts are worth recording: the workflow header still says "Teeth: - (five mutations -)"
(`combination-journey.yml:21-22`) although the selftest now reports **35/35** (section 3.3), and
`first-scenario-design.md:3` still says "design only, not implemented".

### 3.2 What it adds over the thirteen

Alpha.15's gate #10 proves the composed session on the committed 105-prompt derivation, one 3-slot book,
Tavern Helper and the existing verbs. The E03+E04 profile adds, in the same session and the same single
provider request:

1. a deterministic **120-block** preset (per-block `MARKER_Pxxxx`, ordered by `prompt_order`, disabled
   blocks asserted absent) - the committed maxima are 105 / 119 / ???66 (`e03e04-profile-kit.mjs:188-193`);
2. **three nested books** with ordered markers plus declared-absence assertions (global 3-slot, recursive
   secondary-key global, card-embedded `character_book`), which no other gate exercises;
3. **22 pinned extensions coexist** (helpdesk canaries + the 20-extension lock) with per-extension wire-effect
   records, `no-wire-effect` honesty, and a prompt-takeover probe/configure-off for an installed orchestrator
   (`narrative-agent`) proven on the wire;
4. the same helper ?- QR/STscript ?- regex ?- variables ?- group interactions as gate #10, now under the
   extension-collision and prompt-stress conditions GOAL section 9 names;
5. embedded artifact identity + fail-closed identity verification, and a `--expect-profile` refusal that
   makes a missing profile record a red rather than a silent legacy pass.

### 3.3 Independent proofs already in hand, and their states

| proof | evidence | state |
|---|---|---|
| **oracle legs exist and are independent** | the pinned drive, pinned restart and pinned hand-back legs run through `run-against-pinned.mjs` (`combination-journey.yml:250-257`); the comparator refuses a missing restart pair or hand-back (`compare-combination-journey.mjs:17`) | **IN HAND (code + runs recorded)**; the full-tier legs have never all been green |
| **comparator teeth** | local read-only run at `0b577de`: `node tests/browser/combination-journey-gate-selftest.mjs` ??' `[selftest] 35/35 planted case(s) produced their NAMED red`, exit 0 (synthetic suite, no browser, no legs). Progression recorded: 28/28 (commit `6332ef2`), 30/30 (`f22cd1b`), 32/32 (`5262039`), 35/35 (`0b577de`) | **IN HAND for the synthetic suite.** The LIVE mutation suite runs only when the two real legs are supplied (`:293-300`) and has not been recorded green at full tier |
| **negative controls** | the selftest header enumerates one planted red per design section 6 row plus the dispatch-driven additions: `worldbook-order-*`, `preset-block-present-*`, `qr-to-helper-chain`, `helper-variable-marker`, `extension-effect-*`, `ordered-message-ids`, `card-character-book-marker`, `artifact-identity-complete`, `HARNESS-NON-DISCRIMINATING`, `e03e04-profile-recorded`, `e03e04-preset-applied`, `e03e04-preset-document-recorded`, `e03e04-embedded-book-imported`, `group-chat-persisted-parity`, `outgoing-prompt-integrity`, `extension-prompt-takeover-handled`, `send-blocking-overlays-handled` (`combination-journey-gate-selftest.mjs:15-30`) | **IN HAND** at the synthetic level; each row's live counterpart depends on the real legs |
| **fast tier green** | `Combination journey differential` **`42184268652`** - `match` - at lane `f22cd1b` (recorded in commit `5262039`, M2e) | **PROVEN for the fast tier** (12 blocks, 3 extensions, all three books staged) |
| **full tier attempt 1** | `Combination journey differential` **`42186322374`** - failure - at lane `f22cd1b`, profile=e03e04 tier=full extension_tier=full; failed symmetrically on BOTH subjects; all five legs recorded; the job failed at the leg-failure counter and the comparator was skipped (commit `5262039`) | **RED** |
| **full tier attempt 2** | `Combination journey differential` **`42193009501`** - failure - at lane `5262039`; the M2e fixes worked on both subjects (`extensionTakeover {detected:true, narrative-agent, disabled:true, intact:true}`, embedded book bound), and the NEW guard `send-blocking-overlays-handled` was red on both because ST-Copilot's startup changelog overlay covered `#send_but` (commit `0b577de`, M2f) | **RED** |
| **full tier attempt 3** | `42198916430` | **FAILED** - `Combination journey differential` workflow_dispatch at headSha `0b577de`; failed at the leg-failure counter after `send-blocking-overlay-handled` (the first overlay ST-Copilot `scp-changelog-modal` was dismissed through `scp-changelog-close`, then a second overlay `div#rpg-deprecation-modal` class `rpg-settings-popup is-open` was not discovered/dismissed). Harness defect, fixed in M2g; not a product finding, and not a green. |
| earlier profile attempts (context) | `42173399186` failed as HARNESS FAILURE counter=1 (commit `375dc8e`); `42178757887` produced the first real verdict `mismatch` with six failed guards, all harness defects (commit `6332ef2`); `42182251438` failed in "Record the five legs" because `bash -e` aborted the step on the first failing leg (commit `f22cd1b`) | recorded, all harness defects fixed at the cause |

### 3.4 Precise conditions before it may be ADDED to the release bar

The workflow is gate #10, but the interacting-scenario claim is not in the bar. All of the following must
hold (plan section 8: "only after its oracle leg, comparator and negative controls are independently proven"):

1. **A full-tier green exists at an explicit candidate SHA.** A `workflow_dispatch` with
   `profile=e03e04 tier=full extension_tier=full` must conclude success with verdict `match`, all five legs
   recorded, restart/hand-back guards green, and the live mutation suite green. Today: two full-tier reds,
   one failed at the send-blocking-overlay guard (`42198916430`), zero greens.
2. **The evidence artifact must carry the release-evidence contract.** The identity is currently written to
   `legs/identity.json` (`combination-journey.yml:333-334`) and uploaded as `legs/*.json` (`:354-357`); the
   release verifier reads only `release-evidence.json` **at the artifact root**
   (`artifact-evidence.mjs:21`, `:66`). Write that member with `schemaVersion`, `kind`, `headSha`,
   `pinnedSha`, `profile`, `tier`, `seed`, `extensionTier`, the document digests and a truthy `ok`.
3. **A boolean the rails can assert.** `requiredEvidence.requireTruthy` requires exactly `true`
   (`artifact-evidence.mjs:142-146`), so the evidence must carry e.g. `profileIsE03E04: true` and
   `fullTier: true`; `tierField: 'tier', tier: 'full'` covers the block tier but cannot express the profile
   string.
4. **The manifest entry gains the rails.** For gate #10 add `requiredJobs: ["combination-journey"]`,
   `requiredArtifact: "combination-journey-evidence"` and `requiredEvidence` with the contract above. The
   dispatch must be `profile=e03e04`; otherwise a legacy `profile=none` dispatch satisfies the gate with the
   old journey (default `none`, `combination-journey.yml:39`).
5. **The in-workflow artifact verifier must pin the SHA.** `verifyArtifactIdentity` checks only that
   `headSha` is 40 hex (`compare-combination-journey.mjs`), and the planted case uses `'Z'.repeat(40)`,
   which fails the regex rather than the equality (`combination-journey-gate-selftest.mjs:780-781`). A
   well-formed WRONG SHA passes the in-workflow verifier; only the manifest's
   `evidence.headSha === candidate` check (`artifact-evidence.mjs:131-133`) catches it, and only once
   condition 2 exists.
6. **Concurrency must not be able to cancel the evidence run.** The group is per ref with
   `cancel-in-progress: true` (`combination-journey.yml:77-79`). The long-lived and node-stock-tree
   workflows protect dispatch evidence with an event-suffixed group and `cancel-in-progress` false for
   dispatches (`longlived.yml:78-83`; `node-stock-tree.yml:48-53`); this workflow does not. Fix before it
   carries release evidence.
7. **The tier ladder required by plan section 8 must be wired or the narrower coverage declared.** Plan section 8 asks
   for a fast PR/branch tier, a medium same-SHA qualification tier and a full scheduled stress/soak tier.
   Today: a push runs `profile=none` (not the fast tier), medium is only a dispatch parameter, and there is
   no scheduled full/soak run. Either wire the ladder or declare the gate full-tier-only and stop claiming
   a tiered matrix.
8. **The live negative controls must be observed in the same green run**, not only the synthetic 35/35
   (workflow passes the real legs: `:293-300`).
9. **The kit's own selftest must be executed (or retired).**
   `tests/browser/extensions/e03e04-kit-selftest.mjs` exists and is listed only as a push path filter
   (`combination-journey.yml:61`); no step runs it. Either add an execution step or record that the
   comparator selftest's synthetic suite supersedes it and remove the misleading path entry.
10. **Release notes/evidence must state the tier and the narrower coverage** (fast 12/3, medium 60/10,
    full 120/22; books all three at every tier), and no narrowed run may be cited as full coverage.

### 3.5 Narrower coverage per tier (documented, not implied)

| tier | blocks | extensions | books staged | what a green would prove | what it could NOT support |
|---|---|---|---|---|---|
| fast | 12 | 3 (helper + first two lock entries) | all 3 | the ordered-marker contract + the journey's core interactions at small scale; suitable for branch CI | not the 22-extension collision, not the 120-block order, not the full-tier orchestration takeover paths |
| medium | 60 | 10 (2 canaries + 8 lock entries) | all 3 | a mid-size prompt order + a 10-extension coexistence | not all 20 locked extensions; not the full prompt stress |
| full | 120 | 22 (2 canaries + 20 lock) | all 3 | the GOAL section 9 combination at the stress tier - the only tier that can support the interacting-scenario claim | still not a real provider, not multi-user, not a real user's prose, not frontend-only extension effects (`combination-journey.yml:24-27`; `first-scenario-design.md:118-125`) |

The fast-tier extension composition is itself a measured correction of the design: all twenty lock
extensions declare a wire-relevant capability, so the "two quiet entries" the design hoped for do not
exist; the fast tier installs the first two lock-order entries and records them as
`capability-relevant-unproven` rather than pretending they are quiet (`extension-install-batch.mjs:21-26`).

---

## 4. Fail-closed section 8 checklist

States: **PROVEN** (a run/artifact exists and is cited), **UNPROVEN** (no evidence at this tree, or the
evidence does not decide the claim), **BLOCKED** (a structural precondition prevents it). "alpha.15" and
"program tree" are separate columns because the release bar must be re-earned on the alpha.16 candidate.

| # | requirement (source) | alpha.15 | program tree (`0b577de`) | why / evidence |
|---|---|---|---|---|
| 1 | all 13 same-SHA required workflows green at one commit (`plan:127`, `GOAL.md:539-544`) | **PROVEN** | **UNPROVEN** | alpha.15: 13 runs at `95638da`, verifier `PASS 13/13` (`HANDOFF.md:45-66`). Program tree: 0/13 release-admissible (section 1.4); expected before M6 dispatches |
| 2 | third-party gate with its fixed-name `extension-compat-evidence` artifact (`GOAL.md:539-544`; `release-manifest.json:57-61`) | **PROVEN** | **UNPROVEN** | run `42085125376` mode=full (`HANDOFF.md:61`); no program-tree run |
| 3 | long-lived medium tier + `longlived-medium-evidence` with embedded tier/head SHA/teeth/digests (`release-manifest.json:63-76`) | **PROVEN** | **UNPROVEN** | run `42085136899` verified (`HANDOFF.md:62`); no program-tree run; the small-tier masquerade rail is in code (`gates.mjs:181-189`) |
| 4 | Node stock-tree round trip + `node-stock-tree-evidence` (`release-manifest.json:77-87`) | **PROVEN** | **UNPROVEN** | run `42085148642` verified (`HANDOFF.md:63`); `42160006691` is a docs-only program-tree success whose event/rails are not recorded as release evidence (`source-audit.md:171-172`) |
| 5 | fail-closed verifier runs in the publish path (`plan:130`, `GOAL.md:539-544`) | **PROVEN** | **UNPROVEN (run)** - the code is unchanged and tested | code: `release.yml:621-624` and `:631`; tests: `release-governance.md:74-82`, `HANDOFF.md:32`; alpha.15 verifier printed `PASS 13/13` before `gh release create` (`HANDOFF.md:101`). No alpha.16 candidate run exists |
| 6 | release assets + checksums + container pulled back from the public endpoint (`plan:130`, `GOAL.md:563-568`) | **PROVEN** | **UNPROVEN** | alpha.15: 7 assets, digests re-downloaded and compared; container `:tag`/`:latest` same digest `sha256:28fd03f4-`; tag run `42113162309` built/verified/pulled back (`HANDOFF.md:95-98`) |
| 7 | TLS installer smoke (`plan:130`, `GOAL.md:566-568`) | **PROVEN** | **UNPROVEN** | `GoTavern published-release install smoke` `42115838898` success (`HANDOFF.md:99`) |
| 8 | published-extension complex journey (`plan:130`, `GOAL.md:566-568`) | **PROVEN** | **UNPROVEN** | `GoTavern published-extension smoke` `42115856121` success, both legs (`HANDOFF.md:99`) |
| 9 | Node ??" Go hand-back (`plan:130`, `GOAL.md:563-564`) | **PROVEN** | **UNPROVEN** | Q21 hand-back in `Browser differential` `42085061246` (`HANDOFF.md:55`) and the Node stock-tree round trip `42085148642` (`:63`); no program-tree run |
| 10 | no tag move, no force push, no `--no-verify`, no private data, commit identities (`GOAL.md:569-570`) | **PROVEN** | **UNPROVEN** | alpha.15 tag object `8e9e2dcf-` target `95638da-`, "the tag was not moved" (`HANDOFF.md:95`); commit-identity gate runs in CI (`release-governance.md` section 3; `ci.yml:481`). Note the publish-path exception: the tag run's `publish` job was skipped because the macOS arm64 runner was unsupported, and publication was done by running the workflow's own programs against that run's artifacts (`HANDOFF.md:101`) - recorded, and the tag did not move |
| 11 | release notes generated/checked against evidence and stating every skipped/UNPROVEN scenario (`plan:130`, `GOAL.md:555-557`) | **PROVEN (claim)** / drift found | **UNPROVEN** | alpha.15 note lists its boundaries (`release-notes-v0.1.0-alpha.15.md:92-148`) and its notes are validated by `scripts/verify-release-notes.mjs` (`release.yml:486-503`); **but its `## Performance` section is empty (`release-notes-v0.1.0-alpha.15.md:81-83`)** even though `GOAL.md:545-550` requires the figures to be regenerated from the artifact - the README/figure gate is green, the note itself carries no numbers. No alpha.16 note exists (`docs/` search: no `*alpha.16*`) |
| 12 | interacting-scenario gate added only after oracle leg + comparator + negative controls are independently proven (`plan:127`) | n/a | **BLOCKED** | workflow is gate #10, but the E03+E04 full tier has never been green (two reds, one unrecorded run) and the evidence rails are not in the manifest (section 3.4 C1-C10) |
| 13 | no test passes merely because it created files / installed an extension / hit an endpoint / saw a 200; evidence must show extension code executed, markers reached the provider wire, and the intended mutation occurred (`plan:128`) | **PARTIAL** | **PARTIAL** | combination fast tier `42184268652` proves the ordered markers reach the provider body for fast; full tier never green; the all-20 corpus job proves load/API-state, not code execution (M0 finding E-H4); the third-party lifecycle job proves setting persistence and restart but on one extension per root. The strict form of plan:128 is not yet proven at full tier |
| 14 | cross-platform process/file semantics; macOS ARM64 resolved or transparently downgraded with no `continue-on-error` loophole (`plan:129`) | **PROVEN as a recorded downgrade** | **BLOCKED** | the platform refuses `macos-14-arm64-us-default` and cancels the job (`HANDOFF.md:101`; `release-notes-v0.1.0-alpha.15.md:161-165`); `release.yml:389-416` still targets `macos-14` with no downgrade field, and `publish` needs it (`:541`), so a tag run's publish job skips. darwin/arm64 is built + archive-inspected, NOT executed. `docs/alpha16/source-audit.md:234` records the open fix: a supported runner or an explicit downgrade in `release.yml` |
| 15 | release governance applied to the embedded evidence schema, required artifact, required jobs and exact candidate SHA (`plan:129`) | **PARTIAL** | **PARTIAL** | the schema/rails exist and are tested (`release-governance.md:40-82`), but only 3/13 gates carry an artifact and 2/13 carry `requiredEvidence` (`release-manifest.json`); 10 gates are conclusion-only (M0 E-H8). The exact-candidate check is real for the gates that use the rails |
| 16 | M1/M2/M7 gates + performance figures regenerated from the artifact + same-SHA smoke metrics at the tag commit (`GOAL.md:545-550`) | **PROVEN** | **UNPROVEN** | alpha.15: `GoTavern smoke metrics` `42085081862`; `tests/perf/q22-baseline.json` names `f1396ce` as the measured ancestor; the README/figure gate runs in `ci.yml` verify. Program tree: L-H1 was closed by deliberate regeneration (`42164978648` regenerate ??' `42165562517` green comparison, `docs/alpha16/baseline/README.md:175-192`), but no smoke-metrics run at HEAD exists, and the M5 matrix is still unexercised (`docs/alpha16/m5-measurement-plan.md`) |
| 17 | `scripts/classify-version-tag.sh` classifies the new tag stable, the equality list gains it, and the neighbour test proves it (`GOAL.md:551-554`) | alpha.15 **PROVEN** | **UNPROVEN for alpha.16** | `GRADUATED_STABLE_TAGS` ends at `v0.1.0-alpha.15` (`scripts/classify-version-tag.sh:92`); an alpha.16 tag today classifies **prerelease**, and `scripts/test-classify-version-tag.sh` has no alpha.16-stable case. This is a required, one-commit change |
| 18 | audit obligation recorded: one-row-per-surface blind-spot ledger, every new gate mutation, every real defect reproducer (`GOAL.md:558-562`) | **PROVEN** | **PARTIAL** | alpha.15: `docs/audit-v0.1.0-alpha.15.md` (80 rows; `HANDOFF.md:16-19`). alpha.16: M0 audit deliverables exist (`docs/alpha16/source-audit.md`, `audit/*.md`, `ownership-map.json`) and the combination teeth are 35/35, but there is no alpha.16 blind-spot ledger row set and no mutation ledger for the *new* release rails (section 3.4 C2-C10) |
| 19 | Docker `:v0.1.0-alpha.16` and `:latest` published and resolving to the same digest (`GOAL.md:565`) | **PROVEN** | **UNPROVEN** | alpha.15 digest `sha256:28fd03f4-`, `:latest` moved because the tag is stable (`HANDOFF.md:98`); a same-SHA dispatch of `docker.yml` with default `push_image=false` does not publish (`docker.yml:168-217`), so the future gate must evidence the tag run |
| 20 | `GOAL.md` section 14 strong drop-in bar is NOT MET by synthetic qualification (`plan:131`, `GOAL.md:417-472`) | **STATED** | **STATED** | see section 4.1; the statement is already in the tree and must be repeated in alpha.16's notes |

### 4.1 The `GOAL.md` section 14 statement (must not be redefined)

`GOAL.md:452`: *"Current state, dated 2026-11-05 (`v0.1.0-alpha.15`): **NOT MET for the strong form.**
The evidence that exists is synthetic-"*. The same statement is carried in `HANDOFF.md:70-73` and
`docs/release-notes-v0.1.0-alpha.15.md:94-99` (`PRIVATE_NOT_RUN`, no authorised original on the
qualification host), and the plan repeats it as a rule (`docs/alpha16-agent-execution-plan.md:131`):
alpha.16 may claim a new **synthetic adversarial qualification** with precise scope; it may **not** claim
the real-private-tree drop-in bar. `docs/alpha16/source-audit.md:236` records the same as a residual
unknown with its closer ("needs a real private tree and its byte census; synthetic environments do not
close it"). Any alpha.16 release note that omits this is a claim ahead of evidence (`GOAL.md:36`/rule 36).

---

## 5. Exact open items (actionable, ordered)

1. **Alpha.16 tag classification.** Add `v0.1.0-alpha.16` to `GRADUATED_STABLE_TAGS`
   (`scripts/classify-version-tag.sh:92`) *and* extend `scripts/test-classify-version-tag.sh` so the new
   tag is stable while `v0.1.0-alpha.17`, `v0.1.0-alpha.160`, `v0.1.0-alpha.16-rc1` and the other neighbours
   stay prerelease (`GOAL.md:551-554`). One commit; without it an alpha.16 tag publishes as prerelease.
2. **Alpha.16 release notes.** Create `docs/release-notes-v0.1.0-alpha.16.md` (or `docs/releases/-`) from the
   evidence, with a non-empty performance section, every boundary from
   `release-notes-v0.1.0-alpha.15.md:92-148` that still applies, the new section 3.5 tier statement, and the
   skipped/UNPROVEN list. The alpha.15 note's empty `## Performance` section (`:81-83`) is the anti-pattern
   to avoid.
3. **macOS ARM64.** Resolve `execute-darwin-arm64` (`release.yml:389-416`, `runs-on: macos-14`) or add an
   explicit, recorded downgrade so the publish job (`:541`) does not skip on an unsupported runner label -
   without a `continue-on-error` loophole (`plan:129`). Today a tag run skips `publish` exactly as at
   alpha.15 (`HANDOFF.md:101`).
4. **Release-qualification evidence schema.** Write `release-evidence.json` at the artifact root and add
   `requiredJobs`/`requiredArtifact`/`requiredEvidence` for gate #6 (section 2.2). Until then the fail-closed
   verifier cannot see inside this gate.
5. **Combination-journey rails.** Conditions section 3.4 C1-C10, in order; the first is a full-tier green at an
   explicit candidate SHA, the second is moving the identity to a root `release-evidence.json` carrying a
   boolean the rails can assert.
6. **Narrowed-dispatch rail (M0 E-H1).** Ten gates can be satisfied by a `workflow_dispatch` whose inputs
   narrow the selection (`ci.yml:124`; `browser-differential.yml:264`; `combination-journey.yml:39`). The
   verifier cannot read dispatch inputs (`gates.mjs:142-153`). Either add a selection marker to each gate's
   evidence document plus a `requiredEvidence` rail, or record the limitation explicitly in the bar.
7. **Evidence per gate.** 10/13 gates upload no fixed-name release evidence; if alpha.16 wants "evidence
   judged, not names", each gate that already computes a verdict (whole-session comparison, worldinfo
   comparison, helper-state comparison, combination identity, extension-compat summary) can write the same
   `release-evidence.json` contract.
8. **Alpha.16 blind-spot ledger.** One row per new/changed gate with its mutation, per `GOAL.md:558-562`;
   the combination selftest gives 35 synthetic rows, but the release-rail mutations (tier/profile/head-SHA
   refusal) have no row set yet.
9. **Alpha.16 candidate dispatches.** section 2.4 must be executed at one candidate SHA and the run ids collected
   per section 2.5; only then can any of the "program tree" cells in section 4 move from UNPROVEN to PROVEN.

## 6. Residual risks and what this document does not prove

1. **The 13-gate bar is proven as a mechanism, not as evidence at this tree.** section 1.4's 0/13
   release-admissible is a statement about recorded runs, not about the gates' correctness; the M6
   dispatches are what change it.
2. **The verifier cannot see dispatch inputs or (for 10 gates) anything inside a run.** A narrowed dispatch
   can satisfy a conclusion-only gate; that is M0 E-H1 and it is not closed by this document.
3. **`42198916430` is now verified (see section 0.2).** It failed at the send-blocking-overlay guard (second overlay not dismissed); gate #10 remains UNPROVEN for the interacting scenario until a full-tier green exists at an explicit candidate SHA.
   must be updated; until then the full-tier interacting scenario has no green.
4. **The combination artifact's in-workflow verifier accepts a well-formed but wrong head SHA** (section 3.4 C5);
   the planted selftest case only proves the format check.
5. **The alpha.15 publish path was not the tag run's publish job** (it was skipped on the unsupported
   runner; the workflow's own programs were re-run by hand against that run's artifacts, `HANDOFF.md:101`).
   The gate result (`PASS 13/13`) and the tag immutability are recorded, but a future release must either fix
   the runner or record the same exception; the automation path itself has never been exercised end-to-end
   on a supported runner set.
6. **`release-qualification` and 10 other gates have no embedded evidence**, so "the verifier passed" does
   not mean "the qualification jobs ran". The narrow fix is section 5.4.
7. **The macOS ARM64 / darwin-arm64 execution boundary is a platform blocker, not a product gap**; it must
   stay visible in the release notes and may not be papered over with `continue-on-error`.
8. **No claim in this document is a run.** Every number is a citation; every absence is marked UNPROVEN.
   Nothing here was dispatched, so nothing here is fresh evidence about `0b577de`.
