package server

// PERPLEXITY, chat_completion_source: 'perplexity' (src/endpoints/backends/chat-completions.js:2422).
//
// TWO THINGS THE BRIEF ASKED TO BE READ RATHER THAN ASSUMED, and what the source says:
//
//	(a) OWN TRANSFORM OR SHARED HELPER?  SHARED. The branch (:2422-2437) sets `apiUrl`, `apiKey`,
//	    `headers` and `bodyParams`, and mutates `request.body.messages`; the request is then assembled by
//	    the SHARED block at :2652-2689 exactly as for groq/siliconflow/nanogpt. So this file supplies the
//	    branch's CONTRIBUTION and the shared assembly stays where it is -- it does not take over the plan
//	    the way claude/deepseek do.
//
//	(b) DOES IT VALIDATE A SOURCE KEY?  YES, and the frontend's `noValidateSources` list is about a
//	    different question. That list (openai.js:4459, `getStatusOpen`) decides whether the CONNECT BUTTON
//	    calls /status; PERPLEXITY is in it, so pressing Connect never validates anything. The GENERATE
//	    route has its own shared guard at :2615 --
//	        if (!apiKey && !request.body.reverse_proxy && source !== CUSTOM) return 400 { error: true }
//	    -- which PERPLEXITY does reach, because :2424 reads the secret unconditionally and never assigns
//	    it from `proxy_password`. A missing key therefore answers 400 { error: true } and no provider
//	    request is made; it does NOT reach the provider. That is a DERIVATION from :2615 + :2424, and it
//	    stays one: the provider-wire harness refuses a capture with zero provider requests, so a scenario
//	    for it would fail at record time rather than prove anything. TestChatCompletionPerplexityMissingKey
//	    IsReturnedNotRefused asserts the returned empty key at plan level, and
//	    TestChatCompletionPerplexityMissingKeyAnswers400WithNoOutbound asserts the observable at the route.
//
// The branch's four members, and the two places a sibling differs in a way worth naming:
//
//	apiUrl        = API_PERPLEXITY                       (:78 'https://api.perplexity.ai')
//	apiKey        = readSecret(.., SECRET_KEYS.PERPLEXITY, ..)   -- no reverse_proxy branch at all
//	headers       = {}                                   -- owns no header of its own
//	bodyParams    = { reasoning_effort: body.reasoning_effort }
//	messages      = postProcessPrompt(messages, STRICT, names)   -- mutation, not a copy
//	json_schema   -> response_format = { type: 'json_schema', json_schema: { schema: value } }
//
// The json_schema shape is NOT the shared one: the shared block (:2641-2650) sends `name` and `strict`
// inside `json_schema`, and this branch sends NEITHER. Because the branch sets `response_format` itself,
// the shared block's `!bodyParams['response_format']` guard skips it -- so the narrower shape survives.
// Getting this wrong in the other direction (adding name/strict) would produce a body that still parses.
//
// STRICT is the processing type, not SEMI: the two differ only by `placeholders`, and STRICT inserts the
// placeholder between a leading system message and what follows. That is asserted directly, because a
// wrong-but-plausible type would otherwise be invisible in the body.

import (
	"github.com/cocokoishi/gotavern/internal/startup"
)

const (
	pinnedPerplexityAPIURL         = "https://api.perplexity.ai"
	pinnedPerplexitySeamEnv        = "GOTAVERN_PERPLEXITY_CHAT_URL"
	pinnedPerplexitySecretKey      = "api_key_perplexity"
	chatCompletionSourcePerplexity = "perplexity"
	// pinnedPerplexityProcessingType is PROMPT_PROCESSING_TYPE.STRICT (:2429). Named rather than inlined
	// so the test asserts the constant the production path uses, not a copy of it.
	pinnedPerplexityProcessingType = "strict"
)

// pinnedPerplexityBaseURL is the pinned literal, replaceable only by the test seam.
func pinnedPerplexityBaseURL() string {
	return sdSeamURL(pinnedPerplexitySeamEnv, pinnedPerplexityAPIURL)
}

// pinnedPerplexityResponseFormat is :2430-2437: `{ type: 'json_schema', json_schema: { schema: value } }`
// with NO `name` and NO `strict`, unlike the shared shape at :2641-2650.
func pinnedPerplexityResponseFormat(schema orderedNodeJSON) orderedNodeJSON {
	inner := nodeObject()
	if value, exists := schema.member("value"); exists {
		inner.setMember("schema", value)
	}
	format := nodeObject()
	format.setMember("type", nodeString("json_schema"))
	format.setMember("json_schema", inner)
	return format
}

// pinnedPerplexitySourceConfig applies the PERPLEXITY contribution and is the ONE call the dispatch
// needs. Wiring it into pinnedChatCompletionPlan's switch is one case:
//
//	case chatCompletionSourcePerplexity:
//	    apiURL, apiKey, failure = pinnedPerplexitySourceConfig(&body, &bodyParams, directories, cookieSecret)
//	    if failure != nil { return nil, failure }
//
// It returns the empty key when the secret is absent, exactly as pinnedReadSecret does, so the SHARED
// missing-key guard answers 400 { error: true } rather than this source inventing its own refusal.
func pinnedPerplexitySourceConfig(body *orderedNodeJSON, bodyParams *orderedNodeJSON, directories startup.UserDirectories, affinityKey string) (string, orderedNodeJSON, *pinnedChatCompletionFailure) {
	apiKey, secretErr := pinnedReadSecret(directories, pinnedPerplexitySecretKey, pinnedSecretID(*body))
	if secretErr != nil {
		return "", nodeUndefined(), pinnedChatCompletionTransportFailure(secretErr)
	}

	// `bodyParams = { reasoning_effort: request.body.reasoning_effort }`: the member is copied WHEN PRESENT
	// and omitted when the request omits it, because JSON.stringify drops an `undefined` value. A JSON
	// `null` IS copied, which is why this tests for presence rather than truthiness.
	if effort, exists := body.member("reasoning_effort"); exists {
		bodyParams.setMember("reasoning_effort", effort)
	}

	if schema, exists := body.member("json_schema"); exists && pinnedJSTruthy(schema) {
		bodyParams.setMember("response_format", pinnedPerplexityResponseFormat(schema))
	}

	// `request.body.messages = postProcessPrompt(..)` MUTATES the body, and the shared assembly reads the
	// body's messages afterwards, so the processed array has to land back on the body.
	if messages, exists := body.member("messages"); exists {
		processed, processErr := backendsPostProcessPrompt(messages, pinnedPerplexityProcessingType, backendsPromptNamesFor(*body))
		if processErr != nil {
			return "", nodeUndefined(), pinnedChatCompletionTransportFailure(processErr)
		}
		body.setMember("messages", processed)
	}

	return pinnedPerplexityBaseURL(), apiKey, nil
}
