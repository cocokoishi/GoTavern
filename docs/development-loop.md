# The development loop: what runs where

**This changed on 2026-10-24.** The development host does not execute builds, tests, probes or
browsers any more. Every one of them runs in GitHub Actions. This is not a preference: the host is a
2-core machine that is also doing other work, its measured times are not reproducible under load, and
— more importantly — a Windows result is not the gate. The gate is the Linux run, because fixtures are
recorded on Linux and this repository has already been burned once by a host-dependent fixture that
looked self-consistent on Windows (see `AGENTS.md` verification rules 8, 9 and 18).

So the loop is:

1. **Edit.** Read the pinned source (`../SillyTavern`, which is the 1.19.0 baseline checkout and is
   READ-ONLY), read the code, change files. `git` and reading are the local tools.
2. **Cheap static checks only**, on a single file you just wrote: `node --check <file>`. Nothing else.
3. **Commit on your lane, push once, and let the lead merge it into `main`.** The `main` run is the
   verdict. There are no pull requests (see the working-mode section in `AGENTS.md`): a PR per task
   once meant five oracle jobs for five branches, which is how the CI bill exploded.
4. **Fix forward from the CI log**, not from a local guess. Every job that can fail must say WHICH
   bytes differ, and the oracle job uploads the Linux re-record as a patch on every run.

What that costs, measured on the runner (so it is a fact about the gate, not about the host):

| work | GitHub x86 runner | what it proves |
|---|---|---|
| `verify` job (build + vet + gofmt + full `go test` + assets + cross-compile) | **158 s** door to door | the module builds, is formatted, and every Go test passes |
| `browser-evidence` job (committed artefacts vs their claims) | **~11 s** | every committed browser artefact supports the claim it makes |
| `oracle` job, narrowed to one probe | **13–15 min** | pinned Node vs GoTavern, re-recorded |
| `oracle` job, every probe, double-run | **51 min observed; hours for the current corpus** | the full parity sweep, including nondeterminism |

The oracle is the only expensive thing, and it is expensive because it boots the pinned server and runs
hundreds of probe executions — not because the toolchain is slow. The design answer is therefore not
"run it locally", it is **persist what the runner keeps re-compiling** and **narrow what the runner
runs without narrowing what it verifies**:

- `setup-go` caches the module and build cache;
- the oracle build root (a `git clone --shared`, an `npm ci` and a pruned webpack build of the pinned
  tree) is cached under a key made of the pinned commit and that tree's own `package-lock.json` hash;
- the browser differential caches the pinned `node_modules`, the harness `node_modules` and the
  Playwright browser bundle, each keyed by the identity of what it restores;
- every cache hit prints which branch it took, so the log proves the persistence rather than implying
  it, and a key that does not match the pinned identity re-installs instead of silently serving the
  wrong tree.

`scripts/dev-verify.mjs` still exists and still classifies a change (`--explain`), which is useful for
knowing what CI will select. It is not the gate and must not be used to run the Go build or the full
test suite on this host.

## Tiers, restated as CI jobs

**Tier 0 — static, local.** Reading, `git`, `node --check` on one file. Nothing is proven here; this
tier exists so that an obvious typo does not cost a runner slot.

**Tier 1 — the `verify` job.** Every push to `main`. Build, vet, gofmt on the LF bytes, the whole Go
suite, the asset manifests, the six-platform cross-compile, the oracle execution-core and planner
tests, the document-facts `--check`, the browser artefact verifier, the installer classifier test. This
is where a compile error or a broken assertion is found, and it takes under three minutes.

**Tier 2 — the oracle job, narrowed.** When the planner selects specific probes, only those re-record.
The cost falls, and so does the detection: a probe that did not run leaves its fixture byte-identical,
so the zero-diff step cannot see it. A narrowed green is a statement about the selected probes, never
about the oracle as a whole.

**Tier 3 — the oracle job, full.** Pinned Node vs GoTavern, every probe. It runs on:

- the nightly cron (`17 4 * * *`);
- a `workflow_dispatch`, with an empty `probes` input for everything or a list for a named subset;
- a push that touches a shared harness input (`tools/lib/**`, `tools/oracle/execution.mjs`, the
  generator, `upstream/**`) or any path the planner cannot attribute, because such a change can move
  any fixture;
- a release candidate, by using the same dispatch.

It must never be the default for an ordinary provider change, and it must never be skipped for a change
that CAN move a fixture. That decision lives in CODE, not in YAML: `tools/oracle/manifest.mjs` derives
one dependency graph from the probes' own `@gotavern-oracle: fixture=` declarations -- each probe's
script, `tools/lib/` when it imports the harness, `tests/provider-wire/scenarios/` when it reads them,
every `tools/<helper>/` Go program it runs, and a `go-product` edge when it records GoTavern's own
output -- and `tools/oracle/plan.mjs` turns a changed-file list into a JSON plan.
`tests/oracle/plan.test.mjs` is the table test over every rule and runs in the `verify` job. The
`changes` job now only produces the changed-file list and reads that plan.

Skipping the oracle is possible only when every changed path is on the planner's explicit irrelevant
list, and that list excludes the control plane: a change to `ci.yml`/`lane.yml` or to the probe execution
primitive forces a FULL sweep, because a change to the gate that selects work is not evidence that the
selection is right -- it is the thing under test. Anything else -- a Go change, an unknown directory, a
path nothing declares -- forces a FULL sweep with the reason printed beside the decision. **The residual
risk, stated rather than papered over:** a Go change that moves a fixture through a dependency the
derivation cannot see is caught only by the nightly full sweep, because the per-push planner has no way
to attribute it.

## Generated document facts

Counts cited in `README.md`, `HANDOFF.md`, `docs/compat-matrix.md` and `docs/surface-coverage.md` live in
marked blocks: `<!-- BEGIN GENERATED: <name> --> ... <!-- END GENERATED: <name> -->`. `node
tools/generate-doc-facts.mjs` derives them from the tree, rewrites `docs/generated/facts.json` and the
marked blocks, and `--check` (run in CI's `verify` job) fails naming any stale fact or block. Never
hand-edit between the markers; change the derivation or the prose outside them. A fact that cannot be
derived (for example a historical mutation count) stays human-written and must carry its date.

`node tools/generate-coverage-matrix.mjs --check` does the same for the per-source P/E/streaming/
cancellation/preset matrix: a `yes` cell must name a committed fixture or artefact, a stale/absent
artefact is its own status, and the pinned-derived source list and the Go registry are cross-checked
in both directions. It never lets the registry prove a cell.

## What no local run can decide, and must not be pretended otherwise

A **provider-wire capture** needs the pinned Node server talking to a controlled peer. Replaying a
committed fixture proves the Go side only; producing a NEW capture requires a recording run. The same is
true of every browser artefact: producing one requires both legs, a real browser and the pinned
frontend, which is what `.github/workflows/browser-differential.yml` exists for. Re-recording a fixture
to turn red into green, without explaining why the OBSERVATION legitimately changed, is forbidden.

## The loop an agent should follow

1. Read the target source and its tests/probes.
2. `node scripts/dev-verify.mjs --explain` if you want to see what the change can move (classifier only).
3. Make the smallest change.
4. `node --check` the files you wrote, if they are JavaScript.
5. Commit small, on your lane.
6. Push the lane once and report; the lead merges and the `main` run decides.
7. Diagnose from the CI log. Do not run the build or the suite on this host to "confirm" what CI said.

The target is that the gate's wall time is spent once per change set, not once per retry.
