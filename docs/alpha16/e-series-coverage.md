# alpha.16 E-series coverage: what the seeded state-machine lane actually executed

**Status: MEASURED on the Windows/arm64 development host, 2026-11-06, branch `a16/scenarios` (base `main`
`f769b5f`). This file maps the plan's E01-E09 environment matrix (docs/alpha16-agent-execution-plan.md
section 3) to (a) the harness that already covers it, (b) what the new seeded state-machine lane adds, and (c)
what is still UNEXECUTED. It exists so a reader cannot mistake a green in this lane for browser, provider or
cross-OS coverage this lane never ran.**

## 1. What this lane added, in one paragraph

A deterministic seeded scenario recipe layer (`internal/longlivedfixture/recipe.go`) on top of the existing
corpus schema, and a real state-machine driver (`tests/e2e/scenario_state_machine_test.go`) that boots the
actual server object in-process through `internal/app.Start` on a generated eight-account data root and drives
**100 seeds x 10 declared operations, executed twice per seed = 2,000 reproducible operation sequences** over
real HTTP routes and real disk. The lane also carries a teeth self-test
(`tests/e2e/scenario_state_machine_teeth_test.go`) whose 14 planted defects each produce their NAMED red
through the same comparator functions the live driver calls.

Measured on this host (Windows/arm64, `go1.27.0`, `-count=1`):

| artefact | measurement |
| --- | --- |
| recipe layer tests (`go test ./internal/longlivedfixture -run 'TestSeeded\|TestRecipe'`) | 6 tests, 0.39 s |
| driver (`TestSeededStateMachineQualification`) | 100 seeds, 2,000 operation entries, 4 same-data-root restarts, 516 planted files, ~18-20 s |
| teeth (`TestScenarioStateMachineTeeth`) | 14/14 planted defects produced their named assertion, 0.00 s |
| the lane's two tests run twice with `-count=1` | `ok` both times, 18.8 s / 18.9 s of test execution |

Replay command:

```
go test ./tests/e2e -run 'TestSeededStateMachine|TestScenarioStateMachineTeeth' -count=1
```

Recipe/unit gate:

```
go test ./internal/longlivedfixture -run 'TestSeeded|TestRecipe' -count=1
```

Determinism: a recipe is a pure function of its seed (same seed -> byte-identical manifest and canonical
preboot tree SHA-256; different seed -> different tree hash and artifact digests; measured in
`TestSeededRecipeIsDeterministic`, `TestSeededRecipeDiffHasTeeth` and
`TestSeededRecipePrebootDigestMatchesTheGeneratedTree`). Nothing in the lane reads
the wall clock for assertions, sleeps, reaches the network, or calls a provider. The only socket is the
loopback listener the test itself asks the kernel for.

## 2. E01-E09 verdicts

Legend: **EXECUTED HERE** = this lane ran it and asserts on real observables. **PARTIAL HERE** = this lane
touches the environment but not the whole profile. **ELSEWHERE** = another committed harness covers it and this
lane does not re-run it (so this lane's green says nothing about it). **UNEXECUTED** = nobody in this lane ran
it; it is not a claim.

| ID | Profile | Covered by (existing) | What the seeded lane adds | Verdict for this lane |
| --- | --- | --- | --- | --- |
| E01 | Fresh install | `internal/app` startup tests, `tests/e2e/startup_data_root_test.go`, packaged release gates | boots a fresh install root with the shipped `app.Start`; the generated preboot tree is planted before boot | **PARTIAL HERE** (boot path only; pinned defaults/import/first-generation are not re-asserted by this lane) |
| E02 | Long-lived normal (3-5 y history, 100+ cards, groups, books) | `internal/longlivedfixture` complex instance, `tests/e2e/longlived_complex*_test.go`, browser corpus | none: recipes currently describe only the E06 state-machine environment | **ELSEWHERE** (not this lane) |
| E03 | Complex prompt laboratory (120+ prompts, nesting, token boundaries) | `tests/browser/combination-journey-probe.mjs` + `combination-journey.yml` `profile=e03e04`, tiered fast/medium/full | none: this lane makes zero provider requests and cannot observe prompt order | **UNEXECUTED HERE**; covered only by the separate browser gate, which this lane did not run |
| E04 | Extension collision laboratory (20 locked extensions, helper+QR+regex+variables) | same browser gate + `tests/browser/third-party-extensions-run.mjs` | none: no browser is launched and no pinned extension is installed | **UNEXECUTED HERE**; the E03/E04 browser legs are a separate gate and must not be read into this lane |
| E05 | Dirty / legacy (old formats, unknown fields, partial/corrupt inputs, permissions) | `tests/e2e/a15_corrupt_data_test.go`, `a15_external_modification_test.go`, `longlived_*` unknown files | unknown-file SHA-256 preservation across every operation and four restarts; JSON/JSONL validity after every operation | **PARTIAL HERE** (unknown-file preservation and JSON validity only; no corrupt/legacy/permission inputs) |
| E06 | Multi-account concurrency (>=8 users; overlapping save/load/delete/rename; cross-user isolation; concurrent streaming) | `tests/e2e/a15_concurrent_writers_test.go` (two processes, one data root), `internal/server` account tests | 8 real accounts, 100 seeds each authenticated separately, a cross-account read on every seed (settings GET + chats GET inside the next account's session, asserting no marker leaks), settings/chat write per account | **EXECUTED HERE (partial profile)**: isolation and the per-account state machine are measured; CONCURRENT overlapping writes from the eight accounts and concurrent provider streaming are NOT run by this lane |
| E07 | Network & proxy (TLS peer, redirects, streaming chunks, cancellation, credential boundary) | `tests/e2e/transport_internet_shape_test.go`, `tests/e2e/deepseek_generate_test.go`, `tests/mockprovider`, proxy tests | none: recipes declare `maxProviderRequests: 0` and the lane makes no outbound request | **UNEXECUTED HERE** |
| E08 | Crash / recover / hand-back (kill at persistence stages, EFBIG, restart, Node->Go->Node) | `a15_*_crash_test.go`, `a15_efbig_*_test.go`, migration tests | kill the server OBJECT (`RunningServer.Close`) and boot a new one on the SAME data root after every 25-seed batch (4 restarts); assert new instance, same root, settings markers, preboot chat order and unknown-file digests survive; `TestSeededStateMachineQualification` also proves a wrong root and a reused instance are named reds in the teeth test | **PARTIAL HERE** (clean object restart + resume only; no SIGKILL mid-write, no EFBIG, no Node<->Go hand-back) |
| E09 | Operational matrix (Linux/container, Windows, macOS; install/startup/browser/proxy) | CI `ci.yml`/`lane.yml` on `ubuntu-latest`; Windows installer qualification jobs | runs in-process on Windows/arm64 **only** in this lane; paths are `filepath`-based and the data root is `t.TempDir()`, but the Linux/macOS legs were not run by this lane | **UNEXECUTED HERE** (Linux is the CI gate; a local Windows green is not a CI verdict) |

## 3. Explicitly unexecuted legs (do not read these as green)

The following were **not executed by this lane** and this lane's evidence cannot speak for them:

1. **Real browser legs.** No Chromium was launched, no page was loaded, no DOM/event state was compared. The
   pinned frontend and the combined E03+E04 browser journey are covered only by
   `.github/workflows/combination-journey.yml`, which this lane did not run and did not modify.
2. **Real extension legs.** The pinned Tavern Helper / JS-Slash-Runner and LittleWhiteBox canaries, and the 20
   locked third-party client extensions, were not installed or executed. No browser-level extension
   interaction is claimed anywhere in this lane.
3. **Real provider legs.** No provider was contacted, real or recorded. There is no provider-wire observation
   here; the recipes declare `maxProviderRequests: 0` and the lane asserts none is needed.
4. **Live network.** No live network call was made; the only socket is the loopback listener the test asks the
   kernel for, and the HTTP clients are built with `Proxy: nil` so a CI proxy variable cannot divert them.
5. **Crash semantics.** The restart is a clean object close, not a SIGKILL, and EFBIG/ENOSPC are not exercised
   (they remain covered, or explicitly UNPROVEN, in `a15_*`).
6. **Concurrency.** The eight accounts are driven sequentially by one test goroutine. Overlapping
   save/load/delete/rename across accounts, and concurrent provider streaming, are NOT exercised here;
   `a15_concurrent_writers_test.go` covers a different (two-process) concurrency shape.
7. **Linux gate.** The measured run is Windows/arm64 (Layer A evidence). `ubuntu-latest` CI has not judged
   these bytes at the time of writing; a Windows green is not a CI verdict.
8. **E02 corpus.** The seeded recipes describe the E06 state-machine environment only; the long-lived complex
   corpus and its browser/Node legs are unchanged and were not re-run by this lane beyond the existing
   `longlived_*` Go tests, which still pass after the addition.

## 4. Teeth evidence (mutation -> named failing assertion)

`TestScenarioStateMachineTeeth` plants each defect in the OBSERVATION and drives it through the same
comparator the live driver calls. Measured output (14/14):

| planted defect | named assertion observed |
| --- | --- |
| swap-message-order | `message-order-swapped:1:m1->m2` |
| drop-persisted-message | `message-dropped:4:m4` |
| extra-persisted-message | `message-extra:6` |
| wrong-restart-data-root | `restart-data-root-mismatch:/tmp/data-root->/tmp/another-data-root` |
| wrong-restart-pid (same instance object) | `restart-instance-unchanged:1` |
| cross-user-read | `cross-user-read-leaked:SEEDMSG_1601_` |
| cross-user-settings-read | `settings-marker-leaked:SM_SETTINGS_1601` |
| unknown-file-mutated | `unknown-file-mutated:unknown-file` |
| jsonl-corrupt-line | `jsonl-invalid:line-2` |
| restart-lost-settings-marker | `restart-settings-marker-missing:default-user` |
| restart-preboot-chat-dropped | `restart-preboot-chat-missing:1601` |
| restart-preboot-chat-reordered | `restart-preboot-chat-order:1601:message-order-swapped:0:PREBOOT_1601_0->PREBOOT_1601_1` |
| operation-sequence-not-reproducible | `operation-sequence-not-reproducible:1601:step-0` |
| action-plan-operation-replaced | `operation-plan-mismatch:3:chat-load!=chat-save` |

The same test first feeds CORRECT data to every comparator and fails if any of them is red on correct data, so
a comparator cannot pass by always failing.

## 5. Residual gaps and follow-ups

- Extend the recipe layer to the other environment classes (E02/E03/E05) by adding recipes, not by growing this
  driver; the driver's recipe->operation-plan assertion is already generic.
- Run the same driver on `ubuntu-latest` CI (path/permission/CRLF portability is designed for, but not
  measured here). No workflow change was made by this lane; wiring a bounded job is a separate, reviewable
  change.
- A genuine SIGKILL restart leg (kill the process at a persistence stage, not `Close`) belongs beside the
  existing `a15_*_crash_test.go` machinery; this lane deliberately does not dress a clean close up as a crash.
