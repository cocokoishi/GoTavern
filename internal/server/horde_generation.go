package server

// Pinned /api/horde/* generation, polling and cancellation routes, from src/endpoints/horde.js:
//
//	POST /api/horde/cancel-task     horde.js:144
//	POST /api/horde/task-status     horde.js:164
//	POST /api/horde/generate-text   horde.js:183
//	POST /api/horde/sd-samplers     horde.js:214
//	POST /api/horde/sd-models       horde.js:224
//	POST /api/horde/caption-image   horde.js:235
//	POST /api/horde/user-info       horde.js:285
//	POST /api/horde/generate-image  horde.js:309
//
// This EXTENDS the existing horde.go (status, text-models, text-workers) rather than adding a second
// Horde client: the same seam (`hordeAPIBaseURL`), the same `upstreamAgent` from /version and the same
// outbound transport are reused.
//
// Four of these routes go through `@zeldafan0225/ai_horde` 5.2.0, whose request shape lives in the
// package: base `https://aihorde.net/api/v2`, `Client-Agent` and `Content-Type: application/json` on
// EVERY call, and `apikey` only when the call passes a token. `tools/probe-horde.mjs` records what the
// pinned code actually sends, including the SDK-built bodies, because `https://aihorde.net` is a
// hardcoded literal and the module hook is the only way to point both sides at one peer.
//
// Pinned behaviours that a careful implementation would get wrong, each recorded:
//
//   - `task-status` has NO ok guard: a 500 body with valid JSON is returned AS-IS with status 200;
//   - `generate-text` answers a failed submission as `{error:{message}}` and a rejected fetch as
//     `{error:true}`, both at status 200, and re-serializes the submitted body;
//   - `caption-image` and `generate-image` sleep 3000 ms BEFORE each check and poll up to 200 times;
//   - `sd-samplers` makes no request at all: it is the SDK enum's values in declaration order;
//   - `user-info` treats a failed shared-key lookup as `null` rather than an error, because the pinned
//     handler catches only that call;
//   - `generate-image` truncates to `5000 - len(String(negative_prompt)) - 5` UTF-16 units, appends the
//     negative prompt with " ### ", drops undefined members from the SDK body (so an absent `nsfw` and
//     an absent `seed` vanish) and sends `models: [undefined]` as `[null]`;
//   - a successful `generate-image` answers the image URL as a plain string, which Express types html.
//
// NOT differentially verified, and named as such in the compat row: the image route's
// cancel-on-client-disconnect path. The pinned handler registers `request.socket.on('close')`; the probe
// could not make the pinned server observe a disconnect (a fetch abort keeps the pooled socket alive and
// a destroyed raw socket produced no close inside the process within four seconds). The behaviour is
// implemented from the source and is unverified rather than unrecorded.

import (
	"context"
	"encoding/json"
	"net/http"
	"regexp"
	"strconv"
	"time"
	"unicode/utf16"

	"github.com/cocokoishi/gotavern/internal/outbound"
	"github.com/cocokoishi/gotavern/internal/startup"
)

const (
	hordeAnonymousKey        = "0000000000"
	hordeImagePromptLimit    = 5000
	hordeImagePromptReserve  = 5
	hordePollMaxAttempts     = 200
	hordeCaptionStateDone    = "done"
	hordeCaptionStateFaulted = "faulted"
	hordeCaptionStateCancel  = "cancelled"
)

// hordePollCheckInterval is the pinned `CHECK_INTERVAL = 3000`. It is a variable so the route tests can
// collapse it; a separate test asserts the production value, because a poll cadence that silently
// changes is an observable difference no fixture can record.
var hordePollCheckInterval = 3000 * time.Millisecond

// hordeSamplers is `Object.values(ModelGenerationInputStableSamplers)` from the pinned SDK 5.2.0, in
// declaration order. It is a constant of the dependency, not of a live service.
var hordeSamplers = []string{
	"lcm", "k_lms", "k_heun", "k_euler_a", "k_euler", "k_dpm_2", "k_dpm_2_a", "DDIM", "PLMS",
	"k_dpm_fast", "k_dpm_adaptive", "k_dpmpp_2s_a", "k_dpmpp_2m", "dpmsolver", "k_dpmpp_sde",
}

func init() {
	domainRouteRegistrars = append(domainRouteRegistrars, registerHordeGenerationRoutes)
}

func registerHordeGenerationRoutes(mux *http.ServeMux, accounts *accountRuntime, notFoundPage []byte, options HTTPHandlerOptions) {
	post := func(route string, handler func(http.ResponseWriter, *http.Request)) {
		mux.HandleFunc(route, func(w http.ResponseWriter, r *http.Request) {
			if r.Method != http.MethodPost {
				serveStatic(w, r, notFoundPage, options)
				return
			}
			handler(w, r)
		})
	}
	post("/api/horde/cancel-task", accounts.serveHordeCancelTask)
	post("/api/horde/task-status", accounts.serveHordeTaskStatus)
	post("/api/horde/generate-text", accounts.serveHordeGenerateText)
	post("/api/horde/sd-samplers", accounts.serveHordeSDSamplers)
	post("/api/horde/sd-models", accounts.serveHordeSDModels)
	post("/api/horde/caption-image", accounts.serveHordeCaptionImage)
	post("/api/horde/user-info", accounts.serveHordeUserInfo)
	post("/api/horde/generate-image", accounts.serveHordeGenerateImage)
}

// hordeSecretValue reads the Horde API key, returning the pinned anonymous fallback when it is unset.
func (runtime *accountRuntime) hordeSecretValue(w http.ResponseWriter, request *http.Request) (startup.UserDirectories, string, bool) {
	directories, ok := runtime.secretsDirectories(w, request)
	if !ok {
		return nil, "", false
	}
	key, err := startup.ReadSecretString(directories, "api_key_horde")
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return nil, "", false
	}
	if key == "" {
		key = hordeAnonymousKey
	}
	return directories, key, true
}

// hordeSDKRequest performs one AI Horde SDK-shaped request: Host, Client-Agent and Content-Type always,
// plus apikey only when a token is passed, which is exactly what `#e` in the pinned SDK builds.
func hordeSDKRequest(request *http.Request, method, path, token string, body []byte) (*outbound.Response, error) {
	return hordeSDKRequestWithContext(request.Context(), method, path, token, body)
}

// hordeSDKRequestWithContext is hordeSDKRequest with an explicit context, which the cancel path needs:
// the client is already gone, so reusing its context would abort the DELETE that the pinned handler still
// sends (its deleteImageGenerationRequest call carries no signal).
func hordeSDKRequestWithContext(ctx context.Context, method, path, token string, body []byte) (*outbound.Response, error) {
	headers := []outbound.Header{
		{Name: "Host", Value: hostOf(hordeAPIBaseURL() + path)},
		{Name: "Client-Agent", Value: upstreamAgent},
		{Name: "Content-Type", Value: "application/json"},
	}
	if token != "" {
		headers = append(headers, outbound.Header{Name: "apikey", Value: token})
	}
	if len(body) > 0 {
		headers = append(headers, outbound.Header{Name: "Content-Length", Value: strconv.Itoa(len(body))})
	}
	return outbound.Send(ctx, outbound.Request{
		URL:     hordeAPIBaseURL() + path,
		Method:  method,
		Headers: headers,
		Body:    body,
	}, 120*time.Second)
}

// hordeSDKJSON performs an SDK-shaped call and decodes the reply, reporting failure for a rejected fetch,
// a non-2xx status (the SDK throws APIError) or a body that is not JSON.
func hordeSDKJSON(request *http.Request, method, path, token string, body []byte) (orderedNodeJSON, bool) {
	response, err := hordeSDKRequest(request, method, path, token, body)
	if err != nil {
		return orderedNodeJSON{}, false
	}
	if !outboundOK(response) {
		return orderedNodeJSON{}, false
	}
	decoded, err := decodeOrderedNodeJSON(response.Body)
	if err != nil {
		return orderedNodeJSON{}, false
	}
	return decoded, true
}

// hordeAgentRequest performs one of the pinned raw-fetch calls, whose header set is NOT the SDK's.
func hordeAgentRequest(request *http.Request, method, path string, headers []outbound.Header, body []byte) (*outbound.Response, error) {
	all := []outbound.Header{{Name: "Host", Value: hostOf(hordeAPIBaseURL() + path)}}
	all = append(all, headers...)
	if len(body) > 0 {
		all = append(all, outbound.Header{Name: "Content-Length", Value: strconv.Itoa(len(body))})
	}
	return outbound.Send(request.Context(), outbound.Request{
		URL:     hordeAPIBaseURL() + path,
		Method:  method,
		Headers: all,
		Body:    body,
	}, 120*time.Second)
}

// serveHordeSDSamplers answers the SDK sampler enum; no request is made.
func (runtime *accountRuntime) serveHordeSDSamplers(w http.ResponseWriter, request *http.Request) {
	if _, ok := runtime.settingsRequestAccount(w, request); !ok {
		return
	}
	respondJSON(w, http.StatusOK, hordeSamplers)
}

// serveHordeSDModels answers the image model list.
func (runtime *accountRuntime) serveHordeSDModels(w http.ResponseWriter, request *http.Request) {
	if _, ok := runtime.settingsRequestAccount(w, request); !ok {
		return
	}
	decoded, ok := hordeSDKJSON(request, http.MethodGet, "/api/v2/status/models", "", nil)
	if !ok {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	body, err := marshalCharacterJSON(decoded)
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	respondJSONBytes(w, http.StatusOK, body)
}

// serveHordeUserInfo answers the profile of the configured key, or `{anonymous:true}` without one.
func (runtime *accountRuntime) serveHordeUserInfo(w http.ResponseWriter, request *http.Request) {
	directories, ok := runtime.secretsDirectories(w, request)
	if !ok {
		return
	}
	key, err := startup.ReadSecretString(directories, "api_key_horde")
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	if key == "" {
		respondJSONBytes(w, http.StatusOK, []byte(`{"anonymous":true}`))
		return
	}
	// `getSharedKey` is wrapped in its own try/catch: a failure is a null, not an error.
	sharedKey := orderedNodeJSON{kind: 'n'}
	if decoded, found := hordeSDKJSON(request, http.MethodGet, "/api/v2/sharedkeys/"+key, "", nil); found {
		sharedKey = decoded
	}
	user, found := hordeSDKJSON(request, http.MethodGet, "/api/v2/find_user", key, nil)
	if !found {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	result := nodeObject()
	result.setMember("user", user)
	result.setMember("sharedKey", sharedKey)
	result.setMember("anonymous", nodeBool(false))
	body, err := marshalCharacterJSON(result)
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	respondJSONBytes(w, http.StatusOK, body)
}

// serveHordeCancelTask cancels a text generation task.
func (runtime *accountRuntime) serveHordeCancelTask(w http.ResponseWriter, request *http.Request) {
	runtime.serveHordeTaskResource(w, request, http.MethodDelete)
}

// serveHordeTaskStatus answers the status of a text generation task. There is NO ok guard: the pinned
// handler parses and returns the body whatever the status is.
func (runtime *accountRuntime) serveHordeTaskStatus(w http.ResponseWriter, request *http.Request) {
	runtime.serveHordeTaskResource(w, request, http.MethodGet)
}

func (runtime *accountRuntime) serveHordeTaskResource(w http.ResponseWriter, request *http.Request, method string) {
	if _, ok := runtime.settingsRequestAccount(w, request); !ok {
		return
	}
	_, input, bodyOK := readUserPresetRequestBody(request)
	if !bodyOK {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	taskID, valid := hordeTextValue(input["taskId"])
	if !valid {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	response, err := hordeAgentRequest(request, method, "/api/v2/generate/text/status/"+taskID,
		[]outbound.Header{{Name: "Client-Agent", Value: upstreamAgent}}, nil)
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	decoded, err := decodeOrderedNodeJSON(response.Body)
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	body, err := marshalCharacterJSON(decoded)
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	respondJSONBytes(w, http.StatusOK, body)
}

// serveHordeGenerateText submits a text generation and answers the async task object. The server does
// NOT stream: the frontend polls /task-status, which is why that route and cancel-task exist.
func (runtime *accountRuntime) serveHordeGenerateText(w http.ResponseWriter, request *http.Request) {
	_, key, ok := runtime.hordeSecretValue(w, request)
	if !ok {
		return
	}
	body, _, bodyOK := readUserPresetRequestBody(request)
	if !bodyOK {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	// `JSON.stringify(request.body)`: the submitted object is RE-SERIALIZED, so non-canonical text is
	// normalized before it reaches the service. Decoding the raw body preserves its member order.
	reserialized, decodeErr := decodeOrderedNodeJSON(body)
	if decodeErr != nil {
		respondJSON(w, http.StatusOK, map[string]bool{"error": true})
		return
	}
	payload, err := marshalCharacterJSON(reserialized)
	if err != nil {
		respondJSON(w, http.StatusOK, map[string]bool{"error": true})
		return
	}
	response, err := hordeAgentRequest(request, http.MethodPost, "/api/v2/generate/text/async",
		[]outbound.Header{
			{Name: "Content-Type", Value: "application/json"},
			{Name: "apikey", Value: key},
			{Name: "Client-Agent", Value: upstreamAgent},
		}, payload)
	if err != nil {
		respondJSON(w, http.StatusOK, map[string]bool{"error": true})
		return
	}
	if !outboundOK(response) {
		message := string(response.Body)
		errorBody := nodeObject()
		inner := nodeObject()
		inner.setMember("message", nodeString(message))
		errorBody.setMember("error", inner)
		encoded, encodeErr := marshalCharacterJSON(errorBody)
		if encodeErr != nil {
			respondJSON(w, http.StatusOK, map[string]bool{"error": true})
			return
		}
		respondJSONBytes(w, http.StatusOK, encoded)
		return
	}
	decoded, err := decodeOrderedNodeJSON(response.Body)
	if err != nil {
		respondJSON(w, http.StatusOK, map[string]bool{"error": true})
		return
	}
	encoded, err := marshalCharacterJSON(decoded)
	if err != nil {
		respondJSON(w, http.StatusOK, map[string]bool{"error": true})
		return
	}
	respondJSONBytes(w, http.StatusOK, encoded)
}

// serveHordeCaptionImage submits an interrogation and polls until it finishes.
func (runtime *accountRuntime) serveHordeCaptionImage(w http.ResponseWriter, request *http.Request) {
	_, key, ok := runtime.hordeSecretValue(w, request)
	if !ok {
		return
	}
	_, input, bodyOK := readUserPresetRequestBody(request)
	if !bodyOK {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	form := nodeObject()
	form.setMember("name", nodeString("caption"))
	submit := nodeObject()
	if raw, present := input["image"]; present {
		image, err := decodeOrderedNodeJSON(raw)
		if err != nil {
			serveStatusText(w, http.StatusInternalServerError)
			return
		}
		submit.setMember("source_image", image)
	} else {
		submit.setMember("source_image", nodeUndefined())
	}
	submit.setMember("forms", nodeArray(form))
	payload, err := marshalCharacterJSON(submit)
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	submitted, found := hordeSDKJSON(request, http.MethodPost, "/api/v2/interrogate/async", key, payload)
	if !found {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	id, hasID := hordeStringMember(submitted, "id")
	if !hasID || id == "" {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	for attempt := 0; attempt < hordePollMaxAttempts; attempt++ {
		if !hordeSleepForPoll(request.Context()) {
			serveStatusText(w, http.StatusInternalServerError)
			return
		}
		status, found := hordeSDKJSON(request, http.MethodGet, "/api/v2/interrogate/status/"+id, "", nil)
		if !found {
			serveStatusText(w, http.StatusInternalServerError)
			return
		}
		state, _ := hordeStringMember(status, "state")
		switch state {
		case hordeCaptionStateDone:
			forms := nodeGet(status, "forms")
			if forms.isUndefined() {
				serveStatusText(w, http.StatusInternalServerError)
				return
			}
			if forms.kind != 'a' || len(forms.array) == 0 {
				serveStatusText(w, http.StatusInternalServerError)
				return
			}
			caption, _ := hordeStringMember(forms.array[0], "result", "caption")
			if caption == "" {
				serveStatusText(w, http.StatusInternalServerError)
				return
			}
			respondJSON(w, http.StatusOK, map[string]string{"caption": caption})
			return
		case hordeCaptionStateFaulted, hordeCaptionStateCancel:
			serveStatusText(w, http.StatusServiceUnavailable)
			return
		}
	}
	// Pinned falls out of the loop WITHOUT answering, so the browser hangs. A hang is a defect rather
	// than compatibility, so Go answers 504 as the image route does; this is a named deviation and it is
	// unprobed because reaching it takes ten minutes of polling.
	serveStatusText(w, http.StatusGatewayTimeout)
}

// serveHordeGenerateImage generates one image and polls until it is ready.
func (runtime *accountRuntime) serveHordeGenerateImage(w http.ResponseWriter, request *http.Request) {
	if _, ok := runtime.settingsRequestAccount(w, request); !ok {
		return
	}
	_, input, bodyOK := readUserPresetRequestBody(request)
	if !bodyOK {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	if promptRaw, present := input["prompt"]; !present || !nodeTruthyJSON(promptRaw) {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	prompt, promptValid := hordeTextValue(input["prompt"])
	if !promptValid {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	negativePrompt := "undefined"
	if raw, present := input["negative_prompt"]; present {
		text, valid := hordeTextValue(raw)
		if !valid {
			serveStatusText(w, http.StatusInternalServerError)
			return
		}
		negativePrompt = text
	}
	maxLength := hordeImagePromptLimit - javascriptStringLength(negativePrompt) - hordeImagePromptReserve
	if javascriptStringLength(prompt) > maxLength {
		prompt = javascriptSubstring(prompt, maxLength)
	}
	if raw, present := input["sanitize"]; present && nodeTruthyJSON(raw) {
		prompt = sanitizeHordeImagePrompt(prompt)
	}
	_, key, ok := runtime.hordeSecretValue(w, request)
	if !ok {
		return
	}
	params := nodeObject()
	setRawMember(&params, "sampler_name", input["sampler"])
	setRawMember(&params, "hires_fix", input["enable_hr"])
	setRawMember(&params, "use_gfpgan", input["restore_faces"])
	setRawMember(&params, "cfg_scale", input["scale"])
	setRawMember(&params, "steps", input["steps"])
	setRawMember(&params, "width", input["width"])
	setRawMember(&params, "height", input["height"])
	params.setMember("karras", nodeBool(nodeTruthyJSON(input["karras"])))
	setRawMember(&params, "clip_skip", input["clip_skip"])
	if raw, present := input["seed"]; present {
		value, decodeErr := decodeOrderedNodeJSON(raw)
		if decodeErr == nil && javascriptToNumber(value) >= 0 {
			params.setMember("seed", nodeString(javascriptStringOf(value)))
		}
	}
	params.setMember("n", nodeNumber(1))
	submit := nodeObject()
	submit.setMember("prompt", nodeString(prompt+" ### "+negativePrompt))
	submit.setMember("params", params)
	submit.setMember("r2", nodeBool(false))
	setRawMember(&submit, "nsfw", input["nfsw"])
	models := nodeArray(orderedNodeJSON{kind: 'n'})
	if raw, present := input["model"]; present {
		model, decodeErr := decodeOrderedNodeJSON(raw)
		if decodeErr != nil {
			serveStatusText(w, http.StatusInternalServerError)
			return
		}
		models = nodeArray(model)
	}
	submit.setMember("models", models)
	payload, err := marshalCharacterJSON(submit)
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	submitted, found := hordeSDKJSON(request, http.MethodPost, "/api/v2/generate/async", key, payload)
	if !found {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	id, hasID := hordeStringMember(submitted, "id")
	if !hasID || id == "" {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	for attempt := 0; attempt < hordePollMaxAttempts; attempt++ {
		if !hordeSleepForPoll(request.Context()) {
			// The pinned handler aborts its controller and DELETEs the generation when the client socket
			// closes. NOT differentially verified; see this file's header comment.
			cancelContext, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			_, _ = hordeSDKRequestWithContext(cancelContext, http.MethodDelete, "/api/v2/generate/status/"+id, "", nil)
			cancel()
			return
		}
		check, found := hordeSDKJSON(request, http.MethodGet, "/api/v2/generate/check/"+id, "", nil)
		if !found {
			serveStatusText(w, http.StatusInternalServerError)
			return
		}
		if jsTruthyNode(nodeGet(check, "faulted")) {
			serveStatusText(w, http.StatusInternalServerError)
			return
		}
		if !jsTruthyNode(nodeGet(check, "done")) {
			continue
		}
		result, found := hordeSDKJSON(request, http.MethodGet, "/api/v2/generate/status/"+id, "", nil)
		if !found {
			serveStatusText(w, http.StatusInternalServerError)
			return
		}
		generations := nodeGet(result, "generations")
		if generations.isUndefined() || generations.kind != 'a' || len(generations.array) == 0 {
			serveStatusText(w, http.StatusInternalServerError)
			return
		}
		image, _ := hordeStringMember(generations.array[0], "img")
		respondText(w, http.StatusOK, "text/html; charset=utf-8", image)
		return
	}
	serveStatusText(w, http.StatusGatewayTimeout)
}

// hordeSleepForPoll waits one poll interval, reporting false when the client went away first.
func hordeSleepForPoll(ctx context.Context) bool {
	timer := time.NewTimer(hordePollCheckInterval)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}

// hordeTextValue reads a body member as JavaScript String(), reporting false on a decode error.
func hordeTextValue(raw json.RawMessage) (string, bool) {
	if len(raw) == 0 {
		return "", true
	}
	value, err := decodeOrderedNodeJSON(raw)
	if err != nil {
		return "", false
	}
	return javascriptStringOf(value), true
}

// hordeStringMember resolves a path and reports it as a string when it is one.
func hordeStringMember(root orderedNodeJSON, path ...string) (string, bool) {
	value := nodeGet(root, path...)
	if value.kind != 's' {
		return "", false
	}
	return value.scalar.(string), true
}

// setRawMember copies a body member onto an object only when it is present, mirroring JSON.stringify's
// omission of `undefined`.
func setRawMember(target *orderedNodeJSON, name string, raw json.RawMessage) {
	if len(raw) == 0 {
		return
	}
	value, err := decodeOrderedNodeJSON(raw)
	if err != nil {
		return
	}
	target.setMember(name, value)
}

// javascriptStringOf is JavaScript String() for a decoded value.
func javascriptStringOf(value orderedNodeJSON) string {
	text, err := value.javascriptString()
	if err != nil {
		return ""
	}
	return text
}

// javascriptStringLength is `.length` in JavaScript, i.e. UTF-16 code units.
func javascriptStringLength(value string) int {
	return len(utf16.Encode([]rune(value)))
}

// javascriptSubstring reproduces `value.substring(0, end)`: a negative end clamps to zero and the cut is
// counted in UTF-16 code units.
func javascriptSubstring(value string, end int) string {
	if end <= 0 {
		return ""
	}
	units := utf16.Encode([]rune(value))
	if end >= len(units) {
		return value
	}
	return string(utf16.Decode(units[:end]))
}

// hordeImagePromptSanitizers is the pinned word-substitution table from
// sanitizeHordeImagePrompt (horde.js:38), in source order. The source records the provenance of the
// table (KAI Lite, AGPLv3).
var hordeImagePromptSanitizers = []struct {
	pattern     *regexp.Regexp
	replacement string
}{
	{regexp.MustCompile(`(?im)\b(girl)\b`), "woman"},
	{regexp.MustCompile(`(?im)\b(boy)\b`), "man"},
	{regexp.MustCompile(`(?im)\b(girls)\b`), "women"},
	{regexp.MustCompile(`(?im)\b(boys)\b`), "men"},
	{regexp.MustCompile(`(?im)\b(under.age|under.aged|underage|underaged|loli|pedo|pedophile|(\w+).year.old|(\w+).years.old|minor|prepubescent|minors|shota)\b`), ""},
	{regexp.MustCompile(`(?im)\b(youngster|infant|baby|toddler|child|teen|kid|kiddie|kiddo|teenager|student|preteen|pre.teen)\b`), "person"},
	{regexp.MustCompile(`(?im)\b(young|younger|youthful|youth|small|smaller|smallest|girly|boyish|lil|tiny|teenaged|lit[tl]le|school.aged|school|highschool|kindergarten|teens|children|kids)\b`), ""},
}

// sanitizeHordeImagePrompt reproduces the pinned sanitizer: substitutions and removals in source order.
// An empty prompt stays empty.
func sanitizeHordeImagePrompt(prompt string) string {
	if prompt == "" {
		return ""
	}
	for _, rule := range hordeImagePromptSanitizers {
		prompt = rule.pattern.ReplaceAllString(prompt, rule.replacement)
	}
	return prompt
}
