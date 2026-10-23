package server

// AI/ML API, chat_completion_source: 'aimlapi' (src/endpoints/backends/chat-completions.js:1289-1394,
// dispatched at :2267).
//
// OWN TRANSFORM. It is not on the shared openai-compatible path: `sendAimlapiRequest` builds its own
// fold (`bodyParams`), its own request-body literal, its own header set (the shared `AIMLAPI_HEADERS`),
// and its own three error observables. What it SHARES with its siblings is only the plumbing:
// `AIMLAPI_HEADERS` (constants.js), `forwardFetchResponse` for a stream, `tryParse` for a non-2xx body,
// and the `API_AIMLAPI` literal.
//
// WHAT A CAREFUL IMPLEMENTATION WOULD GET WRONG, each recorded in the provider-wire differential:
//   - the body is a FIXED literal (messages, model, temperature, max_tokens, stream, presence_penalty,
//     frequency_penalty, top_p, seed, n) with `bodyParams` spread LAST (:1352), so the folded members
//     come after `n` in the order the pinned `if` statements run: top_logprobs/logprobs, tools/
//     tool_choice, stop, reasoning_effort, response_format;
//   - `request.body.logprobs > 0` is a JS RELATIONAL comparison (ToNumber), so a numeric string passes
//     and 0/null/absent do not, and it sets TWO members (`top_logprobs` then `logprobs: true`);
//   - tools and stop are forwarded only for a NON-EMPTY ARRAY, and `tool_choice` rides with tools even
//     when the caller omitted it (JSON.stringify then drops the undefined member);
//   - `reasoning_effort` is a TRUTHINESS test, so an empty string is omitted;
//   - `json_schema` folds `schema` from `json_schema.value` (NOT flattened, unlike groq/deepseek) and
//     `strict` via `strict ?? true`, in the member order type, name, description, schema, strict;
//   - the key guard is `!apiKey` with NO reverse_proxy escape (:1293), unlike openai/mistral/deepseek;
//     the request never consults `reverse_proxy` at all, so AIMLAPI ALWAYS DIALS THE LITERAL;
//   - the headers are node-fetch's sorted lowercase set PLUS `HTTP-Referer: https://sillytavern.app` and
//     `X-Title: SillyTavern`, then Host and Connection last;
//   - response: a stream is forwarded by `forwardFetchResponse` WITHOUT any ok-check; a non-stream
//     non-2xx answers 500 with `tryParse(errorText) ?? { error: true }`; a 2xx passes the provider JSON
//     through unchanged; and a THROWN fetch answers `response.send({ error: true })` with NO status,
//     i.e. 200, because that catch sets none (:1385-1391).
//
// The /status arm (:1832-1835) assigns the same literal and key with `headers = { ...AIMLAPI_HEADERS }`
// and falls through to the SHARED tail (:2067-2095): 400 `{error:true}` when the key is missing and no
// reverse_proxy is set, `GET <literal>/models` with `Authorization: Bearer <key>` plus those two
// headers, the provider's parsed body on 2xx, `{error:true, data:{data:[]}}` on a non-2xx, and
// `{error:true}` when the fetch or the parse throws.

import (
	"errors"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strconv"

	"github.com/cocokoishi/gotavern/internal/outbound"
	"github.com/cocokoishi/gotavern/internal/startup"
)

const (
	// chat-completions.js:88 `API_AIMLAPI = 'https://api.aimlapi.com/v1'`.
	pinnedAimlapiAPIURL         = "https://api.aimlapi.com/v1"
	pinnedAimlapiSeamEnv        = "GOTAVERN_AIMLAPI_CHAT_URL"
	pinnedAimlapiSecretKey      = "api_key_aimlapi"
	chatCompletionSourceAimlapi = "aimlapi"

	// The two members of the shared `AIMLAPI_HEADERS` (constants.js:1081-1084).
	pinnedAimlapiReferer = "https://sillytavern.app"
	pinnedAimlapiTitle   = "SillyTavern"
)

// pinnedAimlapiBaseURL is the pinned literal `API_AIMLAPI`, replaceable only by the test seam. The route
// has no reverse_proxy branch, so this is the only way the target can change.
func pinnedAimlapiBaseURL() string {
	return sdSeamURL(pinnedAimlapiSeamEnv, pinnedAimlapiAPIURL)
}

// pinnedAimlapiHeaders is `{ ...AIMLAPI_HEADERS }`: member order preserved, values as pinned.
func pinnedAimlapiHeaders() orderedNodeJSON {
	headers := nodeObject()
	headers.setMember("HTTP-Referer", nodeString(pinnedAimlapiReferer))
	headers.setMember("X-Title", nodeString(pinnedAimlapiTitle))
	return headers
}

// pinnedAimlapiPayload builds the pinned request body: the fixed literal, then the fold.
func pinnedAimlapiPayload(body orderedNodeJSON) (orderedNodeJSON, *pinnedChatCompletionFailure) {
	payload := nodeObject()
	// :1344-1353 -- the literal, in order, and `undefined` members are dropped by JSON.stringify.
	for _, name := range []string{
		"messages", "model", "temperature", "max_tokens", "stream",
		"presence_penalty", "frequency_penalty", "top_p", "seed", "n",
	} {
		if value, exists := body.member(name); exists {
			payload.setMember(name, value)
		}
	}
	// :1309-1312 `if (request.body.logprobs > 0)`: top_logprobs carries the value, logprobs is forced true.
	if logprobs, exists := body.member("logprobs"); exists && pinnedJSGreaterThanZero(logprobs) {
		payload.setMember("top_logprobs", logprobs)
		payload.setMember("logprobs", nodeBool(true))
	}
	// :1314-1317 `Array.isArray(tools) && tools.length > 0`.
	if tools, exists := body.member("tools"); exists && tools.kind == 'a' && len(tools.array) > 0 {
		payload.setMember("tools", tools)
		if toolChoice, hasChoice := body.member("tool_choice"); hasChoice {
			payload.setMember("tool_choice", toolChoice)
		}
	}
	// :1319-1321 `Array.isArray(stop) && stop.length > 0`.
	if stop, exists := body.member("stop"); exists && stop.kind == 'a' && len(stop.array) > 0 {
		payload.setMember("stop", stop)
	}
	// :1323-1325 `if (request.body.reasoning_effort)`: TRUTHINESS, so "" and 0 are omitted.
	if reasoningEffort, exists := body.member("reasoning_effort"); exists && pinnedJSTruthy(reasoningEffort) {
		payload.setMember("reasoning_effort", reasoningEffort)
	}
	// :1327-1336 `if (request.body.json_schema)`.
	if jsonSchema, exists := body.member("json_schema"); exists && pinnedJSTruthy(jsonSchema) {
		format := nodeObject()
		format.setMember("type", nodeString("json_schema"))
		inner := nodeObject()
		if value, hasName := jsonSchema.member("name"); hasName {
			inner.setMember("name", value)
		}
		if value, hasDescription := jsonSchema.member("description"); hasDescription {
			inner.setMember("description", value)
		}
		if value, hasValue := jsonSchema.member("value"); hasValue {
			// NOT flattened: `schema: request.body.json_schema.value` is the caller's object as given.
			inner.setMember("schema", value)
		}
		strict := nodeBool(true)
		if value, hasStrict := jsonSchema.member("strict"); hasStrict && !value.isUndefined() && !value.isNull() {
			strict = value
		}
		inner.setMember("strict", strict)
		format.setMember("json_schema", inner)
		payload.setMember("response_format", format)
	}
	return payload, nil
}

// pinnedAimlapiPlan is the generate transform: literal target, own body, own headers.
func pinnedAimlapiPlan(body orderedNodeJSON, directories startup.UserDirectories) (*outbound.Request, *pinnedChatCompletionFailure) {
	payload, failure := pinnedAimlapiPayload(body)
	if failure != nil {
		return nil, failure
	}
	keyNode, secretErr := pinnedReadSecret(directories, pinnedAimlapiSecretKey, pinnedSecretID(body))
	if secretErr != nil {
		// :1290 readSecret throws into the OUTER try, whose catch answers 200 {"error":true}.
		return nil, pinnedChatCompletionJSONFailure(http.StatusOK, pinnedChatCompletionErrorFlag())
	}
	key, keyErr := pinnedJSStringValue(keyNode)
	if keyErr != nil {
		return nil, pinnedChatCompletionJSONFailure(http.StatusOK, pinnedChatCompletionErrorFlag())
	}
	if key == "" {
		// :1293-1296 `response.status(400).send({ error: true })` -- and, unlike its siblings, there is
		// NO reverse_proxy escape here.
		return nil, pinnedChatCompletionJSONFailure(http.StatusBadRequest, pinnedChatCompletionErrorFlag())
	}
	encoded, encodeErr := marshalOrderedNodeJSON(payload)
	if encodeErr != nil {
		return nil, pinnedChatCompletionJSONFailure(http.StatusOK, pinnedChatCompletionErrorFlag())
	}
	headers := map[string]string{
		"content-type":    "application/json",
		"authorization":   "Bearer " + key,
		"accept":          "*/*",
		"accept-encoding": "gzip, deflate, br",
		"user-agent":      "node-fetch",
		"content-length":  strconv.Itoa(len(encoded)),
	}
	for _, entry := range pinnedAimlapiHeaders().object {
		value, valueErr := pinnedJSStringValue(entry.value)
		if valueErr != nil {
			return nil, pinnedChatCompletionJSONFailure(http.StatusOK, pinnedChatCompletionErrorFlag())
		}
		headers[lowerHeaderName(entry.key)] = value
	}
	endpointURL := pinnedAimlapiBaseURL() + "/chat/completions"
	parsedEndpoint, parseErr := url.Parse(endpointURL)
	if parseErr != nil || parsedEndpoint.Host == "" {
		return nil, pinnedChatCompletionJSONFailure(http.StatusOK, pinnedChatCompletionErrorFlag())
	}
	names := make([]string, 0, len(headers)+2)
	for name := range headers {
		names = append(names, name)
	}
	sort.Strings(names)
	requestHeaders := make([]outbound.Header, 0, len(names)+2)
	for _, name := range names {
		requestHeaders = append(requestHeaders, outbound.Header{Name: name, Value: headers[name]})
	}
	requestHeaders = append(requestHeaders, outbound.Header{Name: "Host", Value: pinnedRequestHostHeader(parsedEndpoint)})
	requestHeaders = append(requestHeaders, outbound.Header{Name: "Connection", Value: "close"})
	return &outbound.Request{URL: endpointURL, Method: http.MethodPost, Headers: requestHeaders, Body: encoded}, nil
}

// lowerHeaderName lowercases a header name, which is the form node-fetch sends and the wire capture
// records.
func lowerHeaderName(name string) string {
	lowered := make([]byte, len(name))
	for index := 0; index < len(name); index++ {
		character := name[index]
		if character >= 'A' && character <= 'Z' {
			character = character + ('a' - 'A')
		}
		lowered[index] = character
	}
	return string(lowered)
}

// serveAimlapiChatCompletionResponse is the aimlapi response side (:1359-1382): the shared forwarder for
// a stream (with NO ok-check), the PARSED provider body at 500 for a non-stream non-2xx, a 2xx body
// passed through unchanged, and 200 {"error":true} for anything that throws.
func serveAimlapiChatCompletionResponse(w http.ResponseWriter, request *http.Request, response *outbound.Response, body orderedNodeJSON) {
	if pinnedChatCompletionStreams(body) {
		forwardPinnedChatCompletionStream(w, request, response)
		return
	}
	defer response.Stream.Close()
	providerBody, readErr := io.ReadAll(response.Stream)
	if readErr != nil && !errors.Is(readErr, io.EOF) {
		respondOrderedNodeJSON(w, http.StatusOK, pinnedChatCompletionErrorFlag())
		return
	}
	if response.Status < 200 || response.Status > 299 {
		// `tryParse(errorText) ?? { error: true }` -- a non-JSON error body becomes the bare flag.
		parsed, parseErr := decodeOrderedNodeJSON(providerBody)
		if parseErr != nil {
			respondOrderedNodeJSON(w, http.StatusInternalServerError, pinnedChatCompletionErrorFlag())
			return
		}
		respondOrderedNodeJSON(w, http.StatusInternalServerError, parsed)
		return
	}
	parsed, parseErr := decodeOrderedNodeJSON(providerBody)
	if parseErr != nil {
		respondOrderedNodeJSON(w, http.StatusOK, pinnedChatCompletionErrorFlag())
		return
	}
	respondOrderedNodeJSON(w, http.StatusOK, parsed)
}

// serveAimlapiChatCompletionStatus is the AIMLAPI arm of the pinned status matrix (:1832-1835) plus the
// shared tail: the literal, the aimlapi secret, and `{ ...AIMLAPI_HEADERS }` on the models GET.
func (runtime *accountRuntime) serveAimlapiChatCompletionStatus(w http.ResponseWriter, request *http.Request, body orderedNodeJSON, directories startup.UserDirectories) {
	errorOnly := nodeObject()
	errorOnly.setMember("error", nodeBool(true))
	keyNode, secretErr := pinnedReadSecret(directories, pinnedAimlapiSecretKey, pinnedSecretID(body))
	if secretErr != nil {
		searchJSON(w, errorOnly)
		return
	}
	key, keyErr := pinnedJSStringValue(keyNode)
	if keyErr != nil {
		searchJSON(w, errorOnly)
		return
	}
	// :2067 -- the missing-key refusal consults `request.body.reverse_proxy` even though this source
	// never uses that member for its URL (the same quirk the OPENROUTER and GROQ arms document).
	reverseProxyTruthy := false
	if reverseProxy, exists := body.member("reverse_proxy"); exists && pinnedJSTruthy(reverseProxy) {
		reverseProxyTruthy = true
	}
	if key == "" && !reverseProxyTruthy {
		pinnedChatCompletionMissingKeyRefusal(w)
		return
	}
	headers := map[string]string{"authorization": "Bearer " + key}
	for _, entry := range pinnedAimlapiHeaders().object {
		value, valueErr := pinnedJSStringValue(entry.value)
		if valueErr != nil {
			searchJSON(w, errorOnly)
			return
		}
		headers[lowerHeaderName(entry.key)] = value
	}
	response, fetchErr := searchFetch(request.Context(), searchRequest{
		Method:  http.MethodGet,
		URL:     sdURLJoin(pinnedAimlapiBaseURL(), "/models"),
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
