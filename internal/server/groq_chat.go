package server

// GROQ, chat_completion_source: 'groq' (src/endpoints/backends/chat-completions.js:2454-2471).
//
// This source is the SHARED openai-compatible path: the pinned branch assigns
// `apiUrl = API_GROQ`, reads `SECRET_KEYS.GROQ`, sets NO headers and NO body params, and differs from
// the shared tail in exactly one place — its own `json_schema` fold, whose member ORDER and `description`
// member are its own:
//
//	bodyParams['response_format'] = { type: 'json_schema',
//	    json_schema: { name, description, schema: value, strict: strict ?? true } }
//
// The shared `pinnedChatCompletionResponseFormat` helper is NOT reused because it emits
// {name, strict, schema} with no `description`: reusing it would be a silent behavioural difference in a
// compared body, and the differential records the exact bytes.
//
// The `/status` arm (chat-completions.js:1880-1888) assigns the same literal and key with empty headers
// and falls through to the SHARED status tail: a 400 when the key is missing and `reverse_proxy` is not
// set, `GET <base>/models` with `Authorization: Bearer <key>`, the provider's parsed body passed through
// on 2xx, `{error:true, data:{data:[]}}` on a non-2xx, `{error:true}` when the fetch or parse throws.

import (
	"net/http"

	"github.com/cocokoishi/gotavern/internal/outbound"
	"github.com/cocokoishi/gotavern/internal/startup"
)

const (
	// chat-completions.js:2456 `apiUrl = API_GROQ`. A LITERAL with no reverse_proxy member, so the seam
	// exists only so the recorded differential can aim the Go leg at the same recording peer the pinned
	// leg is redirected to; its default is asserted against the fixture's recorded literal.
	pinnedGroqAPIURL         = "https://api.groq.com/openai/v1"
	pinnedGroqSeamEnv        = "GOTAVERN_GROQ_CHAT_URL"
	pinnedGroqSecretKey      = "api_key_groq"
	chatCompletionSourceGroq = "groq"
)

// pinnedGroqBaseURL is the pinned literal, replaceable only by the test seam.
func pinnedGroqBaseURL() string {
	return sdSeamURL(pinnedGroqSeamEnv, pinnedGroqAPIURL)
}

// pinnedGroqResponseFormat is groq's own json_schema fold, member order included.
func pinnedGroqResponseFormat(jsonSchema orderedNodeJSON) orderedNodeJSON {
	format := nodeObject()
	format.setMember("type", nodeString("json_schema"))
	inner := nodeObject()
	if name, exists := jsonSchema.member("name"); exists {
		inner.setMember("name", name)
	}
	if description, exists := jsonSchema.member("description"); exists {
		inner.setMember("description", description)
	}
	if value, exists := jsonSchema.member("value"); exists {
		inner.setMember("schema", pinnedFlattenSchema(value))
	}
	strict := nodeBool(true)
	if value, exists := jsonSchema.member("strict"); exists && !value.isUndefined() && !value.isNull() {
		strict = value
	}
	inner.setMember("strict", strict)
	format.setMember("json_schema", inner)
	return format
}

// serveGroqChatCompletionStatus is the GROQ arm of the pinned status matrix. It is the SHARED tail with
// groq's literal and key: the arm itself adds nothing but those two values.
func (runtime *accountRuntime) serveGroqChatCompletionStatus(w http.ResponseWriter, request *http.Request, body orderedNodeJSON, directories startup.UserDirectories) {
	errorOnly := nodeObject()
	errorOnly.setMember("error", nodeBool(true))
	keyNode, secretErr := pinnedReadSecret(directories, pinnedGroqSecretKey, pinnedSecretID(body))
	if secretErr != nil {
		searchJSON(w, errorOnly)
		return
	}
	key, keyErr := pinnedJSStringValue(keyNode)
	if keyErr != nil {
		searchJSON(w, errorOnly)
		return
	}
	// The missing-key refusal consults `request.body.reverse_proxy` even though GROQ never uses that
	// member for its URL (the same quirk the OPENROUTER arm documents).
	reverseProxyTruthy := false
	if reverseProxy, exists := body.member("reverse_proxy"); exists && pinnedJSTruthy(reverseProxy) {
		reverseProxyTruthy = true
	}
	if key == "" && !reverseProxyTruthy {
		pinnedChatCompletionMissingKeyRefusal(w)
		return
	}
	headers := map[string]string{"authorization": "Bearer " + key}
	response, fetchErr := searchFetch(request.Context(), searchRequest{
		Method:  http.MethodGet,
		URL:     sdURLJoin(pinnedGroqBaseURL(), "/models"),
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

// pinnedGroqChatPlan is chat-completions.js:2454-2471's GROQ arm plus the shared tail: a literal base,
// api_key_groq, NO header of its own and NO body param of its own. Its one fold is a json_schema shape the
// shared response_format helper cannot express (member order plus `description`), so pinnedGroqResponseFormat
// owns it.
func pinnedGroqChatPlan(request chatCompletionRequest) (*outbound.Request, *pinnedChatCompletionFailure) {
	body := request.body
	apiKey, secretErr := pinnedReadSecret(request.directories, pinnedGroqSecretKey, pinnedSecretID(body))
	if secretErr != nil {
		return nil, pinnedChatCompletionTransportFailure(secretErr)
	}
	bodyParams := nodeObject()
	if schema, exists := body.member("json_schema"); exists && pinnedJSTruthy(schema) {
		bodyParams.setMember("response_format", pinnedGroqResponseFormat(schema))
	}
	return pinnedChatCompletionAssemble(chatCompletionSourceGroq, request, chatCompletionPlanInputs{
		body:          body,
		apiURL:        pinnedGroqBaseURL(),
		apiKey:        apiKey,
		customHeaders: nodeObject(),
		bodyParams:    bodyParams,
	})
}
