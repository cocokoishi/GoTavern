package server

// NANOGPT, chat_completion_source: 'nanogpt' (src/endpoints/backends/chat-completions.js:2476).
//
// The branch is the SHARED openai-compatible path with FOUR foldings, three of which are the reason this
// source needs its own tests rather than a header list:
//
//	headers['X-Provider'] = nanogpt_provider                      when the member is truthy
//	headers['X-Billing-Mode'] = 'paygo'; bodyParams.billing_mode = 'paygo'   when nanogpt_payg_override
//	model += ':online'   when enable_web_search && !/:online$/.test(model)   <-- the model STRING MUTATION
//	bodyParams.reasoning = { effort: NANOGPT_REASONING_EFFORT_MAP[reasoning_effort] }
//
// The `:online` rule is a NEGATIVE test: the suffix is appended only when the model does not already end in
// it, so an implementation that appends unconditionally satisfies the appending scenario and fails the
// already-suffixed one. Both scenarios exist for that reason.
//
// NOT COVERED, and deliberately: the config-gated `cache_control` member
// (`enableSystemPromptCache && /(?:^|\/)claude[-_]/.test(model)`) is default-OFF in the pinned defaults, so
// it cannot be observed without turning the config on for both legs; it is named here rather than
// implemented from a reading. Turning it on is a separate increment with its own config seam.
//
// `/status` (:1817) is a DIFFERENT route with its own arm: the same literal and secret, no header, and
// `queryParams = { detailed: true }`, so the models URL is `<base>/models?detailed=true`. Its key comes from
// readSecret only -- the missing-key 400 consults reverse_proxy, but the arm never assigns from
// proxy_password (the same shape as GROQ and SILICONFLOW; CLAUDE and MISTRALAI differ).
//
// FIXTURE NOTE for a reader who finds two nanogpt fixtures: `tests/oracle/sillytavern-1.19.0-nanogpt.json`
// covers the NanoGPT CREDITS and MODELS routes (`/api/nanogpt/*`) from an earlier lane. This source's chat
// transport and its chat-completions `/status` arm are recorded in the PROVIDER-WIRE fixture, because they
// are provider traffic from `/api/backends/chat-completions/*` and share that harness's peer and seams.

import (
	"net/http"

	"github.com/cocokoishi/gotavern/internal/startup"
)

const (
	pinnedNanoGPTAPIURL    = "https://nano-gpt.com/api/v1"
	pinnedNanoGPTSeamEnv   = "GOTAVERN_NANOGPT_CHAT_URL"
	pinnedNanoGPTSecretKey = "api_key_nanogpt"
	chatCompletionSourceNG = "nanogpt"
)

// pinnedNanoGPTReasoningEffortMap is NANOGPT_REASONING_EFFORT_MAP (src/constants.js:509). The mapping is NOT
// identity: 'medium' becomes 'low' and 'max' becomes 'high'.
var pinnedNanoGPTReasoningEffortMap = map[string]string{
	"min":    "none",
	"low":    "minimal",
	"medium": "low",
	"high":   "medium",
	"max":    "high",
}

// pinnedNanoGPTBaseURL is the pinned literal, replaceable only by the test seam.
func pinnedNanoGPTBaseURL() string {
	return sdSeamURL(pinnedNanoGPTSeamEnv, pinnedNanoGPTAPIURL)
}

// pinnedNanoGPTModel applies the `:online` rule: append only when enable_web_search is truthy AND the model
// does not already end in the suffix. It returns the model the request should carry.
func pinnedNanoGPTModel(body orderedNodeJSON) (string, bool) {
	modelNode, exists := body.member("model")
	if !exists {
		return "", false
	}
	model, ok := modelNode.scalar.(string)
	if !ok {
		return "", false
	}
	enable, hasEnable := body.member("enable_web_search")
	if !hasEnable || !pinnedJSTruthy(enable) {
		return model, false
	}
	if len(model) >= len(":online") && model[len(model)-len(":online"):] == ":online" {
		return model, false
	}
	return model + ":online", true
}

// serveNanoGPTChatCompletionStatus is the NANOGPT arm of the pinned status matrix (:1817).
func (runtime *accountRuntime) serveNanoGPTChatCompletionStatus(w http.ResponseWriter, request *http.Request, body orderedNodeJSON, directories startup.UserDirectories) {
	errorOnly := nodeObject()
	errorOnly.setMember("error", nodeBool(true))
	keyNode, secretErr := pinnedReadSecret(directories, pinnedNanoGPTSecretKey, pinnedSecretID(body))
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
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	headers := map[string]string{"authorization": "Bearer " + key}
	response, fetchErr := searchFetch(request.Context(), searchRequest{
		Method:  http.MethodGet,
		URL:     pinnedNanoGPTStatusURL(),
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

// pinnedNanoGPTStatusURL is the models URL the status arm fetches: `urlJoin(apiUrl,'/models')` with
// `detailed=true` appended (:1817, :2073-2074).
func pinnedNanoGPTStatusURL() string {
	return sdURLJoin(pinnedNanoGPTBaseURL(), "/models") + "?detailed=true"
}
