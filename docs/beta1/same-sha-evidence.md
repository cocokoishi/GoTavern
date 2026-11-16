# v0.1.0-beta.1 — same-SHA qualification record

**Release:** `v0.1.0-beta.1` (prerelease channel)
**Candidate / tag target:** `d97c4d3` (`docs(beta1): make the product page
installation-first and gate the README against release lag`)
**Tag object:** `3fefdf3`, annotated, peels to the candidate above
**Pinned oracle baseline:** SillyTavern `1.19.0` @ `06bde939fb1e9c4c8d8641d810f0a916b5bce127` (unchanged)
**Verdict:** `**PASS**: 14/14 required workflow(s) are green at this SHA.` — `scripts/verify-release-gates.mjs`
exit 0, run locally against the live Actions API before the tag was created, and re-run inside the publish job
immediately before `gh release create`.

## How this record was produced

The gate program is the same one the publish job runs; the only difference is that this copy was executed on the
release manager's host, read-only, with `GITHUB_REPOSITORY=cocokoishi/GoTavern` and a token scoped to the
repository:

```
node scripts/verify-release-gates.mjs \
  --sha "$(git rev-parse d97c4d3)" \
  --manifest docs/release-manifest.json \
  --evidence-out docs/beta1/same-sha-evidence-table.md \
  --release-evidence-out docs/beta1/release-evidence.json \
  --release-evidence-md-out docs/beta1/release-evidence-publish.md
```

The verifier requires a resolved 40-hex SHA, so the command resolves the short candidate id it names; the three
output files it wrote are folded into this page and [`release-evidence.md`](release-evidence.md) rather than
committed a second time (the publish run's `release-evidence-contract` artifact holds the machine copy). The
table below is that command's output, unedited. `--evidence-out` is written only on a passing verdict, so the
existence of this table is itself the PASS condition (`scripts/verify-release-gates.mjs:146-158`); a failing
wave writes no table and appends nothing to the release body.

## Freeze and wave

- The candidate was pushed to `main` before any dispatch, and `HEAD == origin/main` was asserted immediately
  before every dispatch (`d97c4d30…`), so each run's `head_sha` is the candidate rather than a branch tip that
  moved underneath it. No push to `main` was made between the first dispatch and this verdict.
- The release rehearsal (`GoTavern Release`, run `43825779165`, `workflow_dispatch`, success) ran in parallel
  with the wave at the same SHA. It built and archive-inspected the six canonical assets, then asserted, through
  `scripts/qualify-prepublish.sh`:
  `ok: canonical classifier: 'v0.1.0-beta.1' is prerelease`,
  `ok: built the PRERELEASE candidate mirror (<base>/v0.1.0-beta.1/, deliberately NO latest/) and a tampered copy`,
  `ok: a BARE install.sh was REFUSED against the prerelease candidate (no latest stand-in exists, by design)`,
  `ok: a tampered archive was REFUSED by the installer, naming the mismatch, and installed nothing`,
  `ok: a BARE install.ps1 was REFUSED against the prerelease candidate (no latest stand-in exists, by design)`.
  It published nothing, and `gh release view v0.1.0-beta.1` still answered `release not found` after it.
- One superseded run was cancelled deliberately: the push-triggered `GoTavern CI probes=auto` run `43825674282`
  at the same SHA held the `ci-GoTavern CI-refs/heads/main` concurrency group, and the required
  `workflow_dispatch` run (`probes=full`) was queued behind it. The push run's evidence is not admissible for the
  gate (its title is `probes=auto`), so cancelling it removed a wait without changing what the gate accepts.

## Qualification evidence (same-SHA required gates)

Every workflow below has a completed, successful run whose `head_sha` is this release tag's target commit
`d97c4d3`, dispatched with the selection the manifest requires.

| workflow | run id | event | conclusion | required jobs | selection proof | artifact (evidence) |
|---|---|---|---|---|---|---|
| GoTavern CI | [43825703324](https://github.com/cocokoishi/GoTavern/actions/runs/43825703324) | workflow_dispatch | success | changes, browser-evidence, verify, crash-gate, race, oracle | display-title | - |
| GoTavern whole-session differential | [43825708751](https://github.com/cocokoishi/GoTavern/actions/runs/43825708751) | workflow_dispatch | success | whole-session | jobs | - |
| GoTavern world-info slot ordering | [43825714256](https://github.com/cocokoishi/GoTavern/actions/runs/43825714256) | workflow_dispatch | success | worldinfo-slots | jobs | - |
| GoTavern drop-in qualification | [43825719766](https://github.com/cocokoishi/GoTavern/actions/runs/43825719766) | workflow_dispatch | success | dropin-current-head, windows-inputs, dropin-windows | jobs | - |
| Browser differential | [43825725561](https://github.com/cocokoishi/GoTavern/actions/runs/43825725561) | workflow_dispatch | success | differential | display-title | - |
| GoTavern release qualification | [43825730553](https://github.com/cocokoishi/GoTavern/actions/runs/43825730553) | workflow_dispatch | success | qualify-linux-amd64, qualify-windows-amd64, qualify-dropin-linux, qualify-published-alpha9-upgrade, qualify-upgrade-rollback | jobs | - |
| GoTavern smoke metrics | [43825735942](https://github.com/cocokoishi/GoTavern/actions/runs/43825735942) | workflow_dispatch | success | measure-linux-amd64, paired-linux-amd64 | jobs | - |
| GoTavern Docker image | [43825741198](https://github.com/cocokoishi/GoTavern/actions/runs/43825741198) | workflow_dispatch | success | docker | jobs | - |
| Helper state differential | [43825746962](https://github.com/cocokoishi/GoTavern/actions/runs/43825746962) | workflow_dispatch | success | helper state differential (ubuntu, bounded) | jobs | - |
| Combination journey differential | [43825752083](https://github.com/cocokoishi/GoTavern/actions/runs/43825752083) | workflow_dispatch | success | combination-journey | evidence | combination-journey-evidence (combination-journey-evidence) |
| Third-party extension compatibility | [43825757789](https://github.com/cocokoishi/GoTavern/actions/runs/43825757789) | workflow_dispatch | success | selftest, aggregate, corpus, soak, overhead, macos-arm64-recorded-limitation | jobs | extension-compat-evidence |
| GoTavern long-lived corpus qualification | [43825763463](https://github.com/cocokoishi/GoTavern/actions/runs/43825763463) | workflow_dispatch | success | medium-corpus | evidence | longlived-medium-evidence (gotavern-longlived-corpus-evidence) |
| GoTavern Node stock tree round trip | [43825768622](https://github.com/cocokoishi/GoTavern/actions/runs/43825768622) | workflow_dispatch | success | node-stock-tree | jobs | node-stock-tree-evidence (gotavern-node-stock-tree-evidence) |
| GoTavern real-UI oracle differential | [43825773763](https://github.com/cocokoishi/GoTavern/actions/runs/43825773763) | workflow_dispatch | success | real-ui-oracle | evidence | a19-real-ui-oracle-evidence (a19-real-ui-oracle-v1) |

The `required jobs` column names the jobs that had to be completed/success IN the cited run, not merely present
in a green workflow; the `artifact (evidence)` column names the fixed-name evidence bundle the verifier
downloaded and the document kind whose embedded head SHA and tier marker it checked (`-` means the gate is
judged by its own conclusion).

## What this record does not prove

- It does not prove anything about behaviour: it proves that the fourteen required workflows ran at this
  commit with the required selections and jobs. Behaviour is what those workflows measure; their own
  assertions are the evidence, and `docs/beta1/release-evidence.md` records the published-bytes checks.
- It does not cover the `GoTavern Release` run that published the tag: a workflow cannot be its own
  precondition. The publish job re-ran this exact verifier at the tag target before `gh release create`, and
  the published body carries the table above.
- The `mergeGroup`/`push` runs at the same SHA are not part of the gate and are not cited as evidence here.
