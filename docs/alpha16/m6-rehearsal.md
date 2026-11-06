# M6 release rehearsal — alpha.16 candidate `9f6a76e`

**Status: REHEARSAL RECORD, IN PROGRESS. No dispatch was made for this document and no git action was run.**
The 13 required-gate dispatches were made by the Lead at one candidate; this file records what was dispatched,
what each gate must prove, and how the result is read. **Every gate verdict in this file is `PENDING`.** A run
that has concluded is not a verdict: a verdict is the release verifier's rail outcome (event + conclusion +
required job + artifact + embedded evidence) for that candidate, and it is recorded here only after the
verifier reads it. No conclusion is copied from a summary line.

Candidate: `main@9f6a76e` (the lane's current head at dispatch time).
Policy: `docs/release-manifest.json` (13 required workflows, `sameShaRequired: true`). Published evidence is
the same-commit table the publish job appends; this file is the rehearsal's working record, not evidence.

## 1. Method

1. Dispatch every workflow in `docs/release-manifest.json` as `workflow_dispatch` **at the candidate commit**,
   with the full selection that gate names (an empty/narrowed input is a narrowed run and cannot carry a
   release claim).
2. Evaluate the candidate with the same program the publish job runs:
   `scripts/verify-release-gates.mjs` — never with a hand-written checklist.
3. Only a verifier `PASS` with the full 13-row table, plus the checksums and notes checks below, may feed the
   publish path. The publish path is tag-gated (`release.yml`'s publish job) and a dispatch dry run never
   publishes.

## 2. The 13 dispatch rows

`Expected artifact / evidence` is what `docs/release-manifest.json` requires for the gate; all 13 require
`requiredEvent: workflow_dispatch`, `head_sha` = the candidate and conclusion `success`, and rows with a
required job additionally require that job completed/success in the cited run.

| # | workflow | run id | dispatched selection | required job | required artifact | embedded evidence contract | verdict |
|---|---|---|---|---|---|---|---|
| 1 | GoTavern CI | **42237652240** | `probes` empty → full oracle sweep | changes, oracle, browser-evidence, verify, crash-gate, race | — | — | **PENDING** |
| 2 | GoTavern whole-session differential | **42237657487** | — | — | — | — | **PENDING** |
| 3 | GoTavern world-info slot ordering | **42237662677** | — | — | — | — | **PENDING** |
| 4 | GoTavern drop-in qualification | **42237667805** | — | — | — | — | **PENDING** |
| 5 | Browser differential | **42237672610** | `mode=all` | — | — | — | **PENDING** |
| 6 | GoTavern release qualification | **42237676939** | — | — | — | — | **PENDING** |
| 7 | GoTavern smoke metrics | **42237682002** | `requests=50` | measure-linux-amd64, paired-linux-amd64 | — | — | **PENDING** |
| 8 | GoTavern Docker image | **42237686752** | — | — | — | — | **PENDING** |
| 9 | Helper state differential | **42237692314** | — | — | — | — | **PENDING** |
| 10 | Combination journey differential | **42237697117** | `profile=e03e04`, `tier=full` (extension tier follows) | `combination-journey` | `combination-journey-evidence` | kind `combination-journey-evidence`; `tier` = `full`; truthy `interactingScenario`, `ok`, `legs.allRecorded`, `teeth.ok`, `kit.ok`; 64-hex `documents.go-drive.sha256`, `documents.pinned-drive.sha256`, `documents.go-restart.sha256`, `documents.pinned-restart.sha256`, `documents.pinned-handback.sha256` | **PENDING** |
| 11 | Third-party extension compatibility | **42237701919** | `mode=full` | — | `extension-compat-evidence` | — | **PENDING** |
| 12 | GoTavern long-lived corpus qualification | **42237707075** | `size=medium` | `medium-corpus` | `longlived-medium-evidence` | kind `gotavern-longlived-corpus-evidence`; `size` = `medium`; truthy `ok`, `comparatorTeeth.ok`; 64-hex `pinnedExtensions.manifestSha256`, `corpus.treeSha256` | **PENDING** |
| 13 | GoTavern Node stock tree round trip | **42237711904** | — | `node-stock-tree` | `node-stock-tree-evidence` | kind `gotavern-node-stock-tree-evidence`; truthy `ok`, `roundTripOk`; 64-hex `treeSha256`, `manifestSha256` | **PENDING** |

**Snapshot at 2026-11-06T15:05Z (not a verdict):** 5 runs `completed/success` (world-info slot ordering,
release qualification, Docker, long-lived, Node stock tree), 6 `in_progress` (CI, whole-session, drop-in,
smoke, helper state, third-party), 2 `queued` (browser differential, combination journey). The snapshot is a
queue observation only; the `PENDING` column does not change because a run concluded — it changes when the
verifier has read the row, the required job and the embedded evidence.

**Gate #11's platform limitation (task-40).** The first rehearsal dispatch (`GoTavern third-party extension
compatibility` run `42247719306`, `mode=full`) had every meaningful job green except the cross-platform
`os: macos-14` / `platform: macos-arm64` leg, job `127994821648`, cancelled with zero steps and no runner
(annotation: `The configuration 'macos-14-arm64-us-default' is not supported`). That cancelled job made the run
conclusion `cancelled`, so gate #11 could not be green. The workflow now removes that leg, records the limitation
in `macos-arm64-recorded-limitation` (marker carried inside `extension-compat-evidence` by the aggregate job), and
the aggregate refuses a missing or inconsistent record. The row above is therefore expected to be green on the
re-dispatch at the frozen candidate, with the two remaining legs (`windows-amd64`, `macos-amd64`) as the
cross-platform evidence; its verdict stays `PENDING` until the verifier reads the new run.

## 3. The verifier command and the expected output

The publish job runs this exact program (`release.yml`'s publish step; the curated-note path reaches it
through `scripts/assemble-release-body.mjs`). Run it locally against the GitHub API with a token that can read
Actions metadata and artifacts:

```bash
GITHUB_REPOSITORY=cocokoishi/GoTavern \
GITHUB_TOKEN="$(gh auth token)" \
node scripts/verify-release-gates.mjs \
  --sha "$(git rev-parse 9f6a76e)" \
  --manifest docs/release-manifest.json \
  --evidence-out /tmp/alpha16-gate-evidence.md
```

Expected on success: exit 0, a markdown table with one row per required workflow (run id, event, status,
conclusion, required jobs, artifact+evidence, verdict `success`), the final line

```
**PASS**: 13/13 required workflow(s) are green at this SHA.
```

and a second line `wrote same-SHA qualification evidence to /tmp/alpha16-gate-evidence.md`; the written file is
the evidence section the publish job appends to the release body. Expected on failure: exit 1, a `**FAIL**`
block naming every refusal, and no evidence file written (the verifier writes nothing for a failing verdict).

Refusal names a row can show, each from `scripts/release-governance/gates.mjs`: `missing` (no run of that
workflow at the candidate SHA with the required event), `not-green`, `missing-jobs` / `missing-job` /
`job-not-green` (a skipped required job is not green), `missing-artifact` (absent or expired),
`missing-evidence` (no readable `release-evidence.json` inside the artifact), `evidence-mismatch` (wrong kind,
schema, embedded head SHA not the candidate, wrong tier marker, a required truthy field not exactly true, or a
digest that is not lowercase 64-hex).

## 4. Notes, checksums and the dispatch dry run

After the gate verdict is PASS, the remaining release-rehearsal steps (each `PENDING` until run):

1. **Notes validation.** `node scripts/verify-release-notes.mjs docs/release-notes-v0.1.0-alpha.16.md
   v0.1.0-alpha.16 --checksums dist/checksums.txt` — the same check the prepublish job runs (`release.yml`).
   Expected: `release notes OK: …` and `0 cited digest(s) checked against 6 asset(s)` (the note cites no asset
   digest, so membership has nothing to fail on; a cited digest must match the checksums file or it is
   refused).
2. **Checksums.** `bash scripts/release-assemble-checksums.sh dist` — validates the six canonical archives and
   writes `dist/checksums.txt`; expected six entries.
3. **Dispatch dry run.** `gh workflow run release.yml --ref main -f ref="$(git rev-parse 9f6a76e)"
   -f candidate_version=v0.1.0-alpha.16` — builds the six archives, runs the cross-platform jobs the runner
   platform supports, classifies `candidate_version`, validates notes and feeds the bare installers through
   `scripts/qualify-prepublish.sh`. A dispatch never publishes (`release.yml` publish is tag-gated).
   **The 2026-11-06 attempt was cancelled at the darwin/arm64 step:** `GoTavern Release` run `42242191281`
   (ref `a54db37`, `candidate_version=v0.1.0-alpha.16`) built and archive-inspected all six archives and ran
   `execute-darwin-amd64`, `execute-linux-arm64`, `windows-arm64-boundary` and `prepublish-qualification` green,
   then `execute-darwin-arm64` (labels `macos-14`, `timeout-minutes: 20`) was **cancelled after 54 s** with
   **zero steps**, **no assigned runner**, and the check-run annotation `The configuration
   'macos-14-arm64-us-default' is not supported`; `publish` was skipped because its dependency did not succeed,
   so the run ended cancelled. (An earlier dispatch at `9f6a76e`, run `42240357384`, failed in the build jobs'
   checkout and never reached the darwin/arm64 step.) The replacement job `darwin-arm64-recorded-downgrade` runs
   on `ubuntu-latest`, proves the archive is a thin arm64 Mach-O, records the limitation marker, and the publish
   job gates on that marker plus the notes limitation line. Expected on the re-dispatch: **all build jobs green,
   `execute-darwin-amd64` / `execute-linux-arm64` / `windows-arm64-boundary` green,
   `darwin-arm64-recorded-downgrade` green (not cancelled), `prepublish-qualification` green, and `publish`
   green with its tag-only steps skipped and no release created**, with the `darwin-arm64-platform-limitation`
   artifact present. `PENDING` until read.
4. **Verifier on the dry run's artifacts.** The verifier above is the same one; its `PASS` is the gate result
   this rehearsal records. `PENDING`.
5. **Post-publication checks** (installer smoke over TLS, published-extension journey, container pull-back,
   checksums re-verified from the public endpoint) are outside this rehearsal record; they are `PENDING` by
   construction and are the release body's evidence section plus the post-release workflows.

## 5. Local validations already completed (not gate verdicts)

- **Notes verifier dry run** on the committed note with no checksums file: exit 0, `release notes OK` (well above
  the 1,500-byte minimum), observation `no checksums.txt supplied: digest membership was not checked`.
- **Notes verifier with a synthetic placeholder checksums file** (six canonical asset names, sha256 of
  placeholder payloads, no release build): exit 0, `0 cited digest(s) checked against 6 asset(s)`.
- **Planted negative control for the notes digest rule:** a temporary copy citing a repeated 64-hex value was
  refused (`cite a degenerate 64-hex value … which is an example checksum, not a digest`), so the digest path
  is live and not vacuous.
- **Classifier table test:** `scripts/test-classify-version-tag.sh` passes 64 cases after the alpha.16
  graduation; direct checks return `stable` for `v0.1.0-alpha.16` and `prerelease` for `v0.1.0-alpha.160`,
  `v0.1.0-alpha.16-rc1` and `v0.1.0-alpha.17`.
- **darwin/arm64 recorded-downgrade gate:** `node scripts/release-governance/darwin-arm64-qualification.mjs
  --self-test` holds 11/11 planted cases (missing marker, unknown mode, recorded downgrade without the notes
  limitation line, downgrade without the arm64 Mach-O proof, downgrade with no platform evidence, a
  recorded-downgrade marker claiming execution, an archive-sha mismatch, an executed marker without execution
  evidence, and both positive controls).
- **darwin/arm64 inspection, locally on a synthetic archive:** a tar.gz whose `gotavern` carries a real arm64
  Mach-O header (`0xfeedfacf` / `0x0100000c`) plus the contract members was inspected: exit 0, marker written
  with the archive sha256 and the Mach-O/build-info proof; `verify` against the committed note's limitation
  line: exit 0; a note without the line, a missing marker, and an x86_64-header archive were each refused by
  name (`notes-limitation-missing`, `missing-marker`, `mach-o-not-arm64`). The tar executable-bit assertion is
  enforced on the Linux runner; this Windows host cannot represent Unix mode bits on disk, so the local run
  records that limitation instead of manufacturing a red.
- **Release governance suite:** `node --test scripts/release-governance.test.mjs` passes 69/69, including the
  darwin/arm64 refusal/wiring cases, the third-party macos/arm64 refusal/wiring cases, and both planted-cases
  cases.
- **Publish-gate step simulation:** the publish job's marker step was extracted from `release.yml`, evaluated
  with `workflow_dispatch` and the candidate version substituted, and run locally against the synthetic
  marker/archive and the committed note: exit 0. With the marker removed it refuses with
  `::error::missing-marker` (exit 1). The tag-only note-from-`origin/main` branch of that step was not
  exercised locally (it needs a tag checkout) and stays `PENDING` for the dry run.
- **Third-party limitation record:** `node scripts/release-governance/macos-arm64-limitation.mjs --self-test`
  holds 8/8 planted cases (missing marker, invalid JSON, arm64 leg still claimed, missing cross-platform leg,
  execution claimed without evidence, workflow still declaring the leg, missing limitation job, and the valid
  control). `record` against the real workflow exits 0 and writes a marker with
  `matrix.crossPlatformPresent = [windows-amd64, macos-amd64]`, `matrix.removed = [macos-arm64]`,
  `matrix.arm64LegPresent = false`, three recorded cancelled attempts (run/job/annotation), and
  `execution.performed = false`; `verify` exits 0 and writes the published record into the evidence directory.
  An aggregate-step simulation of the verify block passes with the marker and refuses with
  `::error::missing-marker` (exit 1) without it.
- **third-party-extension-compat.yml sanity:** YAML parses; the cross-platform matrix is exactly
  `windows-amd64` + `macos-amd64` (no `os: macos-14` / `platform: macos-arm64` leg); the
  `macos-arm64-recorded-limitation` job exists and uploads the fixed-name artifact; `aggregate.needs` includes
  it and its verify step writes the record into `$RUNNER_TEMP/ext-compat/evidence/`; no `continue-on-error` key
  is added.
- **release.yml sanity:** YAML parses; the job list is `build`, `execute-linux-arm64`, `execute-darwin-amd64`,
  `darwin-arm64-recorded-downgrade`, `windows-arm64-boundary`, `prepublish-qualification`, `publish`,
  `post-release-facts`; `publish.needs` includes `darwin-arm64-recorded-downgrade`; no `execute-darwin-arm64`
  job remains; the new run blocks pass `bash -n`; no `continue-on-error` key is added; the prepublish and
  publish artifact downloads use `pattern: gotavern-*`, so the platform-limitation marker artifact cannot leak
  into `dist` beside the six canonical archives.

## 6. What remains blocked on run completion

- Every verdict in §2 is **PENDING** until the verifier reads the row. The blockers are the queue (the two
  long browser/gate runs and the long-lived and CI runs), not a judgement about the candidate.
- The curated-note path additionally needs the publish dry run's `dist/checksums.txt` and the notes check
  (§4); neither exists until that run builds the archives.
- `darwin/arm64` is no longer an execution job: the recorded-downgrade job must come back green and its
  `darwin-arm64-platform-limitation` marker must pass the publish gate together with the notes limitation line.
  `PENDING` until the re-dispatched dry run is read. If the platform ever provides an arm64 macOS runner, the
  job is restored to execution mode and the gate then requires execution evidence
  (`docs/release-governance.md` §4); no claim of darwin/arm64 runtime qualification exists until then.
- Gate #11 (`Third-party extension compatibility`) is no longer blocked by the cancelled arm64 leg: the
  re-dispatched run must be `completed/success` with `macos-arm64-recorded-limitation` and `aggregate` green,
  and the `extension-compat-evidence` artifact must contain `macos-arm64-platform-limitation.json`. `PENDING`
  until the new run is read; if the marker or the aggregate check is missing, the aggregate job fails by name.
- The soak row (`M5 measurements`) is **not** one of the 13 required gates and is not part of this rehearsal's
  pass condition; its corrected statistic and the real-leak question are recorded in
  `docs/alpha16/m5-evidence.md` and the release notes' Known limitations.

## 7. How this record becomes final

When the verifier has run against the candidate and the publish dry run has been read, this file is updated
row by row: each `PENDING` is replaced by the verifier verdict and the run id it cited, `PASS 13/13` is quoted
verbatim, and the evidence file path is recorded. Until that edit, this record must not be cited as evidence
that any gate passed — the published body's appended table is the evidence, and it is written only by the
publish path itself.
