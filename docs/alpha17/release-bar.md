# alpha.17 release bar — the checkable form of `GOAL.md` §16

**Status: DRAFT (policy for `v0.1.0-alpha.17`).** This file is the release contract for this round. It is
written as a list of measurements so that "the release is ready" is a result, not an opinion. It may only
become `EXECUTED` when every row below is a real, cited run at one candidate SHA; a row that is cancelled,
skipped, narrowed, missing or in-progress is a refusal.

**Version discipline.** `v0.1.0-alpha.16` is published and its tag object `b7d81cd1296e842d79997ea70c49dabeed04da31`
peeling to `c1886d70db0342e09c6fdd3225909cae900c15c9` must not be re-created, moved, overwritten or deleted.
`v0.1.0-alpha.17` is a **stable-channel** release (`draft=false`, `prerelease=false`, `latest=true`).

## 1. Required gates (same SHA, deliberate dispatch)

Every gate below must be a `completed`/`success` **`workflow_dispatch`** run whose `head_sha` equals the
tag target commit. The manifest `docs/release-manifest.json` is the policy; the verifier
`scripts/verify-release-gates.mjs` is the machine that runs inside the publish job before
`gh release create`, and it fails closed.

| # | workflow | required jobs / artifact rails | narrowed-dispatch refusal |
|---|---|---|---|
| 1 | GoTavern CI | `verify`, `race`, oracle full-sweep job, browser-evidence, changes | dispatch with an empty `probes` input; a push run is refused by event |
| 2 | GoTavern whole-session differential | all jobs | dispatch |
| 3 | GoTavern world-info slot ordering | all jobs | dispatch |
| 4 | GoTavern drop-in qualification | Linux and Windows packaged-archive jobs | dispatch |
| 5 | Browser differential | `mode=all` legs | dispatch + all-mode selection |
| 6 | GoTavern release qualification | archive build, extraction, boot, update/rollback | dispatch |
| 7 | GoTavern smoke metrics | paired benchmark + soak job | dispatch; `requests=50` |
| 8 | GoTavern Docker image | build, push, pull-back verification | dispatch |
| 9 | Helper state differential | 30-guard judge job | dispatch |
| 10 | Combination journey differential | `combination-journey` job + `combination-journey-evidence` artifact (`profile=e03e04`, `tier=full`, head SHA, five leg digests) | dispatch + `profile=e03e04 -f tier=full -f extension_tier=full`; a `profile=none` run is refused |
| 11 | Third-party extension compatibility | `mode=full`, 20-extension aggregator + `extension-compat-evidence` artifact | dispatch + `mode=full`; a shard-skipped run is refused |
| 12 | GoTavern long-lived corpus qualification | `medium-corpus` job + `longlived-medium-evidence` artifact (`size=medium`, head SHA, corpus tree digest, 20-extension manifest digest) | dispatch + `size=medium`; a default `small` dispatch that leaves `medium-corpus` **skipped** is refused |
| 13 | GoTavern Node stock tree round trip | `node-stock-tree` job + `node-stock-tree-evidence` artifact (head SHA, tree/manifest digests) | dispatch (the workflow also uploads on push, so the event rail is load-bearing) |

`GoTavern Release` is not its own precondition: the publish run supplies its own build and
`prepublish-qualification` at the tag commit. The dry run must have been green at the candidate before the
tag is created.

## 2. Evidence contract (machine-checkable)

Each gate row in the release evidence document must carry: `schemaVersion`, `kind`, `workflow`, `headSha`,
`pinnedSha` (`06bde939…`), `event`, the dispatch selection that was actually proved (job set and/or embedded
tier marker), the artifact name and its digest(s), the embedded evidence fields the manifest requires, and
an overall result. A field that cannot be derived from the Actions API is recorded `null` with
`derived:false` and the reason. It is never invented. The verifier must refuse, by name: a wrong SHA, a
wrong event, a skipped required job, a missing/expired artifact, a missing or mismatched embedded `kind`/
`tier`/head SHA/truthy field/64-hex digest, a narrowed selection, and a stale artifact from an older
attempt. `docs/alpha17/evidence-contract.md` carries the contract, its negative tests and the real alpha.16
wave validation.

## 3. Non-gate evidence that must also be at the same commit

1. **Performance evidence.** `GoTavern smoke metrics` green at the tag commit; the README table and the
   dark/light figure are generated from the recorded artifact whose `provenance.commit` is the code-complete
   commit the release descends from (the artifact cannot name the commit that contains it), and the
   performance-documentation checker (`tools/check-perf-docs.mjs`) is green in `GoTavern CI`.
2. **README/documentation.** README 10–14 KB, no stale release text, internal links resolve, performance
   numbers trace to the artifact, figure has alt text/dark-light parity/contrast and minimum font size;
   detailed methodology lives in `docs/performance.md`.
3. **M0/M1/M2/M3/M4/M6 records.** `docs/alpha17/source-audit.md`, `ownership-map.json`, `source-graph.json`,
   `defect-reconfirmation.md`, `niche-scenario-catalog.md`, `test-gap-matrix.md`, `new-test-evidence.md`,
   `architecture-decisions.md`, `performance-plan.md`, `perf/`, `perf-hotspot.md` all present, with
   `DRAFT`/`PROPOSED` upgraded only where work executed and every unexecuted item labelled.
4. **Classifier.** `scripts/classify-version-tag.sh` classifies `v0.1.0-alpha.17` **stable**; its equality
   list gains the tag in the same change; `scripts/test-classify-version-tag.sh` proves the new tag stable and
   every version-shaped neighbour (`v0.1.0-alpha.16`, `v0.1.0-alpha.170`, `v0.1.0-alpha.17-rc1`,
   `v0.1.0-alpha.16+build.1`, `v0.1.0-alpha.150`, …) still prerelease.
5. **Release notes.** `docs/release-notes-v0.1.0-alpha.17.md` is checked by the publish path's note
   validator: it names its own tag, contains no drafting token, no unfilled placeholder, no too-short run id,
   no 64-hex digest that does not equal an entry in this run's `checksums.txt`, and no claim ahead of a gate.
   It carries `## Known limitations` and `## Checksums`/`## Artifacts`, and states `GOAL.md` §14 **NOT MET**.
6. **Generated facts.** `node tools/generate-doc-facts.mjs --check` and
   `node tools/generate-coverage-matrix.mjs --check` green at the candidate after the new tests land.

## 4. Publication and post-publication verification

1. Tag `v0.1.0-alpha.17` is annotated, is created **after** the 13-gate wave PASS, and is not moved.
2. `GoTavern Release` (tag push) is `completed`/`success`; `publish` created the Release with
   `draft=false`, `prerelease=false`, `latest=true`; the body carries the same-SHA evidence table generated
   at publish time.
3. Six canonical archives plus `checksums.txt` are attached; every asset digest matches the release's own
   `checksums.txt` when downloaded again; the published binary's `version --json` names
   `v0.1.0-alpha.17`, `sillytavern_version: 1.19.0`, `sillytavern_commit: 06bde939…`.
4. Docker `:v0.1.0-alpha.17` and `:latest` resolve to the **same digest** (verified through the registry API,
   not by assumption), and `GoTavern Docker image` on the tag is green.
5. `GoTavern published-release install smoke` and `GoTavern published-extension smoke` are green after
   publication and prove the installers over real TLS, the tokenizer layout and the published-extension
   journey.
6. `git ls-remote` still answers the alpha.16 tag object `b7d81cd1…` peeling to `c1886d7…`; no force push,
   no `--no-verify`, no tag move.
7. `post-release-facts` regenerates the generated facts for the new tag on `main` and dispatches `GoTavern CI`
   at that commit; the run id is recorded in `handoff-ledger.md`.

## 5. Stop rule

If any requirement above cannot be met, the release does **not** happen. `handoff-ledger.md` records
`BLOCKED`, the exact requirement that failed, the run id that showed it, and the next bounded action. A
formal release is a claim about the artifact, not an intention; a known-unmet item is disclosed, never
silently waived. `GOAL.md` §14 stays **NOT MET** unless a real private user tree is qualified on one commit
by its own byte census and hand-back.
