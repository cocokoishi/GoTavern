# P0 baseline: build, provider-wire oracle, `internal/server` suite (local Layer A)

Owner: Subagent B (compat-diff). Date: 2026-11-08, host `windows/arm64`, 2 logical cores.
**Label: LOCAL Layer A.** A Windows result is not the CI gate (`AGENTS.md` working mode); the Linux
`GoTavern CI` run named below is the gate for this code.

## 1. Source identity

| field | value | how |
|---|---|---|
| branch | `alpha19/program` | `git rev-parse --abbrev-ref HEAD` |
| HEAD when the build started | `07af095` | `git rev-parse HEAD` before the build |
| HEAD after the build | `423b02a` | Lead's docs-only commit landed during the build |
| code difference between them | **none** | `git diff --name-only 07af095d 423b02a1` = 5 files, all `docs/alpha19/*`; `git diff --stat 07af095d 423b02a1 -- '*.go' '*.mjs'` empty |

## 2. Build

| command | elapsed | result |
|---|---|---|
| `go build ./...` | **26,069 ms** | exit 0 |
| `go build -trimpath -o <scratch>\bin\gotavern.exe ./cmd/gotavern` | **8,305 ms** | exit 0 |

Artifact (scratch, outside the repo — `C:\Users\koishi\Desktop\GoTavern\a19-diff\bin\gotavern.exe`):

```
sha256  C756A9F748032E22B1BDC9FDFE90FB5399E279A4083CDF75F86375389685C883
bytes   67,331,072
```

`gotavern.exe version` on that artifact:

```
GoTavern 0.0.0-dev
SillyTavern baseline 1.19.0 (06bde939fb1e9c4c8d8641d810f0a916b5bce127)
```

`0.0.0-dev` is expected: the version is injected from the tag by `release.yml`, and this is a local build
(`cmd/gotavern/main.go`'s default), exactly as `CHARTER.md` §1.2 records for the previous round.

## 3. Pinned oracle state used as the input to the replay

| field | value | how |
|---|---|---|
| checkout | `C:\Users\koishi\Desktop\GoTavern\SillyTavern` | `run-against-pinned.mjs` default resolution |
| HEAD | `06bde939fb1e9c4c8d8641d810f0a916b5bce127` | `git rev-parse HEAD` |
| tracked modifications | none (`git status --porcelain` yielded 0 lines) | `git status --porcelain` |

The byte manifest for this tree is the Lead's `docs/alpha19/oracle-pin.sha256` / `oracle-pin.json`
(906 files, 61,049,059 bytes, tree digest `41d91cd6…`); this note records only the checkout state at baseline.

## 4. Provider-wire oracle replay — GREEN

```
go test ./internal/server -run 'TestChatCompletionGenerateMatchesProviderWireCapture' -count=1 -v
```

| field | value |
|---|---|
| verdict | **PASS** |
| subtests | **262 PASS / 0 FAIL** (`--- PASS:` lines counted from the `-v` log) |
| package line | `ok  github.com/cocokoishi/gotavern/internal/server  63.433s` |
| wall time | 72,193 ms |
| log | `C:\Users\koishi\Desktop\GoTavern\a19-diff\oracle-provider-wire.log` |

This is the byte-oriented provider-wire replay against
`tests/oracle/sillytavern-1.19.0-provider-wire.json`: it proves the **existing** provider-wire contract is
green at this tree. It does not prove the alpha.19 real-UI corpus, which does not exist yet.

## 5. Full `internal/server` suite — one LOCAL red, classified

```
go test ./internal/server -count=1
```

| attempt | result |
|---|---|
| suite run | **FAIL** in 48.875 s (wall 59,247 ms) |
| `-run '^TestAccountResetInterleavedWithSavesDoesNotCorruptOrCrossUserData$'` attempt 1 | **FAIL** in 22.0 s |
| attempt 2 | PASS (3 seeds, 25.1 s) |
| attempt 3 | PASS (3 seeds, 22.2 s) |

Failure text (verbatim, from the suite log):

```
panic: Fail in goroutine after TestAccountResetInterleavedWithSavesDoesNotCorruptOrCrossUserData/seed1 has completed
  testing.(*common).Errorf(...)
  github.com/cocokoishi/gotavern/internal/server.runResetSaveProbe.func1()
      internal/server/account_reset_save_race_test.go:573
  created by ...runResetSaveProbe in goroutine 41
      internal/server/account_reset_save_race_test.go:565
FAIL github.com/cocokoishi/gotavern/internal/server 48.875s
```

### Classification

- **Not a CI red.** The Linux gate for the same code is green: workflow `GoTavern CI`, run **42478540221**,
  headSha `52883e8a…`, conclusion **success** (`gh run list --workflow 'GoTavern CI'`).
- **A test-harness defect, exposed by a Windows scheduling flake**, reproduced **2 of 5** local attempts, in a
  different seed each time (`/seed1`, `/seed2`).
  Writer goroutines started at `:565-579` call `t.Errorf` at `:573`. Any `t.Fatalf` in the body before
  `writers.Wait()` at `:613` (the reset-status checks at `:587`, `:604`, `:609`, `:618`) returns from the
  subtest while those writers are still in flight; a writer that then sees an unexpected status calls
  `t.Errorf` on a finished `*testing.T`, and Go **panics**, aborting the test binary and **discarding the
  original `t.Fatalf` message** that says what actually happened.
- Consequence: on this host the suite's verdict is not readable — a red is "a panic", not "the assertion
  that fired". That is the same "evidence that reads as proof but cannot fail" family as AGENTS rule 7: the
  panic replaces the real failure with an unrelated one.
- **Proposed fix (test-only, needs Lead approval + a disjoint write window because it is `internal/server`):**
  writers record outcomes into a mutex-guarded slice instead of calling `t.Errorf`; the body joins the writers
  on every exit path (defer a `writers.Wait()` + `readerDone.Wait()` that is safe to call twice, or run the
  body in a helper that returns problems and assert after the joins), so the real assertion is the one that
  reports. Teeth: mutate one writer's status check to accept `503` and require the *named* assertion, not a
  panic, to go red. This is not done here: `internal/**` needs Lead approval and one writer at a time.

### Residual risk of this baseline

- The local suite red is a host flake in a test's goroutine bookkeeping; it does **not** show the product
  corrupts data (the test's own data assertions passed on the 3 attempts that completed, and Linux CI is
  green). It **does** mean "local full suite green" is not available as a baseline claim today.
- Everything in this file is Layer A. The gate remains the Linux CI run at the cited SHA.
