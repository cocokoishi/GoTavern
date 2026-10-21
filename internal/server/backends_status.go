package server

// Pinned /api/backends/chat-completions/status, from
// src/endpoints/backends/chat-completions.js:1778.
//
// IMPLEMENTED: the CUSTOM source. The pinned tail joins urlJoin(custom_url, "/models"), GETs it with
// `Authorization: Bearer <custom key>` plus any custom_include_headers, passes an OK body through
// unchanged, answers `{ error: true, data: { data: [] } }` for a non-OK response, and `{ error: true }`
// when the fetch or the key read throws.
//
// NOT IMPLEMENTED: every other source in the pinned 380-line provider matrix answers 501 (rule 17), so
// an unimplemented source stays distinguishable from pinned's 400 unknown-source answer. The chat
// completions row keeps that visible.
//
// Evidence: tools/probe-backends.mjs records the `status.custom.*` scenarios in
// tests/oracle/sillytavern-1.19.0-backends.json; backends_test.go replays them.

import (
	"net/http"
	"strings"
)

func init() {
	// Registration happens in registerBackendsRoutes; nothing to add here.
}

// serveBackendsChatCompletionStatus is chat-completions.js:1778, custom branch + 501 for the rest.
func (runtime *accountRuntime) serveBackendsChatCompletionStatus(w http.ResponseWriter, request *http.Request) {
	_, directories, ok := runtime.sdUser(w, request)
	if !ok {
		return
	}
	body, ok := runtime.sdRequestBody(w, request)
	if !ok {
		return
	}
	source, _ := sdBodyMember(body, "chat_completion_source").stringValue()
	if source != "custom" {
		serveStatusText(w, http.StatusNotImplemented)
		return
	}
	errorOnly := nodeObject()
	errorOnly.setMember("error", nodeBool(true))
	customURLNode, exists := body.member("custom_url")
	if !exists {
		// `urlJoin(undefined, "/models")` throws, and the pinned catch answers { error: true }.
		searchJSON(w, errorOnly)
		return
	}
	customURL, stringErr := pinnedJSStringValue(customURLNode)
	if stringErr != nil {
		searchJSON(w, errorOnly)
		return
	}
	keyNode, secretErr := pinnedReadSecret(directories, "api_key_custom", pinnedSecretID(body))
	if secretErr != nil {
		searchJSON(w, errorOnly)
		return
	}
	key, keyErr := pinnedJSStringValue(keyNode)
	if keyErr != nil {
		searchJSON(w, errorOnly)
		return
	}
	headers := map[string]string{"authorization": "Bearer " + key}
	if includeHeaders, includeExists := body.member("custom_include_headers"); includeExists {
		customHeaders := nodeObject()
		pinnedMergeObjectWithYAML(&customHeaders, includeHeaders)
		for _, entry := range customHeaders.object {
			headerName := strings.ToLower(entry.key)
			headerValue, valueErr := pinnedJSStringValue(entry.value)
			if valueErr != nil {
				searchJSON(w, errorOnly)
				return
			}
			headers[headerName] = headerValue
		}
	}
	response, fetchErr := searchFetch(request.Context(), searchRequest{
		Method:  http.MethodGet,
		URL:     sdURLJoin(customURL, "/models"),
		Headers: headers,
	})
	if fetchErr != nil {
		searchJSON(w, errorOnly)
		return
	}
	if !sdResponseOK(response) {
		failure := nodeObject()
		failure.setMember("error", nodeBool(true))
		data := nodeObject()
		data.setMember("data", nodeArray())
		failure.setMember("data", data)
		searchJSON(w, failure)
		return
	}
	parsed, parsedOK := sdReadJSON(response)
	if !parsedOK {
		searchJSON(w, errorOnly)
		return
	}
	searchJSON(w, parsed)
}
