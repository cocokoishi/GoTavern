# Release governance: machine gates, not a remembered checklist

This document records the two process gaps Beta 1 closes, the mechanism that closes each, and the one lifecycle
event that used to make `main` red after every release. Everything here is enforced by a program that runs in the
publish path, and every refusal has a named test case.

## 1. Same-SHA required gates (the release stops being a human memory)

**The gap.** Alpha.9 was published with every required gate green, and a human read the checklist's "same SHA"
line and confirmed it. Nothing in the pipeline could see the difference between

- CI, browser differential and qualification runs that all judged commit `X`, and
- CI at `X`, browser differential at `Y`, qualification at `Z`, tag at `W`.

A hand-written checklist cannot tell those apart, which is exactly the state a release must not be trusted from.
The only durable fix is a machine that reads the runs.

**The mechanism.**

- `docs/release-manifest.json` names the required workflows. It is hand-maintained because it is policy, and it is
  validated by the `verify` job against the workflow names that actually exist, so a typo is a red at PR time
  rather than a confusing "missing run" at publish time.
- `scripts/verify-release-gates.mjs` runs inside `release.yml`'s publish job **before** `gh release create`. It
  asks the Actions API for every run whose `head_sha` is the tag's target commit, matches the required workflow
  names, and accepts only a run that is `completed` **and** `success` at that SHA. A green run on any other commit
  is counted, reported, and refused.
- The gate fails closed: a missing run, an in-progress run, a cancelled run, a failed run, or a different-SHA run
  exits non-zero and the release is not published. Every row of its table (workflow, run id, event, conclusion) is
  written to the run summary, and the release body cites those run ids.
- `GoTavern Release` is not in its own manifest: a workflow cannot be its own precondition. The publishing run
  supplies its own build and `prepublish-qualification` at the tag commit, and that job executes the bare
  installers against the archives this very run built.

**The teeth.** `scripts/release-governance.test.mjs` (run by `ci.yml`'s `verify` job) drives the decision function
with synthetic runs and requires each refusal by name, including the case that motivates the gate: a perfect set of
green runs that belongs to a **different** commit must fail.

## 2. Release-body validation (both channels)

**The gap.** Alpha.9's publish path grepped one placeholder shape (`<UPPER:`) inside a shell `if`, and only on the
stable path. The rule existed nowhere a test could execute it, and a prerelease body -- equally permanent once
published -- was never checked at all.

**The mechanism.** `scripts/verify-release-notes.mjs` (rules in `scripts/release-governance/notes.mjs`) runs
before `gh release create` for **any** curated body:

| rule | why |
| --- | --- |
| the body names its own tag as a version **token** (not a substring: `v0.1.0-beta.1` contains `v0.1.0`) | a body written for one release must not be publishable against another |
| no `TODO` / `TBD` / `FIXME` / `PLACEHOLDER` / `XXX` | drafting words mean the note is unfinished |
| no `<version>` / `<date>` / `<sha>` / `<run id>` / `<checksum>` style tokens | an unfilled template is not a release note |
| no too-short run ids (`run 123`) | real Actions run ids are 9-12 digits; a 1-7 digit value is a stand-in |
| any 64-hex digest must match an entry in this run's `checksums.txt`, and a canonical asset named beside a digest must be the asset that digest belongs to | an example checksum or a digest quoted beside the wrong file is a false claim in the release record |
| required sections: a level-1 title, `## Known limitations`, `## Checksums`/`## Artifacts`; minimum body size | the release body is a claim document, not a stub |
| stable channel **requires** a curated body; prerelease may fall back to generated notes | documented channel difference, not a silent one |

A dispatch dry run validates the candidate's notes file in `prepublish-qualification`, so placeholders are caught
an hour before the tag instead of after the archives are built twice. The stable/prerelease selection is still made
in exactly one place, `scripts/classify-version-tag.sh`.

**The teeth.** The same test file drives the notes validator with a clean body (accepted) and with a drafting word,
a `<date>` token, a fabricated run id, a degenerate checksum, a digest matching no asset, the right digest beside
the wrong asset, a wrong tag and a stub body (each refused by name).

## 3. The generated-facts lifecycle

**The gap.** `docs/generated/facts.json` records the version tags the tree knows about. Creating a tag changes
that fact **on the commit the tag points at**, which is `main`'s tip. Alpha.9 handled this with a manual
regeneration commit (`d5464eb`); until someone remembered it, `main verify` was red after every release. A normal
release event making `main` red is a process defect, not a test defect.

**The mechanism.** `release.yml` has a `post-release-facts` job after `publish`:

1. check out `main` with full history and assert that `main` is still the tagged commit; if `main` has advanced,
   fail closed (a merge decision is not mechanical);
2. run `node tools/generate-doc-facts.mjs`, re-run its `--check`, and commit with an **explicit file list** --
   never `git add -A`, because this repository has already had a mutation commit absorb other lanes' in-flight
   files that way;
3. push the commit to `main`;
4. dispatch `GoTavern CI` on `main` explicitly, because a push made with `GITHUB_TOKEN` does not create a workflow
   run. The run id is printed into the release job's log, so "main is green after the release" cites a run.

The tag itself never moves and no asset is re-uploaded: the generated-facts commit is a descendant of the released
commit, on `main` only.

## 4. What this deliberately does not do

- It does not decide the channel from the tag name in the release workflow; `scripts/classify-version-tag.sh`
  remains the single answer shared with `docker.yml` and both installers.
- It does not accept a "green enough" set: there is no override flag. A genuine platform outage is handled by
  re-running the missing gate at the same SHA before tagging, not by bypassing the gate.
- It does not make the tag commit's own facts evergreen: a CI run *at a tagged commit after the tag was created*
  can legitimately see one more tag than the commit recorded. No workflow runs CI on tags, and the post-release
  commit is what keeps `main` healthy; the alternative -- making the facts independent of tags -- would mean the
  document stopped recording the release history it exists to record.
