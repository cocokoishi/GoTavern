package server

// THE OPENAI AND CUSTOM PLANNERS -- the two sources the shared openai-compatible assembly was written
// for, and the reference the other ten shared-path sources are read against.
//
// OPENAI (:2260) is the shared path verbatim: `apiUrl = new URL(body.reverse_proxy || API_OPENAI)`,
// `apiKey = reverse_proxy ? proxy_password : readSecret(OPENAI)`, no headers and no body params of its own
// beyond the shared logprobs adjustment. Two captured details are NOT guessable from this file and both
// come from `new URL(...).toString()` rather than from the literal:
//
//   - a bare-origin reverse_proxy gains a TRAILING SLASH, so the shared `/chat/completions` concatenation
//     produces `//chat/completions` on the wire;
//   - an unparseable reverse_proxy throws inside the pinned try, i.e. the shared 502, before any connection.
//
// CUSTOM (:2398-2421) is the same assembly with a caller-supplied `custom_url`, the CUSTOM secret, the
// YAML include/exclude options, and its own json_schema fold that runs BEFORE the shared one so the shared
// `!bodyParams.response_format` guard does not overwrite it.

import (
	"errors"

	"github.com/cocokoishi/gotavern/internal/outbound"
)

// pinnedOpenAIChatPlan is chat-completions.js:2260-2300's OPENAI arm plus the shared tail.
func pinnedOpenAIChatPlan(request chatCompletionRequest) (*outbound.Request, *pinnedChatCompletionFailure) {
	body := request.body
	customHeaders := nodeObject()
	bodyParams := nodeObject()

	var apiURL string
	var apiKey orderedNodeJSON = nodeUndefined()

	reverseProxy, hasReverseProxy := body.member("reverse_proxy")
	if hasReverseProxy && pinnedJSTruthy(reverseProxy) {
		normalized, ok := pinnedJSURLString(reverseProxy)
		if !ok {
			// `new URL(value)` throws for anything that is not a valid
			// absolute URL, and the pinned catch answers 502.
			return nil, pinnedChatCompletionTransportFailure(errors.New("Invalid URL"))
		}
		apiURL = normalized
		if password, exists := body.member("proxy_password"); exists {
			apiKey = password
		}
	} else {
		apiURL = pinnedOpenAIBaseURL()
		secret, err := pinnedReadSecret(request.directories, "api_key_openai", pinnedSecretID(body))
		if err != nil {
			return nil, pinnedChatCompletionTransportFailure(err)
		}
		apiKey = secret
	}
	pinnedChatCompletionApplyLogprobs(&bodyParams, body, request.isTextCompletion)

	return pinnedChatCompletionAssemble(chatCompletionSourceOpenAI, request, chatCompletionPlanInputs{
		body:          body,
		apiURL:        apiURL,
		apiKey:        apiKey,
		customHeaders: customHeaders,
		bodyParams:    bodyParams,
	})
}

// pinnedCustomChatPlan is chat-completions.js:2398-2421's CUSTOM arm plus the shared tail. The order of the
// three optional folds is the pinned order and is observable: logprobs first, then custom_include_body, then
// custom_include_headers, and the json_schema fold LAST so that it overwrites a response_format the caller
// supplied through custom_include_body rather than being skipped by the shared guard.
func pinnedCustomChatPlan(request chatCompletionRequest) (*outbound.Request, *pinnedChatCompletionFailure) {
	body := request.body
	customURL, exists := body.member("custom_url")
	if !exists {
		// `${undefined}/chat/completions` is not an absolute URL, so the
		// pinned fetch throws and the catch answers 502.
		return nil, pinnedChatCompletionTransportFailure(errors.New("Only absolute URLs are supported"))
	}
	apiURL, stringErr := pinnedJSStringValue(customURL)
	if stringErr != nil {
		return nil, pinnedChatCompletionTransportFailure(stringErr)
	}
	apiKey, secretErr := pinnedReadSecret(request.directories, "api_key_custom", pinnedSecretID(body))
	if secretErr != nil {
		return nil, pinnedChatCompletionTransportFailure(secretErr)
	}

	customHeaders := nodeObject()
	bodyParams := nodeObject()
	pinnedChatCompletionApplyLogprobs(&bodyParams, body, request.isTextCompletion)
	if includeBody, includeExists := body.member("custom_include_body"); includeExists {
		pinnedMergeObjectWithYAML(&bodyParams, includeBody)
	}
	if includeHeaders, headersExist := body.member("custom_include_headers"); headersExist {
		pinnedMergeObjectWithYAML(&customHeaders, includeHeaders)
	}
	if schema, schemaExists := body.member("json_schema"); schemaExists && pinnedJSTruthy(schema) {
		bodyParams.setMember("response_format", pinnedChatCompletionResponseFormat(schema))
	}

	return pinnedChatCompletionAssemble(chatCompletionSourceCustom, request, chatCompletionPlanInputs{
		body:          body,
		apiURL:        apiURL,
		apiKey:        apiKey,
		customHeaders: customHeaders,
		bodyParams:    bodyParams,
	})
}
