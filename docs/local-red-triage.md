# Local red triage: the four `go test ./...` failures on Windows/arm64

Task: `task-3`. Host: `go version go1.27.0 windows/arm64`, `GOROOT=C:\Program Files\Go`,
HEAD `292905f`. All four failures are reproduced below, and all four are classified from an
observation I made, not from plausibility.

## Verdict in one line

**None of the four is a product bug.** All four have ONE root cause, and it is a Windows
environment-variable semantic that two pieces of *test* code do not account for: on Windows an
environment variable name is case-insensitive, so `os.Unsetenv("https_proxy")` deletes
`HTTPS_PROXY`. Each red is a **TEST DEFECT, Windows-triggered** — a real defect in test code, not a
"host artefact" that can be dismissed, because the host only *triggers* it and the fix is in the test.

| # | Failing test | Verdict | Defect location |
|---|---|---|---|
| 1 | `TestHTTPSProviderUsesTheConnectProxy` | TEST DEFECT (Windows-triggered), not a product bug | `internal/outbound/proxytest/proxy_test.go:54-56` |
| 2 | `TestHTTPProviderUsesTheForwardProxy` | TEST DEFECT (Windows-triggered), not a product bug | `internal/outbound/proxytest/proxy_test.go:54-56` |
| 3 | `TestNoProxyIsHonoured` | TEST DEFECT (Windows-triggered), not a product bug | `internal/outbound/proxytest/proxy_test.go:54-56` |
| 4 | `TestScrubRemovesEveryProxyVariable` | TEST DEFECT (Windows-triggered) in the harness helper | `tests/egressguard/guard.go:74-89` |

No failure is `PRODUCT BUG`; none is `ENVIRONMENT PRECONDITION` (this host has everything the tests
need, and "env names are case-sensitive" is not a precondition a test may require); the "host
artefact" reading applies only in the AGENTS.md sense that a local red need not be a defect in the
shipped product — and here it is a defect in test code, so it must be fixed, not dismissed.

The reason this matters: the failures *read* like the P0-A product defect (rule 29). They are not,
and the evidence that rules it out is in "Positive controls" below.

## Commands run (and the exact output)

```
go version; go env GOOS GOARCH GOROOT GOVERSION
go version go1.27.0 windows/arm64
windows
arm64
C:\Program Files\Go
go1.27.0
```

```
go test -count=1 -v ./internal/outbound/proxytest
=== RUN   TestHTTPSProviderUsesTheConnectProxy
    proxy_test.go:186: send through HTTPS_PROXY: timeout waiting for provider 192.0.2.1:59992 to answer: context deadline exceeded
--- FAIL: TestHTTPSProviderUsesTheConnectProxy (5.01s)
=== RUN   TestHTTPProviderUsesTheForwardProxy
    proxy_test.go:208: send through HTTP_PROXY: timeout waiting for provider 192.0.2.1:59996 to answer: context deadline exceeded
--- FAIL: TestHTTPProviderUsesTheForwardProxy (5.00s)
=== RUN   TestNoProxyIsHonoured
    proxy_test.go:229: HTTPS_PROXY is not being applied to a non-loopback provider host
--- FAIL: TestNoProxyIsHonoured (0.00s)
FAIL
FAIL	github.com/cocokoishi/gotavern/internal/outbound/proxytest	10.894s
```

```
go test -count=1 -v ./tests/egressguard
--- PASS: TestGuardRefusesAnUndeclaredDirectDial (0.00s)
--- PASS: TestGuardPermitsADeclaredPeerAndTheProxy (0.00s)
--- PASS: TestAssertPassesOnTheClaimedSetAndFailsOnAnExtra (0.00s)
--- PASS: TestProxyRefusesAndRecordsAConnectTunnel (0.00s)
    guard_test.go:208: recorded as required: [proxy-unexpected] 192.0.2.7:443 CONNECT 192.0.2.7:443: a TLS tunnel to a real host was opened through the proxy; the fixture claims no such request
--- PASS: TestTheEscapeThatRule14WasWrittenFor (0.00s)
--- PASS: TestTheShippedTransportReachesTheInstalledProxy (0.00s)
    guard_test.go:278: shipped transport arrived at the proxy: POST /v1/chat/completions (error as expected: <nil>)
=== RUN   TestScrubRemovesEveryProxyVariable
    guard_test.go:299: the restore lost HTTPS_PROXY: ""
--- FAIL: TestScrubRemovesEveryProxyVariable (0.00s)
FAIL	github.com/cocokoishi/gotavern/tests/egressguard	1.396s
```

Note what is green in that second run: the two tests that prove the *production* transport honours
the proxy environment on this host.

```
go test -count=1 -v -shuffle=1793262640618667800 ./tests/egressguard
=== RUN   TestScrubRemovesEveryProxyVariable
    guard_test.go:299: the restore lost HTTPS_PROXY: ""
--- FAIL: TestScrubRemovesEveryProxyVariable (0.00s)
=== RUN   TestTheShippedTransportReachesTheInstalledProxy
    guard_test.go:264: the shipped transport sent 0 request(s) to the proxy (error: timeout waiting for provider 192.0.2.7:8080 to answer: context deadline exceeded); expected exactly 1
--- FAIL: TestTheShippedTransportReachesTheInstalledProxy (5.00s)
=== RUN   TestGuardRefusesAnUndeclaredDirectDial
--- PASS: TestGuardRefusesAnUndeclaredDirectDial (0.00s)
=== RUN   TestAssertPassesOnTheClaimedSetAndFailsOnAnExtra
    guard_test.go:143: request 0 did not reach the proxy: Get "http://192.0.2.7:8080/v1/chat/completions": context deadline exceeded
--- FAIL: TestAssertPassesOnTheClaimedSetAndFailsOnAnExtra (5.00s)
=== RUN   TestTheEscapeThatRule14WasWrittenFor
--- PASS: TestTheEscapeThatRule14WasWrittenFor (0.00s)
=== RUN   TestGuardPermitsADeclaredPeerAndTheProxy
    guard_test.go:116: the request through the installed proxy failed before reaching it: Get "http://192.0.2.7:8080/v1/models": context deadline exceeded
--- FAIL: TestGuardPermitsADeclaredPeerAndTheProxy (5.00s)
=== RUN   TestProxyRefusesAndRecordsAConnectTunnel
    guard_test.go:208: recorded as required: [proxy-unexpected] 192.0.2.7:443 CONNECT 192.0.2.7:443
--- PASS: TestProxyRefusesAndRecordsAConnectTunnel (0.00s)
FAIL	github.com/cocokoishi/gotavern/tests/egressguard	15.279s
```

```
# host-level demonstration of the Windows semantic
$env:HTTPS_PROXY = 'http://127.0.0.1:9'
Test-Path env:https_proxy                       -> True      (lowercase lookup finds the uppercase name)
Remove-Item env:https_proxy                     -> (removes the variable)
Test-Path env:HTTPS_PROXY                       -> False     (the uppercase name is gone)
env:HTTPS_PROXY after lowercase removal         -> ''
```

Stdlib sources read (not guessed):

- `C:\Program Files\Go\src\syscall\env_windows.go:48-59` — `Unsetenv` is
  `SetEnvironmentVariable(keyp, nil)`; `Setenv` (`:31-46`) is `SetEnvironmentVariable(keyp, v)`.
  Both are the case-insensitive Win32 API.
- `C:\Program Files\Go\src\net\http\transport.go:1031-1043` — `envProxyOnce sync.Once`; the
  environment is resolved ONCE per process into `envProxyFuncValue`.
- `C:\Program Files\Go\src\vendor\golang.org\x\net\http\httpproxy\proxy.go:90-106` —
  `FromEnvironment()` reads `getEnvAny("HTTP_PROXY","http_proxy")`,
  `getEnvAny("HTTPS_PROXY","https_proxy")`, `getEnvAny("NO_PROXY","no_proxy")`, and `getEnvAny`
  returns the FIRST NON-EMPTY value. `:116-117` documents the localhost/loopback bypass.

## (a) What each failing test asserts, and its fixture

### `internal/outbound/proxytest` — three tests, one shared fixture

`TestMain` (`proxy_test.go:49-64`) is the fixture for all three: it starts an in-process HTTP proxy
(`newProxyServer`, `:76-101`) that either forwards an absolute-form request by rewriting the
unroutable authority to `127.0.0.1:<same port>` (`rewriteLoopback`, `:68-74`) or splices a CONNECT
tunnel (`serveConnect`, `:104-127`), then installs it into the process environment:

```go
_ = os.Setenv("HTTP_PROXY", proxy.URL)      // :51
_ = os.Setenv("HTTPS_PROXY", proxy.URL)     // :52
_ = os.Setenv("NO_PROXY", bypassHost)       // :53
_ = os.Unsetenv("http_proxy")               // :54
_ = os.Unsetenv("https_proxy")              // :55
_ = os.Unsetenv("no_proxy")                 // :56
```

The provider is addressed as `192.0.2.1` (TEST-NET-1) on the port the real local server listens on
(`unreachableProvider`, `:40`; `providerURL`, `:162-173`), deliberately not loopback, because Go
bypasses loopback before `NO_PROXY` is consulted (`:10-17`).

- **`TestHTTPSProviderUsesTheConnectProxy` (`:177-194`)** — fixture: a local `httptest.NewTLSServer`
  answering `{"choices":[{"message":{"content":"OK"}}]}` (`startProvider`, `:129-139`) plus the proxy
  above. Asserts: `outbound.Send` returns that JSON body (`:188-190`) AND the proxy counted exactly
  one CONNECT tunnel (`:191-193`, "HTTPS_PROXY is ignored, so a user who can only reach the internet
  through their proxy cannot reach any provider").
- **`TestHTTPProviderUsesTheForwardProxy` (`:198-216`)** — fixture: a plain (non-TLS)
  `httptest.NewServer` addressed as `192.0.2.1:<port>`, i.e. the absolute-form half. Asserts: the
  body equals `proxyJSON` (`:210-212`) AND the proxy counted exactly one forwarded request
  (`:213-215`).
- **`TestNoProxyIsHonoured` (`:223-238`)** — no sockets at all. Asserts against the resolver
  directly: `http.ProxyFromEnvironment` for `https://api.example.com` is non-nil (`:228-230`) and for
  `https://bypass.invalid` (the `NO_PROXY` entry) is nil (`:235-237`). The comment at `:218-222`
  explains why it cannot be asserted with a live tunnel.

### `tests/egressguard` — `TestScrubRemovesEveryProxyVariable` (`guard_test.go:281-304`)

Fixture: the process environment installed by `TestMain` -> `sharedProxy.Install()`
(`guard_test.go:58-71`; `Install` at `guard.go:370-406`) plus two per-test overrides. Asserts, in
order: the shared proxy IS installed (`:285-288`), the scrub leaves no provider proxy variable
visible (`:292-294`), and the restore puts back exactly what was there (`:298-303`). It is a
save/restore round-trip assertion — and it is the reproducer for failure 4, which means it has teeth.

## (b)/(c) The mechanism — one root cause, measured

Windows environment names are case-insensitive. Go on Windows reaches them through the Win32 API
(`syscall/env_windows.go:31-59`), so `os.Unsetenv("https_proxy")` deletes `HTTPS_PROXY`, and
`os.LookupEnv("NO_PROXY")` finds a variable stored as `no_proxy`. Measured on this host:

```
Test-Path env:https_proxy  -> True      # after $env:HTTPS_PROXY = '...'
Remove-Item env:https_proxy
Test-Path env:HTTPS_PROXY  -> False     # the uppercase name is gone
```

### Failure 1-3: `proxy_test.go:54-56` deletes the environment `:51-53` just set

`TestMain` sets the three uppercase names and then "clears the other spelling" with three
`os.Unsetenv` calls. On Windows each of those three calls removes the variable that was set three
lines earlier, so the test binary runs with **no proxy environment at all**. That predicts every
symptom exactly:

- `TestNoProxyIsHonoured`: `HTTPSProxy` is `""`, so `httpproxy` (`proxy.go:92-106`) yields an empty
  config and `proxyForURL` returns `nil, nil` for a non-loopback host -> `:228-230` fires with
  precisely the observed message. (The message is itself false: the variable is not "not being
  applied", it is not present.)
- `TestHTTPSProviderUsesTheConnectProxy` / `TestHTTPProviderUsesTheForwardProxy`: no proxy is
  configured, so `outbound.Send` dials `192.0.2.1` directly; TEST-NET-1 is unroutable, so the request
  sits until the caller's 5 s bound expires -> "timeout waiting for provider 192.0.2.1:<port> to
  answer: context deadline exceeded", which is the message the Lead recorded. A stale or broken proxy
  would have produced a `proxyconnect ...` error instead, and it did not.

The three `Unsetenv` calls are also **unnecessary on any host**: `getEnvAny` returns the first
non-empty value and the uppercase names are set non-empty at `:51-53`, so the lowercase spellings
can never influence the resolution where they are distinct variables. Deleting them cannot weaken
any assertion.

### Failure 4: the same semantic breaks the scrub's save/restore round trip

`ScrubProviderEnvironment` (`guard.go:70-90`) iterates the eight spellings in
`ProviderEnvironmentVariables` (`guard.go:60-65`), and its save loop **mutates the state it is
measuring**:

```go
for _, name := range ProviderEnvironmentVariables {   // :74
    value, ok := os.LookupEnv(name)                    // :75  case-insensitive on Windows
    saved[name], present[name] = value, ok
    if err := os.Unsetenv(name); err != nil { ... }    // :77
}
return func() {                                        // :81
    for _, name := range ProviderEnvironmentVariables {
        if present[name] { _ = os.Setenv(name, saved[name]) } else { _ = os.Unsetenv(name) }
    }
}
```

On Windows the eight names are four variables. For each pair, the first spelling is found, saved and
removed; the second spelling is then *absent* (it is the same variable), so `present[second]=false`.
The restore then re-sets the first spelling and immediately `Unsetenv`s the second — deleting what it
just restored. The order in the list makes this deterministic: `HTTP_PROXY` restored, then
`Unsetenv("http_proxy")` kills it; `HTTPS_PROXY` restored, then `Unsetenv("https_proxy")` kills it;
same for `ALL_PROXY` and `NO_PROXY`.

That is exactly the observed red: the scrub assertion at `:292-294` PASSED (the environment really
was empty), and the restore assertion at `:298-300` failed with `""` — and under case-sensitive
semantics the whole test would PASS, which is why this red is Windows-only by construction.

The same shape exists latently in `Proxy.Install` (`guard.go:377-380` save, `:397-405` restore). It
does not fire only because its save loop does not unset between reads, so both spellings resolve to
the same present variable and the restore writes the same value twice. A future edit that unsets
there would reintroduce the bug.

### The shuffle experiment: the loss is real and consequential, not a `LookupEnv` artefact

The scrub test is declared last, so in the normal order nothing observes the leak. Run with a fixed
shuffle seed that puts it first:

```
go test -count=1 -v -shuffle=1793262640618667800 ./tests/egressguard
```

`TestScrubRemovesEveryProxyVariable` runs first and fails at `:299`; then every **http**-based proxy
test fails with a direct-dial timeout (`guard_test.go:116`, `:143`, and `:264` — "the shipped
transport sent 0 request(s) to the proxy"), i.e. the transport genuinely could not find the proxy
environment any more. The **https** CONNECT test still PASSED, and that asymmetry is the fingerprint
of the mechanism: `t.Setenv("HTTPS_PROXY", ...)` at `guard_test.go:289` registers a cleanup that
restores `HTTPS_PROXY` when the scrub test ends, while `HTTP_PROXY` has no such protection and stays
destroyed. So the restore() destroyed all four variables; one of them was resurrected by the
`testing` package's own bookkeeping, not by `restore()`.

This also means the egressguard package currently depends on declaration order on Windows: after this
defect, the shared proxy environment is left broken for any later test in the same binary.

## The positive controls that rule out a PRODUCT BUG

1. `TestTheShippedTransportReachesTheInstalledProxy` PASSED in the normal order:
   `shipped transport arrived at the proxy: POST /v1/chat/completions (error as expected: <nil>)`.
   That test drives `outbound.Send` — the production transport (`transport.go:90-113`, whose
   `providerProxy` at `:386-395` delegates to `http.ProxyFromEnvironment`) — at an `http://` provider
   host, and the proxy received exactly the request. The production transport's environment-proxy
   path works on windows/arm64.
2. `TestProxyRefusesAndRecordsAConnectTunnel` PASSED:
   `[proxy-unexpected] 192.0.2.7:443 CONNECT 192.0.2.7:443`. That is `HTTPS_PROXY` being honoured for
   a CONNECT tunnel on windows/arm64 — the exact property `TestNoProxyIsHonoured` accuses the host of
   lacking.
3. Both are only possible if a variable set by `TestMain` before `m.Run()` is visible to the first
   `http.ProxyFromEnvironment` call. That refutes the alternative explanation "the once in
   `transport.go:1031-1043` was primed before `TestMain` ran", and it shows the once is resolved
   lazily in these binaries. The same control answers the obvious objection to failure 1-3:
   `proxy_test.go:50` calls `newProxyServer()` (which calls `httptest.NewServer`) BEFORE the `Setenv`
   lines at `:51-53`, so a reader may suspect the server construction primed the cache. In
   `tests/egressguard` the order is the same — `startProxy(sharedGuard)` at `guard_test.go:63` runs
   before `sharedProxy.Install()` at `:64` — and there the environment WAS honoured afterwards, so
   `httptest.NewServer` does not prime the proxy cache and the `Setenv` lines at `:51-53` do take
   effect. The only difference in `proxytest` is the three `Unsetenv` calls that follow them.
4. The shuffle cascade above is the negative control for the same claim: with the environment
   destroyed, the *same* binary's transport dials `192.0.2.7` directly — which is what the proxytest
   reds show.

The Windows case-insensitivity that breaks these tests is in fact *helpful* to the product: on
Windows `os.Getenv("HTTPS_PROXY")` finds a variable a user set as `https_proxy`, so either spelling
works for a real operator.

## What I ruled out, and why

- **Ambient proxy variables.** The Lead measured none, and `TestNoProxyIsHonoured` calls the resolver
  directly against a process whose entire provider-proxy environment `TestMain` had deleted.
- **A `no_proxy` rule matching the provider.** `NO_PROXY` is set to `bypass.invalid` only (`:53`), and
  the failing resolver call is for `api.example.com` — no rule could match it. Also ruled out by the
  observed messages.
- **A broken/closed test proxy server.** The failure is a *direct-dial* timeout, not
  `proxyconnect ...`; and the identical httptest-proxy pattern works in `tests/egressguard`.
- **Loopback bypass.** The provider is `192.0.2.1`, not loopback (`proxy_test.go:10-17`).
- **`os.Setenv` failing on Windows.** It did not: `guard_test.go:285-288` (which asserts
  `HTTPS_PROXY == sharedProxy.URL` before the scrub) PASSED.
- **A Windows-specific defect in the product's proxy handling.** Refuted by controls 1-2 above.
- **A missing host capability (`ENVIRONMENT PRECONDITION`).** Nothing is missing here; the tests
  assume POSIX env-name case sensitivity, which is an assumption they must not make.

## Minimal fixes (NOT implemented — reported for the Lead to integrate)

### Fix A — `internal/outbound/proxytest/proxy_test.go`

Delete `:54-56` (the three `os.Unsetenv` calls), with a comment naming the reason: on Windows the
lowercase spelling IS the uppercase variable, and `httpproxy.getEnvAny`
(`src/vendor/golang.org/x/net/http/httpproxy/proxy.go:99-106`) prefers the uppercase name that
`:51-53` sets, so the lowercase cleanup can never change the resolution on a case-sensitive host.
This weakens nothing: it removes three statements that were no-ops on POSIX and destructive on
Windows. (If the author prefers to keep clearing the other spelling for determinism, the guard must
be `runtime.GOOS != "windows"` — but removal is simpler and equally strong.)

### Fix A2 — the missing lock: make the test's own precondition assertable

`proxytest` has no assertion that its environment survived `TestMain`, so today a *test* defect
presented as `timeout waiting for provider ... context deadline exceeded` and as "HTTPS_PROXY is not
being applied" — both of which read as product findings. Add, after `:56` in `TestMain`:

```go
for _, name := range []string{"HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY"} {
    if os.Getenv(name) == "" {
        fmt.Fprintf(os.Stderr, "proxytest: %s is empty after TestMain's install; the proxy matrix would measure a direct dial\n", name)
        os.Exit(1)
    }
}
```

and, strengthening rather than weakening `TestNoProxyIsHonoured`, assert
`os.Getenv("HTTPS_PROXY") != ""` before the resolver call so the message distinguishes "not set"
from "not applied". Acceptance for Fix A + A2 (rule 31): `go test -count=1 -v
./internal/outbound/proxytest` on this host goes green, and a re-introduced `Unsetenv` makes the
self-check fail BY NAME instead of looking like a product timeout.

### Fix B — `tests/egressguard/guard.go`

Make the scrub/restore name list host-aware, and use the SAME list in both loops (and in `Install`'s
save/restore at `:377-380` / `:397-405`):

```go
// proxyVariableNames: on a case-insensitive host (Windows) HTTP_PROXY and http_proxy are ONE
// variable, so unsetting the first spelling removes the second and a later restore of the second
// would delete what the first restored. Unsetting the uppercase name removes the variable whatever
// its stored spelling is, so four names cover the four variables.
func proxyVariableNames() []string {
    if runtime.GOOS == "windows" {
        return []string{"HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"}
    }
    return ProviderEnvironmentVariables
}
```

Keep `ProviderEnvironmentVariables` exported and complete — `lookupAny(ProviderEnvironmentVariables)`
at `guard_test.go:292` is a case-insensitive enumeration and must keep seeing all eight spellings.
More faithful variant, if the exact stored spelling in `os.Environ()` matters: enumerate
`os.Environ()` once, match names against the known set case-insensitively, and save/restore the
ACTUAL spelling. The observable difference is limited to `os.Environ()` output (a case-insensitive
`LookupEnv` cannot see it), so the simple variant is acceptable.

### Fix B2 — the lock already exists

`TestScrubRemovesEveryProxyVariable` (`guard_test.go:281-304`) IS the reproducer and must go green
**unmodified**; do not relax `:298-303`. Strengthen it without weakening: round-trip all four
variables (`HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY`) rather than only `HTTPS_PROXY` and
`no_proxy`, and assert the pre-scrub precondition that each is non-empty. Once fixed, this package
must also be order-independent — the shuffle seed above is the check.

## Process finding (rule 40): no gate runs the Go suite on Windows

Every `go test ./...` in this repository runs on `ubuntu-latest`:
`.github/workflows/ci.yml:402-403` (job `verify`, step "Test" at `:528-529`) and
`.github/workflows/lane.yml:37,139`. The Windows jobs are artifact/installer qualifications
(`release-qualification.yml:322`, `dropin-qualification.yml:494`) and do not run the suite. Two
consequences:

1. The POSIX assumption in these two files is unfalsifiable in CI, and the red is invisible there.
2. The mirror risk is the one the task was written about: a *genuine* Windows-only provider-transport
   defect would be equally invisible to CI, and on this host it would present as the same
   `context deadline exceeded` reds that this triage shows are a test defect — which is exactly how a
   real P0 gets dismissed as a host artefact.

Recommendation (not implemented): add a bounded Windows job that runs at least
`go test -count=1 ./internal/outbound/... ./tests/egressguard` (these two packages, plus the
sibling `internal/outbound` package), so the Windows-only environment semantics are measured rather
than assumed. Until such a job exists, a Windows red in these packages must be triaged by this
document's method rather than trusted or dismissed.

## Uncertainty (stated plainly)

- I did not run these packages on Linux, and there is no Windows `go test ./...` CI job to cite, so
  "these pass on Linux / are green in CI" is DERIVED from the stdlib semantics (POSIX `os.Unsetenv`
  is case-sensitive) plus the code reading, not observed. I also did not query CI (no network/gh in
  scope). If a Linux run of these two packages were red for an unrelated reason, my mechanism would
  be incomplete — the mechanism does not depend on that being false, but the "host-only" claim does.
- Fixes A, A2 and B are NOT implemented (out of scope for this task), so they are not verified to
  turn the reds green. That single check is the acceptance step: after the fix,
  `go test -count=1 -v ./internal/outbound/proxytest ./tests/egressguard` must be green on this host
  and under `-shuffle=on`.
- I did not exercise the user-configured `requestProxy` path (`transport.go:359-395`) on Windows, nor
  run `internal/outbound/proxy_config_test.go`; that path is outside this red and remains untriaged
  here.
- `go test ./...` was not run (per the task's constraint), and neither was npm or Playwright.
