## Unified release evidence contract (`a41772152a76cd3c42c52b63f2a377e2963de6fd`)

Kind `gotavern-release-evidence` schemaVersion 1. Generated from the Actions API by `scripts/release-governance/release-evidence.mjs`; deterministic (no clock value).

**Overall: PASS** - 13/13 required gate(s) green at this SHA.

| workflow | run | event | verdict | required jobs | artifact (digest) | embedded evidence | selection |
|---|---|---|---|---|---|---|---|
| GoTavern CI | 42465368654 | workflow_dispatch | success | changes=success, browser-evidence=success, verify=success, crash-gate=success, race=success, oracle=success | - | - | proven (display-title) |
| GoTavern whole-session differential | 42465370968 | workflow_dispatch | success | whole-session=success | - | - | proven (jobs) |
| GoTavern world-info slot ordering | 42465373081 | workflow_dispatch | success | worldinfo-slots=success | - | - | proven (jobs) |
| GoTavern drop-in qualification | 42465375433 | workflow_dispatch | success | dropin-current-head=success, windows-inputs=success, dropin-windows=success | - | - | proven (jobs) |
| Browser differential | 42465378269 | workflow_dispatch | success | differential=success | - | - | proven (display-title) |
| GoTavern release qualification | 42465380701 | workflow_dispatch | success | qualify-linux-amd64=success, qualify-windows-amd64=success, qualify-dropin-linux=success, qualify-published-alpha9-upgrade=success, qualify-upgrade-rollback=success | - | - | proven (jobs) |
| GoTavern smoke metrics | 42465383084 | workflow_dispatch | success | measure-linux-amd64=success, paired-linux-amd64=success | - | - | proven (jobs) |
| GoTavern Docker image | 42465385438 | workflow_dispatch | success | docker=success | - | - | proven (jobs) |
| Helper state differential | 42465387697 | workflow_dispatch | success | helper state differential (ubuntu, bounded)=success | - | - | proven (jobs) |
| Combination journey differential | 42465389791 | workflow_dispatch | success | combination-journey=success | combination-journey-evidence (sha256:d44ccc5f3add96ddb80398f151d77a37ec50ce1fd3019449c60db1745d3f4b8d) | kind=combination-journey-evidence, tier=full, pinnedSha=06bde939fb1e9c4c8d8641d810f0a916b5bce127 | proven (evidence) |
| Third-party extension compatibility | 42465391902 | workflow_dispatch | success | selftest=success, aggregate=success, corpus=success, soak=success, overhead=success, macos-arm64-recorded-limitation=success | extension-compat-evidence (sha256:d98ba7ff94a291b522c4b632302b74b9bfa3b7ff3ce21ba7680ead2b7f02a89e) | - | proven (jobs) |
| GoTavern long-lived corpus qualification | 42465394362 | workflow_dispatch | success | medium-corpus=success | longlived-medium-evidence (sha256:f9b902668f91119ac3d6138e016c6932428e7bf9a191f78325f8fa444c84eaf0) | kind=gotavern-longlived-corpus-evidence, tier=medium | proven (evidence) |
| GoTavern Node stock tree round trip | 42465396530 | workflow_dispatch | success | node-stock-tree=success | node-stock-tree-evidence (sha256:e2201ceb6d027181c230fb9657e7ee8db94f98e145f10ce75dd04554c479e3c2) | kind=gotavern-node-stock-tree-evidence, pinnedSha=06bde939fb1e9c4c8d8641d810f0a916b5bce127 | proven (jobs) |

### Fields the Actions API cannot answer (recorded, not invented)

- `dispatchInputs`: the Actions runs API exposes no dispatch inputs for a run: the workflow_run object has no `inputs` member (verified against GitHub API run 42340311363 on 2026-11-07) and display_title carries the workflow name, not the inputs. The dispatch selection is therefore proven from required jobs / embedded evidence where the manifest names a requiredSelection, and recorded as unverifiable otherwise -- never inferred from a title or invented
- `selectedTests`: per-gate test selection/execution counts are not exposed by the Actions API; they live in each run log, which this document does not parse. Where a gate's embedded evidence document carries a count it is recorded under gates[].tests with its source; otherwise it stays null
- `executedTests`: per-gate test selection/execution counts are not exposed by the Actions API; they live in each run log, which this document does not parse. Where a gate's embedded evidence document carries a count it is recorded under gates[].tests with its source; otherwise it stays null
- `unexecutedTests`: per-gate test selection/execution counts are not exposed by the Actions API; they live in each run log, which this document does not parse. Where a gate's embedded evidence document carries a count it is recorded under gates[].tests with its source; otherwise it stays null
- `tier`: the release has no single tier: the combination journey requires tier=full and the long-lived corpus requires medium, while other gates have none. Per-gate tiers are recorded under gates[].tier only where an embedded evidence document names them; a single release-wide value would be invented
- `negativeControl`: no gate on this wave is required to carry a negative-control/teeth member in its embedded evidence, and the Actions API does not expose one

### Selection proof

- proven from the API: GoTavern CI, GoTavern whole-session differential, GoTavern world-info slot ordering, GoTavern drop-in qualification, Browser differential, GoTavern release qualification, GoTavern smoke metrics, GoTavern Docker image, Helper state differential, Combination journey differential, Third-party extension compatibility, GoTavern long-lived corpus qualification, GoTavern Node stock tree round trip
- unverifiable (the manifest names no requiredSelection, so the dispatch inputs are not exposed): none
- narrowed (refused): none

Pinned oracle commit: `06bde939fb1e9c4c8d8641d810f0a916b5bce127` (manifest.pinnedSha (the release baseline policy))

