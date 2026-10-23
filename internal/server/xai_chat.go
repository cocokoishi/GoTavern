package server

// Pinned xAI conversation source, from src/endpoints/backends/chat-completions.js:1183
// (sendXaiRequest), dispatched at :2268 (`case CHAT_COMPLETION_SOURCES.XAI`).
//
// OWN TRANSFORM WITH A SHARED HELPER ON THE NAME SIDE. The request body, URL, key and every fold are
// this source's own; the only thing it borrows is getPromptNames (prompt-converters.js:49), which is
// the source-neutral name resolver backendsPromptNamesFor already ports.
//
// THE MESSAGE CONVERTER IS convertXAIMessages (prompt-converters.js:785), NOT mergeMessages: it does
// not merge, does not re-role, does not touch tool calls and does not add an assistant prefix. It
// renames only, and its guards have two consequences a merge-shaped port would get wrong:
//   - the early return is `if (!msg.name || msg.role === 'user')` (:791-793), so a USER turn keeps its
//     `name` member all the way to the provider, and a message with a FALSY name ('' / null / 0)
//     keeps it too;
//   - every other named message loses `name` (:810) whether or not a rule matched, so a named `tool`
//     turn loses its name without gaining a prefix.
//
// WHAT THE GENERIC PATH WOULD NOT REPRODUCE (the fold list, in pinned order):
//   - member ORDER: `messages` FIRST (:1232), then model/temperature/max_tokens/max_completion_tokens/
//     stream/presence_penalty/frequency_penalty/top_p/seed/n, then bodyParams spread LAST (:1244);
//   - `max_completion_tokens` and `n` are forwarded, and `top_k` / `logit_bias` / `stop` are NOT in the
//     base list, so a `stop` reaches the wire only through the bodyParams fold below;
//   - `logprobs > 0` adds `top_logprobs` (the count) and `logprobs: true` (:1201-1204);
//   - tools are forwarded RAW with `tool_choice` beside them (:1206-1209), and an ABSENT tool_choice is
//     a key with an `undefined` VALUE that JSON.stringify then DROPS -- so the wire body has no
//     `tool_choice` member at all (not a null), which is why the plan omits it rather than emitting a
//     null placeholder;
//   - `stop` only when it is a NON-EMPTY array (:1211-1213);
//   - `reasoning_effort` is MAPPED, not forwarded: exactly `'high'` stays `'high'` and anything else
//     truthy becomes `'low'` (:1215-1217);
//   - `json_schema` folds to `{type:'json_schema', json_schema:{name, strict ?? true, schema: value}}`
//     (:1219-1228) -- member order `name, strict, schema`, NO `description`, and `value` copied RAW
//     (no flattening). The shared pinnedChatCompletionResponseFormat helper emits
//     `{name, strict, schema}` too but its callers flatten the schema, and groq's own fold carries
//     `description` and puts `strict` after `schema`, so neither is this shape;
//   - the key guard is `!apiKey && !reverse_proxy` (:1187), so a reverse_proxy WITHOUT a password goes
//     out with `Bearer undefined` rather than answering 400;
//   - the URL is `new URL(reverse_proxy || API_XAI).toString() + '/chat/completions'` (:1184, :1259),
//     so a proxy origin without a path yields the pinned doubled slash `//chat/completions`;
//   - response: a stream is piped through forwardFetchResponse (:1261-1262); a non-2xx non-stream
//     answer is status 500 carrying the PARSED PROVIDER BODY (`tryParse(errorText) ?? {error: true}`,
//     :1264-1269); a 2xx answer is passed through unchanged (:1270-1272); a THROWN fetch answers
//     **200** `{"error":true}`, because that catch uses `response.send` with no status (:1274-1281).
//
// THE /status ARM EXISTS (:1826-1829). It is the shared status tail with xai's URL expression and key:
// `apiUrl = new URL(reverse_proxy || API_XAI).toString()`, `apiKey = reverse_proxy ? proxy_password :
// readSecret(..XAI)`, `headers = {}`, then the shared :2067 key guard (400 unless reverse_proxy),
// `GET urlJoin(apiUrl, '/models')` with `Authorization: Bearer <key>`, the provider body passed through
// on 2xx, `200 {"error":true,"data":{"data":[]}}` on a non-2xx, `200 {"error":true}` when the fetch or
// the parse throws. Note the generate route and the status route read the SAME literal with no
// transformation (contrast DEEPSEEK, whose status arm strips `/beta`), so ONE seam serves both.

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
	// chat-completions.js:87 `const API_XAI = 'https://api.x.ai/v1'`. This is the pinned literal for
	// BOTH the generate route (:1184) and the status arm (:1827); the seam exists only so the recorded
	// differential can aim the Go leg at the same recording peer the pinned leg is redirected to, and
	// its default is asserted against the fixture's recorded literal.
	pinnedXAIAPIURL         = "https://api.x.ai/v1"
	pinnedXAISeamEnv        = "GOTAVERN_XAI_CHAT_URL"
	pinnedXAISecretKey      = "api_key_xai"
	chatCompletionSourceXAI = "xai"
)

// pinnedXAIBaseURL is the pinned literal, replaceable only by the test seam.
func pinnedXAIBaseURL() string { return sdSeamURL(pinnedXAISeamEnv, pinnedXAIAPIURL) }

// pinnedXAIContentText is the `msg.content` read convertXAIMessages performs and then treats as a
// string (`.startsWith`). Anything that is not a string throws in pinned -- including an ABSENT
// content, since `undefined.startsWith` is a TypeError -- and that throw is inside the route's try, so
// it answers 200 {"error":true}. Note the read happens for EVERY named non-user message once either
// name is set, because the pinned rule array is built eagerly even though only one rule can match.
func pinnedXAIContentText(message orderedNodeJSON) (string, error) {
	content, exists := message.member("content")
	if !exists {
		return "", errors.New("message content is not a string")
	}
	text, isString := content.stringValue()
	if !isString {
		return "", errors.New("message content is not a string")
	}
	return text, nil
}

// pinnedXAIMessages ports convertXAIMessages (prompt-converters.js:785).
func pinnedXAIMessages(body orderedNodeJSON) (orderedNodeJSON, error) {
	raw := sdBodyMember(body, "messages")
	if raw.kind != 'a' {
		// `if (!Array.isArray(messages)) return [];` -- a non-array becomes an EMPTY array rather than
		// throwing.
		return nodeArray(), nil
	}
	messages := pinnedStructuredClone(raw)
	names := backendsPromptNamesFor(body)
	// The pinned rule array evaluates all three conditions eagerly, so the content read is guarded by
	// "either name is set", not by the role of this particular message.
	needsContentText := names.charName != "" || names.userName != ""

	for position := range messages.array {
		message := messages.array[position]
		if message.kind != 'o' {
			// `msg.name` on a non-object element is undefined, which the early return treats as falsy.
			continue
		}
		nameNode, hasName := message.member("name")
		if !hasName || !pinnedJSTruthy(nameNode) {
			// `!msg.name` -- a falsy name (absent, '', null, 0, false) leaves the message ENTIRELY
			// untouched, including that falsy name member.
			continue
		}
		role, _ := pinnedClaudeMemberString(message, "role")
		if role == "user" {
			// `msg.role === 'user'` -- a named USER turn is returned from the callback before the
			// `delete msg.name`, so it keeps its name on the wire.
			continue
		}
		name, _ := pinnedClaudeMemberString(message, "name")
		contentText := ""
		if needsContentText {
			text, err := pinnedXAIContentText(message)
			if err != nil {
				return orderedNodeJSON{}, err
			}
			contentText = text
		}

		// The three pinned rules, in order; `.find` returns the FIRST match, and the two charName rules
		// share their whole condition.
		matched := false
		charNameApplies := names.charName != "" &&
			!strings.HasPrefix(contentText, names.charName+": ") &&
			!names.startsWithGroupName(contentText)
		switch {
		case role == "assistant" && charNameApplies:
			matched = true
		case role == "system" && name == "example_assistant" && charNameApplies:
			matched = true
		case role == "system" && name == "example_user" && names.userName != "" &&
			!strings.HasPrefix(contentText, names.userName+": "):
			matched = true
		}
		if matched {
			prefix := names.charName
			if role == "system" && name == "example_user" {
				prefix = names.userName
			}
			message.setMember("content", nodeString(prefix+": "+contentText))
		}
		// `delete msg.name` is OUTSIDE the match, so an unmatched named message loses its name too.
		message.deleteMember("name")
		messages.array[position] = message
	}
	return messages, nil
}

// pinnedXAIResponseFormat is xai's own json_schema fold (:1219-1228), member order included:
// `{type, json_schema: {name, strict, schema}}` with `strict ?? true` and the schema copied RAW.
func pinnedXAIResponseFormat(jsonSchema orderedNodeJSON) orderedNodeJSON {
	format := nodeObject()
	format.setMember("type", nodeString("json_schema"))
	inner := nodeObject()
	if name, exists := jsonSchema.member("name"); exists {
		inner.setMember("name", name)
	}
	// `strict: request.body.json_schema.strict ?? true` -- null and undefined both become true.
	strict := nodeBool(true)
	if supplied, exists := jsonSchema.member("strict"); exists && !supplied.isUndefined() && !supplied.isNull() {
		strict = supplied
	}
	inner.setMember("strict", strict)
	if value, exists := jsonSchema.member("value"); exists {
		inner.setMember("schema", value)
	}
	format.setMember("json_schema", inner)
	return format
}

// pinnedXAIPayload builds the pinned requestBody (:1232-1245) in its fixed member order.
//
// A member whose pinned value is `undefined` is OMITTED rather than written as a null: the literal
// object keeps the key with an undefined value and `JSON.stringify` drops exactly those. Writing a
// null would be a different body on the wire, so `tool_choice` is simply not set when the request does
// not carry one.
func pinnedXAIPayload(body orderedNodeJSON) (orderedNodeJSON, *pinnedChatCompletionFailure) {
	messages, err := pinnedXAIMessages(body)
	if err != nil {
		// The converter throws INSIDE the pinned try, so the catch answers 200 {"error":true}.
		return orderedNodeJSON{}, pinnedXAICatchFailure()
	}

	// bodyParams, in the order the pinned statements create them.
	bodyParams := nodeObject()
	if logprobs := sdBodyMember(body, "logprobs"); pinnedJSGreaterThanZero(logprobs) {
		bodyParams.setMember("top_logprobs", logprobs)
		bodyParams.setMember("logprobs", nodeBool(true))
	}
	if tools := sdBodyMember(body, "tools"); tools.kind == 'a' && len(tools.array) > 0 {
		bodyParams.setMember("tools", tools)
		// `bodyParams['tool_choice'] = request.body.tool_choice` -- undefined when absent, and dropped
		// by JSON.stringify, so the member is added only when the request carries one.
		if choice, exists := body.member("tool_choice"); exists {
			bodyParams.setMember("tool_choice", choice)
		}
	}
	if stop := sdBodyMember(body, "stop"); stop.kind == 'a' && len(stop.array) > 0 {
		bodyParams.setMember("stop", stop)
	}
	if effort := sdBodyMember(body, "reasoning_effort"); pinnedJSTruthy(effort) {
		// `request.body.reasoning_effort === 'high' ? 'high' : 'low'` -- a MAPPING, not a copy.
		mapped := "low"
		if text, isString := effort.stringValue(); isString && text == "high" {
			mapped = "high"
		}
		bodyParams.setMember("reasoning_effort", nodeString(mapped))
	}
	if schema := sdBodyMember(body, "json_schema"); pinnedJSTruthy(schema) {
		bodyParams.setMember("response_format", pinnedXAIResponseFormat(schema))
	}

	payload := nodeObject()
	payload.setMember("messages", messages)
	for _, key := range []string{
		"model", "temperature", "max_tokens", "max_completion_tokens", "stream",
		"presence_penalty", "frequency_penalty", "top_p", "seed", "n",
	} {
		if value, exists := body.member(key); exists {
			payload.setMember(key, value)
		}
	}
	for _, entry := range bodyParams.object {
		payload.setMember(entry.key, entry.value)
	}
	return payload, nil
}

// pinnedXAICatchFailure is the pinned catch: `response.send({ error: true })` with NO status, so the
// answer is 200 -- a 500 here would be a different contract from the pinned one.
func pinnedXAICatchFailure() *pinnedChatCompletionFailure {
	return pinnedChatCompletionJSONFailure(http.StatusOK, pinnedChatCompletionErrorFlag())
}

// pinnedXAIPlan is the plan for the XAI source.
func pinnedXAIPlan(body orderedNodeJSON, directories startup.UserDirectories) (*outbound.Request, *pinnedChatCompletionFailure) {
	apiURL := pinnedXAIBaseURL()
	apiKey := nodeUndefined()
	reverseProxyTruthy := false
	if reverseProxy, exists := body.member("reverse_proxy"); exists && pinnedJSTruthy(reverseProxy) {
		normalized, ok := pinnedJSURLString(reverseProxy)
		if !ok {
			return nil, pinnedXAICatchFailure()
		}
		apiURL = normalized
		reverseProxyTruthy = true
		if password, exists := body.member("proxy_password"); exists {
			apiKey = password
		}
	} else {
		secret, err := pinnedReadSecret(directories, pinnedXAISecretKey, pinnedSecretID(body))
		if err != nil {
			return nil, pinnedXAICatchFailure()
		}
		apiKey = secret
	}
	if !pinnedJSTruthy(apiKey) && !reverseProxyTruthy {
		// :1187 -- `!apiKey && !request.body.reverse_proxy`, so a reverse_proxy WITHOUT a password
		// passes and leaves with `Bearer undefined`.
		return nil, pinnedChatCompletionJSONFailure(http.StatusBadRequest, pinnedChatCompletionErrorFlag())
	}
	payload, failure := pinnedXAIPayload(body)
	if failure != nil {
		return nil, failure
	}
	encoded, encodeErr := marshalOrderedNodeJSON(payload)
	if encodeErr != nil {
		return nil, pinnedXAICatchFailure()
	}
	// `'Bearer ' + apiKey` stringifies an absent proxy password, which is where `Bearer undefined`
	// comes from.
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
		return nil, pinnedXAICatchFailure()
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

// serveXAIChatCompletionResponse is the XAI side of the response:
//
//   - a stream is piped through the shared forwarder, so xAI's own `data: [DONE]` terminator reaches
//     the caller verbatim (:1261-1262);
//   - a non-2xx NON-stream answer is answered 500 with the PARSED PROVIDER BODY, falling back to
//     {"error":true} only when the body is not JSON (:1264-1269);
//   - a 2xx answer is passed through UNCHANGED (:1270-1272);
//   - a body that does not parse, or a read failure, is the pinned catch: 200 {"error":true}.
func serveXAIChatCompletionResponse(w http.ResponseWriter, request *http.Request, response *outbound.Response, body orderedNodeJSON) {
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

// serveXAIChatCompletionStatus is the XAI branch of the pinned status matrix (chat-completions.js:1826-1829,
// then the shared GET at :2072-2082).
//
// Unlike CLAUDE, this source HAS a branch, and unlike GROQ its arm honours reverse_proxy: the URL is
// `new URL(reverse_proxy || API_XAI).toString()` with NO transformation (the same expression the
// generate route uses, so one seam serves both), the key is the proxy password or the xAI secret, the
// arm's headers are empty so the shared call adds only `Authorization: Bearer`, and the provider body
// is returned unchanged. A non-2xx provider answer leaves the shared else at :2143-2145 in place: 200
// {"error":true,"data":{"data":[]}}.
func (runtime *accountRuntime) serveXAIChatCompletionStatus(w http.ResponseWriter, request *http.Request, body orderedNodeJSON, directories startup.UserDirectories) {
	apiURL := pinnedXAIBaseURL()
	apiKey := nodeUndefined()
	reverseProxyTruthy := false
	if reverseProxy, exists := body.member("reverse_proxy"); exists && pinnedJSTruthy(reverseProxy) {
		normalized, ok := pinnedJSURLString(reverseProxy)
		if !ok {
			// `new URL(...)` throws before the fetch, so the pinned catch answers {"error":true}.
			searchJSON(w, pinnedChatCompletionErrorFlag())
			return
		}
		apiURL = normalized
		reverseProxyTruthy = true
		if password, exists := body.member("proxy_password"); exists {
			apiKey = password
		}
	} else {
		secret, err := pinnedReadSecret(directories, pinnedXAISecretKey, pinnedSecretID(body))
		if err != nil {
			searchJSON(w, pinnedChatCompletionErrorFlag())
			return
		}
		apiKey = secret
	}
	if !pinnedJSTruthy(apiKey) && !reverseProxyTruthy {
		// :2067-2070 -- 400 for a missing key, unless the request carries a reverse_proxy.
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
