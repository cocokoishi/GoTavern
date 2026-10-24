package server

// Pinned MISTRAL conversation source, from src/endpoints/backends/chat-completions.js:881
// (sendMistralAIRequest), dispatched at :2264 (`case CHAT_COMPLETION_SOURCES.MISTRALAI`).
//
// THE SAME KIND AS CLAUDE, AND SMALLER. It is its own function with its own URL, key, body and error
// observables, so the plan switch delegates here and the response side branches on the source, but
// unlike CLAUDE it has no model-regex branches, no thinking/budget members, no beta-header
// composition and NO response rewrap: a 2xx body is passed through unchanged (:954).
//
// WHAT THE GENERIC PATH WOULD NOT REPRODUCE:
//   - `random_seed`: `request.body.seed === -1 ? undefined : request.body.seed` (:908). A seed of -1
//     is DROPPED rather than forwarded, which is not a `||` default and not a plain copy.
//   - `stop`: only forwarded when it is a NON-EMPTY array (:909).
//   - `safe_prompt`, forwarded verbatim in its own fixed position (:907).
//   - `messages` from convertMistralMessages (prompt-converters.js:703): tool ids REPLACED by the
//     first 9 hex characters of sha512(id), example_user/example_assistant name prefixes, a
//     `name: ` prefix on a non-system named message, a user turn folded into the previous user
//     content with "\n\n" when it follows a tool turn, and a system turn after an assistant turn
//     flipped to user.
//   - tools/tool_choice forwarded RAW (no mapping, no filtering), unlike CLAUDE.
//   - THREE error observables, none of them CLAUDE's: 400 {"error":true} for a missing key BEFORE
//     the try (:885-888); status 500 carrying the PARSED PROVIDER BODY for a non-2xx non-stream
//     answer (:946-951, `tryParse(errorText) ?? { error: true }`); and 200 {"error":true} for a
//     THROWN fetch (:956-962 -- `response.send` with no status, which is the branch an implementer
//     copying CLAUDE would get wrong).
//
// NOT COVERED, stated rather than silently different: `mistral.enablePrefix` (prompt-converters.js:709,
// default false) marks a trailing assistant turn with `prefix: true`. It is CONFIG-GATED and OFF by
// default, and the mistral config key is not projected into HTTPHandlerOptions, so a default request
// can never reach it. Every other member of this route is implemented.
//
// REUSED, not re-ported: `pinnedClaudeNamesFor`/`startsWithGroupName` (getPromptNames,
// prompt-converters.js:49 is source-neutral) and `pinnedClaudeJSString` (JavaScript String()).

import (
	"crypto/sha512"
	"encoding/hex"
	"errors"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"github.com/cocokoishi/gotavern/internal/outbound"
	"github.com/cocokoishi/gotavern/internal/startup"
)

const (
	pinnedMistralAPIURL         = "https://api.mistral.ai/v1"
	pinnedMistralSeamEnv        = "GOTAVERN_MISTRAL_CHAT_URL"
	pinnedMistralSecretKey      = "api_key_mistralai"
	chatCompletionSourceMistral = "mistralai"
)

// pinnedMistralBaseURL is the pinned literal `API_MISTRAL` (:75), replaceable only by the test seam.
// BOTH the generate route and the status route build their URL from it, so one seam serves both.
func pinnedMistralBaseURL() string { return sdSeamURL(pinnedMistralSeamEnv, pinnedMistralAPIURL) }

// pinnedMistralToolID is `crypto.createHash('sha512').update(id).digest('hex').slice(0, 9)` (:715).
// The pinned `.update()` does NOT coerce its argument, so a non-string id throws and the route's
// catch answers 200 {"error":true}; that is reported as an error here rather than stringified.
func pinnedMistralToolID(id orderedNodeJSON) (string, error) {
	text, isString := id.stringValue()
	if !isString {
		return "", errors.New("tool id is not a string")
	}
	sum := sha512.Sum512([]byte(text))
	return hex.EncodeToString(sum[:])[:9], nil
}

// pinnedMistralMessageText is the `msg.content` read the pinned converter performs and then treats as
// a string (`.startsWith`, `+=`). A non-string content is reported as an error, which the route turns
// into its catch observable.
func pinnedMistralMessageText(message orderedNodeJSON) (string, error) {
	content, exists := message.member("content")
	if !exists {
		return "", nil
	}
	text, isString := content.stringValue()
	if !isString {
		if content.kind == nodeUndefinedKind || content.kind == 'n' {
			return "", errors.New("message content is not a string")
		}
		return "", errors.New("message content is not a string")
	}
	return text, nil
}

// pinnedMistralMessages ports convertMistralMessages (prompt-converters.js:703).
func pinnedMistralMessages(body orderedNodeJSON) (orderedNodeJSON, error) {
	raw := sdBodyMember(body, "messages")
	if raw.kind != 'a' {
		// `if (!Array.isArray(messages)) return [];` -- a NON-ARRAY messages member becomes an empty
		// array rather than throwing, which is the opposite of the CLAUDE converter.
		return nodeArray(), nil
	}
	messages := pinnedStructuredClone(raw)
	names := pinnedClaudeNamesFor(body)

	for position := range messages.array {
		message := messages.array[position]
		if message.kind != 'o' {
			continue
		}
		if toolCalls, exists := message.member("tool_calls"); exists && toolCalls.kind == 'a' {
			for callPosition, call := range toolCalls.array {
				if call.kind != 'o' {
					continue
				}
				sanitized, err := pinnedMistralToolID(sdBodyMember(call, "id"))
				if err != nil {
					return orderedNodeJSON{}, err
				}
				call.setMember("id", nodeString(sanitized))
				toolCalls.array[callPosition] = call
			}
			message.setMember("tool_calls", toolCalls)
		}
		role, _ := pinnedClaudeMemberString(message, "role")
		if _, hasToolCallID := message.member("tool_call_id"); hasToolCallID && role == "tool" {
			sanitized, err := pinnedMistralToolID(sdBodyMember(message, "tool_call_id"))
			if err != nil {
				return orderedNodeJSON{}, err
			}
			message.setMember("tool_call_id", nodeString(sanitized))
		}
		content, err := pinnedMistralMessageText(message)
		if err != nil {
			return orderedNodeJSON{}, err
		}
		name, hasName := pinnedClaudeMemberString(message, "name")
		if role == "system" && name == "example_assistant" {
			if names.charName != "" && !strings.HasPrefix(content, names.charName+": ") && !names.startsWithGroupName(content) {
				message.setMember("content", nodeString(names.charName+": "+content))
			}
			message.deleteMember("name")
		}
		if role == "system" && name == "example_user" {
			if names.userName != "" && !strings.HasPrefix(content, names.userName+": ") {
				message.setMember("content", nodeString(names.userName+": "+content))
			}
			message.deleteMember("name")
		}
		if hasName && name != "" && role != "system" && !strings.HasPrefix(content, name+": ") {
			message.setMember("content", nodeString(name+": "+content))
			message.deleteMember("name")
		}
		messages.array[position] = message
	}

	// fixToolMessages (:748-767): a USER turn right after a TOOL turn is appended to the closest
	// EARLIER user turn's content with "\n\n", and the loop re-runs until nothing moves.
	for rerun := true; rerun; {
		rerun = false
		for index := 0; index < len(messages.array)-1; index++ {
			role, _ := pinnedClaudeMemberString(messages.array[index], "role")
			if role != "tool" {
				continue
			}
			nextRole, _ := pinnedClaudeMemberString(messages.array[index+1], "role")
			if nextRole != "user" {
				continue
			}
			lastUser := -1
			for candidate := index - 1; candidate >= 0; candidate-- {
				candidateRole, _ := pinnedClaudeMemberString(messages.array[candidate], "role")
				if candidateRole != "user" {
					continue
				}
				if text, _ := pinnedMistralMessageText(messages.array[candidate]); text != "" {
					lastUser = candidate
					break
				}
			}
			if lastUser == -1 {
				continue
			}
			nextText, _ := pinnedMistralMessageText(messages.array[index+1])
			priorText, _ := pinnedMistralMessageText(messages.array[lastUser])
			messages.array[lastUser].setMember("content", nodeString(priorText+"\n\n"+nextText))
			messages.array = append(messages.array[:index+1], messages.array[index+2:]...)
			rerun = true
			break
		}
	}

	// A SYSTEM turn immediately after an ASSISTANT turn becomes a USER turn (:770-774).
	for index := 0; index < len(messages.array)-1; index++ {
		role, _ := pinnedClaudeMemberString(messages.array[index], "role")
		nextRole, _ := pinnedClaudeMemberString(messages.array[index+1], "role")
		if role == "assistant" && nextRole == "system" {
			messages.array[index+1].setMember("role", nodeString("user"))
		}
	}
	return messages, nil
}

// pinnedMistralPayload builds the pinned requestBody (:898-927) in its fixed member order.
func pinnedMistralPayload(body orderedNodeJSON) (orderedNodeJSON, *pinnedChatCompletionFailure) {
	messages, err := pinnedMistralMessages(body)
	if err != nil {
		// The converter throws INSIDE the pinned try, so the catch answers 200 {"error":true}.
		return orderedNodeJSON{}, pinnedMistralCatchFailure()
	}
	payload := nodeObject()
	for _, key := range []string{"model"} {
		if value, exists := body.member(key); exists {
			payload.setMember(key, value)
		}
	}
	payload.setMember("messages", messages)
	for _, key := range []string{"temperature", "top_p", "frequency_penalty", "presence_penalty", "max_tokens", "stream", "safe_prompt"} {
		if value, exists := body.member(key); exists {
			payload.setMember(key, value)
		}
	}
	// `random_seed: request.body.seed === -1 ? undefined : request.body.seed` -- a seed of -1 is
	// dropped, any other present value is forwarded unchanged.
	if seed, exists := body.member("seed"); exists {
		isMinusOne := seed.kind == 'v' && seed.scalar.(float64) == -1
		if !isMinusOne {
			payload.setMember("random_seed", seed)
		}
	}
	// `stop` only when it is a non-empty array.
	if stop := sdBodyMember(body, "stop"); stop.kind == 'a' && len(stop.array) > 0 {
		payload.setMember("stop", stop)
	}

	// tools/tool_choice are forwarded RAW (:912-915), not mapped.
	if tools := sdBodyMember(body, "tools"); tools.kind == 'a' && len(tools.array) > 0 {
		payload.setMember("tools", tools)
		if choice, exists := body.member("tool_choice"); exists {
			payload.setMember("tool_choice", choice)
		} else {
			payload.setMember("tool_choice", nodeUndefined())
		}
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
		payload.setMember("response_format", responseFormat)
	}
	return payload, nil
}

// pinnedMistralCatchFailure is the pinned catch: `response.send({ error: true })` WITHOUT a status, so
// the answer is 200 -- a 500 here would be a different contract from the pinned one.
func pinnedMistralCatchFailure() *pinnedChatCompletionFailure {
	return pinnedChatCompletionJSONFailure(http.StatusOK, pinnedChatCompletionErrorFlag())
}

// pinnedMistralPlan is the plan for the MISTRAL source.
func pinnedMistralPlan(body orderedNodeJSON, directories startup.UserDirectories) (*outbound.Request, *pinnedChatCompletionFailure) {
	apiURL := pinnedMistralBaseURL()
	apiKey := nodeUndefined()
	if reverseProxy, exists := body.member("reverse_proxy"); exists && pinnedJSTruthy(reverseProxy) {
		normalized, ok := pinnedJSURLString(reverseProxy)
		if !ok {
			return nil, pinnedMistralCatchFailure()
		}
		apiURL = normalized
		if password, exists := body.member("proxy_password"); exists {
			apiKey = password
		}
	} else {
		secret, err := pinnedReadSecret(directories, pinnedMistralSecretKey, pinnedSecretID(body))
		if err != nil {
			return nil, pinnedMistralCatchFailure()
		}
		apiKey = secret
	}
	if !pinnedJSTruthy(apiKey) {
		// :885-888, BEFORE the try.
		return nil, pinnedChatCompletionJSONFailure(http.StatusBadRequest, pinnedChatCompletionErrorFlag())
	}
	payload, failure := pinnedMistralPayload(body)
	if failure != nil {
		return nil, failure
	}
	encoded, encodeErr := marshalOrderedNodeJSON(payload)
	if encodeErr != nil {
		return nil, pinnedMistralCatchFailure()
	}
	keyText, keyErr := pinnedJSStringValue(apiKey)
	if keyErr != nil {
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
	endpointURL := apiURL + "/chat/completions"
	parsedEndpoint, parseErr := url.Parse(endpointURL)
	if parseErr != nil || parsedEndpoint.Host == "" {
		return nil, pinnedMistralCatchFailure()
	}
	requestHeaders := pinnedChatCompletionRequestFraming(headers, parsedEndpoint)
	return &outbound.Request{URL: endpointURL, Method: http.MethodPost, Headers: requestHeaders, Body: encoded}, nil
}

// serveMistralChatCompletionStatus is the MISTRALAI branch of the pinned status matrix
// (chat-completions.js:1796-1799, then the shared GET at :2072-2082).
//
// Unlike CLAUDE, this source HAS a branch: the URL is `new URL(reverse_proxy || API_MISTRAL)`, the key
// is the proxy password or the MISTRALAI secret, headers are empty (so the shared call adds only
// `Authorization: Bearer`), and the provider's body is returned unchanged. A non-2xx provider answer
// leaves the shared `else` at :2143-2145 in place: 200 {"error":true,"data":{"data":[]}}.
func (runtime *accountRuntime) serveMistralChatCompletionStatus(w http.ResponseWriter, request *http.Request, body orderedNodeJSON, directories startup.UserDirectories) {
	apiURL := pinnedMistralBaseURL()
	apiKey := nodeUndefined()
	proxyTruthy := false
	if reverseProxy, exists := body.member("reverse_proxy"); exists && pinnedJSTruthy(reverseProxy) {
		normalized, ok := pinnedJSURLString(reverseProxy)
		if !ok {
			searchJSON(w, pinnedChatCompletionErrorFlag())
			return
		}
		apiURL = normalized
		proxyTruthy = true
		if password, exists := body.member("proxy_password"); exists {
			apiKey = password
		}
	} else {
		secret, err := pinnedReadSecret(directories, pinnedMistralSecretKey, pinnedSecretID(body))
		if err != nil {
			searchJSON(w, pinnedChatCompletionErrorFlag())
			return
		}
		apiKey = secret
	}
	if !pinnedJSTruthy(apiKey) && !proxyTruthy {
		// :2067-2070.
		respondOrderedNodeJSON(w, http.StatusBadRequest, pinnedChatCompletionErrorFlag())
		return
	}
	keyText, keyErr := pinnedJSStringValue(apiKey)
	if keyErr != nil {
		keyText = pinnedClaudeJSString(apiKey)
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
