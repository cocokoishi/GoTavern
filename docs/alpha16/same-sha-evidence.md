# Same-SHA release-gate evidence - alpha.16 candidate `c1886d7` and the published tag

This is the recorded output of the release gate program itself, run against the frozen candidate
`c1886d7`. It is the evidence the publish job's own verifier produces, not a
hand-written checklist.

Command (the same one the publish job runs, with the candidate commit in place of the tag target):

```
node scripts/verify-release-gates.mjs \\
  --sha c1886d7 \\
  --manifest docs/release-manifest.json \\
  --evidence-out <path>
```

Exit status: `0`. Recorded at 2026-11-07 (America/Los_Angeles) from the GitHub Actions API.

## Recorded output

```
## Same-SHA release gate for `c1886d7`

Every required workflow must have a completed, successful run whose `head_sha` is this commit.

| required workflow | run | event | status | conclusion | required jobs | evidence | verdict |
|---|---|---|---|---|---|---|---|
| GoTavern CI | 42340290230 | workflow_dispatch | completed | success | - | - | success |
| GoTavern whole-session differential | 42340292267 | workflow_dispatch | completed | success | - | - | success |
| GoTavern world-info slot ordering | 42340294045 | workflow_dispatch | completed | success | - | - | success |
| GoTavern drop-in qualification | 42340295948 | workflow_dispatch | completed | success | - | - | success |
| Browser differential | 42340297957 | workflow_dispatch | completed | success | - | - | success |
| GoTavern release qualification | 42340299880 | workflow_dispatch | completed | success | - | - | success |
| GoTavern smoke metrics | 42340301718 | workflow_dispatch | completed | success | - | - | success |
| GoTavern Docker image | 42340303463 | workflow_dispatch | completed | success | - | - | success |
| Helper state differential | 42340305321 | workflow_dispatch | completed | success | - | - | success |
| Combination journey differential | 42340307249 | workflow_dispatch | completed | success | combination-journey | combination-journey-evidence (combination-journey-evidence) | success |
| Third-party extension compatibility | 42340309242 | workflow_dispatch | completed | success | - | extension-compat-evidence | success |
| GoTavern long-lived corpus qualification | 42340311363 | workflow_dispatch | completed | success | medium-corpus | longlived-medium-evidence (gotavern-longlived-corpus-evidence) | success |
| GoTavern Node stock tree round trip | 42340313131 | workflow_dispatch | completed | success | node-stock-tree | node-stock-tree-evidence (gotavern-node-stock-tree-evidence) | success |

**PASS**: 13/13 required workflow(s) are green at this SHA.
```

## What this table does and does not prove

It proves: every required workflow has a completed, successful `workflow_dispatch` run whose `head_sha` is
the candidate; the rows with required jobs have those jobs completed/success inside the cited run
(`combination-journey`, `medium-corpus`, `node-stock-tree`); the rows with required artifacts carry them
(`combination-journey-evidence`, `extension-compat-evidence`, `longlived-medium-evidence`,
`node-stock-tree-evidence`); and the embedded-evidence rails validate the artifact content (tier and truthy
field contracts, 64-hex digests, the recorded macos-arm64 platform limitation carried inside the
extension-compat evidence, and the release-evidence contract for the combination journey).

It does not prove: the real-private-tree claim of GOAL.md section 14 (synthetic scope only - NOT MET), darwin/arm64
runtime execution (recorded platform limitation; the archive is proved to be a thin arm64 Mach-O and the build
contract is re-asserted, but it is not executed), the macos-arm64 extension lifecycle (recorded limitation; the
Windows and macOS-x64 representative legs still run), the 8-user latency row (report-only; its gate is not
ratifiable on the shared runner pool, see docs/alpha16/m5-evidence.md sections 10-12), the E01-E09 environments
this release did not execute (docs/alpha16/e-series-coverage.md), or any capability the release notes do not name.
The publish job re-runs this same program against the exact tag target before it uploads anything; a missing,
narrowed, expired-artifact, wrong-SHA or non-success row refuses by name.

## Companion records

- `docs/alpha16/handoff-ledger.md` - the program ledger and the published release record (section 12).
- `docs/alpha16/m6-rehearsal.md` - the 13 dispatch rows, the dry-run result and the final-wave section.
- The dry run at the same candidate: `GoTavern Release` run `42340315205` (completed/success) - six archives
  built and archive-inspected, `execute-darwin-amd64`, `execute-linux-arm64`, `windows-arm64-boundary`,
  `darwin-arm64-recorded-downgrade`, `prepublish-qualification` and `publish` all green, with every
  tag-only publish step skipped and no release created; artifact `darwin-arm64-platform-limitation` present.
- The candidate is also `c1886d7` in prose; the full SHA is used only in commands and the table.