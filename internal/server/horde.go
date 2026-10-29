package server

// Pinned Horde startup routes that block a frontend send, from src/endpoints/horde.js:
//
//	POST /api/horde/status      horde.js:128
//	POST /api/horde/text-models horde.js:96
//
// SCOPE, CORRECTED 2026-10-29: this file registers the three STARTUP routes, and the rest of the Horde domain
// is NOT absent -- `horde_generation.go:93-100` registers eight more (`/cancel-task`, `/task-status`,
// `/generate-text`, `/sd-samplers`, `/sd-models`, `/caption-image`, `/user-info`, `/generate-image`). The
// sentence that stood here said "the rest of the Horde domain ... is not implemented here or claimed
// anywhere", which understated the product by eleven routes and is exactly the phantom-boundary class a
// missing/stub sweep is told to collect. The registrations are the answer; a header is not.
//
// Both are outbound routes, so they follow the project-level convention in
// docs/tokenizer-parity-plan.md §11: the upstream URL is a seam that DEFAULTS TO THE PINNED URL
// (asserted by a test so the default cannot drift), the tests point the seam at a local mock, and
// nothing about a third-party answer is recorded as a constant.
//
// Two pinned behaviours that a careful implementation would get wrong, so they are called out:
//
//   - `/status` answers `{ok: <fetch ok>}` for a RESOLVED fetch, so a non-2xx peer produces
//     `{ok:false}` with our own status 200; only a REJECTED fetch (connection refused) reaches the
//     catch and answers 500. Adding a "if !ok return 500" guard would look more correct and would
//     diverge on exactly the non-2xx case.
//   - `/text-models` does NOT check `response.ok` before parsing: a non-2xx response carrying valid
//     JSON is returned AS-IS. A metadata fetch failure is caught and logged, and the unmerged list
//     is still returned.
//
// KNOWN LIMITATION, measured by tests/browser/generation-probe.mjs: `outbound.Send` dials plain TCP and
// does not perform a TLS handshake, so it cannot reach these HTTPS upstreams. Against a local mock the
// routes are correct and fully tested; against the real pinned URL they answer 500. That is a
// transport capability gap in the shared client, not a route defect, and it must be closed before
// these routes can be called compatible.

import (
	"encoding/json"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/cocokoishi/gotavern/internal/outbound"
)

const (
	hordeDefaultAPIURL      = "https://aihorde.net"
	hordeDefaultMetadataURL = "https://raw.githubusercontent.com/db0/AI-Horde-text-model-reference/main/db.json"
	hordeModelsCacheTTL     = 60 * time.Second
)

// hordeAPIBaseURL is the seam for the Horde API. The default is the pinned URL and is asserted.
func hordeAPIBaseURL() string {
	if override := strings.TrimSpace(os.Getenv("GOTAVERN_HORDE_API_URL")); override != "" {
		return strings.TrimSuffix(override, "/")
	}
	return hordeDefaultAPIURL
}

// hordeMetadataURL is the seam for the second outbound call /text-models makes.
func hordeMetadataURL() string {
	if override := strings.TrimSpace(os.Getenv("GOTAVERN_HORDE_METADATA_URL")); override != "" {
		return strings.TrimSuffix(override, "/")
	}
	return hordeDefaultMetadataURL
}

// hordeModelsCache mirrors the pinned `new Cache(60 * 1000)` keyed by "models". The workers route
// uses the same TTL under its own key, so the two caches share this type rather than one rule each.
type hordeModelsCacheType struct {
	mu      sync.Mutex
	body    []byte
	expires time.Time
}

var (
	hordeModels  = &hordeModelsCacheType{}
	hordeWorkers = &hordeModelsCacheType{}
)

func (cache *hordeModelsCacheType) get() ([]byte, bool) {
	cache.mu.Lock()
	defer cache.mu.Unlock()
	if cache.body == nil || time.Now().After(cache.expires) {
		cache.body = nil
		return nil, false
	}
	return cache.body, true
}

func (cache *hordeModelsCacheType) set(body []byte) {
	cache.mu.Lock()
	defer cache.mu.Unlock()
	cache.body = body
	cache.expires = time.Now().Add(hordeModelsCacheTTL)
}

func (cache *hordeModelsCacheType) clear() {
	cache.mu.Lock()
	defer cache.mu.Unlock()
	cache.body = nil
}

func init() {
	domainRouteRegistrars = append(domainRouteRegistrars, registerHordeRoutes)
}

func registerHordeRoutes(mux *http.ServeMux, accounts *accountRuntime, notFoundPage []byte, options HTTPHandlerOptions) {
	post := func(route string, handler func(http.ResponseWriter, *http.Request)) {
		mux.HandleFunc(route, func(w http.ResponseWriter, r *http.Request) {
			if r.Method != http.MethodPost {
				serveStatic(w, r, notFoundPage, options)
				return
			}
			handler(w, r)
		})
	}
	post("/api/horde/status", accounts.serveHordeStatus)
	post("/api/horde/text-models", accounts.serveHordeTextModels)
	post("/api/horde/text-workers", accounts.serveHordeTextWorkers)
}

// hordeGet performs the pinned outbound GET with the Client-Agent header.
func hordeGet(request *http.Request, target string) (*outbound.Response, error) {
	headers := []outbound.Header{{Name: "Client-Agent", Value: upstreamAgent}}
	if parsed, err := url.Parse(target); err == nil {
		headers = append([]outbound.Header{{Name: "Host", Value: parsed.Host}}, headers...)
	}
	return outbound.Send(request.Context(), outbound.Request{
		URL:     target,
		Method:  http.MethodGet,
		Headers: headers,
	}, 0)
}

// serveHordeStatus answers {ok: <2xx>} for a resolved fetch, 500 for a rejected one.
func (runtime *accountRuntime) serveHordeStatus(w http.ResponseWriter, request *http.Request) {
	response, err := hordeGet(request, hordeAPIBaseURL()+"/api/v2/status/heartbeat")
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	respondJSON(w, http.StatusOK, map[string]bool{"ok": response.Status >= 200 && response.Status <= 299})
}

// serveHordeTextModels proxies the model list, merges best-effort metadata, and caches the result.
func (runtime *accountRuntime) serveHordeTextModels(w http.ResponseWriter, request *http.Request) {
	force := false
	if _, input, ok := readUserPresetRequestBody(request); ok {
		force = nodeTruthyJSON(input["force"])
	}
	if !force {
		if cached, present := hordeModels.get(); present {
			respondJSONBytes(w, http.StatusOK, cached)
			return
		}
	}

	response, err := hordeGet(request, hordeAPIBaseURL()+"/api/v2/status/models?type=text")
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	// No `response.ok` check here, deliberately: the pinned handler calls json() directly, so a
	// non-2xx response carrying valid JSON is returned as-is. Adding the guard would be a
	// divergence that no ordinary test would notice.
	var models any
	if err := json.Unmarshal(response.Body, &models); err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	if merged, ok := mergeHordeModelsMetadata(request, models); ok {
		models = merged
	}
	body, err := json.Marshal(models)
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	hordeModels.set(body)
	respondJSONBytes(w, http.StatusOK, body)
}

// mergeHordeModelsMetadata reproduces the pinned merge: for each model, `{...model, ...metadata[name],
// is_whitelisted: <metadata present>}`. A metadata failure is logged by omission and the unmerged
// list is kept, because the pinned handler catches that error and still returns the list.
func mergeHordeModelsMetadata(request *http.Request, models any) (any, bool) {
	list, isList := models.([]any)
	if !isList {
		return nil, false
	}
	response, err := hordeGet(request, hordeMetadataURL())
	if err != nil {
		return nil, false
	}
	var metadata map[string]any
	if err := json.Unmarshal(response.Body, &metadata); err != nil {
		return nil, false
	}
	merged := make([]any, 0, len(list))
	for _, entry := range list {
		model, isObject := entry.(map[string]any)
		if !isObject {
			merged = append(merged, entry)
			continue
		}
		combined := map[string]any{}
		for key, value := range model {
			combined[key] = value
		}
		name, _ := model["name"].(string)
		extra, hasMetadata := metadata[name]
		if hasMetadata {
			if extraObject, ok := extra.(map[string]any); ok {
				for key, value := range extraObject {
					combined[key] = value
				}
			}
		}
		combined["is_whitelisted"] = hasMetadata
		merged = append(merged, combined)
	}
	return merged, true
}

// serveHordeTextWorkers is the same shape as text-models with a different upstream path and cache
// key (horde.js:58): cached under "workers", no `ok` guard before parsing, cache set, and 500 when
// the fetch is rejected or the body is not JSON.
func (runtime *accountRuntime) serveHordeTextWorkers(w http.ResponseWriter, request *http.Request) {
	force := false
	if _, input, ok := readUserPresetRequestBody(request); ok {
		force = nodeTruthyJSON(input["force"])
	}
	if !force {
		if cached, present := hordeWorkers.get(); present {
			respondJSONBytes(w, http.StatusOK, cached)
			return
		}
	}
	response, err := hordeGet(request, hordeAPIBaseURL()+"/api/v2/workers?type=text")
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	// THE PROVIDER'S BYTES ARE REPRODUCED THE WAY PINNED REPRODUCES THEM, NOT THE WAY Go WOULD BY DEFAULT.
	//
	// Pinned does `fetch(...).then(res => res.json()).then(data => response.send(data))`
	// (src/endpoints/horde.js:67-74), and Express's `send` on an object runs `JSON.stringify`. That has two
	// observable consequences Go's `json.Marshal` on a `map[string]any` gets WRONG:
	//
	//   member ORDER   JSON.stringify preserves the parsed insertion order, so the provider's own member order
	//                  survives; Go sorts map keys alphabetically.
	//   HTML escaping  JSON.stringify does NOT escape `<`, `>` or `&`; Go's encoder writes `\u003c`, `\u003e`
	//                  and `\u0026` unless `SetEscapeHTML(false)` is set.
	//
	// Both are byte-level differences on a browser-facing route, and the weak ETag `respondJSONBytes` computes
	// is derived from those bytes, so the two differences are observable together. The project already owns the
	// correct serialiser for JavaScript semantics -- `decodeOrderedNodeJSON` plus `marshalOrderedNodeJSON`, whose
	// string path (`marshalNodeJSONString` -> `marshalNodeJSON` with `SetEscapeHTML(false)`, then U+2028/U+2029
	// un-escaped) is exactly `JSON.stringify` -- so this uses it rather than re-deriving one.
	//
	// THE EXISTING TEST COULD NOT SEE EITHER DIFFERENCE: `horde_test.go`'s fixture is a SINGLE-member object with
	// no HTML characters, and a one-member object has no order to get wrong (AGENTS.md rule 15: "what input would
	// make this assertion fail?" had no answer in it). The test beside this change uses a multi-member,
	// non-alphabetical body carrying `<`, `&` and a non-BMP character.
	workers, err := decodeOrderedNodeJSON(response.Body)
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	body, err := marshalOrderedNodeJSON(workers)
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	hordeWorkers.set(body)
	respondJSONBytes(w, http.StatusOK, body)
}
