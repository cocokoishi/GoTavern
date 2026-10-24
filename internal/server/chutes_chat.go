package server

// Pinned CHUTES conversation source, from src/endpoints/backends/chat-completions.js:1506
// (sendChutesRequest), dispatched at :2269.
//
// OWN TRANSFORM, and a SMALLER one than its siblings: there is no prompt post-processing at all.
// `messages: request.body.messages` is forwarded VERBATIM (:1547), so this file does not touch
// backendsMergeMessages, addAssistantPrefix or addReasoningContentToToolCalls. That is the first thing a
// reader arriving from deepseek_chat.go will expect and will not find.
//
// WHAT THE GENERIC PATH WOULD NOT REPRODUCE:
//   - the body's MEMBER ORDER is the pinned literal order (:1546-1563): messages, model, temperature,
//     max_tokens, stream, presence_penalty, frequency_penalty, repetition_penalty, min_p, top_p, top_k,
//     seed, stop, reasoning_effort, logit_bias, and only then the folded members. `min_p`, `top_k` and
//     `repetition_penalty` are FORWARDED here; the generic path does not forward them for every source.
//   - the three folded members, in this order (:1524-1544):
//     tools + tool_choice   when `Array.isArray(request.body.tools) && request.body.tools.length > 0`.
//     A NON-ARRAY truthy `tools` is NOT forwarded (the Array.isArray guard), and `tool_choice` is set even
//     when absent (undefined is dropped by JSON.stringify, so it appears only when supplied).
//     top_logprobs + logprobs:true   when `request.body.logprobs > 0`, a NUMERIC comparison under JS
//     coercion -- the string "1" folds (Number("1") > 0), the boolean true folds (1 > 0), null does not.
//     response_format       when `json_schema` is truthy: {type:'json_schema', json_schema:{name,
//     description, schema:value, strict: strict ?? true}}. `strict` defaults to TRUE, and `name`/
//     `description` are copied even when absent (dropped by stringify) -- the shape difference from
//     Pollinations' {type, json_schema:{schema}} and WorkersAI's bare json_schema.
//   - the CREDENTIAL is API_CHUTES + readSecret('api_key_chutes') ONLY. This transform has NO
//     reverse_proxy branch: a reverse_proxy in the body is ignored and the key guard is the plain
//     `if (!apiKey) 400 {error:true}` (:1510-1513). Contrast deepseek/mistral, where reverse_proxy moves
//     the URL and supplies the password.
//   - response: stream -> forwardFetchResponse (verbatim, including the provider's own terminator);
//     2xx -> the parsed provider body; non-2xx -> 500 with `tryParse(errorText) ?? {error:true}`
//     (:1582-1587); a thrown fetch -> 200 {"error":true}, because the catch uses `response.send` with NO
//     status (:1592-1599). A 2xx whose body is not JSON throws in `generateResponse.json()`, which is the
//     same catch, so that case is also 200 {"error":true}.
//
// /status EXISTS (:1809-1811) and it is the SHARED models GET shape, not its own: `urlJoin(API_CHUTES,
// '/models')` with only `Authorization: Bearer <key>`, no query params and no extra header, then the one
// chutes-specific projection at :2092-2108 which runs BEFORE `statusResponse.send(data)` -- unlike the
// COHERE and OPENROUTER projections, which run AFTER the send and are dead code. The projection keeps
// only models with a truthy `id` and, when `pricing.prompt` and `pricing.completion` are both defined,
// adds `input`/`output` copies inside the same `pricing` object (the spread keeps the provider's member
// order, so the two new keys land last).

import (
	"net/http"
	"net/url"
	"strconv"

	"github.com/cocokoishi/gotavern/internal/outbound"
	"github.com/cocokoishi/gotavern/internal/startup"
)

const (
	// :83 -- one literal serves BOTH the generate call and the status arm.
	pinnedChutesAPIURL         = "https://llm.chutes.ai/v1"
	pinnedChutesSeamEnv        = "GOTAVERN_CHUTES_CHAT_URL"
	pinnedChutesSecretKey      = "api_key_chutes"
	chatCompletionSourceChutes = "chutes"
)

// pinnedChutesBaseURL is the pinned literal, replaceable only by the test seam. The status arm uses the
// same seam and the same literal; there is no second base for this source.
func pinnedChutesBaseURL() string { return sdSeamURL(pinnedChutesSeamEnv, pinnedChutesAPIURL) }

// pinnedChutesStatusURL is `urlJoin(apiUrl,'/models')` (:2072) with no query params.
func pinnedChutesStatusURL() string { return sdURLJoin(pinnedChutesBaseURL(), "/models") }

// pinnedChutesCatchFailure is the pinned catch for this transform: `response.send({error:true})` with no
// status, i.e. 200.
func pinnedChutesCatchFailure() *pinnedChatCompletionFailure {
	return pinnedChatCompletionJSONFailure(http.StatusOK, pinnedChatCompletionErrorFlag())
}

// pinnedChutesPayload builds the provider body in the pinned literal member order.
func pinnedChutesPayload(body orderedNodeJSON) (orderedNodeJSON, *pinnedChatCompletionFailure) {
	// bodyParams, in the order the pinned statements create them.
	bodyParams := nodeObject()
	tools := sdBodyMember(body, "tools")
	if tools.kind == 'a' && len(tools.array) > 0 {
		bodyParams.setMember("tools", tools)
		// `bodyParams['tool_choice'] = request.body.tool_choice` with an ABSENT member: JSON.stringify
		// DROPS an undefined value, so the key must not appear at all. Writing null here (which is what
		// nodeUndefined() serialises to through this package's encoder) would put a member on the wire
		// that pinned never sends.
		if choice, exists := body.member("tool_choice"); exists && !choice.isUndefined() {
			bodyParams.setMember("tool_choice", choice)
		}
	}
	// `request.body.logprobs > 0` -- JS coercion, including the numeric-string and boolean cases.
	if logprobs := sdBodyMember(body, "logprobs"); pinnedJSGreaterThanZero(logprobs) {
		bodyParams.setMember("top_logprobs", logprobs)
		bodyParams.setMember("logprobs", nodeBool(true))
	}
	jsonSchema := sdBodyMember(body, "json_schema")
	if pinnedJSTruthy(jsonSchema) {
		responseFormat := nodeObject()
		responseFormat.setMember("type", nodeString("json_schema"))
		inner := nodeObject()
		// name, description and schema are copied straight from the request body, so an ABSENT member is
		// undefined and JSON.stringify drops it. Only `strict` is unconditionally present (?? true).
		for _, key := range []string{"name", "description"} {
			if value, exists := jsonSchema.member(key); exists && !value.isUndefined() {
				inner.setMember(key, value)
			}
		}
		if value, exists := jsonSchema.member("value"); exists && !value.isUndefined() {
			inner.setMember("schema", value)
		}
		// `strict: request.body.json_schema.strict ?? true` -- null coalesces to true; false stays false.
		if strict, exists := jsonSchema.member("strict"); exists && !strict.isUndefined() && !strict.isNull() {
			inner.setMember("strict", strict)
		} else {
			inner.setMember("strict", nodeBool(true))
		}
		responseFormat.setMember("json_schema", inner)
		bodyParams.setMember("response_format", responseFormat)
	}

	payload := nodeObject()
	payload.setMember("messages", sdBodyMember(body, "messages"))
	for _, key := range []string{
		"model", "temperature", "max_tokens", "stream", "presence_penalty", "frequency_penalty",
		"repetition_penalty", "min_p", "top_p", "top_k", "seed", "stop", "reasoning_effort", "logit_bias",
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

// pinnedChutesPlan builds the provider request for one chat-completion call.
func pinnedChutesPlan(body orderedNodeJSON, directories startup.UserDirectories) (*outbound.Request, *pinnedChatCompletionFailure) {
	secret, err := pinnedReadSecret(directories, pinnedChutesSecretKey, pinnedSecretID(body))
	if err != nil {
		return nil, pinnedChutesCatchFailure()
	}
	if !pinnedJSTruthy(secret) {
		// :1510-1513 -- `if (!apiKey) return response.status(400).send({error:true})`.
		return nil, pinnedChatCompletionJSONFailure(http.StatusBadRequest, pinnedChatCompletionErrorFlag())
	}
	keyText, isString := secret.stringValue()
	if !isString {
		keyText = pinnedClaudeJSString(secret)
	}
	payload, failure := pinnedChutesPayload(body)
	if failure != nil {
		return nil, failure
	}
	encoded, encodeErr := marshalOrderedNodeJSON(payload)
	if encodeErr != nil {
		return nil, pinnedChutesCatchFailure()
	}
	headers := map[string]string{
		"content-type":    "application/json",
		"authorization":   "Bearer " + keyText,
		"accept":          "*/*",
		"accept-encoding": "gzip, deflate, br",
		"user-agent":      "node-fetch",
		"content-length":  strconv.Itoa(len(encoded)),
	}
	endpointURL := pinnedChutesBaseURL() + "/chat/completions"
	parsedEndpoint, parseErr := url.Parse(endpointURL)
	if parseErr != nil || parsedEndpoint.Host == "" {
		return nil, pinnedChutesCatchFailure()
	}
	requestHeaders := pinnedChatCompletionRequestFraming(headers, parsedEndpoint)
	return &outbound.Request{URL: endpointURL, Method: http.MethodPost, Headers: requestHeaders, Body: encoded}, nil
}

// pinnedChutesProjectModels is the status projection at :2092-2108: keep only models with a truthy `id`,
// and when both `pricing.prompt` and `pricing.completion` are defined, add `input`/`output` inside the
// same pricing object, after the provider's own members.
func pinnedChutesProjectModels(data orderedNodeJSON) orderedNodeJSON {
	if data.kind != 'o' {
		return data
	}
	listNode, exists := data.member("data")
	if !exists || listNode.kind != 'a' {
		return data
	}
	projected := nodeArray()
	for _, model := range listNode.array {
		if model.kind != 'o' {
			// `model?.id` is undefined for a non-object entry, which the filter drops.
			continue
		}
		id, hasID := model.member("id")
		if !hasID || !pinnedJSTruthy(id) {
			continue
		}
		replacement := model
		if pricing, hasPricing := model.member("pricing"); hasPricing && pricing.kind == 'o' {
			prompt, hasPrompt := pricing.member("prompt")
			completion, hasCompletion := pricing.member("completion")
			if hasPrompt && hasCompletion && !prompt.isUndefined() && !completion.isUndefined() {
				augmented := nodeObject()
				for _, entry := range pricing.object {
					augmented.setMember(entry.key, entry.value)
				}
				augmented.setMember("input", prompt)
				augmented.setMember("output", completion)
				rebuilt := nodeObject()
				for _, entry := range model.object {
					if entry.key == "pricing" {
						rebuilt.setMember("pricing", augmented)
						continue
					}
					rebuilt.setMember(entry.key, entry.value)
				}
				replacement = rebuilt
			}
		}
		projected.array = append(projected.array, replacement)
	}
	result := nodeObject()
	for _, entry := range data.object {
		if entry.key == "data" {
			result.setMember("data", projected)
			continue
		}
		result.setMember(entry.key, entry.value)
	}
	return result
}

// serveChutesChatCompletionStatus is the CHUTES arm of the status matrix (:1809-1811 + the shared GET at
// :2072-2082 + the chutes projection at :2092-2108). The key comes from readSecret only; a truthy
// reverse_proxy only suppresses the missing-key 400 (the shared guard at :2067), it does NOT move the URL.
func (runtime *accountRuntime) serveChutesChatCompletionStatus(w http.ResponseWriter, request *http.Request, body orderedNodeJSON, directories startup.UserDirectories) {
	errorOnly := nodeObject()
	errorOnly.setMember("error", nodeBool(true))
	secret, secretErr := pinnedReadSecret(directories, pinnedChutesSecretKey, pinnedSecretID(body))
	if secretErr != nil {
		searchJSON(w, errorOnly)
		return
	}
	key, keyErr := pinnedJSStringValue(secret)
	if keyErr != nil {
		searchJSON(w, errorOnly)
		return
	}
	reverseProxyTruthy := false
	if reverseProxy, exists := body.member("reverse_proxy"); exists && pinnedJSTruthy(reverseProxy) {
		reverseProxyTruthy = true
	}
	if key == "" && !reverseProxyTruthy {
		pinnedChatCompletionMissingKeyRefusal(w)
		return
	}
	headers := map[string]string{"authorization": "Bearer " + key}
	response, fetchErr := searchFetch(request.Context(), searchRequest{
		Method:  http.MethodGet,
		URL:     pinnedChutesStatusURL(),
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
	searchJSON(w, pinnedChutesProjectModels(data))
}
