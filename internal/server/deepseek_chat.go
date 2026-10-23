package server

// Pinned DEEPSEEK conversation source, from src/endpoints/backends/chat-completions.js:1071
// (sendDeepSeekRequest), dispatched at :2266.
//
// OWN TRANSFORM WITH SHARED PROMPT HELPERS. The request is built here, not by the generic plan path,
// but the MESSAGE side rides three helpers shared with other sources: postProcessPrompt(messages,
// SEMI_TOOLS) (:1119), addAssistantPrefix(..., 'prefix') and addReasoningContentToToolCalls(...). The
// first of those is already ported (backendsMergeMessages, whose SEMI_TOOLS options are exactly
// {strict, tools}), so this file reuses it and ports only the two small helpers.
//
// WHAT THE GENERIC PATH WOULD NOT REPRODUCE:
//   - `thinking: { type: include_reasoning ? 'enabled' : 'disabled' }` is ALWAYS present (:1137).
//   - `bodyParams` is spread LAST (:1138), so its members are appended after `thinking` in the order
//     the pinned statements create them: top_logprobs/logprobs, tools/tool_choice, response_format,
//     reasoning_effort.
//   - tools are forwarded RAW, but a tool whose `parameters.required` is an EMPTY ARRAY has that key
//     DELETED (:1098-1104, "DeepSeek doesn't permit empty required arrays").
//   - json_schema sets `response_format: { type: 'json_object' }` AND APPENDS a new USER message
//     carrying the schema pretty-printed with four spaces (:1107-1117) -- a message, not a tool.
//   - `reasoning_effort` is forwarded only when include_reasoning AND reasoning_effort are both set.
//   - seed and stop are forwarded as-is: there is no `-1` rule here (contrast MISTRAL).
//   - the key guard is `!apiKey && !request.body.reverse_proxy` (:1075), so a reverse_proxy WITHOUT a
//     password does NOT answer 400 -- the request goes out with `Bearer undefined`.
//   - response: 2xx passed through unchanged; non-2xx answered 500 with the PARSED PROVIDER BODY
//     (`tryParse(errorText) ?? { error: true }`); a THROWN fetch answered 200 {"error":true} because
//     that catch uses `response.send` with no status (:1168-1174).
//   - the stream is piped through forwardFetchResponse, so DeepSeek's own `data: [DONE]` terminator
//     reaches the caller verbatim.
//
// NOT COVERED, stated rather than silently different: PROMPT_PLACEHOLDER (config value
// `promptPlaceholder`), which is reached only when the merge result is EMPTY (:903-908). The claude
// and process routes carry the same named gap: the config key is not projected into
// HTTPHandlerOptions, so this route uses the pinned default.

import (
	"errors"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"

	"github.com/cocokoishi/gotavern/internal/outbound"
	"github.com/cocokoishi/gotavern/internal/startup"
)

const (
	// :86 -- note the /beta suffix on the GENERATE base, which the status branch strips.
	pinnedDeepSeekAPIURL         = "https://api.deepseek.com/beta"
	pinnedDeepSeekSeamEnv        = "GOTAVERN_DEEPSEEK_CHAT_URL"
	pinnedDeepSeekSecretKey      = "api_key_deepseek"
	chatCompletionSourceDeepSeek = "deepseek"
)

// pinnedDeepSeekBaseURL is the pinned literal `API_DEEPSEEK`, replaceable only by the test seam.
func pinnedDeepSeekBaseURL() string { return sdSeamURL(pinnedDeepSeekSeamEnv, pinnedDeepSeekAPIURL) }

// pinnedDeepSeekStatusBaseURL is `API_DEEPSEEK.replace('/beta', ”)` (:1823): the status route asks for
// /models on the host root, not on the beta path. The replace mirrors the pinned expression, so a seam
// that carries no /beta (the replay's local origin) is left alone.
func pinnedDeepSeekStatusBaseURL() string {
	return strings.ReplaceAll(pinnedDeepSeekBaseURL(), "/beta", "")
}

// pinnedJSONStringifyIndent4 reproduces `JSON.stringify(value, null, 4)`, which the json_schema branch
// embeds in a MESSAGE, so the exact whitespace is part of the provider bytes.
func pinnedJSONStringifyIndent4(value orderedNodeJSON, depth int) (string, error) {
	indent := strings.Repeat(" ", depth*4)
	childIndent := strings.Repeat(" ", (depth+1)*4)
	switch value.kind {
	case 'o':
		entries, _ := value.entries()
		if len(entries) == 0 {
			return "{}", nil
		}
		parts := make([]string, 0, len(entries))
		for _, entry := range entries {
			keyBytes, err := marshalNodeJSONString(entry.key)
			if err != nil {
				return "", err
			}
			rendered, err := pinnedJSONStringifyIndent4(entry.value, depth+1)
			if err != nil {
				return "", err
			}
			parts = append(parts, childIndent+string(keyBytes)+": "+rendered)
		}
		return "{\n" + strings.Join(parts, ",\n") + "\n" + indent + "}", nil
	case 'a':
		if len(value.array) == 0 {
			return "[]", nil
		}
		parts := make([]string, 0, len(value.array))
		for _, item := range value.array {
			rendered, err := pinnedJSONStringifyIndent4(item, depth+1)
			if err != nil {
				return "", err
			}
			parts = append(parts, childIndent+rendered)
		}
		return "[\n" + strings.Join(parts, ",\n") + "\n" + indent + "]", nil
	case 's':
		encoded, err := marshalNodeJSONString(value.scalar.(string))
		return string(encoded), err
	case 'h':
		unit := value.scalar.(uint16)
		hex := strconv.FormatUint(uint64(unit), 16)
		return `"\u` + strings.Repeat("0", 4-len(hex)) + hex + `"`, nil
	case 'v':
		encoded, err := marshalECMAScriptNumber(value.scalar.(float64))
		return string(encoded), err
	case 'n':
		return "null", nil
	default:
		// undefined has no JSON rendering and a schema cannot carry one; JSON.stringify would throw,
		// which the route's catch turns into 200 {"error":true}.
		return "", errors.New("json_schema value is not representable")
	}
}

// pinnedAddAssistantPrefix is addAssistantPrefix (prompt-converters.js:67) with property 'prefix': it
// marks the LAST message when it is an assistant turn and there is no tool in play.
func pinnedAddAssistantPrefix(messages orderedNodeJSON, tools orderedNodeJSON) {
	if messages.kind != 'a' || len(messages.array) == 0 {
		return
	}
	hasAnyTools := tools.kind == 'a' && len(tools.array) > 0
	if !hasAnyTools {
		for _, message := range messages.array {
			if role, _ := pinnedClaudeMemberString(message, "role"); role == "tool" {
				hasAnyTools = true
				break
			}
		}
	}
	if hasAnyTools {
		return
	}
	last := messages.array[len(messages.array)-1]
	if role, _ := pinnedClaudeMemberString(last, "role"); role != "assistant" {
		return
	}
	last.setMember("prefix", nodeBool(true))
	messages.array[len(messages.array)-1] = last
}

// pinnedAddReasoningContentToToolCalls is addReasoningContentToToolCalls (prompt-converters.js:1377):
// a message that carries tool_calls and no reasoning_content member gains an EMPTY one.
func pinnedAddReasoningContentToToolCalls(messages orderedNodeJSON) {
	if messages.kind != 'a' {
		return
	}
	for position, message := range messages.array {
		toolCalls, exists := message.member("tool_calls")
		if !exists || toolCalls.kind != 'a' {
			continue
		}
		if _, hasReasoning := message.member("reasoning_content"); hasReasoning {
			continue
		}
		message.setMember("reasoning_content", nodeString(""))
		messages.array[position] = message
	}
}

// pinnedDeepSeekPayload builds the pinned requestBody (:1087-1139).
func pinnedDeepSeekPayload(body orderedNodeJSON) (orderedNodeJSON, *pinnedChatCompletionFailure) {
	names := backendsPromptNamesFor(body)

	// The pinned code mutates request.body.messages (the json_schema push lands there and the merge
	// rewrites it in place), so the work happens on a clone.
	messages := pinnedStructuredClone(sdBodyMember(body, "messages"))
	if messages.kind != 'a' {
		messages = nodeArray()
	}
	jsonSchema := sdBodyMember(body, "json_schema")
	if pinnedJSTruthy(jsonSchema) {
		schemaText, err := pinnedJSONStringifyIndent4(sdBodyMember(jsonSchema, "value"), 0)
		if err != nil {
			return orderedNodeJSON{}, pinnedDeepSeekCatchFailure()
		}
		pushed := nodeObject()
		pushed.setMember("role", nodeString("user"))
		pushed.setMember("content", nodeString("JSON schema for the response:\n"+schemaText))
		messages.array = append(messages.array, pushed)
	}

	processed, err := backendsMergeMessages(messages, names, backendsMergeOptions{strict: true, tools: true})
	if err != nil {
		return orderedNodeJSON{}, pinnedDeepSeekCatchFailure()
	}
	tools := sdBodyMember(body, "tools")
	pinnedAddAssistantPrefix(processed, tools)
	pinnedAddReasoningContentToToolCalls(processed)

	// bodyParams, in the order the pinned statements create them.
	bodyParams := nodeObject()
	if logprobs := sdBodyMember(body, "logprobs"); pinnedJSGreaterThanZero(logprobs) {
		bodyParams.setMember("top_logprobs", logprobs)
		bodyParams.setMember("logprobs", nodeBool(true))
	}
	if tools.kind == 'a' && len(tools.array) > 0 {
		cleaned := nodeArray()
		for _, tool := range tools.array {
			cleaned.array = append(cleaned.array, pinnedDeepSeekDropEmptyRequired(tool))
		}
		bodyParams.setMember("tools", cleaned)
		if choice, exists := body.member("tool_choice"); exists {
			bodyParams.setMember("tool_choice", choice)
		} else {
			bodyParams.setMember("tool_choice", nodeUndefined())
		}
	}
	if pinnedJSTruthy(jsonSchema) {
		responseFormat := nodeObject()
		responseFormat.setMember("type", nodeString("json_object"))
		bodyParams.setMember("response_format", responseFormat)
	}
	includeReasoning := pinnedJSTruthy(sdBodyMember(body, "include_reasoning"))
	if reasoningEffort, exists := body.member("reasoning_effort"); exists && includeReasoning && pinnedJSTruthy(reasoningEffort) {
		bodyParams.setMember("reasoning_effort", reasoningEffort)
	}

	payload := nodeObject()
	payload.setMember("messages", processed)
	for _, key := range []string{"model", "temperature", "max_tokens", "stream", "presence_penalty", "frequency_penalty", "top_p", "stop", "seed"} {
		if value, exists := body.member(key); exists {
			payload.setMember(key, value)
		}
	}
	thinking := nodeObject()
	if includeReasoning {
		thinking.setMember("type", nodeString("enabled"))
	} else {
		thinking.setMember("type", nodeString("disabled"))
	}
	payload.setMember("thinking", thinking)
	for _, entry := range bodyParams.object {
		payload.setMember(entry.key, entry.value)
	}
	return payload, nil
}

// pinnedDeepSeekDropEmptyRequired reproduces the pinned tools mutation: a function whose
// `parameters.required` is an ARRAY OF LENGTH ZERO loses that key (:1098-1104).
func pinnedDeepSeekDropEmptyRequired(tool orderedNodeJSON) orderedNodeJSON {
	if tool.kind != 'o' {
		return tool
	}
	function, exists := tool.member("function")
	if !exists || function.kind != 'o' {
		return tool
	}
	parameters, exists := function.member("parameters")
	if !exists || parameters.kind != 'o' {
		return tool
	}
	required, exists := parameters.member("required")
	if !exists || required.kind != 'a' || len(required.array) != 0 {
		return tool
	}
	parameters.deleteMember("required")
	function.setMember("parameters", parameters)
	tool.setMember("function", function)
	return tool
}

// pinnedDeepSeekCatchFailure is the pinned catch: `response.send({ error: true })` with NO status.
func pinnedDeepSeekCatchFailure() *pinnedChatCompletionFailure {
	return pinnedChatCompletionJSONFailure(http.StatusOK, pinnedChatCompletionErrorFlag())
}

// pinnedDeepSeekPlan is the plan for the DEEPSEEK source.
func pinnedDeepSeekPlan(body orderedNodeJSON, directories startup.UserDirectories) (*outbound.Request, *pinnedChatCompletionFailure) {
	apiURL := pinnedDeepSeekBaseURL()
	apiKey := nodeUndefined()
	reverseProxyTruthy := false
	if reverseProxy, exists := body.member("reverse_proxy"); exists && pinnedJSTruthy(reverseProxy) {
		normalized, ok := pinnedJSURLString(reverseProxy)
		if !ok {
			return nil, pinnedDeepSeekCatchFailure()
		}
		apiURL = normalized
		reverseProxyTruthy = true
		if password, exists := body.member("proxy_password"); exists {
			apiKey = password
		}
	} else {
		secret, err := pinnedReadSecret(directories, pinnedDeepSeekSecretKey, pinnedSecretID(body))
		if err != nil {
			return nil, pinnedDeepSeekCatchFailure()
		}
		apiKey = secret
	}
	if !pinnedJSTruthy(apiKey) && !reverseProxyTruthy {
		// :1075 -- note the guard is `!apiKey && !reverse_proxy`, so a reverse_proxy WITHOUT a password
		// passes this check.
		return nil, pinnedChatCompletionJSONFailure(http.StatusBadRequest, pinnedChatCompletionErrorFlag())
	}
	payload, failure := pinnedDeepSeekPayload(body)
	if failure != nil {
		return nil, failure
	}
	encoded, encodeErr := marshalOrderedNodeJSON(payload)
	if encodeErr != nil {
		return nil, pinnedDeepSeekCatchFailure()
	}
	// `'Bearer ' + apiKey` stringifies an absent proxy password, which is where the pinned
	// `Bearer undefined` comes from.
	keyText := "undefined"
	if pinnedJSTruthy(apiKey) {
		if value, isString := apiKey.stringValue(); isString {
			keyText = value
		} else {
			keyText = pinnedClaudeJSString(apiKey)
		}
	}
	headers := map[string]string{
		"content-type":    "application/json",
		"authorization":   "Bearer " + keyText,
		"accept":          "*/*",
		"accept-encoding": "gzip, deflate, br",
		"user-agent":      "node-fetch",
		"content-length":  strconv.Itoa(len(encoded)),
	}
	endpointURL := apiURL + "/chat/completions"
	parsedEndpoint, parseErr := url.Parse(endpointURL)
	if parseErr != nil || parsedEndpoint.Host == "" {
		return nil, pinnedDeepSeekCatchFailure()
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

// serveDeepSeekChatCompletionResponse is the DEEPSEEK side of the response: the shared forwarder for a
// stream, the provider body passed through for a 2xx answer, the PARSED provider body at 500 for a
// non-2xx answer, and 200 {"error":true} for anything that throws.
func serveDeepSeekChatCompletionResponse(w http.ResponseWriter, request *http.Request, response *outbound.Response, body orderedNodeJSON) {
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

// serveDeepSeekChatCompletionStatus is the DEEPSEEK branch of the pinned status matrix
// (chat-completions.js:1822-1825 + the shared GET at :2072-2082): the base is API_DEEPSEEK with /beta
// REMOVED, the key is the proxy password or the DEEPSEEK secret, headers are empty so the shared call
// adds only `Authorization: Bearer`, and the provider body is returned unchanged. A non-2xx provider
// answer leaves the shared envelope 200 {"error":true,"data":{"data":[]}}.
func (runtime *accountRuntime) serveDeepSeekChatCompletionStatus(w http.ResponseWriter, request *http.Request, body orderedNodeJSON, directories startup.UserDirectories) {
	apiURL := pinnedDeepSeekStatusBaseURL()
	apiKey := nodeUndefined()
	reverseProxyTruthy := false
	if reverseProxy, exists := body.member("reverse_proxy"); exists && pinnedJSTruthy(reverseProxy) {
		normalized, ok := pinnedJSURLString(reverseProxy)
		if !ok {
			searchJSON(w, pinnedChatCompletionErrorFlag())
			return
		}
		apiURL = strings.ReplaceAll(normalized, "/beta", "")
		reverseProxyTruthy = true
		if password, exists := body.member("proxy_password"); exists {
			apiKey = password
		}
	} else {
		secret, err := pinnedReadSecret(directories, pinnedDeepSeekSecretKey, pinnedSecretID(body))
		if err != nil {
			searchJSON(w, pinnedChatCompletionErrorFlag())
			return
		}
		apiKey = secret
	}
	if !pinnedJSTruthy(apiKey) && !reverseProxyTruthy {
		respondOrderedNodeJSON(w, http.StatusBadRequest, pinnedChatCompletionErrorFlag())
		return
	}
	keyText := "undefined"
	if pinnedJSTruthy(apiKey) {
		if value, isString := apiKey.stringValue(); isString {
			keyText = value
		} else {
			keyText = pinnedClaudeJSString(apiKey)
		}
	}
	response, fetchErr := searchFetch(request.Context(), searchRequest{
		Method:  http.MethodGet,
		URL:     sdURLJoin(apiURL, "/models"),
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
