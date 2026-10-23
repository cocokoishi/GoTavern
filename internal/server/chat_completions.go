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
//     why its Vary header carries only the CORS Origin entry: Express's
//     compression middleware never reaches its vary step without a Content-Type;
//   - a provider error status is answered at status 200 with the pinned
//     {error:{message}, quota_error} shape, not forwarded as a status.
//
// Implemented sources: openai (including reverse_proxy + proxy_password) and
// custom (custom_url, the CUSTOM secret, and the YAML include/exclude options).
// Every other source the pinned backend supports has a transport this route
// does not implement yet and is answered 501 rather than faked. A source the
// pinned backend itself does not support is answered 400 {"error":true}, which
// is what the pinned handler's final else branch sends.

import (
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"sort"
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
	// chat-completions.js:2302 is a LITERAL, and the source has no reverse_proxy member: an OpenRouter
	// request cannot be aimed anywhere except at that URL. This seam therefore exists so the recorded
	// differential can point the Go leg at the same recording peer the pinned leg is redirected to at the
	// transport layer, and its DEFAULT is asserted against the fixture's recorded literal
	// (TestChatCompletionOpenRouterSeamDefault), so the default cannot drift into whatever makes the replay
	// pass.
	pinnedOpenRouterAPIURL      = "https://openrouter.ai/api/v1"
	pinnedOpenRouterSeamEnv     = "GOTAVERN_OPENROUTER_CHAT_URL"
	pinnedOpenRouterSecretKey   = "api_key_openrouter"
	chatCompletionSourceOpenRtr = "openrouter"
)

// pinnedOpenRouterBaseURL is the pinned literal, replaceable only by the test seam.
func pinnedOpenRouterBaseURL() string {
	return sdSeamURL(pinnedOpenRouterSeamEnv, pinnedOpenRouterAPIURL)
}

// pinnedOpenRouterHeaders is OPENROUTER_HEADERS (src/constants.js:362). The pinned comment names the reason:
// "OpenRouter needs to pass the Referer and X-Title". Member order is preserved because the outbound header
// set is sent in name order regardless, but the fixture records these two as compared values.
func pinnedOpenRouterHeaders() orderedNodeJSON {
	headers := nodeObject()
	headers.setMember("HTTP-Referer", nodeString("https://sillytavern.app"))
	headers.setMember("X-Title", nodeString("SillyTavern"))
	return headers
}

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

func (runtime *accountRuntime) serveChatCompletionGenerate(w http.ResponseWriter, request *http.Request) {
	body, ok := readPinnedJSONBody(request)
	if !ok {
		// Express's JSON body parser answers its own 400 page for a malformed
		// body; GoTavern answers the same status with a plain-text body.
		serveStatusText(w, http.StatusBadRequest)
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

	plan, failure := pinnedChatCompletionPlan(body, directories, runtime.options.CookieSecret)
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
		if pinnedChatCompletionSourceName(body) == chatCompletionSourceClaude {
			// :441-446: the CLAUDE route's own catch answers 500 {"error":true} while the headers have
			// not been sent, NOT the generic 502 {"error":{message}}.
			respondOrderedNodeJSON(w, http.StatusInternalServerError, pinnedChatCompletionErrorFlag())
			return
		}
		if pinnedChatCompletionSourceName(body) == chatCompletionSourceAI21 {
			// :870-877: the catch calls `response.send({error:true})` with NO status, so a thrown fetch answers
			// 200 {"error":true} rather than the shared 502.
			respondOrderedNodeJSON(w, http.StatusOK, pinnedChatCompletionErrorFlag())
			return
		}
		if pinnedChatCompletionSourceName(body) == chatCompletionSourceMistral {
			// :956-962: the MISTRAL route's catch uses `response.send` with NO status, so a thrown
			// fetch answers 200 {"error":true}. Answering 500 here would be a different contract.
			respondOrderedNodeJSON(w, http.StatusOK, pinnedChatCompletionErrorFlag())
			return
		}
		if pinnedChatCompletionSourceName(body) == chatCompletionSourceDeepSeek {
			// :1168-1174: the same shape as MISTRAL and for the same reason: that catch calls
			// status, so a thrown fetch answers 200 {"error":true} rather than CLAUDE's 500.
			respondOrderedNodeJSON(w, http.StatusOK, pinnedChatCompletionErrorFlag())
			return
		}
		if pinnedChatCompletionSourceName(body) == chatCompletionSourceChutes {
			// :1592-1599: `response.send({error:true})` with no status, so a thrown fetch answers
			// 200 {"error":true}. See chutes_chat.go.
			respondOrderedNodeJSON(w, http.StatusOK, pinnedChatCompletionErrorFlag())
			return
		}
		failure := pinnedChatCompletionTransportFailure(err)
		respondOrderedNodeJSON(w, failure.status, *failure.payload)
		return
	}

	if pinnedChatCompletionSourceName(body) == chatCompletionSourceClaude {
		// :424-439: the shared forwarder for a stream, the pinned rewrap for a buffered answer.
		serveClaudeChatCompletionResponse(w, request, response, body)
		return
	}
	if pinnedChatCompletionSourceName(body) == chatCompletionSourceChutes {
		// :1579-1599: the shared forwarder for a stream, the provider body passed through otherwise,
		// and the PARSED provider body at 500 for a non-2xx answer. See chutes_chat.go.
		serveChutesChatCompletionResponse(w, request, response, body)
		return
	}
	if pinnedChatCompletionSourceName(body) == chatCompletionSourceMistral {
		// :943-954: the shared forwarder for a stream, the provider body passed through otherwise.
		serveMistralChatCompletionResponse(w, request, response, body)
		return
	}
	if pinnedChatCompletionSourceName(body) == chatCompletionSourceDeepSeek {
		// :1155-1167: the shared forwarder for a stream, the provider body passed through otherwise,
		// and the PARSED provider body at 500 for a non-2xx answer.
		serveDeepSeekChatCompletionResponse(w, request, response, body)
		return
	}
	if pinnedChatCompletionSourceName(body) == chatCompletionSourceCohere {
		// :1041-1062: the shared forwarder for a stream, the provider body passed through otherwise, the
		// PARSED provider body at 500 for a non-2xx answer. See cohere_chat.go.
		serveCohereChatCompletionResponse(w, request, response, body)
		return
	}

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

	// chat-completions.js:2701-2710: the provider's error status is replaced by
	// the pinned error shape at status 200. The provider's own text is not
	// forwarded, only its reason phrase.
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

// pinnedChatCompletionPlan resolves the pinned target selection and request
// body for the sources this route implements.
func pinnedChatCompletionPlan(body orderedNodeJSON, directories startup.UserDirectories, affinityKey string) (*outbound.Request, *pinnedChatCompletionFailure) {
	sourceName := pinnedChatCompletionSourceName(body)
	if sourceName == chatCompletionSourceAI21 {
		// chat-completions.js:800-881 is an OWN transform: its own converter, member order, header set and
		// error mapping. See ai21_chat.go.
		return pinnedAI21Plan(body, directories)
	}
	if sourceName == chatCompletionSourceMistral {
		// chat-completions.js:881 is its own transform, a sibling of the CLAUDE branch: its own body
		// order, its own seed/stop coercions, its own message converter and three error observables of
		// its own. See mistral_chat.go.
		return pinnedMistralPlan(body, directories)
	}
	if sourceName == chatCompletionSourceCohere {
		// chat-completions.js:971 is its own transform: its own body, its own two-value header set, its own
		// converter and its own three error observables. See cohere_chat.go.
		return pinnedCoherePlan(body, directories)
	}
	if sourceName == chatCompletionSourceDeepSeek {
		// chat-completions.js:1071 is its own transform, with the message side riding the SHARED
		// SEMI_TOOLS merge, addAssistantPrefix and addReasoningContentToToolCalls helpers. See
		// deepseek_chat.go.
		return pinnedDeepSeekPlan(body, directories)
	}
	if sourceName == chatCompletionSourceChutes {
		// chat-completions.js:1506 is its own transform with NO prompt post-processing at all: messages
		// are forwarded verbatim and only the folded members are built. See chutes_chat.go.
		return pinnedChutesPlan(body, directories)
	}
	if sourceName == chatCompletionSourceClaude {
		// chat-completions.js:230 is NOT on the generic path: it builds its own body, URL and header
		// set, and has its own response mapping, so it delegates here and the response side branches
		// on the same source name. See claude_chat.go.
		return pinnedClaudePlan(body, directories)
	}
	if sourceName == chatCompletionSourceAimlapi {
		// chat-completions.js:1289 is its own transform: its own body literal and fold order, its own
		// header set (AIMLAPI_HEADERS), its own response mapping and NO reverse_proxy branch. See
		// aimlapi_chat.go.
		return pinnedAimlapiPlan(body, directories)
	}
	isTextCompletion := pinnedChatCompletionIsTextCompletion(body)

	var apiURL string
	var apiKey orderedNodeJSON = nodeUndefined()
	reverseProxyUsed := false
	customHeaders := nodeObject()
	bodyParams := nodeObject()

	switch sourceName {
	case chatCompletionSourceOpenAI:
		reverseProxy, hasReverseProxy := body.member("reverse_proxy")
		if hasReverseProxy && pinnedJSTruthy(reverseProxy) {
			reverseProxyUsed = true
			normalized, ok := pinnedJSURLString(reverseProxy)
			if !ok {
				// `new URL(value)` throws for anything that is not a valid
				// absolute URL, and the pinned catch answers 502.
				return nil, pinnedChatCompletionTransportFailure(errors.New("Invalid URL"))
			}
			apiURL = normalized
			if password, exists := body.member("proxy_password"); exists {
				apiKey = password
			}
		} else {
			apiURL = pinnedOpenAIBaseURL()
			secret, err := pinnedReadSecret(directories, "api_key_openai", pinnedSecretID(body))
			if err != nil {
				return nil, pinnedChatCompletionTransportFailure(err)
			}
			apiKey = secret
		}
		pinnedChatCompletionApplyLogprobs(&bodyParams, body, isTextCompletion)
	case chatCompletionSourceCustom:
		customURL, exists := body.member("custom_url")
		if !exists {
			// `${undefined}/chat/completions` is not an absolute URL, so the
			// pinned fetch throws and the catch answers 502.
			return nil, pinnedChatCompletionTransportFailure(errors.New("Only absolute URLs are supported"))
		}
		text, stringErr := pinnedJSStringValue(customURL)
		if stringErr != nil {
			return nil, pinnedChatCompletionTransportFailure(stringErr)
		}
		apiURL = text
		secret, secretErr := pinnedReadSecret(directories, "api_key_custom", pinnedSecretID(body))
		if secretErr != nil {
			return nil, pinnedChatCompletionTransportFailure(secretErr)
		}
		apiKey = secret
		pinnedChatCompletionApplyLogprobs(&bodyParams, body, isTextCompletion)
		if includeBody, includeExists := body.member("custom_include_body"); includeExists {
			pinnedMergeObjectWithYAML(&bodyParams, includeBody)
		}
		if includeHeaders, headersExist := body.member("custom_include_headers"); headersExist {
			pinnedMergeObjectWithYAML(&customHeaders, includeHeaders)
		}
		if schema, schemaExists := body.member("json_schema"); schemaExists && pinnedJSTruthy(schema) {
			bodyParams.setMember("response_format", pinnedChatCompletionResponseFormat(schema))
		}
	case chatCompletionSourceZai:
		// chat-completions.js:2551. The ENDPOINT is a request body field with two literals that differ
		// only in PATH, the key comes from proxy_password when a reverse proxy is set and from
		// api_key_zai otherwise, the branch owns one header, and it always sends `thinking`.
		reverseProxy, hasReverseProxy := body.member("reverse_proxy")
		if hasReverseProxy && pinnedJSTruthy(reverseProxy) {
			reverseProxyUsed = true
			normalized, ok := pinnedJSURLString(reverseProxy)
			if !ok {
				// `new URL(value)` throws for anything that is not an absolute URL, and the pinned
				// catch answers 502 -- the same shape the OPENAI case reproduces.
				return nil, pinnedChatCompletionTransportFailure(errors.New("Invalid URL"))
			}
			apiURL = normalized
			if password, exists := body.member("proxy_password"); exists {
				apiKey = password
			}
		} else {
			apiURL = pinnedZAIBaseURL(body)
			secret, err := pinnedReadSecret(directories, pinnedZAISecretKey, pinnedSecretID(body))
			if err != nil {
				return nil, pinnedChatCompletionTransportFailure(err)
			}
			apiKey = secret
		}
		customHeaders.setMember("Accept-Language", nodeString(pinnedZAIHeaderLanguage))
		bodyParams.setMember("thinking", pinnedZAIThinking(body))
		if schema, exists := body.member("json_schema"); exists && pinnedJSTruthy(schema) {
			if foldErr := pinnedSetJsonObjectFormat(&bodyParams, &body, schema); foldErr != nil {
				return nil, pinnedChatCompletionTransportFailure(foldErr)
			}
		}
	case chatCompletionSourceSiliconF:
		// chat-completions.js:2566. The endpoint comes from the REQUEST BODY, and its one fold is
		// setJsonObjectFormat, which is not a response_format shape but a response_format PLUS an appended
		// message. The fold returns an error only when the schema cannot be pretty-printed, which pinned
		// cannot reach because JSON.stringify of a parsed body always succeeds.
		apiURL = pinnedSiliconFlowBaseURL(body)
		secret, err := pinnedReadSecret(directories, pinnedSiliconFlowSecretKey, pinnedSecretID(body))
		if err != nil {
			return nil, pinnedChatCompletionTransportFailure(err)
		}
		apiKey = secret
		if schema, exists := body.member("json_schema"); exists && pinnedJSTruthy(schema) {
			if foldErr := pinnedSetJsonObjectFormat(&bodyParams, &body, schema); foldErr != nil {
				return nil, pinnedChatCompletionTransportFailure(foldErr)
			}
		}
	case chatCompletionSourceNG:
		// chat-completions.js:2476. Four foldings, and the model mutation is the one a reader would assume
		// works: `:online` is appended only when enable_web_search is truthy AND the model does not already
		// end in it, so the already-suffixed scenario is the control that fails an unconditional append.
		apiURL = pinnedNanoGPTBaseURL()
		secret, err := pinnedReadSecret(directories, pinnedNanoGPTSecretKey, pinnedSecretID(body))
		if err != nil {
			return nil, pinnedChatCompletionTransportFailure(err)
		}
		apiKey = secret
		if provider, exists := body.member("nanogpt_provider"); exists && pinnedJSTruthy(provider) {
			customHeaders.setMember("X-Provider", provider)
		}
		if payg, exists := body.member("nanogpt_payg_override"); exists && pinnedJSTruthy(payg) {
			customHeaders.setMember("X-Billing-Mode", nodeString("paygo"))
			bodyParams.setMember("billing_mode", nodeString("paygo"))
		}
		if model, changed := pinnedNanoGPTModel(body); changed {
			body.setMember("model", nodeString(model))
		}
		for _, key := range []string{"min_p", "top_a", "repetition_penalty"} {
			if value, exists := body.member(key); exists && !value.isUndefined() {
				bodyParams.setMember(key, value)
			}
		}
		// chat-completions.js: `/auto/` is not in NANOGPT_REASONING_EFFORT_MAP, so the pinned lookup
		// yields `undefined` -- and `bodyParams['reasoning'] = { effort: undefined }` still assigns the
		// MEMBER. JSON.stringify then drops the undefined value and keeps the object, so a truthy but
		// UNMAPPED effort emits `"reasoning": {}`: an empty object, not an absent member. Measured end
		// to end: with reasoning_effort "auto" the pinned provider body was exactly 15 bytes longer
		// than GoTavern's, and `,"reasoning":{}` is exactly 15 bytes. Omitting the member when the map
		// misses is therefore a wire divergence, so the object is assigned whenever the effort is
		// truthy and only its `effort` member depends on the map.
		if effort, exists := body.member("reasoning_effort"); exists && pinnedJSTruthy(effort) {
			reasoning := nodeObject()
			if text, ok := effort.scalar.(string); ok {
				if mapped, known := pinnedNanoGPTReasoningEffortMap[text]; known {
					reasoning.setMember("effort", nodeString(mapped))
				}
			}
			bodyParams.setMember("reasoning", reasoning)
		}
	case chatCompletionSourceWAI:
		// chat-completions.js:2576. The base URL is derived from the request body, and the missing account id
		// refuses with 400 {error:true} BEFORE the fetch -- that refusal is a labelled derivation in the test
		// file because the harness has no provider traffic to record for it.
		accountID, hasAccountID := pinnedWorkersAIAccountID(body)
		if !hasAccountID {
			return nil, pinnedChatCompletionJSONFailure(http.StatusBadRequest, pinnedChatCompletionErrorFlag())
		}
		apiURL = pinnedWorkersAIBaseURL(accountID)
		secret, err := pinnedReadSecret(directories, pinnedWorkersAISecretKey, pinnedSecretID(body))
		if err != nil {
			return nil, pinnedChatCompletionTransportFailure(err)
		}
		apiKey = secret
		if penalty, exists := body.member("repetition_penalty"); exists && !penalty.isUndefined() {
			bodyParams.setMember("repetition_penalty", penalty)
		}
		if schema, exists := body.member("json_schema"); exists && pinnedJSTruthy(schema) {
			format := nodeObject()
			format.setMember("type", nodeString("json_schema"))
			if value, hasValue := schema.member("value"); hasValue {
				format.setMember("json_schema", value)
			} else {
				format.setMember("json_schema", nodeUndefined())
			}
			bodyParams.setMember("response_format", format)
		}
	case chatCompletionSourcePollinations:
		// chat-completions.js:2511. The endpoint mode moves BOTH the host and the credential: anonymous sends
		// the literal key `anonymous` and never reads the secret; authenticated reads api_key_pollinations.
		anonymous := pinnedPollinationsAnonymous(body)
		apiURL = pinnedPollinationsBaseURL(anonymous)
		if anonymous {
			apiKey = nodeString(pinnedPollinationsAnonymousKey)
		} else {
			secret, err := pinnedReadSecret(directories, pinnedPollinationsSecretKey, pinnedSecretID(body))
			if err != nil {
				return nil, pinnedChatCompletionTransportFailure(err)
			}
			apiKey = secret
		}
		// The seed is ALWAYS in the body: `seed: request.body.seed ?? Math.floor(Math.random()*99999999)`.
		seed, _ := pinnedPollinationsSeed(body)
		bodyParams.setMember("seed", seed)
		if !anonymous {
			if effort, exists := body.member("reasoning_effort"); exists {
				bodyParams.setMember("reasoning_effort", effort)
			}
			if schema, exists := body.member("json_schema"); exists && pinnedJSTruthy(schema) {
				format := nodeObject()
				format.setMember("type", nodeString("json_schema"))
				inner := nodeObject()
				if value, hasValue := schema.member("value"); hasValue {
					inner.setMember("schema", value)
				}
				format.setMember("json_schema", inner)
				bodyParams.setMember("response_format", format)
			}
		}
	case chatCompletionSourceFW:
		// chat-completions.js:2454. The affinity header is NOT built here: its key is the install's cookie
		// secret, so the plan takes it from the runtime's cookie secret at send time (see the note in
		// fireworks_chat.go) rather than from a constant this function could invent.
		apiURL = pinnedFireworksBaseURL()
		secret, err := pinnedReadSecret(directories, pinnedFireworksSecretKey, pinnedSecretID(body))
		if err != nil {
			return nil, pinnedChatCompletionTransportFailure(err)
		}
		apiKey = secret
		if effort, exists := body.member("reasoning_effort"); exists && pinnedJSTruthy(effort) {
			bodyParams.setMember("reasoning_effort", effort)
		}
		if schema, exists := body.member("json_schema"); exists && pinnedJSTruthy(schema) {
			format := nodeObject()
			format.setMember("type", nodeString("json_schema"))
			inner := nodeObject()
			if name, hasName := schema.member("name"); hasName {
				inner.setMember("name", name)
			}
			if description, hasDescription := schema.member("description"); hasDescription {
				inner.setMember("description", description)
			}
			if value, hasValue := schema.member("value"); hasValue {
				inner.setMember("schema", value)
			}
			strict := nodeBool(true)
			if value, hasStrict := schema.member("strict"); hasStrict && !value.isUndefined() && !value.isNull() {
				strict = value
			}
			inner.setMember("strict", strict)
			format.setMember("json_schema", inner)
			bodyParams.setMember("response_format", format)
		}
		if chatID, exists := body.member("chat_id"); exists && pinnedJSTruthy(chatID) {
			if text, err := pinnedJSStringValue(chatID); err == nil && text != "" {
				customHeaders.setMember("x-session-affinity", nodeString(pinnedFireworksAffinity(affinityKey, text)))
			}
		}
	case chatCompletionSourceGroq:
		// chat-completions.js:2454 is the SHARED path: a literal base, api_key_groq, no headers and no
		// body params of its own. Its one fold is a json_schema shape the shared response_format helper
		// cannot express (member order plus `description`), so pinnedGroqResponseFormat owns it.
		apiURL = pinnedGroqBaseURL()
		secret, err := pinnedReadSecret(directories, pinnedGroqSecretKey, pinnedSecretID(body))
		if err != nil {
			return nil, pinnedChatCompletionTransportFailure(err)
		}
		apiKey = secret
		if schema, exists := body.member("json_schema"); exists && pinnedJSTruthy(schema) {
			bodyParams.setMember("response_format", pinnedGroqResponseFormat(schema))
		}
	case chatCompletionSourceOpenRtr:
		// chat-completions.js:2301-2393. The source has NO reverse_proxy and NO custom_url: the URL is the
		// literal above, the key is the OPENROUTER secret, and the request is shaped by members that no other
		// source sends (transforms / plugins / reasoning / provider routing / verbosity).
		apiURL = pinnedOpenRouterBaseURL()
		secret, err := pinnedReadSecret(directories, pinnedOpenRouterSecretKey, pinnedSecretID(body))
		if err != nil {
			return nil, pinnedChatCompletionTransportFailure(err)
		}
		apiKey = secret
		customHeaders = pinnedOpenRouterHeaders()
		pinnedChatCompletionOpenRouterBodyParams(&bodyParams, body)
	default:
		if pinnedChatCompletionSources[sourceName] {
			// A pinned source whose transport this route does not implement.
			// Answering "not implemented" is deliberate: a fabricated success
			// would be worse than a visible gap.
			return nil, &pinnedChatCompletionFailure{status: http.StatusNotImplemented}
		}
		return nil, pinnedChatCompletionJSONFailure(http.StatusBadRequest, pinnedChatCompletionErrorFlag())
	}

	// chat-completions.js:2615 -- `!apiKey && !request.body.reverse_proxy && source !== CUSTOM`. The guard
	// reads the REQUEST MEMBER for every source, which matters for openrouter: that branch ignores
	// reverse_proxy when it builds the URL but still lets a request that carries one skip this refusal.
	reverseProxyTruthy := reverseProxyUsed
	if !reverseProxyTruthy {
		if reverseProxy, exists := body.member("reverse_proxy"); exists && pinnedJSTruthy(reverseProxy) {
			reverseProxyTruthy = true
		}
	}
	if !pinnedJSTruthy(apiKey) && !reverseProxyTruthy && sourceName != chatCompletionSourceCustom {
		return nil, pinnedChatCompletionJSONFailure(http.StatusBadRequest, pinnedChatCompletionErrorFlag())
	}

	// chat-completions.js:2620-2623. A non-empty stop array is copied into the
	// parameter object, so it also overwrites a stop supplied by
	// custom_include_body.
	if stop, exists := body.member("stop"); exists && stop.kind == 'a' && len(stop.array) > 0 {
		bodyParams.setMember("stop", stop)
	}
	// chat-completions.js:2636-2639.
	if !isTextCompletion {
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
	requestBody := nodeObject()
	if isTextCompletion {
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
		if key == "stop" && isTextCompletion {
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
	encoded, encodeErr := marshalOrderedNodeJSON(requestBody)
	if encodeErr != nil {
		return nil, pinnedChatCompletionTransportFailure(encodeErr)
	}

	endpointURL := apiURL + "/chat/completions"
	if isTextCompletion && sourceName != "openrouter" {
		endpointURL = apiURL + "/completions"
	}
	parsedEndpoint, parseErr := url.Parse(endpointURL)
	if parseErr != nil || parsedEndpoint.Host == "" || (parsedEndpoint.Scheme != "http" && parsedEndpoint.Scheme != "https") {
		// node-fetch rejects a non-absolute URL before any connection is made.
		return nil, pinnedChatCompletionTransportFailure(errors.New("Only absolute URLs are supported"))
	}

	headers := pinnedChatCompletionHeaders(apiKey, customHeaders, encoded)
	requestHeaders := make([]outbound.Header, 0, len(headers)+2)
	names := make([]string, 0, len(headers))
	for name := range headers {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		requestHeaders = append(requestHeaders, outbound.Header{Name: name, Value: headers[name]})
	}
	// Node's http client appends Host and Connection after the headers
	// node-fetch supplied, in that order; the capture records exactly that.
	requestHeaders = append(requestHeaders, outbound.Header{Name: "Host", Value: pinnedRequestHostHeader(parsedEndpoint)})
	requestHeaders = append(requestHeaders, outbound.Header{Name: "Connection", Value: "close"})

	return &outbound.Request{
		URL:     endpointURL,
		Method:  http.MethodPost,
		Headers: requestHeaders,
		Body:    encoded,
	}, nil
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

// pinnedChatCompletionOpenRouterBodyParams reproduces chat-completions.js:2306-2354, in SOURCE ORDER,
// because the outbound body's member order is part of the byte contract.
//
// THE SHAPING MEMBERS THIS SOURCE ALONE SENDS, each with the pinned semantics that a tidy rewrite would get
// wrong:
//
//   - `transforms` comes from a SWITCH on `request.body.middleout`: 'on' -> ['middle-out'], 'off' -> [],
//     'auto' -> undefined and EVERYTHING ELSE -> undefined. `undefined` is dropped by JSON.stringify, so the
//     member is ABSENT for 'auto' and absent when the caller sent nothing, while 'off' sends an EMPTY ARRAY.
//     Those three outcomes are different requests and the fixture records each.
//   - `plugins` is ALWAYS present (an empty array unless web search is enabled), so an OpenRouter body that
//     omits it is not the pinned body.
//   - `reasoning: { exclude: !Boolean(include_reasoning) }` is ALWAYS present, and `reasoning.effort` is
//     added to that SAME object when `reasoning_effort` is truthy -- so the member order is exclude then
//     effort inside a member that was created earlier in the body.
//   - `provider` is built only for a NON-EMPTY `provider` array, as { allow_fallbacks, order }, where
//     `allow_fallbacks ?? true` defaults to true for an absent OR null member but keeps a `false` one.
//     `quantizations` reuses that object with `??=`, so it either EXTENDS it (order: allow_fallbacks, order,
//     quantizations) or CREATES it as { quantizations } alone.
//   - `min_p`, `top_a` and `repetition_penalty` are tested with `!== undefined`, which in JSON means "the
//     member is PRESENT" -- a JSON null is present and is forwarded, and the fixture records that.
//   - `logprobs` is handled HERE rather than by the shared helper the openai source uses: only a value
//     GREATER THAN ZERO adds top_logprobs and flips logprobs to true; `logprobs: 0` adds NOTHING, which is
//     not what the shared helper would do.
func pinnedChatCompletionOpenRouterBodyParams(bodyParams *orderedNodeJSON, body orderedNodeJSON) {
	middleout := ""
	if member, exists := body.member("middleout"); exists {
		if text, isString := member.stringValue(); isString {
			middleout = text
		}
	}
	switch middleout {
	case "on":
		transforms := nodeArray()
		transforms.array = append(transforms.array, nodeString("middle-out"))
		bodyParams.setMember("transforms", transforms)
	case "off":
		bodyParams.setMember("transforms", nodeArray())
	}
	plugins := nodeArray()
	if enableWebSearch, exists := body.member("enable_web_search"); exists && pinnedJSTruthy(enableWebSearch) {
		plugin := nodeObject()
		plugin.setMember("id", nodeString("web"))
		plugins.array = append(plugins.array, plugin)
	}
	bodyParams.setMember("plugins", plugins)
	reasoning := nodeObject()
	includeReasoning := false
	if member, exists := body.member("include_reasoning"); exists && pinnedJSTruthy(member) {
		includeReasoning = true
	}
	reasoning.setMember("exclude", nodeBool(!includeReasoning))
	bodyParams.setMember("reasoning", reasoning)

	if logprobs, exists := body.member("logprobs"); exists && pinnedJSGreaterThanZero(logprobs) {
		bodyParams.setMember("top_logprobs", logprobs)
		bodyParams.setMember("logprobs", nodeBool(true))
	}
	for _, key := range []string{"min_p", "top_a", "repetition_penalty"} {
		if value, exists := body.member(key); exists {
			bodyParams.setMember(key, value)
		}
	}
	providerSet := false
	if provider, exists := body.member("provider"); exists && provider.kind == 'a' && len(provider.array) > 0 {
		allowFallbacks := orderedNodeJSON{kind: 'b', scalar: true}
		if value, allowExists := body.member("allow_fallbacks"); allowExists && value.kind != 'n' && !value.isUndefined() {
			allowFallbacks = value
		}
		order := nodeObject()
		order.setMember("allow_fallbacks", allowFallbacks)
		order.setMember("order", provider)
		bodyParams.setMember("provider", order)
		providerSet = true
	}
	if quantizations, exists := body.member("quantizations"); exists && quantizations.kind == 'a' && len(quantizations.array) > 0 {
		if !providerSet {
			bodyParams.setMember("provider", nodeObject())
		}
		// `bodyParams['provider']['quantizations'] = ...` mutates the object in place. This type is a VALUE, so
		// the member must be written back after mutating the copy: the differential caught exactly that here
		// (pinned sent provider.quantizations, GoTavern sent none).
		if existing, hasProvider := bodyParams.member("provider"); hasProvider {
			existing.setMember("quantizations", quantizations)
			bodyParams.setMember("provider", existing)
		}
	}
	if useFallback, exists := body.member("use_fallback"); exists && pinnedJSTruthy(useFallback) {
		bodyParams.setMember("route", nodeString("fallback"))
	}
	if effort, exists := body.member("reasoning_effort"); exists && pinnedJSTruthy(effort) {
		// `bodyParams['reasoning']['effort'] = ...` mutates the member created above. Value semantics again:
		// write the mutated copy back, and setMember keeps its original POSITION because the key already
		// exists (JS assignment semantics), which is what keeps exclude before effort.
		reasoning.setMember("effort", effort)
		bodyParams.setMember("reasoning", reasoning)
	}
	if verbosity, exists := body.member("verbosity"); exists && pinnedJSTruthy(verbosity) {
		bodyParams.setMember("verbosity", verbosity)
	}
	if schema, exists := body.member("json_schema"); exists && pinnedJSTruthy(schema) {
		bodyParams.setMember("response_format", pinnedChatCompletionResponseFormat(schema))
	}
	model := ""
	if member, exists := body.member("model"); exists {
		if text, isString := member.stringValue(); isString {
			model = text
		}
	}
	if pinnedOpenRouterGeminiModel.MatchString(model) {
		// GEMINI_SAFETY (src/constants.js:141), a static five-entry array. NOTE: the pinned branch ALSO
		// awaits `isOpenRouterModelCacheable(model)` for these models, which issues an extra `GET /models`.
		// That probe is deliberately NOT implemented in this increment (see the route comment), so a gemini
		// model through OpenRouter sends this body but ONE FEWER outbound request than pinned.
		bodyParams.setMember("safety_settings", pinnedGeminiSafety())
	}
}

// pinnedOpenRouterGeminiModel is `/google\/gemini/.test(model)` (chat-completions.js:2368), NOT anchored: a
// model id such as `foo/google/gemini-x` matches the pinned test just as much as `google/gemini-x`.
var pinnedOpenRouterGeminiModel = regexp.MustCompile(`google/gemini`)

func pinnedGeminiSafety() orderedNodeJSON {
	categories := []string{
		"HARM_CATEGORY_HARASSMENT", "HARM_CATEGORY_HATE_SPEECH", "HARM_CATEGORY_SEXUALLY_EXPLICIT",
		"HARM_CATEGORY_DANGEROUS_CONTENT", "HARM_CATEGORY_CIVIC_INTEGRITY",
	}
	array := nodeArray()
	for _, category := range categories {
		entry := nodeObject()
		entry.setMember("category", nodeString(category))
		entry.setMember("threshold", nodeString("OFF"))
		array.array = append(array.array, entry)
	}
	return array
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
