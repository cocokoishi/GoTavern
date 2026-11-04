package server

// Pinned remote tokenizer routes, from src/endpoints/tokenizers.js.
//
// This file owns BOTH remote passthrough routes:
//
//	/remote/kobold/count              tokenizers.js:1037-1070
//	/remote/textgenerationwebui/encode tokenizers.js:1072-1124
//
// THEY ARE DELIBERATELY NOT THE SAME KIND OF ROUTE. /remote/kobold/count calls fetch directly and never
// calls setAdditionalHeaders (tokenizers.js:1044-1052), so it needs nothing from the provider-auth domain.
// /remote/textgenerationwebui/encode calls `setAdditionalHeaders(request, args, baseUrl)`
// (tokenizers.js:1084) and is therefore wired through the SHARED provider helpers rather than through a
// private copy of proxy/SSRF logic:
//
//	trimV1                     -> searchTrimV1           (internal/server/search.go)
//	TEXTGEN_TYPES + the switch -> textgenTokenizeRequestFor (below, the single owner of the suffix/payload table)
//	auth-header shaping        -> backendsAdditionalHeaders -> setAdditionalHeadersByType
//	target-URL construction    -> textgenTokenizeTarget      (below)
//	requestOverrides           -> pinnedApplyRequestOverrides (request_overrides.go)
//	node-fetch + SSRF/proxy    -> backendsFetch -> searchFetch -> internal/outbound
//
// The outbound call goes through the shared client. A zero timeout is passed because the pinned handler
// uses fetch with no timeout at all, and outbound already treats a zero duration as "no deadline" (net.Dialer
// with a zero Timeout does not time out, and the SetDeadline call is skipped), so this needs no change to
// that package. A pinned capture (tests/oracle/sillytavern-1.19.0-tokenizer-textgen-remote.json,
// `no_timeout#slow_upstream`) records a 250 ms provider answer being accepted, which is the observable
// form of "no short deadline"; the pinned source has no AbortSignal at all.

import (
	"encoding/json"
	"github.com/cocokoishi/gotavern/internal/httpx"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"unicode/utf16"

	"github.com/cocokoishi/gotavern/internal/outbound"
)

// tokenizerNodeString is JavaScript's String(value) for the values a JSON body can hold,
// which is what the pinned routes apply to text and url before using them.
func tokenizerNodeString(raw json.RawMessage) (string, bool) {
	if len(raw) == 0 {
		return "", false
	}
	if string(raw) == "null" {
		return "null", true
	}
	var text string
	if err := json.Unmarshal(raw, &text); err == nil {
		return text, true
	}
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		return "", false
	}
	switch typed := value.(type) {
	case bool:
		if typed {
			return "true", true
		}
		return "false", true
	case float64:
		return tokenizerNodeNumber(typed), true
	}
	return "", false
}

// tokenizerNodeNumber formats a JSON number the way JavaScript's String() does for the
// values the pinned corpus contains. Exponential notation for very large or very small
// magnitudes is not reproduced and is recorded as unverified in the plan.
func tokenizerNodeNumber(value float64) string {
	return strconv.FormatFloat(value, 'f', -1, 64)
}
func (runtime *accountRuntime) serveRemoteKoboldCount(w http.ResponseWriter, request *http.Request) {
	body, bodyOK := tokenizerRawBody(request)
	if !bodyOK {
		httpx.WriteStatusText(w, http.StatusBadRequest)
		return
	}
	input := map[string]json.RawMessage{}
	if len(body) > 0 {
		_ = json.Unmarshal(body, &input)
	}
	text, textPresent := tokenizerNodeString(input["text"])
	if !textPresent {
		// String(undefined) is the string "undefined"; the pinned handler would send it.
		text = "undefined"
	}
	baseURL, urlPresent := tokenizerNodeString(input["url"])
	if !urlPresent {
		// String(undefined) makes fetch fail, which the pinned catch turns into {error:true}.
		respondJSON(w, http.StatusOK, map[string]any{"error": true})
		return
	}

	target := strings.TrimSuffix(baseURL, "/") + "/extra/tokencount"
	payload, err := marshalNodeJSON(map[string]string{"prompt": text})
	if err != nil {
		respondJSON(w, http.StatusOK, map[string]any{"error": true})
		return
	}
	parsedTarget, err := url.Parse(target)
	if err != nil {
		respondJSON(w, http.StatusOK, map[string]any{"error": true})
		return
	}
	response, err := outbound.Send(request.Context(), outbound.Request{
		URL:    target,
		Method: http.MethodPost,
		Headers: []outbound.Header{
			// outbound writes the head verbatim and supplies none of the framing that fetch
			// adds, so the route provides it: Host, the content type and the length.
			{Name: "Host", Value: parsedTarget.Host},
			{Name: "Content-Type", Value: "application/json"},
			{Name: "Content-Length", Value: strconv.Itoa(len(payload))},
		},
		Body: payload,
	}, 0)
	if err != nil || response.Status < 200 || response.Status > 299 {
		respondJSON(w, http.StatusOK, map[string]any{"error": true})
		return
	}

	// The pinned handler reads data.value and data.ids ?? [], and JSON.stringify drops a
	// count key whose value is undefined, so a reply without "value" answers {ids: ...} only.
	var data map[string]json.RawMessage
	if err := json.Unmarshal(response.Body, &data); err != nil {
		respondJSON(w, http.StatusOK, map[string]any{"error": true})
		return
	}
	answer := map[string]any{}
	if value, present := data["value"]; present {
		var decoded any
		if err := json.Unmarshal(value, &decoded); err == nil {
			answer["count"] = decoded
		}
	}
	ids := any([]any{})
	if raw, present := data["ids"]; present {
		var decoded any
		if err := json.Unmarshal(raw, &decoded); err == nil {
			ids = decoded
		}
	}
	answer["ids"] = ids
	respondJSON(w, http.StatusOK, answer)
}

// ---- /remote/textgenerationwebui/encode ---------------------------------------------------

// textgenTokenizePayload is the pinned per-api_type request body (tokenizers.js:1091-1117). Every member
// order below is the pinned object literal's order, because the provider receives JSON.stringify of it.
func textgenTokenizePayload(apiType, text, model string) (orderedNodeJSON, bool) {
	switch apiType {
	case "tabby": // tokenizers.js:1092-1095
		payload := nodeObject()
		payload.setMember("text", nodeString(text))
		payload.setMember("add_bos_token", nodeBool(false))
		payload.setMember("encode_special_tokens", nodeBool(false))
		return payload, true
	case "koboldcpp": // tokenizers.js:1096-1099
		payload := nodeObject()
		payload.setMember("prompt", nodeString(text))
		payload.setMember("special", nodeBool(false))
		return payload, true
	case "llamacpp": // tokenizers.js:1100-1103
		payload := nodeObject()
		payload.setMember("model", nodeString(model))
		payload.setMember("content", nodeString(text))
		return payload, true
	case "vllm": // tokenizers.js:1104-1107
		payload := nodeObject()
		payload.setMember("model", nodeString(model))
		payload.setMember("prompt", nodeString(text))
		return payload, true
	case "aphrodite": // tokenizers.js:1108-1111
		payload := nodeObject()
		payload.setMember("model", nodeString(model))
		payload.setMember("prompt", nodeString(text))
		return payload, true
	case "ooba": // tokenizers.js:1112-1115
		payload := nodeObject()
		payload.setMember("text", nodeString(text))
		return payload, true
	default: // tokenizers.js:1116-1117 `default: return response.sendStatus(400);`
		return orderedNodeJSON{}, false
	}
}

// textgenTokenizeSuffix is the pinned api_type -> URL path table. The suffix is appended AFTER trimV1, so
// the configured base URL's trailing `/` and `/v1` are already removed by the caller.
func textgenTokenizeSuffix(apiType string) (string, bool) {
	switch apiType {
	case "tabby":
		return "/v1/token/encode", true
	case "koboldcpp":
		return "/api/extra/tokencount", true
	case "llamacpp", "vllm":
		return "/tokenize", true
	case "aphrodite":
		return "/v1/tokenize", true
	case "ooba":
		return "/v1/internal/encode", true
	default:
		return "", false
	}
}

// tokenizerJSONProperty is JavaScript property access `<value>.<key>` that CANNOT throw: the optional
// chain in the pinned projection (`data?.length`) short-circuits null/undefined to undefined, an array or
// string exposes `length` (strings in UTF-16 code units, like JavaScript), and an object exposes its own
// member. A JSON null has no members, so it answers undefined rather than a Go nil.
func tokenizerJSONProperty(value orderedNodeJSON, key string) orderedNodeJSON {
	switch value.kind {
	case 'o':
		if member, exists := value.member(key); exists {
			return member
		}
		return nodeUndefined()
	case 'a':
		if key == "length" {
			return nodeNumber(float64(len(value.array)))
		}
		return nodeUndefined()
	case 's':
		if key == "length" {
			text, _ := value.stringValue()
			return nodeNumber(float64(len(utf16.Encode([]rune(text)))))
		}
		return nodeUndefined()
	default:
		return nodeUndefined()
	}
}

// tokenizerNullish is the `??` operator.
func tokenizerNullish(first, second orderedNodeJSON) orderedNodeJSON {
	if first.isNull() || first.isUndefined() {
		return second
	}
	return first
}

// serveRemoteTextGenerationEncode reproduces tokenizers.js:1072-1124, the remote text-generation-webui
// tokenizer passthrough. The pinned source, because every branch below is one of its lines:
//
//	const text = String(request.body.text) || '';
//	const baseUrl = String(request.body.url);
//	const model = String(request.body.model) || '';
//	const args = { method: 'POST', headers: { 'Content-Type': 'application/json' } };
//	setAdditionalHeaders(request, args, baseUrl);
//	let url = trimV1(baseUrl);
//	switch (request.body.api_type) { ...tabby|koboldcpp|llamacpp|vllm|aphrodite|ooba...; default: sendStatus(400) }
//	const result = await fetch(url, args);
//	if (!result.ok) { console.warn(...); return response.send({ error: true }); }
//	const data = await result.json();
//	const count = (data?.length ?? data?.count ?? data?.value ?? data?.tokens?.length);
//	const ids = (data?.tokens ?? data?.ids ?? []);
//	return response.send({ count, ids });
//
// The three string coercions are JavaScript's `String(value)`, NOT "read it if it is a string": an absent
// `text`/`model` becomes the literal "undefined" (recorded on the wire by coerce#missing_text and
// coerce#missing_model), and `String(42)` is "42" (coerce#text_number). `baseUrl` has no fallback operator, so
// an absent URL becomes "undefined", trimV1 leaves it, and the fetch throws on an invalid URL -- the
// error#missing_url case.
func (runtime *accountRuntime) serveRemoteTextGenerationEncode(w http.ResponseWriter, request *http.Request) {
	_, directories, ok := runtime.sdUser(w, request)
	if !ok {
		return
	}
	body, bodyOK := runtime.sdRequestBody(w, request)
	if !bodyOK {
		return
	}

	text := searchJSString(sdBodyMember(body, "text"))
	baseURL := searchJSString(sdBodyMember(body, "url"))
	model := searchJSString(sdBodyMember(body, "model"))

	// The pinned order is Content-Type FIRST (the args literal), then setAdditionalHeaders'
	// `Object.assign(requestHeaders, headers)`, whose last act is the requestOverrides assignment.
	headers, headersErr := backendsAdditionalHeaders(body, directories)
	if headersErr != nil {
		httpx.WriteStatusText(w, http.StatusInternalServerError)
		return
	}
	headers["content-type"] = "application/json"
	pinnedApplyRequestOverrides(directories, baseURL, headers)

	apiTypeNode := sdBodyMember(body, "api_type")
	apiType, apiTypeIsString := apiTypeNode.stringValue()
	if !apiTypeIsString {
		// The pinned switch is over the RAW value: a missing or non-string api_type matches no case.
		httpx.WriteStatusText(w, http.StatusBadRequest)
		return
	}
	suffix, supported := textgenTokenizeSuffix(apiType)
	if !supported {
		httpx.WriteStatusText(w, http.StatusBadRequest)
		return
	}
	payloadNode, payloadOK := textgenTokenizePayload(apiType, text, model)
	if !payloadOK {
		httpx.WriteStatusText(w, http.StatusBadRequest)
		return
	}
	payload, payloadErr := marshalOrderedNodeJSON(payloadNode)
	if payloadErr != nil {
		respondJSON(w, http.StatusOK, map[string]any{"error": true})
		return
	}
	target := searchTrimV1(nodeString(baseURL)) + suffix

	response, responseOK, fetchErr := backendsPost(request, target, headers, payload)
	if fetchErr != nil {
		// `catch (error) { console.error(error); return response.send({ error: true }); }`: a malformed URL,
		// an unreachable endpoint or a transport refusal all land here with NO provider request sent.
		consoleErrorf(tokenizerConsoleWriter(runtime.options), "%v\n", fetchErr)
		respondJSON(w, http.StatusOK, map[string]any{"error": true})
		return
	}
	if !responseOK {
		consoleWarnf(tokenizerConsoleWriter(runtime.options), "API returned error: %d %s\n", response.Status, http.StatusText(response.Status))
		respondJSON(w, http.StatusOK, map[string]any{"error": true})
		return
	}

	data, decodeErr := decodeOrderedNodeJSON(response.Body)
	if decodeErr != nil {
		// `await result.json()` throws on an empty or non-JSON 2xx body; the pinned catch answers the
		// same {error:true} envelope as a non-2xx status, but through a DIFFERENT branch.
		respondJSON(w, http.StatusOK, map[string]any{"error": true})
		return
	}
	// `data?.length ?? data?.count ?? data?.value ?? data?.tokens?.length`
	count := tokenizerNullish(
		tokenizerJSONProperty(data, "length"),
		tokenizerNullish(
			tokenizerJSONProperty(data, "count"),
			tokenizerNullish(
				tokenizerJSONProperty(data, "value"),
				tokenizerJSONProperty(tokenizerJSONProperty(data, "tokens"), "length"),
			),
		),
	)
	// `data?.tokens ?? data?.ids ?? []`
	ids := tokenizerNullish(
		tokenizerJSONProperty(data, "tokens"),
		tokenizerNullish(tokenizerJSONProperty(data, "ids"), nodeArray()),
	)
	answer := nodeObject()
	if !count.isUndefined() {
		// `res.send({count, ids})` -> JSON.stringify drops an undefined member, which is why a reply with
		// only an ids array answers `{"ids": ...}` and no count key at all.
		answer.setMember("count", count)
	}
	answer.setMember("ids", ids)
	respondOrderedNodeJSON(w, http.StatusOK, answer)
}
