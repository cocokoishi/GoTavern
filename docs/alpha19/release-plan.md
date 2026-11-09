# alpha.19 release plan (Lead-owned, executable)

This is the operational sequence for turning the gated candidate into `v0.1.0-alpha.19`. It is written before the
candidate exists so the release cannot be improvised, and every command in it is one this repository already uses.

## 0. Preconditions (all must be true)

- [ ] The branch `alpha19/program` has the final product, tests, docs and evidence; `git status` clean.
- [ ] `go build ./...`, `go vet ./...`, `node --test scripts/release-governance.test.mjs`,
      `node scripts/verify-a19-evidence.mjs --self-test`, `node tools/generate-doc-facts.mjs --check`,
      `node tools/check-perf-docs.mjs`, and the pin gate (`go test ./internal/fixtures -run
      TestPinnedCommitStringsMatchThePin -count=1`) are green locally (Layer A; CI is still the gate).
- [ ] The live real-UI oracle has run locally against the finalized corpus (B's `a19-live-oracle.mjs
      --corpus-origin ui --mode all`) and produced a `release-evidence.json` that
      `scripts/verify-a19-evidence.mjs` accepts; the corpus digest and created counts are recorded in
      `docs/alpha19/oracle/`.
- [ ] The pinned SillyTavern checkout still matches `docs/alpha19/oracle-pin.sha256`
      (`git status --porcelain` empty and the digest verifies).
- [ ] `docs/release-notes-v0.1.0-alpha.19.md` exists, is curated (no run ids), and passes
      `validateReleaseNotes`; `scripts/classify-version-tag.sh v0.1.0-alpha.19` returns `stable` because the
      graduation constant and its test are in the release commit (decision D-11).

## 1. Land on `main` as ONE squash commit (decision D-10)

Branch history is retained for provenance; `main` receives one record commit whose tree is the gated candidate.

```bash
git switch alpha19/program
git log --oneline 52883e8..HEAD            # review the record
git switch main
git merge --squash alpha19/program
git commit -F <message-file>               # the alpha.19 record; names the branch, the gates and the evidence
git push origin main
CANDIDATE="$(git rev-parse HEAD)"
```

`CANDIDATE` MUST be the SHA every gate run and the tag target name. There is no force-push and no history rewrite
of `alpha19/program`.

## 2. Local pre-flight at `CANDIDATE`

```bash
go build ./... && go vet ./...
go test ./internal/server -count=1
go test ./internal/fixtures -count=1
node --test scripts/release-governance.test.mjs
node scripts/verify-a19-evidence.mjs --self-test
node tools/generate-doc-facts.mjs --check
node tools/check-perf-docs.mjs
```

Any red stops the wave: fix on a new commit, re-run the squash landing, and use the NEW candidate SHA.

## 3. Dispatch the fourteen required gates at `CANDIDATE`

All dispatches use `--ref main` so the workflow file comes from the candidate tree and the run's `head_sha` is
`CANDIDATE`. The selections are the ones `docs/release-manifest.json` requires; a narrowed dispatch is refused.

```bash
gh workflow run ci.yml                     --ref main -f probes=            # run-name must say probes=full
gh workflow run whole-session.yml          --ref main
gh workflow run worldinfo-slots.yml        --ref main
gh workflow run dropin-qualification.yml   --ref main
gh workflow run browser-differential.yml   --ref main -f mode=all          # run-name must say mode=all
gh workflow run release-qualification.yml  --ref main
gh workflow run smoke-metrics.yml          --ref main
gh workflow run docker.yml                 --ref main
gh workflow run helper-state.yml           --ref main
gh workflow run combination-journey.yml    --ref main
gh workflow run third-party-extension-compat.yml --ref main
gh workflow run longlived.yml              --ref main -f size=medium
gh workflow run node-stock-tree.yml        --ref main
gh workflow run real-ui-oracle.yml         --ref main -f mode=all          # NEW in alpha.19
```

Record each `workflow name + run id + conclusion` as it completes. A run that is green but has a required job
SKIPPED is not green (the verifier enforces `requiredJobs`).

## 4. Verify the wave (the same command the publish job runs)

```bash
export GITHUB_REPOSITORY=cocokoishi/GoTavern
export GH_TOKEN="$(gh auth token)"
node scripts/verify-release-gates.mjs --sha "$CANDIDATE" \
  --manifest docs/release-manifest.json \
  --evidence-out "$RUNNER_TEMP/same-sha-evidence.md" \
  --release-evidence-out "$RUNNER_TEMP/release-evidence.json"
```

Exit 0 required; the printed table must say `PASS: 14/14 required workflow(s) are green at this SHA`. The new
gate's row must show its artifact and evidence kind; a stale/foreign/narrowed/generated artifact is refused by the
rails, not by a human reading the table.

## 5. Tag and publish (only after §4 PASS)

```bash
git tag -a v0.1.0-alpha.19 -m "GoTavern v0.1.0-alpha.19"
git push origin v0.1.0-alpha.19          # triggers GoTavern Release at the tag target
```

The tag MUST be annotated and MUST peel to `CANDIDATE`. `GoTavern Release` reapplies the verifier, builds the six
archives + `checksums.txt`, appends the same-SHA table to the body, and creates the release. If the publish job
refuses, publish is NOT improvised past the verifier: diagnose, fix, and produce a new candidate.

## 6. Post-publication verification (independent of the release run)

```bash
gh release view v0.1.0-alpha.19 --json tagName,targetCommitish,assets,isDraft,isPrerelease,isLatest
gh release download v0.1.0-alpha.19 --pattern 'checksums.txt'
gh release download v0.1.0-alpha.19 --pattern 'gotavern-linux-amd64.tar.gz'
sha256sum -c checksums.txt                # or the Windows equivalent for the Windows asset
tar -xzf gotavern-linux-amd64.tar.gz && ./gotavern version   # 0.1.0-alpha.19 + baseline 1.19.0 (06bde939...)
```

Then run the installer smoke and the published-binary journey exactly as `docs/INSTALLATION.md` documents. Record:
Release URL, tag object, tag target SHA, asset names, checksums, the published binary's `version` output, and the
historical tags' unchanged SHAs (`v0.1.0-alpha.18` must still peel to `a417721...`).

## 7. Failure handling during the wave

For every red: classify as **product / pinned-oracle / harness-driver / CI-environment**, quote the failing
assertion and the run id, fix the true root cause, and re-run the ENTIRE wave at a NEW candidate SHA. Never skip a
job, lower an assertion, re-record an oracle, widen an ignore list, or cite a run at another SHA. The release
manifest's required jobs and artifact rails are the contract; a change to them is a policy commit with its reason.

## 8. Evidence to record (in `docs/alpha19/`)

- `same-sha-evidence.md`: the verifier table, all 14 run ids, candidate SHA, pinned SHA, selection proofs.
- `release-evidence.md`: the release URL/tag/assets/checksums, the published binary run, the post-publication
  checks, and the historical tags' SHAs.
- `handoff-ledger.md`: what shipped, what was found/fixed, what remains unproven (`GOAL.md` §14 status).
- Updates to `docs/goal-scorecard.md` (the only external ledger) and `HANDOFF.md` (latest checkpoint).
- The final report sections A–G the user's prompt requires.
