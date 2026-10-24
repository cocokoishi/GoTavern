package server

// Pinned COHERE conversation source, from src/endpoints/backends/chat-completions.js:971
// (sendCohereRequest), dispatched at :2265 (`case CHAT_COMPLETION_SOURCES.COHERE`).
//
// OWN TRANSFORM, NO SHARED REQUEST HELPERS. Cohere is a sibling of CLAUDE and MISTRAL rather than a member
// of the openai-compatible shared path: it builds its own body, its own single header pair, its own URL
// (:1039 `API_COHERE_V2 + '/chat'`) and its own response mapping. The message side rides
// convertCohereMessages (prompt-converters.js:384), which is used by this source alone.
//
// WHAT THE GENERIC PATH WOULD NOT REPRODUCE:
//   - the body is a FLAT list of renamed members, in the pinned statement order, with no request passthrough
//     at all: `stream` is coerced with Boolean(), `top_k` becomes `k`, `top_p` becomes `p`, `stop` becomes
//     `stop_sequences`, and `documents: []` plus `tools` are ALWAYS present (:998-1012). A body this route
//     does not name never reaches the provider -- there is no `...request.body` spread.
//   - `safety_mode: 'OFF'` is added only when `String(request.body.model).endsWith('08-2024')` (:1014-1017).
//   - `json_schema` becomes `response_format: { type: 'json_schema', schema: <value> }` (:1019-1024) -- a
//     top-level `schema`, not the `json_schema: {name, schema, strict}` envelope the shared path builds.
//     The ROUTE flattens that value before dispatch (:2255-2257 `flattenSchema`), so the flatten is applied
//     here at the point of use, as the groq branch does.
//   - every tool whose `function.parameters.$schema` is truthy loses that member (:988-995); the rest of the
//     tool object is forwarded RAW.
//   - the key guard is `if (!apiKey)` (:979) and there is NO reverse_proxy and NO custom_url anywhere in this
//     function, so unlike the shared path a request carrying `reverse_proxy` does NOT skip the refusal.
//   - three error observables: 400 {"error":true} for a missing key BEFORE the try (:979-982); status 500
//     carrying the PARSED PROVIDER BODY for a non-2xx non-stream answer (:1046-1051,
//     `tryParse(errorText) ?? { error: true }`); and 200 {"error":true} for anything that throws (:1056-1062,
//     `response.send` with no status).
//   - a stream is piped through forwardFetchResponse, so Cohere's own events reach the caller verbatim.
//
// MESSAGE CONVERTER DETAILS THAT ARE EASY TO "TIDY" AWAY (convertCohereMessages, prompt-converters.js:384):
//   - an EMPTY messages array is replaced by one user turn carrying PROMPT_PLACEHOLDER;
//   - `messages.forEach` MUTATES the array with splice() when a tool_calls message follows an assistant turn,
//     so the element that follows such a fold SHIFTS INTO the already-visited index and is SKIPPED entirely
//     (:394-401). The loop below reproduces that skip rather than iterating the original elements;
//   - a tool_calls message takes the PREVIOUS assistant message's content and the assistant message is
//     removed, or (when it is first or the previous turn is not assistant) it gets the literal
//     "I'm going to call a tool for that: <names>" content (:399);
//   - example_assistant/example_user system turns gain a `charName: `/`userName: ` prefix, every other
//     named turn gains a `name: ` prefix, and `name` is then DELETED (:403-418);
//   - `.startsWith` on a non-string content throws, which the route's catch turns into 200 {"error":true}.
//
// NOT COVERED, stated rather than silently different: PROMPT_PLACEHOLDER (getConfigValue('promptPlaceholder',
// "Let's get started."), prompt-converters.js:4) is reached only when the converted message list is EMPTY.
// The config key is not projected into HTTPHandlerOptions (the claude and process routes carry the same
// named gap), so this route uses the pinned default.
//
// /status (:1805-1808) IS a pinned arm: apiUrl = API_COHERE_V1, apiKey = the COHERE secret, headers = {},
// then the SHARED tail (:2067-2146). Note :2112-2114 -- the `data.data = data.models.map(...)` fold runs
// AFTER `statusResponse.send(data)` at :2110, so it is a POST-SEND mutation of an already-serialized object
// and is NOT observable on the wire. The status answer is therefore the provider's body, unchanged.

import (
	"errors"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"github.com/cocokoishi/gotavern/internal/outbound"
	"github.com/cocokoishi/gotavern/internal/startup"
)

const (
	// :77-78 -- the two pinned literals. The chat route reads V2, the status arm reads V1, so there is no
	// suffix relation between them to derive one from the other (contrast DEEPSEEK's `/beta` strip).
	pinnedCohereAPIURL       = "https://api.cohere.ai/v2"
	pinnedCohereStatusAPIURL = "https://api.cohere.ai/v1"
	pinnedCohereSeamEnv      = "GOTAVERN_COHERE_CHAT_URL"
	// The status literal lives OUTSIDE the chat base, so it carries its own seam (the FIREWORKS precedent)
	// and the provider-wire status scenarios declare this variable.
	pinnedCohereStatusSeamEnv  = "GOTAVERN_COHERE_STATUS_URL"
	pinnedCohereSecretKey      = "api_key_cohere"
	chatCompletionSourceCohere = "cohere"
	// prompt-converters.js:4 `getConfigValue('promptPlaceholder', "Let's get started.")`. See NOT COVERED.
	pinnedCoherePromptPlaceholder = "Let's get started."
)

// pinnedCohereBaseURL is the pinned chat literal, replaceable only by the test seam.
func pinnedCohereBaseURL() string { return sdSeamURL(pinnedCohereSeamEnv, pinnedCohereAPIURL) }

// pinnedCohereStatusBaseURL is the pinned status literal, which lives outside the chat base.
func pinnedCohereStatusBaseURL() string {
	return sdSeamURL(pinnedCohereStatusSeamEnv, pinnedCohereStatusAPIURL)
}

// pinnedCohereMessageText is the `msg.content` read the pinned converter does and then treats as a string
// (`.startsWith`, `+=`). A missing or non-string content is reported as an error, which the route turns
// into its catch observable rather than stringifying into bytes the pinned server never sends.
func pinnedCohereMessageText(message orderedNodeJSON) (string, error) {
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

// pinnedCohereToolNames is `msg.tool_calls.map(tc => tc?.function?.name).join(', ')` (:399). Array.join
// renders a null or undefined element as the EMPTY STRING, so a call without a name contributes an empty
// slot rather than being dropped.
func pinnedCohereToolNames(toolCalls orderedNodeJSON) (string, error) {
	names := make([]string, 0, len(toolCalls.array))
	for _, call := range toolCalls.array {
		name := ""
		if call.kind == 'o' {
			if function, exists := call.member("function"); exists && function.kind == 'o' {
				if value, hasName := function.member("name"); hasName && !value.isUndefined() && !value.isNull() {
					text, err := pinnedJSStringValue(value)
					if err != nil {
						return "", err
					}
					name = text
				}
			}
		}
		names = append(names, name)
	}
	return strings.Join(names, ", "), nil
}

// pinnedCohereMessages ports convertCohereMessages (prompt-converters.js:384).
func pinnedCohereMessages(body orderedNodeJSON) (orderedNodeJSON, error) {
	raw := sdBodyMember(body, "messages")
	if raw.kind != 'a' {
		// `messages.length` / `messages.forEach` throw for anything that is not an array (a string, a number,
		// null, undefined), which the pinned catch answers with 200 {"error":true}. The EMPTY-ARRAY case does
		// NOT throw -- it is the placeholder branch below.
		return orderedNodeJSON{}, errors.New("messages is not an array")
	}
	messages := pinnedStructuredClone(raw)
	names := backendsPromptNamesFor(body)

	if len(messages.array) == 0 {
		// `messages.unshift({ role: 'user', content: PROMPT_PLACEHOLDER })`.
		placeholder := nodeObject()
		placeholder.setMember("role", nodeString("user"))
		placeholder.setMember("content", nodeString(pinnedCoherePromptPlaceholder))
		messages.array = append([]orderedNodeJSON{placeholder}, messages.array...)
	}

	// `forEach` captures the length ONCE and skips an index that no longer exists, so a splice inside the
	// callback makes the following element be visited under the loop counter that has already advanced past
	// it. That element is therefore never converted, which is the pinned behaviour and not an oversight.
	initialLength := len(messages.array)
	for index := 0; index < initialLength; index++ {
		if index >= len(messages.array) {
			continue
		}
		message := messages.array[index]
		// A null or undefined element throws on the first member read (`msg.tool_calls`), which is the pinned
		// catch. Any other primitive is harmless: a member read on it yields undefined, so neither block
		// below runs and the element is forwarded unchanged.
		if message.kind == 'n' || message.isUndefined() {
			return orderedNodeJSON{}, errors.New("message is null")
		}
		// `msg` is a REFERENCE in the pinned code: a splice moves it, but the mutations that follow still land
		// on the same object at its NEW index. `position` tracks that, so the single write-back at the end of
		// the body cannot clobber the element that shifted into the old index.
		position := index
		isObject := message.kind == 'o'

		if isObject {
			if toolCalls, exists := message.member("tool_calls"); exists && toolCalls.kind == 'a' {
				previousIsAssistant := false
				if index > 0 {
					previous := messages.array[index-1]
					if previous.kind == 'n' || previous.isUndefined() {
						return orderedNodeJSON{}, errors.New("message is null")
					}
					role, _ := pinnedClaudeMemberString(previous, "role")
					previousIsAssistant = role == "assistant"
				}
				if previousIsAssistant {
					// `msg.content = messages[index - 1].content` -- a MISSING content on the previous turn
					// assigns undefined, which JSON.stringify then drops from the tool_calls turn.
					content := nodeUndefined()
					if previousContent, exists := messages.array[index-1].member("content"); exists {
						content = previousContent
					}
					message.setMember("content", content)
					messages.array = append(messages.array[:index-1], messages.array[index:]...)
					position = index - 1
				} else {
					joined, err := pinnedCohereToolNames(toolCalls)
					if err != nil {
						return orderedNodeJSON{}, err
					}
					message.setMember("content", nodeString("I'm going to call a tool for that: "+joined))
				}
			}

			if nameValue, hasName := message.member("name"); hasName && pinnedJSTruthy(nameValue) {
				role, _ := pinnedClaudeMemberString(message, "role")
				name, nameErr := pinnedJSStringValue(nameValue)
				if nameErr != nil {
					return orderedNodeJSON{}, nameErr
				}
				content, contentErr := pinnedCohereMessageText(message)
				if contentErr != nil {
					return orderedNodeJSON{}, contentErr
				}
				if role == "system" && name == "example_assistant" {
					if names.charName != "" && !strings.HasPrefix(content, names.charName+": ") && !names.startsWithGroupName(content) {
						message.setMember("content", nodeString(names.charName+": "+content))
					}
				}
				if role == "system" && name == "example_user" {
					if names.userName != "" && !strings.HasPrefix(content, names.userName+": ") {
						message.setMember("content", nodeString(names.userName+": "+content))
					}
				}
				if role != "system" && !strings.HasPrefix(content, name+": ") {
					message.setMember("content", nodeString(name+": "+content))
				}
				message.deleteMember("name")
			}
		}

		messages.array[position] = message
	}

	return messages, nil
}

// pinnedCohereTools ports :986-995: the tools array is forwarded RAW except that a truthy
// `function.parameters.$schema` is DELETED. The result is ALWAYS an array, empty when the request carries
// no tools, because `tools: tools` is an unconditional member of the pinned body.
func pinnedCohereTools(body orderedNodeJSON) orderedNodeJSON {
	raw, exists := body.member("tools")
	if !exists || raw.kind != 'a' || len(raw.array) == 0 {
		return nodeArray()
	}
	tools := pinnedStructuredClone(raw)
	for position, tool := range tools.array {
		if tool.kind != 'o' {
			continue
		}
		function, hasFunction := tool.member("function")
		if !hasFunction || function.kind != 'o' {
			continue
		}
		parameters, hasParameters := function.member("parameters")
		if !hasParameters || parameters.kind != 'o' {
			continue
		}
		schema, hasSchema := parameters.member("$schema")
		if !hasSchema || !pinnedJSTruthy(schema) {
			continue
		}
		parameters.deleteMember("$schema")
		function.setMember("parameters", parameters)
		tool.setMember("function", function)
		tools.array[position] = tool
	}
	return tools
}

// pinnedCoherePayload builds the pinned requestBody (:998-1024) in its fixed member order.
func pinnedCoherePayload(body orderedNodeJSON) (orderedNodeJSON, *pinnedChatCompletionFailure) {
	history, err := pinnedCohereMessages(body)
	if err != nil {
		// The converter throws INSIDE the pinned try, so the catch answers 200 {"error":true}.
		return orderedNodeJSON{}, pinnedCohereCatchFailure()
	}

	payload := nodeObject()
	// `stream: Boolean(request.body.stream)` -- ALWAYS present, and never undefined.
	stream := nodeBool(false)
	if value, exists := body.member("stream"); exists {
		stream = nodeBool(pinnedJSTruthy(value))
	}
	payload.setMember("stream", stream)
	if model, exists := body.member("model"); exists {
		payload.setMember("model", model)
	}
	payload.setMember("messages", history)
	for _, pair := range [][2]string{
		{"temperature", "temperature"},
		{"max_tokens", "max_tokens"},
		// `k: request.body.top_k` / `p: request.body.top_p` -- two renames, not a copy of the shared path.
		{"k", "top_k"},
		{"p", "top_p"},
		{"seed", "seed"},
		// `stop_sequences: request.body.stop` -- forwarded as supplied, with no non-empty-array check.
		{"stop_sequences", "stop"},
		{"frequency_penalty", "frequency_penalty"},
		{"presence_penalty", "presence_penalty"},
	} {
		if value, exists := body.member(pair[1]); exists {
			payload.setMember(pair[0], value)
		}
	}
	// `documents: []` and `tools` are unconditional members of the pinned literal.
	payload.setMember("documents", nodeArray())
	payload.setMember("tools", pinnedCohereTools(body))

	// `String(request.body.model).endsWith('08-2024')` -- String(undefined) is "undefined", which does not
	// match, so an absent model simply never takes this branch.
	if modelText, modelErr := pinnedJSStringValue(sdBodyMember(body, "model")); modelErr == nil && strings.HasSuffix(modelText, "08-2024") {
		payload.setMember("safety_mode", nodeString("OFF"))
	}

	if schema, exists := body.member("json_schema"); exists && pinnedJSTruthy(schema) {
		format := nodeObject()
		format.setMember("type", nodeString("json_schema"))
		if value, hasValue := schema.member("value"); hasValue {
			// The route-level `flattenSchema` (:2255-2257) has already run on this value before the source
			// function is called; pinnedFlattenSchema is idempotent for an already-flattened schema and is a
			// no-op for a falsy or non-object value, which is where the pinned guard leaves it too.
			format.setMember("schema", pinnedFlattenSchema(value))
		} else {
			format.setMember("schema", nodeUndefined())
		}
		payload.setMember("response_format", format)
	}
	return payload, nil
}

// pinnedCohereCatchFailure is the pinned catch: `response.send({ error: true })` with NO status, so the
// answer is 200 -- a 500 here would be a different contract from the pinned one.
func pinnedCohereCatchFailure() *pinnedChatCompletionFailure {
	return pinnedChatCompletionJSONFailure(http.StatusOK, pinnedChatCompletionErrorFlag())
}

// pinnedCoherePlan is the plan for the COHERE source.
func pinnedCoherePlan(body orderedNodeJSON, directories startup.UserDirectories) (*outbound.Request, *pinnedChatCompletionFailure) {
	apiKey, secretErr := pinnedReadSecret(directories, pinnedCohereSecretKey, pinnedSecretID(body))
	if secretErr != nil {
		return nil, pinnedCohereCatchFailure()
	}
	// :979 `if (!apiKey)` -- JavaScript truthiness, and the ONLY credential guard on this route: cohere reads
	// neither `reverse_proxy` nor `proxy_password`, so a request that carries one is still refused here.
	if !pinnedJSTruthy(apiKey) {
		return nil, pinnedChatCompletionJSONFailure(http.StatusBadRequest, pinnedChatCompletionErrorFlag())
	}

	payload, failure := pinnedCoherePayload(body)
	if failure != nil {
		return nil, failure
	}
	encoded, encodeErr := marshalOrderedNodeJSON(payload)
	if encodeErr != nil {
		return nil, pinnedCohereCatchFailure()
	}

	keyText, keyErr := pinnedJSStringValue(apiKey)
	if keyErr != nil {
		keyText = pinnedClaudeJSString(apiKey)
	}
	// The pinned `config.headers` is exactly {Content-Type, Authorization}; node-fetch then adds its own
	// defaults and a computed Content-Length, which pinnedChatCompletionHeaders reproduces.
	headers := map[string]string{
		"content-type":    "application/json",
		"authorization":   "Bearer " + keyText,
		"accept":          "*/*",
		"accept-encoding": "gzip, deflate, br",
		"user-agent":      "node-fetch",
		"content-length":  strconv.Itoa(len(encoded)),
	}
	// :1039 `API_COHERE_V2 + '/chat'` -- a plain concatenation, NOT urlJoin.
	endpointURL := pinnedCohereBaseURL() + "/chat"
	parsedEndpoint, parseErr := url.Parse(endpointURL)
	if parseErr != nil || parsedEndpoint.Host == "" {
		return nil, pinnedCohereCatchFailure()
	}
	requestHeaders := pinnedChatCompletionRequestFraming(headers, parsedEndpoint)
	return &outbound.Request{URL: endpointURL, Method: http.MethodPost, Headers: requestHeaders, Body: encoded}, nil
}

// serveCohereChatCompletionStatus is the COHERE arm of the pinned status matrix (:1805-1808 + the shared GET
// at :2072-2082): the base is API_COHERE_V1, the key is the COHERE secret, `headers = {}` so the shared call
// adds only `Authorization: Bearer`, and the provider body is returned UNCHANGED.
//
// The missing-key refusal it inherits consults `request.body.reverse_proxy` even though this source never
// uses that member for its URL (the same quirk the GROQ and OPENROUTER arms document).
//
// The :2112-2114 `data.data = data.models.map(...)` fold is NOT reproduced as an output shape: it runs after
// `statusResponse.send(data)` at :2110, so the object it mutates has already been serialized and the fold is
// unobservable. Reproducing it would emit a projection the pinned server never sends.
func (runtime *accountRuntime) serveCohereChatCompletionStatus(w http.ResponseWriter, request *http.Request, body orderedNodeJSON, directories startup.UserDirectories) {
	errorOnly := nodeObject()
	errorOnly.setMember("error", nodeBool(true))
	keyNode, secretErr := pinnedReadSecret(directories, pinnedCohereSecretKey, pinnedSecretID(body))
	if secretErr != nil {
		searchJSON(w, errorOnly)
		return
	}
	key, keyErr := pinnedJSStringValue(keyNode)
	if keyErr != nil {
		searchJSON(w, errorOnly)
		return
	}
	reverseProxyTruthy := false
	if reverseProxy, exists := body.member("reverse_proxy"); exists && pinnedJSTruthy(reverseProxy) {
		reverseProxyTruthy = true
	}
	if !pinnedJSTruthy(keyNode) && !reverseProxyTruthy {
		pinnedChatCompletionMissingKeyRefusal(w)
		return
	}
	headers := map[string]string{"authorization": "Bearer " + key}
	response, fetchErr := searchFetch(request.Context(), searchRequest{
		Method:  http.MethodGet,
		URL:     sdURLJoin(pinnedCohereStatusBaseURL(), "/models"),
		Headers: headers,
	})
	if fetchErr != nil {
		searchJSON(w, errorOnly)
		return
	}
	if !sdResponseOK(response) {
		failure := nodeObject()
		failure.setMember("error", nodeBool(true))
		emptyData := nodeObject()
		emptyData.setMember("data", nodeArray())
		failure.setMember("data", emptyData)
		searchJSON(w, failure)
		return
	}
	data, parsed := sdReadJSON(response)
	if !parsed {
		searchJSON(w, errorOnly)
		return
	}
	searchJSON(w, data)
}
