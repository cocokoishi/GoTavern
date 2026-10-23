package server

// Pinned MINIMAX chat-completion source: chat-completions.js:1603-1680 (sendMinimaxRequest),
// dispatched at :2270.
//
// WHY THIS SOURCE IS ITS OWN TRANSPORT rather than a case in pinnedChatCompletionPlan. Five of its
// properties are not expressible there, and each one is observable:
//
//   - the endpoint is a PAIR chosen by `minimax_endpoint === MINIMAX_ENDPOINT.CN` ('cn', a strict
//     comparison, not a truthiness test): API_MINIMAX_CN ('https://api.minimaxi.com/v1') or
//     API_MINIMAX ('https://api.minimax.io/v1'). There is no reverse_proxy and no custom_url;
//   - the `messages` array is FOLDED server-side before it is sent:
//     postProcessPrompt(request.body.messages, MERGE_TOOLS, getPromptNames(request)). This is the
//     only chat source whose prompt the backend rewrites, and the pinned comment names the reason:
//     MiniMax rejects consecutive same-role messages with "invalid chat setting (2013)";
//   - `max_tokens` is clamped with `Math.min(request.body.max_tokens, 2048)` for the `M2-her` model;
//   - the outgoing body is a FIXED member list in a fixed order (messages, model, temperature,
//     max_tokens, stream, top_p, stop, then tools/tool_choice), so nothing else the frontend sends
//     reaches the provider;
//   - a non-2xx answer is 500 with the PARSED provider body (`tryParse(errorText) ?? {error:true}`),
//     not the shared 200 {error:{message}} shape, and a streamed reply is forwarded with no `ok`
//     check at all (forwardFetchResponse does the 401 -> 400 rewrite).
//
// The abort controller is bound to the socket close but sends NO abort request; the Go side gets
// that for free because the shared outbound client watches the request context.
//
// Evidence: tests/provider-wire/scenarios/minimax-*.json, replayed by
// internal/server/chat_completions_oracle_test.go; the two zero-outbound branches (no key, and the
// status fall-through) are in tests/oracle/sillytavern-1.19.0-backends.json, because the
// provider-wire replay refuses a capture with no provider request.

import (
	"errors"
	"io"
	"math"
	"net/http"
	"net/url"
	"sort"

	"github.com/cocokoishi/gotavern/internal/outbound"
	"github.com/cocokoishi/gotavern/internal/startup"
)

const (
	chatCompletionSourceMinimax = "minimax"

	// API_MINIMAX / API_MINIMAX_CN (chat-completions.js:98-99).
	minimaxChatGlobalAPIURL = "https://api.minimax.io/v1"
	minimaxChatCNAPIURL     = "https://api.minimaxi.com/v1"
	// The two hosts are different, so one seam per literal: asserting a single seam against two
	// literals would let the CN branch silently reuse the global host.
	minimaxChatSeamEnv   = "GOTAVERN_MINIMAX_CHAT_URL"
	minimaxChatCNSeamEnv = "GOTAVERN_MINIMAX_CHAT_CN_URL"

	// SECRET_KEYS.MINIMAX.
	minimaxChatSecretKey = "api_key_minimax"
	// MINIMAX_ENDPOINT.CN, compared with === as the pinned branch does.
	minimaxChatEndpointCN = "cn"
	// `request.body.model === 'M2-her' ? Math.min(max_tokens, 2048) : max_tokens`.
	minimaxChatHerModel     = "M2-her"
	minimaxChatHerMaxTokens = 2048
)

func minimaxChatGlobalBaseURL() string {
	return sdSeamURL(minimaxChatSeamEnv, minimaxChatGlobalAPIURL)
}

func minimaxChatCNBaseURL() string {
	return sdSeamURL(minimaxChatCNSeamEnv, minimaxChatCNAPIURL)
}

// minimaxChatBaseURL is the pinned endpoint switch. `=== MINIMAX_ENDPOINT.CN` is a strict string
// comparison, so `minimax_endpoint: 'CN'` or a truthy non-string takes the global host.
func minimaxChatBaseURL(body orderedNodeJSON) string {
	if pinnedJSStrictEqual(sdBodyMember(body, "minimax_endpoint"), nodeString(minimaxChatEndpointCN)) {
		return minimaxChatCNBaseURL()
	}
	return minimaxChatGlobalBaseURL()
}

// minimaxNodeNull is the JSON `null` a NaN becomes: `Math.min(undefined, 2048)` is NaN and
// JSON.stringify writes NaN as null, so an `M2-her` request with no max_tokens sends
// "max_tokens": null rather than omitting it.
func minimaxNodeNull() orderedNodeJSON {
	return orderedNodeJSON{kind: 'n'}
}

// pinnedMinimaxChatBody builds the pinned request body, member order included.
func pinnedMinimaxChatBody(body orderedNodeJSON) (orderedNodeJSON, error) {
	messages, mergeErr := backendsPostProcessPrompt(
		sdBodyMember(body, "messages"),
		"merge_tools",
		backendsPromptNamesFor(body),
	)
	if mergeErr != nil {
		return orderedNodeJSON{}, mergeErr
	}
	requestBody := nodeObject()
	requestBody.setMember("messages", messages)
	for _, key := range []string{"model", "temperature"} {
		if value, exists := body.member(key); exists && !value.isUndefined() {
			requestBody.setMember(key, value)
		}
	}
	modelIsHer := pinnedJSStrictEqual(sdBodyMember(body, "model"), nodeString(minimaxChatHerModel))
	maxTokens, hasMaxTokens := body.member("max_tokens")
	switch {
	case modelIsHer && !hasMaxTokens:
		// Math.min(undefined, 2048) -> NaN -> null.
		requestBody.setMember("max_tokens", minimaxNodeNull())
	case modelIsHer:
		clamped := math.Min(pinnedJSToNumber(maxTokens), minimaxChatHerMaxTokens)
		if math.IsNaN(clamped) {
			requestBody.setMember("max_tokens", minimaxNodeNull())
		} else {
			requestBody.setMember("max_tokens", nodeNumber(clamped))
		}
	case hasMaxTokens && !maxTokens.isUndefined():
		requestBody.setMember("max_tokens", maxTokens)
	}
	for _, key := range []string{"stream", "top_p", "stop"} {
		if value, exists := body.member(key); exists && !value.isUndefined() {
			requestBody.setMember(key, value)
		}
	}
	// `if (Array.isArray(tools) && tools.length > 0)` -- an EMPTY tools array sends neither member,
	// and `tool_choice` rides along with it (an absent tool_choice is omitted by JSON.stringify).
	if tools := sdBodyMember(body, "tools"); tools.kind == 'a' && len(tools.array) > 0 {
		requestBody.setMember("tools", tools)
		if choice, exists := body.member("tool_choice"); exists && !choice.isUndefined() {
			requestBody.setMember("tool_choice", choice)
		}
	}
	return requestBody, nil
}

// pinnedMinimaxChatPlan assembles the pinned node-fetch request: the fixed body above, the two
// config headers (Content-Type and Authorization), node-fetch's own defaults, the computed
// Content-Length, and Host/Connection appended by Node's client in that order.
func pinnedMinimaxChatPlan(body orderedNodeJSON, directories startup.UserDirectories) (*outbound.Request, *pinnedChatCompletionFailure) {
	keyNode, secretErr := pinnedReadSecret(directories, minimaxChatSecretKey, pinnedSecretID(body))
	if secretErr != nil {
		// readSecret only throws when the secrets file is unreadable; the pinned catch answers
		// 200 {error:true}.
		return nil, pinnedChatCompletionJSONFailure(http.StatusOK, pinnedChatCompletionErrorFlag())
	}
	if !pinnedJSTruthy(keyNode) {
		// :1612-1615 `if (!apiKey) return response.status(400).send({ error: true });` -- outside
		// the try, so no merge and no request happen.
		return nil, pinnedChatCompletionJSONFailure(http.StatusBadRequest, pinnedChatCompletionErrorFlag())
	}
	requestBody, bodyErr := pinnedMinimaxChatBody(body)
	if bodyErr != nil {
		// postProcessPrompt throws on a non-array messages member; the pinned catch answers
		// 200 {error:true} because the headers have not been sent.
		return nil, pinnedChatCompletionJSONFailure(http.StatusOK, pinnedChatCompletionErrorFlag())
	}
	encoded, encodeErr := marshalOrderedNodeJSON(requestBody)
	if encodeErr != nil {
		return nil, pinnedChatCompletionJSONFailure(http.StatusOK, pinnedChatCompletionErrorFlag())
	}

	endpointURL := minimaxChatBaseURL(body) + "/chat/completions"
	parsedEndpoint, parseErr := url.Parse(endpointURL)
	if parseErr != nil || parsedEndpoint.Host == "" {
		return nil, pinnedChatCompletionJSONFailure(http.StatusOK, pinnedChatCompletionErrorFlag())
	}

	headers := pinnedChatCompletionHeaders(keyNode, nodeObject(), encoded)
	names := make([]string, 0, len(headers))
	for name := range headers {
		names = append(names, name)
	}
	sort.Strings(names)
	requestHeaders := make([]outbound.Header, 0, len(names)+2)
	for _, name := range names {
		requestHeaders = append(requestHeaders, outbound.Header{Name: name, Value: headers[name]})
	}
	requestHeaders = append(requestHeaders, outbound.Header{Name: "Host", Value: pinnedRequestHostHeader(parsedEndpoint)})
	requestHeaders = append(requestHeaders, outbound.Header{Name: "Connection", Value: "close"})

	return &outbound.Request{
		URL:     endpointURL,
		Method:  http.MethodPost,
		Headers: requestHeaders,
		Body:    encoded,
	}, nil
}

// serveMinimaxChatCompletion is :2270 -> sendMinimaxRequest.
func (runtime *accountRuntime) serveMinimaxChatCompletion(w http.ResponseWriter, request *http.Request, body orderedNodeJSON, directories startup.UserDirectories) {
	plan, failure := pinnedMinimaxChatPlan(body, directories)
	if failure != nil {
		respondOrderedNodeJSON(w, failure.status, *failure.payload)
		return
	}
	response, fetchErr := outbound.SendStreaming(request.Context(), *plan, 0)
	if fetchErr != nil {
		// :1673-1679: the catch answers 200 {error:true} while the headers have not been sent.
		respondOrderedNodeJSON(w, http.StatusOK, pinnedChatCompletionErrorFlag())
		return
	}
	if pinnedChatCompletionStreams(body) {
		// No `ok` check on this path: forwardFetchResponse forwards the upstream status (401 -> 400)
		// and body, and sets no content type.
		forwardPinnedChatCompletionStream(w, request, response)
		return
	}
	defer response.Stream.Close()
	providerBody, readErr := io.ReadAll(response.Stream)
	if readErr != nil && !errors.Is(readErr, io.EOF) {
		respondOrderedNodeJSON(w, http.StatusOK, pinnedChatCompletionErrorFlag())
		return
	}
	if response.Status < 200 || response.Status > 299 {
		// `const errorJson = tryParse(errorText) ?? { error: true }; return response.status(500).send(errorJson);`
		parsed, parseErr := decodeOrderedNodeJSON(providerBody)
		if parseErr != nil || parsed.isUndefined() || parsed.isNull() {
			respondOrderedNodeJSON(w, http.StatusInternalServerError, pinnedChatCompletionErrorFlag())
			return
		}
		respondMinimaxSendValue(w, http.StatusInternalServerError, parsed)
		return
	}
	parsed, parseErr := decodeOrderedNodeJSON(providerBody)
	if parseErr != nil {
		// `await generateResponse.json()` throws inside the try -> 200 {error:true}.
		respondOrderedNodeJSON(w, http.StatusOK, pinnedChatCompletionErrorFlag())
		return
	}
	serveSDValue(w, parsed)
}

// serveMinimaxChatCompletionStatus is the pinned FALL-THROUGH for this source: 400 {error:true}
// (:2062-2065) with no outbound request. Recorded as status.minimax.noBranch and
// status.minimax.reverseProxy in the backends fixture, because a zero-request capture cannot live in
// the provider-wire fixture by design.
func (runtime *accountRuntime) serveMinimaxChatCompletionStatus(w http.ResponseWriter) {
	respondOrderedNodeJSON(w, http.StatusBadRequest, pinnedChatCompletionErrorFlag())
}

// respondMinimaxSendValue is `response.status(status).send(value)` for a value that came from the
// provider's own JSON. Express dispatches on the JavaScript type: a string is sent as text/html,
// null is an empty body, and an object, array, number or boolean is serialized as JSON (the number
// is a BODY here, not the deprecated `res.send(status)` form, because the status was set
// explicitly).
func respondMinimaxSendValue(w http.ResponseWriter, status int, value orderedNodeJSON) {
	switch value.kind {
	case 's':
		text, _ := value.stringValue()
		respondText(w, status, "text/html; charset=utf-8", text)
	case 'n':
		w.Header().Set("Content-Length", "0")
		w.Header().Set("ETag", expressWeakETag(nil))
		w.WriteHeader(status)
	default:
		respondOrderedNodeJSON(w, status, value)
	}
}
