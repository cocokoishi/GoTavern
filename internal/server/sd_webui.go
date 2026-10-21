package server

// The /api/sd routes whose upstream is either `request.body.url` (an SD WebUI / ComfyUI /
// stable-diffusion.cpp / DrawThings base URL supplied by the browser) or a RunPod endpoint with
// the same shape. Pinned source: src/endpoints/stable-diffusion.js lines noted per handler.
//
// These routes are differential-tested by internal/server/sd_routes_test.go against
// tests/oracle/sillytavern-1.19.0-sd-routes.json. Every recorded response status, content type,
// content length, ETag and body is compared, as is every header the mock peer received
// (the `connection` header is classified `shape` in the fixture because it is transport framing,
// not route behaviour).

import (
	"context"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/cocokoishi/gotavern/internal/outbound"
)

// sdBodyURL parses `new URL(request.body.url)` or answers 500 when the pinned handler would
// throw. It is the first statement of every SD WebUI route's try block.
func sdBodyURL(w http.ResponseWriter, body orderedNodeJSON) (*url.URL, bool) {
	parsed, ok := sdURLValue(sdBodyMember(body, "url"))
	if !ok {
		serveSDStatus(w, http.StatusInternalServerError)
		return nil, false
	}
	return parsed, true
}

// serveSDPing is stable-diffusion.js:31: GET <url>/sdapi/v1/options with the Basic auth header,
// 200 when the peer answers 2xx.
func (runtime *accountRuntime) serveSDPing(w http.ResponseWriter, request *http.Request) {
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
	response, err := sdFetch(request.Context(), sdRequest{
		Method:  http.MethodGet,
		URL:     sdURLWithPath(parsed, "/sdapi/v1/options"),
		Headers: map[string]string{"authorization": authorization},
	})
	if err != nil || !sdResponseOK(response) {
		serveSDStatus(w, http.StatusInternalServerError)
		return
	}
	serveSDStatus(w, http.StatusOK)
}

// sdSDWebUIRequest is the header/auth shape every SD WebUI model-list route uses: the path is
// replaced on the body URL and the Basic auth header is always sent.
func sdSDWebUIRequest(parsed *url.URL, pathname, authorization string) sdRequest {
	return sdRequest{
		Method:  http.MethodGet,
		URL:     sdURLWithPath(parsed, pathname),
		Headers: map[string]string{"authorization": authorization},
	}
}

// sdFetchSDWebUI runs one SD WebUI GET and reports whether it resolved with a 2xx status.
func sdFetchSDWebUI(ctx context.Context, parsed *url.URL, pathname, authorization string) (*outbound.Response, bool) {
	response, err := sdFetch(ctx, sdSDWebUIRequest(parsed, pathname, authorization))
	if err != nil || !sdResponseOK(response) {
		return nil, false
	}
	return response, true
}

// serveSDUpscalers is stable-diffusion.js:54: both lists are fetched, and the latent upscalers are
// spliced in at index 1 (0 is "None" in the frontend's option list).
func (runtime *accountRuntime) serveSDUpscalers(w http.ResponseWriter, request *http.Request) {
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
	type fetchResult struct {
		response *outbound.Response
		ok       bool
	}
	results := make([]fetchResult, 2)
	done := make(chan struct{}, 2)
	paths := [2]string{"/sdapi/v1/upscalers", "/sdapi/v1/latent-upscale-modes"}
	for index, pathname := range paths {
		go func(index int, pathname string) {
			response, fetchOK := sdFetchSDWebUI(request.Context(), parsed, pathname, authorization)
			results[index] = fetchResult{response: response, ok: fetchOK}
			done <- struct{}{}
		}(index, pathname)
	}
	for range paths {
		<-done
	}
	names := make([]orderedNodeJSON, 2)
	for index := range results {
		if !results[index].ok {
			serveSDStatus(w, http.StatusInternalServerError)
			return
		}
		data, ok := sdReadJSON(results[index].response)
		if !ok {
			serveSDStatus(w, http.StatusInternalServerError)
			return
		}
		mapped, ok := sdArrayMember(data, "name")
		if !ok {
			serveSDStatus(w, http.StatusInternalServerError)
			return
		}
		names[index] = mapped
	}
	serveSDRespondJSON(w, sdSpliceAfterFirst(names[0], names[1]))
}

// serveSDVaes is stable-diffusion.js:108: the automatic1111 and forge endpoints are both asked,
// with Promise.allSettled, and the FIRST fulfilled answer in that order is used even when the
// other endpoint also answered. A fulfilled answer that is not an array then fails the route.
func (runtime *accountRuntime) serveSDVaes(w http.ResponseWriter, request *http.Request) {
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
	// allSettled: both requests are always attempted, and a fulfilled value means "2xx and a
	// JSON body", because the pinned .then rejects on !ok and .json() rejects on a bad body.
	type settled struct {
		data orderedNodeJSON
		ok   bool
	}
	results := make([]settled, 2)
	for index, pathname := range []string{"/sdapi/v1/sd-vae", "/sdapi/v1/sd-modules"} {
		response, fetchOK := sdFetchSDWebUI(request.Context(), parsed, pathname, authorization)
		if !fetchOK {
			continue
		}
		data, parsedOK := sdReadJSON(response)
		if !parsedOK {
			continue
		}
		results[index] = settled{data: data, ok: true}
	}
	var chosen orderedNodeJSON
	found := false
	for _, result := range results {
		if result.ok {
			chosen, found = result.data, true
			break
		}
	}
	if !found || chosen.kind != 'a' {
		serveSDStatus(w, http.StatusInternalServerError)
		return
	}
	names, ok := sdArrayMember(chosen, "model_name")
	if !ok {
		serveSDStatus(w, http.StatusInternalServerError)
		return
	}
	serveSDRespondJSON(w, names)
}

// serveSDSamplers is stable-diffusion.js:140.
func (runtime *accountRuntime) serveSDSamplers(w http.ResponseWriter, request *http.Request) {
	runtime.serveSDNamedList(w, request, "/sdapi/v1/samplers", "name")
}

// serveSDSchedulers is stable-diffusion.js:166.
func (runtime *accountRuntime) serveSDSchedulers(w http.ResponseWriter, request *http.Request) {
	runtime.serveSDNamedList(w, request, "/sdapi/v1/schedulers", "name")
}

// serveSDModels is stable-diffusion.js:192: each model title becomes a {value, text} option.
func (runtime *accountRuntime) serveSDModels(w http.ResponseWriter, request *http.Request) {
	runtime.serveSDNamedList(w, request, "/sdapi/v1/sd-models", "title")
}

// serveSDNamedList is the shared shape of samplers/schedulers/models: one GET, a 2xx check, then
// `data.map(x => x.<member>)` or `({value: x.title, text: x.title})`.
func (runtime *accountRuntime) serveSDNamedList(w http.ResponseWriter, request *http.Request, pathname, member string) {
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
	response, fetchOK := sdFetchSDWebUI(request.Context(), parsed, pathname, authorization)
	if !fetchOK {
		serveSDStatus(w, http.StatusInternalServerError)
		return
	}
	data, ok := sdReadJSON(response)
	if !ok {
		serveSDStatus(w, http.StatusInternalServerError)
		return
	}
	names, ok := sdArrayMember(data, member)
	if !ok {
		serveSDStatus(w, http.StatusInternalServerError)
		return
	}
	if member == "name" {
		// samplers/schedulers return the names, not option objects.
		serveSDRespondJSON(w, names)
		return
	}
	serveSDRespondJSON(w, sdNameOptions(names))
}

// serveSDGetModel is stable-diffusion.js:218. Note that this handler does NOT check result.ok:
// a non-2xx peer carrying valid JSON is answered as if it succeeded, which is exactly what the
// recorded nonOkJson scenario observes.
func (runtime *accountRuntime) serveSDGetModel(w http.ResponseWriter, request *http.Request) {
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
	response, err := sdFetch(request.Context(), sdSDWebUIRequest(parsed, "/sdapi/v1/options", authorization))
	if err != nil {
		serveSDStatus(w, http.StatusInternalServerError)
		return
	}
	data, ok := sdReadJSON(response)
	if !ok {
		serveSDStatus(w, http.StatusInternalServerError)
		return
	}
	value, ok := sdMemberOf(data, "sd_model_checkpoint")
	if !ok {
		serveSDStatus(w, http.StatusInternalServerError)
		return
	}
	serveSDValue(w, value)
}

// serveSDSetModel is stable-diffusion.js:238: POST the checkpoint, then poll /progress up to ten
// times, two seconds apart, until it reports progress 0 and a job count of 0.
func (runtime *accountRuntime) serveSDSetModel(w http.ResponseWriter, request *http.Request) {
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
	options := nodeObject()
	if model := sdBodyMember(body, "model"); !model.isUndefined() {
		options.setMember("sd_model_checkpoint", model)
	}
	payload, err := marshalOrderedNodeJSON(options)
	if err != nil {
		serveSDStatus(w, http.StatusInternalServerError)
		return
	}
	response, err := sdFetch(request.Context(), sdRequest{
		Method:  http.MethodPost,
		URL:     sdURLWithPath(parsed, "/sdapi/v1/options"),
		Headers: map[string]string{"content-type": "application/json", "authorization": authorization},
		Body:    payload,
	})
	if err != nil || !sdResponseOK(response) {
		serveSDStatus(w, http.StatusInternalServerError)
		return
	}
	for attempt := 0; attempt < 10; attempt++ {
		progressResponse, progressErr := sdFetch(request.Context(), sdSDWebUIRequest(parsed, "/sdapi/v1/progress", authorization))
		if progressErr != nil {
			serveSDStatus(w, http.StatusInternalServerError)
			return
		}
		// getProgress() does not check result.ok either: it parses whatever body arrived.
		progressState, ok := sdReadJSON(progressResponse)
		if !ok {
			serveSDStatus(w, http.StatusInternalServerError)
			return
		}
		progress, ok := sdMemberOf(progressState, "progress")
		if !ok {
			serveSDStatus(w, http.StatusInternalServerError)
			return
		}
		jobState, ok := sdMemberOf(progressState, "state")
		if !ok {
			serveSDStatus(w, http.StatusInternalServerError)
			return
		}
		jobCount, ok := sdMemberOf(jobState, "job_count")
		if !ok {
			serveSDStatus(w, http.StatusInternalServerError)
			return
		}
		if sdStrictNumberZero(progress) && sdStrictNumberZero(jobCount) {
			break
		}
		if !sdSleep(request.Context(), 2*time.Second) {
			serveSDStatus(w, http.StatusInternalServerError)
			return
		}
	}
	serveSDStatus(w, http.StatusOK)
}

// serveSDSDNextUpscalers is stable-diffusion.js:352: Vlad's API does not expose latent
// upscalers, so the pinned handler hardcodes them.
func (runtime *accountRuntime) serveSDSDNextUpscalers(w http.ResponseWriter, request *http.Request) {
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
	response, fetchOK := sdFetchSDWebUI(request.Context(), parsed, "/sdapi/v1/upscalers", authorization)
	if !fetchOK {
		serveSDStatus(w, http.StatusInternalServerError)
		return
	}
	data, ok := sdReadJSON(response)
	if !ok {
		serveSDStatus(w, http.StatusInternalServerError)
		return
	}
	names, ok := sdArrayMember(data, "name")
	if !ok {
		serveSDStatus(w, http.StatusInternalServerError)
		return
	}
	// src/endpoints/stable-diffusion.js:369, in order.
	latent := nodeArray(
		nodeString("Latent"),
		nodeString("Latent (antialiased)"),
		nodeString("Latent (bicubic)"),
		nodeString("Latent (bicubic antialiased)"),
		nodeString("Latent (nearest)"),
		nodeString("Latent (nearest-exact)"),
	)
	serveSDRespondJSON(w, sdSpliceAfterFirst(names, latent))
}

// ---- comfy body-url routes ---------------------------------------------------------------

// sdComfyURL reproduces `new URL(urlJoin(request.body.url, <path>))`.
func sdComfyURL(w http.ResponseWriter, body orderedNodeJSON, pathname string) (*url.URL, bool) {
	raw, err := pinnedJSStringValue(sdBodyMember(body, "url"))
	if err != nil {
		serveSDStatus(w, http.StatusInternalServerError)
		return nil, false
	}
	parsed, ok := sdParseAbsoluteURL(sdURLJoin(raw, pathname))
	if !ok {
		serveSDStatus(w, http.StatusInternalServerError)
		return nil, false
	}
	return parsed, true
}

// serveSDComfyPing is stable-diffusion.js:387.
func (runtime *accountRuntime) serveSDComfyPing(w http.ResponseWriter, request *http.Request) {
	if _, _, ok := runtime.sdUser(w, request); !ok {
		return
	}
	body, ok := runtime.sdRequestBody(w, request)
	if !ok {
		return
	}
	parsed, ok := sdComfyURL(w, body, "/system_stats")
	if !ok {
		return
	}
	response, err := sdFetch(request.Context(), sdRequest{Method: http.MethodGet, URL: parsed.String()})
	if err != nil || !sdResponseOK(response) {
		serveSDStatus(w, http.StatusInternalServerError)
		return
	}
	serveSDStatus(w, http.StatusOK)
}

// sdComfyObjectInfo fetches /object_info for the comfy routes that read ComfyUI's node schema.
func sdComfyObjectInfo(ctx context.Context, parsed *url.URL) (orderedNodeJSON, bool) {
	response, err := sdFetch(ctx, sdRequest{Method: http.MethodGet, URL: parsed.String()})
	if err != nil || !sdResponseOK(response) {
		return orderedNodeJSON{}, false
	}
	return sdReadJSON(response)
}

// sdObjectInfoChoices reproduces `data.<node>.input.required.<field>[0]`.
func sdObjectInfoChoices(data orderedNodeJSON, node, field string) (orderedNodeJSON, bool) {
	nodeValue, ok := sdMemberOf(data, node)
	if !ok {
		return orderedNodeJSON{}, false
	}
	input, ok := sdMemberOf(nodeValue, "input")
	if !ok {
		return orderedNodeJSON{}, false
	}
	required, ok := sdMemberOf(input, "required")
	if !ok {
		return orderedNodeJSON{}, false
	}
	choices, ok := sdMemberOf(required, field)
	if !ok {
		return orderedNodeJSON{}, false
	}
	return sdIndex(choices, 0)
}

// serveSDComfySamplers is stable-diffusion.js:403.
func (runtime *accountRuntime) serveSDComfySamplers(w http.ResponseWriter, request *http.Request) {
	runtime.serveSDComfyChoices(w, request, "KSampler", "sampler_name")
}

// serveSDComfySchedulers is stable-diffusion.js:449.
func (runtime *accountRuntime) serveSDComfySchedulers(w http.ResponseWriter, request *http.Request) {
	runtime.serveSDComfyChoices(w, request, "KSampler", "scheduler")
}

// serveSDComfyVaes is stable-diffusion.js:467.
func (runtime *accountRuntime) serveSDComfyVaes(w http.ResponseWriter, request *http.Request) {
	runtime.serveSDComfyChoices(w, request, "VAELoader", "vae_name")
}

func (runtime *accountRuntime) serveSDComfyChoices(w http.ResponseWriter, request *http.Request, node, field string) {
	if _, _, ok := runtime.sdUser(w, request); !ok {
		return
	}
	body, ok := runtime.sdRequestBody(w, request)
	if !ok {
		return
	}
	parsed, ok := sdComfyURL(w, body, "/object_info")
	if !ok {
		return
	}
	data, ok := sdComfyObjectInfo(request.Context(), parsed)
	if !ok {
		serveSDStatus(w, http.StatusInternalServerError)
		return
	}
	choices, ok := sdObjectInfoChoices(data, node, field)
	if !ok {
		serveSDStatus(w, http.StatusInternalServerError)
		return
	}
	serveSDRespondJSON(w, choices)
}

// serveSDComfyModels is stable-diffusion.js:421: checkpoints, UNETLoader models and, when the
// GGUF loader node exists, GGUF unets; every display name then has its extension removed and its
// underscores turned into spaces.
func (runtime *accountRuntime) serveSDComfyModels(w http.ResponseWriter, request *http.Request) {
	if _, _, ok := runtime.sdUser(w, request); !ok {
		return
	}
	body, ok := runtime.sdRequestBody(w, request)
	if !ok {
		return
	}
	parsed, ok := sdComfyURL(w, body, "/object_info")
	if !ok {
		return
	}
	data, ok := sdComfyObjectInfo(request.Context(), parsed)
	if !ok {
		serveSDStatus(w, http.StatusInternalServerError)
		return
	}
	models := nodeArray()
	for _, loader := range []struct{ node, field, prefix string }{
		{"CheckpointLoaderSimple", "ckpt_name", ""},
		{"UNETLoader", "unet_name", "UNet: "},
	} {
		choices, ok := sdObjectInfoChoices(data, loader.node, loader.field)
		if !ok || choices.kind != 'a' {
			serveSDStatus(w, http.StatusInternalServerError)
			return
		}
		options, ok := sdPrefixedOptions(choices, loader.prefix)
		if !ok {
			serveSDStatus(w, http.StatusInternalServerError)
			return
		}
		models.array = append(models.array, options.array...)
	}
	// `data.UnetLoaderGGUF?.input...` only runs when the node is present.
	ggufNode, ok := sdMemberOf(data, "UnetLoaderGGUF")
	if !ok {
		serveSDStatus(w, http.StatusInternalServerError)
		return
	}
	if !ggufNode.isUndefined() {
		choices, ok := sdObjectInfoChoices(data, "UnetLoaderGGUF", "unet_name")
		if !ok || choices.kind != 'a' {
			serveSDStatus(w, http.StatusInternalServerError)
			return
		}
		options, ok := sdPrefixedOptions(choices, "GGUF: ")
		if !ok {
			serveSDStatus(w, http.StatusInternalServerError)
			return
		}
		models.array = append(models.array, options.array...)
	}
	// `models.forEach(it => it.text = it.text.replace(...))` — a non-string choice throws.
	for index := range models.array {
		text, exists := models.array[index].member("text")
		if !exists {
			serveSDStatus(w, http.StatusInternalServerError)
			return
		}
		value, ok := text.stringValue()
		if !ok {
			serveSDStatus(w, http.StatusInternalServerError)
			return
		}
		models.array[index].setMember("text", nodeString(sdComfyDisplayName(value)))
	}
	serveSDRespondJSON(w, models)
}

// ---- comfy runpod ------------------------------------------------------------------------

// serveSDComfyRunPodPing is stable-diffusion.js:637: a missing secret answers 400 before any
// request, then /health is fetched with the RunPod bearer token.
func (runtime *accountRuntime) serveSDComfyRunPodPing(w http.ResponseWriter, request *http.Request) {
	_, directories, ok := runtime.sdUser(w, request)
	if !ok {
		return
	}
	body, ok := runtime.sdRequestBody(w, request)
	if !ok {
		return
	}
	key, err := sdReadSecret(directories, "api_key_comfy_runpod")
	if err != nil {
		serveSDStatus(w, http.StatusInternalServerError)
		return
	}
	if !sdTruthyString(key) {
		serveSDStatus(w, http.StatusBadRequest)
		return
	}
	parsed, ok := sdComfyURL(w, body, "/health")
	if !ok {
		return
	}
	response, err := sdFetch(request.Context(), sdRequest{
		Method:  http.MethodGet,
		URL:     parsed.String(),
		Headers: map[string]string{"authorization": "Bearer " + key},
	})
	if err != nil || !sdResponseOK(response) {
		serveSDStatus(w, http.StatusInternalServerError)
		return
	}
	data, ok := sdReadJSON(response)
	if !ok {
		serveSDStatus(w, http.StatusInternalServerError)
		return
	}
	// `data.workers.ready <= 0` only logs a warning, but reading it throws when `workers` is
	// absent or not an object, and that throw is what answers 500.
	workers, ok := sdMemberOf(data, "workers")
	if !ok {
		serveSDStatus(w, http.StatusInternalServerError)
		return
	}
	if _, ok := sdMemberOf(workers, "ready"); !ok {
		serveSDStatus(w, http.StatusInternalServerError)
		return
	}
	serveSDStatus(w, http.StatusOK)
}

// ---- stable-diffusion.cpp ----------------------------------------------------------------

// serveSDSDCppPing is stable-diffusion.js:834: an OPTIONS request to the generations endpoint.
func (runtime *accountRuntime) serveSDSDCppPing(w http.ResponseWriter, request *http.Request) {
	if _, _, ok := runtime.sdUser(w, request); !ok {
		return
	}
	body, ok := runtime.sdRequestBody(w, request)
	if !ok {
		return
	}
	parsed, ok := sdComfyURL(w, body, "/v1/images/generations")
	if !ok {
		return
	}
	response, err := sdFetch(request.Context(), sdRequest{Method: http.MethodOptions, URL: parsed.String()})
	if err != nil || !sdResponseOK(response) {
		serveSDStatus(w, http.StatusInternalServerError)
		return
	}
	serveSDStatus(w, http.StatusOK)
}

// serveSDSDCppModels is stable-diffusion.js:850: the model list is returned unmodified.
func (runtime *accountRuntime) serveSDSDCppModels(w http.ResponseWriter, request *http.Request) {
	if _, _, ok := runtime.sdUser(w, request); !ok {
		return
	}
	body, ok := runtime.sdRequestBody(w, request)
	if !ok {
		return
	}
	parsed, ok := sdComfyURL(w, body, "/v1/models")
	if !ok {
		return
	}
	response, err := sdFetch(request.Context(), sdRequest{Method: http.MethodGet, URL: parsed.String()})
	if err != nil || !sdResponseOK(response) {
		serveSDStatus(w, http.StatusInternalServerError)
		return
	}
	data, ok := sdReadJSON(response)
	if !ok {
		serveSDStatus(w, http.StatusInternalServerError)
		return
	}
	serveSDValue(w, data)
}

// ---- drawthings --------------------------------------------------------------------------

// sdDrawThingsURL replaces the body URL's path with '/' (`url.pathname = '/'`).
func sdDrawThingsURL(w http.ResponseWriter, body orderedNodeJSON) (*url.URL, bool) {
	parsed, ok := sdBodyURL(w, body)
	if !ok {
		return nil, false
	}
	target, ok := sdParseAbsoluteURL(sdURLWithPath(parsed, "/"))
	if !ok {
		serveSDStatus(w, http.StatusInternalServerError)
		return nil, false
	}
	return target, true
}

// serveSDDrawThingsPing is stable-diffusion.js:919: a HEAD request to the root URL.
func (runtime *accountRuntime) serveSDDrawThingsPing(w http.ResponseWriter, request *http.Request) {
	if _, _, ok := runtime.sdUser(w, request); !ok {
		return
	}
	body, ok := runtime.sdRequestBody(w, request)
	if !ok {
		return
	}
	target, ok := sdDrawThingsURL(w, body)
	if !ok {
		return
	}
	response, err := sdFetch(request.Context(), sdRequest{Method: http.MethodHead, URL: target.String()})
	if err != nil || !sdResponseOK(response) {
		serveSDStatus(w, http.StatusInternalServerError)
		return
	}
	serveSDStatus(w, http.StatusOK)
}

// serveSDDrawThingsGetModel is stable-diffusion.js:939. Like get-model it does not check
// result.ok before parsing.
func (runtime *accountRuntime) serveSDDrawThingsGetModel(w http.ResponseWriter, request *http.Request) {
	runtime.serveSDDrawThingsMember(w, request, "model")
}

// serveSDDrawThingsGetUpscaler is stable-diffusion.js:958.
func (runtime *accountRuntime) serveSDDrawThingsGetUpscaler(w http.ResponseWriter, request *http.Request) {
	runtime.serveSDDrawThingsMember(w, request, "upscaler")
}

func (runtime *accountRuntime) serveSDDrawThingsMember(w http.ResponseWriter, request *http.Request, member string) {
	if _, _, ok := runtime.sdUser(w, request); !ok {
		return
	}
	body, ok := runtime.sdRequestBody(w, request)
	if !ok {
		return
	}
	target, ok := sdDrawThingsURL(w, body)
	if !ok {
		return
	}
	response, err := sdFetch(request.Context(), sdRequest{Method: http.MethodGet, URL: target.String()})
	if err != nil {
		serveSDStatus(w, http.StatusInternalServerError)
		return
	}
	data, ok := sdReadJSON(response)
	if !ok {
		serveSDStatus(w, http.StatusInternalServerError)
		return
	}
	value, ok := sdMemberOf(data, member)
	if !ok {
		serveSDStatus(w, http.StatusInternalServerError)
		return
	}
	serveSDValue(w, value)
}

// ---- shared mapping helpers --------------------------------------------------------------

// sdArrayMember reproduces `data.map(x => x.<member>)`. A non-array data, a null/undefined
// element (property access throws) or a value that cannot be stringified reports false, which the
// caller turns into 500. A missing member on any other primitive is JavaScript `undefined`, which
// JSON.stringify writes as null.
func sdArrayMember(data orderedNodeJSON, member string) (orderedNodeJSON, bool) {
	if data.kind != 'a' {
		return orderedNodeJSON{}, false
	}
	result := nodeArray()
	for _, item := range data.array {
		value, ok := sdMemberOf(item, member)
		if !ok {
			return orderedNodeJSON{}, false
		}
		result.array = append(result.array, value)
	}
	return result, true
}

// sdNameOptions is `data.map(x => ({value: x.title, text: x.title}))`.
func sdNameOptions(names orderedNodeJSON) orderedNodeJSON {
	options := nodeArray()
	for _, name := range names.array {
		option := nodeObject()
		option.setMember("value", name)
		option.setMember("text", name)
		options.array = append(options.array, option)
	}
	return options
}

// sdSpliceAfterFirst reproduces `list.splice(1, 0, ...insert)`: the insert always lands at index
// 1, clamped to the list length, so an empty list receives only the insert.
func sdSpliceAfterFirst(list, insert orderedNodeJSON) orderedNodeJSON {
	start := 1
	if start > len(list.array) {
		start = len(list.array)
	}
	result := nodeArray()
	result.array = append(result.array, list.array[:start]...)
	result.array = append(result.array, insert.array...)
	result.array = append(result.array, list.array[start:]...)
	return result
}

// sdPrefixedOptions is `choices.map(it => ({value: it, text: prefix + it}))` for the loader
// prefixes: a non-string choice stringifies through the template literal, and a missing text
// member (an impossible object coercion) is carried as undefined so the later `.replace` fails.
func sdPrefixedOptions(choices orderedNodeJSON, prefix string) (orderedNodeJSON, bool) {
	options := nodeArray()
	for _, choice := range choices.array {
		option := nodeObject()
		option.setMember("value", choice)
		if prefix == "" {
			// checkpoints: `{value: it, text: it}` keeps the decoded type, so a non-string
			// choice fails later at `.replace`, exactly where the pinned transform fails.
			option.setMember("text", choice)
			options.array = append(options.array, option)
			continue
		}
		// UNet/GGUF: a template literal stringifies anything.
		text, err := pinnedJSStringValue(choice)
		if err != nil {
			return orderedNodeJSON{}, false
		}
		option.setMember("text", nodeString(prefix+text))
		options.array = append(options.array, option)
	}
	return options, true
}

// sdComfyDisplayName is `.replace(/\.[^.]*$/, ”).replace(/_/g, ' ')`.
func sdComfyDisplayName(text string) string {
	if dot := strings.LastIndexByte(text, '.'); dot >= 0 {
		text = text[:dot]
	}
	return strings.ReplaceAll(text, "_", " ")
}

// sdStrictNumberZero is JavaScript `value === 0.0`.
func sdStrictNumberZero(value orderedNodeJSON) bool {
	if value.kind != 'v' {
		return false
	}
	number, ok := value.scalar.(float64)
	return ok && number == 0
}

// sdSleep waits for the pinned delay, releasing early when the caller goes away.
func sdSleep(ctx context.Context, duration time.Duration) bool {
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-timer.C:
		return true
	case <-ctx.Done():
		return false
	}
}

// serveSDRespondJSON writes `res.send(value)` for a value this package built itself. Every
// handler in this file responds with a value derived from JSON, so the ordered serializer keeps
// key order and ECMAScript number formatting identical to JSON.stringify.
func serveSDRespondJSON(w http.ResponseWriter, value orderedNodeJSON) {
	respondOrderedNodeJSON(w, http.StatusOK, value)
}
