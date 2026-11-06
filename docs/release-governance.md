# Release governance: machine gates, not a remembered checklist

This document records the process gaps the release path closes (the same-SHA required gates, release-body
validation, the generated-facts lifecycle and the recorded darwin/arm64 platform limitation), the mechanism that
closes each, and the one lifecycle event that used to make `main` red after every release. Everything here is
enforced by a program that runs in the publish path, and every refusal has a named test case.

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
- **A narrowed run is not the gate.** Each manifest entry carries `requiredEvent`
  (`workflow_dispatch` for every required gate at alpha.10). This closed a hole measured while qualifying alpha.10:
  `ci.yml` on a **push** selects its oracle probes from the changed paths, so push run `41210334467` at the alpha.10
  candidate concluded `success` with its `oracle` job **skipped**. The original gate asked only "is there a
  successful run at this SHA?" and would have published on that narrowed evidence. A gate whose required event
  does not match the run is now `missing`, and its refusal names the event it found ("$n run(s) ... prove a
  narrowed selection, not the release gate"). The dispatch run is the one whose selection is the full one, and the
  row in the published evidence table names it.
- The gate fails closed: a missing run, an in-progress run, a cancelled run, a failed run, or a different-SHA run
  exits non-zero and the release is not published. Every row of its table (workflow, run id, event, conclusion,
  required jobs, artifact/evidence) is written to the run summary, and the published body carries the same table:
  `scripts/assemble-release-body.mjs` appends it to the curated note at publish time, so the run ids appear in the
  release without a self-referential commit (see section 2).
- **Four rails, because "the run is green" is not evidence.** A green conclusion can coexist with a job that never
  ran, a missing or expired artifact, or an artifact whose content belongs to another attempt. Each manifest entry
  may therefore name, besides `requiredEvent`:
  - `requiredJobs`: every named job must be `completed`/`success` **in the cited run**. The runs API reports the
    workflow's conclusion, not its jobs; a job whose `if:` was false contributes `skipped` to a successful run. This
    is measured, not hypothetical: the long-lived workflow's **default dispatch runs small only and leaves
    `medium-corpus` SKIPPED while the run is green** — the exact plausible-looking evidence the alpha.15 rails
    refuse.
  - `requiredArtifact`: the fixed-name evidence bundle must be attached to the cited run and not expired.
  - `requiredEvidence`: the contract for the artifact's CONTENT — `kind`, optional tier marker (`tierField`/`tier`;
    the long-lived gate requires `size: medium`), the **embedded head SHA which must equal the candidate**, plus
    `requireTruthy` member paths and `requireSha256` digest paths. A name is not content: the verifier downloads the
    artifact archive and reads `release-evidence.json` out of it (`scripts/release-governance/artifact-evidence.mjs`
    has a bounded ZIP reader), so an artifact uploaded by another attempt, or a small-tier document dropped into a
    similarly-named bundle, is refused.
  - A gate naming any of those MUST also name its `requiredEvent` (`validateManifest` refuses otherwise), because
    `node-stock-tree.yml` uploads the SAME fixed artifact name on push runs — without the event rail a push run
    would satisfy its release gate. `requiredEvent` accepts any known Actions event; a `schedule` requirement is
    satisfied only by a scheduled/cron run at the candidate SHA, never by a dispatch.
- **One query plan.** `evidenceQueryNeeds(manifest)` derives the three live queries (artifact lists, job lists, the
  named artifacts' downloaded evidence) from the manifest, and both publish paths — the curated-note assembler and
  `verify-release-gates.mjs` — use it, so they cannot judge different evidence.
- **The two alpha.15 gates and why they are independent.** `GoTavern long-lived corpus qualification` buys the
  medium-tier long-lived shape (a ~50 MB, 2400-message-history corpus driven through resume/send/swipe/
  switch/reload/save/restart/resume/continue with a comparator teeth proof and the 20-extension manifest digest);
  no other entry exercises an existing long history across a restart. `GoTavern Node stock tree round trip` buys the
  Node→Go→Node input half (a tree **originated by the pinned Node server** is read, mutated, restarted, handed back
  and re-read); drop-in qualification boots a packaged archive against a **derived** tree and release qualification
  installs the archive, so neither duplicates it. The `large` long-lived tier is a nightly/large-dispatch **rail**,
  not a release gate: a nightly run predates the candidate and cannot be same-SHA by construction.
- `GoTavern Release` is not in its own manifest: a workflow cannot be its own precondition. The publishing run
  supplies its own build and `prepublish-qualification` at the tag commit, and that job executes the bare
  installers against the archives this very run built.

**The teeth.** `scripts/release-governance.test.mjs` (run by `ci.yml`'s `verify` job) drives the decision function
with synthetic, fabricated API responses and requires each refusal by name: a perfect set of green runs belonging to
a **different** commit; a push run for a dispatch-required gate; a dispatch run for a schedule-required gate; a green
run whose required job was **skipped** (the small-tier long-lived masquerade); a required job absent or failed; a job
list that was never fetched; a missing/wrong/expired artifact; missing embedded evidence; a wrong `kind`, tier marker,
embedded head SHA, `schemaVersion`, truthy field or 64-hex digest; a newer empty run not masking an older satisfying
one; and the positive control. It also exercises the ZIP reader on stored and deflated archives, the live query
plumbing against a fake `fetch`, and the `release.yml` wiring (six platform assets, the shared classifier, both
publish paths calling the gate, and the tag-only publish gate).

## 2. Release-body validation (both channels)

**The gap.** Alpha.9's publish path grepped one placeholder shape (`<UPPER:`) inside a shell `if`, and only on the
stable path. The rule existed nowhere a test could execute it, and a prerelease body -- equally permanent once
published -- was never checked at all.

**The mechanism.** `scripts/verify-release-notes.mjs` (rules in `scripts/release-governance/notes.mjs`) runs
before `gh release create` for **any** curated body. The body is read from the tag's tree when it is there, and
otherwise from `main` -- and `main` must contain the released commit. That is not a loophole: a release note is
release **metadata**, and a note that cites the ids or measurements of runs is necessarily written *after* those
runs, so editing it into the tagged commit would change the commit the runs judged. Keeping it on `main` and
reading it at publish time is what lets the note be both current and true about the tag.

In the publish path the three decisions are one tested program: `scripts/assemble-release-body.mjs` validates the
note against this run's `checksums.txt`, runs the same-SHA gate, and appends the evidence table only if BOTH are
clean. `scripts/verify-release-notes.mjs` remains the standalone note check used by the dispatch rehearsal.

The rules are:

| rule | why |
| --- | --- |
| the body names its own tag as a version **token** (not a substring: `v0.1.0-alpha.10` contains `v0.1.0`) | a body written for one release must not be publishable against another |
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

1. check out `main` with full history and require the released commit to be an ancestor of it (`main` may be ahead
   by the curated release note, which is metadata written after qualification, never by unrelated history);
2. run `node tools/generate-doc-facts.mjs`, re-run its `--check`, and commit with an **explicit file list** --
   never `git add -A`, because this repository has already had a mutation commit absorb other lanes' in-flight
   files that way;
3. push the commit to `main`;
4. dispatch `GoTavern CI` on `main` explicitly, because a push made with `GITHUB_TOKEN` does not create a workflow
   run. The run id is printed into the release job's log, so "main is green after the release" cites a run.

The tag itself never moves and no asset is re-uploaded: the generated-facts commit is a descendant of the released
commit, on `main` only.

## 4. Recorded platform limitations: the darwin/arm64 downgrade

**The gap.** `release.yml` used to have one job, `execute-darwin-arm64` on `runs-on: macos-14`, that ran the
built darwin/arm64 archive and polled its own `/version`, and the publish job's `needs` list included it. That
is the right shape for every other target: an archive that cannot be executed is not runtime-qualified. It
became an unpassable gate on 2026-11-06: the runner was never assigned, the job was cancelled with zero steps,
and the check-run annotation says `The configuration 'macos-14-arm64-us-default' is not supported`. The run
cannot be published with a skipped `publish`, and the alternatives were a silent waiver (a hidden gap) or an
unverified label guess. Both are refused.

**The evidence, re-readable.** The cancelled attempt is `GoTavern Release` run `42242191281`, job `127975851110`
(labels `macos-14`, `runner_name` empty, `steps: []`, started `2026-11-06T15:22:23Z`, cancelled after 54 s); the
alpha.15 release-candidate run `42113162581`, job `127552551348`, carries the same annotation. The same job
executed successfully five times earlier on 2026-11-05: runs `42018112346`, `42035872824`, `42051271771`,
`42061439366`, `42085159949` (`execute-darwin-arm64` completed/success with an assigned runner). So the job, the
archive and the archive-inspection contract are not what changed: the platform's arm64 macOS runner configuration
stopped being provisioned. The repository has no self-hosted runners (`GET /repos/{owner}/{repo}/actions/runners`
answers zero) and is public, so the runner is GitHub-hosted and this was a platform-side unavailability. To
re-read it:

```bash
gh api repos/cocokoishi/GoTavern/actions/jobs/127975851110   # labels, empty runner, empty steps, cancelled
gh api repos/cocokoishi/GoTavern/commits/a54db37/check-runs # annotations for that job
```

**Why not switch labels.** `macos-14` is the only arm64 macOS label this repository has ever used; `macos-15-intel`
is already the x64 label, so `macos-15` is the only plausible existing arm64 alternative. Selecting it would be an
unverified guess that only a dispatch can settle, and a release gate may not be moved to a guessed runner. It is
recorded here as the restoration candidate instead: if an arm64 macOS runner is available again, restore the
execution job (and its `executed`-mode marker/evidence) rather than weakening this gate.

**The mechanism.** The pure-execution job is replaced by `darwin-arm64-recorded-downgrade` on `ubuntu-latest`. It:

1. extracts the archive this run built and **proves the Mach-O CPU type is arm64**: magic `0xfeedfacf`
   (`MH_MAGIC_64`) and cputype `0x0100000c` (`CPU_TYPE_ARM64`), parsed from the binary header, not read from a
   label or a `file` string;
2. re-asserts the build+archive inspection contract the build job asserts: `LICENSE`, `THIRD_PARTY_NOTICES.txt`,
   `BUILD-INFO.txt` naming the release and `target darwin`, the version string inside the shipped binary bytes,
   the `src/tokenizers/` tree with a non-empty `llama.model`, no duplicate root `tokenizers/`, no shipped runtime
   state (`config.yaml`, `data`, `extensions`, `certs`, `_storage`, `cookie-secret.txt`, `secrets.json`), and the
   tar executable bits on the Linux runner;
3. writes `darwin-arm64-platform-limitation.json` (schemaVersion 1, kind `gotavern-darwin-arm64-platform-limitation`,
   target `darwin/arm64`, archive sha256 and size, the Mach-O proof, the build-info target, the recorded platform
   attempts with run/job ids and the platform annotation, and `execution: {performed: false}`) and uploads it as
   the fixed-name artifact `darwin-arm64-platform-limitation`.

The publish job downloads that artifact, runs the gate's planted cases first (`--self-test`), then runs `verify`
with the archive it is about to publish and the resolved curated notes (the candidate/tag version first from the
tree, then from `origin/main` when a curated body lives there). `verify` accepts **either** an `executed`-mode
marker carrying real execution evidence (uname `arm64`/`aarch64`, the `gotavern version` output, and the pinned
`"pkgVersion":"1.19.0"` record) **or** a `recorded-downgrade` marker that proves the arm64 Mach-O and the build
contract and records at least one real platform attempt, **and** a curated note that carries the published
limitation line (the note must name `darwin/arm64` and say it is NOT runtime-qualified / not executed). A
downgrade that is not stated in what users read is refused exactly like a missing marker.

**What blocks publication, by name** (each is a case in `scripts/release-governance/darwin-arm64-qualification.mjs
--self-test`, run in the publish job before the real marker): a missing or unreadable marker (`missing-marker`);
malformed JSON (`marker-invalid`); wrong schema/kind/target/archive/version; an archive whose sha256 differs from
the marker (`archive-sha-mismatch`); an unexplained downgrade (`reason-code-unknown`); a marker without the arm64
Mach-O proof (`mach-o-not-arm64`) or without the darwin/arm64 build-info target; a downgrade with no recorded
platform attempt (`platform-evidence-missing`); a `recorded-downgrade` marker claiming execution
(`execution-claim-without-evidence`); an unknown mode (`unknown-mode`); an executed marker without execution
evidence (`execution-evidence-missing`); and a curated note without the limitation line
(`notes-limitation-missing`). There is no override flag and no `continue-on-error`: the job is a normal required
dependency of `publish`, and the marker check is a normal failing step.

**What it does NOT prove.** Nothing here executes darwin/arm64. Dynamic linking, process and file semantics,
startup latency and the `/version` handshake on an arm64 Mac remain **UNPROVEN**, and the release notes'
Known limitations section must say so (and does, or `notes-limitation-missing` blocks the release). What is
proven is narrower and stated as such: the published archive is a thin arm64 Mach-O built by this run, it carries
this release's version and tokenizer tree, it was not swapped after inspection (sha256), and the platform's refusal
to provide the runner was recorded with ids and re-read from the API rather than asserted in prose.

**Teeth.** `scripts/release-governance.test.mjs` includes the refusal cases and a workflow-wiring case that fails
if the publish job stops waiting for the recorded-downgrade job, stops running `--self-test`, stops running
`verify`, or if a pure-execution `execute-darwin-arm64` job is reintroduced without an execution marker. The
planted program itself (`--self-test`, currently 11 cases) runs on every release, so the refusal path cannot rot
into a step that only ever sees a good input.

## 5. What this deliberately does not do

- It does not decide the channel from the tag name in the release workflow; `scripts/classify-version-tag.sh`
  remains the single answer shared with `docker.yml` and both installers.
- It does not accept a "green enough" set: there is no override flag. A genuine platform outage is handled by
  re-running the missing gate at the same SHA before tagging, not by bypassing the gate.
- It does not make the tag commit's own facts evergreen: a CI run *at a tagged commit after the tag was created*
  can legitimately see one more tag than the commit recorded. No workflow runs CI on tags, and the post-release
  commit is what keeps `main` healthy; the alternative -- making the facts independent of tags -- would mean the
  document stopped recording the release history it exists to record.
