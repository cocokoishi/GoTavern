package server

// Pinned OpenAI media routes implemented this round, from src/endpoints/openai.js:
//
//	POST /api/openai/generate-voice              (273)  binary audio, fixed audio/mpeg
//	POST /api/openai/custom/generate-voice       (756)  binary audio, fixed audio/mpeg, caller-supplied endpoint
//	POST /api/openai/electronhub/generate-voice  (321)  binary audio, upstream content-type forwarded
//	POST /api/openai/chutes/generate-voice       (419)  binary audio, upstream content-type forwarded
//	POST /api/openai/generate-image              (619)  JSON passthrough
//
// THE "DEFERRED" LIST THAT STOOD HERE WAS WRONG, and corrected 2026-10-29 by reading the registrations:
// every route it called `not implemented` is registered --
//
//	/api/openai/caption-image       openai_caption.go:88      (the per-api provider matrix)
//	/api/openai/generate-video      openai_generate_video.go:82  (the polling loop with client abort)
//	/api/openai/transcribe-audio    openai_transcribe.go:55   (and the chutes variant, openai_chutes_transcribe.go)
//	/api/google/*                   google_media.go:49-50, google_voice.go:49-50, google_video.go:66,
//	                                google_native_tts.go:527
//
// A header may say what a file DOES; it may not be the only place a capability is denied, because a reader
// believes it and the next lane builds what already exists.
//
// Evidence: tools/probe-openai-media.mjs drives the pinned server with node-fetch replaced by a
// controlled peer, records tests/oracle/sillytavern-1.19.0-openai-media.json, and
// internal/server/openai_media_test.go replays it. Audio bodies are recorded as base64 + SHA-256 +
// length and compared that way, never as text. The stub can only carry UTF-8 payloads, so the
// recorded audio is an ASCII byte pattern; that limitation is stated in the fixture.

import (
	"net/http"
	"strconv"

	"github.com/cocokoishi/gotavern/internal/startup"
)

const (
	openaiMediaAPIDefaultURL         = "https://api.openai.com"
	openaiMediaElectronHubDefaultURL = "https://api.electronhub.ai"
	openaiMediaChutesTTSDefaultURL   = "https://chutes-kokoro.chutes.ai"
)

func openaiMediaAPIURL() string {
	return sdSeamURL("GOTAVERN_OPENAI_API_URL", openaiMediaAPIDefaultURL)
}
func openaiMediaElectronHubURL() string {
	return sdSeamURL("GOTAVERN_OPENAI_ELECTRONHUB_URL", openaiMediaElectronHubDefaultURL)
}
func openaiMediaChutesTTSURL() string {
	return sdSeamURL("GOTAVERN_OPENAI_CHUTES_TTS_URL", openaiMediaChutesTTSDefaultURL)
}

func init() {
	domainRouteRegistrars = append(domainRouteRegistrars, registerOpenAIMediaRoutes)
}

func registerOpenAIMediaRoutes(mux *http.ServeMux, accounts *accountRuntime, notFoundPage []byte, options HTTPHandlerOptions) {
	post := func(route string, handler func(http.ResponseWriter, *http.Request)) {
		mux.HandleFunc(route, func(w http.ResponseWriter, r *http.Request) {
			if r.Method != http.MethodPost {
				serveStatic(w, r, notFoundPage, options)
				return
			}
			handler(w, r)
		})
	}
	post("/api/openai/generate-voice", accounts.serveOpenAIGenerateVoice)
	post("/api/openai/custom/generate-voice", accounts.serveOpenAICustomGenerateVoice)
	post("/api/openai/electronhub/generate-voice", accounts.serveOpenAIElectronHubVoice)
	post("/api/openai/chutes/generate-voice", accounts.serveOpenAIChutesVoice)
	post("/api/openai/generate-image", accounts.serveOpenAIGenerateImage)
}

// ---- shared helpers -----------------------------------------------------------------------

// openaiMediaSendAudio is `res.setHeader('Content-Type', type); res.send(Buffer.from(buffer))`:
// the JSON send path is bypassed, so there is no charset suffix, but the weak ETag and
// Content-Length are still produced from the bytes.
func openaiMediaSendAudio(w http.ResponseWriter, contentType string, body []byte) {
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Content-Length", strconv.Itoa(len(body)))
	w.Header().Set("ETag", expressWeakETag(body))
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(body)
}

// openaiMediaServerError is the pinned catch: `response.status(500).send('Internal server error')`.
func openaiMediaServerError(w http.ResponseWriter) {
	respondText(w, http.StatusInternalServerError, "text/html; charset=utf-8", "Internal server error")
}

// openaiMediaUpstreamError is `response.status(500).send(text)` with the upstream body.
func openaiMediaUpstreamError(w http.ResponseWriter, body []byte) {
	respondText(w, http.StatusInternalServerError, "text/html; charset=utf-8", string(body))
}

// openaiMediaNullish is JavaScript `value ?? fallback`.
func openaiMediaNullish(value, fallback orderedNodeJSON) orderedNodeJSON {
	if value.kind == 'n' || value.isUndefined() {
		return fallback
	}
	return value
}

// openaiMediaJSONObject marshals a response-request object built in JS literal order.
func openaiMediaJSONObject(w http.ResponseWriter, object orderedNodeJSON) ([]byte, bool) {
	encoded, err := marshalOrderedNodeJSON(object)
	if err != nil {
		openaiMediaServerError(w)
		return nil, false
	}
	return encoded, true
}

// openaiMediaPrepareJSONRequest reads the request body and answers 400 on a parse failure exactly
// like the pinned body parser.
func (runtime *accountRuntime) openaiMediaPrepareJSONRequest(w http.ResponseWriter, request *http.Request) (startup.UserDirectories, orderedNodeJSON, bool) {
	_, directories, ok := runtime.sdUser(w, request)
	if !ok {
		return nil, orderedNodeJSON{}, false
	}
	body, ok := runtime.sdRequestBody(w, request)
	if !ok {
		return nil, orderedNodeJSON{}, false
	}
	return directories, body, true
}

// ---- /generate-voice ----------------------------------------------------------------------

// serveOpenAIGenerateVoice is openai.js:273.
func (runtime *accountRuntime) serveOpenAIGenerateVoice(w http.ResponseWriter, request *http.Request) {
	directories, body, ok := runtime.openaiMediaPrepareJSONRequest(w, request)
	if !ok {
		return
	}
	key, err := sdReadSecret(directories, "api_key_openai")
	if err != nil {
		openaiMediaServerError(w)
		return
	}
	if key == "" {
		backendsStatus(w, http.StatusBadRequest)
		return
	}
	requestBody := nodeObject()
	requestBody.setMember("input", sdBodyMember(body, "text"))
	requestBody.setMember("response_format", nodeString("mp3"))
	requestBody.setMember("voice", openaiMediaNullish(sdBodyMember(body, "voice"), nodeString("alloy")))
	requestBody.setMember("speed", openaiMediaNullish(sdBodyMember(body, "speed"), nodeNumber(1)))
	requestBody.setMember("model", openaiMediaNullish(sdBodyMember(body, "model"), nodeString("tts-1")))
	if instructions := sdBodyMember(body, "instructions"); pinnedJSTruthy(instructions) {
		requestBody.setMember("instructions", instructions)
	}
	encoded, ok := openaiMediaJSONObject(w, requestBody)
	if !ok {
		return
	}
	response, err := searchFetch(request.Context(), searchRequest{
		Method: http.MethodPost,
		URL:    openaiMediaAPIURL() + "/v1/audio/speech",
		Headers: map[string]string{
			"content-type":  "application/json",
			"authorization": "Bearer " + key,
		},
		Body: encoded,
	})
	if err != nil {
		openaiMediaServerError(w)
		return
	}
	if !sdResponseOK(response) {
		openaiMediaUpstreamError(w, response.Body)
		return
	}
	openaiMediaSendAudio(w, "audio/mpeg", response.Body)
}

// ---- /custom/generate-voice ---------------------------------------------------------------

// serveOpenAICustomGenerateVoice is openai.js:756: the endpoint comes from the request body and the
// key may legitimately be empty, in which case the header is "Bearer ".
func (runtime *accountRuntime) serveOpenAICustomGenerateVoice(w http.ResponseWriter, request *http.Request) {
	directories, body, ok := runtime.openaiMediaPrepareJSONRequest(w, request)
	if !ok {
		return
	}
	key, err := sdReadSecret(directories, "api_key_custom_openai_tts")
	if err != nil {
		openaiMediaServerError(w)
		return
	}
	providerEndpoint := sdBodyMember(body, "provider_endpoint")
	if !pinnedJSTruthy(providerEndpoint) {
		backendsStatus(w, http.StatusBadRequest)
		return
	}
	endpoint, err := pinnedJSStringValue(providerEndpoint)
	if err != nil {
		openaiMediaServerError(w)
		return
	}
	requestBody := nodeObject()
	requestBody.setMember("input", openaiMediaNullish(sdBodyMember(body, "input"), nodeString("")))
	requestBody.setMember("response_format", openaiMediaNullish(sdBodyMember(body, "response_format"), nodeString("mp3")))
	requestBody.setMember("voice", openaiMediaNullish(sdBodyMember(body, "voice"), nodeString("alloy")))
	requestBody.setMember("speed", openaiMediaNullish(sdBodyMember(body, "speed"), nodeNumber(1)))
	requestBody.setMember("model", openaiMediaNullish(sdBodyMember(body, "model"), nodeString("tts-1")))
	encoded, ok := openaiMediaJSONObject(w, requestBody)
	if !ok {
		return
	}
	response, err := searchFetch(request.Context(), searchRequest{
		Method: http.MethodPost,
		URL:    endpoint,
		Headers: map[string]string{
			"content-type":  "application/json",
			"authorization": "Bearer " + key,
		},
		Body: encoded,
	})
	if err != nil {
		openaiMediaServerError(w)
		return
	}
	if !sdResponseOK(response) {
		openaiMediaUpstreamError(w, response.Body)
		return
	}
	openaiMediaSendAudio(w, "audio/mpeg", response.Body)
}

// ---- /electronhub/generate-voice ----------------------------------------------------------

// serveOpenAIElectronHubVoice is openai.js:321. The body literal is built in a fixed order, then
// truthy optional fields are appended, then Number.isFinite-only fields, then any request-body
// member that was not already accounted for (the pinned dynamic-parameter pass-through).
func (runtime *accountRuntime) serveOpenAIElectronHubVoice(w http.ResponseWriter, request *http.Request) {
	directories, requestBodySource, ok := runtime.openaiMediaPrepareJSONRequest(w, request)
	if !ok {
		return
	}
	key, err := sdReadSecret(directories, "api_key_electronhub")
	if err != nil {
		openaiMediaServerError(w)
		return
	}
	if key == "" {
		backendsStatus(w, http.StatusBadRequest)
		return
	}
	body := nodeObject()
	body.setMember("input", sdBodyMember(requestBodySource, "input"))
	body.setMember("voice", sdBodyMember(requestBodySource, "voice"))
	body.setMember("speed", openaiMediaNullish(sdBodyMember(requestBodySource, "speed"), nodeNumber(1)))
	body.setMember("temperature", openaiMediaNullish(sdBodyMember(requestBodySource, "temperature"), nodeUndefined()))
	body.setMember("model", valueOrDefault(sdBodyMember(requestBodySource, "model"), nodeString("tts-1")))
	body.setMember("response_format", nodeString("mp3"))

	for _, optional := range []string{"instructions", "speaker_transcript"} {
		if value := sdBodyMember(requestBodySource, optional); pinnedJSTruthy(value) {
			body.setMember(optional, value)
		}
	}
	for _, finite := range []string{"cfg_scale", "cfg_filter_top_k", "speech_rate", "pitch_adjustment"} {
		if value := sdBodyMember(requestBodySource, finite); value.kind == 'v' && !isNaNValue(value) {
			body.setMember(finite, nodeNumber(pinnedJSToNumber(value)))
		}
	}
	if emotionalStyle := sdBodyMember(requestBodySource, "emotional_style"); pinnedJSTruthy(emotionalStyle) {
		body.setMember("emotional_style", emotionalStyle)
	}
	known := map[string]bool{
		"input": true, "voice": true, "speed": true, "temperature": true, "model": true, "response_format": true,
	}
	for _, entry := range body.object {
		known[entry.key] = true
	}
	if requestBodySource.kind == 'o' {
		for _, entry := range requestBodySource.object {
			if known[entry.key] || entry.value.isUndefined() {
				continue
			}
			body.setMember(entry.key, entry.value)
		}
	}
	// Clean undefineds, exactly like the pinned Object.keys(...).forEach(... delete).
	cleaned := nodeObject()
	for _, entry := range body.object {
		if entry.value.isUndefined() {
			continue
		}
		cleaned.setMember(entry.key, entry.value)
	}
	encoded, ok := openaiMediaJSONObject(w, cleaned)
	if !ok {
		return
	}
	response, err := searchFetch(request.Context(), searchRequest{
		Method: http.MethodPost,
		URL:    openaiMediaElectronHubURL() + "/v1/audio/speech",
		Headers: map[string]string{
			"content-type":  "application/json",
			"authorization": "Bearer " + key,
		},
		Body: encoded,
	})
	if err != nil {
		openaiMediaServerError(w)
		return
	}
	if !sdResponseOK(response) {
		openaiMediaUpstreamError(w, response.Body)
		return
	}
	contentType := response.Header("content-type")
	if contentType == "" {
		contentType = "audio/mpeg"
	}
	openaiMediaSendAudio(w, contentType, response.Body)
}

// valueOrDefault is JavaScript `value || fallback` for a JSON member.
func valueOrDefault(value, fallback orderedNodeJSON) orderedNodeJSON {
	if pinnedJSTruthy(value) {
		return value
	}
	return fallback
}

// isNaNValue reports a JSON number that is NaN, which JSON cannot carry; kept explicit so the
// finite check reads like Number.isFinite.
func isNaNValue(value orderedNodeJSON) bool {
	number, isNumber := value.scalar.(float64)
	return !isNumber || number != number
}

// ---- /chutes/generate-voice ---------------------------------------------------------------

// serveOpenAIChutesVoice is openai.js:419.
func (runtime *accountRuntime) serveOpenAIChutesVoice(w http.ResponseWriter, request *http.Request) {
	directories, body, ok := runtime.openaiMediaPrepareJSONRequest(w, request)
	if !ok {
		return
	}
	key, err := sdReadSecret(directories, "api_key_chutes")
	if err != nil {
		openaiMediaServerError(w)
		return
	}
	if key == "" {
		backendsStatus(w, http.StatusBadRequest)
		return
	}
	requestBody := nodeObject()
	requestBody.setMember("text", sdBodyMember(body, "input"))
	requestBody.setMember("voice", valueOrDefault(sdBodyMember(body, "voice"), nodeString("af_heart")))
	requestBody.setMember("speed", valueOrDefault(sdBodyMember(body, "speed"), nodeNumber(1)))
	encoded, ok := openaiMediaJSONObject(w, requestBody)
	if !ok {
		return
	}
	response, err := searchFetch(request.Context(), searchRequest{
		Method: http.MethodPost,
		URL:    openaiMediaChutesTTSURL() + "/speak",
		Headers: map[string]string{
			"content-type":  "application/json",
			"authorization": "Bearer " + key,
		},
		Body: encoded,
	})
	if err != nil {
		openaiMediaServerError(w)
		return
	}
	if !sdResponseOK(response) {
		openaiMediaUpstreamError(w, response.Body)
		return
	}
	contentType := response.Header("content-type")
	if contentType == "" {
		contentType = "audio/mpeg"
	}
	openaiMediaSendAudio(w, contentType, response.Body)
}

// ---- /generate-image ----------------------------------------------------------------------

// serveOpenAIGenerateImage is openai.js:619: the caller's body is forwarded as-is and the upstream
// JSON answer is returned as-is.
func (runtime *accountRuntime) serveOpenAIGenerateImage(w http.ResponseWriter, request *http.Request) {
	directories, body, ok := runtime.openaiMediaPrepareJSONRequest(w, request)
	if !ok {
		return
	}
	key, err := sdReadSecret(directories, "api_key_openai")
	if err != nil {
		openaiMediaServerError(w)
		return
	}
	if key == "" {
		backendsStatus(w, http.StatusBadRequest)
		return
	}
	encoded, err := marshalOrderedNodeJSON(body)
	if err != nil {
		openaiMediaServerError(w)
		return
	}
	response, err := searchFetch(request.Context(), searchRequest{
		Method: http.MethodPost,
		URL:    openaiMediaAPIURL() + "/v1/images/generations",
		Headers: map[string]string{
			"content-type":  "application/json",
			"authorization": "Bearer " + key,
		},
		Body: encoded,
	})
	if err != nil {
		openaiMediaServerError(w)
		return
	}
	if !sdResponseOK(response) {
		openaiMediaUpstreamError(w, response.Body)
		return
	}
	data, parsed := sdReadJSON(response)
	if !parsed {
		openaiMediaServerError(w)
		return
	}
	searchJSON(w, data)
}
