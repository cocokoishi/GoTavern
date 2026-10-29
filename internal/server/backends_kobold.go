package server

// Pinned kobold backend routes, from src/endpoints/backends/kobold.js:
//
//	POST /status  (143)  three concurrent probes with per-probe defaults
//	POST /embed   (241)  precomputed-input embeddings proxy
//
// THE "DEFERRED" SENTENCE THAT STOOD HERE WAS WRONG, corrected 2026-10-29 by reading the registrations: both
// routes it called `not implemented` are registered in `backends_kobold_deferred.go:66-67` --
// `/api/backends/kobold/generate` (the streaming proxy with retry and cancellation) and
// `/api/backends/kobold/transcribe-audio` (the multipart upload). The file name says "deferred" and the routes
// are implemented, which is the same trap in the other direction.
//
// Pinned crash, deliberately not reproduced: /status has no try/catch, so a request whose
// api_server is missing or not a string throws inside the async handler and the pinned process
// exits. GoTavern answers 500 instead; the fixture records this and does not replay such a request.

import (
	"math"
	"net/http"
	"strconv"
	"strings"
)

// backendsKoboldRewriteLocalhost is the pinned `api_server.replace('localhost', '127.0.0.1')`
// (first occurrence only).
func backendsKoboldRewriteLocalhost(apiServer string) string {
	if !strings.Contains(apiServer, "localhost") {
		return apiServer
	}
	return strings.Replace(apiServer, "localhost", "127.0.0.1", 1)
}

// serveBackendsKoboldStatus is kobold.js:143.
func (runtime *accountRuntime) serveBackendsKoboldStatus(w http.ResponseWriter, request *http.Request) {
	_, directories, ok := runtime.sdUser(w, request)
	if !ok {
		return
	}
	body, ok := runtime.sdRequestBody(w, request)
	if !ok {
		return
	}
	apiServerNode := sdBodyMember(body, "api_server")
	apiServer, err := pinnedJSStringValue(apiServerNode)
	if err != nil || apiServerNode.kind != 's' {
		// The pinned handler throws here and the process exits; a server must not die, so this
		// answers the route's usual failure status instead (documented deviation).
		backendsStatus(w, http.StatusInternalServerError)
		return
	}
	apiServer = backendsKoboldRewriteLocalhost(apiServer)
	headers, err := backendsAdditionalHeaders(body, directories)
	if err != nil {
		backendsStatus(w, http.StatusInternalServerError)
		return
	}
	headers["content-type"] = "application/json"
	// kobold.js:150-154: the Content-Type literal, then `setAdditionalHeaders(request, args, api_server)`,
	// whose last act is the `requestOverrides` Object.assign -- so the override wins over both the content type
	// and the secret-backed headers.
	pinnedApplyRequestOverrides(directories, apiServer, headers)

	// Pinned Promise.all order: united version, extra version, model. Each request catches its own
	// failure and substitutes a default object.
	united := nodeObjectWith("result", nodeString("0.0.0"))
	if response, responseOK, fetchErr := backendsGet(request, apiServer+"/v1/info/version", nil); fetchErr == nil && responseOK {
		if data, parsed := sdReadJSON(response); parsed {
			united = data
		}
	}
	extra := nodeObjectWith("version", nodeString("0.0"))
	if response, responseOK, fetchErr := backendsGet(request, apiServer+"/extra/version", nil); fetchErr == nil && responseOK {
		if data, parsed := sdReadJSON(response); parsed {
			extra = data
		}
	}
	model := orderedNodeJSON{kind: 'n'}
	if response, responseOK, fetchErr := backendsGet(request, apiServer+"/v1/model", nil); fetchErr == nil && responseOK {
		if data, parsed := sdReadJSON(response); parsed {
			model = data
		}
	}

	result := nodeObject()
	if version, exists := united.member("result"); exists {
		result.setMember("koboldUnitedVersion", version)
	}
	if version, exists := extra.member("result"); exists {
		result.setMember("koboldCppVersion", version)
	}
	modelResult := nodeUndefined()
	if model.kind != 'n' && model.kind != nodeUndefinedKind {
		if value, exists := model.member("result"); exists {
			modelResult = value
		}
	}
	if model.kind == 'n' || model.kind == nodeUndefinedKind || (modelResult.kind == 's' && modelResult.scalar.(string) == "ReadOnly") {
		result.setMember("model", nodeString("no_connection"))
	} else if !modelResult.isUndefined() {
		result.setMember("model", modelResult)
	}
	backendsJSON(w, result)
}

// nodeObjectWith is a convenience for a one-member JS object literal.
func nodeObjectWith(key string, value orderedNodeJSON) orderedNodeJSON {
	object := nodeObject()
	object.setMember(key, value)
	return object
}

// serveBackendsKoboldEmbed is kobold.js:241. The response items are mapped to their first element
// when already arrays, sorted by `index`, then projected to `embedding`.
func (runtime *accountRuntime) serveBackendsKoboldEmbed(w http.ResponseWriter, request *http.Request) {
	_, directories, ok := runtime.sdUser(w, request)
	if !ok {
		return
	}
	body, ok := runtime.sdRequestBody(w, request)
	if !ok {
		return
	}
	serverNode := sdBodyMember(body, "server")
	if !pinnedJSTruthy(serverNode) {
		backendsStatus(w, http.StatusBadRequest)
		return
	}
	parsedServer, validServer := searchURLValue(serverNode)
	if !validServer {
		backendsEmbedInternalError(w)
		return
	}
	headers, err := backendsAdditionalHeadersForType(body, "koboldcpp", directories)
	if err != nil {
		backendsEmbedInternalError(w)
		return
	}
	// kobold.js:209-210: `const headers = {}` then `setAdditionalHeadersByType(headers, KOBOLDCPP, server, ...)`,
	// so the override is the last assignment made to this set. `server` is the RAW body member, not the
	// re-serialised URL, because that is the string the pinned `new URL(server)` parses.
	pinnedApplyRequestOverrides(directories, backendsStringMember(serverNode), headers)
	target := sdURLWithPath(parsedServer, "/api/extra/embeddings")
	payload := nodeObject()
	if items := sdBodyMember(body, "items"); !items.isUndefined() {
		payload.setMember("input", items)
	}
	encoded, err := marshalOrderedNodeJSON(payload)
	if err != nil {
		backendsEmbedInternalError(w)
		return
	}
	response, err := backendsFetch(request, searchRequest{Method: http.MethodPost, URL: target, Headers: headers, Body: encoded})
	if err != nil {
		backendsEmbedInternalError(w)
		return
	}
	// No ok check: the pinned handler parses whatever body arrived.
	data, parsed := sdReadJSON(response)
	if !parsed {
		backendsEmbedInternalError(w)
		return
	}
	entries, exists := sdMemberOf(data, "data")
	if !exists || entries.kind != 'a' {
		backendsStatus(w, http.StatusInternalServerError)
		return
	}
	// `.map(x => Array.isArray(x) ? x[0] : x)`
	items := make([]orderedNodeJSON, 0, len(entries.array))
	for _, entry := range entries.array {
		if entry.kind == 'a' {
			if len(entry.array) == 0 {
				items = append(items, nodeUndefined())
			} else {
				items = append(items, entry.array[0])
			}
			continue
		}
		items = append(items, entry)
	}
	// `.sort((a, b) => a.index - b.index)` with stable order for NaN comparisons.
	for _, item := range items {
		if item.kind == 'n' || item.kind == nodeUndefinedKind {
			backendsEmbedInternalError(w)
			return
		}
	}
	indexes := make([]float64, len(items))
	order := make([]int, len(items))
	for index, item := range items {
		member, memberOK := sdMemberOf(item, "index")
		if !memberOK {
			backendsEmbedInternalError(w)
			return
		}
		indexes[index] = pinnedJSToNumber(member)
		order[index] = index
	}
	for position := 1; position < len(order); position++ {
		current := order[position]
		previous := position - 1
		for previous >= 0 && backendsLess(indexes[current], indexes[order[previous]]) {
			order[previous+1] = order[previous]
			previous--
		}
		order[previous+1] = current
	}
	embeddings := nodeArray()
	for _, index := range order {
		embedding, memberOK := sdMemberOf(items[index], "embedding")
		if !memberOK {
			backendsEmbedInternalError(w)
			return
		}
		embeddings.array = append(embeddings.array, embedding)
	}
	model := nodeString("unknown")
	if value, exists := sdMemberOf(data, "model"); exists && pinnedJSTruthy(value) {
		model = value
	}
	result := nodeObject()
	result.setMember("model", model)
	result.setMember("embeddings", embeddings)
	backendsJSON(w, result)
}

// backendsLess reports whether the comparator a.index - b.index is negative, treating NaN as zero
// (V8's stable sort) so equal/undefined indexes keep their order.
func backendsLess(left, right float64) bool {
	if math.IsNaN(left) || math.IsNaN(right) {
		return false
	}
	return left-right < 0
}

// backendsEmbedInternalError is the pinned catch branch: `response.status(500).send('Internal
// server error')`, a text/html body.
func backendsEmbedInternalError(w http.ResponseWriter) {
	respondText(w, http.StatusInternalServerError, "text/html; charset=utf-8", "Internal server error")
}

var _ = strconv.Itoa
