// Wave 3 of the SD generation routes: the two routes whose upstream URL comes from the REQUEST BODY
// (`request.body.url`), so no provider seam exists or is needed — the caller names the server. They
// are single-shot: no polling loop, no provider-supplied follow-up URL.
//
//   /api/sd/sdcpp/generate       stable-diffusion.js:867
//   /api/sd/drawthings/generate  stable-diffusion.js:977

package server

import (
	"context"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/cocokoishi/gotavern/internal/outbound"
)

// sdDropsBodyValue is the pinned payload cleanup shared by both routes: a member whose value is
// `undefined`, `null` or the empty string is removed before the request is sent.
func sdDropsBodyValue(value orderedNodeJSON) bool {
	if value.isUndefined() || value.isNull() {
		return true
	}
	if value.isString() {
		text, _ := value.stringValue()
		return text == ""
	}
	return false
}

// sdJSNumberGreaterThanOne is `value > 1` with JavaScript ToNumber coercion, which decides whether
// the sd.cpp payload carries clip_skip (it is dropped for the default of 1, which produces blank
// images).
func sdJSNumberGreaterThanOne(value orderedNodeJSON) bool {
	switch value.kind {
	case 'v':
		number, _ := value.scalar.(float64)
		return number > 1
	case 's':
		text, _ := value.stringValue()
		number, err := strconv.ParseFloat(strings.TrimSpace(text), 64)
		return err == nil && number > 1
	case 'b':
		flag, _ := value.scalar.(bool)
		return flag
	default:
		return false
	}
}

// serveSDSdcppGenerate is stable-diffusion.js:867. The payload is a fixed projection of the request
// body in a fixed member order, cleaned of undefined/null/empty members, sent with only a JSON
// content type (no authorization), and the provider JSON is re-serialized to the caller.
func (runtime *accountRuntime) serveSDSdcppGenerate(w http.ResponseWriter, request *http.Request) {
	if _, _, ok := runtime.sdUser(w, request); !ok {
		return
	}
	body, ok := runtime.sdRequestBody(w, request)
	if !ok {
		return
	}
	parsed, ok := sdBodyURL(w, body)
	if !ok {
		return
	}
	payload := nodeObject()
	for _, key := range []string{"model", "prompt", "negative_prompt", "width", "height", "steps", "cfg_scale", "seed", "batch_size", "sampler_name", "scheduler"} {
		value := sdBodyMember(body, key)
		if sdDropsBodyValue(value) {
			continue
		}
		payload.setMember(key, value)
	}
	if clipSkip := sdBodyMember(body, "clip_skip"); !sdDropsBodyValue(clipSkip) && sdJSNumberGreaterThanOne(clipSkip) {
		payload.setMember("clip_skip", clipSkip)
	}
	encoded, err := marshalOrderedNodeJSON(payload)
	if err != nil {
		serveSDStatus(w, http.StatusInternalServerError)
		return
	}
	// sdPostJSON sends exactly the declared headers, which is the convention these provider
	// fixtures record: the pinned hook sees the headers the route passes, not node-fetch's
	// transport defaults.
	data, ok := sdPostJSON(request, sdURLWithPath(parsed, "/sdapi/v1/txt2img"), []outbound.Header{{Name: "Content-Type", Value: "application/json"}}, encoded)
	if !ok {
		serveSDStatus(w, http.StatusInternalServerError)
		return
	}
	searchJSON(w, data)
}

// serveSDDrawThingsGenerate is stable-diffusion.js:977. The whole request body is forwarded in its
// original member order minus `url` and `auth`, with a JSON content type and the Basic auth header
// built from `auth` (which is ALWAYS sent, including the string "undefined" when it is absent,
// because getBasicAuthHeader stringifies).
func (runtime *accountRuntime) serveSDDrawThingsGenerate(w http.ResponseWriter, request *http.Request) {
	if _, _, ok := runtime.sdUser(w, request); !ok {
		return
	}
	body, ok := runtime.sdRequestBody(w, request)
	if !ok {
		return
	}
	parsed, ok := sdBodyURL(w, body)
	if !ok {
		return
	}
	authorization, ok := sdBasicAuthHeader(sdBodyMember(body, "auth"))
	if !ok {
		serveSDStatus(w, http.StatusInternalServerError)
		return
	}
	payload := nodeObject()
	for _, entry := range body.object {
		if entry.key == "url" || entry.key == "auth" {
			continue
		}
		payload.setMember(entry.key, entry.value)
	}
	encoded, err := marshalOrderedNodeJSON(payload)
	if err != nil {
		serveSDStatus(w, http.StatusInternalServerError)
		return
	}
	data, ok := sdPostJSON(request, sdURLWithPath(parsed, "/sdapi/v1/txt2img"), []outbound.Header{
		{Name: "Content-Type", Value: "application/json"},
		{Name: "Authorization", Value: authorization},
	}, encoded)
	if !ok {
		serveSDStatus(w, http.StatusInternalServerError)
		return
	}
	searchJSON(w, data)
}

// sdUnsetForgeModules is `_.unset(request.body, 'override_settings.forge_additional_modules')`: the
// member is removed while every other member keeps its position. A body whose override_settings is
// not an object is returned unchanged, which is what lodash's unset does to a non-object parent.
func sdUnsetForgeModules(body orderedNodeJSON) orderedNodeJSON {
	settings, exists := body.member("override_settings")
	if !exists || settings.kind != 'o' {
		return body
	}
	trimmed := nodeObject()
	for _, entry := range settings.object {
		if entry.key == "forge_additional_modules" {
			continue
		}
		trimmed.setMember(entry.key, entry.value)
	}
	rebuilt := nodeObject()
	for _, entry := range body.object {
		if entry.key == "override_settings" {
			rebuilt.setMember(entry.key, trimmed)
			continue
		}
		rebuilt.setMember(entry.key, entry.value)
	}
	return rebuilt
}

// serveSDA1111Generate is stable-diffusion.js:297 (the plain `/api/sd/generate` route).
//
// TWO requests, and the fixture records the count: an options GET first (Forge detection, whose
// failure is SWALLOWED by the pinned inner try), then the txt2img POST with the whole — possibly
// mutated — request body. A non-Forge server loses `override_settings.forge_additional_modules`.
// The pinned route also registers a socket-close handler that POSTs `{url}/sdapi/v1/interrupt` and
// aborts the generation; the Go side mirrors that by watching the request context.
func (runtime *accountRuntime) serveSDA1111Generate(w http.ResponseWriter, request *http.Request) {
	if _, _, ok := runtime.sdUser(w, request); !ok {
		return
	}
	body, ok := runtime.sdRequestBody(w, request)
	if !ok {
		return
	}
	parsed, ok := sdBodyURL(w, body)
	if !ok {
		return
	}
	authorization, ok := sdBasicAuthHeader(sdBodyMember(body, "auth"))
	if !ok {
		serveSDStatus(w, http.StatusInternalServerError)
		return
	}
	// The provider convention: send exactly the declared headers (the fixture records what the route
	// passes, not node-fetch's transport defaults), so this uses sdGetJSON rather than sdFetch.
	if optionsData, optionsOK := sdGetJSON(request, sdURLWithPath(parsed, "/sdapi/v1/options"), []outbound.Header{{Name: "Authorization", Value: authorization}}); optionsOK {
		if _, isForge := optionsData.member("forge_preset"); !isForge {
			body = sdUnsetForgeModules(body)
		}
	}
	// Cancellation leg: the pinned handler POSTs the interrupt as soon as the caller goes away. The
	// interrupt uses a fresh context because the request's own context is already cancelled.
	go func() {
		<-request.Context().Done()
		_, _ = sdFetch(context.Background(), sdRequest{
			Method:  http.MethodPost,
			URL:     sdURLWithPath(parsed, "/sdapi/v1/interrupt"),
			Headers: map[string]string{"authorization": authorization},
		})
	}()
	encoded, err := marshalOrderedNodeJSON(body)
	if err != nil {
		serveSDStatus(w, http.StatusInternalServerError)
		return
	}
	data, ok := sdPostJSON(request, sdURLWithPath(parsed, "/sdapi/v1/txt2img"), []outbound.Header{
		{Name: "Content-Type", Value: "application/json"},
		{Name: "Authorization", Value: authorization},
	}, encoded)
	if !ok {
		serveSDStatus(w, http.StatusInternalServerError)
		return
	}
	searchJSON(w, data)
}

// sdGetJSON is the GET counterpart of sdPostJSON: it sends exactly the declared headers, which is the
// convention these provider fixtures record, and parses a JSON answer. A non-2xx or unparseable body
// reports false, which is how the A1111 options probe treats a failure (it is swallowed).
func sdGetJSON(request *http.Request, target string, headers []outbound.Header) (orderedNodeJSON, bool) {
	all := append([]outbound.Header{{Name: "Host", Value: hostOf(target)}}, headers...)
	response, err := outbound.Send(request.Context(), outbound.Request{
		URL:     target,
		Method:  http.MethodGet,
		Headers: all,
	}, 120*time.Second)
	if err != nil || !outboundOK(response) {
		return orderedNodeJSON{}, false
	}
	decoded, err := decodeOrderedNodeJSON(response.Body)
	if err != nil {
		return orderedNodeJSON{}, false
	}
	return decoded, true
}
