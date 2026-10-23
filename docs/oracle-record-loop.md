# Recording a fixture on Linux: the oracle patch loop

Some fixtures **cannot be recorded faithfully on the Windows development host**. The tokenizer corpus is
the recorded example: re-recording it on Windows altered 326 pre-existing anchors by decoding UTF-8 as
Latin-1, reproduced twice, from a different working directory — the recorder's own encoding, not a copy
mistake. A Windows re-record of such a fixture is therefore **not evidence**, and the only recording
authority is the Linux CI runner.

A source lane can therefore land **scenario inputs without captures**: the scenario files are written by
hand (or generated), the captures do not exist yet, and the differential test fails with

```
capture has no scenario "aimlapi-error-status"; a missing capture must never look like a pass
```

That failure is correct and is not a defect to work around. The loop below turns it into recorded bytes.

## The loop

```
  branch with scenario INPUTS, no captures
        |
        |  push (lane branch, then main when the Lead merges)
        v
  "GoTavern CI" -> oracle job re-records on Linux, TWO runs per probe
        |
        |  uploads artifact `oracle-linux-rerecord` (14 days)
        |  containing `oracle-rerecord.patch` = `git diff --binary` over
        |  tests/oracle, docs/api-inventory.md, docs/config-inventory.md, upstream
        v
  node scripts/apply-oracle-rerecord.mjs         # checks, applies, prints the scenario delta
        |
        |  YOU review the counts, then commit and push (the script never does)
        v
  next run is green, or the re-record disagreed with GoTavern -- read it, do not force it
```

The script does the mechanical part and refuses on every condition a human would have to check:

```
node scripts/apply-oracle-rerecord.mjs                   # newest SUCCESSFUL oracle artifact for HEAD
node scripts/apply-oracle-rerecord.mjs --dry-run         # all checks, no `git apply`
node scripts/apply-oracle-rerecord.mjs --patch FILE      # a patch already on disk
node scripts/apply-oracle-rerecord.mjs --run <run-id>    # pin a run (e.g. the one named in a failure)
node scripts/apply-oracle-rerecord.mjs --allow-non-oracle docs/api-inventory.md
```

It refuses (exit 1, naming the reason) when: the artifact belongs to a **different commit** than HEAD; the
run for HEAD is **still in flight**; the run **did not succeed**; the patch **does not apply**; or the
patch touches **anything outside `tests/oracle/`** by default. An **empty** patch is not a refusal — it is
the success case, meaning the commit is already recorded on Linux.

## The two hazards, both hit for real

**(a) A push while an oracle run is in flight CANCELS it.** `ci.yml` sets
`concurrency: { group: ci-${{ github.workflow }}-${{ github.ref }}, cancel-in-progress: push }`. A cancelled
run **uploads no patch**, and it publishes a `cancelled` conclusion that looks nothing like "waiting". So
before pushing again: confirm the run for the commit you care about is **completed**, not merely started.
The script reports an in-flight run as a refusal for exactly this reason; `gh run view <id>` is the manual
check.

**(b) A commit landing between the oracle start and its completion INVALIDATES the patch.** The patch is
`git diff` against the commit the run started from. If anything else lands on that branch first, the patch
either fails `git apply --check` or — worse, when the two touch different fixtures — **applies cleanly while
being recorded against a tree that no longer exists**. That is why the script compares the run's `headSha`
with `HEAD` and refuses; and why `git apply --3way` is forbidden here (it "makes it fit" by inventing a
merge, which is exactly the silent corruption the check exists to prevent).

Both hazards have the same root: **the artifact is bound to a commit, not to a branch**. Treat it as a fact
about one SHA.

## When the patch is not fixtures-only

The oracle job also diffs `docs/api-inventory.md`, `docs/config-inventory.md` and `upstream/`. Those are not
fixture bytes:

* `docs/api-inventory.md` is generated, but its **status column is hand-maintained** (the generator keeps
  what it finds), so a re-record can legitimately reorder or add rows;
* `upstream/` carries release-owned regenerated assets.

The script applies fixtures only, prints the offending paths, and asks for them explicitly:

```
REFUSED: the patch touches 1 path(s) outside tests/oracle/:
  docs/api-inventory.md
```

Read those hunks, apply them yourself if they are yours, or pass `--allow-non-oracle docs/api-inventory.md`
to say so in one step — the flag exists so the decision is *recorded*, not so it is skippable.

## Why this is a script and not a workflow job that pushes for you

A `workflow_dispatch` job could download the artifact, apply it and push to a `lane/oracle-apply` branch.
It is **not** enabled, for three reasons that are properties of the platform rather than of the script:

1. **A push made with the default `GITHUB_TOKEN` does not trigger further workflow runs.** The push that
   applies the patch would therefore never be verified — and "the next run must be green" is the only
   evidence that the re-record agreed with GoTavern. Working around this needs a PAT (or a GitHub App
   token) as a repository secret, i.e. credentials this project does not currently have and should not add
   for convenience.
2. **`ci.yml` is `permissions: contents: read`.** Writing needs that widened, which also widens what every
   other job in the file may do.
3. **The patch is bound to a commit** (hazard (b)). A job that applies the patch for run X onto branch Y
   is doing exactly the unsafe thing this loop exists to prevent, and it would do it unattended.

If the project later wants the automation, the safe shape is: dispatch job on the **same** SHA, apply, push
to a branch **named after the SHA**, and use a PAT so the verification run actually happens. Until then the
script plus this page is the loop.

## Checklist for the Lead

1. `git rev-parse HEAD` — know the SHA you are recording.
2. Confirm the run for that SHA is **completed and successful** (`gh run list --commit <sha>`).
3. `node scripts/apply-oracle-rerecord.mjs` — read the scenario delta it prints.
4. `git status --porcelain` — expect only `tests/oracle/*.json`.
5. Commit with the measurement in the message, push.
6. **Wait for that run to complete before pushing anything else** (hazard (a)).
