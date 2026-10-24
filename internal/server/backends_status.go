package server

// Pinned /api/backends/chat-completions/status, from
// src/endpoints/backends/chat-completions.js:1778.
//
// IMPLEMENTED: the CUSTOM source. The pinned tail joins urlJoin(custom_url, "/models"), GETs it with
// `Authorization: Bearer <custom key>` plus any custom_include_headers, passes an OK body through
// unchanged, answers `{ error: true, data: { data: [] } }` for a non-OK response, and `{ error: true }`
// when the fetch or the key read throws.
//
// NOT IMPLEMENTED: a source in the pinned provider matrix whose arm this route does not port answers 501
// (rule 17), so an unimplemented source stays distinguishable from pinned's 400 unknown-source answer. The
// distinction is `pinnedChatCompletionSources`: a KNOWN name gets 501, an UNKNOWN name falls through to the
// pinned closing else and gets its own 400. The chat completions row keeps that visible.
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

// pinnedChatCompletionMissingKeyRefusal is the status chain's SHARED missing-key refusal,
// chat-completions.js:2067-2070: `statusResponse.status(400).send({ error: true })` -- a JSON body, not
// Express's plain-text status message.
//
// It is a helper because the same refusal is reproduced by every arm that reaches that point, and NINE
// arms answered it with serveStatusText(400), so a request without a key got `Bad Request` as TEXT where the
// pinned server sends `{"error":true}` as JSON. The shape is ORACLE-BACKED rather than derived: the recorded
// scenarios status.openai.noKey, status.mistral.noKey and status.deepseek.noKey all record 400 with the body
// {"error":true}, and minimaxChat.noKey records the same shape for the generate-side sibling. A test that
// asserted only the BODY would have accepted the plain-text form's 400, which is why this one asserts both.
func pinnedChatCompletionMissingKeyRefusal(w http.ResponseWriter) {
	errorOnly := nodeObject()
	errorOnly.setMember("error", nodeBool(true))
	respondOrderedNodeJSON(w, http.StatusBadRequest, errorOnly)
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
	// Pinned's chain puts OPENAI first (chat-completions.js:1787); the order is not observable, but
	// keeping it makes this dispatch readable against the pinned text.
	if source == chatCompletionSourceOpenAI {
		runtime.serveOpenAIChatCompletionStatus(w, request, body, directories)
		return
	}
	if source == chatCompletionSourceOpenRtr {
		runtime.serveOpenRouterChatCompletionStatus(w, request, body, directories)
		return
	}
	if source == chatCompletionSourceClaude {
		runtime.serveClaudeChatCompletionStatus(w, body)
		return
	}
	// MAKERSUITE has its OWN status shape (:1908-1933): its own URL, `{data: models}` instead of the shared
	// envelope, and a 200 `{error:true, bypass:true, data:{data:[]}}` on every failure but a missing key.
	// VERTEXAI has NO arm and must keep falling through to the shared 400 {"error":true}.
	if source == chatCompletionSourceMakerSuite {
		runtime.serveMakerSuiteChatCompletionStatus(w, request, body, directories)
		return
	}
	if source == chatCompletionSourceMistral {
		runtime.serveMistralChatCompletionStatus(w, request, body, directories)
		return
	}
	if source == chatCompletionSourceDeepSeek {
		runtime.serveDeepSeekChatCompletionStatus(w, request, body, directories)
		return
	}
	if source == chatCompletionSourceCohere {
		// chat-completions.js:1805-1808 -- cohere DOES have a pinned status arm, unlike CLAUDE.
		runtime.serveCohereChatCompletionStatus(w, request, body, directories)
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
	if source == chatCompletionSourceChutes {
		// :1809-1811 sets the shared literal and secret with no header of its own, and the shared tail
		// at :2092-2108 projects the models list. See chutes_chat.go.
		runtime.serveChutesChatCompletionStatus(w, request, body, directories)
		return
	}
	if source == chatCompletionSourcePollinations {
		runtime.servePollinationsChatCompletionStatus(w, request, body, directories)
		return
	}
	if source == chatCompletionSourceFW {
		runtime.serveFireworksChatCompletionStatus(w, request, body, directories)
		return
	}
	if source == chatCompletionSourceGroq {
		runtime.serveGroqChatCompletionStatus(w, request, body, directories)
		return
	}
	if source == chatCompletionSourceZai {
		// Pinned has no ZAI arm and its chain's closing else answers 400 { error: true } without a
		// provider call (chat-completions.js:2062-2065), so this is the pinned behaviour rather than
		// the 501 "not written yet" the default below would give.
		runtime.serveZaiChatCompletionStatus(w, request, body, directories)
		return
	}
	if source == chatCompletionSourceElectronHub {
		runtime.serveElectronHubChatCompletionStatus(w, request, body, directories)
		return
	}
	if source == chatCompletionSourceAimlapi {
		// chat-completions.js:1832-1835: the shared tail with aimlapi's literal, key and AIMLAPI_HEADERS.
		runtime.serveAimlapiChatCompletionStatus(w, request, body, directories)
		return
	}
	if source == chatCompletionSourceXAI {
		runtime.serveXAIChatCompletionStatus(w, request, body, directories)
		return
	}
	if source == chatCompletionSourceAzure {
		// :1934-2011 is NOT part of the shared tail: that arm returns on every path (two provider calls and
		// its own 400/500 wording), so it neither reaches the :2067 key guard nor the :2072 fetch. See
		// azure_openai_chat.go.
		runtime.serveAzureOpenAIChatCompletionStatus(w, request, body, directories)
		return
	}
	if source == chatCompletionSourceMinimax {
		// MINIMAX has NO arm in the pinned status chain either (src/endpoints/backends/
		// chat-completions.js:1778-2065 mentions it nowhere), so a status request reaches the
		// chain's final else and answers 400 {error:true} with zero outbound -- exactly the CLAUDE
		// case above. Answering 501 now that the source is implemented would be the wrong gap.
		runtime.serveMinimaxChatCompletionStatus(w)
		return
	}
	if source == chatCompletionSourceMoonshot {
		// :1848-1851 assigns the URL and the key with the reverse_proxy split and no header of its own,
		// then falls through to the shared GET /models tail. See moonshot_chat.go.
		runtime.serveMoonshotChatCompletionStatus(w, request, body, directories)
		return
	}
	// 501 IS FOR A SOURCE THE PINNED MATRIX KNOWS AND THIS ROUTE DOES NOT PORT YET, and for nothing
	// else. An UNKNOWN name must reach the pinned closing else below, which answers 400 {"error":true}
	// with no provider call (chat-completions.js:2062-2065) -- the same answer the generate chain gives
	// at :2594-2597. Answering 501 for an unknown name would be a parity divergence, and it would also
	// leave no durable control: the only way to assert "not written yet" would be to name a real source,
	// which stops being true the day that source lands.
	if source != "custom" {
		if pinnedChatCompletionSources[source] {
			serveStatusText(w, http.StatusNotImplemented)
			return
		}
		// AN UNKNOWN NAME: the pinned chain's closing else (chat-completions.js:2062-2065) answers
		// 400 {"error":true} with no provider call. NOT the custom branch's error path below, which
		// uses `searchJSON` and therefore answers 200 -- a first attempt at this guard fell through to
		// it and produced 200 {"error":true}, which the status assertion caught and a body-only
		// assertion would have accepted.
		respondOrderedNodeJSON(w, http.StatusBadRequest, pinnedChatCompletionErrorFlag())
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
		pinnedChatCompletionMissingKeyRefusal(w)
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
