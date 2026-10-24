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

## The division of labour: this host is the worker, Actions is the gate

Measured on this host with a warm cache, after one cold run:

| work | this host (2-core) | GitHub x86 runner |
|---|---|---|
| `go build ./cmd/gotavern`, nothing changed | **2.95 s** | 11.2 s step + 10.3 s setup-go + 262 MB cache restore |
| one provider's tests (`-run Xai`, warm) | **3.1 s** | — |
| `go test ./internal/outbound` (warm) | **1.37 s** | — |
| `go test ./internal/server` (whole package) | **95.2 s** | 38.1 s |
| `go test ./...` (whole suite) | **123.0 s** | 56.4 s |
| one cold run, modules not yet downloaded | 72–78 s | — |
| the whole `verify` job, door to door | — | **158 s** |

Two conclusions that decide the design, and they point in opposite directions:

- **Incrementally, this host wins by an order of magnitude.** A warm provider edit costs 6-7 s here (7.2 s measured on a one-file change to `internal/server/chutes_chat.go`: gofmt 0.4 s, the targeted test 3.3 s, the build 3.1 s) against a
  158 s round trip through the runner. That is the loop an agent should actually use.
- **At full width, the runner wins.** The whole suite is 2.2× slower here, and the six-platform cross-compile
  is a gate, not a development step. Copying the CI job onto this host would be slower AND would prove the same
  thing, so the fast tier deliberately does neither.

Therefore: `scripts/dev-verify.mjs` builds `./cmd/gotavern` (the artifact that ships) rather than `./...`, runs the
changed package's tests rather than the suite, derives a `-run <Provider>` pattern when exactly one provider
changed (95 s → 3 s), and formats only the files you touched. It escalates to `./...` only when a shared surface
moved, and it never pretends to have checked a fixture.

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
- a push that touches a shared harness input (`tools/lib/**`, the generator, `upstream/**`) or any path the
  planner cannot attribute, because such a change can move any fixture;
- a release candidate, by using the same dispatch.

It must never be the default for an ordinary provider change, and it must never be skipped for a change that
CAN move a fixture. That decision lives in CODE, not in YAML: `tools/oracle/manifest.mjs` derives one
dependency graph from the probes' own `@gotavern-oracle: fixture=` declarations -- each probe's script,
`tools/lib/` when it imports the harness, `tests/provider-wire/scenarios/` when it reads them, every
`tools/<helper>/` Go program it runs, and a `go-product` edge when it records GoTavern's own output -- and
`tools/oracle/plan.mjs` turns a changed-file list into a JSON plan. `tests/oracle/plan.test.mjs` is the
table test over every rule and runs in the `verify` job. The `changes` job now only produces the
changed-file list and reads that plan.

Skipping the oracle is possible only when every changed path is on the planner's explicit irrelevant list,
and that list excludes the control plane: a change to `ci.yml`/`lane.yml` or to the probe execution
primitive forces a FULL sweep, because a change to the gate that selects work is not evidence that the
selection is right -- it is the thing under test.
Anything else -- a Go change, an unknown directory, a path nothing declares -- forces a FULL sweep with the
reason printed beside the decision. **The residual risk, stated rather than papered over:** a Go change that
moves a fixture through a dependency the derivation cannot see is caught only by the nightly full sweep,
because the per-push planner has no way to attribute it.

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
