package server

// Pinned chat-completion generation, from
// src/endpoints/backends/chat-completions.js:
//
//	POST /api/backends/chat-completions/generate   chat-completions.js:2242
//
// The wire form this route must produce is NOT derived from a reading of the
// pinned source. It is the captured contract in
// tests/oracle/sillytavern-1.19.0-provider-wire.json, produced by pointing the
// pinned backend at a recording provider, and that capture is the
// specification: when this code and a capture disagree, the capture is right
// and this code is wrong. Three captured details are not guessable from the
// source alone:
//
//   - an OPENAI source whose reverse_proxy has no trailing slash still reaches
//     the provider as `//chat/completions`, because
//     `new URL(reverse_proxy).toString()` already ends in `/` and the pinned
//     code then appends `/chat/completions` to it;
//   - a streamed reply is forwarded with NO content-type at all, which is also
//     why its Vary header carries only the CORS origin entry: Express's
//     compression middleware never reaches its vary step without a Content-Type;
//   - a provider error status is answered at status 200 with the pinned
//     {error:{message}, quota_error} shape, not forwarded as a status.
//
// WHICH SOURCES EXIST IS NOT DECIDED HERE. Every routed source is one row of
// pinnedChatCompletionSourceRegistry (chat_completions_registry.go), which binds
// its name to its three behaviours -- plan, response and transportFailure -- so a
// source is routed in exactly one place. A source the pinned backend knows but
// this route has not ported has NO row and is answered 501 rather than faked; a
// source the pinned backend itself does not route is answered 400
// {"error":true}, which is what the pinned handler's final else branch sends.
//
// WHAT STAYS IN THIS FILE: the route registration, the handler, the account and
// data-root prerequisites, the source resolution and dispatch, the generic
// lifecycle (stream forwarding and the shared response tail), and the machinery
// every shared-path source builds its request with -- the ordered-body assembler,
// the header framing and the credential header set.
//
// THIS FILE IS LARGE ON PURPOSE AND MUST STAY SHARED. The ordered-JSON helpers it
// uses (orderedNodeJSON + marshalOrderedNodeJSON) are the reason member order is
// part of the byte contract: replacing them with map[string]any and
// encoding/json would reorder members and change every provider body digest.

import (
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"syscall"

	"github.com/cocokoishi/gotavern/internal/outbound"
	"github.com/cocokoishi/gotavern/internal/startup"
)

const (
	pinnedOpenAIAPIURL         = "https://api.openai.com/v1"
	chatCompletionSourceOpenAI = "openai"
	chatCompletionSourceCustom = "custom"
)

// pinnedChatCompletionSources lists every value of the pinned
// CHAT_COMPLETION_SOURCES constant (src/constants.js). A source in this set is
// one the pinned backend routes somewhere; a source outside it falls to the
// pinned handler's unsupported-source branch.
var pinnedChatCompletionSources = map[string]bool{
	"openai": true, "claude": true, "openrouter": true, "ai21": true,
	"makersuite": true, "vertexai": true, "mistralai": true, "custom": true,
	"cohere": true, "perplexity": true, "groq": true, "chutes": true,
	"electronhub": true, "nanogpt": true, "deepseek": true, "aimlapi": true,
	"xai": true, "pollinations": true, "moonshot": true, "fireworks": true,
	"cometapi": true, "azure_openai": true, "zai": true, "siliconflow": true,
	"minimax": true, "workers_ai": true,
}

// pinnedTextCompletionModels is TEXT_COMPLETION_MODELS (src/endpoints/
// tokenizers.js:31). The pinned handler switches to the /completions endpoint
// and a flattened prompt for exactly these model names.
var pinnedTextCompletionModels = map[string]bool{
	"gpt-3.5-turbo-instruct": true, "gpt-3.5-turbo-instruct-0914": true,
	"text-davinci-003": true, "text-davinci-002": true, "text-davinci-001": true,
	"text-curie-001": true, "text-babbage-001": true, "text-ada-001": true,
	"code-davinci-002": true, "code-davinci-001": true, "code-cushman-002": true,
	"code-cushman-001": true, "text-davinci-edit-001": true, "code-davinci-edit-001": true,
	"text-embedding-ada-002": true, "text-similarity-davinci-001": true,
	"text-similarity-curie-001": true, "text-similarity-babbage-001": true,
	"text-similarity-ada-001": true, "text-search-davinci-doc-001": true,
	"text-search-curie-doc-001": true, "text-search-babbage-doc-001": true,
	"text-search-ada-doc-001": true, "code-search-babbage-code-001": true,
	"code-search-ada-code-001": true,
}

func init() {
	domainRouteRegistrars = append(domainRouteRegistrars, registerChatCompletionRoutes)
}

func registerChatCompletionRoutes(mux *http.ServeMux, accounts *accountRuntime, notFoundPage []byte, options HTTPHandlerOptions) {
	mux.HandleFunc("/api/backends/chat-completions/generate", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			serveStatic(w, r, notFoundPage, options)
			return
		}
		accounts.serveChatCompletionGenerate(w, r)
	})
}

// pinnedChatCompletionFailure is a response the pinned handler produces before
// it reaches a provider. A nil payload is a plain-text status, which is how the
// body-parser and transport failures are answered here.
type pinnedChatCompletionFailure struct {
	status  int
	payload *orderedNodeJSON
}

func pinnedChatCompletionJSONFailure(status int, payload orderedNodeJSON) *pinnedChatCompletionFailure {
	return &pinnedChatCompletionFailure{status: status, payload: &payload}
}

// pinnedChatCompletionTransportFailure is the pinned catch branch
// (chat-completions.js:2717-2724): status 502 with {error:{message, ...error}}.
// Spreading a JavaScript Error contributes no enumerable members, so the body
// is always {error:{message}}.
func pinnedChatCompletionTransportFailure(err error) *pinnedChatCompletionFailure {
	payload := nodeObject()
	errorMember := nodeObject()
	errorMember.setMember("message", nodeString(pinnedChatCompletionTransportMessage(err)))
	payload.setMember("error", errorMember)
	return pinnedChatCompletionJSONFailure(http.StatusBadGateway, payload)
}

// pinnedChatCompletionTransportBadGateway is the SHARED catch, and the answer for every source whose pinned
// branch reaches it: 502 with {error:{message}}.
func pinnedChatCompletionTransportBadGateway(err error) *pinnedChatCompletionFailure {
	return pinnedChatCompletionTransportFailure(err)
}

// pinnedChatCompletionTransportErrorFlagOK is the catch of the EIGHT sources whose pinned branch calls
// `response.send({error:true})` with NO status argument, so a fetch that throws answers 200 {"error":true}
// rather than the shared 502.
//
// THE CAUSE IS NOW ATTACHED, AND THAT IS A DELIBERATE, DECLARED DIVERGENCE (product decision 2026-10-25).
// Pinned drops the thrown error before building the body, so a real DNS/TLS/proxy/timeout failure reaches the
// user as "cannot connect" with nothing else -- which is exactly the report P0-A started from, and exactly
// what AGENTS.md rule 35 forbids. The frontend reads `error === true`; adding a `message` member keeps every
// reader of that flag working while making the stage visible in the payload and in the server log. The body is
// a SUPERSET, never a replacement: `error` stays exactly what pinned sends, and any comparison of this body
// carries a named exemption for the added member, with both values recorded beside it.
func pinnedChatCompletionTransportErrorFlagOK(err error) *pinnedChatCompletionFailure {
	return pinnedChatCompletionJSONFailure(http.StatusOK, pinnedChatCompletionErrorFlagWithCause(err))
}

// pinnedChatCompletionTransportErrorFlagServerError is the catch of GOOGLE and CLAUDE: 500 {"error":true}
// while the headers are unsent (:787-791 and :441-446), not the shared 502. Same superset rule as above.
func pinnedChatCompletionTransportErrorFlagServerError(err error) *pinnedChatCompletionFailure {
	return pinnedChatCompletionJSONFailure(http.StatusInternalServerError, pinnedChatCompletionErrorFlagWithCause(err))
}

func pinnedChatCompletionTransportMessage(err error) string {
	if err == nil {
		return "Unknown error occurred"
	}
	if errors.Is(err, syscall.ECONNREFUSED) {
		return "Connection refused: " + err.Error()
	}
	if err.Error() != "" {
		return err.Error()
	}
	return "Unknown error occurred"
}

// pinnedChatCompletionErrorFlag is the pinned `{ error: true }` body.
func pinnedChatCompletionErrorFlag() orderedNodeJSON {
	payload := nodeObject()
	payload.setMember("error", nodeBool(true))
	return payload
}

// pinnedChatCompletionErrorFlagWithCause is that body plus a causal `message`, and it exists because the
// pinned body deliberately throws the error away. The member's VALUE comes from the transport's own taxonomy,
// so it names the stage a user needs -- dns, connect, tls handshake, proxy CONNECT, timeout, cancellation,
// mid-stream close, HTTP status -- and it never carries a credential: the taxonomy is built from the request's
// host and the failure stage, never from headers (see docs/network-egress.md 3 and the outbound error tests).
func pinnedChatCompletionErrorFlagWithCause(err error) orderedNodeJSON {
	payload := pinnedChatCompletionErrorFlag()
	payload.setMember("message", nodeString(pinnedChatCompletionTransportMessage(err)))
	return payload
}

// pinnedChatCompletionApplyCustomPromptPostProcessing is chat-completions.js:2246-2253, the ROUTE-WIDE
// prompt transform. Three things about it are contract, not convenience:
//
//   - it runs BEFORE the per-source dispatch, so every source sees the processed messages (MINIMAX
//     included; its own MERGE_TOOLS fold then runs on the result, exactly as pinned's does);
//   - it MUTATES request.body.messages, and the source branches read that member afterwards;
//   - its guard is `Array.isArray(request.body.messages) && postProcessingType`: a string prompt, or an
//     absent/falsy type, is left completely alone. An UNKNOWN type is not an error either -- postProcessPrompt
//     switches on the type and its default arm returns the messages unchanged.
//
// It applies ONCE, here. Applying it again inside the plan would double-process a body the route already
// transformed (harmless for 'merge', wrong for the placeholder types).
func pinnedChatCompletionApplyCustomPromptPostProcessing(body orderedNodeJSON) (orderedNodeJSON, *pinnedChatCompletionFailure) {
	processingType, hasType := body.member("custom_prompt_post_processing")
	if !hasType || !pinnedJSTruthy(processingType) {
		return body, nil
	}
	messages, hasMessages := body.member("messages")
	if !hasMessages || messages.kind != 'a' {
		return body, nil
	}
	text, isString := processingType.stringValue()
	if !isString {
		return body, nil
	}
	processed, err := backendsPostProcessPrompt(messages, text, backendsPromptNamesFor(body))
	if err != nil {
		// The pinned call sits inside the handler's try, so a throw becomes its catch.
		return body, pinnedChatCompletionTransportFailure(err)
	}
	body.setMember("messages", processed)
	return body, nil
}

func (runtime *accountRuntime) serveChatCompletionGenerate(w http.ResponseWriter, request *http.Request) {
	body, ok := readPinnedJSONBody(request)
	if !ok {
		// Express's JSON body parser answers its own 400 page for a malformed
		// body; GoTavern answers the same status with a plain-text body.
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	// chat-completions.js:2246-2253, before ANY source branch is reached.
	body, postProcessingFailure := pinnedChatCompletionApplyCustomPromptPostProcessing(body)
	if postProcessingFailure != nil {
		respondOrderedNodeJSON(w, postProcessingFailure.status, *postProcessingFailure.payload)
		return
	}
	account := runtime.requestAccount(accountFromContext(request))
	if account == nil {
		serveStatusText(w, http.StatusForbidden)
		return
	}
	if runtime.options.DataRoot == "" || account.string("handle") == "" {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	directories, err := startup.DirectoriesForUser(runtime.options.DataRoot, account.string("handle"))
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}

	// MINIMAX is its own transport (a CN/global endpoint pair, a server-side messages fold, a
	// max_tokens clamp and its own non-2xx shape), so it is dispatched BEFORE the shared plan. It has
	// to be before: pinnedChatCompletionPlan answers 501 for a source it does not plan, so reaching
	// that call first is what made this lane report 501 for a source it had just implemented.
	// It has NO registry row for exactly this reason; see chat_completions_registry.go.
	if pinnedChatCompletionSourceName(body) == chatCompletionSourceMinimax {
		runtime.serveMinimaxChatCompletion(w, request, body, directories)
		return
	}

	row, plan, failure := pinnedChatCompletionResolve(body, directories, runtime.options.CookieSecret)
	if failure != nil {
		if failure.payload == nil {
			serveStatusText(w, failure.status)
			return
		}
		respondOrderedNodeJSON(w, failure.status, *failure.payload)
		return
	}

	// No client-side timeout: the pinned fetch has none, and a provider that
	// never answers must leave the caller waiting rather than be invented away.
	// Cancellation still tears the upstream connection down, because the
	// outbound client watches this request's context.
	response, err := outbound.SendStreaming(request.Context(), *plan, 0)
	if err != nil {
		// The catch shape is PER SOURCE and is not guessable from the shared code: eight sources answer
		// 200 {"error":true}, google and claude answer 500 {"error":true}, azure answers 500
		// {"error":{message}} with its own wording, and the rest answer the shared 502.
		failure := row.transportFailure(err)
		respondOrderedNodeJSON(w, failure.status, *failure.payload)
		return
	}
	row.response(w, request, response, body)
}

// forwardPinnedChatCompletionStream reproduces forwardFetchResponse
// (src/util.js:732) for a streamed reply. Pinned sets the Express status
// directly, never sets a content type, and pipes the provider body; a source
// error is not forwarded and does not end the response, which is what leaves a
// caller whose provider died mid-stream hanging until it disconnects.
func forwardPinnedChatCompletionStream(w http.ResponseWriter, request *http.Request, response *outbound.Response) {
	status := response.Status
	if status == http.StatusUnauthorized {
		// Pinned rewrites 401 to 400 so a streamed reply cannot reset the
		// browser's Basic Auth prompt.
		status = http.StatusBadRequest
	}
	// No Content-Type is set, so Express's compression middleware never runs its
	// vary step and Vary keeps only the CORS Origin entry. Marking the header as
	// present with no value stops net/http from sniffing the first write and
	// inventing a content type the pinned response does not have.
	w.Header().Set("Vary", "Origin")
	w.Header()["Content-Type"] = nil

	if response.Status < 200 || response.Status > 299 {
		body, _ := io.ReadAll(response.Stream)
		_ = response.Stream.Close()
		w.WriteHeader(status)
		_, _ = w.Write(body)
		return
	}

	w.WriteHeader(status)
	flusher, _ := w.(http.Flusher)
	if flusher != nil {
		flusher.Flush()
	}
	buffer := make([]byte, 32*1024)
	for {
		count, err := response.Stream.Read(buffer)
		if count > 0 {
			if _, writeErr := w.Write(buffer[:count]); writeErr != nil {
				break
			}
			if flusher != nil {
				flusher.Flush()
			}
		}
		if err != nil {
			break
		}
	}
	_ = response.Stream.Close()

	if response.Truncated {
		// Pinned pipe() does not forward a source error and never ends the
		// Express response, so the caller is left hanging. Reproduce that rather
		// than inventing a terminal sentinel the pinned backend never sends.
		<-request.Context().Done()
	}
}

// pinnedChatCompletionStreams reports `if (request.body.stream)` truthiness.
func pinnedChatCompletionStreams(body orderedNodeJSON) bool {
	stream, exists := body.member("stream")
	return exists && pinnedJSTruthy(stream)
}

// pinnedChatCompletionQuotaError implements
// `fetchResponse.status === 429 && errorData?.error?.type === 'insufficient_quota'`
// where errorData is tryParse(responseText).
func pinnedChatCompletionQuotaError(providerBody []byte) bool {
	parsed, err := decodeOrderedNodeJSON(providerBody)
	if err != nil {
		return false
	}
	errorType := nodeGet(parsed, "error", "type")
	text, isString := errorType.stringValue()
	return isString && text == "insufficient_quota"
}

// pinnedChatCompletionResolve turns a request body into the row that serves it and the outbound request that
// row plans. It reports three things because the caller needs all three: the ROW supplies the response side
// and the catch shape once the fetch has run, so a caller that had only the request would have to resolve
// the source again and could disagree with itself.
//
// The three outcomes are the ones the pinned dispatcher has, and they must stay distinguishable:
//
//   - a routed source: the row and its request;
//   - a name the pinned matrix knows but this route has no row for (cometapi): 501, NO request. This is
//     the "not written yet" gap, and answering it as a 400 would make it indistinguishable from a refusal;
//   - a name the pinned matrix does not know: 400 {"error":true}, which is the pinned closing else.
func pinnedChatCompletionResolve(body orderedNodeJSON, directories startup.UserDirectories, affinityKey string) (chatCompletionSource, *outbound.Request, *pinnedChatCompletionFailure) {
	sourceName := pinnedChatCompletionSourceName(body)
	row, routed := pinnedChatCompletionSourceByName(sourceName)
	if !routed {
		if pinnedChatCompletionSources[sourceName] {
			// A pinned source whose transport this route does not implement.
			// Answering "not implemented" is deliberate: a fabricated success
			// would be worse than a visible gap.
			return chatCompletionSource{}, nil, &pinnedChatCompletionFailure{status: http.StatusNotImplemented}
		}
		return chatCompletionSource{}, nil, pinnedChatCompletionJSONFailure(http.StatusBadRequest, pinnedChatCompletionErrorFlag())
	}
	// The text-completion decision is made from the REQUEST body, once, before the row's planner runs, for
	// the same reason the pinned handler reads it once at :2279 before its per-source branches: a planner
	// may MUTATE the body (nanogpt appends `:online` to the model, moonshot and perplexity rewrite
	// messages), and a decision taken after that mutation would be a different decision.
	request := chatCompletionRequest{
		body:             body,
		directories:      directories,
		affinityKey:      affinityKey,
		isTextCompletion: pinnedChatCompletionIsTextCompletion(body),
	}
	plan, failure := row.plan(request)
	if failure != nil {
		return row, nil, failure
	}
	return row, plan, nil
}

// pinnedChatCompletionPlan resolves the pinned target selection and request body for the sources this route
// implements. It is the plan half of pinnedChatCompletionResolve, kept as its own entry point because the
// per-source tests drive the plan directly and need the failure rather than the row.
func pinnedChatCompletionPlan(body orderedNodeJSON, directories startup.UserDirectories, affinityKey string) (*outbound.Request, *pinnedChatCompletionFailure) {
	_, plan, failure := pinnedChatCompletionResolve(body, directories, affinityKey)
	return plan, failure
}

// chatCompletionRequest is everything a planner needs that is not specific to its source, resolved once by
// pinnedChatCompletionResolve and handed to every planner identically.
type chatCompletionRequest struct {
	body        orderedNodeJSON
	directories startup.UserDirectories
	affinityKey string
	// isTextCompletion is `TEXT_COMPLETION_MODELS.includes(body.model) || typeof body.messages === 'string'`
	// (:2279), evaluated ONCE against the request body before the planner can mutate it.
	isTextCompletion bool
}

// chatCompletionPlanInputs is what a shared-path source's planner hands the assembler: the request body it
// has finished shaping, plus the four things its own pinned branch assigns (apiUrl, apiKey, headers and
// bodyParams). Sources with their own transport (ai21, claude, cohere, azure, google, minimax, ...) never
// use this -- they build their outbound.Request themselves.
type chatCompletionPlanInputs struct {
	// body is the request body AS THE ASSEMBLY MUST READ IT, i.e. after the planner's own mutations.
	body          orderedNodeJSON
	apiURL        string
	apiKey        orderedNodeJSON
	customHeaders orderedNodeJSON
	bodyParams    orderedNodeJSON
}

// THE OPENAI REASONING-EFFORT AND VERBOSITY TABLES (src/constants.js:459-507), applied at
// chat-completions.js:2599-2613 to the CUSTOM and OPENAI sources only. AZURE carries the same data under
// pinnedAzureOpenAI* names, because its own branch consults it at :1731; these are the shared names the
// shared tail uses, and both copies are asserted against their own recorded scenarios.
//
// The two tables do NOT compose the same way, and each difference is recorded:
//
//   - OPENAI_REASONING_EFFORT_MODELS is a MEMBERSHIP test, and a model OUTSIDE it gets NO reasoning_effort
//     at all -- the raw value is not forwarded. Inside it, OPENAI_FIXED_REASONING_EFFORT WINS over the map,
//     so the same 'min' input sends 'medium' for gpt-5.3-chat-latest and 'minimal' for o3.
//   - OPENAI_VERBOSITY_MODELS is an anchored PREFIX regex, not a membership list: 'o3' is a reasoning model
//     and still misses it, so verbosity is DROPPED for o3 and forwarded for gpt-5.3-chat-latest.
//
// openai-reasoning-effort-{map,fixed,outside-table} pin all three outcomes from bodies that differ only in
// `model`, which is what makes the tables the only possible explanation.
var pinnedOpenAIReasoningEffortModels = map[string]bool{
	"o1": true, "o3-mini": true, "o3-mini-2025-01-31": true, "o4-mini": true,
	"o4-mini-2025-04-16": true, "o3": true, "o3-2025-04-16": true,
	"gpt-5": true, "gpt-5-2025-08-07": true, "gpt-5-mini": true, "gpt-5-mini-2025-08-07": true,
	"gpt-5-nano": true, "gpt-5-nano-2025-08-07": true, "gpt-5.1": true,
	"gpt-5.1-2025-11-13": true, "gpt-5.1-chat-latest": true, "gpt-5.2": true,
	"gpt-5.2-2025-12-11": true, "gpt-5.2-chat-latest": true, "gpt-5.3-chat-latest": true,
	"gpt-5.4": true, "gpt-5.4-2026-03-05": true, "gpt-5.4-mini": true,
	"gpt-5.4-mini-2026-03-17": true, "gpt-5.4-nano": true, "gpt-5.4-nano-2026-03-17": true,
	"gpt-5.5": true, "gpt-5.5-2026-04-23": true, "gpt-5.6": true, "gpt-5.6-sol": true,
	"gpt-5.6-terra": true, "gpt-5.6-luna": true, "gpt-6-astra": true,
}

// pinnedOpenAIFixedReasoningEffort is OPENAI_FIXED_REASONING_EFFORT: a model that accepts ONE effort only.
var pinnedOpenAIFixedReasoningEffort = map[string]string{"gpt-5.3-chat-latest": "medium"}

// pinnedOpenAIReasoningEffortMap is OPENAI_REASONING_EFFORT_MAP. Not the identity.
var pinnedOpenAIReasoningEffortMap = map[string]string{"min": "minimal"}

// pinnedOpenAIVerbosityModel is /^(?:gpt-5|gpt-6-astra)/ -- ANCHORED, so a model whose id merely contains
// those characters does not match.
var pinnedOpenAIVerbosityModel = regexp.MustCompile(`^(?:gpt-5|gpt-6-astra)`)

// pinnedOpenAIKoboldCPPModel is /^koboldcpp\/(.+)$/ (:2604), a CUSTOM-only escape hatch that forwards the
// RAW effort even for a model the table does not list.
var pinnedOpenAIKoboldCPPModel = regexp.MustCompile(`^koboldcpp/(.+)`)

// pinnedChatCompletionRequestBodyMemberOrder is the FIXED key order of the pinned requestBody object literal
// (chat-completions.js:2652-2668). EVERY one of those keys is declared there, with `undefined` for a member
// the request did not send; `JSON.stringify` then drops the undefined ones. The POSITION still exists, and
// that is what decides where a bodyParams member lands: `{...literal, ...bodyParams}` keeps an existing
// key's insertion position and only APPENDS a key the literal does not name.
//
// That distinction is the whole of custom-include-body. An included `top_k` must occupy the fixed slot
// between top_p and n, while an included `service_tier` (which the literal does not name) is appended after
// n. Both bodies are 232 bytes; only the order differs, and the recording is what caught it.
var pinnedChatCompletionRequestBodyMemberOrder = []string{
	"messages", "prompt", "model", "temperature", "max_tokens", "max_completion_tokens", "stream",
	"presence_penalty", "frequency_penalty", "top_p", "top_k", "stop", "logit_bias", "seed", "n",
}

// pinnedChatCompletionAssemble is the shared openai-compatible tail (chat-completions.js:2615-2710): the
// missing-key guard, the stop/tools/response_format copies, the ordered member list, the
// `/chat/completions` vs `/completions` choice, the absolute-URL check and the header framing.
//
// THE MEMBER ORDER IS THE CONTRACT. requestBody is built by SETTING members in the pinned source order --
// prompt-or-messages first, then the fixed model/temperature/... list, then whatever bodyParams holds -- and
// the ordered-JSON marshaller emits exactly that order. A map here would reorder every body and change
// every recorded digest.
func pinnedChatCompletionAssemble(sourceName string, request chatCompletionRequest, inputs chatCompletionPlanInputs) (*outbound.Request, *pinnedChatCompletionFailure) {
	body := inputs.body
	bodyParams := inputs.bodyParams

	// chat-completions.js:2615 -- `!apiKey && !request.body.reverse_proxy && source !== CUSTOM`. The guard
	// reads the REQUEST MEMBER for every source, which matters for openrouter: that branch ignores
	// reverse_proxy when it builds the URL but still lets a request that carries one skip this refusal.
	reverseProxyTruthy := false
	if reverseProxy, exists := body.member("reverse_proxy"); exists && pinnedJSTruthy(reverseProxy) {
		reverseProxyTruthy = true
	}
	if !pinnedJSTruthy(inputs.apiKey) && !reverseProxyTruthy && sourceName != chatCompletionSourceCustom {
		return nil, pinnedChatCompletionJSONFailure(http.StatusBadRequest, pinnedChatCompletionErrorFlag())
	}

	// chat-completions.js:2599-2613. The reasoning-effort and verbosity tables apply to CUSTOM and OPENAI
	// ONLY -- the pinned guard is `[CUSTOM, OPENAI].includes(source)` -- and they run BEFORE the stop copy,
	// so their bodyParams insertion order is reasoning_effort then verbosity. Neither name is in the fixed
	// literal, so both are APPENDED to the body; the recorded bodies show them after `stream`.
	if sourceName == chatCompletionSourceOpenAI || sourceName == chatCompletionSourceCustom {
		model := ""
		if member, exists := body.member("model"); exists {
			if text, isString := member.stringValue(); isString {
				model = text
			}
		}
		if effort, exists := body.member("reasoning_effort"); exists && pinnedJSTruthy(effort) {
			if pinnedOpenAIReasoningEffortModels[model] {
				// `FIXED[model] ?? MAP[effort] ?? effort` -- nullish, so a model with a fixed effort
				// ignores the map entirely, and an effort the map does not know is forwarded raw.
				mapped := effort
				if fixed, hasFixed := pinnedOpenAIFixedReasoningEffort[model]; hasFixed {
					mapped = nodeString(fixed)
				} else if text, isString := effort.stringValue(); isString {
					if known, hasKnown := pinnedOpenAIReasoningEffortMap[text]; hasKnown {
						mapped = nodeString(known)
					}
				}
				bodyParams.setMember("reasoning_effort", mapped)
			}
			if sourceName == chatCompletionSourceCustom && pinnedOpenAIKoboldCPPModel.MatchString(model) {
				// Assigned AFTER the table arm and unconditionally, so it overwrites a mapped value.
				bodyParams.setMember("reasoning_effort", effort)
			}
		}
		if verbosity, exists := body.member("verbosity"); exists && pinnedJSTruthy(verbosity) {
			if pinnedOpenAIVerbosityModel.MatchString(model) {
				bodyParams.setMember("verbosity", verbosity)
			}
		}
	}

	// chat-completions.js:2620-2623. A non-empty stop array is copied into the
	// parameter object, so it also overwrites a stop supplied by
	// custom_include_body.
	if stop, exists := body.member("stop"); exists && stop.kind == 'a' && len(stop.array) > 0 {
		bodyParams.setMember("stop", stop)
	}
	// chat-completions.js:2636-2639.
	if !request.isTextCompletion {
		if tools, exists := body.member("tools"); exists && tools.kind == 'a' && len(tools.array) > 0 {
			bodyParams.setMember("tools", tools)
			if toolChoice, choiceExists := body.member("tool_choice"); choiceExists {
				bodyParams.setMember("tool_choice", toolChoice)
			}
		}
	}
	// chat-completions.js:2641-2650. A custom source may already have set
	// response_format from its own branch above.
	if _, already := bodyParams.member("response_format"); !already {
		if schema, exists := body.member("json_schema"); exists && pinnedJSTruthy(schema) {
			bodyParams.setMember("response_format", pinnedChatCompletionResponseFormat(schema))
		}
	}

	// chat-completions.js:2652-2669. JSON.stringify drops only `undefined`, so a
	// member is included exactly when it is present, and `temperature: 0` or
	// `stream: false` survive while an absent member does not appear at all.
	//
	// Reserve EVERY fixed position first, including the ones this request leaves undefined, because the
	// pinned literal declares all of them and `...bodyParams` keeps an existing key's position. Without the
	// reservation an included `top_k` is appended after `n` instead of sitting between top_p and n.
	// marshalOrderedNodeJSON emits every entry it is GIVEN -- it does not drop undefined the way
	// JSON.stringify does -- so the placeholders that remain undefined are removed before marshalling.
	requestBody := nodeObject()
	for _, key := range pinnedChatCompletionRequestBodyMemberOrder {
		requestBody.setMember(key, nodeUndefined())
	}
	if request.isTextCompletion {
		prompt, ok := pinnedChatCompletionTextPrompt(body)
		if !ok {
			return nil, pinnedChatCompletionTransportFailure(errors.New("Cannot read properties of undefined (reading 'forEach')"))
		}
		requestBody.setMember("prompt", nodeString(prompt))
	} else if messages, exists := body.member("messages"); exists {
		requestBody.setMember("messages", messages)
	}
	for _, key := range []string{
		"model", "temperature", "max_tokens", "max_completion_tokens", "stream",
		"presence_penalty", "frequency_penalty", "top_p", "top_k", "stop",
		"logit_bias", "seed", "n",
	} {
		if key == "stop" && request.isTextCompletion {
			continue
		}
		if value, exists := body.member(key); exists {
			requestBody.setMember(key, value)
		}
	}
	for _, entry := range bodyParams.object {
		requestBody.setMember(entry.key, entry.value)
	}
	if sourceName == chatCompletionSourceCustom {
		if exclude, exists := body.member("custom_exclude_body"); exists {
			pinnedExcludeKeysByYAML(&requestBody, exclude)
		}
	}
	// Drop the reserved positions this request left undefined. This is the step JSON.stringify does for free
	// on the pinned side, and it must run AFTER the exclusion so an excluded member is gone for both reasons.
	for _, key := range pinnedChatCompletionRequestBodyMemberOrder {
		if value, exists := requestBody.member(key); exists && value.isUndefined() {
			requestBody.deleteMember(key)
		}
	}
	encoded, encodeErr := marshalOrderedNodeJSON(requestBody)
	if encodeErr != nil {
		return nil, pinnedChatCompletionTransportFailure(encodeErr)
	}

	endpointURL := inputs.apiURL + "/chat/completions"
	if request.isTextCompletion && sourceName != chatCompletionSourceOpenRtr {
		endpointURL = inputs.apiURL + "/completions"
	}
	parsedEndpoint, parseErr := url.Parse(endpointURL)
	if parseErr != nil || parsedEndpoint.Host == "" || (parsedEndpoint.Scheme != "http" && parsedEndpoint.Scheme != "https") {
		// node-fetch rejects a non-absolute URL before any connection is made.
		return nil, pinnedChatCompletionTransportFailure(errors.New("Only absolute URLs are supported"))
	}

	return &outbound.Request{
		URL:     endpointURL,
		Method:  http.MethodPost,
		Headers: pinnedChatCompletionRequestFraming(pinnedChatCompletionHeaders(inputs.apiKey, inputs.customHeaders, encoded), parsedEndpoint),
		Body:    encoded,
	}, nil
}

// pinnedChatCompletionRequestFraming turns the header set node-fetch would have sent into the outbound header
// list. Two ordered steps, and the fixture records the result:
//
//  1. the headers node-fetch supplied, in NAME ORDER, because node-fetch's Headers is backed by a sorted
//     URLSearchParams;
//  2. Host and Connection, which Node's http client appends AFTER those, in that order.
//
// This is the ONE framing implementation: it replaced thirteen hand-rolled copies (this file plus ai21,
// aimlapi, azure, chutes, claude, cohere, deepseek, electronhub, google, minimax, mistral and xai), each of
// which collected the map keys, called sort.Strings and then appended the same two headers. The replacement
// is byte-identical by construction -- same keys, same order, same two trailing headers -- which is why the
// recorded header list for every scenario is unchanged.
func pinnedChatCompletionRequestFraming(headers map[string]string, endpoint *url.URL) []outbound.Header {
	names := make([]string, 0, len(headers))
	for name := range headers {
		names = append(names, name)
	}
	slices.Sort(names)
	framed := make([]outbound.Header, 0, len(names)+2)
	for _, name := range names {
		framed = append(framed, outbound.Header{Name: name, Value: headers[name]})
	}
	framed = append(framed, outbound.Header{Name: "Host", Value: pinnedRequestHostHeader(endpoint)})
	framed = append(framed, outbound.Header{Name: "Connection", Value: "close"})
	return framed
}

// pinnedChatCompletionHeaders reproduces the header set node-fetch actually
// sends: the config headers it was given (Content-Type and Authorization, then
// anything merged from custom_include_headers), its own defaults for a request
// that has not overridden them, a computed Content-Length, and iteration in
// name order because node-fetch's Headers is backed by a sorted URLSearchParams.
func pinnedChatCompletionHeaders(apiKey orderedNodeJSON, customHeaders orderedNodeJSON, encodedBody []byte) map[string]string {
	headers := map[string]string{
		"content-type":    "application/json",
		"accept":          "*/*",
		"accept-encoding": "gzip, deflate, br",
		"user-agent":      "node-fetch",
	}
	// `'Bearer ' + apiKey` is always present, and a non-string key is stringified
	// the way JavaScript would: an absent proxy_password becomes "Bearer undefined".
	keyText, keyErr := pinnedJSStringValue(apiKey)
	if keyErr != nil {
		keyText = "undefined"
	}
	headers["authorization"] = "Bearer " + keyText
	for _, entry := range customHeaders.object {
		value, valueErr := pinnedJSStringValue(entry.value)
		if valueErr != nil {
			continue
		}
		headers[strings.ToLower(entry.key)] = value
	}
	headers["content-length"] = strconv.Itoa(len(encodedBody))
	return headers
}

// pinnedRequestHostHeader is the Host header Node's http client derives from the
// request URL: the hostname, with the port unless it is the scheme default.
func pinnedRequestHostHeader(endpoint *url.URL) string {
	hostname := strings.ToLower(endpoint.Hostname())
	if strings.Contains(hostname, ":") {
		hostname = "[" + hostname + "]"
	}
	port := endpoint.Port()
	if (endpoint.Scheme == "http" && port == "80") || (endpoint.Scheme == "https" && port == "443") {
		port = ""
	}
	if port == "" {
		return hostname
	}
	return net.JoinHostPort(endpoint.Hostname(), port)
}

// servePinnedChatCompletionDefaultResponse is the SHARED response tail
// (chat-completions.js:2689-2710) that every source without its own mapping uses: a streamed reply is
// forwarded as it arrives, a 2xx answer is parsed and re-sent at 200, and a provider error status is
// replaced by the pinned error shape at status 200 -- the provider's own text is not forwarded, only its
// reason phrase.
func servePinnedChatCompletionDefaultResponse(w http.ResponseWriter, request *http.Request, response *outbound.Response, body orderedNodeJSON) {
	if pinnedChatCompletionStreams(body) {
		forwardPinnedChatCompletionStream(w, request, response)
		return
	}
	defer response.Stream.Close()
	providerBody, readErr := io.ReadAll(response.Stream)
	if readErr != nil && !errors.Is(readErr, io.EOF) {
		failure := pinnedChatCompletionTransportFailure(readErr)
		respondOrderedNodeJSON(w, failure.status, *failure.payload)
		return
	}

	if response.Status >= 200 && response.Status < 300 {
		parsed, parseErr := decodeOrderedNodeJSON(providerBody)
		if parseErr != nil {
			// fetchResponse.json() rejects on a body that is not JSON, so the
			// pinned catch answers 502 instead of forwarding the bytes.
			failure := pinnedChatCompletionTransportFailure(parseErr)
			respondOrderedNodeJSON(w, failure.status, *failure.payload)
			return
		}
		respondOrderedNodeJSON(w, http.StatusOK, parsed)
		return
	}

	message := response.Reason
	if message == "" {
		message = "Unknown error occurred"
	}
	payload := nodeObject()
	errorMember := nodeObject()
	errorMember.setMember("message", nodeString(message))
	payload.setMember("error", errorMember)
	payload.setMember("quota_error", nodeBool(response.Status == http.StatusTooManyRequests && pinnedChatCompletionQuotaError(providerBody)))
	respondOrderedNodeJSON(w, http.StatusOK, payload)
}

// servePinnedChatCompletionPassThroughResponse is the response side that EIGHT sources share: ai21, aimlapi,
// chutes, cohere, deepseek, electronhub, mistralai and xai. Their pinned branches were byte-identical apart
// from one comment, which is why they are one function here rather than eight copies that a future edit
// could silently desynchronise.
//
// The shape, and the three places it differs from the shared tail above:
//
//   - a streamed reply is forwarded as it arrives;
//   - a non-2xx answer re-sends the PARSED provider body at status 500, not the shared 200 envelope, and a
//     body that does not parse becomes the bare {error:true} flag at 500 (`tryParse(errorText) ?? {error:true}`);
//   - a read or parse failure answers 200 {error:true}, because these branches' own catch is
//     `response.send({error:true})` with NO status rather than the shared 502.
func servePinnedChatCompletionPassThroughResponse(w http.ResponseWriter, request *http.Request, response *outbound.Response, body orderedNodeJSON) {
	if pinnedChatCompletionStreams(body) {
		forwardPinnedChatCompletionStream(w, request, response)
		return
	}
	defer response.Stream.Close()
	providerBody, readErr := io.ReadAll(response.Stream)
	if readErr != nil && !errors.Is(readErr, io.EOF) {
		// `generateResponse.json()` throws into the catch, which answers 200 {"error":true}.
		respondOrderedNodeJSON(w, http.StatusOK, pinnedChatCompletionErrorFlag())
		return
	}
	if response.Status < 200 || response.Status > 299 {
		// `tryParse(errorText) ?? { error: true }` -- a non-JSON error body becomes the bare flag, at 500.
		parsed, parseErr := decodeOrderedNodeJSON(providerBody)
		if parseErr != nil {
			respondOrderedNodeJSON(w, http.StatusInternalServerError, pinnedChatCompletionErrorFlag())
			return
		}
		respondOrderedNodeJSON(w, http.StatusInternalServerError, parsed)
		return
	}
	parsed, parseErr := decodeOrderedNodeJSON(providerBody)
	if parseErr != nil {
		respondOrderedNodeJSON(w, http.StatusOK, pinnedChatCompletionErrorFlag())
		return
	}
	respondOrderedNodeJSON(w, http.StatusOK, parsed)
}

func pinnedSecretID(body orderedNodeJSON) orderedNodeJSON {
	if id, exists := body.member("secret_id"); exists {
		return id
	}
	return nodeUndefined()
}

// pinnedChatCompletionSourceName is `String(request.body.chat_completion_source)`. It is resolved once
// per request and reused by the plan and by the response side, so the two cannot disagree about which
// source is being served.
func pinnedChatCompletionSourceName(body orderedNodeJSON) string {
	source, exists := body.member("chat_completion_source")
	if !exists {
		return ""
	}
	text, _ := source.stringValue()
	return text
}

// pinnedChatCompletionIsTextCompletion implements chat-completions.js:2279.
func pinnedChatCompletionIsTextCompletion(body orderedNodeJSON) bool {
	if model, exists := body.member("model"); exists && pinnedJSTruthy(model) {
		if name, isString := model.stringValue(); isString && pinnedTextCompletionModels[name] {
			return true
		}
	}
	if messages, exists := body.member("messages"); exists {
		if _, isString := messages.stringValue(); isString {
			return true
		}
	}
	return false
}

// pinnedChatCompletionApplyLogprobs implements the OpenAI-compatible
// {logprobs, top_logprobs} adjustment (chat-completions.js:2285-2294 and
// :2398-2407).
func pinnedChatCompletionApplyLogprobs(bodyParams *orderedNodeJSON, body orderedNodeJSON, isTextCompletion bool) {
	logprobs, exists := body.member("logprobs")
	if !exists {
		return
	}
	bodyParams.setMember("logprobs", logprobs)
	if !isTextCompletion && pinnedJSGreaterThanZero(logprobs) {
		bodyParams.setMember("top_logprobs", logprobs)
		bodyParams.setMember("logprobs", nodeBool(true))
	}
}

// pinnedChatCompletionResponseFormat builds the pinned response_format object.
// `strict: request.body.json_schema.strict ?? true` is nullish, so an explicit
// false survives while null and undefined do not.
func pinnedChatCompletionResponseFormat(jsonSchema orderedNodeJSON) orderedNodeJSON {
	format := nodeObject()
	format.setMember("type", nodeString("json_schema"))
	inner := nodeObject()
	if name, exists := jsonSchema.member("name"); exists {
		inner.setMember("name", name)
	}
	strict := nodeBool(true)
	if value, exists := jsonSchema.member("strict"); exists && !value.isUndefined() && !value.isNull() {
		strict = value
	}
	inner.setMember("strict", strict)
	if value, exists := jsonSchema.member("value"); exists {
		inner.setMember("schema", pinnedFlattenSchema(value))
	}
	format.setMember("json_schema", inner)
	return format
}

// pinnedChatCompletionTextPrompt implements convertTextCompletionPrompt
// (src/prompt-converters.js:961) for the text-completion models.
func pinnedChatCompletionTextPrompt(body orderedNodeJSON) (string, bool) {
	messages, exists := body.member("messages")
	if !exists || messages.isUndefined() {
		return "", false
	}
	if text, isString := messages.stringValue(); isString {
		return text, true
	}
	if messages.kind != 'a' {
		return "", false
	}
	parts := make([]string, 0, len(messages.array))
	for _, message := range messages.array {
		role, roleErr := pinnedJSStringValue(nodeGet(message, "role"))
		if roleErr != nil {
			return "", false
		}
		content, contentErr := pinnedJSStringValue(nodeGet(message, "content"))
		if contentErr != nil {
			return "", false
		}
		// `m.name === undefined` is a strict check, so an explicit null takes
		// the named-system branch.
		name, hasName := message.member("name")
		switch {
		case role == "system" && !hasName:
			parts = append(parts, "System: "+content)
		case role == "system":
			nameText, nameErr := pinnedJSStringValue(name)
			if nameErr != nil {
				return "", false
			}
			parts = append(parts, nameText+": "+content)
		default:
			parts = append(parts, role+": "+content)
		}
	}
	return strings.Join(parts, "\n") + "\nassistant:", true
}

// pinnedJSStringValue is JavaScript's ToString for a decoded JSON member,
// including the `undefined` a missing member produces.
func pinnedJSStringValue(value orderedNodeJSON) (string, error) {
	if value.isUndefined() {
		return "undefined", nil
	}
	return value.javascriptString()
}
