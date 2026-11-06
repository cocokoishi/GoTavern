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
   -f candidate_version=v0.1.0-alpha.16` — builds the six archives, runs the cross-platform execution jobs the
   runner platform supports, classifies `candidate_version`, validates notes and feeds the bare installers
   through `scripts/qualify-prepublish.sh`. A dispatch never publishes (`release.yml` publish is tag-gated).
   Expected: run `completed/success` with the publish job skipped by design; `PENDING` until observed.
4. **Verifier on the dry run's artifacts.** The verifier above is the same one; its `PASS` is the gate result
   this rehearsal records. `PENDING`.
5. **Post-publication checks** (installer smoke over TLS, published-extension journey, container pull-back,
   checksums re-verified from the public endpoint) are outside this rehearsal record; they are `PENDING` by
   construction and are the release body's evidence section plus the post-release workflows.

## 5. Local validations already completed (not gate verdicts)

- **Notes verifier dry run** on the committed note with no checksums file: exit 0, `release notes OK`, 22,699
  bytes, observation `no checksums.txt supplied: digest membership was not checked`.
- **Notes verifier with a synthetic placeholder checksums file** (six canonical asset names, sha256 of
  placeholder payloads, no release build): exit 0, `0 cited digest(s) checked against 6 asset(s)`.
- **Planted negative control for the notes digest rule:** a temporary copy citing a repeated 64-hex value was
  refused (`cite a degenerate 64-hex value … which is an example checksum, not a digest`), so the digest path
  is live and not vacuous.
- **Classifier table test:** `scripts/test-classify-version-tag.sh` passes 64 cases after the alpha.16
  graduation; direct checks return `stable` for `v0.1.0-alpha.16` and `prerelease` for `v0.1.0-alpha.160`,
  `v0.1.0-alpha.16-rc1` and `v0.1.0-alpha.17`.

## 6. What remains blocked on run completion

- Every verdict in §2 is **PENDING** until the verifier reads the row. The blockers are the queue (the two
  long browser/gate runs and the long-lived and CI runs), not a judgement about the candidate.
- The curated-note path additionally needs the publish dry run's `dist/checksums.txt` and the notes check
  (§4); neither exists until that run builds the archives.
- The `darwin/arm64` execution job is blocked by the runner platform (it has been reported unsupported and
  cancelled on this repository; recorded at alpha.15). The publish job depends on that execution job, so this
  is a known publish-path blocker for this candidate as well; the release body records it and the target stays
  built + archive-inspected, not executed.
- The soak row (`M5 measurements`) is **not** one of the 13 required gates and is not part of this rehearsal's
  pass condition; its corrected statistic and the real-leak question are recorded in
  `docs/alpha16/m5-evidence.md` and the release notes' Known limitations.

## 7. How this record becomes final

When the verifier has run against the candidate and the publish dry run has been read, this file is updated
row by row: each `PENDING` is replaced by the verifier verdict and the run id it cited, `PASS 13/13` is quoted
verbatim, and the evidence file path is recorded. Until that edit, this record must not be cited as evidence
that any gate passed — the published body's appended table is the evidence, and it is written only by the
publish path itself.
