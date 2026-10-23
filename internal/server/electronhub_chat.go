package server

// Pinned ELECTRONHUB conversation source, from src/endpoints/backends/chat-completions.js:1394
// (sendElectronHubRequest), dispatched at :2271.
//
// AN OWN TRANSFORM, THE THINNEST OF THE FAMILY: unlike CLAUDE and DEEPSEEK it runs NO message helper
// at all -- `'messages': request.body.messages` (:1450) forwards the array VERBATIM, so there is no
// merge, no name prefixing, no tool-id rewriting and no reasoning_content injection to port. What it
// does add is its own member list, and two members no other route sends: `top_k` and `logit_bias`.
//
// WHAT THE GENERIC PATH WOULD NOT REPRODUCE:
//   - `top_k` and `logit_bias` are copied in their own fixed positions (:1458-1459).
//   - `enable_web_search` becomes `web_search: true` (:1412-1414) -- the member is ABSENT otherwise.
//   - `reasoning_effort` is forwarded whenever it is truthy (:1421-1423): there is NO
//     include_reasoning gate here, which is the exact opposite of DEEPSEEK.
//   - `json_schema` becomes `response_format: {type:'json_schema', json_schema:{name, description,
//     schema, strict: strict ?? true}}` (:1425-1435) -- the MISTRAL shape, NOT DEEPSEEK's appended
//     message.
//   - tools/tool_choice are forwarded RAW (:1416-1419).
//   - `bodyParams` is spread LAST (:1461), so web_search, tools/tool_choice, response_format and
//     reasoning_effort follow `seed` in the order the pinned statements create them.
//   - NO reverse_proxy support: `apiUrl = API_ELECTRONHUB` (:1395) is a bare literal and the key is
//     always the ELECTRONHUB secret, so a request that carries a reverse_proxy is IGNORED rather than
//     honoured. The seam is the only redirection.
//   - response: 2xx passed through unchanged; non-2xx answered 500 with the PARSED provider body
//     (`tryParse(errorText) ?? { error: true }`, :1481-1485); a THROWN fetch answered 200
//     {"error":true} (:1491-1497, `response.send` with no status); the stream is piped through
//     forwardFetchResponse, so the provider's own `data: [DONE]` reaches the caller verbatim.
//
// NOT COVERED, stated rather than silently different:
//   - The CLAUDE-specific cache injection (:1437-1447) is unreachable from a default request: it needs
//     `model` to match /^claude-/ AND one of two config values that are off by default
//     (`enableSystemPromptCache` false, `cachingAtDepth` -1) and are not projected into
//     HTTPHandlerOptions. A scenario with a claude-model request pins that nothing is injected, which
//     is the observable half; the injection itself would need a config write AND a boot-time override
//     the pinned server honours only at startup, so it stays a named gap exactly like the CLAUDE
//     lane's caching helpers.

import (
	"errors"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strconv"

	"github.com/cocokoishi/gotavern/internal/outbound"
	"github.com/cocokoishi/gotavern/internal/startup"
)

const (
	pinnedElectronHubAPIURL         = "https://api.electronhub.ai/v1"
	pinnedElectronHubSeamEnv        = "GOTAVERN_ELECTRONHUB_CHAT_URL"
	pinnedElectronHubSecretKey      = "api_key_electronhub"
	chatCompletionSourceElectronHub = "electronhub"
)

// pinnedElectronHubBaseURL is the pinned literal `API_ELECTRONHUB` (:84), replaceable only by the test
// seam. Both the generate route and the status route use it unchanged -- this route has no /beta-style
// difference to reproduce.
func pinnedElectronHubBaseURL() string {
	return sdSeamURL(pinnedElectronHubSeamEnv, pinnedElectronHubAPIURL)
}

// pinnedElectronHubPayload builds the pinned requestBody (:1410-1462).
func pinnedElectronHubPayload(body orderedNodeJSON) orderedNodeJSON {
	bodyParams := nodeObject()
	if pinnedJSTruthy(sdBodyMember(body, "enable_web_search")) {
		bodyParams.setMember("web_search", nodeBool(true))
	}
	if tools := sdBodyMember(body, "tools"); tools.kind == 'a' && len(tools.array) > 0 {
		bodyParams.setMember("tools", tools)
		if choice, exists := body.member("tool_choice"); exists {
			bodyParams.setMember("tool_choice", choice)
		} else {
			bodyParams.setMember("tool_choice", nodeUndefined())
		}
	}
	if effort, exists := body.member("reasoning_effort"); exists && pinnedJSTruthy(effort) {
		bodyParams.setMember("reasoning_effort", effort)
	}
	if schema := sdBodyMember(body, "json_schema"); pinnedJSTruthy(schema) {
		inner := nodeObject()
		if name, exists := schema.member("name"); exists {
			inner.setMember("name", name)
		}
		if description, exists := schema.member("description"); exists {
			inner.setMember("description", description)
		}
		if value, exists := schema.member("value"); exists {
			inner.setMember("schema", value)
		}
		strict := nodeBool(true)
		if supplied, exists := schema.member("strict"); exists && supplied.kind != nodeUndefinedKind {
			strict = supplied
		}
		inner.setMember("strict", strict)
		responseFormat := nodeObject()
		responseFormat.setMember("type", nodeString("json_schema"))
		responseFormat.setMember("json_schema", inner)
		bodyParams.setMember("response_format", responseFormat)
	}

	payload := nodeObject()
	// `'messages': request.body.messages` -- VERBATIM. This route runs no prompt processing, so a
	// repeated role stays two messages and a mid-prompt system turn stays a system turn.
	if messages, exists := body.member("messages"); exists {
		payload.setMember("messages", pinnedStructuredClone(messages))
	}
	for _, key := range []string{"model", "temperature", "max_tokens", "stream", "presence_penalty", "frequency_penalty", "top_p", "top_k", "logit_bias", "seed"} {
		if value, exists := body.member(key); exists {
			payload.setMember(key, value)
		}
	}
	for _, entry := range bodyParams.object {
		payload.setMember(entry.key, entry.value)
	}
	return payload
}

// pinnedElectronHubCatchFailure is the pinned catch: `response.send({ error: true })` with NO status.
func pinnedElectronHubCatchFailure() *pinnedChatCompletionFailure {
	return pinnedChatCompletionJSONFailure(http.StatusOK, pinnedChatCompletionErrorFlag())
}

// pinnedElectronHubPlan is the plan for the ELECTRONHUB source.
func pinnedElectronHubPlan(body orderedNodeJSON, directories startup.UserDirectories) (*outbound.Request, *pinnedChatCompletionFailure) {
	apiKey, err := pinnedReadSecret(directories, pinnedElectronHubSecretKey, pinnedSecretID(body))
	if err != nil {
		return nil, pinnedElectronHubCatchFailure()
	}
	if !pinnedJSTruthy(apiKey) {
		// :1398-1401. There is no reverse_proxy escape here: the pinned route never reads one.
		return nil, pinnedChatCompletionJSONFailure(http.StatusBadRequest, pinnedChatCompletionErrorFlag())
	}
	payload := pinnedElectronHubPayload(body)
	encoded, encodeErr := marshalOrderedNodeJSON(payload)
	if encodeErr != nil {
		return nil, pinnedElectronHubCatchFailure()
	}
	keyText, isString := apiKey.stringValue()
	if !isString {
		keyText = pinnedClaudeJSString(apiKey)
	}
	headers := map[string]string{
		"content-type":    "application/json",
		"authorization":   "Bearer " + keyText,
		"accept":          "*/*",
		"accept-encoding": "gzip, deflate, br",
		"user-agent":      "node-fetch",
		"content-length":  strconv.Itoa(len(encoded)),
	}
	endpointURL := pinnedElectronHubBaseURL() + "/chat/completions"
	parsedEndpoint, parseErr := url.Parse(endpointURL)
	if parseErr != nil || parsedEndpoint.Host == "" {
		return nil, pinnedElectronHubCatchFailure()
	}
	names := make([]string, 0, len(headers)+2)
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
	return &outbound.Request{URL: endpointURL, Method: http.MethodPost, Headers: requestHeaders, Body: encoded}, nil
}

// serveElectronHubChatCompletionResponse is the ELECTRONHUB side of the response: the shared forwarder
// for a stream, the provider body passed through for a 2xx answer, the PARSED provider body at 500 for
// a non-2xx answer, and 200 {"error":true} for anything that throws.
func serveElectronHubChatCompletionResponse(w http.ResponseWriter, request *http.Request, response *outbound.Response, body orderedNodeJSON) {
	if pinnedChatCompletionStreams(body) {
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

// serveElectronHubChatCompletionStatus is the ELECTRONHUB branch of the pinned status matrix
// (chat-completions.js:1813-1815 + the shared GET at :2072-2082): the URL is the pinned literal, the key
// is the ELECTRONHUB secret, headers are empty so the shared call adds only `Authorization: Bearer`, and
// the provider body is returned unchanged. A non-2xx provider answer leaves the shared envelope
// 200 {"error":true,"data":{"data":[]}}.
func (runtime *accountRuntime) serveElectronHubChatCompletionStatus(w http.ResponseWriter, request *http.Request, body orderedNodeJSON, directories startup.UserDirectories) {
	apiKey, err := pinnedReadSecret(directories, pinnedElectronHubSecretKey, pinnedSecretID(body))
	if err != nil {
		searchJSON(w, pinnedChatCompletionErrorFlag())
		return
	}
	if !pinnedJSTruthy(apiKey) {
		respondOrderedNodeJSON(w, http.StatusBadRequest, pinnedChatCompletionErrorFlag())
		return
	}
	keyText, isString := apiKey.stringValue()
	if !isString {
		keyText = pinnedClaudeJSString(apiKey)
	}
	response, fetchErr := searchFetch(request.Context(), searchRequest{
		Method:  http.MethodGet,
		URL:     sdURLJoin(pinnedElectronHubBaseURL(), "/models"),
		Headers: map[string]string{"authorization": "Bearer " + keyText},
	})
	if fetchErr != nil {
		searchJSON(w, pinnedChatCompletionErrorFlag())
		return
	}
	if !sdResponseOK(response) {
		envelope := nodeObject()
		envelope.setMember("error", nodeBool(true))
		data := nodeObject()
		data.setMember("data", nodeArray())
		envelope.setMember("data", data)
		searchJSON(w, envelope)
		return
	}
	parsed, parseErr := decodeOrderedNodeJSON(response.Body)
	if parseErr != nil {
		searchJSON(w, pinnedChatCompletionErrorFlag())
		return
	}
	respondOrderedNodeJSON(w, http.StatusOK, parsed)
}
