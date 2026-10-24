package server

// Pinned MOONSHOT source, from src/endpoints/backends/chat-completions.js:2531-2542.
//
// THIS IS NOT AN OWN TRANSFORM, and that decides the shape of this file. There is no
// `sendMoonshotRequest` and no `case CHAT_COMPLETION_SOURCES.MOONSHOT` in the :2259 generate dispatch;
// MOONSHOT is an arm INSIDE the shared openai-compatible path, so it inherits that path's body assembly
// (:2652-2669), key guard (:2615-2618), fetch and response handling. The arm's entire content is:
//
//	apiUrl  = new URL(request.body.reverse_proxy || API_MOONSHOT).toString();   // :2532
//	apiKey  = request.body.reverse_proxy ? request.body.proxy_password
//	                                     : readSecret(..., MOONSHOT, ...);      // :2533
//	headers = {};                                                              // :2534
//	bodyParams = { thinking: { type: include_reasoning ? 'enabled' : 'disabled' } };  // :2535-2539
//	request.body.json_schema
//	    ? setJsonObjectFormat(bodyParams, request.body.messages, request.body.json_schema)
//	    : addAssistantPrefix(request.body.messages, [], 'partial');              // :2540-2542
//
// TWO FOLDS THAT ARE EASY TO GET WRONG
//  1. `setJsonObjectFormat` (:214-223) is the DEEPSEEK helper, NOT GoTavern's
//     `pinnedChatCompletionResponseFormat`: it sets `response_format {type: 'json_object'}` -- not
//     json_schema -- AND appends a user message whose content is "JSON schema for the response:\n" +
//     JSON.stringify(value, null, 4). The shared path fills response_format only when the key is ABSENT
//     (:2641 `!bodyParams['response_format']`), so the json_object value SURVIVES and the schema reaches
//     the provider as that appended message.
//  2. `addAssistantPrefix(messages, [], 'partial')` uses the property name `partial`, NOT `prefix`, and
//     runs only when json_schema is falsy. Tools are hardcoded to `[]`, so the ONLY thing that can
//     suppress the mark is a `tool` ROLE among the messages -- the request's `tools` array is added to
//     bodyParams later by the shared path and has no effect on this fold.
//
// WIRING (single lines, for the central commit that owns chat_completions.go / backends_status.go):
//
//  1. inside the shared builder, in the per-source arm chain, BEFORE the shared body assembly:
//     } else if name == chatCompletionSourceMoonshot { if err := pinnedChatCompletionMoonshotBodyParams(&bodyParams, &body); err != nil { return nil, pinnedChatCompletionTransportFailure(err) } }
//     It must run BEFORE the assembly because the arm MUTATES body.messages, and the assembly copies
//     `body.member("messages")` into the request body (chat_completions.go:682); afterwards the mutation
//     would be invisible. The pointer to `body` (not a `messages` value) is what makes the append and
//     the `partial` mark survive this frame -- a `messages orderedNodeJSON` parameter would change only
//     a local slice header and SILENTLY DROP both folds.
//  2. for the URL and the key split, in the same arm:
//     apiURL = pinnedChatCompletionMoonshotURLFor(body); apiKey = pinnedChatCompletionMoonshotKeyFor(body, directories); headers = map[string]string{}
//     (both non-failing variants, documented below; the parse failure the strict variants report as an
//     error is the pinned throw inside the shared try, i.e. a transport failure).
//  3. in backends_status.go, in the status chain:
//     if source == chatCompletionSourceMoonshot { runtime.serveMoonshotChatCompletionStatus(w, request, body, directories); return }
//     It is a status ARM, so it must run BEFORE the shared guard/fetch (:2067-2082) that would otherwise
//     answer for every other source.

import (
	"errors"
	"net/http"

	"github.com/cocokoishi/gotavern/internal/outbound"
	"github.com/cocokoishi/gotavern/internal/startup"
)

const (
	pinnedMoonshotAPIURL         = "https://api.moonshot.ai/v1"
	pinnedMoonshotSeamEnv        = "GOTAVERN_MOONSHOT_CHAT_URL"
	pinnedMoonshotSecretKey      = "api_key_moonshot"
	chatCompletionSourceMoonshot = "moonshot"
)

// pinnedMoonshotBaseURL is the pinned literal `API_MOONSHOT` (:91) behind the test seam.
func pinnedMoonshotBaseURL() string { return sdSeamURL(pinnedMoonshotSeamEnv, pinnedMoonshotAPIURL) }

// pinnedChatCompletionMoonshotURL is `new URL(body.reverse_proxy || API_MOONSHOT).toString()` (:2532).
// A bare origin gains a trailing slash here, so a reverse proxy of "https://host" yields
// "https://host/" and the shared `/chat/completions` concatenation produces a DOUBLED slash -- the same
// quirk deepseek and xai have. The second result reports a value that is not a parseable URL.
func pinnedChatCompletionMoonshotURL(body orderedNodeJSON) (string, bool) {
	if reverseProxy, exists := body.member("reverse_proxy"); exists && pinnedJSTruthy(reverseProxy) {
		return pinnedJSURLString(reverseProxy)
	}
	return pinnedMoonshotBaseURL(), true
}

// pinnedChatCompletionMoonshotURLFor is the non-failing form for the central wiring: an unparseable
// reverse_proxy keeps the pinned literal, which is not what the pinned code does, so the builder should
// prefer pinnedChatCompletionMoonshotURL and answer a transport failure instead.
func pinnedChatCompletionMoonshotURLFor(body orderedNodeJSON) string {
	value, _ := pinnedChatCompletionMoonshotURL(body)
	return value
}

// pinnedChatCompletionMoonshotKey is the pinned KEY SPLIT (:2533): the proxy password under a reverse
// proxy, otherwise the MOONSHOT secret. Same split as claude, mistral, openai, deepseek and xai.
func pinnedChatCompletionMoonshotKey(body orderedNodeJSON, directories startup.UserDirectories) (orderedNodeJSON, error) {
	if reverseProxy, exists := body.member("reverse_proxy"); exists && pinnedJSTruthy(reverseProxy) {
		if password, exists := body.member("proxy_password"); exists {
			return password, nil
		}
		return nodeUndefined(), nil
	}
	return pinnedReadSecret(directories, pinnedMoonshotSecretKey, pinnedSecretID(body))
}

// pinnedChatCompletionMoonshotKeyFor is the non-failing form for the central wiring; a secret read error
// is reported by the pinned route as a thrown fetch, so the builder's transport failure is the carrier.
func pinnedChatCompletionMoonshotKeyFor(body orderedNodeJSON, directories startup.UserDirectories) orderedNodeJSON {
	key, err := pinnedChatCompletionMoonshotKey(body, directories)
	if err != nil {
		return nodeUndefined()
	}
	return key
}

// pinnedChatCompletionMoonshotBodyParams is the MOONSHOT arm's whole body content (:2535-2542): the
// always-present `thinking` member, and then EITHER the json_object + schema-message fold OR the
// `partial` mark on a trailing assistant turn. It mutates `*body`'s messages exactly as the pinned code
// mutates `request.body.messages`.
func pinnedChatCompletionMoonshotBodyParams(bodyParams *orderedNodeJSON, body *orderedNodeJSON) error {
	thinking := nodeObject()
	if pinnedJSTruthy(sdBodyMember(*body, "include_reasoning")) {
		thinking.setMember("type", nodeString("enabled"))
	} else {
		thinking.setMember("type", nodeString("disabled"))
	}
	bodyParams.setMember("thinking", thinking)

	messages, exists := body.member("messages")
	schema := sdBodyMember(*body, "json_schema")
	if !exists || messages.kind != 'a' {
		// `setJsonObjectFormat` calls messages.push(), so a non-array messages member throws inside the
		// shared try. Without a schema, `!prompt.length` on a non-array is simply false and nothing
		// happens, which is why only the schema case reports an error here.
		if pinnedJSTruthy(schema) {
			return errMoonshotMessagesNotArray
		}
		return nil
	}
	if pinnedJSTruthy(schema) {
		if err := pinnedChatCompletionMoonshotJSONObjectFormat(bodyParams, &messages, schema); err != nil {
			return err
		}
		body.setMember("messages", messages)
		return nil
	}
	pinnedChatCompletionMoonshotAssistantPrefix(&messages, "partial")
	body.setMember("messages", messages)
	return nil
}

var errMoonshotMessagesNotArray = errors.New("Cannot read properties of undefined (reading 'push')")

// pinnedChatCompletionMoonshotJSONObjectFormat is setJsonObjectFormat (chat-completions.js:214-223).
func pinnedChatCompletionMoonshotJSONObjectFormat(bodyParams *orderedNodeJSON, messages *orderedNodeJSON, jsonSchema orderedNodeJSON) error {
	responseFormat := nodeObject()
	responseFormat.setMember("type", nodeString("json_object"))
	bodyParams.setMember("response_format", responseFormat)

	schemaText, err := pinnedJSONStringifyIndent4(sdBodyMember(jsonSchema, "value"), 0)
	if err != nil {
		return err
	}
	pushed := nodeObject()
	pushed.setMember("role", nodeString("user"))
	pushed.setMember("content", nodeString("JSON schema for the response:\n"+schemaText))
	messages.array = append(messages.array, pushed)
	return nil
}

// pinnedChatCompletionMoonshotAssistantPrefix is addAssistantPrefix(prompt, [], property)
// (prompt-converters.js:67): mark the LAST message when it is an assistant turn and no message carries
// the `tool` role.
func pinnedChatCompletionMoonshotAssistantPrefix(messages *orderedNodeJSON, property string) {
	if messages.kind != 'a' || len(messages.array) == 0 {
		return
	}
	for _, message := range messages.array {
		if role, _ := pinnedClaudeMemberString(message, "role"); role == "tool" {
			return
		}
	}
	last := messages.array[len(messages.array)-1]
	if role, _ := pinnedClaudeMemberString(last, "role"); role != "assistant" {
		return
	}
	last.setMember(property, nodeBool(true))
	messages.array[len(messages.array)-1] = last
}

// serveMoonshotChatCompletionStatus is the MOONSHOT arm of the pinned status matrix (:1848-1851) plus
// the shared GET (:2072-2082): the URL is the reverse proxy or the pinned literal, the key is the proxy
// password or the MOONSHOT secret, `headers = {}` so the shared call adds only `Authorization: Bearer`,
// the provider body is returned unchanged, and a non-2xx provider answer leaves the shared envelope
// 200 {"error":true,"data":{"data":[]}} (:2143-2145).
func (runtime *accountRuntime) serveMoonshotChatCompletionStatus(w http.ResponseWriter, request *http.Request, body orderedNodeJSON, directories startup.UserDirectories) {
	apiURL, ok := pinnedChatCompletionMoonshotURL(body)
	if !ok {
		searchJSON(w, pinnedChatCompletionErrorFlag())
		return
	}
	apiKey, keyErr := pinnedChatCompletionMoonshotKey(body, directories)
	if keyErr != nil {
		searchJSON(w, pinnedChatCompletionErrorFlag())
		return
	}
	reverseProxyTruthy := false
	if reverseProxy, exists := body.member("reverse_proxy"); exists && pinnedJSTruthy(reverseProxy) {
		reverseProxyTruthy = true
	}
	if !pinnedJSTruthy(apiKey) && !reverseProxyTruthy {
		// :2067-2070.
		respondOrderedNodeJSON(w, http.StatusBadRequest, pinnedChatCompletionErrorFlag())
		return
	}
	keyText := "undefined"
	if pinnedJSTruthy(apiKey) {
		if value, isString := apiKey.stringValue(); isString {
			keyText = value
		} else {
			keyText = pinnedClaudeJSString(apiKey)
		}
	}
	response, fetchErr := searchFetch(request.Context(), searchRequest{
		Method:  http.MethodGet,
		URL:     sdURLJoin(apiURL, "/models"),
		Headers: map[string]string{"authorization": "Bearer " + keyText},
	})
	if fetchErr != nil {
		searchJSON(w, pinnedChatCompletionErrorFlag())
		return
	}
	if !sdResponseOK(response) {
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
	respondOrderedNodeJSON(w, http.StatusOK, parsed)
}

// pinnedMoonshotChatPlan is MOONSHOT as the shared path sees it: the branch is an arm INSIDE the shared
// openai-compatible path, so it supplies the URL, the key split and its body folds and the shared assembly
// does the rest. The folds must run BEFORE the assembly because they MUTATE body.messages, and the assembly
// copies that member into the request body afterwards.
func pinnedMoonshotChatPlan(request chatCompletionRequest) (*outbound.Request, *pinnedChatCompletionFailure) {
	body := request.body
	bodyParams := nodeObject()
	if moonshotErr := pinnedChatCompletionMoonshotBodyParams(&bodyParams, &body); moonshotErr != nil {
		return nil, pinnedChatCompletionTransportFailure(moonshotErr)
	}
	return pinnedChatCompletionAssemble(chatCompletionSourceMoonshot, request, chatCompletionPlanInputs{
		body:          body,
		apiURL:        pinnedChatCompletionMoonshotURLFor(body),
		apiKey:        pinnedChatCompletionMoonshotKeyFor(body, request.directories),
		customHeaders: nodeObject(),
		bodyParams:    bodyParams,
	})
}
