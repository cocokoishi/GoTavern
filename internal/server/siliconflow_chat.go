package server

// SILICONFLOW, chat_completion_source: 'siliconflow' (src/endpoints/backends/chat-completions.js:2566).
//
// The branch is the SHARED openai-compatible path with two differences, and the first is the trap:
//
//	apiUrl = body.siliconflow_endpoint === SILICONFLOW_ENDPOINT.CN ? API_SILICONFLOW_CN : API_SILICONFLOW
//	apiKey = readSecret(.., SECRET_KEYS.SILICONFLOW, ..); headers = {}; bodyParams = {}
//
// The ENDPOINT is chosen by a REQUEST BODY FIELD, not by the caller's environment, so this source has TWO
// literals and TWO seams. They are asserted separately (`TestChatCompletionSiliconFlowSeamDefaults`); folding
// them into one seam would make a request to the wrong region pass whenever the recording peer accepted both.
//
// The second difference is `setJsonObjectFormat` (:214), which is NOT `response_format = {type:'json_schema'}`
// like the other sources: it sets `{type:'json_object'}` AND PUSHES a synthesized user message carrying the
// schema, so the compared body's message array is longer than the request's. The pinned text is
// `JSON schema for the response:\n` + JSON.stringify(schema.value, null, 4), reproduced with the same
// 4-space pretty printer the rest of this package uses.
//
// `/status` (:2012) picks the same pair of literals from the SAME body field and appends
// `?type=text&sub_type=chat` to `urlJoin(apiUrl, '/models')`. It reads the key with readSecret only: the
// missing-key 400 consults `reverse_proxy`, but this arm never assigns the key from `proxy_password`, so a
// proxied siliconflow status request still reads the secret (unlike CLAUDE and MISTRALAI, which do both).

import (
	"net/http"

	"github.com/cocokoishi/gotavern/internal/outbound"
	"github.com/cocokoishi/gotavern/internal/startup"
)

const (
	pinnedSiliconFlowAPIURL      = "https://api.siliconflow.com/v1"
	pinnedSiliconFlowCNAPIURL    = "https://api.siliconflow.cn/v1"
	pinnedSiliconFlowSeamEnv     = "GOTAVERN_SILICONFLOW_CHAT_URL"
	pinnedSiliconFlowCNSeamEnv   = "GOTAVERN_SILICONFLOW_CN_CHAT_URL"
	pinnedSiliconFlowSecretKey   = "api_key_siliconflow"
	pinnedSiliconFlowCNEndpoint  = "cn"
	chatCompletionSourceSiliconF = "siliconflow"
)

// pinnedSiliconFlowBaseURL implements the body-driven endpoint choice. Each literal has its own seam so the
// recorded differential can aim either leg at the peer without one region standing in for the other.
func pinnedSiliconFlowBaseURL(body orderedNodeJSON) string {
	if endpoint, exists := body.member("siliconflow_endpoint"); exists {
		if text, ok := endpoint.scalar.(string); ok && text == pinnedSiliconFlowCNEndpoint {
			return sdSeamURL(pinnedSiliconFlowCNSeamEnv, pinnedSiliconFlowCNAPIURL)
		}
	}
	return sdSeamURL(pinnedSiliconFlowSeamEnv, pinnedSiliconFlowAPIURL)
}

// pinnedSetJsonObjectFormat is setJsonObjectFormat (:214): `response_format = {type:'json_object'}` plus a
// synthesized user message whose content is the schema pretty-printed with JSON.stringify(.., null, 4).
func pinnedSetJsonObjectFormat(bodyParams *orderedNodeJSON, body *orderedNodeJSON, jsonSchema orderedNodeJSON) error {
	format := nodeObject()
	format.setMember("type", nodeString("json_object"))
	bodyParams.setMember("response_format", format)

	pretty := "undefined"
	if value, exists := jsonSchema.member("value"); exists {
		encoded, encodeErr := marshalPrettyOrderedNodeJSON(value, 0)
		if encodeErr != nil {
			return encodeErr
		}
		pretty = string(encoded)
	}
	message := nodeObject()
	message.setMember("role", nodeString("user"))
	message.setMember("content", nodeString("JSON schema for the response:\n"+pretty))

	messages, exists := body.member("messages")
	if !exists || messages.kind != 'a' {
		return nil
	}
	messages.array = append(messages.array, message)
	body.setMember("messages", messages)
	return nil
}

// pinnedSiliconFlowStatusURL is the models URL the /status arm fetches. It is a separate function so the
// QUERY, which a seam assertion cannot see and a drop would not fail any recorded field's construction, is
// directly testable (TestChatCompletionSiliconFlowStatusURLCarriesTheQuery). `?type=text&sub_type=chat` is
// appended in the pinned order (:2018, :2073-2074).
func pinnedSiliconFlowStatusURL(body orderedNodeJSON) string {
	return sdURLJoin(pinnedSiliconFlowBaseURL(body), "/models") + "?type=text&sub_type=chat"
}

// serveSiliconFlowChatCompletionStatus is the SILICONFLOW arm of the pinned status matrix (:2012): the shared
// status tail with the body-chosen literal, `api_key_siliconflow`, no header of its own, and the query
// `?type=text&sub_type=chat` on the models URL.
func (runtime *accountRuntime) serveSiliconFlowChatCompletionStatus(w http.ResponseWriter, request *http.Request, body orderedNodeJSON, directories startup.UserDirectories) {
	errorOnly := nodeObject()
	errorOnly.setMember("error", nodeBool(true))
	keyNode, secretErr := pinnedReadSecret(directories, pinnedSiliconFlowSecretKey, pinnedSecretID(body))
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
	if key == "" && !reverseProxyTruthy {
		pinnedChatCompletionMissingKeyRefusal(w)
		return
	}
	headers := map[string]string{"authorization": "Bearer " + key}
	response, fetchErr := searchFetch(request.Context(), searchRequest{
		Method:  http.MethodGet,
		URL:     pinnedSiliconFlowStatusURL(body),
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

// pinnedSiliconFlowChatPlan is chat-completions.js:2566-2574's SILICONFLOW arm plus the shared tail. Both
// the endpoint and the fold are the source's own: the endpoint is chosen from a REQUEST BODY FIELD, and the
// fold is setJsonObjectFormat, which appends a synthesized schema message rather than setting a json_schema
// response_format.
func pinnedSiliconFlowChatPlan(request chatCompletionRequest) (*outbound.Request, *pinnedChatCompletionFailure) {
	body := request.body
	apiKey, secretErr := pinnedReadSecret(request.directories, pinnedSiliconFlowSecretKey, pinnedSecretID(body))
	if secretErr != nil {
		return nil, pinnedChatCompletionTransportFailure(secretErr)
	}
	bodyParams := nodeObject()
	if schema, exists := body.member("json_schema"); exists && pinnedJSTruthy(schema) {
		// The fold returns an error only when the schema cannot be pretty-printed, which pinned cannot
		// reach because JSON.stringify of a parsed body always succeeds.
		if foldErr := pinnedSetJsonObjectFormat(&bodyParams, &body, schema); foldErr != nil {
			return nil, pinnedChatCompletionTransportFailure(foldErr)
		}
	}
	return pinnedChatCompletionAssemble(chatCompletionSourceSiliconF, request, chatCompletionPlanInputs{
		body:          body,
		apiURL:        pinnedSiliconFlowBaseURL(body),
		apiKey:        apiKey,
		customHeaders: nodeObject(),
		bodyParams:    bodyParams,
	})
}
