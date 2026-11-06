# Lane D M0 audit — server→provider wire, streaming/cancel, registry, tokenizers, config→options

Baseline read: `lane/alpha16-program` at `c8472c1` (working tree clean except
another lane's untracked `docs/alpha16/baseline/`). Oracle: pinned SillyTavern `1.19.0`
`06bde939fb1e9c4c8d8641d810f0a916b5bce127` at `../SillyTavern`, read-only. Machine-readable fragment:
[`docs/alpha16/audit/fragments/d.json`](fragments/d.json).

**Method and honesty.** Read-only. No `go test`, `go build`, `go vet`, no pinned boot, no provider call, no network.
Every claim below carries `file:line` at HEAD or `../SillyTavern/src/...:line`. Depth is stated per area: *deep* =
line-by-line reading of the owner and its tests; *mechanical* = file inventory + targeted reads. Nothing here is a
fix; each finding has a reproducer plan instead (README M0 rule 2).

**What this lane did NOT decide** (see §6): whether the runtime behaviour of any *pinned* dependency matches the pinned
*source* for the redirect/header cases below (that needs a probe), whether the 120 s header bound is acceptable to
product, and how `configinit`'s write-vs-no-write decision (Lane B) interacts with the fallback table in §4.5.

---

## 1. (a) The provider request path and its framing contract

Observer surface for this whole section: **server→provider wire** (plus the streaming/cancel sequence). The
browser→server response side is cited only where it is the same code path (the chat route's response tail).

### 1.1 Route → dispatch → plan → send → respond

| Stage | What happens | Source |
|---|---|---|
| registration | `POST /api/backends/chat-completions/generate`; non-POST falls through to the 404 page | `internal/server/chat_completions.go:98-106` |
| body | pinned JSON body parser; malformed body → 400 status text (pinned Express page replaced by text) | `chat_completions.go:230-236` |
| route-wide prompt post-processing | `custom_prompt_post_processing` applied **before** any source branch, mutating `messages`; guard is `Array.isArray(messages) && postProcessingType` truthiness | `chat_completions.go:195-227`, `:238-242`; pinned `src/endpoints/backends/chat-completions.js:2246-2253` |
| account / data root | request account, data root and per-user directories; failure is 403/500 status text | `chat_completions.go:243-256` |
| MINIMAX short-circuit | dispatched **before** the registry because the plan path must keep answering 501 for it | `chat_completions.go:258-266`; registry rationale `chat_completions_registry.go:27-29` |
| source resolve | registry lookup; routed → row + plan; known-but-unrouted → 501, **zero outbound**; unknown → 400 `{"error":true}` | `chat_completions.go:370-408`, `:381-392` |
| plan | `outbound.Request{URL,Method,Headers,Body}` built by the row's converter; ordered JSON body | `chat_completions_registry.go:38-61`; e.g. `chat_completions.go:506-651` |
| send | `outbound.SendStreaming(request.Context(), *plan, 0)` — **no whole-exchange timeout** | `chat_completions.go:278-290` |
| respond | per-source response function; catch shape per source | `chat_completions_registry.go:41-54`, `:75-229` |

The request body is an **ordered-node JSON** value, not a map: member order is part of the byte contract
(`chat_completions.go:40-43`, `:484-496`) and the frozen literal order is
`messages,prompt,model,temperature,max_tokens,max_completion_tokens,stream,presence_penalty,frequency_penalty,top_p,top_k,stop,logit_bias,seed,n`
(`:493-496`, reserved at `:590-593`, filled `:603-617`, undefined slots dropped `:623-629`).

### 1.2 Target construction, raw target, and the query-string credential

- `/chat/completions` is appended to the source's base URL; a text-completion model switches to `/completions`
  **except for OpenRouter** (`chat_completions.go:635-638`).
- The double slash `//chat/completions` is contract: `new URL(reverse_proxy).toString()` already ends in `/`
  (`chat_completions.go:16-19`, `:635`; pinned `chat-completions.js:2650`). The raw-target path for the wire-exact
  client is `parsed.EscapedPath()` so a doubled slash survives (`internal/outbound/raw.go:139-148`).
- A non-absolute or non-http(s) endpoint is refused **before** a connection, with node-fetch's message
  `Only absolute URLs are supported` (`chat_completions.go:639-643`).
- `Host` is derived from the endpoint with the scheme-default port removed and IPv6 bracketed
  (`chat_completions.go:710-725`); it is the **last but one** header in the wire-exact framing, followed by
  `Connection: close` (`:653-678`).
- MakerSuite carries the key **in the query** (`?key=`), never in `Authorization`
  (`makersuite_chat.go:105-117`; pinned `:730`), and Vertex express/full/global hosts are built per pinned branch
  (`makersuite_chat.go:129-164`).

### 1.3 Header framing, and what the production client owns

Wire-exact framing (oracle only): node-fetch header names sorted (its `Headers` is a sorted `URLSearchParams`),
then `Host`, then `Connection: close` (`chat_completions.go:653-678`, `:685-708`). The captured header set includes
`accept: */*`, `accept-encoding: gzip, deflate, br`, `user-agent: node-fetch`, `authorization: Bearer <stringified
key>` (an absent key stringifies to the literal `Bearer undefined`, reproduced deliberately), `content-type:
application/json`, computed `content-length`, and `custom_include_headers` lowercased and overriding
(`chat_completions.go:685-708`).

Production client (`internal/outbound/transport.go:180-244`): `isTransportOwnedHeader` drops
`accept-encoding, host, content-length, connection, transfer-encoding` from the caller's list
(`transport.go:359-368`), so net/http supplies them. The declared consequences, all sanctioned by
`AGENTS.md` rules 29-30, are recorded in the file header (`transport.go:15-29`):
`Accept-Encoding: gzip` instead of `gzip, deflate, br`; keep-alive rather than `Connection: close` unless
`enableKeepAlive` is on; canonical header casing/order. **The provider thus observes a different framing from the
capture whenever the production client carries user traffic** — that is the intended role split, not a defect
(`transport.go:3-13`, `raw.go:77-80`), but no gate compares the production client's framing *with the captured
node-fetch framing*, so the split is a recorded contract rather than a measured one.

### 1.4 Credential boundary

- Secrets are read **per request, per user** from `<dataRoot>/<handle>/secrets.json`: no cache, no cross-user reuse;
  a missing file yields `""`, an unreadable/unparsable file is an error (502 through the catch), a plain-string
  value yields `""` rather than an error — which is exactly why the capture records `authorizationKeyVerified`
  instead of trusting header presence (`internal/server/chat_completions_secrets.go:23-89`,
  `chat_completions_oracle_test.go:115`).
- The reverse-proxy shapes read `proxy_password` instead of the secret (claude `claude_chat.go:16-18`; shared guard
  `chat_completions.go:510-519`), including the inherited `Bearer undefined` case for a reverse_proxy without a
  password (pinned `:2615`; reproduced at `chat_completions.go:692-698`).
- Transport errors never carry the URL, because a provider base URL may carry a key in its query
  (`transport.go:370-425`; asserted by `internal/outbound/transport_matrix_test.go:418`).
- Redirect credential stripping is discussed in §1.5; the **wildcard risk is there**, not in the static path.
- `requestOverrides` can replace `Authorization` and `Content-Type` by design, assigned last
  (`internal/server/request_overrides.go:1-56`, `:138-148`; pinned `src/additional-headers.js:202-265`).

### 1.5 Redirects

Contract reproduced: node-fetch `follow` default **20** (`productionRedirectLimit`, `transport.go:246-247`;
pinned `node_modules/node-fetch/src/request.js:134`, rejection at `src/index.js:177-181`), sensitive headers
(`Authorization, Www-Authenticate, Cookie, Cookie2`) deleted on a domain **or** protocol change
(`transport.go:249-251`, `:232-242`; pinned `src/index.js:199-212`), and node-fetch's method rules for
301/302/303 vs 307/308 (verified at `internal/outbound/a15_redirect_semantics_test.go:277-323`; pinned
`src/index.js:221-226`). The wire-exact client deliberately does not follow redirects (`raw.go:77-80`).

Two source-level divergences that no test discriminates (hypothesis D-H5):

1. **Hop semantics.** Go strips sensitive headers by comparing each destination with the *initial* request
   (`GOROOT/src/net/http/client.go:1017-1039`, copier at `:772-843`, call site `:700-705`), and `stripSensitiveHeaders`
   latches once set. node-fetch deletes per **current→next** hop (`src/index.js:208-212`, recursive `new Request` at
   `:235`). For a chain that leaves the origin and later returns to a domain that is a domain/subdomain of the
   *initial* host, Go re-copies the initial headers (`client.go:820-841`) while pinned keeps them deleted. The Go
   `CheckRedirect` adds only the **protocol** half against `via[0]` (`transport.go:236-240`).
2. **Body-header retention on POST→GET.** node-fetch deletes only `content-length` when it converts a 301/302 POST
   to GET (`src/index.js:221-226`); Go also strips `Content-Type/Content-Encoding/Content-Language/Content-Location`
   (`stripBodyHeaders = !includeBody`, `client.go:830-840`). The redirected GET therefore carries a different header
   set at the provider.

Every existing redirect test is single-hop (`a15_redirect_semantics_test.go:110-323`;
`transport_matrix_test.go:206`), so neither case can fail today.

### 1.6 Bounds, timeouts, decompression, keep-alive, proxy, SSRF filter

| Property | Go | Pinned | Status |
|---|---|---|---|
| connect / TLS handshake | 30 s / 15 s (`transport.go:57-58`) | none (node-fetch default agent has no connect timer) | declared rule-29 hardening |
| response headers | 120 s (`transport.go:59`) | none | declared rule-29 hardening; a provider that accepts TCP and stalls yields a Go error where pinned waits forever |
| idle conn | 90 s, 32 idle conns (`transport.go:60-61`, `:207-209`) | agent default | parity-by-capability |
| whole exchange | caller supplies it; chat passes **0** (`chat_completions.go:278-282`); `context.WithTimeout` only when >0 (`transport.go:256-262`) | no timeout | intentional parity |
| streaming body | no clock bound, by design (`transport.go:52-55`) | none | intentional parity |
| keep-alive | `DisableKeepAlives = !enableKeepAlive` (`transport.go:210-213`) | `new http.Agent({keepAlive: cliArgs.enableKeepAlive})` (`src/server-main.js:100-101`) | implemented (`docs/config-parity.md:74`) |
| decompression | transport owns `Accept-Encoding`; net/http decodes gzip; `decodeProviderBody` handles gzip/deflate and errors causally on unsupported encodings (`transport.go:305-328`) | node-fetch `compress: true`, decodes gzip/deflate/br | br unsupported -> causal error (declared, `transport.go:21-25`) |
| proxy | config `requestProxy` wins over environment, never merged; enabling without a usable URL is an **error** (`transport.go:447-483`) | `requestProxy` via agents / `ProxyAgent` | implemented with a declared rule-35 divergence (an error instead of pinned's unusable placeholder URL, `commandline/options.go:265`) |
| SSRF / private-address filter | on the dialer, so every redirect hop is checked (`transport.go:196-204`; `internal/outbound/privatefilter.go`; test `privatefilter_test.go:199`) | replaces the global agents (`src/private-request-filter.js:254-255`) | implemented, one recorded stricter divergence (v4-mapped v6) |

### 1.7 Streaming, cancellation, error mapping, truncation

Sequence for the chat route (all shapes below are per-source; §2 names each row's function):

1. **Stream decision** is `pinnedJSTruthy(body.stream)` on the *request* body (`chat_completions.go:351-355`).
2. **2xx stream**: status (401 rewritten to 400) is written, `Vary: Origin` set, `Content-Type` explicitly marked
   absent so net/http cannot sniff one, `WriteHeader` + flush, then a 32 KiB read/write/flush loop; on any read
   error the loop breaks, the stream is closed, and — if `response.Truncated` — the handler **waits for the client
   to disconnect** (`chat_completions.go:294-349`). That hang is pinned's own: `forwardFetchResponse` pipes the
   body and never ends the Express response on a source error (`../SillyTavern/src/util.js:732-779`).
3. **Non-2xx stream**: body read and forwarded after the status (Go writes it; pinned `to.end(rawErrorText)`)
   (`chat_completions.go:313-319`).
4. **Cancellation** is request-scoped: the plan is sent with `request.Context()`
   (`chat_completions.go:282`), so a browser disconnect cancels the upstream request; `attributedBody` distinguishes
   a context cancellation (returned as-is, not `Truncated`) from a mid-response close
   (`internal/outbound/transport.go:333-357`). The provider-side abort observable is asserted by
   `internal/outbound/a15_streaming_observables_test.go:35-105` (the peer sees the socket close).
5. **Truncation** is an explicit response flag, not an EOF: `Response.Truncated` is set by the wire-exact framer
   (`raw.go:57-64`, `:266-342`) and by the production body wrapper (`transport.go:340-350`).
6. **Non-streaming response mapping** (shared tail, `chat_completions.go:727-768`): 2xx body parsed and re-sent at
   **200**; non-2xx answered **200** with `{error:{message},quota_error}` using the provider's *reason phrase*; a
   read or parse failure answers 502. The eight pass-through sources answer a non-2xx with the **parsed provider body
   at 500** and a read failure with 200 `{error:true}` (`:770-810`). Claude answers non-2xx 500 `{error:true}`
   (`claude_chat.go:19-22`); Azure has its own 500 `{error:{message}}` (`chat_completions_registry.go:93-97`);
   MakerSuite/Vertex answer 500 `{error:true}` (`google_chat.go:23-24`).
7. **Transport failure catch shapes** are per source and are NOT the shared 502: eight answer 200 `{"error":true}`,
   Google and Claude 500 `{"error":true}`, Azure its own 500 body, the rest 502 `{error:{message}}`
   (`chat_completions.go:120-157`, `chat_completions_registry.go:76-229`). The added `message` member on the two
   `{error:true}` families is a **declared superset divergence** (pinned drops the error; `chat_completions.go:142-151`,
   `:184-193`), required by rule 35.

**Coverage gap (D-H13):** there is a truncation teeth-test for the *textgen*, *novelai* and *ollama* forwarders
(`internal/server/stream_truncation_teeth_test.go:90-160`) but **none for `forwardPinnedChatCompletionStream`**; grep
over `internal/server/*_test.go` finds no `forwardPinnedChatCompletionStream` or equivalent. The `openai-*`/`openrouter-*`
`midstream-truncation` scenarios exercise the route through the capture instead (see §2), which is the only reason
this is a coverage hypothesis rather than an unverified capability.

**Status/derived routes** (`/api/backends/chat-completions/status`, `/api/backends/*` provider status arms) were
covered *mechanically* only (`internal/server/backends_status.go`, `openai_chat_status.go`,
`makersuite_chat.go:166-180`); their per-source R1/R2 shape belongs to the backends domain and is cited in
`docs/api-inventory.md:23`.

---

## 2. (b) Provider registry: source → converter → pinned basis → evidence

Registry: `internal/server/chat_completions_registry.go:75-229` (**24 rows**, three behaviours each, positional
constructor `:59-61`, nil check `:254-263`). One more source is dispatched at route level (MINIMAX,
`chat_completions.go:263-266`), and one pinned source has no transport by design (COMETAPI → 501,
`chat_completions.go:381-392`, exemption with reason `chat_completion_capture_coverage_test.go:42-46`). Total pinned
matrix: 26 (`chat_completions.go:71-79`); implemented: **25** (24 rows + MINIMAX); unported: **1** (COMETAPI).

Pinned dispatch is a `switch` of 13 dedicated send functions (`chat-completions.js:2260-2272`) plus a 13-arm
`else if` chain on the shared planner (`:2281-2596`). Capture column = number of scenario inputs under
`tests/provider-wire/scenarios/` naming that source (258 files total), recorded to
`tests/oracle/sillytavern-1.19.0-provider-wire.json` and replayed by
`internal/server/chat_completions_oracle_test.go:123`. Every row is also required by
`TestEveryClaimedSourceHasAProviderWireCapture` (`chat_completion_capture_coverage_test.go:96-131`) and
`TestEveryClaimedSourceHasARegistryRow` (`chat_completions_registry_test.go:54-99`).

| # | source | pinned dispatch / shape | Go plan (converter) | response / catch | captures | notes |
|---|---|---|---|---|---|---|
| 1 | `ai21` | `:2261` → `sendAI21Request` | `pinnedAI21Plan` `ai21_chat.go:222` | pass-through / 200 `{error:true}` | 6 | placeholder hardcoded (D-H8) |
| 2 | `aimlapi` | `:2267` → `sendAimlapiRequest` | `pinnedAimlapiPlan` `aimlapi_chat.go:133` | pass-through / 200 `{error:true}` | 17 | |
| 3 | `azure_openai` | `:2272` → `sendAzureOpenAIRequest` | `pinnedAzureOpenAIPlan` `azure_openai_chat.go:289` | `serveAzureOpenAIChatCompletionResponse` / `pinnedAzureOpenAICatch` 500 `{error:{message}}` | 11 | own URL query `api-version` (`azure_openai_chat.go:162`) |
| 4 | `chutes` | `:2269` → `sendChutesRequest` | `pinnedChutesPlan` `chutes_chat.go:136` | pass-through / 200 `{error:true}` | 6 | |
| 5 | `claude` | `:2260` → `sendClaudeRequest` `:230` | `pinnedClaudePlan` `claude_chat.go:792` | `serveClaudeChatCompletionResponse` / 500 `{error:true}` | 20 | `x-api-key` not Bearer; own beta list; caching (D-H3, D-H6, D-H9) |
| 6 | `cohere` | `:2265` → `sendCohereRequest` | `pinnedCoherePlan` `cohere_chat.go:333` | pass-through / 200 `{error:true}` | 10 | placeholder hardcoded (D-H8) |
| 7 | `custom` | `:2394` (shared planner arm) | `pinnedCustomChatPlan` `openai_chat.go:83` | default / 502 | 8 | `custom_url`, YAML include/exclude, `Bearer undefined` |
| 8 | `deepseek` | `:2266` → `sendDeepSeekRequest` | `pinnedDeepSeekPlan` `deepseek_chat.go:275` | pass-through / 200 `{error:true}` | 15 | placeholder hardcoded (D-H8) |
| 9 | `electronhub` | `:2271` → `sendElectronHubRequest` | `pinnedElectronHubPlan` `electronhub_chat.go:124` | pass-through / 200 `{error:true}` | 11 | declared gap: claude model cache (`electronhub_chat.go:30-36`) |
| 10 | `fireworks` | `:2454` | `pinnedFireworksChatPlan` `fireworks_chat.go:187` | default / 502 | 5 | `x-session-affinity` HMAC from cookie secret (`registry.go:63-70`) |
| 11 | `groq` | `:2438` | `pinnedGroqChatPlan` `groq_chat.go:123` | default / 502 | 5 | own `response_format` member order |
| 12 | `makersuite` | `:2262` → `sendMakerSuiteRequest` `:454` | `pinnedMakerSuitePlan` `google_chat.go:479` | `serveMakerSuiteChatCompletionResponse` / 500 `{error:true}` | 9 | `?key=` query credential; `gemini.apiVersion` ignored (D-H2) |
| 13 | `mistralai` | `:2264` → `sendMistralAIRequest` | `pinnedMistralPlan` `mistral_chat.go:286` | pass-through / 200 `{error:true}` | 14 | `mistral.enablePrefix` read (`mistral_chat.go:309`) |
| 14 | `moonshot` | `:2531` | `pinnedMoonshotChatPlan` `moonshot_chat.go:246` | default / 502 | 9 | mutates messages before assembly (`chat_completions.go:393-396`) |
| 15 | `nanogpt` | `:2476` | `pinnedNanoGPTChatPlan` `nanogpt_chat.go:141` | default / 502 | 7 | declared gap: claude `cache_control` default-off (`nanogpt_chat.go:17-25`) |
| 16 | `openai` | `:2281` + shared tail `:2615-2710` | `pinnedOpenAIChatPlan` `openai_chat.go:26` | default / 502 | 46 (incl. 36 `preset-knob-*`) | reasoning-effort/verbosity tables; `openai.randomizeUserId` (`openai_chat.go:66`) |
| 17 | `openrouter` | `:2301` | `pinnedOpenRouterChatPlan` `openrouter_chat.go:72` | default / 502 | 13 | **undeclared gap**: claude prompt-cache transform (D-H6) |
| 18 | `perplexity` | `:2422` | `pinnedPerplexityChatPlan` `perplexity_chat.go:120` | default / 502 | 5 | `postProcessPrompt` STRICT fold (`:2429`) |
| 19 | `pollinations` | `:2512` | `pinnedPollinationsChatPlan` `pollinations_chat.go:154` | default / 502 | 6 | anonymous credential literal |
| 20 | `siliconflow` | `:2566` | `pinnedSiliconFlowChatPlan` `siliconflow_chat.go:144` | default / 502 | 6 | two literals by body field |
| 21 | `vertexai` | `:2263` (same fn as makersuite) | `pinnedVertexAIPlan` `google_chat.go:483` | `serveVertexAIChatCompletionResponse` / 500 `{error:true}` | 4 | full service-account mode is a named boundary (`vertexai_chat.go:27-30`) |
| 22 | `workers_ai` | `:2576` | `pinnedWorkersAIChatPlan` `workers_ai_chat.go:168` | default / 502 | 6 | account id as path segment, percent-encoded |
| 23 | `xai` | `:2268` → `sendXaiRequest` | `pinnedXAIPlan` `xai_chat.go:254` | pass-through / 200 `{error:true}` | 9 | |
| 24 | `zai` | `:2551` | `pinnedZaiChatPlan` `zai_chat.go:121` | default / 502 | 5 | coding endpoint variant |
| 25 | `minimax` | `:2270` → `sendMinimaxRequest` | `pinnedMinimaxChatPlan` `minimax_chat.go:140`, route-level (`chat_completions.go:263-266`) | own mapping (`chat_completions.go:258-262`) | 5 | **no registry row by design** (`chat_completions_registry.go:27-29`) |
| — | `cometapi` | `:2543` assembles URL/key then throws "temporarily disabled" | **none** | 501, zero outbound (`chat_completions.go:385-390`) | 0 | exemption with reason (`chat_completion_capture_coverage_test.go:42-46`) |

Supporting gates: registry uniqueness (`chat_completions_registry_test.go:14-36`), row ⇒ pinned source
(`:38-48`), scan-visibility (`:101-131`), duplicate-dispatch control (`chat_completions_dispatch_test.go:270-310`),
501-vs-400 distinction (`chat_completion_control_test.go:78-133`), provider egress reaches the declared peer
(`chat_completions_egress_test.go:42-110`).

**Mechanical, not deep:** the 25 `*_chat.go` converter files total 350 KB; this lane read `chat_completions.go`,
`chat_completions_registry.go`, `chat_completions_secrets.go`, `pinned_chat_config.go`, `request_overrides.go`,
`protocols.go`, `compression.go`, `claude_cache.go`, `claude_chat.go` (head + caching call site),
`google_chat.go` (head), `makersuite_chat.go` (URL layer), `openrouter_chat.go`, `openai_chat.go` (plan header),
`minimax_chat.go` (dispatch) in depth and the remaining converters only at their headers/declared-gap blocks plus
the plan-function signature (table above). No converter was claimed deep without being read.

---

## 3. (c) Tokenizer exactness state

Package `internal/tokenizers/**` implements three engines plus a remote passthrough; the server routes are
`internal/server/tokenizers.go` (encode/decode/count) and `tokenizers_remote.go`.

| family | models | engine | exactness | evidence |
|---|---|---|---|---|
| tiktoken | encodings resolved from the pinned `model_to_encoding.json` table (`internal/tokenizers/tiktoken.go:63-105`); `gpt2` is the route encoding (`server/tokenizers.go:87-88`) | in-house port | **exact vs pinned capture** | `internal/tokenizers/tiktoken_test.go:128` `TestTiktokenMatchesPinnedOracle`, segment/rank tests `:516-548`, model selection `:348` |
| SentencePiece BPE + byte fallback | `llama, nerdstash, nerdstash_v2, mistral, yi, gemma, jamba` (`server/tokenizers.go:43-45`) | in-house port of BPE/byte-fallback (no charsmap needed) | **exact vs pinned capture** | `sentencepiece_test.go:65` oracle, merge tie-break `:241`, decode rules `:330` |
| HF `tokenizer.json` | `claude, llama3, qwen2, command-r, command-a, nemo, deepseek` (`server/tokenizers.go:47-48`) | in-house ByteLevel/BPE/WordPiece/Unigram subset | **exact vs pinned capture** | `hftokenizer_test.go:87` oracle, post-processor not applied `:285`, normalizer shapes `:303`, added-token longest match `:330` |
| remote passthrough | kobold `count`, textgenerationwebui `encode` | no local tokenizer: **transport** exactness only | **exact as transport** | `internal/server/tokenizers_remote.go`; differential `docs/api-inventory.md:302` (31 + 12 cases) |

Exactness boundary markers (this is the honest part):

- `X-GoTavern-Tokenizer-Exact: true|false` and `X-GoTavern-Tokenizer-Layout: src/tokenizers|tokenizers|upstream/tokenizers|none`
  are attached **on every tokenizer route**, including 400 and the GET fall-through, so absence is never silently
  exact (`internal/server/tokenizers.go:167-205`, `:54-77`).
- With no vendored tree the routes answer the pinned `Guesstimate` fallback
  `ceil(utf8bytes/3.35)` (`internal/tokenizers/count.go:16-20`; pinned `src/endpoints/tokenizers.js:68-72`, used at
  `:373`, `:551`, `:1032`) and the boot log carries the stable `tokenizer-guesstimate` marker
  (`server/tokenizers.go:60-64`, `:202-204`). So: **exact where a tree resolves, explicitly approximate where it does
  not** — the estimate is never presented as exact.
- The vendored tree exists in this checkout (`upstream/tokenizers/` = 12 entries incl. `external/`, `tiktoken/`,
  seven model files, `PROVENANCE.md`) and is resolved from `InstallRoot` at boot, which production sets
  (`internal/app/server.go:294`); the release layout and the pinned layout are the same path by design
  (`server/tokenizers.go:107-141`).
- Boundary tests (rule 9): `TestContextBoundaryTailStability` and `TestContextBoundarySameCountDifferentTokens`
  (`internal/tokenizers/context_boundary_test.go:84`, `:189`) assert the property a trimming client relies on, the
  same-count/different-tokens counter-case from the pinned capture, and the explicit re-merge counter-property —
  they do **not** claim a universal BPE prefix law (`:1-28`).
- Declared gaps: the pinned `enableDownloadableTokenizers` cold-cache fallback to `llama3.json` is **not** claimed
  (`server/tokenizers.go:21-25`; `docs/config-parity.md:72` classifies the key `implemented`); the server only
  *counts* — the context-boundary trimming happens in the frontend, so "off-by-one changes the provider request" is
  a browser-E2E property, recorded as a named gap (`context_boundary_test.go:24-28`,
  `docs/tokenizer-parity-plan.md:494`).
- **The one writer this lane owns is NOT atomic (D-H17).** Materializing an external tokenizer into
  `<DataRoot>/_cache/<model>.json` uses `os.WriteFile` with the error discarded
  (`internal/server/tokenizers.go:374-380`, `:383-391`), while pinned uses `writeFileAtomicSync` for the same three
  writes (`../SillyTavern/src/endpoints/tokenizers.js:116`, `:136`, `:140`) and creates the cache directory
  recursively (`:98-100`). The uncompressed cache file **wins over every other source on later reads**
  (`tokenizers.go:370-373`), so a crash or ENOSPC during that write leaves a truncated `_cache/<model>.json` that is
  preferred forever and makes `ParseHF` fail on every later request until an operator deletes it. In-process
  serialization hides this (`tokenizerSet.mu`, `:265`, `:337-339`), so only a process-level fault can reach it;
  `internal/faultinject` is the existing seam for the reproducer.

## 4. (d) Config → `HTTPHandlerOptions`, and the request-time config readers

### 4.1 Pipeline

`argv` → `ResolvePaths` (config path, `--configPath` honoured, `--dataRoot`/`SILLYTAVERN_DATAROOT` honoured,
`internal/commandline/paths.go:100-162`) → `configinit.Initialize` (create from the pinned serialisation, migrate
legacy keys, `defaultsDeep`-style merge and **write back**, `internal/configinit/config.go:77-139`, `:473-510`) →
`ResolveCommandLine` (CLI option table `internal/commandline/options.go:164-196`; env-first, then the raw config
file, then a per-call fallback, `:554-585`) → `HTTPHandlerOptionsFromCommandLine`
(`internal/server/http.go:142-240`) → `newHTTPHandler` (`http.go:336-359`) → **per-request re-reads** of the same
config file by some routes (`characters.go:50-92`, `pinned_chat_config.go:35-160`, `google_config.go:23`).

Two structural facts matter for every row below:

1. **No `ConfigFile`/`ConfigPath` ever reaches `HTTPHandlerOptions`.** The struct has `InstallRoot`/`DataRoot` only
   (`http.go:44-136`); production sets `InstallRoot` at `internal/app/server.go:294`. Every request-time config read
   therefore **re-derives** a candidate path instead of using the resolved one. Consequence: **`--configPath` is
   honoured at startup and silently ignored by every request-time reader** — a defect (D-H1).
2. **Two different Go readers exist.** `internal/commandline`'s reader JSON-parses an env var when the *fallback is
   an array* (`options.go:557-566`), matching pinned (`src/util.js:91-94`); the server's chat reader
   `pinnedChatConfigValue` returns the raw env string (`pinned_chat_config.go:78-87`) — a divergence for
   `requestOverrides` (D-H4).

### 4.2 `HTTPHandlerOptions`: every field, and its nil-vs-false discipline

`optionBoolean` collapses an absent value to `false` (`http.go:242-245`); `optionBooleanValue` reports
present/absent (`:247-264`); `*bool`/`*float64`/`any` fields preserve "not configured" so a downstream default can
still apply (`:168-238`). Types are the Go rendering of pinned's `any` reads; the last column names the risk.

| field | type | set from (config key / CLI) | default in Go | nil-vs-false / truthiness risk | pinned source |
|---|---|---|---|---|---|
| `InstallRoot` | string | app wiring, not config | required | — | `src/server-directory.js` (`process.chdir`) |
| `DataRoot` | string | `--dataRoot`, `SILLYTAVERN_DATAROOT`, config `dataRoot` | `./data` | — | `src/command-line.js:290` |
| `CookieSecret` | string | `<dataRoot>/cookie-secret.txt` | file | — | `src/users.js` cookie secret |
| `DisableCSRF` | bool | `disableCsrfProtection` / `--disableCsrf` | `false` | absent ⇒ false = pinned default | `src/command-line.js:316` |
| `EnableCorsProxy` | bool | `enableCorsProxy` / `--corsProxy` | `false` | absent ⇒ false | `:315` |
| `WhitelistEnabled` | bool | `whitelistMode` / `--whitelist` | `true` (pinned default; Go CLI fallback true at `options.go:261`) | — | `:321` |
| `ForwardedWhitelist` | bool | `enableForwardedWhitelist` | `false` fallback (`options.go:305`) | **pinned default true** (`src/middleware/whitelist.js:13`) — latent mismatch, §4.5 | `whitelist.js:13` |
| `Whitelist` | []string | `whitelist` | `[]` fallback (`options.go:306`) | pinned default `["::1","127.0.0.1"]` — latent | `whitelist.js:16` |
| `ForbiddenPage` | []byte | `<dataRoot>/_errors/forbidden-by-whitelist.html` | embedded default | — | pinned static read |
| `PreserveForbiddenPage` | bool | test injection | `false` | — | — |
| `HostWhitelistEnabled` | bool | `hostWhitelist.enabled` | `false` | — | `hostWhitelist.js:8` |
| `HostWhitelistScan` | bool | `hostWhitelist.scan` | `false` fallback (`options.go:309`) | **pinned default true** (`:10`) — latent | `hostWhitelist.js:10` |
| `HostWhitelistHosts` | []string | `hostWhitelist.hosts` | `[]` | — | `:9` |
| `WhitelistImportDomains` | []string | `whitelistImportDomains` | four-host list (`options.go:365-366`) | default list matches pinned | `content-manager.js:22` |
| `hostWhitelistWarningWriter` | io.Writer | test injection | stderr | — | — |
| `BasicAuthEnabled` | bool | `listen && basicAuthMode` | `false` | composed: listener-less mode disables auth (`http.go:155`) | `src/server-main.js` |
| `BasicAuthMode` | bool | `basicAuthMode` | `false` | — | `command-line.js:322` |
| `PerUserBasicAuth` | bool | `perUserBasicAuth` | `false` | — | `middleware/basicAuth.js:13` |
| `BasicAuthUsername` | any | `basicAuthUser.username` | `""` fallback (`options.go:311`) | **pinned default `"user"`** — latent | `middleware/basicAuth.js:33` |
| `BasicAuthPassword` | any | `basicAuthUser.password` | `""` fallback | **pinned default `"password"`** — latent | `:34` |
| `BasicAuthRateLimit` | *float64 | `rateLimiting.basicAuthMaxAttempts` | nil ⇒ 5 | nil-vs-0 preserved | `:16` |
| `AccountsEnabled` | bool | `enableUserAccounts` | `false` | — | `endpoints/settings.js:16` |
| `DiscreetLogin` | bool | `enableDiscreetLogin` | `false` | — | `users-public.js:10` |
| `PreferRealIPHeader` | bool | `rateLimiting.preferRealIpHeader` | `false` | — | `users-private.js:16` |
| `SkipContentCheck` | bool | `skipContentCheck` | `false` | — | `content-manager.js:217` |
| `AllowFullDataBackup` | *bool | `backups.allowFullDataBackup` | nil ⇒ true | nil-vs-false preserved | `users-private.js:158` |
| `AllowKeysExposure` | bool | `allowKeysExposure` | `false` | — | `secrets.js:108` |
| `SettingsBackupRetention` | *float64 | `backups.common.numberOfBackups` | nil ⇒ 50 | nil-vs-0 preserved | `util.js:657` |
| `ExtensionsEnabled` | *bool | `extensions.enabled` | nil ⇒ true | nil-vs-false preserved | `endpoints/extensions.js:73` |
| `ExtensionsAutoUpdate` | *bool | `AutoUpdateKey` via `ResolveAutoUpdate` | nil ⇒ OFF | **recorded product decision overrides pinned default true** (rule 26, `commandline/autoupdate.go`; `docs/config-parity.md:78`) | `settings.js:15` |
| `EnableDownloadableTokenizers` | *bool | `enableDownloadableTokenizers` | nil ⇒ true | set only when resolved (`http.go:174-177`) | `tokenizers.js:60` |
| `RequestCompressionEnabled` | *bool | `performance.requestCompression.enabled` | nil ⇒ false | — | `settings.js:17` |
| `RequestCompressionMin` | any | `…minPayloadSize` | `"256kb"` | string, size-parsed downstream | `:18` |
| `RequestCompressionMax` | any | `…maxPayloadSize` | `"8mb"` | — | `:19` |
| `RequestCompressionTimeout` | any | `…timeout` | `3000` fallback (`options.go:287`) | **pinned default 4000** (`:20`) — latent | `:20` |
| `LoginRateLimitPoints` | *float64 | `rateLimiting.accountsLoginMaxAttempts` | nil ⇒ 5 | nil-vs-0 | `users-public.js:12` |
| `RecoveryRateLimitPoints` | *float64 | `…RecoverMaxAttempts` | nil ⇒ 5 | — | `:13` |
| `ResetRateLimitPoints` | *float64 | `…ResetMaxAttempts` | nil ⇒ 5 | — | `users-private.js:15` |
| `recoveryCodeGenerator`/`resetCodeGenerator` | func | test injection | nil | — | — |
| `ForwardedXRealIP` | *bool | `forwardedHeaders.xRealIp` | nil ⇒ true | — | `express-common.js:39` |
| `ForwardedCFConnectingIP` | *bool | `forwardedHeaders.cfConnectingIp` | nil ⇒ false | — | `:40` |
| `ForwardedXForwardedFor` | *bool | `forwardedHeaders.xForwardedFor` | nil ⇒ true | — | `:41` |
| `SessionTimeoutSeconds` | *float64 | `sessionTimeout` | nil ⇒ -1 | — | `users.js:621` |
| `CorsSettingsConfigured` | bool | `cors.enabled` present | `false` | distinguishes absent block from `enabled:false` (`http.go:181-194`) | `server-main.js:114-121` |
| `CorsEnabled` | *bool | `cors.enabled` | nil ⇒ true | nil-vs-false | `:114` |
| `CorsOrigin` | any | `cors.origin` | `"null"` fallback (`options.go:289`) | pinned default is the ARRAY `["null"]` — latent | `:116` |
| `CorsMethods` | any | `cors.methods` | `["OPTIONS"]` | — | `:117` |
| `CorsAllowedHeaders` | any | `cors.allowedHeaders` | `[]` | — | `:118` |
| `CorsExposedHeaders` | any | `cors.exposedHeaders` | `[]` | — | `:119` |
| `CorsCredentials` | *bool | `cors.credentials` | nil ⇒ false | — | `:120` |
| `CorsMaxAge` | any | `cors.maxAge` | nil | — | `:121` |
| `ImageMetadataThumbnailDimensions` | map | `thumbnails.dimensions.*` | nil ⇒ defaults | `ThumbnailDimensionsSet` distinguishes explicit null | `image-metadata.js:42-44` |
| `Thumbnails` | struct | `thumbnails.{enabled,format,quality}` | pinned defaults | see `thumbnails.go`, `docs/config-parity.md:144-149` | `thumbnails.js:20-22` |
| `CacheBuster` | struct | `cacheBuster.*` | pinned defaults | pinned truthiness quirk reproduced (`cachebuster.go:56`) | `middleware/cacheBuster.js:28-29` |
| `Listen` | bool | `listen` / `--listen` | `false` | also gates the access logger (`http.go:355-359`) | `server-main.js:152-154` |
| `AccessLogEnabled` | bool | `logging.enableAccessLog` | `true` | — | `accessLogWriter.js:6` |
| `ConsoleMinLogLevel` | float64 | `logging.minLogLevel` | `0`, kept as float | NaN silences everything, matching pinned's numeric compare (`options.go:320-336`) | `util.js:1136-1143` |
| `accessLogConsole`, `accessLogErrors`, `tokenizerConsole`, `redirectWarnings`, `accessLogNow` | injection | test-only | stdout/stderr/time.Now | — | — |

**Truthiness helpers, and where they diverge from JavaScript.** `optionBooleanValue` (`http.go:247-264`),
`pinnedToBoolean` (`characters.go:95-118`), `jsBoolean` (`options.go:615-641`) and `configinit.jsTruthyValue`
(`configinit/config.go:719-738`) all reproduce `toBoolean` (string `"true"/"false"` case-insensitive, otherwise
`Boolean(value)`) except for one class: **NaN**. `Boolean(NaN) === false`, but the Go predicates test `typed != 0`,
which is `true` for NaN (`http.go:259-260`, `characters.go:109-111`). A YAML `.nan` in a boolean-valued key therefore
resolves `true` here and `false` in pinned (D-H10, low strength). `configinit.jsTruthyValue` gets this right
(`:734`) — so the inconsistency is between Go helpers, not just Go-vs-JS.

### 4.3 The chat path's request-time config keys (this lane's provider surface)

Read per request through `pinned_config.go`/`request_overrides.go`, not through `HTTPHandlerOptions`:

| key | pinned site | Go site | default | conversion | status |
|---|---|---|---|---|---|
| `promptPlaceholder` | `prompt-converters.js:4` | `pinned_chat_config.go:155-157`; used only by claude `claude_chat.go:818` | `"[Start a new chat]"` (effective, `backends.go:105-111`) | string | **partial**: ai21/cohere/deepseek hardcode the default (`ai21_chat.go:44-50`, `cohere_chat.go:43-79`, `deepseek_chat.go:31-33`) — D-H8 |
| `gemini.thoughtSignatures` | `prompt-converters.js:34` | `pinned_chat_config.go:159-163`; used `openrouter_chat.go:83` | `true` | boolean | implemented, fixture `openrouter-reasoning-signatures-flag-off` |
| `mistral.enablePrefix` | `prompt-converters.js:709` | `mistral_chat.go:309` | `false` | boolean | implemented, fixtures `mistral-prefix-*` |
| `claude.enableSystemPromptCache` | `chat-completions.js:107` | `claude_cache.go:33`; call `claude_chat.go:822` | `false` | boolean | implemented for claude; **missing for openrouter/electronhub/nanogpt** (D-H6) |
| `claude.extendedTTL` | `:106` | `claude_cache.go:34` | `false` | boolean | implemented, fixtures `claude-cache-*` |
| `claude.cachingAtDepth` | `:108-111` | `claude_cache.go:35-39` | `-1` | number, then `<0 ⇒ -1` | **partial**: pinned requires `Number.isInteger`, Go truncates (D-H9) |
| `claude.enableAdaptiveThinking` | `:112`, used `:260` | **no reader** (`claude_chat.go:119-121` hardcodes the true branch, on the belief that the pinned default is true) | `false` (shipped default, `../SillyTavern/default/config.yaml:376`) | boolean | **missing, and divergent on a STOCK install** (D-H3) |
| `gemini.apiVersion` | `:679`, `:730`, `:1911` | **no reader in chat path** (`google_chat.go:67-68` returns the default constant) | `v1beta` | string | **missing for chat** (D-H2); implemented for media/tts via `google_config.go:58-60` |
| `gemini.enableSystemPromptCache` | `:2370` | none | `false` | boolean | declared no-op (`docs/config-inventory.md:255`, `docs/config-parity.md:90`), gated on an unimplemented `/models` probe |
| `openai.randomizeUserId` | `:2296` | `openai_chat.go:66` | `false` | boolean | implemented, fixture-backed (`docs/config-parity.md:107`) |
| `requestOverrides` | `additional-headers.js:203` | `request_overrides.go:65-148` | `[]` | array/object | implemented, but **env-var JSON not parsed** in this reader (D-H4) |

### 4.4 The D-H3 detail: the shipped default is FALSE, so this is a stock-install divergence

`../SillyTavern/default/config.yaml:376` ships `enableAdaptiveThinking: false`, and pinned reads it at module load
(`chat-completions.js:112`) to gate only the 4-6 generation (`:260`:
`... || (enableAdaptiveThinking && /^claude-(opus-4-6|sonnet-4-6)/.test(model))`). Go folds the *true* default in as
a comment (`claude_chat.go:75-77`, `:119-121`), so for `claude-opus-4-6` / `claude-sonnet-4-6` a **stock** GoTavern
is adaptive while a stock pinned server is not, and the two send different `thinking` payloads
(`claude_chat.go:140-176`: an effort string vs `{type:"enabled",budget_tokens:...}`). No provider-wire scenario uses
a 4-6 model — the 20 claude scenarios use only `claude-sonnet-4-5-20250929` (10) and
`claude-3-5-sonnet-20240620` (10), neither of which matches `pinnedClaudeAdaptive46Pattern` — so the fixture set
cannot see this and the capture stays green.

### 4.5 `--configPath` and the request-time readers (D-H1 detail)

`ResolvePaths` honours `--configPath` (`paths.go:108-109`) and `internal/app/server.go:170-173` deliberately lets an
explicit path win over the install-root chdir. The chat converters then resolve the file **only** by walking up from
`<dataRoot>/<handle>`:

```
dataRoot := filepath.Dir(root)                                   // <dataRoot>
{ X/dataRoot/config.yaml, dir(dataRoot)/../config.yaml }          // pinned_chat_config.go:40-44
```

Hence, for `--configPath /etc/st/config.yaml`, or a `--dataRoot` whose parent is not the config directory (a Docker
bind-mount of only `data/`, `SILLYTAVERN_DATAROOT`), **every key in §4.3 silently resolves to its hardcoded default**
while `HTTPHandlerOptions` and `/api/settings` see the real file. A sibling helper already does better
(`charactersConfigCandidates` includes `InstallRoot/config.yaml`, `characters.go:83-92`) — but it too ignores
`--configPath`. The provider-wire replay cannot see any of this because its harness *constructs the guessed layout*:
`root/data` + `root/config.yaml` (`chat_completions_oracle_test.go:322-333`). This is the strongest Lane D finding
(strength 4): it changes the final provider request for a supported, documented launch flag.

### 4.6 Fallback-vs-pinned-default mismatches (latent; only when the file lacks the key)

`configinit` merges the pinned default set and writes it back (`configinit/config.go:109-138`), so for a stock or
migrated writable install these fallbacks never apply. They apply when the merge write fails, when the key is
explicitly removed after boot (Go re-reads the file, pinned caches — D-H7), or when a request-time reader misses the
file (D-H1). Rows: `enableForwardedWhitelist` (`false` vs `true`), `whitelist` (`[]` vs `["::1","127.0.0.1"]`),
`hostWhitelist.scan` (`false` vs `true`), `browserLaunch.enabled` (`false` vs `true`, `options.go:217`),
`basicAuthUser.username/password` (`""` vs `"user"/"password"`), `performance.requestCompression.timeout`
(`3000` vs `4000`), `requestProxy.url` (`""` vs the documented placeholder) and `requestProxy.bypass`
(`[]` vs `["localhost","127.0.0.1"]`) — `options.go:214-316` versus `docs/config-inventory.md:31-149`.

### 4.7 Answer to "an option with no Go counterpart?"

**Yes — three, all in the chat path**, plus two partials:

1. `claude.enableAdaptiveThinking` — pinned `:112`/`:260`; no Go reader at all (D-H3).
2. `gemini.apiVersion` — pinned `:679`/`:730`/`:1911`; the chat path hardcodes `v1beta` (D-H2). `docs/config-parity.md:89`
   classifies the key **implemented** and names `makersuite_chat.go` as evidence, which is not true for the chat
   route — a documentation claim ahead of evidence (rule 36).
3. `gemini.enableSystemPromptCache` — declared no-op with a startup warning (correctly classified).

Partials: `promptPlaceholder` (only claude honours it) and the `claude.*` cache flags (only claude-and-OpenRouter's
sibling route is missing the OpenRouter half).

## 5. (e) Hypothesis rows

Ids, classifications and strength follow `docs/alpha16/README.md` §3. Full evidence lists are in `fragments/d.json`.

| id | title | class | surface | strength |
|---|---|---|---|---|
| D-H1 | Chat-path config readers ignore the resolved config path (`--configPath`, non-adjacent `--dataRoot`) | confirmed-defect | provider-wire | 4 |
| D-H2 | `gemini.apiVersion` not read by the MAKERSUITE/chat route; parity doc says implemented | confirmed-defect | provider-wire | 4 |
| D-H3 | `claude.enableAdaptiveThinking` has no Go reader; 4-6 models are always adaptive though the shipped default is false | confirmed-defect | provider-wire | 4 |
| D-H4 | `SILLYTAVERN_REQUESTOVERRIDES` JSON env override is not parsed by the server reader → no override headers | verified-risk | provider-wire | 4 |
| D-H5 | Redirect credential stripping is per-initial-request (Go) vs per-hop (pinned); POST→GET body headers differ | verified-risk | provider-wire | 3 |
| D-H6 | OpenRouter's claude prompt-cache transform is absent and undeclared | verified-risk | provider-wire | 3 |
| D-H7 | Config is re-read per request/ key here, cached once in pinned | untested-hypothesis | provider-wire | 2 |
| D-H8 | `promptPlaceholder` honoured only by claude; three sources hardcode the default | verified-risk | provider-wire | 3 |
| D-H9 | `claude.cachingAtDepth` non-integer is truncated instead of disabled | verified-risk | provider-wire | 3 |
| D-H10 | Nine fallback defaults differ from pinned; NaN boolean truthiness diverges | untested-hypothesis | startup-state | 2 |
| D-H11 | The wire-exact (no proxy/redirect/decompress/bounds) client is selectable by an env var with no production guard | untested-hypothesis | provider-wire | 2 |
| D-H12 | Streamed non-2xx response forwards the provider body but not its reason phrase | untested-hypothesis | browser-wire | 2 |
| D-H13 | No truncation teeth-test for the chat-completions forwarder | untested-hypothesis | streaming/cancel | 2 |
| D-H14 | Production-transport bounds/encodings/keep-alive diverge from pinned by declared design | intentional-parity | provider-wire | 5 |
| D-H15 | MINIMAX has no registry row and COMETAPI answers 501 | intentional-parity | provider-wire | 5 |
| D-H16 | Non-request-scoped provider fetches (zai image/video) and their wall-clock bound | intentional-parity | provider-wire | 4 |
| D-H17 | Tokenizer cache materialization writes non-atomically where pinned writes atomically; a torn cache file is permanently preferred | verified-risk | persisted-bytes | 3 |

**The five strongest** (for the Lead's assembling list): **D-H1** (confirmed-defect, user-visible provider-request
change on a supported launch flag), **D-H2** (confirmed-defect, wrong endpoint version -> provider 404; a parity doc
claims otherwise), **D-H4** (verified-risk, documented env override produces no header), **D-H3** (confirmed-defect,
different thinking payload for 4-6 models), **D-H6** (verified-risk, body differs whenever the pinned claude cache
flag is on). **D-H5** is the strongest *security-adjacent* row and is ranked sixth in that list because its exposure requires an
unusual redirect chain: it ends at a domain that is still a subdomain of the original provider, so it is a
parity/credential-hygiene defect rather than a confirmed leak to a third party.

## 6. Questions this lane could not decide

1. **D-H5 needs a probe, not a source reading.** Does pinned 1.19.0 at the recorded commit follow a multi-hop chain
   the way `node-fetch/src/index.js:208` reads (per hop)? A controlled peer chain A -> B -> A(subdomain) would decide
   it, and the existing single-hop tests cannot.
2. **Is the 120 s response-header bound a product decision or an unstated divergence?** Pinned never times out; a
   real provider that stalls after the request is sent will answer the user differently. It belongs in the product
   contract list next to `enableKeepAlive`/auto-update, not only in a code comment.
3. **`configinit` write-vs-not-write** (Lane B): `mergeDefaults` marks a `changed` iteration for sequence elements
   (`configinit/config.go:497-508`) where pinned's write decision counts only missing *keys*
   (`src/config-init.js:145-158`, `:216-229`). Whether that produces an extra startup write on some real config is a
   B-domain question, and it gates how reachable §4.6 is.
4. **`docs/config-parity.md` is generated from `tools/inventories/config-parity.json`**; fixing the D-H2/D-H3 rows
   requires editing that inventory (Lead/E scope), not the generated table.
5. **`gemini.apiVersion` for the makersuite `/status` arm** (`makersuite_chat.go:166-180`, pinned `:1911`) was only
   read mechanically; the status route was out of this lane's deep scope.
