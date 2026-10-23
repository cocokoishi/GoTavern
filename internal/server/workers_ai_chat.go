package server

// WORKERS_AI, chat_completion_source: 'workers_ai' (src/endpoints/backends/chat-completions.js:2576).
//
// The base URL is DERIVED FROM A REQUEST BODY VALUE, which is why this source's seam is the ACCOUNTS PREFIX
// and not a literal:
//
//	apiUrl = `${API_WORKERS_AI}/${encodeURIComponent(accountId)}/ai/v1`
//	API_WORKERS_AI = 'https://api.cloudflare.com/client/v4/accounts'
//
// Two consequences, both tested rather than assumed. The seam replaces only the PREFIX, so the account id
// stays caller data and is asserted as a PATH SEGMENT -- a single combined literal would pin caller data as
// if it were a constant. And the id goes through `encodeURIComponent`, whose unescaped set differs from Go's
// url.PathEscape, so an id carrying reserved characters (`acc/one?x=1` -> `acc%2Fone%3Fx%3D1`) is the input
// that makes the assertion able to fail at all.
//
// The pre-fetch refusal -- a missing account id answers 400 {error:true} BEFORE any request -- cannot be
// captured by the provider-wire harness, because there is no provider traffic to record. It is a LABELLED
// DERIVATION in the test file asserting the pinned status and ZERO outbound requests, which is the shape
// AGENTS.md rule 4 asks for when only half of a behaviour is reachable.
//
// Body foldings: `repetition_penalty` is copied when supplied, and json_schema becomes
// `{type:'json_schema', json_schema:<the schema value itself>}` -- NOT the `{name, strict, schema}` envelope
// the other sources use, so this fold is its own.
//
// `/status` (:2019) is a different route and a different shape: it requires the key AND the account id
// (400 for either, pre-fetch), GETs `<prefix>/<accountId>/ai/models/search?task=Text+Generation&per_page=1000`,
// maps the reply to `{data: result.map(m => ({...m, id: m.name}))}`, forwards a provider non-2xx status with
// `{error:true}`, and answers 500 `{error:true}` when the fetch throws. Its key comes from readSecret only:
// the arm never consults reverse_proxy and never assigns from proxy_password.

import (
	"net/http"

	"github.com/cocokoishi/gotavern/internal/startup"
)

const (
	pinnedWorkersAIPrefix    = "https://api.cloudflare.com/client/v4/accounts"
	pinnedWorkersAISeamEnv   = "GOTAVERN_WORKERS_AI_CHAT_URL"
	pinnedWorkersAISecretKey = "api_key_workers_ai"
	chatCompletionSourceWAI  = "workers_ai"
)

// pinnedWorkersAIPrefixURL is the pinned accounts prefix, replaceable only by the test seam. The account id
// is appended by pinnedWorkersAIBaseURL and never comes from the seam.
func pinnedWorkersAIPrefixURL() string {
	return sdSeamURL(pinnedWorkersAISeamEnv, pinnedWorkersAIPrefix)
}

// pinnedWorkersAIAccountID implements `String(request.body.workers_ai_account_id || ”).trim()`, including
// the falsiness check that produces the pre-fetch 400.
func pinnedWorkersAIAccountID(body orderedNodeJSON) (string, bool) {
	accountNode, exists := body.member("workers_ai_account_id")
	if !exists {
		return "", false
	}
	text, stringErr := pinnedJSStringValue(accountNode)
	if stringErr != nil {
		if !pinnedJSTruthy(accountNode) {
			return "", false
		}
		text = pinnedClaudeJSString(accountNode)
	}
	trimmed := trimJSWhitespace(text)
	return trimmed, trimmed != ""
}

// pinnedWorkersAIBaseURL is `${prefix}/${encodeURIComponent(accountId)}/ai/v1`.
func pinnedWorkersAIBaseURL(accountID string) string {
	return pinnedWorkersAIPrefixURL() + "/" + encodeURIComponentJS(accountID) + "/ai/v1"
}

// pinnedWorkersAIStatusURL is the models SEARCH url the status arm fetches, query included.
func pinnedWorkersAIStatusURL(accountID string) string {
	return pinnedWorkersAIPrefixURL() + "/" + encodeURIComponentJS(accountID) + "/ai/models/search?task=Text+Generation&per_page=1000"
}

// serveWorkersAIChatCompletionStatus is the WORKERS_AI arm of the pinned status matrix (:2019).
func (runtime *accountRuntime) serveWorkersAIChatCompletionStatus(w http.ResponseWriter, request *http.Request, body orderedNodeJSON, directories startup.UserDirectories) {
	errorOnly := nodeObject()
	errorOnly.setMember("error", nodeBool(true))
	keyNode, secretErr := pinnedReadSecret(directories, pinnedWorkersAISecretKey, pinnedSecretID(body))
	if secretErr != nil {
		searchJSON(w, errorOnly)
		return
	}
	key, keyErr := pinnedJSStringValue(keyNode)
	if keyErr != nil {
		searchJSON(w, errorOnly)
		return
	}
	// The arm's OWN key check, before the account id: 400 {error:true}. It does NOT consult reverse_proxy --
	// the shared guard at :2068 is never reached for this source.
	if key == "" {
		pinnedChatCompletionMissingKeyRefusal(w)
		return
	}
	accountID, ok := pinnedWorkersAIAccountID(body)
	if !ok {
		pinnedChatCompletionMissingKeyRefusal(w)
		return
	}
	headers := map[string]string{"authorization": "Bearer " + key}
	response, fetchErr := searchFetch(request.Context(), searchRequest{
		Method:  http.MethodGet,
		URL:     pinnedWorkersAIStatusURL(accountID),
		Headers: headers,
	})
	if fetchErr != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	if !sdResponseOK(response) {
		serveStatusText(w, response.Status)
		return
	}
	data, parsed := sdReadJSON(response)
	if !parsed {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	// `{data: result.map(model => ({...model, id: model.name}))}`.
	projected := nodeArray()
	if result, exists := data.member("result"); exists && result.kind == 'a' {
		for _, model := range result.array {
			if model.kind != 'o' {
				continue
			}
			if name, hasName := model.member("name"); hasName {
				model.setMember("id", name)
			}
			projected.array = append(projected.array, model)
		}
	}
	out := nodeObject()
	out.setMember("data", projected)
	searchJSON(w, out)
}

// trimJSWhitespace is String.prototype.trim's ASCII whitespace set, which is what account ids carry.
func trimJSWhitespace(value string) string {
	start := 0
	end := len(value)
	for start < end && isJSWhitespace(value[start]) {
		start++
	}
	for end > start && isJSWhitespace(value[end-1]) {
		end--
	}
	return value[start:end]
}

func isJSWhitespace(character byte) bool {
	switch character {
	case ' ', '\t', '\n', '\r', '\v', '\f':
		return true
	}
	return false
}
