package server

// ZAI, chat_completion_source: 'zai' (src/endpoints/backends/chat-completions.js:2551).
//
// The branch is the SHARED openai-compatible path with four differences, and the first is the one the
// brief was imprecise about:
//
//	defaultApiUrl = body.zai_endpoint === ZAI_ENDPOINT.CODING ? API_ZAI_CODING : API_ZAI_COMMON
//	apiUrl        = new URL(body.reverse_proxy || defaultApiUrl)
//	apiKey        = body.reverse_proxy ? body.proxy_password : readSecret(.., SECRET_KEYS.ZAI, ..)
//	headers       = { 'Accept-Language': 'en-US,en' }
//	bodyParams    = { thinking: { type: body.include_reasoning ? 'enabled' : 'disabled' } }
//	if (body.json_schema) setJsonObjectFormat(..)
//
// THE ENDPOINT SWITCH MOVES THE PATH, NOT THE HOST, AND THAT IS EXACTLY WHY IT NEEDS A SEAM PER MODE.
// Both literals are `api.z.ai` and only the path differs ('/api/paas/v4' vs '/api/coding/paas/v4'),
// unlike SILICONFLOW whose switch moves the host between .com and .cn. This file used to argue that ONE
// seam was therefore enough, "because the provider target carries the path", and that argument was wrong
// in the way only a recorded scenario can show: a seam REPLACES THE WHOLE BASE URL, so with one seam
// both modes leave for the peer with identical bytes, the recorded `zai_endpoint` rule cannot fail, and
// a build that ignored the ternary would pass. `tests/provider-wire/scenarios/zai-coding-endpoint.json`
// therefore names a variable that only the coding literal reads: a build that ignored the switch leaves
// that variable unread, falls back to the production common literal, and reaches no peer at all -- a
// failure rather than a silent pass. The shape is minimax's for its CN endpoint (minimax_chat.go:49-52)
// and makersuite's for its two Google bases. The literals are also still asserted separately
// (TestChatCompletionZaiEndpointLiteralPerMode), so neither mode can silently stand in for the other.
//
// ZAI HONOURS `reverse_proxy`, so unlike groq/siliconflow/nanogpt it can be aimed at a peer through the
// frontend's own setting, and `proxy_password` is the credential in that case -- pinned reads
// `body.reverse_proxy ? body.proxy_password : readSecret(..)`, so a drive with a proxy set but no
// password sends no credential at all.
//
// /status: pinned's status matrix has NO ZAI arm, and its chain ends at :2062-2065 with
// `console.warn('This chat completion source is not supported yet.'); return statusResponse.status(400)
// .send({ error: true })`. So the observable is 400 with {error:true} and ZERO outbound requests --
// NOT the 501 this package answers for a source whose status arm is simply unimplemented. The two are
// different claims: 501 means "we have not written it", 400 means "this is what pinned does".

import (
	"errors"
	"net/http"

	"github.com/cocokoishi/gotavern/internal/outbound"
	"github.com/cocokoishi/gotavern/internal/startup"
)

// One seam per pinned literal (pinnedZAISeamEnv for the common endpoint, pinnedZAICodingSeamEnv for the
// coding one): a seam replaces the whole base URL, so a single seam would make the two modes
// indistinguishable at the peer. See the header comment.
const (
	pinnedZAICommonAPIURL   = "https://api.z.ai/api/paas/v4"
	pinnedZAICodingAPIURL   = "https://api.z.ai/api/coding/paas/v4"
	pinnedZAISeamEnv        = "GOTAVERN_ZAI_CHAT_URL"
	pinnedZAICodingSeamEnv  = "GOTAVERN_ZAI_CODING_CHAT_URL"
	pinnedZAISecretKey      = "api_key_zai"
	pinnedZAICodingEndpoint = "coding"
	pinnedZAIHeaderLanguage = "en-US,en"
	chatCompletionSourceZai = "zai"
)

// pinnedZAIEndpointIsCoding is pinned's ternary condition isolated in one place, so the literal choice,
// the seam choice and the unit tests cannot disagree about what selects the coding endpoint:
// `request.body.zai_endpoint === ZAI_ENDPOINT.CODING`.
func pinnedZAIEndpointIsCoding(body orderedNodeJSON) bool {
	endpoint, exists := body.member("zai_endpoint")
	if !exists {
		return false
	}
	text, ok := endpoint.scalar.(string)
	return ok && text == pinnedZAICodingEndpoint
}

// pinnedZAILiteralBaseURL is the pinned literal for the mode the REQUEST selects, with no seam applied.
// It exists so each mode's literal can be asserted on its own; the seam must never be the only thing a
// test can see, or a wrong literal would pass whenever the peer accepted both.
func pinnedZAILiteralBaseURL(body orderedNodeJSON) string {
	if pinnedZAIEndpointIsCoding(body) {
		return pinnedZAICodingAPIURL
	}
	// Anything else -- 'common', an absent field, or a value this build does not know -- takes the
	// common literal, which is what pinned's single ternary does.
	return pinnedZAICommonAPIURL
}

// pinnedZAIBaseURL applies the seam FOR THE SELECTED MODE to that mode's literal.
func pinnedZAIBaseURL(body orderedNodeJSON) string {
	if pinnedZAIEndpointIsCoding(body) {
		return sdSeamURL(pinnedZAICodingSeamEnv, pinnedZAICodingAPIURL)
	}
	return sdSeamURL(pinnedZAISeamEnv, pinnedZAICommonAPIURL)
}

// pinnedZAIThinking is `bodyParams.thinking` (:2558-2562): the member is ALWAYS present, and only its
// type depends on include_reasoning. `include_reasoning` is read with JS truthiness, so zero, an empty
// string, false and an absent field all mean 'disabled'.
func pinnedZAIThinking(body orderedNodeJSON) orderedNodeJSON {
	kind := "disabled"
	if includeReasoning, exists := body.member("include_reasoning"); exists && pinnedJSTruthy(includeReasoning) {
		kind = "enabled"
	}
	thinking := nodeObject()
	thinking.setMember("type", nodeString(kind))
	return thinking
}

// serveZaiChatCompletionStatus is the ZAI arm of the pinned status matrix, which has no ZAI branch:
// the chain's closing `else` answers 400 { error: true } for a source it does not support, and it does
// so WITHOUT calling the provider. Recorded here rather than left to the package's 501 default, because
// 501 would claim the arm is unwritten when its behaviour is known and observable.
func (runtime *accountRuntime) serveZaiChatCompletionStatus(w http.ResponseWriter, _ *http.Request, _ orderedNodeJSON, _ startup.UserDirectories) {
	errorOnly := nodeObject()
	errorOnly.setMember("error", nodeBool(true))
	respondOrderedNodeJSON(w, http.StatusBadRequest, errorOnly)
}

// pinnedZaiChatPlan is chat-completions.js:2551-2564's ZAI arm plus the shared tail. ZAI HONOURS
// `reverse_proxy`, so unlike groq/siliconflow/nanogpt it can be aimed at a peer through the frontend's own
// setting, and `proxy_password` is the credential in that case. The shared :2615 guard consults the same
// request member, so a drive with a proxy set but no password sends no credential at all and still reaches
// the provider -- reproduced, not corrected.
func pinnedZaiChatPlan(request chatCompletionRequest) (*outbound.Request, *pinnedChatCompletionFailure) {
	body := request.body
	customHeaders := nodeObject()
	bodyParams := nodeObject()

	var apiURL string
	var apiKey orderedNodeJSON = nodeUndefined()
	reverseProxy, hasReverseProxy := body.member("reverse_proxy")
	if hasReverseProxy && pinnedJSTruthy(reverseProxy) {
		normalized, ok := pinnedJSURLString(reverseProxy)
		if !ok {
			// `new URL(value)` throws for anything that is not an absolute URL, and the pinned
			// catch answers 502 -- the same shape the OPENAI case reproduces.
			return nil, pinnedChatCompletionTransportFailure(errors.New("Invalid URL"))
		}
		apiURL = normalized
		if password, exists := body.member("proxy_password"); exists {
			apiKey = password
		}
	} else {
		apiURL = pinnedZAIBaseURL(body)
		secret, err := pinnedReadSecret(request.directories, pinnedZAISecretKey, pinnedSecretID(body))
		if err != nil {
			return nil, pinnedChatCompletionTransportFailure(err)
		}
		apiKey = secret
	}
	customHeaders.setMember("Accept-Language", nodeString(pinnedZAIHeaderLanguage))
	bodyParams.setMember("thinking", pinnedZAIThinking(body))
	if schema, exists := body.member("json_schema"); exists && pinnedJSTruthy(schema) {
		if foldErr := pinnedSetJsonObjectFormat(&bodyParams, &body, schema); foldErr != nil {
			return nil, pinnedChatCompletionTransportFailure(foldErr)
		}
	}
	return pinnedChatCompletionAssemble(chatCompletionSourceZai, request, chatCompletionPlanInputs{
		body:          body,
		apiURL:        apiURL,
		apiKey:        apiKey,
		customHeaders: customHeaders,
		bodyParams:    bodyParams,
	})
}
