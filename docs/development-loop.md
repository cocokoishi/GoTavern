# The development loop: what to run, when, and why

This file exists because the project's own guidance made the cheap loop look expensive. An agent that
believes every answer costs a GitHub round trip will batch changes, push to find compile errors, and wait
tens of minutes for a verdict it could have had in seconds. Measured on the development host
(2 logical cores, 12 GB RAM, Go 1.27.0 windows/arm64, Node 24.19.0):

| check | measured | what it proves |
|---|---|---|
| `gofmt` (LF form) | < 1 s per file | the committed bytes are formatted |
| `go build ./...` | **9.1 s** cold, < 1 s warm | the module compiles |
| `go test ./internal/<pkg> -run <X> -count=1` | **19 s** | one behaviour's unit + plan-level tests |
| `go test ./... -count=1` | **116 s** | every Go test, including every fixture replay |
| GitHub `verify` job (build+vet+test) | 84–210 s **plus queue** | the same, on a clean Linux box |
| `oracle` job, narrowed to one probe | **13–15 min** | pinned Node vs GoTavern, re-recorded |
| `oracle` job, every probe | **51 min** (observed max) | the full parity sweep |

So the toolchain is not the bottleneck. The oracle is, and only for the things only it can decide.

## Tiers

**Tier 0 — seconds.** `node scripts/dev-verify.mjs`. It classifies your changed files, picks the smallest
falsifying set, runs it, and prints what it decided and why. Escalation is automatic and only ever widens:
a per-source transport runs that package; a shared dispatch surface (`chat_completions.go`,
`backends_status.go`, `sd*`, `internal/outbound`, `internal/startup`, `tools/lib`) widens to every package.

**Tier 1 — one package + its provider scenarios.** Still local. `go test ./internal/server -run XAI -count=1`
plus `node tools/verify-browser-comparisons.mjs` when a comparison artifact or its gate moved. This is the
tier that replaces "push and read the CI failure", which is the habit this whole document is about.

**Tier 2 — broader integration.** Shared middleware, auth/session, config/startup, routing, request parsing,
streaming, persistence, the shared HTTP client, secrets, or static-asset routing. Locally that is
`--full` (116 s). Remotely it is the normal push, which selects the probes whose fixtures can move.

**Tier 3 — the full oracle.** Pinned Node vs GoTavern, every probe. It runs on:

- the nightly cron (`17 4 * * *`);
- a `workflow_dispatch`, with an empty `probes` input for everything or a list for a named subset;
- a push that touches a shared harness input (`tools/lib/**`, the generator, `upstream/**`), because such a
  change can move any fixture;
- a release candidate, by using the same dispatch.

It must never be the default for an ordinary provider change, and it must never be skipped for a change that
CAN move a fixture. The `changes` job in `.github/workflows/ci.yml` is the single place that decision lives,
and it resolves the mapping by grepping the probes' own `@gotavern-oracle: fixture=` declarations, so the
mapping cannot drift away from the probes.

## What is not locally verifiable, and must not be pretended otherwise

A **provider-wire capture** needs the pinned Node server talking to a controlled peer. Replaying a committed
fixture locally proves the Go side only; producing a NEW capture requires a recording run. `dev-verify.mjs`
prints every such path under "NOT verifiable locally" instead of returning a green that means less than it
looks.

## The loop an agent should follow

1. Read the target source and its tests/probes.
2. `node scripts/dev-verify.mjs --explain` to see what the change can move before writing it.
3. Make the smallest change.
4. `node scripts/dev-verify.mjs` — seconds to two minutes.
5. On failure, diagnose locally. Do not push to let CI find a compile error.
6. If narrow passes, ask whether the change touched a shared surface (the script tells you by escalating).
7. Commit small.
8. Push when a remote, independent proof is genuinely needed — a merge gate, a Linux-only fixture, or a
   scheduled full sweep.
9. Continue with the next task instead of watching the run.

The target is that an agent's thinking time is the bottleneck, not the queue.
