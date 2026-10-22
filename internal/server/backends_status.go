package server

// Pinned /api/backends/chat-completions/status, from
// src/endpoints/backends/chat-completions.js:1778.
//
// IMPLEMENTED: the CUSTOM source. The pinned tail joins urlJoin(custom_url, "/models"), GETs it with
// `Authorization: Bearer <custom key>` plus any custom_include_headers, passes an OK body through
// unchanged, answers `{ error: true, data: { data: [] } }` for a non-OK response, and `{ error: true }`
// when the fetch or the key read throws.
//
// NOT IMPLEMENTED: every other source in the pinned 380-line provider matrix answers 501 (rule 17), so
// an unimplemented source stays distinguishable from pinned's 400 unknown-source answer. The chat
// completions row keeps that visible.
//
// Evidence: tools/probe-backends.mjs records the `status.custom.*` scenarios in
// tests/oracle/sillytavern-1.19.0-backends.json; backends_test.go replays them.

import (
	"net/http"
	"strings"

	"github.com/cocokoishi/gotavern/internal/startup"
)

func init() {
	// Registration happens in registerBackendsRoutes; nothing to add here.
}

// serveBackendsChatCompletionStatus is chat-completions.js:1778: the custom and openrouter branches, and 501
// for every other source in the pinned provider matrix.
func (runtime *accountRuntime) serveBackendsChatCompletionStatus(w http.ResponseWriter, request *http.Request) {
	_, directories, ok := runtime.sdUser(w, request)
	if !ok {
		return
	}
	body, ok := runtime.sdRequestBody(w, request)
	if !ok {
		return
	}
	source, _ := sdBodyMember(body, "chat_completion_source").stringValue()
	if source == chatCompletionSourceOpenRtr {
		runtime.serveOpenRouterChatCompletionStatus(w, request, body, directories)
		return
	}
	if source == chatCompletionSourceClaude {
		runtime.serveClaudeChatCompletionStatus(w, body)
		return
	}
	if source == chatCompletionSourceMistral {
		runtime.serveMistralChatCompletionStatus(w, request, body, directories)
		return
	}
	if source == chatCompletionSourceSiliconF {
		runtime.serveSiliconFlowChatCompletionStatus(w, request, body, directories)
		return
	}
	if source == chatCompletionSourceNG {
		runtime.serveNanoGPTChatCompletionStatus(w, request, body, directories)
		return
	}
	if source == chatCompletionSourceWAI {
		runtime.serveWorkersAIChatCompletionStatus(w, request, body, directories)
		return
	}
	if source == chatCompletionSourcePollinations {
		runtime.servePollinationsChatCompletionStatus(w, request, body, directories)
		return
	}
	if source == chatCompletionSourceGroq {
		runtime.serveGroqChatCompletionStatus(w, request, body, directories)
		return
	}
	if source != "custom" {
		serveStatusText(w, http.StatusNotImplemented)
		return
	}
	errorOnly := nodeObject()
	errorOnly.setMember("error", nodeBool(true))
	customURLNode, exists := body.member("custom_url")
	if !exists {
		// `urlJoin(undefined, "/models")` throws, and the pinned catch answers { error: true }.
		searchJSON(w, errorOnly)
		return
	}
	customURL, stringErr := pinnedJSStringValue(customURLNode)
	if stringErr != nil {
		searchJSON(w, errorOnly)
		return
	}
	keyNode, secretErr := pinnedReadSecret(directories, "api_key_custom", pinnedSecretID(body))
	if secretErr != nil {
		searchJSON(w, errorOnly)
		return
	}
	key, keyErr := pinnedJSStringValue(keyNode)
	if keyErr != nil {
		searchJSON(w, errorOnly)
		return
	}
	headers := map[string]string{"authorization": "Bearer " + key}
	if includeHeaders, includeExists := body.member("custom_include_headers"); includeExists {
		customHeaders := nodeObject()
		pinnedMergeObjectWithYAML(&customHeaders, includeHeaders)
		for _, entry := range customHeaders.object {
			headerName := strings.ToLower(entry.key)
			headerValue, valueErr := pinnedJSStringValue(entry.value)
			if valueErr != nil {
				searchJSON(w, errorOnly)
				return
			}
			headers[headerName] = headerValue
		}
	}
	response, fetchErr := searchFetch(request.Context(), searchRequest{
		Method:  http.MethodGet,
		URL:     sdURLJoin(customURL, "/models"),
		Headers: headers,
	})
	if fetchErr != nil {
		searchJSON(w, errorOnly)
		return
	}
	if !sdResponseOK(response) {
		failure := nodeObject()
		failure.setMember("error", nodeBool(true))
		data := nodeObject()
		data.setMember("data", nodeArray())
		failure.setMember("data", data)
		searchJSON(w, failure)
		return
	}
	parsed, parsedOK := sdReadJSON(response)
	if !parsedOK {
		searchJSON(w, errorOnly)
		return
	}
	searchJSON(w, parsed)
}

// serveClaudeChatCompletionStatus is the CLAUDE case of the pinned status matrix, and its whole
// content is that THERE IS NO CLAUDE BRANCH in it. chat-completions.js:1787-2065 is a chain of
// `chat_completion_source === ...` arms and CLAUDE is not one of them (it appears only in the
// GENERATE dispatch at :2260), so the chain falls through to its final else:
//
//	:2062-2065  console.warn('This chat completion source is not supported yet.');
//	            return statusResponse.status(400).send({ error: true });
//
// which answers 400 {"error":true} and NEVER reaches the shared :2067 key guard or the :2072 fetch, so
// there is no outbound request either. The first reading of this file expected the :2067 guard to be
// what fires; the recorded pinned capture answered 400 for a request WITH a reverse_proxy as well,
// which is what located the final else. Both cases are recorded in the backends fixture and the replay
// asserts the outbound COUNT is zero for each.
// serveClaudeChatCompletionStatus reproduces the PINNED FALL-THROUGH for this source, and the name says
// otherwise on purpose: pinned has NO claude arm in the status chain -- CHAT_COMPLETION_SOURCES.CLAUDE
// appears exactly once in that file, in the GENERATE switch at :2260 -- so a claude status request reaches
// the chain final else and answers 400 {error:true} with ZERO outbound, even when a reverse_proxy is
// supplied. Two lanes have now flagged the dispatch as a suspected divergence, so the evidence is recorded
// here: tests/oracle/sillytavern-1.19.0-provider-wire.json carries status.claude.noBranch and
// status.claude.reverseProxy, both recorded from the pinned server.
func (runtime *accountRuntime) serveClaudeChatCompletionStatus(w http.ResponseWriter, body orderedNodeJSON) {
	errorOnly := nodeObject()
	errorOnly.setMember("error", nodeBool(true))
	respondOrderedNodeJSON(w, http.StatusBadRequest, errorOnly)
}

// serveOpenRouterChatCompletionStatus is the OPENROUTER branch of chat-completions.js:1778-2156:
//
//	apiUrl = 'https://openrouter.ai/api/v1'; apiKey = readSecret(..OPENROUTER); headers = {...OPENROUTER_HEADERS}
//	then the SHARED tail: 400 {error:true} when the key is missing (unless the request carries
//	reverse_proxy), GET urlJoin(apiUrl, '/models') with `Authorization: Bearer <key>` plus those headers,
//	the provider's parsed body passed through unchanged on 2xx, 200 {error:true, data:{data:[]}} on a non-2xx,
//	and 200 {error:true} when the fetch or the parse throws.
func (runtime *accountRuntime) serveOpenRouterChatCompletionStatus(w http.ResponseWriter, request *http.Request, body orderedNodeJSON, directories startup.UserDirectories) {
	errorOnly := nodeObject()
	errorOnly.setMember("error", nodeBool(true))
	keyNode, secretErr := pinnedReadSecret(directories, pinnedOpenRouterSecretKey, pinnedSecretID(body))
	if secretErr != nil {
		searchJSON(w, errorOnly)
		return
	}
	key, keyErr := pinnedJSStringValue(keyNode)
	if keyErr != nil {
		searchJSON(w, errorOnly)
		return
	}
	// chat-completions.js:2067 -- the missing-key refusal is 400 and consults `request.body.reverse_proxy`
	// even though this source never uses that member for its URL.
	reverseProxyTruthy := false
	if reverseProxy, exists := body.member("reverse_proxy"); exists && pinnedJSTruthy(reverseProxy) {
		reverseProxyTruthy = true
	}
	if key == "" && !reverseProxyTruthy {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	headers := map[string]string{"authorization": "Bearer " + key}
	for _, entry := range pinnedOpenRouterHeaders().object {
		value, valueErr := pinnedJSStringValue(entry.value)
		if valueErr != nil {
			searchJSON(w, errorOnly)
			return
		}
		headers[strings.ToLower(entry.key)] = value
	}
	response, fetchErr := searchFetch(request.Context(), searchRequest{
		Method:  http.MethodGet,
		URL:     sdURLJoin(pinnedOpenRouterBaseURL(), "/models"),
		Headers: headers,
	})
	if fetchErr != nil {
		searchJSON(w, errorOnly)
		return
	}
	if !sdResponseOK(response) {
		failure := nodeObject()
		failure.setMember("error", nodeBool(true))
		data := nodeObject()
		data.setMember("data", nodeArray())
		failure.setMember("data", data)
		searchJSON(w, failure)
		return
	}
	parsed, parsedOK := sdReadJSON(response)
	if !parsedOK {
		searchJSON(w, errorOnly)
		return
	}
	searchJSON(w, parsed)
}
