package server

// AZURE_OPENAI, chat_completion_source: 'azure_openai' (src/endpoints/backends/chat-completions.js:1687
// sendAzureOpenAIRequest, dispatched at :2272), and its own /status arm at :1934-2011.
//
// AN OWN TRANSFORM, NOT THE SHARED PATH, and the reason is visible in the first line of the pinned
// function: the provider URL is CALLER DATA. The pinned server has NO API_AZURE_OPENAI constant
// (src/constants.js carries only CHAT_COMPLETION_SOURCES.AZURE_OPENAI at :209 and the AZURE_OPENAI_KEYS
// allow-list at :440), so `azure_base_url`, `azure_deployment_name` and `azure_api_version` arrive in the
// request body and are composed into
//
//	url = new URL(`/openai/deployments/${azure_deployment_name}/chat/completions`, azure_base_url)
//	url.searchParams.set('api-version', azure_api_version)
//
// A leading-slash path REPLACES the base's own path and drops its query and fragment, so a base such as
// https://host/v1 contributes only its origin. The pinned FRONTEND default for that member is the EMPTY
// STRING (public/scripts/openai.js:470 `azure_base_url: ''`; public/index.html:3974 carries only a
// placeholder), which is why a missing base is the 400 below rather than a request to a built-in host.
//
// THE SEAM IS THEREFORE A DIFFERENT KIND from every other source in this package.
// GOTAVERN_AZURE_OPENAI_CHAT_URL has no provider literal to default to: its default is that pinned
// frontend default, `""`, which means "use the request's own azure_base_url", and when it is SET it
// REPLACES the resolved base URL so a test can aim this source at a peer without depending on the body.
// The scenarios do not need it -- they carry the recording peer in `azure_base_url`, exactly as the custom
// and reverse_proxy scenarios do -- so no fixture records a seam literal for this source, and the default
// is asserted as a LABELLED DERIVATION from the pinned frontend default rather than from a capture
// (TestChatCompletionAzureOpenAISeamDefault).
//
// WHAT THE SHARED PATH WOULD NOT REPRODUCE (each is a folded member with a plan-level assertion):
//   - the body is built from AZURE_OPENAI_KEYS (src/constants.js:440) IN THE CONSTANT'S ORDER, not in the
//     request's order, and `model` is NOT in that list: the deployment name in the URL is the model, so the
//     provider body carries no `model` member at all. `top_k`, `prompt` and `user` are likewise absent, and
//     there is NO text-completion prompt conversion (`isTextCompletion` is never consulted).
//   - json_schema becomes {type:'json_schema', json_schema:{name, strict: strict ?? true, schema: <value>}}
//     (:1713-1722): NO `description` member, and `strict` BEFORE `schema`. The `value` is the
//     flattenSchema copy the generate route already made at :2255-2257.
//   - `logprobs` as a NUMBER > 0 becomes `top_logprobs:<n>` plus `logprobs:true` (:1725-1728), with
//     top_logprobs appended after the keys block, i.e. AFTER `response_format` when a schema was folded.
//   - `reasoning_effort` is ASSIGNED UNCONDITIONALLY (:1731-1733): the value is OPENAI_FIXED_REASONING_EFFORT
//     for the model, else OPENAI_REASONING_EFFORT_MAP[effort] ('min' -> 'minimal'), else the raw effort --
//     and `undefined` for a model outside OPENAI_REASONING_EFFORT_MODELS, which JSON.stringify DROPS. So a
//     model outside the list never sends the member even when the request carries one, and a fixed-effort
//     model sends the fixed value joining the object at the END when the request carried none.
//   - the credential header is `api-key`, NOT `Authorization: Bearer` (:1741-1744).
//   - response: a 2xx body is parsed and passed through; a non-2xx answers **500** -- not the provider's
//     status, and not the shared {error:{message},quota_error} envelope -- with
//     `tryParse(text) || {error:{message: statusText || 'Unknown error occurred'}}`; a stream is piped
//     through the shared forwardFetchResponse; anything thrown is 500 {error:{message}}.
//   - the missing-configuration refusal is 400 with a LONG message (:1691-1697), not the shared
//     `{error:true}`.
//
// /status (:1934) IS NOT THE SHARED STATUS TAIL. Every path of that arm returns, so the shared
// `!apiKey && !reverse_proxy` guard, the single `urlJoin(apiUrl,'/models')` fetch and the
// `{error:true,data:{data:[]}}` envelope are never reached for this source. The arm instead: refuses 400
// {error:true, message:'Azure configuration is incomplete.'} when the key, base URL, deployment or api
// version is missing (and never consults reverse_proxy, which this source does not support at all); GETs
// `/openai/models?api-version=` with `api-key` + `Accept: application/json`; on a non-2xx ECHOES the
// provider's status with a mapped message (400/401/403/404 have pinned wording, everything else
// `Azure Models endpoint error: <statusText>`); then POSTs a fixed probe
// `{messages:[{role:'user',content:'Say word Hi'}],stream:false,max_completion_tokens:5}` whose response
// `model` becomes `{data:[{id:<model>}]}` -- or `{data:[]}` when the probe body has no truthy `model` or is
// not JSON at all. A thrown fetch is 500 {error:true, message:'Failed to connect to the Azure endpoint.'}.
// The probe POST's STATUS IS NOT CHECKED: a 401 with a JSON body simply has no `model` and answers
// {data:[]}.
//
// NOT COVERED, stated rather than silently different:
//   - a THROWN fetch on /generate answers 500 {"error":{message, ...error}} (:1768-1773). GoTavern answers
//     the same status and envelope with the transport message, but the `...error` spread's own enumerable
//     members (a Node system error carries code/errno/syscall) are not reproduced. No recording exists:
//     the provider-wire harness has no closed-port mode.
//   - a 2xx with a NON-JSON body throws out of fetchResponse.json() and is answered by the same catch with
//     Node's JSON.parse wording. GoTavern answers 500 with the same envelope and its own decode message;
//     the TEXT differs and there is no recording for it.
//   - `custom_prompt_post_processing` (:2246-2253) is applied by the GENERATE route before this branch for
//     EVERY source, and the Go route does not implement it. That is a route-level gap shared with every
//     source rather than one introduced here, so no azure scenario sends that member.

import (
	"errors"
	"io"
	"net/http"
	"net/url"
	"strconv"

	"github.com/cocokoishi/gotavern/internal/outbound"
	"github.com/cocokoishi/gotavern/internal/startup"
)

const (
	// public/scripts/openai.js:470 -- the pinned FRONTEND default for `azure_base_url`, which is the only
	// "literal" this source has. There is no provider constant: the base URL is caller data.
	pinnedAzureOpenAIBaseURLDefault = ""
	pinnedAzureOpenAISeamEnv        = "GOTAVERN_AZURE_OPENAI_CHAT_URL"
	// SECRET_KEYS.AZURE_OPENAI (src/endpoints/secrets.js:65).
	pinnedAzureOpenAISecretKey = "api_key_azure_openai"
	chatCompletionSourceAzure  = "azure_openai"

	// :1694 -- one long pinned sentence, not the shared {error:true}.
	pinnedAzureOpenAIIncompleteMessage = "Azure OpenAI configuration is incomplete. Please provide Base URL, Deployment Name, API Version, and API Key in the connection settings."
	// :1941 -- the status arm's own, SHORTER wording for the same condition.
	pinnedAzureOpenAIStatusIncompleteMessage = "Azure configuration is incomplete."
	// :2010 -- the status arm's catch.
	pinnedAzureOpenAIStatusConnectMessage = "Failed to connect to the Azure endpoint."
	// :1981 -- the status arm's fixed probe.
	pinnedAzureOpenAIStatusProbeContent = "Say word Hi"
)

// pinnedAzureOpenAIKeys is AZURE_OPENAI_KEYS (src/constants.js:440). Note what is ABSENT: `model` (the
// deployment in the URL is the model), `top_k`, `prompt` and `user`.
var pinnedAzureOpenAIKeys = []string{
	"messages", "temperature", "frequency_penalty", "presence_penalty", "top_p", "max_tokens",
	"max_completion_tokens", "stream", "logit_bias", "stop", "n", "logprobs", "seed", "tools",
	"tool_choice", "reasoning_effort",
}

// pinnedAzureOpenAIReasoningModels is OPENAI_REASONING_EFFORT_MODELS (src/constants.js:461-495).
var pinnedAzureOpenAIReasoningModels = map[string]bool{
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

// pinnedAzureOpenAIFixedReasoningEffort is OPENAI_FIXED_REASONING_EFFORT (src/constants.js:505). It is
// consulted BEFORE the map, so `high` on this model sends `medium`.
var pinnedAzureOpenAIFixedReasoningEffort = map[string]string{
	"gpt-5.3-chat-latest": "medium",
}

// pinnedAzureOpenAIReasoningEffortMap is OPENAI_REASONING_EFFORT_MAP (src/constants.js:497). Not identity.
var pinnedAzureOpenAIReasoningEffortMap = map[string]string{"min": "minimal"}

// pinnedAzureOpenAIBaseNode is the `azure_base_url` operand of the pinned URL composition, with the seam
// applied. The pinned frontend default is "" (public/scripts/openai.js:470), so an absent member and the
// unset seam agree, and the truthiness check that follows answers the pinned 400 for both.
func pinnedAzureOpenAIBaseNode(body orderedNodeJSON) orderedNodeJSON {
	if override := sdSeamURL(pinnedAzureOpenAISeamEnv, pinnedAzureOpenAIBaseURLDefault); override != "" {
		return nodeString(override)
	}
	if value, exists := body.member("azure_base_url"); exists {
		return value
	}
	return nodeUndefined()
}

// pinnedAzureOpenAIChatPath is the pinned template `/openai/deployments/${azure_deployment_name}/chat/completions`
// with the deployment interpolated RAW: the WHATWG URL parser percent-encodes what the path set escapes
// (a space becomes %20), which Go's url.URL.String does as well through its encodePath escaping.
func pinnedAzureOpenAIChatPath(deployment string) string {
	return "/openai/deployments/" + deployment + "/chat/completions"
}

// pinnedAzureOpenAIResolveEndpoint is the pinned pair
//
//	const url = new URL(path, azure_base_url);
//	url.searchParams.set('api-version', azure_api_version);
//
// The base must be an absolute http(s) URL or `new URL` throws, which the pinned catch answers with 500;
// ok=false is that throw. A leading-slash path replaces the base's path and drops its query and fragment.
// The query is serialized the way URLSearchParams does (a space becomes '+'), which is what
// searchFormEncode reproduces.
func pinnedAzureOpenAIResolveEndpoint(base, path, version string) (string, bool) {
	normalized, ok := pinnedJSURLString(nodeString(base))
	if !ok {
		return "", false
	}
	parsed, parseErr := url.Parse(normalized)
	if parseErr != nil || parsed.Host == "" {
		return "", false
	}
	parsed.Path = path
	parsed.RawPath = ""
	parsed.RawQuery = "api-version=" + searchFormEncode(version)
	parsed.Fragment = ""
	parsed.RawFragment = ""
	return parsed.String(), true
}

// pinnedAzureOpenAIByTheKeysList is the pinned `for (const key of AZURE_OPENAI_KEYS) if (Object.hasOwn(
// request.body, key))` loop: membership AND order both come from the constant.
func pinnedAzureOpenAIByTheKeysList(body orderedNodeJSON) orderedNodeJSON {
	payload := nodeObject()
	for _, key := range pinnedAzureOpenAIKeys {
		if value, exists := body.member(key); exists {
			payload.setMember(key, value)
		}
	}
	return payload
}

// pinnedAzureOpenAIReasoningEffort is :1731-1733. present=false is the `undefined` arm, which JSON.stringify
// drops -- the fold that stops a non-reasoning model from forwarding the member at all.
func pinnedAzureOpenAIReasoningEffort(body orderedNodeJSON) (orderedNodeJSON, bool) {
	model, isString := sdBodyMember(body, "model").stringValue()
	if !isString || !pinnedAzureOpenAIReasoningModels[model] {
		return orderedNodeJSON{}, false
	}
	if fixed, known := pinnedAzureOpenAIFixedReasoningEffort[model]; known {
		return nodeString(fixed), true
	}
	effort := sdBodyMember(body, "reasoning_effort")
	if text, effortIsString := effort.stringValue(); effortIsString {
		if mapped, known := pinnedAzureOpenAIReasoningEffortMap[text]; known {
			return nodeString(mapped), true
		}
	}
	if effort.isUndefined() {
		return orderedNodeJSON{}, false
	}
	return effort, true
}

// pinnedAzureOpenAIPayload builds the pinned apiRequestBody (:1705-1733), in the pinned insertion order:
// the keys block, then response_format, then top_logprobs, then reasoning_effort (which keeps its place in
// the keys block when the request already carried it, and otherwise joins the object at the end).
func pinnedAzureOpenAIPayload(body orderedNodeJSON) orderedNodeJSON {
	payload := pinnedAzureOpenAIByTheKeysList(body)

	if schema, exists := body.member("json_schema"); exists && pinnedJSTruthy(schema) {
		format := nodeObject()
		format.setMember("type", nodeString("json_schema"))
		inner := nodeObject()
		if name, hasName := schema.member("name"); hasName {
			inner.setMember("name", name)
		}
		strict := nodeBool(true)
		if value, hasStrict := schema.member("strict"); hasStrict && !value.isUndefined() && !value.isNull() {
			strict = value
		}
		inner.setMember("strict", strict)
		if value, hasValue := schema.member("value"); hasValue {
			inner.setMember("schema", pinnedFlattenSchema(value))
		}
		format.setMember("json_schema", inner)
		payload.setMember("response_format", format)
	}

	// `typeof apiRequestBody.logprobs === 'number' && apiRequestBody.logprobs > 0` (:1725).
	if logprobs, exists := payload.member("logprobs"); exists && logprobs.kind == 'v' {
		if number, isNumber := logprobs.scalar.(float64); isNumber && number > 0 {
			payload.setMember("top_logprobs", nodeNumber(number))
			payload.setMember("logprobs", nodeBool(true))
		}
	}

	if effort, present := pinnedAzureOpenAIReasoningEffort(body); present {
		payload.setMember("reasoning_effort", effort)
	} else {
		payload.deleteMember("reasoning_effort")
	}
	return payload
}

// pinnedAzureOpenAIIncompleteConfig is :1692-1697: 400 with the long pinned sentence.
func pinnedAzureOpenAIIncompleteConfig() *pinnedChatCompletionFailure {
	errorMember := nodeObject()
	errorMember.setMember("message", nodeString(pinnedAzureOpenAIIncompleteMessage))
	payload := nodeObject()
	payload.setMember("error", errorMember)
	return pinnedChatCompletionJSONFailure(http.StatusBadRequest, payload)
}

// pinnedAzureOpenAICatch is :1768-1773 with the documented limit: the envelope and the 500 are the pinned
// contract, the `...error` spread's members are not reproduced.
func pinnedAzureOpenAICatch(err error) *pinnedChatCompletionFailure {
	message := pinnedChatCompletionTransportMessage(err)
	errorMember := nodeObject()
	errorMember.setMember("message", nodeString(message))
	payload := nodeObject()
	payload.setMember("error", errorMember)
	return pinnedChatCompletionJSONFailure(http.StatusInternalServerError, payload)
}

// pinnedAzureOpenAIStatusFailure is the status arm's 500 (':2010') and its 500 for an unbuildable URL.
func pinnedAzureOpenAIStatusFailure() *pinnedChatCompletionFailure {
	payload := nodeObject()
	payload.setMember("error", nodeBool(true))
	payload.setMember("message", nodeString(pinnedAzureOpenAIStatusConnectMessage))
	return pinnedChatCompletionJSONFailure(http.StatusInternalServerError, payload)
}

// pinnedAzureOpenAIPlan is the plan for the AZURE_OPENAI source.
func pinnedAzureOpenAIPlan(body orderedNodeJSON, directories startup.UserDirectories) (*outbound.Request, *pinnedChatCompletionFailure) {
	baseNode := pinnedAzureOpenAIBaseNode(body)
	deploymentNode := sdBodyMember(body, "azure_deployment_name")
	versionNode := sdBodyMember(body, "azure_api_version")
	apiKey := nodeUndefined()
	if secret, secretErr := pinnedReadSecret(directories, pinnedAzureOpenAISecretKey, pinnedSecretID(body)); secretErr == nil {
		apiKey = secret
	}
	// :1691 -- `!azure_base_url || !azure_deployment_name || !azure_api_version || !apiKey`. There is no
	// reverse_proxy escape: this source does not support one at all.
	if !pinnedJSTruthy(baseNode) || !pinnedJSTruthy(deploymentNode) || !pinnedJSTruthy(versionNode) || !pinnedJSTruthy(apiKey) {
		return nil, pinnedAzureOpenAIIncompleteConfig()
	}
	baseText, _ := pinnedJSStringValue(baseNode)
	deploymentText, _ := pinnedJSStringValue(deploymentNode)
	versionText, _ := pinnedJSStringValue(versionNode)
	endpointURL, endpointOK := pinnedAzureOpenAIResolveEndpoint(baseText, pinnedAzureOpenAIChatPath(deploymentText), versionText)
	if !endpointOK {
		// `new URL` throws inside the pinned try, so this is the catch, not the 400.
		return nil, pinnedAzureOpenAICatch(errors.New("Invalid URL"))
	}
	encoded, encodeErr := marshalOrderedNodeJSON(pinnedAzureOpenAIPayload(body))
	if encodeErr != nil {
		return nil, pinnedAzureOpenAICatch(encodeErr)
	}
	keyText, _ := pinnedJSStringValue(apiKey)
	// :1739-1747 -- Content-Type plus `api-key`. node-fetch adds its own defaults and a Content-Length, and
	// there is NO Authorization header.
	headers := map[string]string{
		"content-type":    "application/json",
		"api-key":         keyText,
		"accept":          "*/*",
		"accept-encoding": "gzip, deflate, br",
		"user-agent":      "node-fetch",
		"content-length":  strconv.Itoa(len(encoded)),
	}
	parsedEndpoint, parseErr := url.Parse(endpointURL)
	if parseErr != nil || parsedEndpoint.Host == "" {
		return nil, pinnedAzureOpenAICatch(errors.New("Invalid URL"))
	}
	requestHeaders := pinnedChatCompletionRequestFraming(headers, parsedEndpoint)
	return &outbound.Request{URL: endpointURL, Method: http.MethodPost, Headers: requestHeaders, Body: encoded}, nil
}

// serveAzureOpenAIChatCompletionResponse is the AZURE_OPENAI response side (:1751-1773): the shared
// forwarder for a stream, the parsed provider body for a 2xx answer, and 500 with the PARSED provider body
// -- or the pinned `{error:{message: statusText}}` fallback when it is not JSON -- for a non-2xx answer.
func serveAzureOpenAIChatCompletionResponse(w http.ResponseWriter, request *http.Request, response *outbound.Response, body orderedNodeJSON) {
	if pinnedChatCompletionStreams(body) {
		forwardPinnedChatCompletionStream(w, request, response)
		return
	}
	defer response.Stream.Close()
	providerBody, readErr := io.ReadAll(response.Stream)
	if readErr != nil && !errors.Is(readErr, io.EOF) {
		failure := pinnedAzureOpenAICatch(readErr)
		respondOrderedNodeJSON(w, failure.status, *failure.payload)
		return
	}
	if response.Status >= 200 && response.Status <= 299 {
		// `await fetchResponse.json()` REJECTS on a body that is not JSON, so the pinned answer is the catch
		// (500) rather than the shared path's 200 {"error":true}.
		parsed, parseErr := decodeOrderedNodeJSON(providerBody)
		if parseErr != nil {
			failure := pinnedAzureOpenAICatch(parseErr)
			respondOrderedNodeJSON(w, failure.status, *failure.payload)
			return
		}
		respondOrderedNodeJSON(w, http.StatusOK, parsed)
		return
	}
	// `tryParse(text) || { error: { message: statusText || 'Unknown error occurred' } }`. tryParse returns
	// undefined for a non-JSON body, and a falsy JSON document (null, false, 0, "") fell through the `||`
	// in the pinned expression too.
	parsed, parseErr := decodeOrderedNodeJSON(providerBody)
	if parseErr != nil || !pinnedJSTruthy(parsed) {
		message := response.Reason
		if message == "" {
			message = "Unknown error occurred"
		}
		errorMember := nodeObject()
		errorMember.setMember("message", nodeString(message))
		payload := nodeObject()
		payload.setMember("error", errorMember)
		respondOrderedNodeJSON(w, http.StatusInternalServerError, payload)
		return
	}
	respondOrderedNodeJSON(w, http.StatusInternalServerError, parsed)
}

// pinnedAzureOpenAIStatusErrorMap is :1951-1956. Only 400/401/403/404 have pinned wording.
func pinnedAzureOpenAIStatusErrorMessage(status int, statusText string) string {
	switch status {
	case http.StatusBadRequest:
		return "API version may be invalid for this resource."
	case http.StatusUnauthorized, http.StatusForbidden:
		return "Invalid API key or insufficient permissions."
	case http.StatusNotFound:
		return "Endpoint URL appears incorrect (404)."
	}
	return "Azure Models endpoint error: " + statusText
}

// serveAzureOpenAIChatCompletionStatus is the AZURE_OPENAI arm of the pinned status matrix (:1934-2011).
// It is NOT the shared tail: every path returns, the key is read with readSecret only (reverse_proxy is
// never consulted), and the arm makes TWO provider calls -- GET /openai/models and a fixed POST probe.
func (runtime *accountRuntime) serveAzureOpenAIChatCompletionStatus(w http.ResponseWriter, request *http.Request, body orderedNodeJSON, directories startup.UserDirectories) {
	baseNode := pinnedAzureOpenAIBaseNode(body)
	deploymentNode := sdBodyMember(body, "azure_deployment_name")
	versionNode := sdBodyMember(body, "azure_api_version")
	key := ""
	if keyNode, secretErr := pinnedReadSecret(directories, pinnedAzureOpenAISecretKey, pinnedSecretID(body)); secretErr == nil {
		if text, keyErr := pinnedJSStringValue(keyNode); keyErr == nil {
			key = text
		}
	}
	if key == "" || !pinnedJSTruthy(baseNode) || !pinnedJSTruthy(deploymentNode) || !pinnedJSTruthy(versionNode) {
		payload := nodeObject()
		payload.setMember("error", nodeBool(true))
		payload.setMember("message", nodeString(pinnedAzureOpenAIStatusIncompleteMessage))
		respondOrderedNodeJSON(w, http.StatusBadRequest, payload)
		return
	}
	baseText, _ := pinnedJSStringValue(baseNode)
	deploymentText, _ := pinnedJSStringValue(deploymentNode)
	versionText, _ := pinnedJSStringValue(versionNode)
	modelsURL, modelsOK := pinnedAzureOpenAIResolveEndpoint(baseText, "/openai/models", versionText)
	chatURL, chatOK := pinnedAzureOpenAIResolveEndpoint(baseText, pinnedAzureOpenAIChatPath(deploymentText), versionText)
	if !modelsOK || !chatOK {
		failure := pinnedAzureOpenAIStatusFailure()
		respondOrderedNodeJSON(w, failure.status, *failure.payload)
		return
	}

	// ---- A) GET /models: endpoint + api key + api version sanity check ----
	modelsResponse, modelsErr := searchFetch(request.Context(), searchRequest{
		Method:  http.MethodGet,
		URL:     modelsURL,
		Headers: map[string]string{"api-key": key, "accept": "application/json"},
	})
	if modelsErr != nil {
		failure := pinnedAzureOpenAIStatusFailure()
		respondOrderedNodeJSON(w, failure.status, *failure.payload)
		return
	}
	if !sdResponseOK(modelsResponse) {
		// The provider's status is ECHOED, with the pinned message for a mapped status.
		payload := nodeObject()
		payload.setMember("error", nodeBool(true))
		payload.setMember("message", nodeString(pinnedAzureOpenAIStatusErrorMessage(modelsResponse.Status, modelsResponse.Reason)))
		respondOrderedNodeJSON(w, modelsResponse.Status, payload)
		return
	}

	// ---- B) POST the fixed probe; its answer's `model` is the reply ----
	probe := nodeObject()
	messages := nodeArray()
	message := nodeObject()
	message.setMember("role", nodeString("user"))
	message.setMember("content", nodeString(pinnedAzureOpenAIStatusProbeContent))
	messages.array = append(messages.array, message)
	probe.setMember("messages", messages)
	probe.setMember("stream", nodeBool(false))
	probe.setMember("max_completion_tokens", nodeNumber(5))
	encoded, encodeErr := marshalOrderedNodeJSON(probe)
	if encodeErr != nil {
		failure := pinnedAzureOpenAIStatusFailure()
		respondOrderedNodeJSON(w, failure.status, *failure.payload)
		return
	}
	probeResponse, probeErr := searchFetch(request.Context(), searchRequest{
		Method:  http.MethodPost,
		URL:     chatURL,
		Headers: map[string]string{"api-key": key, "content-type": "application/json", "accept": "application/json"},
		Body:    encoded,
	})
	if probeErr != nil {
		failure := pinnedAzureOpenAIStatusFailure()
		respondOrderedNodeJSON(w, failure.status, *failure.payload)
		return
	}
	// `modelRequest.json()` is wrapped in a try that substitutes {raw: ...}, so a non-JSON probe answer costs
	// the model id and not the request; the probe's STATUS is not examined either.
	emptyData := nodeObject()
	emptyData.setMember("data", nodeArray())
	parsed, parseErr := decodeOrderedNodeJSON(probeResponse.Body)
	if parseErr != nil {
		respondOrderedNodeJSON(w, http.StatusOK, emptyData)
		return
	}
	modelID, modelled := sdMemberOf(parsed, "model")
	if !modelled || !pinnedJSTruthy(modelID) {
		// :1998-2002 -- "Keep a benign success to avoid UX disruption in the UI".
		respondOrderedNodeJSON(w, http.StatusOK, emptyData)
		return
	}
	detected := nodeObject()
	detected.setMember("id", modelID)
	data := nodeArray()
	data.array = append(data.array, detected)
	payload := nodeObject()
	payload.setMember("data", data)
	respondOrderedNodeJSON(w, http.StatusOK, payload)
}
