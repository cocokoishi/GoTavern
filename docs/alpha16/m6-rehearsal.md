# M6 release rehearsal - alpha.16 candidate `6e96959`

**Status: COMPLETE. The rehearsal result is a verifier `PASS`, and the release bar is MET at this
candidate within the synthetic adversarial-qualification scope.** This file is the rehearsal's working
record; the machine evidence is the same-commit table in `docs/alpha16/same-sha-evidence.md` (the output
of `scripts/verify-release-gates.mjs`) and the publish job's own re-run of the same program on a tag.
No alpha.16 tag was created or moved and no release was published during this rehearsal - the program
stopped at qualification.

Candidate: `main@6e96959`. Short form is used because the repository's document gate refuses a
forty-character commit that is not the pinned one; the verifier resolves the short form through the
runs API and the recorded table names every run.

Policy: `docs/release-manifest.json` (13 required workflows, `sameShaRequired: true`, per-gate required
jobs/artifacts/embedded-evidence rails).

## 1. Method

1. Freeze the candidate commit and dispatch every workflow in `docs/release-manifest.json` as
   `workflow_dispatch` **at that commit**, with the full selection each gate names. An empty or narrowed
   input is a narrowed run and cannot carry a release claim, so every row below records its selection.
2. Evaluate the candidate with the same program the publish job runs:
   `scripts/verify-release-gates.mjs` - never with a hand-written checklist. The recorded output is
   `docs/alpha16/same-sha-evidence.md`.
3. Only a verifier `PASS` with the full 13-row table may feed the publish path. The publish path is
   tag-gated (`release.yml`'s publish job) and a dispatch dry run never publishes.
4. Run the release dry run at the same candidate (`release.yml`, `ref` = the full candidate SHA,
   `candidate_version=v0.1.0-alpha.16`) to prove the archive build, the cross-platform execution legs,
   the darwin/arm64 recorded platform limitation and the publish gate against curated notes.

## 2. The 13 dispatch rows and their verdicts

`Required job` / `Required artifact` / `Embedded evidence` are what `docs/release-manifest.json`
requires for that gate; every row also requires `requiredEvent: workflow_dispatch`, `head_sha` = the
candidate and conclusion `success`.

| # | workflow | run id | dispatched selection | required job | required artifact | embedded evidence contract | verdict |
|---|---|---|---|---|---|---|---|
| 1 | GoTavern CI | 42294114075 | `probes` empty -> full oracle sweep | changes, oracle, browser-evidence, verify, crash-gate, race | - | - | **success** |
| 2 | GoTavern whole-session differential | 42294118964 | - | - | - | - | **success** |
| 3 | GoTavern world-info slot ordering | 42294123412 | - | - | - | - | **success** |
| 4 | GoTavern drop-in qualification | 42294127433 | - | - | - | - | **success** |
| 5 | Browser differential | 42294131712 | `mode=all` | - | - | - | **success** |
| 6 | GoTavern release qualification | 42294137094 | - | - | - | - | **success** |
| 7 | GoTavern smoke metrics | 42294141379 | `requests=50` | measure-linux-amd64, paired-linux-amd64 | - | - | **success** |
| 8 | GoTavern Docker image | 42294146024 | - | - | - | - | **success** |
| 9 | Helper state differential | 42294150962 | - | - | - | - | **success** |
| 10 | Combination journey differential | 42294155456 | `profile=e03e04`, `tier=full` (extension tier follows) | `combination-journey` | `combination-journey-evidence` | kind `combination-journey-evidence`; `tier` = `full`; truthy `interactingScenario`, `ok`, `legs.allRecorded`, `teeth.ok`, `kit.ok`; 64-hex digests of the five recorded documents | **success** |
| 11 | Third-party extension compatibility | 42294159806 | `mode=full` | - | `extension-compat-evidence` | the artifact carries `macos-arm64-platform-limitation.json` (kind `gotavern-macos-arm64-platform-limitation`, `matrix.arm64LegPresent:false`, the two remaining cross-platform legs, `execution.performed:false`); the aggregate refuses a missing/inconsistent record | **success** |
| 12 | GoTavern long-lived corpus qualification | 42294164369 | `size=medium` | `medium-corpus` | `longlived-medium-evidence` | kind `gotavern-longlived-corpus-evidence`; `size` = `medium`; truthy `ok`, `comparatorTeeth.ok`; 64-hex `pinnedExtensions.manifestSha256`, `corpus.treeSha256` | **success** |
| 13 | GoTavern Node stock tree round trip | 42294168373 | - | `node-stock-tree` | `node-stock-tree-evidence` | kind `gotavern-node-stock-tree-evidence`; truthy `ok`, `roundTripOk`; 64-hex `treeSha256`, `manifestSha256` | **success** |

**Verifier result:** `**PASS**: 13/13 required workflow(s) are green at this SHA.` (exit 0; full table in
`docs/alpha16/same-sha-evidence.md`).

### 2.1 Superseded dispatch waves

Two earlier waves were dispatched while the program was still landing changes (M3b chaos tests, the
darwin/arm64 recorded downgrade, the macos-arm64 extension-gate limitation, the M2m deterministic-swipe
fix, and the regenerated compatibility matrix). They are recorded here so the ids are not mistaken for
the final evidence: the first wave at `9f6a76e`/`a54db37` had 8 gates green before the candidate moved;
the second wave at `97e8cde` was superseded by the regenerate-compatibility-matrix commit because its
GoTavern CI verify job correctly refused a stale derived-count claim. Only the wave above is the
same-SHA evidence.

## 3. The release dry run at the same candidate

`GoTavern Release` run **42294172571** (workflow_dispatch, `ref` = the full candidate SHA,
`candidate_version=v0.1.0-alpha.16`) is **completed/success**:

- all six `build` jobs green: linux/amd64 and windows/amd64 executed and launcher-tested, linux/arm64
  and darwin/amd64 built and archive-inspected (darwin/amd64 also executed), darwin/arm64 built and
  archive-inspected, windows/arm64 built/archive-inspected only (no windows/arm64 hosted runner exists);
- `execute-linux-arm64`, `execute-darwin-amd64`, `windows-arm64-boundary` green;
- `darwin-arm64-recorded-downgrade` green, uploading the fixed-name artifact
  `darwin-arm64-platform-limitation` (mode `recorded-downgrade`, thin arm64 Mach-O proof, the recorded
  platform attempts, `execution.performed:false`);
- `prepublish-qualification` green;
- `publish` green with every tag-only step skipped: a dispatch dry run publishes nothing, and the
  repository's release listing was not changed;
- `post-release-facts` skipped (tag-only);
- artifacts present: the six canonical archives plus `darwin-arm64-platform-limitation`.

**Platform limitation (recorded, not hidden).** The macOS arm64 hosted runner is unavailable
platform-side: the job receives zero steps and no runner and the check-run annotation is
`The configuration 'macos-14-arm64-us-default' is not supported` (same annotation at alpha.15, while the
same job/label succeeded five times on 2026-11-05; the repository is public with zero self-hosted
runners). `release.yml` therefore replaces the pure-execution job with
`darwin-arm64-recorded-downgrade`, and `third-party-extension-compat.yml` replaces its macos-14 matrix
leg with `macos-arm64-recorded-limitation`. Both record a machine-readable limitation that the publish
gate and the extension aggregate refuse to omit; there is no `continue-on-error` anywhere. darwin/arm64
runtime execution and the macos-arm64 extension lifecycle remain **UNPROVEN** and the release notes say
so.

## 4. Notes, checksums and the dry-run boundary

- The curated notes `docs/release-notes-v0.1.0-alpha.16.md` exist at the candidate, classify as a
  graduated stable tag (`v0.1.0-alpha.16` in `GRADUATED_STABLE_TAGS`; classifier suite 64/64), carry the
  darwin/arm64 and macos-arm64 limitation lines the publish gate requires, and pass the notes verifier
  with no checksums and with a synthetic checksums file; a planted degenerate digest is refused.
- `dist/checksums.txt` is produced by the release build and checked by the publish job against the
  uploaded archives; a dry run builds and inspects the archives but does not publish, so the final
  checksum membership check is part of the tag run's publish path, not of this rehearsal.
- The publish gate was exercised end to end on the dry run: the job ran the limitation program's
  `--self-test`, resolved the curated notes exactly as the body step does, and verified the marker
  against the archive; a missing marker, missing note line or archive-sha mismatch refuses by name.

## 5. Local validations (not gate verdicts)

- `node scripts/release-governance/darwin-arm64-qualification.mjs --self-test` 11/11; the
  macos-arm64 limitation program's `--self-test` 8/8; `scripts/release-governance.test.mjs` 69/69;
  `scripts/test-classify-version-tag.sh` 64/64.
- `node tools/compat-matrix/check.mjs` green after the regenerate; `node tools/generate-doc-facts.mjs
  --check` current; the Go document gates green; the compatibility surface-coverage drift gate green
  (573 frontend surfaces, 422 Go registrations, 50/50 redirect aliases, 0 recorded open missing routes).
- `tests/browser/combination-journey-gate-selftest.mjs` 44/44 planted reds, including the new
  deterministic-swipe case.
- A local full `go test ./...` run on this Windows host failed only with ENOSPC ("There is not enough
  space on the disk") on a nearly-full host volume, which is a host artefact and not a test result; the
  Linux CI run 42294114075 is the gate and it is green.

## 6. Residual register (unchanged by the green rehearsal)

- GOAL.md section 14 real-private-tree claim: **NOT MET**; this is a synthetic adversarial qualification
  with a stated scope.
- darwin/arm64 runtime execution and the macos-arm64 extension lifecycle: **UNPROVEN** (recorded
  platform limitation; archives are proved to be thin arm64 Mach-O and build-contract-clean).
- Streaming-cancellation performance, real provider-relay p99, 20-extension page-load row, same-commit
  soak ratification and the 8-user AFTER row: see `docs/alpha16/m5-evidence.md`; the soak is green at
  this candidate under the corrected GC-robust rule and the 8-user AFTER is a fail-closed red under an
  unratified BEFORE x1.25 ceiling (reported as a repeatability finding, not a product regression).
- Real kernel ENOSPC remains UNPROVEN by policy; the ENOSPC/EFBIG non-conflation is proved by named
  tests and mutations in `docs/alpha16/m3-chaos-evidence.md`.
- No tag was created or moved and no release was published; publishing remains a separate, explicit
  action that the tag-gated publish job must pass with this same verifier.

## 7. How this record becomes the release evidence

The publish job runs `scripts/verify-release-gates.mjs` against the exact tag target and appends the
same-commit table to the release; this file and `docs/alpha16/same-sha-evidence.md` are the rehearsal's
record of the same program's output at the frozen candidate. If the tag target differs by even one
commit, the verifier refuses (it requires `head_sha` equal to the target), which is the fail-closed
property this rehearsal exists to prove.
