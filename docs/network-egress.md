# Network egress inventory (Phase 0.2)

> **HISTORICAL INVENTORY, WITH ONE SUPERSEDED SECTION.** This was recorded at main 10314c8 and its §2
> describes the tree at that time, when internal/outbound/raw.go wrote HTTP/1.1 by hand and was ALSO the
> client that carried user traffic. That is no longer true: aw.go is now ORACLE-ONLY (its own comment says
> so), and internal/outbound/transport.go is a separate production client with proxy awareness, bounded
> connect/TLS/header/idle timeouts, decompression, redirect policy, keep-alive honouring enableKeepAlive,
> and the private-address dial filter -- selected for user traffic by TransportMode. So §2's D1-D8 list is
> a record of the defect that produced P0-A, not a current description; read internal/outbound/transport.go
> and 	ransport_matrix_test.go for what the production client does today. §1's egress inventory and §3/§4's
> requirements remain the right questions. **Current status lives in docs/goal-scorecard.md and
> docs/compatibility-matrix.json; a historical inventory is not evidence about the current tree.**

Recorded at `main` `10314c8`. Every row was read from the source named in it; nothing here is inferred from a
document or from a green CI run.

Why this file exists: a release is unusable if it cannot reach a real provider, and dangerous if it reaches one
nobody asked for. Both questions need the same inventory — **what can this process talk to, when, and under whose
instruction.** The provider defect reported by the user (`P0-A`) lives in a transport that was validated only
against a local mock, so the transport section below is deliberately blunt about what that mock could not see.

## 1. Every egress path in the running server

| Caller | Destination type | Trigger | Startup? | User action? | Proxy aware? | Timeout? | Can retry? | Can mutate state? |
|---|---|---|---|---|---|---|---|---|
| `internal/outbound.Send` / `SendStreaming` (27 files, 48 call sites: `Send` 42, `SendStreaming` 6) | any provider HTTPS/HTTP host | an API request the browser makes | **no** | yes | **no** | **no** (`timeout 0` from chat completions, see D1) | no | no |
| `internal/app/server.go:161` `net.LookupIP("host.docker.internal")` | DNS only | startup, and only when `whitelistDockerHosts` is on **and** `/.dockerenv` exists | **yes** | no | n/a | **no** | no | no |
| `internal/server/extensions_git.go:59,80` `exec.CommandContext(ctx, "git", …)` | arbitrary git remote of an installed extension | `POST /api/extensions/…/{install,update,switch}` | **no** | yes | inherits git's own proxy env | yes, from the request context | no | **yes** — rewrites the extension directory |
| `internal/server/tokenizers_remote.go` (via `outbound.Send`) | the pinned tokenizer host | first use of a remote tokenizer | **no** | yes | **no** | partial (see D1) | no | writes the tokenizer cache |

No other egress exists: there is no update checker, no telemetry, no download-on-boot, and no plugin HTTP client.
`grep` for `exec.Command`, `net.Dial`, `http.Client`, `http.Get`, `LookupIP`, `LookupHost` over `internal/**` and
`cmd/**` returns exactly the five sites above.

**Therefore `P0-C` is not a boot-time `git pull`.** Boot never runs git. What the user observed is reachable a
different way: the pinned defaults turn extension auto-update **on** (`upstream/default/config.yaml:301`
`autoUpdate: true`, `:396 enableServerPluginsAutoUpdate: true`) and GoTavern reproduces that default rather than
choosing its own — `internal/commandline/options.go:250` resolves the key with `getConfigValue(config,
"extensions.autoUpdate", true, cliBoolean)`, and `internal/server/settings_get.go:70` reports it to the frontend
with `optionBooleanDefault(runtime.options.ExtensionsAutoUpdate, true)`. A user with no key, an old config, or a
migrated config gets `true` — and the unmodified frontend then offers (and, with its own auto-update habit, can
drive) the git-backed update routes. The fix is the product contract in `AGENTS.md` rule 26: **missing, null,
unparsed or legacy means OFF**, whatever upstream's default says.

## 2. The production transport contract, and where it now stands

**READ THE NEXT TABLE, NOT THE ONE AFTER IT.** This section used to open with an "eight places the production
transport does not meet the contract" table, written against `internal/outbound/raw.go` when that hand-written
client carried user traffic. `raw.go` is now the **oracle-only** byte-exact client (`Send`, `sendWireExact`) and
the production path is `internal/outbound/transport.go`, which is a `net/http` client with proxy awareness,
bounded connect/handshake/header/idle timeouts, decompression, a redirect policy, keep-alive honouring
`enableKeepAlive`, cancellation and the private-address dial filter. The old table is kept verbatim below as
HISTORY, because it is the measurement that made the split happen and because deleting it would hide why
`transport.go` exists. It is **superseded**, and the status table above it is the current statement.

| # | Contract property | Status now | Gate that would go red |
|---|---|---|---|
| D1 | Bounded connect / handshake / header / idle timeouts | **closed** — `transport.go` bounds each stage and attributes a timeout to the stage it happened in | `TestProductionTransportAttributesATimeoutToTheHeaderStage` |
| D2 | Response decompression (gzip, deflate, chunked) | **closed** — the transport decompresses and refuses an encoding it cannot decode causally | `TestProductionTransportDecompressesGzipJSON`, `…DeflateJSON`, `…DecodesGzipOverChunkedFraming`, `…ReportsAnUndecodableEncodingCausally` |
| D3 | Proxy support (`requestProxy.*` and the environment, never merged) | **closed** — explicit config wins over the environment, bypass is honoured, and a proxy that REFUSES is named as the proxy | `TestConfigureRequestProxyValidatesItsInput`, `TestProviderProxyUsesTheConfiguredProxyAndHonoursBypass`, `TestProductionTransportNamesAProxyRefusal` |
| D4 | Redirect following | **closed** — a bounded hop policy | `TestProductionTransportFollowsARedirect` |
| D5 | Connection reuse / keep-alive | **closed** — follows `enableKeepAlive` (pinned's default is false) | `TestProductionTransportKeepAliveFollowsTheConfigKey` |
| D6 | TLS verification and a bounded handshake | **closed** — system roots, verification on, handshake bounded; an untrusted chain is refused CAUSALLY | `TestProductionTransportRefusesAnUntrustedCertificate`, `TestSendRejectsAnUntrustedCertificate` (wire-exact) |
| D7 | No per-request goroutine leak | **closed** by construction — `net/http` owns the connection lifecycle; a mid-stream close surfaces causally instead of hanging | `TestProductionTransportSurfacesAMidStreamCloseCausally` |
| D8 | Framing, `Expect: 100-continue`, HTTP/2 | **closed** by construction for the production path (the standard client), and still absent from `raw.go` **on purpose**: that client exists to reproduce pinned's bytes, not to be a general HTTP stack | covered indirectly by every production-transport test; `raw.go`'s narrowness is the oracle's contract |

**THE INTERNET-SHAPED GATE (added 2026-10-29).** Every property above was, until this change, asserted against a
recording peer that answers HTTP quickly and correctly. The shapes a real network produces had no test:
`internal/outbound/transport_internet_shape_test.go` now drives the production transport against a peer for each
failure class and requires the error to (a) exist, (b) NAME the stage and the provider host, and (c) NOT contain
the request's bearer token:

- an untrusted certificate → `TestProductionTransportRefusesAnUntrustedCertificate` (TLS);
- a hostname that cannot resolve (`.invalid`) → `TestProductionTransportNamesADNSFailure` (DNS);
- a port that refuses → `TestProductionTransportNamesAConnectRefusal` (connect);
- a proxy that answers 407 → `TestProductionTransportNamesAProxyRefusal` (proxy);
- a peer that accepts and never answers → `TestProductionTransportAttributesATimeoutToTheHeaderStage` (timeout,
  pre-existing).

And the artifact-level half, which is what AGENTS.md 23/35 actually require: `tests/e2e`'s
`TestProviderTransportFailureIsCausalThroughTheShippedBinary` boots the built binary, points a provider at an
untrusted TLS peer, drives a real chat completion and asserts the JSON the browser receives carries `error`
exactly as pinned's branch sends it **plus** a `message` that names the TLS stage and no credential. That test's
teeth were observed: removing the `message` member from `pinnedChatCompletionErrorFlagWithCause` turns it red with
`the failure body carries no message, so the user sees no cause (this is the P0-A shape): {"error":true}`.

**WHAT IS STILL NOT PROVEN, so this section does not claim it.** The differential corpus still runs against our own
recording peer, and AGENTS.md 22 makes that `unverified` for production purposes: the live canary that reaches a
real provider (`scripts/live-canary.mjs`, `scripts/deepseek-canary.mjs`) needs a credential and is not part of the
default suite. A user's own provider, through a user's own proxy, is exercised by the user and by nothing here.

### 2.1 HISTORY — the table that was current before the split

`internal/outbound/raw.go` writes HTTP/1.1 by hand. That is a legitimate way to reproduce a byte-exact oracle,
and the provider-wire fixture proves it does reproduce one. It is **not** evidence that the same code is a
serviceable production client, and the following are measured gaps, not suspicions:

| # | Gap | Evidence | Consequence for a real provider |
|---|---|---|---|
| D1 | **No read/response timeout at all.** `SendStreaming` sets a deadline only when `timeout > 0`, and chat completions passes `0` | `raw.go:166-168`; `chat_completions.go:263` `outbound.SendStreaming(request.Context(), *plan, 0)` with the comment "no client-side timeout: the pinned fetch has none". The same `0` is passed to `net.Dialer{Timeout: timeout}` at `raw.go:107`, so the CONNECT is unbounded too, not only the read | a provider that accepts TCP and then stalls holds the request (and the frontend) forever |
| D2 | **`accept-encoding: gzip, deflate, br` is sent and never decompressed** | every planner sets it (`chat_completions.go:670`, `ai21_chat.go:297`, `claude_chat.go:842`, …); `raw.go` imports no `compress/*` and `bodyReader` returns the bytes as they arrive | any provider that honours the header (DeepSeek sits behind a compressing CDN) returns gzip/brotli; the JSON parse then fails and the user sees a connection error |
| D3 | **No proxy support at all** | `raw.go:107-111` dials the target host directly; nothing reads `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` (`grep` over `internal/**` finds no `ProxyFromEnvironment`) | every user behind a corporate proxy cannot reach any provider |
| D4 | **No redirect following** | `readResponseHead` returns a 3xx as the response; there is no `Location` handling | a provider that redirects (region or CDN edge) answers a body that is not JSON |
| D5 | **No connection reuse / keep-alive** | one `DialContext` per request, connection closed by `bodyReader.Close` | every message opens a fresh TCP+TLS handshake; slow, and hostile to providers that rate-limit connection churn |
| D6 | **Unbounded TLS handshake when the caller passes no deadline** | `raw.go:129` `HandshakeContext(ctx)`; the deadline is set only later, at `:167` | a half-open TLS peer blocks boot-time-free but request-time indefinitely |
| D7 | **A goroutine per request waits for `ctx.Done()`** | `raw.go:169-172` | with a background context this goroutine outlives the request; with thousands of requests it is a leak |
| D8 | **No HTTP/2, no `Expect: 100-continue`, no body framing for `HEAD`/204/304** | the whole of `raw.go` | narrow today, but these are the reasons a hand-written stack is the wrong default for production traffic |

None of this was visible to the oracle: the recording peer is plain HTTP, answers complete bodies, never
compresses, never redirects and never stalls. **That is the same shape of blind spot the repository already
recorded for TLS** ("`outbound.Send` dials plain TCP and does not perform a TLS handshake … against a local mock
the routes are correct and fully tested; against the real pinned URL they answer 500", `internal/server/horde.go:26`,
which is itself now stale since TLS was added). A comment describing a previous blind spot is not a fix for the
next one.

## 3. What the contract must become

**Which client carries what (decided, implemented).** internal/outbound.Send / SendStreaming are the production
client (	ransport.go, net/http). The hand-written HTTP/1.1 client is retained as sendWireExact /
sendWireExactStreaming and is selected only when GOTAVERN_OUTBOUND_WIRE_EXACT=1 is present in the process
environment; nothing in internal/** or cmd/** sets it. The provider-wire replay's test binary pins it in
internal/server/transport_mode_test.go and asserts the mode actually took effect, because a seam that
silently fails to apply would leave the replay green while measuring a client that cannot reproduce the
recorded bytes.

1. **Two transports, two jobs.** A production transport built on `net/http` (`Proxy: http.ProxyFromEnvironment`,
   explicit `DialContext`/`TLSHandshakeTimeout`/`ResponseHeaderTimeout`/idle limits, keep-alive, redirect policy,
   transparent decompression) serves every real provider request. The wire-exact transport stays, is renamed to
   say what it is for, and is used only where a byte-exact provider observation is the point.
2. **The split is proven, not asserted**: the same HTTPS-based provider matrix (stream, non-stream, 4xx, 5xx,
   delay, chunk-split SSE, abrupt close, proxy, TLS failure) must pass through the production transport, and the
   byte-exact fixture must still pass through the wire-exact transport.
3. **Errors are causal**, not "cannot connect": `DNS`, `connect`, `TLS handshake`, `proxy CONNECT`, `timeout`,
   `HTTP 401/403/429/5xx`, `mid-stream close` must each be distinguishable to the user (`P0-A` acceptance).
4. **Boot egress stays at zero.** The only allowed startup network call is the docker-hostname DNS lookup, and it
   must be bounded — an unbounded resolver call on a machine with a hanging DNS server is the same class of hang as
   `P0-B`.
5. **No secret ever reaches a log**: API keys, bearer tokens, proxy credentials and `secrets.json` content are
   redacted at the transport boundary, not by callers remembering to do it.

## 4. The two gates that carry P0-A's evidence (added 2026-10-25)

Everything above measures what the transport CAN do. Neither of the gates below existed, and that is why the
suite could be green while a real key reached nothing: the transport matrix drives `Send`/`SendStreaming`
directly, and the provider-wire replay pins the wire-exact client for the whole `internal/server` test binary, so
neither of them observes the client that carries user traffic through the shipped route.

**`tests/e2e` — the deterministic subprocess gate.** `go test ./tests/e2e` boots the binary built from this tree
(in CI, the lane's own `lane-binaries/gotavern-linux-amd64` via `GOTAVERN_BINARY`, so no second compile and the
binary under test is the binary under review), waits on `GET /version` with a hard deadline, takes the CSRF token
and cookie from `GET /csrf-token` (accounts are off in the default config, so a fresh install has no login step),
stores a synthetic key through `POST /api/secrets/write` — the route the frontend uses, not a hand-written
`secrets.json` — and then drives `POST /api/backends/chat-completions/generate` four times:

| Leg | The observable it pins | What would make it fail |
|---|---|---|
| non-stream | the peer receives the capture's provider body **byte for byte** (`bodySha256`), `Authorization` carries the stored key, and the route returns the capture's recorded assistant content | any change to the plan, the message merge, the stored key or the response mapping |
| stream | the route's body is exactly the capture's recorded frames and ends in a clean `data: [DONE]` | a frame dropped, reordered, re-encoded or a stream that stops without the provider's sentinel |
| provider error | a provider that ANSWERS with 429 produces the capture's 500 + the provider's own message | the transport-failure shape (`200 {"error":true}`) being returned for an answered request |
| unreachable provider | a closed peer produces `200 {"error":true}` and the peer records nothing further | a kept-alive socket being reused, or the two failure shapes collapsing into one |

The leg that makes "the production transport carried this" measurable is asserted at the peer, on headers that
neither client chooses freely: `accept-encoding` arrives as exactly `gzip` (the production client drops the
planner's `gzip, deflate, br` so net/http can decode), there is **no** `Connection` header (the plans' `close` is
the wire-exact client's value), and header names arrive canonicalised (`Content-Type`, not `content-type`). Any one
of these failing means the request was not on the production transport, so the test cannot pass for the wrong
reason. The harness also refuses to run at all when `GOTAVERN_OUTBOUND_WIRE_EXACT=1` is in its environment.

The provider peer is **plain HTTP, deliberately**. The claim being made is about the route, the stored key, the
plan, the response mapping and the client that carries them; TLS, proxy CONNECT, redirect and timeout bounds are
one layer below and are measured against a TLS server in `internal/outbound/transport_matrix_test.go`. A peer that
terminated TLS would add a certificate to this harness without adding a single new observable.

**`scripts/deepseek-canary.mjs` — the live gate, run by the lane workflow.** It boots the same binary (seam
unset), stores the key through the same route, and calls the real `https://api.deepseek.com/beta`.

It runs in **two modes**, and the log names which one ran:

- **with `DEEPSEEK_API_KEY`**: the shipped binary's production transport must complete a real TLS request to
  DeepSeek and the route must return a non-empty completion using the key the frontend stored.
- **without it (the reachability half, and it needs no credential)**: the script stores its own obviously-invalid
  key and **requires a provider-origin rejection** — an HTTP status plus api.deepseek.com's own error body. A
  provider cannot reject a request it never received, so that answer proves DNS resolution, TCP connect, the TLS
  handshake against the system roots, request framing and response parsing all happened through the shipped
  binary. A transport failure, an empty completion, or the route's own `{"error":true}` flag **fails the step**.

The earlier version exited 0 with a `SKIPPED:` line when the credential was absent, which made the only gate that
reaches the provider a line nobody could act on. A gate that cannot fail is worse than no gate, and "no key" never
meant "nothing measurable".

It **cannot prove**: which stage failed when the request does not arrive at all, streaming/cancellation/preset
equivalence, or parity with pinned Node (the run has no pinned subject).

**The cause the pinned body discarded, and the DECLARED divergence that fixes it (2026-10-25).** The DEEPSEEK
source answers a fetch that threw with `response.send({ error: true })` — no status, no message (`upstream`
chat-completions.js:1168-1174) — and eight other sources share that catch. GoTavern reproduced it for parity, which
meant a real transport failure reached the user as `{"error":true}` with no DNS/connect/TLS/proxy/timeout
distinction: contract item 3 above and AGENTS.md rule 35 were **not** met on this route, and it is the exact shape
P0-A was reported as.

The body is now a **superset** of pinned's, never a replacement:

| member | value | why |
|---|---|---|
| `error` | `true` | byte-identical to pinned; this is what the frontend reads, so every existing reader is unaffected |
| `message` | the transport's own stage: `dns`, `connect`, `tls handshake`, `proxy CONNECT`, `timeout`, cancellation, mid-stream close, or an HTTP status | the cause a user can act on, and the one pinned threw away |

The value is composed from the request's host and the failure stage and never from headers, so no credential can
appear in it (the canary checks the body for the key independently). The divergence is recorded here rather than
absorbed: a comparison of this body carries a named exemption for the added member with both values, and
`tests/e2e` leg 4 asserts *both* halves — the pinned flag and a cause that names a real stage — so neither the flag
nor the diagnosis can be dropped silently.

