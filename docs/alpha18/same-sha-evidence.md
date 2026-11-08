# alpha.18 same-SHA evidence

**Status: PASS — 13/13 required workflows green at the frozen candidate
`a41772152a76cd3c42c52b63f2a377e2963de6fd`.** This is the pre-tag record; the publication facts are
appended by `docs/alpha18/handoff-ledger.md` and the post-publication commit.

## 1. The candidate

| fact | value |
|---|---|
| candidate | `a41772152a76cd3c42c52b63f2a377e2963de6fd` (`fix(alpha18): normalise the chat-backup timestamp in the runtime-roundtrip oracle`) |
| parent | `2216617` — the release-record candidate; the ONLY difference is the oracle probe normalisation and its re-recorded fixture (test infrastructure; the shipped binary is unchanged) |
| baseline | SillyTavern `1.19.0` @ `06bde939fb1e9c4c8d8641d810f0a916b5bce127` |
| pinned oracle | mounted from `.reference` at the same commit; `Makefile`/`scripts` pinned checks passed inside the oracle job |

## 2. Verifier output (official command, same as the publish step)

```text
## Same-SHA release gate for `a41772152a76cd3c42c52b63f2a377e2963de6fd`
| required workflow | run | event | status | conclusion | required jobs | evidence | verdict |
| GoTavern CI | 42465368654 | workflow_dispatch | completed | success | changes, browser-evidence, verify, crash-gate, race, oracle | - | success |
| GoTavern whole-session differential | 42465370968 | workflow_dispatch | completed | success | whole-session | - | success |
| GoTavern world-info slot ordering | 42465373081 | workflow_dispatch | completed | success | worldinfo-slots | - | success |
| GoTavern drop-in qualification | 42465375433 | workflow_dispatch | completed | success | dropin-current-head, windows-inputs, dropin-windows | - | success |
| Browser differential | 42465378269 | workflow_dispatch | completed | success | differential | - | success |
| GoTavern release qualification | 42465380701 | workflow_dispatch | completed | success | qualify-linux-amd64, qualify-windows-amd64, qualify-dropin-linux, qualify-published-alpha9-upgrade, qualify-upgrade-rollback | - | success |
| GoTavern smoke metrics | 42465383084 | workflow_dispatch | completed | success | measure-linux-amd64, paired-linux-amd64 | - | success |
| GoTavern Docker image | 42465385438 | workflow_dispatch | completed | success | docker | - | success |
| Helper state differential | 42465387697 | workflow_dispatch | completed | success | helper state differential (ubuntu, bounded) | - | success |
| Combination journey differential | 42465389791 | workflow_dispatch | completed | success | combination-journey | combination-journey-evidence | success |
| Third-party extension compatibility | 42465391902 | workflow_dispatch | completed | success | selftest, aggregate, corpus, soak, overhead, macos-arm64-recorded-limitation | extension-compat-evidence | success |
| GoTavern long-lived corpus qualification | 42465394362 | workflow_dispatch | completed | success | medium-corpus | longlived-medium-evidence | success |
| GoTavern Node stock tree round trip | 42465396530 | workflow_dispatch | completed | success | node-stock-tree | node-stock-tree-evidence | success |

**PASS**: 13/13 required workflow(s) are green at this SHA.
```

The full machine-readable document is `docs/alpha18/release-evidence.json`; the markdown is
`docs/alpha18/release-evidence.md`; the publish job re-runs the SAME verifier inside `GoTavern Release`
and refuses to publish when it does not pass, so the release body cannot disagree with this record.

## 3. Selection proofs the rails required

- `GoTavern CI`: dispatched with an empty `-f probes=`, so the run's display title reads
  `GoTavern CI probes=full` (the API exposes no dispatch inputs; the run name is the proof, committed in
  `ci.yml` before the candidate).
- `Browser differential`: dispatched with `-f mode=all`, title `Browser differential mode=all`.
- Artifact gates: the verifier downloaded and checked `combination-journey-evidence`,
  `extension-compat-evidence`, `gotavern-longlived-corpus-evidence` and
  `gotavern-node-stock-tree-evidence` from these runs (digest + freshness + embedded pinned member);
  the four rows above would have refused a stale or foreign artifact.
- Wrong-SHA, wrong-event, skipped-required-job and narrowed-selection refusals are proven with real runs in
  `docs/alpha18/evidence-contract.md` §2/§3: an accepted Docker full-selection run, a refused
  `long-lived -f size=small` dispatch (skipped `medium-corpus`), a refused pre-run-name alpha.17 title,
  and a wrong-SHA `missing` verdict.

## 4. The first wave at `2216617` was NOT published, and why

The wave dispatched at `2216617` (the release-record commit) had 12 of 13 gates green but:

- **`GoTavern CI` run `42444382437` failed in the `oracle` job.** The alpha.18 chat auto-backup implements
  pinned's timestamped filename, and the runtime-round-trip probe's double run observed
  `chat_round_trip_probe_20261108-055942.jsonl` in run 1 and `...-060047.jsonl` in run 2, so the oracle
  correctly reported "oracle changed across identical pinned Node runs". The fix (normalise the timestamped
  backup path, resolve the recorded `<timestamp>` path back to the one file on disk, re-record the fixture to
  add exactly that entry) is the `a417721` commit; the probe then recorded
  `pinned deltas over GoTavern: added 0, changed 0, removed 0` with the double run enabled.
- **`Browser differential` run `42444390807` failed in the asset leg.** Both subjects failed the SAME
  driver check (`the gallery tile click did not select the staged tile ... the delegated .bg_example click
  handler is NOT BOUND`) and the helper/Q20 legs "failed to drive, so there is no comparison to judge" —
  an environment/driver failure, not a product difference (a subject-identical failure cannot be a
  parity claim). The re-run at the same frozen candidate `a417721` succeeded
  (`42465378269`), and the reasoning is recorded rather than hidden.

A wave is evidence only when ALL of it is green at one SHA; the failed wave is therefore recorded here and the
release waits for the re-run. No tag was created from `2216617`, and the failed runs are not counted as gates.

## 5. Reproduce

```bash
GH_TOKEN=$(gh auth token) GITHUB_REPOSITORY=cocokoishi/GoTavern \
node scripts/verify-release-gates.mjs --sha a41772152a76cd3c42c52b63f2a377e2963de6fd \
  --manifest docs/release-manifest.json \
  --release-evidence-out /tmp/release-evidence.json \
  --release-evidence-md-out /tmp/release-evidence.md \
  --workflow 'GoTavern Release' --event workflow_dispatch
```

The thirteen dispatches used: `ci.yml -f probes=`, `whole-session.yml`, `worldinfo-slots.yml`,
`dropin-qualification.yml`, `browser-differential.yml -f mode=all`, `release-qualification.yml`,
`smoke-metrics.yml -f requests=50`, `docker.yml`, `helper-state.yml`,
`combination-journey.yml -f profile=e03e04 -f tier=full -f extension_tier=full`,
`third-party-extension-compat.yml -f mode=full`, `longlived.yml -f size=medium`, `node-stock-tree.yml`.
