# alpha.18 — the evidence contract is APPLIED to the release chain

**Status: rails applied + real fail-closed/accept evidence captured; the full 13-gate acceptance run for the
run-name gates is UNEXECUTED pending the workflow commit + the alpha.18 wave (commands given in §7).**

Alpha.17 added the rails, proved them with synthetic refusals and produced a unified evidence document, but left
`docs/release-manifest.json` unchanged and did not wire the emitter into the publish path: the contract was a
proposal. This round makes it policy:

1. every one of the thirteen required gates now names `requiredSelection`, and the four artifact gates additionally
   bind their evidence bundle's **bytes** (`requireArtifactDigest`) and **run identity** (`requiredArtifactFresh`);
2. the two gates whose producer writes a pinned-oracle member under a different name bind it explicitly
   (`requiredEvidence.pinnedShaField: pinnedCommit` for the Node stock-tree gate; `pinnedSha` for the combination
   gate), with `manifest.pinnedSha` recording the baseline;
3. `release.yml`'s publish job emits `release-evidence.json` + `release-evidence.md` with the **same** verifier,
   asserts that the tree it publishes is the tag target the runs were judged at, appends the table to the run summary
   and uploads it as the `release-evidence-contract` artifact;
4. two workflows (`ci.yml`, `browser-differential.yml`) now set `run-name` from their dispatch input so the full
   selection is **machine-visible through the Actions API** (`display_title`), because their job lists cannot
   distinguish `probes=full`/`mode=all` from a narrowed dispatch.

The alpha.17 record is unchanged at [`../alpha17/evidence-contract.md`](../alpha17/evidence-contract.md); this file is
the alpha.18 record of what changed and what was measured.

## 1. Manifest: which rail on which gate, and the real API source that proves it

`docs/release-manifest.json`: `pinnedSha = 06bde939fb1e9c4c8d8641d810f0a916b5bce127` added; every gate below is unchanged
in `workflow`/`why`/`requiredEvent` except for the added rails (the `why` text gains a `RAIL:` sentence).

| # | workflow | `requiredJobs` (real display names) | selection proof | artifact rails |
|---|---|---|---|---|
| 1 | GoTavern CI | `changes`, `browser-evidence`, `verify`, `crash-gate`, `race`, `oracle` | `titleIncludes: ["probes=full"]` — the `probes` input narrows the sweep while the same jobs stay green; `ci.yml` now sets `run-name` from it | — |
| 2 | GoTavern whole-session differential | `whole-session` | `jobs` | — |
| 3 | GoTavern world-info slot ordering | `worldinfo-slots` | `jobs` | — |
| 4 | GoTavern drop-in qualification | `dropin-current-head`, `windows-inputs`, `dropin-windows` | `jobs` | — |
| 5 | Browser differential | `differential` (the `handback-stability`/`publish-preset` jobs are legitimately SKIPPED in a `mode=all` dispatch, so they are excluded) | `titleIncludes: ["mode=all"]` — every mode runs the same job; `browser-differential.yml` now sets `run-name` from `inputs.mode` | — |
| 6 | GoTavern release qualification | `qualify-linux-amd64`, `qualify-windows-amd64`, `qualify-dropin-linux`, `qualify-published-alpha9-upgrade`, `qualify-upgrade-rollback` | `jobs` | — |
| 7 | GoTavern smoke metrics | `measure-linux-amd64`, `paired-linux-amd64` | `jobs` | — |
| 8 | GoTavern Docker image | `docker` | `jobs` | — |
| 9 | Helper state differential | `helper state differential (ubuntu, bounded)` — the job's DISPLAY name, not its id (`helper-state`) | `jobs` | — |
| 10 | Combination journey differential | `combination-journey` | `evidence`: `profile=e03e04`, `tier=full` (the producer writes both; a legacy `profile=none` document does not) | `requiredArtifact`, `requiredEvidence` (unchanged), `requiredPinnedSha` (producer's `pinnedSha`), `requireArtifactDigest`, `requiredArtifactFresh` |
| 11 | Third-party extension compatibility | `selftest`, `aggregate`, `corpus`, `soak`, `overhead`, `macos-arm64-recorded-limitation` | `jobs`: `aggregate`/`corpus`/`soak`/`overhead` are scheduled ONLY for `mode=full`; a `mode=sentinel` dispatch leaves them SKIPPED and runs `sentinel` | `requiredArtifact`, `requireArtifactDigest`, `requiredArtifactFresh` — **no** `requiredEvidence`: the `extension-compat-evidence` archive carries no `release-evidence.json` member, and inventing a content contract for a document that does not exist would make the gate unsatisfiable |
| 12 | GoTavern long-lived corpus qualification | `medium-corpus` | `evidence`: `size=medium` (independent of the job list) | `requiredArtifact`, `requiredEvidence` (unchanged), `requireArtifactDigest`, `requiredArtifactFresh` — **no** `requiredPinnedSha`: the medium evidence document does not carry a pinned-commit member |
| 13 | GoTavern Node stock tree round trip | `node-stock-tree` | `jobs` | `requiredArtifact`, `requiredEvidence` (unchanged), `requiredPinnedSha` with `pinnedShaField: pinnedCommit` (the producer's field name), `requireArtifactDigest`, `requiredArtifactFresh` |

Why the other **nine** gates do not name `requiredPinnedSha`: their producers do not write a pinned-oracle member into
an artifact the gate consumes. The alternative — naming the rail anyway — would make the gate red at every release for
a field the workflow does not produce; the honest form is to leave it un-named and state the gap (§8).

Why job names are **display names**, and why matrix jobs are excluded: the runs API reports each job's `name`, which is
the YAML `name:` when set (Helper state) and the job id otherwise (whole-session, …). Matrix jobs append their values
(`shard (1)`, `cross-platform (macos-15-intel, macos-amd64, gotavern)`), so requiring them would break whenever the
matrix changed. `aggregate`/`corpus`/`soak`/`overhead` already prove `mode=full`, so the matrix names add nothing.
`scripts/release-governance.test.mjs` pins both facts: the Helper state display name must still match the workflow
file, and no required job may be a matrix-generated name.

## 2. Workflow edits (2 workflows + the publish path)

`ci.yml` (top of file):

```yaml
run-name: GoTavern CI probes=${{ github.event_name == 'workflow_dispatch' && (inputs.probes || 'full') || 'auto' }}
```

`browser-differential.yml` (top of file):

```yaml
run-name: Browser differential mode=${{ github.event_name == 'workflow_dispatch' && (inputs.mode || 'all') || 'auto' }}
```

Both are evaluated from the dispatch input and become the run's `display_title`, which the manifest's
`requiredSelection.titleIncludes` reads. Non-dispatch triggers say `auto` (a push run can never satisfy
`requiredEvent: workflow_dispatch`, and the label must not claim a full sweep the automatic path did not run). Both
files parse as YAML (checked with PyYAML, which is the strongest local check available without dispatching).

`release.yml` publish job, two new steps between the body step and `gh release create`:

```yaml
      - name: Emit the unified release evidence contract (same-SHA, fail closed)
        if: github.ref_type == 'tag' && startsWith(github.ref, 'refs/tags/v')
        env:
          GITHUB_TOKEN: ${{ github.token }}
        run: |
          set -eu
          target="$(git rev-parse "${GITHUB_REF_NAME}^{commit}")"
          checkout_sha="$(git rev-parse HEAD)"
          if [ "${checkout_sha}" != "${target}" ]; then
            echo "::error::the publish checkout is ${checkout_sha}, not the tag target ${target}; ..." >&2
            exit 1
          fi
          node scripts/verify-release-gates.mjs \
            --sha "${target}" --manifest docs/release-manifest.json \
            --release-evidence-out "${RUNNER_TEMP}/release-evidence.json" \
            --release-evidence-md-out "${RUNNER_TEMP}/release-evidence.md" \
            --workflow "${GITHUB_WORKFLOW}" --event "${GITHUB_EVENT_NAME}"
          # The pinned oracle baseline is read from docs/release-manifest.json (`pinnedSha`) by the verifier, so this
          # workflow does not repeat the literal: one policy source, and a baseline bump is one manifest edit.
          { echo; echo "## Unified release evidence contract"; echo; cat "${RUNNER_TEMP}/release-evidence.md"; } >> "$GITHUB_STEP_SUMMARY"

      - name: Upload the unified release evidence contract
        if: github.ref_type == 'tag' && startsWith(github.ref, 'refs/tags/v') && success()
        uses: actions/upload-artifact@v4
        with:
          name: release-evidence-contract
          path: |
            ${{ runner.temp }}/release-evidence.json
            ${{ runner.temp }}/release-evidence.md
          if-no-files-found: error
          retention-days: 90
```

**The release consumes the same evidence the verifier reads**: one query plan (`evidenceQueryNeeds`), one decision
function (`evaluateGates`), one document. The checkout assertion is what makes "correct commit" checkable: the six
archives are downloaded from *this* run's build matrix, the verifier only accepts runs whose `head_sha` is the tag
target, and the tree executing the check is proven to be that same commit. The step is fail-closed and runs before
`gh release create`; a failing gate writes no PASS document and exits non-zero.

## 3. Real GitHub Actions evidence (all runs listed here are REAL; commands and outputs verbatim)

All local verification was run from `main` at `336ba48dab8aa124e0eff55e1cf352c495d8f6eb` with
`GH_TOKEN`, `GITHUB_REPOSITORY=cocokoishi/GoTavern`.

### 3.1 Full selection ACCEPTED — `GoTavern Docker image` run **42438088879**

Dispatched with `gh workflow run docker.yml --ref main` at `336ba48`; `completed/success`. The applied manifest row
(`requiredJobs: ["docker"]`, `requiredSelection: {jobs: ["docker"]}`) was exercised by a one-gate manifest copy of the
committed row (the full 13-gate wave is the release candidate's, §7):

```
| required workflow | run | event | status | conclusion | required jobs | evidence | verdict |
|---|---|---|---|---|---|---|---|
| GoTavern Docker image | 42438088879 | workflow_dispatch | completed | success | docker | - | success |

**PASS**: 1/1 required workflow(s) are green at this SHA.
```

Exact command:

```bash
node scripts/verify-release-gates.mjs --sha 336ba48dab8aa124e0eff55e1cf352c495d8f6eb \
  --manifest "$TEMP/manifest-docker.json"      # the committed Docker gate, alone
```

The emitter was run on the same accepted run (`--release-evidence-out …`, pinned baseline taken from the manifest):

```
wrote unified release evidence to …/real-docker-evidence.json (overall PASS, 1/1 gates)
overall=PASS gates=1 passed=1 publishable=true
pinnedSha={"value":"06bde939fb1e9c4c8d8641d810f0a916b5bce127","derived":true,"source":"manifest.pinnedSha (the release baseline policy)"}
selection.proven=["GoTavern Docker image"] unverifiable=[]
gates[0].selection = { "status": "proven", "derived": true, "provenBy": "jobs" }
```

The committed sample is [`release-evidence-docker-smoke.json`](release-evidence-docker-smoke.json) (a real run, not a
fixture).

### 3.2 Narrowed dispatch REFUSED — `GoTavern long-lived corpus qualification` run **42438080493**

Dispatched with `gh workflow run longlived.yml --ref main -f size=small` at `336ba48`. The workflow concluded
`success` (the small job is green), which is exactly the masquerade the rail exists for. The applied gate requires
`medium-corpus`:

```
**FAIL**: 1 problem(s):
- GoTavern long-lived corpus qualification: job-not-green (run 42438080493): required job "medium-corpus"
  is completed/skipped in run 42438080493 (a skipped job is not a green job)
```

Exit status `1`. The same run inside the full manifest at the same SHA is refused identically while the accepted
Docker row is `success` in the same table (a real mixed wave, §3.4).

### 3.3 The title rails REFUSE the historical alpha.17 wave (real API, real runs)

All thirteen alpha.17 runs are real (`docs/alpha17/same-sha-evidence.md`), and every one of their `display_title`s is
just the workflow name because those workflows did not set `run-name` yet. Reading the same real wave with the
**applied** manifest:

```
$ node scripts/verify-release-gates.mjs --sha 9b99fde0b0a9be0665cd93bc2143a3f495af31c2 --manifest docs/release-manifest.json
…
Refusals, each naming the rail that broke (a green conclusion is not by itself evidence):
- GoTavern CI: **narrowed-selection** — run display title "GoTavern CI" does not contain "probes=full"
- Browser differential: **narrowed-selection** — run display title "Browser differential" does not contain "mode=all"

**FAIL**: 2 problem(s)
```

Exit status `1`; the other eleven gates pass on that wave with their new rails (required jobs, embedded
evidence/tier, pinned member, artifact digest and freshness all satisfied by the real alpha.17 artifacts). This is the
rail working: a wave that cannot prove its full selection is not accepted, and the next wave (dispatched after the
`run-name` commit) is the first that can.

### 3.4 Wrong/SHA-missing refusal (real API)

A 40-hex commit with no runs (`ffff…`) is refused by every gate, e.g.:

```
::error::Helper state differential: missing (no run): no run of this workflow exists; the gate cannot be satisfied by a claim
```

and at `336ba48` (real push runs exist, no dispatches except the two above) the same run shows the event rail doing
its job:

```
::error::GoTavern drop-in qualification: missing (run 42396302020): no workflow_dispatch run at the target SHA
  (1 run(s) of the same workflow exist there with event(s) push, which prove a narrowed selection, not the release gate)
```

## 4. Local test evidence

`node --test scripts/release-governance.test.mjs` → **87 tests, 87 pass, 0 fail** (alpha.17: 83; alpha.16: 69). New
cases this round:

| case | what it pins |
|---|---|
| `manifest: the applied alpha.18 rails are present on all thirteen gates` | every gate names a selection source; the two title gates; the evidence gates; pinned member names; digest+freshness on the four artifact gates; no matrix job names; Helper state display-name mapping |
| `selection: a legacy run whose display title predates the run-name is refused as narrowed-selection` | the measured alpha.17 refusal shape for CI and Browser, plus the positive control with the run-name |
| `pinnedSha: requiredEvidence.pinnedShaField reads the producer's differently named member` | `pinnedCommit` is read for the Node gate; missing member refuses `pinned-sha-missing` naming the member |
| `emitter: a title-proven gate is recorded in selection.proven, not in the unverifiable list` | the unified document reports `display-title` proof and does not list the gate as unverifiable |

## 5. Fail-closed classes that cannot be produced with a real run (UNEXECUTED, and why)

- **Stale artifact (artifact belongs to another run/attempt).** The Actions API gives no way to attach an artifact from
  another run to a candidate run, and artifacts cannot be fabricated into a run. The rail compares
  `artifact.created_at` and `artifact.workflow_run.id/head_sha` against the cited run; it is covered by synthetic
  refusals (`stale-artifact`, including a 999-vs-51 run id and a pre-run timestamp), and by the real alpha.17 wave where
  all four artifacts **are** the cited runs' (`workflow_run.id == run.id`, timestamps after run start).
- **Missing/expired artifact.** Cannot be induced on a real run without deleting release evidence or waiting 90 days
  for expiry; covered by synthetic cases (`missing-artifact`, `EXPIRED`).
- **run-name → display_title propagation for CI/Browser.** The `run-name` edits are in the working tree only (the Lead
  owns git); `workflow_dispatch` always runs the workflow file as committed on the ref. As soon as the Lead commits
  `ci.yml` and `browser-differential.yml`, this exact sequence proves the mechanism cheaply:
  `gh workflow run browser-differential.yml --ref main -f mode=assets` (~5 min) → the run's `display_title` must be
  `Browser differential mode=assets`; reading that SHA with the applied manifest must refuse Browser as
  `narrowed-selection` (title lacks `mode=all`) — a REAL narrowed browser refusal. The full `mode=all` dispatch in the
  final wave must be `accepted`.
- **The full 13-gate wave at the alpha.18 candidate** is the release candidate's wave (§7), not run here.

## 6. The applied selection rails and their named refusals (recap of the alpha.17 contract)

| rail | refusal by name |
|---|---|
| `requiredSelection.jobs` | `narrowed-selection` (a required job absent/skipped/failed IN the cited run) |
| `requiredSelection.evidence` | `narrowed-selection` (an embedded member differs from the required value) |
| `requiredSelection.titleIncludes` | `narrowed-selection` (the display title lacks the required marker; a legacy/no-run-name run lands here) |
| any declared source unreadable | `selection-unverifiable` (refused; the consolidated document marks the gate `derived:false`) |
| `requiredPinnedSha` | `pinned-sha-missing` / `pinned-sha-mismatch` |
| `requireArtifactDigest` | `artifact-digest-missing` (the API's `sha256:<64hex>`) |
| `requiredArtifactFresh` | `stale-artifact` (other run/head, pre-run timestamp, or no comparable identity) |
| `requiredEvidence.requireFields` | `evidence-mismatch` naming the missing member |

## 7. Dispatch commands for the alpha.18 13-gate wave (after this change is committed)

The run-name gates require the committed workflow files; `probes` MUST be empty and `mode` MUST be `all`:

```bash
gh workflow run ci.yml                          --ref main -f probes=
gh workflow run whole-session.yml               --ref main
gh workflow run worldinfo-slots.yml             --ref main
gh workflow run dropin-qualification.yml        --ref main
gh workflow run browser-differential.yml        --ref main -f mode=all
gh workflow run release-qualification.yml       --ref main
gh workflow run smoke-metrics.yml               --ref main -f requests=50
gh workflow run docker.yml                      --ref main
gh workflow run helper-state.yml                --ref main
gh workflow run combination-journey.yml         --ref main -f profile=e03e04 -f tier=full -f extension_tier=full
gh workflow run third-party-extension-compat.yml --ref main -f mode=full
gh workflow run longlived.yml                   --ref main -f size=medium
gh workflow run node-stock-tree.yml             --ref main
```

Then, at the candidate SHA:

```bash
node scripts/verify-release-gates.mjs --sha "$CANDIDATE" --manifest docs/release-manifest.json \
  --release-evidence-out "$TMP/release-evidence.json" \
  --release-evidence-md-out "$TMP/release-evidence.md" \
  --workflow 'GoTavern Release' --event workflow_dispatch
```

The pinned baseline comes from `manifest.pinnedSha`, so the command has no baseline literal to keep in sync.

## 8. Residual gaps (stated, not hidden)

- **Dispatch inputs are not exposed by the Actions API.** `dispatchInputs`, `selectedTests`, `executedTests`,
  `unexecutedTests` remain `null` with `derived:false` and a reason. The title rail is the honest substitute for the
  two gates whose selection is input-only; it is a workflow-authored, API-visible value, not the input itself.
- **`run-name` did not exist before this change**, so no historical run can satisfy the CI/Browser title rails. The
  alpha.17 wave is therefore refused for those two gates (measured, §3.3) — that is the rail working, and it is why the
  alpha.18 wave must be dispatched after the commit.
- **Nine gates have no pinned-oracle content binding** because their producers write no pinned member into a consumed
  artifact. Adding one is a workflow change that should be done with the producer, not faked in the manifest.
- **Third-party evidence has no `release-evidence.json` member**, so that gate cannot carry a content contract
  (kind/tier/headSha) without a workflow change; it is bound by job-set selection + artifact digest + freshness today.
- **Same-run different-attempt artifacts** are only caught by the embedded head SHA/tier checks; `workflow_run.id` is
  the same for every attempt of a run, so freshness cannot separate attempts (recorded alpha.17 residual, unchanged).
- The full 13/13 PASS at the alpha.18 candidate is UNEXECUTED here and belongs to the release wave; this document
  records the real accepted single gate, the real narrowed refusal and the real historical-wave refusals instead.
- **The `release.yml` emission step has not been executed inside Actions.** It is a thin wrapper over the exact
  command proven locally in §3.1 and over the same verifier the alpha.17 publish run `42394884973` already ran. It needs
  no `jq`, no extra secret (`GITHUB_TOKEN` is the token the adjacent body step already uses) and its upload paths are
  `${{ runner.temp }}/release-evidence.{json,md}`, which the emitter writes before the upload step. A dispatch rehearsal
  exercises everything except the final upload; the Lead should rehearse once before tagging.
- The publish job runs the verifier twice (once in the existing body step, once for the evidence document): roughly
  ~35 extra GitHub API calls against a 1,000/hour workflow-token budget per repository, which is comfortable but is
  stated here so a future rate-limit failure is diagnosable rather than mysterious.

## 9. Files changed this round

- `docs/release-manifest.json` — `pinnedSha` + the rails in §1 (policy change, applied).
- `.github/workflows/ci.yml`, `.github/workflows/browser-differential.yml` — `run-name` from the dispatch input.
- `.github/workflows/release.yml` — fail-closed unified-evidence step, checkout==tag-target assertion, artifact upload.
- `scripts/release-governance.test.mjs` — 4 new teeth cases (83 → 87).
- `docs/alpha18/evidence-contract.md` (this file) + `docs/alpha18/release-evidence-docker-smoke.json` (real sample).
