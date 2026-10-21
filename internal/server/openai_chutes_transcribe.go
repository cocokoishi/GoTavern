package server

// Pinned `/api/openai/chutes/transcribe-audio` (openai.js:882) -- the one route in this project where the
// REQUEST changes the DESTINATION.
//
// The pinned handler builds its URL by interpolating the model into the HOSTNAME with no sanitising:
//
//	fetch(`https://${request.body.model}.chutes.ai/transcribe`)
//
// A model containing a dot or a slash therefore sends the request to a DIFFERENT HOST. That is reproduced
// VERBATIM here and recorded as an INHERITED property, the way the content-import substring match is
// recorded: hardening it would be a deliberate compatibility change rather than a silent improvement.
//
// The seam is the host TEMPLATE (`https://{model}.chutes.ai`), so a test can point the whole base at a
// controlled peer for the replay while the host interpolation itself is asserted separately against the
// recorded URLs -- which is the assertion that matters, because the peer cannot own a hostile host.

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/cocokoishi/gotavern/internal/outbound"
	"github.com/cocokoishi/gotavern/internal/startup"
)

const (
	chutesTranscribeDefaultBase = "https://{model}.chutes.ai"
	chutesTranscribePath        = "/transcribe"
)

// chutesTranscribeURL is the pinned template literal. `{model}` is replaced with the RAW model, and a base
// that carries no placeholder (a test override) is left alone so the path can still be compared.
func chutesTranscribeURL(model string) string {
	base := sdSeamURL("GOTAVERN_CHUTES_TRANSCRIBE_URL", chutesTranscribeDefaultBase)
	return strings.ReplaceAll(base, "{model}", model) + chutesTranscribePath
}

func init() {
	domainRouteRegistrars = append(domainRouteRegistrars, registerOpenAIChutesTranscribeRoutes)
}

func registerOpenAIChutesTranscribeRoutes(mux *http.ServeMux, accounts *accountRuntime, notFoundPage []byte, options HTTPHandlerOptions) {
	mux.HandleFunc("/api/openai/chutes/transcribe-audio", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			serveStatic(w, r, notFoundPage, options)
			return
		}
		accounts.serveOpenAIChutesTranscribe(w, r)
	})
}

func (runtime *accountRuntime) serveOpenAIChutesTranscribe(w http.ResponseWriter, request *http.Request) {
	directories, ok := runtime.secretsDirectories(w, request)
	if !ok {
		return
	}
	key, err := startup.ReadSecretString(directories, "api_key_chutes")
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	if key == "" {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	fileBytes, fields, _, ok := readTranscribeUpload(request)
	if !ok {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	if fileBytes == nil {
		serveStatusText(w, http.StatusBadRequest)
		return
	}

	payload := nodeObject()
	payload.setMember("audio_b64", nodeString(base64.StdEncoding.EncodeToString(fileBytes)))
	body, err := marshalCharacterJSON(payload)
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}

	target := chutesTranscribeURL(fields["model"])
	response, err := outbound.Send(request.Context(), outbound.Request{
		URL:    target,
		Method: http.MethodPost,
		Headers: []outbound.Header{
			{Name: "Host", Value: hostOf(target)},
			{Name: "Authorization", Value: "Bearer " + key},
			{Name: "Content-Type", Value: "application/json"},
			{Name: "Content-Length", Value: strconvItoa(len(body))},
		},
		Body: body,
	}, 120*time.Second)
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	if !outboundOK(response) {
		// `response.status(500).send(text)` forwards the PROVIDER TEXT.
		respondText(w, http.StatusInternalServerError, "text/html; charset=utf-8", string(response.Body))
		return
	}

	// `if (!Array.isArray(data)) return response.sendStatus(500)` -- a non-array answer is the plain status
	// text, NOT the provider body.
	var chunks []struct {
		Text string `json:"text"`
	}
	if err := json.Unmarshal(response.Body, &chunks); err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	if !strings.HasPrefix(strings.TrimSpace(string(response.Body)), "[") {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	var builder strings.Builder
	for _, chunk := range chunks {
		builder.WriteString(chunk.Text)
	}
	answer := nodeObject()
	answer.setMember("text", nodeString(strings.TrimSpace(builder.String())))
	encoded, err := marshalCharacterJSON(answer)
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	respondJSONBytes(w, http.StatusOK, encoded)
}
