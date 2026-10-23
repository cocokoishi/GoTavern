package server

// Pinned OPENAI status arm, from src/endpoints/backends/chat-completions.js:1787-1790, then the
// shared tail at :2067-2156.
//
// The arm is three lines, and every one of them is a contract:
//
//	apiUrl = new URL(request.body.reverse_proxy || API_OPENAI).toString();
//	apiKey = request.body.reverse_proxy ? request.body.proxy_password
//	                                    : readSecret(request.user.directories, SECRET_KEYS.OPENAI, request.body.secret_id);
//	headers = {};
//
// This is the arm that was missing from a set the inventories already described as complete, and it
// is missing in a way a summary hides: the CUSTOM arm immediately below it looks like the whole
// route (the tail is shared), so "status is implemented for custom" reads as "status is
// implemented". OPENAI takes its key from `proxy_password` when a reverse proxy is configured --
// MISTRALAI, XAI, MOONSHOT and DEEPSEEK do the same; GROQ, SILICONFLOW, NANOGPT, POLLINATIONS,
// ELECTRONHUB, CHUTES, OPENROUTER and AIMLAPI do not -- so the arm is reproduced from the pinned
// text rather than from the shape of its siblings.
//
// The shared tail is what makes the observables: `urlJoin(apiUrl, '/models')`, a GET whose only
// route-set header is `Authorization: Bearer <key>`, the provider's parsed body passed through
// unchanged on a 2xx, **status 200** with `{error:true, data:{data:[]}}` on a non-2xx, 400
// `{error:true}` for a missing key with no reverse proxy, and 200 `{error:true}` when the fetch or
// the parse throws.
//
// Evidence: `status.openai.ok`, `.reverseProxy`, `.reverseProxyNoPassword`, `.nonOk` and `.noKey`
// in tests/oracle/sillytavern-1.19.0-backends.json, recorded from the pinned server by
// tools/probe-backends.mjs and replayed by internal/server/openai_chat_status_test.go.
//
// WHY THE EVIDENCE LIVES IN THE BACKENDS FIXTURE and not in tests/provider-wire/scenarios: the
// provider-wire probe builds the Go binary and drives both legs in one run, and `status.openai.noKey`
// asserts ZERO outbound requests -- a capture the provider-wire replay refuses by design ("capture
// records no provider request"). This route's other evidence (`status.custom.*`) is in the same
// fixture, and its replay already maps a chat-domain seam (`GOTAVERN_MISTRAL_CHAT_URL`) for exactly
// this case.

import (
	"net/http"

	"github.com/cocokoishi/gotavern/internal/startup"
)

const (
	// pinnedOpenAISecretKey is SECRET_KEYS.OPENAI (src/endpoints/secrets.js).
	pinnedOpenAISecretKey = "api_key_openai"
	// pinnedOpenAISeamEnv points the route at a local recorder. The default is the pinned literal,
	// so an unset variable can never change production behaviour.
	pinnedOpenAISeamEnv = "GOTAVERN_OPENAI_CHAT_URL"
)

// pinnedOpenAIBaseURL is API_OPENAI ('https://api.openai.com/v1'), replaceable only by the test
// seam so the recorded pinned literal and the value the replay drives cannot drift apart.
func pinnedOpenAIBaseURL() string {
	return sdSeamURL(pinnedOpenAISeamEnv, pinnedOpenAIAPIURL)
}

// serveOpenAIChatCompletionStatus is chat-completions.js:1787-1790 plus the shared tail at
// :2067-2156. It is deliberately the same shape as serveMistralChatCompletionStatus, because the
// pinned arms are the same shape; the difference between them is only the literal and the secret.
func (runtime *accountRuntime) serveOpenAIChatCompletionStatus(w http.ResponseWriter, request *http.Request, body orderedNodeJSON, directories startup.UserDirectories) {
	apiURL := pinnedOpenAIBaseURL()
	apiKey := nodeUndefined()
	proxyTruthy := false
	if reverseProxy, exists := body.member("reverse_proxy"); exists && pinnedJSTruthy(reverseProxy) {
		// `new URL(request.body.reverse_proxy)` throws on anything that is not an absolute URL, and
		// the pinned catch answers {error:true}.
		normalized, ok := pinnedJSURLString(reverseProxy)
		if !ok {
			searchJSON(w, pinnedChatCompletionErrorFlag())
			return
		}
		apiURL = normalized
		proxyTruthy = true
		// `reverse_proxy ? request.body.proxy_password : readSecret(...)`: an absent password leaves
		// apiKey `undefined`, which the guard below deliberately does NOT reject (proxyTruthy is
		// set) and which reaches the provider as `Bearer undefined` -- the pinned quirk recorded by
		// status.openai.reverseProxyNoPassword.
		if password, exists := body.member("proxy_password"); exists {
			apiKey = password
		}
	} else {
		secret, err := pinnedReadSecret(directories, pinnedOpenAISecretKey, pinnedSecretID(body))
		if err != nil {
			searchJSON(w, pinnedChatCompletionErrorFlag())
			return
		}
		apiKey = secret
	}
	if !pinnedJSTruthy(apiKey) && !proxyTruthy {
		// :2067-2070 `if (!apiKey && !request.body.reverse_proxy && source !== CUSTOM)`.
		respondOrderedNodeJSON(w, http.StatusBadRequest, pinnedChatCompletionErrorFlag())
		return
	}
	keyText, keyErr := pinnedJSStringValue(apiKey)
	if keyErr != nil {
		// `'Bearer ' + undefined` and `'Bearer ' + 123` are String() conversions, not a refusal.
		keyText = pinnedClaudeJSString(apiKey)
	}
	response, fetchErr := searchFetch(request.Context(), searchRequest{
		Method: http.MethodGet,
		URL:    sdURLJoin(apiURL, "/models"),
		Headers: map[string]string{
			"authorization": "Bearer " + keyText,
		},
	})
	if fetchErr != nil {
		searchJSON(w, pinnedChatCompletionErrorFlag())
		return
	}
	if !sdResponseOK(response) {
		// :2143-2145 `statusResponse.send({ error: true, data: { data: [] } })` -- no status call,
		// so the pinned answer is 200 and the failing provider status is NOT forwarded.
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
	searchJSON(w, parsed)
}
