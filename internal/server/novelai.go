package server

// Pinned NovelAI routes implemented this round, from src/endpoints/novelai.js:
//
//	POST /api/novelai/status          (133)  credential/entitlement probe; JSON envelope, always 200
//	POST /api/novelai/generate-voice  (442)  one-shot GET, binary audio/mpeg response
//
// DEFERRED, recorded in the fixture knownDifferences:
//	/api/novelai/generate        (167) model-dependent bad-word/logit-bias/repetition-penalty tables
//	                                   plus an SSE streaming forward;
//	/api/novelai/generate-image  (300) NAI Diffusion body, PNG zip extraction, conditional upscale
//	                                   with a fallback to the original image.
// /api/extra/{caption,classify,classify/labels} are NOT provider routes (local Transformers.js
// pipelines with no outbound HTTP); they stay not implemented for that reason.
//
// Evidence: tools/probe-novelai.mjs records tests/oracle/sillytavern-1.19.0-novelai.json against the
// pinned server with node-fetch replaced by a controlled peer; internal/server/novelai_test.go
// replays it. Voice bytes are compared as base64 + SHA-256 + length, never as text.

import (
	"net/http"
	"strconv"

	"github.com/cocokoishi/gotavern/internal/startup"
)

const (
	novelaiImageDefaultURL = "https://image.novelai.net"
	novelaiAPIDefaultURL   = "https://api.novelai.net"
)

func novelaiImageURL() string { return sdSeamURL("GOTAVERN_NOVELAI_IMAGE_URL", novelaiImageDefaultURL) }
func novelaiAPIURL() string   { return sdSeamURL("GOTAVERN_NOVELAI_API_URL", novelaiAPIDefaultURL) }

func init() {
	domainRouteRegistrars = append(domainRouteRegistrars, registerNovelAIRoutes)
}

func registerNovelAIRoutes(mux *http.ServeMux, accounts *accountRuntime, notFoundPage []byte, options HTTPHandlerOptions) {
	for _, route := range []string{"/api/novelai/status", "/api/novelai/generate-voice"} {
		handler := map[string]func(http.ResponseWriter, *http.Request){
			"/api/novelai/status":         accounts.serveNovelAIStatus,
			"/api/novelai/generate-voice": accounts.serveNovelAIGenerateVoice,
		}[route]
		mux.HandleFunc(route, func(w http.ResponseWriter, r *http.Request) {
			if r.Method != http.MethodPost {
				serveStatic(w, r, notFoundPage, options)
				return
			}
			handler(w, r)
		})
	}
}

// novelaiErrorTrue is the pinned `res.send({ error: true })` envelope used by /status for every
// upstream failure, including a rejected fetch.
func novelaiErrorTrue(w http.ResponseWriter) {
	searchJSON(w, nodeObjectWith("error", nodeBool(true)))
}

// serveNovelAIStatus is novelai.js:133.
func (runtime *accountRuntime) serveNovelAIStatus(w http.ResponseWriter, request *http.Request) {
	_, directories, ok := runtime.sdUser(w, request)
	if !ok {
		return
	}
	key, err := sdReadSecret(directories, "api_key_novel")
	if err != nil {
		backendsStatus(w, http.StatusInternalServerError)
		return
	}
	if key == "" {
		backendsStatus(w, http.StatusBadRequest)
		return
	}
	response, fetchErr := searchFetch(request.Context(), searchRequest{
		Method: http.MethodGet,
		URL:    novelaiImageURL() + "/user/subscription",
		Headers: map[string]string{
			"content-type":  "application/json",
			"authorization": "Bearer " + key,
		},
	})
	if fetchErr != nil {
		novelaiErrorTrue(w)
		return
	}
	if !sdResponseOK(response) {
		novelaiErrorTrue(w)
		return
	}
	data, parsed := sdReadJSON(response)
	if !parsed {
		// response.json() rejects in pinned, the catch answers the same envelope.
		novelaiErrorTrue(w)
		return
	}
	searchJSON(w, data)
}

// serveNovelAIGenerateVoice is novelai.js:442.
func (runtime *accountRuntime) serveNovelAIGenerateVoice(w http.ResponseWriter, request *http.Request) {
	_, directories, ok := runtime.sdUser(w, request)
	if !ok {
		return
	}
	key, err := sdReadSecret(directories, "api_key_novel")
	if err != nil {
		backendsStatus(w, http.StatusInternalServerError)
		return
	}
	if key == "" {
		backendsStatus(w, http.StatusBadRequest)
		return
	}
	body, ok := runtime.sdRequestBody(w, request)
	if !ok {
		return
	}
	textNode := sdBodyMember(body, "text")
	voiceNode := sdBodyMember(body, "voice")
	if !pinnedJSTruthy(textNode) || !pinnedJSTruthy(voiceNode) {
		backendsStatus(w, http.StatusBadRequest)
		return
	}
	text, textErr := pinnedJSStringValue(textNode)
	voice, voiceErr := pinnedJSStringValue(voiceNode)
	if textErr != nil || voiceErr != nil {
		backendsStatus(w, http.StatusInternalServerError)
		return
	}
	target := novelaiAPIURL() + "/ai/generate-voice?text=" + sdEncodeURIComponent(text) +
		"&voice=-1&seed=" + sdEncodeURIComponent(voice) + "&opus=false&version=v2"
	response, fetchErr := searchFetch(request.Context(), searchRequest{
		Method: http.MethodGet,
		URL:    target,
		Headers: map[string]string{
			"authorization": "Bearer " + key,
			"accept":        "audio/mpeg",
		},
	})
	if fetchErr != nil {
		backendsStatus(w, http.StatusInternalServerError)
		return
	}
	if !sdResponseOK(response) {
		backendsStatus(w, http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "audio/mpeg")
	w.Header().Set("Content-Length", strconv.Itoa(len(response.Body)))
	w.Header().Set("ETag", expressWeakETag(response.Body))
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(response.Body)
}

var _ = startup.UserDirectories{}
