package server

// Pinned remote tokenizer routes, from src/endpoints/tokenizers.js.
//
// This file owns /remote/kobold/count (tokenizers.js:1030-1070). It is the one remote route
// that does NOT call setAdditionalHeaders, so it needs nothing from the proxy/SSRF domain and
// can be wired here. /remote/textgenerationwebui/encode (tokenizers.js:1072) does call
// setAdditionalHeaders and depends on trimV1 and the TEXTGEN_TYPES constants, so it stays
// `not implemented` until that domain exists; copying those helpers here would fork
// proxy-domain logic and diverge from it later.
//
// The outbound call goes through the shared client. A zero timeout is passed because the
// pinned handler uses fetch with no timeout at all, and outbound already treats a zero
// duration as "no deadline" (net.Dialer with a zero Timeout does not time out, and the
// SetDeadline call is skipped), so this needs no change to that package.

import (
	"encoding/json"
	"net/http"
	"net/url"
	"strconv"
	"strings"

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
		serveStatusText(w, http.StatusBadRequest)
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
