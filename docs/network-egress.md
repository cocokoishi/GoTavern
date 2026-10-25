# Network egress inventory (Phase 0.2)

Recorded at `main` `10314c8`. Every row was read from the source named in it; nothing here is inferred from a
document or from a green CI run.

Why this file exists: a release is unusable if it cannot reach a real provider, and dangerous if it reaches one
nobody asked for. Both questions need the same inventory — **what can this process talk to, when, and under whose
instruction.** The provider defect reported by the user (`P0-A`) lives in a transport that was validated only
against a local mock, so the transport section below is deliberately blunt about what that mock could not see.

## 1. Every egress path in the running server

| Caller | Destination type | Trigger | Startup? | User action? | Proxy aware? | Timeout? | Can retry? | Can mutate state? |
|---|---|---|---|---|---|---|---|---|
| `internal/outbound.Send` / `SendStreaming` (27 files, ~90 call sites) | any provider HTTPS/HTTP host | an API request the browser makes | **no** | yes | **no** | **no** (`timeout 0` from chat completions, see D1) | no | no |
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

## 2. The production transport contract, and the eight places it does not meet it

`internal/outbound/raw.go` writes HTTP/1.1 by hand. That is a legitimate way to reproduce a byte-exact oracle,
and the provider-wire fixture proves it does reproduce one. It is **not** evidence that the same code is a
serviceable production client, and the following are measured gaps, not suspicions:

| # | Gap | Evidence | Consequence for a real provider |
|---|---|---|---|
| D1 | **No read/response timeout at all.** `SendStreaming` sets a deadline only when `timeout > 0`, and chat completions passes `0` | `raw.go:166-168`; `chat_completions.go:263` `outbound.SendStreaming(request.Context(), *plan, 0)` with the comment "no client-side timeout: the pinned fetch has none" | a provider that accepts TCP and then stalls holds the request (and the frontend) forever |
| D2 | **`accept-encoding: gzip, deflate, br` is sent and never decompressed** | every planner sets it (`chat_completions.go:670`, `ai21_chat.go:297`, `claude_chat.go:842`, …); `raw.go` imports no `compress/*` and `bodyReader` returns the bytes as they arrive | any provider that honours the header (DeepSeek sits behind a compressing CDN) returns gzip/brotli; the JSON parse then fails and the user sees a connection error |
| D3 | **No proxy support at all** | `raw.go:107-111` dials the target host directly; nothing reads `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` (`grep` over `internal/**` finds no `ProxyFromEnvironment`) | every user behind a corporate proxy cannot reach any provider |
| D4 | **No redirect following** | `readResponseHead` returns a 3xx as the response; there is no `Location` handling | a provider that redirects (region or CDN edge) answers a body that is not JSON |
| D5 | **No connection reuse / keep-alive** | one `DialContext` per request, connection closed by `bodyReader.Close` | every message opens a fresh TCP+TLS handshake; slow, and hostile to providers that rate-limit connection churn |
| D6 | **Unbounded TLS handshake when the caller passes no deadline** | `raw.go:129` `HandshakeContext(ctx)`; the deadline is set only later, at `:167` | a half-open TLS peer blocks boot-time-free but request-time indefinitely |
| D7 | **A goroutine per request waits for `ctx.Done()`** | `raw.go:169-172` | with a background context this goroutine outlives the request; with thousands of requests it is a leak |
| D8 | **No HTTP/2, no `Expect: 100-continue`, no body framing for `HEAD`/204/304** | the whole of `raw.go` | narrow today, but these are the reasons a hand-written stack is the wrong default for production traffic |

None of this is visible to the oracle: the recording peer is plain HTTP, answers complete bodies, never
compresses, never redirects and never stalls. **That is the same shape of blind spot the repository already
recorded for TLS** ("`outbound.Send` dials plain TCP and does not perform a TLS handshake … against a local mock
the routes are correct and fully tested; against the real pinned URL they answer 500", `internal/server/horde.go:26`,
which is itself now stale since TLS was added). A comment describing a previous blind spot is not a fix for the
next one.

## 3. What the contract must become

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
