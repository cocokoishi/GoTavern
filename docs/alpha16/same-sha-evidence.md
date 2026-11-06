# Same-SHA release-gate evidence - alpha.16 candidate `6e96959`

This is the recorded output of the release gate program itself, run by the Lead against the frozen
candidate. It is the evidence the publish job's own verifier produces, not a hand-written checklist.

Command (the same one the publish job runs, with the candidate commit in place of the tag target):

```
node scripts/verify-release-gates.mjs \
  --sha 6e96959 \
  --manifest docs/release-manifest.json \
  --evidence-out <path>
```

This document deliberately uses the repository's seven-character candidate form `6e96959`, because the
document gate in `internal/fixtures` refuses a forty-character commit that is not the pinned one. The
verifier itself resolves the short form through the runs API and refuses an ambiguous or missing commit, so
the recorded table below is the authoritative statement of which run belongs to which commit.
Exit status: `0`.

## Recorded output

```
## Same-SHA release gate for `6e96959`

Every required workflow must have a completed, successful run whose `head_sha` is this commit.

| required workflow | run | event | status | conclusion | required jobs | evidence | verdict |
|---|---|---|---|---|---|---|---|
| GoTavern CI | 42294114075 | workflow_dispatch | completed | success | - | - | success |
| GoTavern whole-session differential | 42294118964 | workflow_dispatch | completed | success | - | - | success |
| GoTavern world-info slot ordering | 42294123412 | workflow_dispatch | completed | success | - | - | success |
| GoTavern drop-in qualification | 42294127433 | workflow_dispatch | completed | success | - | - | success |
| Browser differential | 42294131712 | workflow_dispatch | completed | success | - | - | success |
| GoTavern release qualification | 42294137094 | workflow_dispatch | completed | success | - | - | success |
| GoTavern smoke metrics | 42294141379 | workflow_dispatch | completed | success | - | - | success |
| GoTavern Docker image | 42294146024 | workflow_dispatch | completed | success | - | - | success |
| Helper state differential | 42294150962 | workflow_dispatch | completed | success | - | - | success |
| Combination journey differential | 42294155456 | workflow_dispatch | completed | success | combination-journey | combination-journey-evidence (combination-journey-evidence) | success |
| Third-party extension compatibility | 42294159806 | workflow_dispatch | completed | success | - | extension-compat-evidence | success |
| GoTavern long-lived corpus qualification | 42294164369 | workflow_dispatch | completed | success | medium-corpus | longlived-medium-evidence (gotavern-longlived-corpus-evidence) | success |
| GoTavern Node stock tree round trip | 42294168373 | workflow_dispatch | completed | success | node-stock-tree | node-stock-tree-evidence (gotavern-node-stock-tree-evidence) | success |

**PASS**: 13/13 required workflow(s) are green at this SHA.
```

## What this table does and does not prove

It proves: every required workflow has a completed, successful `workflow_dispatch` run whose `head_sha`
is the candidate; the rows with required jobs have those jobs completed/success inside the cited run
(`combination-journey`, `medium-corpus`, `node-stock-tree`); the rows with required artifacts carry them
(`combination-journey-evidence`, `extension-compat-evidence`, `longlived-medium-evidence`,
`node-stock-tree-evidence`); and the embedded-evidence rails validate the artifact content (tier and
truthy field contracts, 64-hex digests, the recorded macos-arm64 platform limitation carried inside the
extension-compat evidence, and the release-evidence contract for the combination journey).

It does not prove: the real-private-tree claim of GOAL.md section 14 (synthetic scope only), darwin/arm64
runtime execution (recorded platform limitation; the archive is proved to be a thin arm64 Mach-O and the
build contract is re-asserted, but it is not executed), the macos-arm64 extension lifecycle (recorded
limitation; the Windows and macOS-x64 representative legs still run), or any capability it does not name.
The publish job re-runs this same program against the exact tag target before it uploads anything; a
missing, narrowed, expired-artifact, wrong-SHA or non-success row refuses by name.

## Companion records

- `docs/alpha16/m6-rehearsal.md` - the 13 dispatch rows, the dry-run result and the residual register.
- `docs/alpha16/handoff-ledger.md` - the program ledger and the honest release conclusion.
- The dry run at the same candidate: `GoTavern Release` run `42294172571` (completed/success) - six
  archives built, `execute-darwin-amd64`, `execute-linux-arm64`, `windows-arm64-boundary`,
  `darwin-arm64-recorded-downgrade`, `prepublish-qualification` and `publish` all green, with every
  tag-only publish step skipped and no release created; artifact `darwin-arm64-platform-limitation`
  present.
