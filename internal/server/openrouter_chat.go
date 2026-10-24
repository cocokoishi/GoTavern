package server

// OPENROUTER, chat_completion_source: 'openrouter' (src/endpoints/backends/chat-completions.js:2301-2393).
//
// The source has NO reverse_proxy and NO custom_url: the base URL is a LITERAL, the key is the OPENROUTER
// secret, and the request is shaped by members no other source sends -- transforms / plugins / reasoning /
// provider routing / verbosity. Everything that is openrouter's alone lives in this file: the literal and
// its test seam, the two static headers, the body shaping, and the Gemini safety block.
//
// THE SHAPING MEMBERS THIS SOURCE ALONE SENDS, each with the pinned semantics that a tidy rewrite would get
// wrong:
//
//   - `transforms` comes from a SWITCH on `request.body.middleout`: 'on' -> ['middle-out'], 'off' -> [],
//     'auto' -> undefined and EVERYTHING ELSE -> undefined. `undefined` is dropped by JSON.stringify, so the
//     member is ABSENT for 'auto' and absent when the caller sent nothing, while 'off' sends an EMPTY ARRAY.
//     Those three outcomes are different requests and the fixture records each.
//   - `plugins` is ALWAYS present (an empty array unless web search is enabled), so an OpenRouter body that
//     omits it is not the pinned body.
//   - `reasoning: { exclude: !Boolean(include_reasoning) }` is ALWAYS present, and `reasoning.effort` is
//     added to that SAME object when `reasoning_effort` is truthy -- so the member order is exclude then
//     effort inside a member that was created earlier in the body.
//   - `provider` is built only for a NON-EMPTY `provider` array, as { allow_fallbacks, order }, where
//     `allow_fallbacks ?? true` defaults to true for an absent OR null member but keeps a `false` one.
//     `quantizations` reuses that object with `??=`, so it either EXTENDS it (order: allow_fallbacks, order,
//     quantizations) or CREATES it as { quantizations } alone.
//   - `min_p`, `top_a` and `repetition_penalty` are tested with `!== undefined`, which in JSON means "the
//     member is PRESENT" -- a JSON null is present and is forwarded, and the fixture records that.
//   - `logprobs` is handled HERE rather than by the shared helper the openai source uses: only a value
//     GREATER THAN ZERO adds top_logprobs and flips logprobs to true; `logprobs: 0` adds NOTHING, which is
//     not what the shared helper would do.
//   - a `/google\/gemini/` model additionally carries GEMINI_SAFETY. That test is NOT anchored, so a model id
//     such as `foo/google/gemini-x` matches it just as much as `google/gemini-x`.

import (
	"regexp"

	"github.com/cocokoishi/gotavern/internal/outbound"
)

const (
	// chat-completions.js:2302 is a LITERAL, and the source has no reverse_proxy member: an OpenRouter
	// request cannot be aimed anywhere except at that URL. This seam therefore exists so the recorded
	// differential can point the Go leg at the same recording peer the pinned leg is redirected to at the
	// transport layer, and its DEFAULT is asserted against the fixture's recorded literal
	// (TestChatCompletionOpenRouterSeamDefault), so the default cannot drift into whatever makes the replay
	// pass.
	pinnedOpenRouterAPIURL      = "https://openrouter.ai/api/v1"
	pinnedOpenRouterSeamEnv     = "GOTAVERN_OPENROUTER_CHAT_URL"
	pinnedOpenRouterSecretKey   = "api_key_openrouter"
	chatCompletionSourceOpenRtr = "openrouter"
)

// pinnedOpenRouterBaseURL is the pinned literal, replaceable only by the test seam.
func pinnedOpenRouterBaseURL() string {
	return sdSeamURL(pinnedOpenRouterSeamEnv, pinnedOpenRouterAPIURL)
}

// pinnedOpenRouterHeaders is OPENROUTER_HEADERS (src/constants.js:362). The pinned comment names the reason:
// "OpenRouter needs to pass the Referer and X-Title". Member order is preserved because the outbound header
// set is sent in name order regardless, but the fixture records these two as compared values.
func pinnedOpenRouterHeaders() orderedNodeJSON {
	headers := nodeObject()
	headers.setMember("HTTP-Referer", nodeString("https://sillytavern.app"))
	headers.setMember("X-Title", nodeString("SillyTavern"))
	return headers
}

// pinnedOpenRouterChatPlan is the OPENROUTER arm plus the shared tail. The source has no reverse_proxy
// branch, so the key comes from the secret unconditionally -- but the shared missing-key guard at :2615
// still READS `request.body.reverse_proxy`, which is why a request that carries one can reach the provider
// with an empty Bearer token. That quirk is reproduced, not corrected.
func pinnedOpenRouterChatPlan(request chatCompletionRequest) (*outbound.Request, *pinnedChatCompletionFailure) {
	body := request.body
	apiKey, secretErr := pinnedReadSecret(request.directories, pinnedOpenRouterSecretKey, pinnedSecretID(body))
	if secretErr != nil {
		return nil, pinnedChatCompletionTransportFailure(secretErr)
	}
	bodyParams := nodeObject()
	pinnedChatCompletionOpenRouterBodyParams(&bodyParams, body)
	// chat-completions.js:2372-2374, in the pinned order: the body parameters are assembled first, then the
	// media and signature transforms mutate `request.body.messages` BEFORE the assembly copies them into the
	// outbound body. See openrouter_media.go for the semantics and why each is where it is.
	pinnedChatCompletionOpenRouterMessageTransforms(&body, pinnedThoughtSignatures(request.directories))

	return pinnedChatCompletionAssemble(chatCompletionSourceOpenRtr, request, chatCompletionPlanInputs{
		body:          body,
		apiURL:        pinnedOpenRouterBaseURL(),
		apiKey:        apiKey,
		customHeaders: pinnedOpenRouterHeaders(),
		bodyParams:    bodyParams,
	})
}

// pinnedChatCompletionOpenRouterBodyParams reproduces chat-completions.js:2306-2354, in SOURCE ORDER,
// because the outbound body's member order is part of the byte contract. See this file's header for the
// per-member semantics.
func pinnedChatCompletionOpenRouterBodyParams(bodyParams *orderedNodeJSON, body orderedNodeJSON) {
	middleout := ""
	if member, exists := body.member("middleout"); exists {
		if text, isString := member.stringValue(); isString {
			middleout = text
		}
	}
	switch middleout {
	case "on":
		transforms := nodeArray()
		transforms.array = append(transforms.array, nodeString("middle-out"))
		bodyParams.setMember("transforms", transforms)
	case "off":
		bodyParams.setMember("transforms", nodeArray())
	}
	plugins := nodeArray()
	if enableWebSearch, exists := body.member("enable_web_search"); exists && pinnedJSTruthy(enableWebSearch) {
		plugin := nodeObject()
		plugin.setMember("id", nodeString("web"))
		plugins.array = append(plugins.array, plugin)
	}
	bodyParams.setMember("plugins", plugins)
	reasoning := nodeObject()
	includeReasoning := false
	if member, exists := body.member("include_reasoning"); exists && pinnedJSTruthy(member) {
		includeReasoning = true
	}
	reasoning.setMember("exclude", nodeBool(!includeReasoning))
	bodyParams.setMember("reasoning", reasoning)

	if logprobs, exists := body.member("logprobs"); exists && pinnedJSGreaterThanZero(logprobs) {
		bodyParams.setMember("top_logprobs", logprobs)
		bodyParams.setMember("logprobs", nodeBool(true))
	}
	for _, key := range []string{"min_p", "top_a", "repetition_penalty"} {
		if value, exists := body.member(key); exists {
			bodyParams.setMember(key, value)
		}
	}
	providerSet := false
	if provider, exists := body.member("provider"); exists && provider.kind == 'a' && len(provider.array) > 0 {
		allowFallbacks := orderedNodeJSON{kind: 'b', scalar: true}
		if value, allowExists := body.member("allow_fallbacks"); allowExists && value.kind != 'n' && !value.isUndefined() {
			allowFallbacks = value
		}
		order := nodeObject()
		order.setMember("allow_fallbacks", allowFallbacks)
		order.setMember("order", provider)
		bodyParams.setMember("provider", order)
		providerSet = true
	}
	if quantizations, exists := body.member("quantizations"); exists && quantizations.kind == 'a' && len(quantizations.array) > 0 {
		if !providerSet {
			bodyParams.setMember("provider", nodeObject())
		}
		// `bodyParams['provider']['quantizations'] = ...` mutates the object in place. This type is a VALUE, so
		// the member must be written back after mutating the copy: the differential caught exactly that here
		// (pinned sent provider.quantizations, GoTavern sent none).
		if existing, hasProvider := bodyParams.member("provider"); hasProvider {
			existing.setMember("quantizations", quantizations)
			bodyParams.setMember("provider", existing)
		}
	}
	if useFallback, exists := body.member("use_fallback"); exists && pinnedJSTruthy(useFallback) {
		bodyParams.setMember("route", nodeString("fallback"))
	}
	if effort, exists := body.member("reasoning_effort"); exists && pinnedJSTruthy(effort) {
		// `bodyParams['reasoning']['effort'] = ...` mutates the member created above. Value semantics again:
		// write the mutated copy back, and setMember keeps its original POSITION because the key already
		// exists (JS assignment semantics), which is what keeps exclude before effort.
		reasoning.setMember("effort", effort)
		bodyParams.setMember("reasoning", reasoning)
	}
	if verbosity, exists := body.member("verbosity"); exists && pinnedJSTruthy(verbosity) {
		bodyParams.setMember("verbosity", verbosity)
	}
	if schema, exists := body.member("json_schema"); exists && pinnedJSTruthy(schema) {
		bodyParams.setMember("response_format", pinnedChatCompletionResponseFormat(schema))
	}
	model := ""
	if member, exists := body.member("model"); exists {
		if text, isString := member.stringValue(); isString {
			model = text
		}
	}
	if pinnedOpenRouterGeminiModel.MatchString(model) {
		// GEMINI_SAFETY (src/constants.js:141), a static five-entry array. NOTE: the pinned branch ALSO
		// awaits `isOpenRouterModelCacheable(model)` for these models, which issues an extra `GET /models`.
		// That probe is deliberately NOT implemented in this increment (see the route comment), so a gemini
		// model through OpenRouter sends this body but ONE FEWER outbound request than pinned.
		bodyParams.setMember("safety_settings", pinnedGeminiSafety())
	}
}

// pinnedOpenRouterGeminiModel is `/google\/gemini/.test(model)` (chat-completions.js:2368), NOT anchored: a
// model id such as `foo/google/gemini-x` matches the pinned test just as much as `google/gemini-x`.
var pinnedOpenRouterGeminiModel = regexp.MustCompile(`google/gemini`)

// pinnedGeminiSafety is GEMINI_SAFETY (src/constants.js:141).
func pinnedGeminiSafety() orderedNodeJSON {
	categories := []string{
		"HARM_CATEGORY_HARASSMENT", "HARM_CATEGORY_HATE_SPEECH", "HARM_CATEGORY_SEXUALLY_EXPLICIT",
		"HARM_CATEGORY_DANGEROUS_CONTENT", "HARM_CATEGORY_CIVIC_INTEGRITY",
	}
	array := nodeArray()
	for _, category := range categories {
		entry := nodeObject()
		entry.setMember("category", nodeString(category))
		entry.setMember("threshold", nodeString("OFF"))
		array.array = append(array.array, entry)
	}
	return array
}
