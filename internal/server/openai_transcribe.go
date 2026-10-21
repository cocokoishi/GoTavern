package server

// Pinned transcription routes built by `createTranscribeHandler` (openai.js:806), one handler and four
// registrations:
//
//	POST /api/openai/transcribe-audio          -> https://api.openai.com/v1/audio/transcriptions
//	POST /api/openai/groq/transcribe-audio     -> https://api.groq.com/openai/v1/audio/transcriptions
//	POST /api/openai/mistral/transcribe-audio  -> https://api.mistral.ai/v1/audio/transcriptions
//	POST /api/openai/zai/transcribe-audio      -> https://api.z.ai/api/paas/v4/transcriptions
//
// The handler appends `fs.createReadStream(request.file.path)` to a `form-data` FormData and then `model`
// and an optional `language`, and posts it with the bearer key. The part ORDER and the explicit
// `audio/wav` content type are visible to the provider, so both are pinned: `model` is a form FIELD here,
// not a path segment, which is why this family has no rule-15 interpolation at all.
//
// The refusals answer 400 with NO outbound request: no key, or no uploaded file.

import (
	"bytes"
	"io"
	"mime/multipart"
	"net/http"
	"strings"
	"time"

	"github.com/cocokoishi/gotavern/internal/outbound"
	"github.com/cocokoishi/gotavern/internal/startup"
)

const (
	openAITranscribeDefaultBase  = "https://api.openai.com"
	openAITranscribePath         = "/v1/audio/transcriptions"
	groqTranscribeDefaultBase    = "https://api.groq.com"
	groqTranscribePath           = "/openai/v1/audio/transcriptions"
	mistralTranscribeDefaultBase = "https://api.mistral.ai"
	mistralTranscribePath        = "/v1/audio/transcriptions"
	zaiTranscribeDefaultBase     = "https://api.z.ai"
	zaiTranscribePath            = "/api/paas/v4/audio/transcriptions"
	transcribeUploadField        = "avatar"
	transcribeUpstreamFileName   = "audio.wav"
	transcribeUpstreamFileType   = "audio/wav"
	transcribeMissingMemberValue = "undefined"
)

type openAITranscribeProvider struct {
	route       string
	secretID    string
	environment string
	fallback    string
	path        string
}

func openAITranscribeProviders() []openAITranscribeProvider {
	return []openAITranscribeProvider{
		{"/api/openai/transcribe-audio", "api_key_openai", "GOTAVERN_OPENAI_TRANSCRIBE_URL", openAITranscribeDefaultBase, openAITranscribePath},
		{"/api/openai/groq/transcribe-audio", "api_key_groq", "GOTAVERN_GROQ_TRANSCRIBE_URL", groqTranscribeDefaultBase, groqTranscribePath},
		{"/api/openai/mistral/transcribe-audio", "api_key_mistralai", "GOTAVERN_MISTRAL_TRANSCRIBE_URL", mistralTranscribeDefaultBase, mistralTranscribePath},
		{"/api/openai/zai/transcribe-audio", "api_key_zai", "GOTAVERN_ZAI_TRANSCRIBE_URL", zaiTranscribeDefaultBase, zaiTranscribePath},
	}
}

func init() {
	domainRouteRegistrars = append(domainRouteRegistrars, registerOpenAITranscribeRoutes)
}

func registerOpenAITranscribeRoutes(mux *http.ServeMux, accounts *accountRuntime, notFoundPage []byte, options HTTPHandlerOptions) {
	for _, entry := range openAITranscribeProviders() {
		provider := entry
		mux.HandleFunc(provider.route, func(w http.ResponseWriter, r *http.Request) {
			if r.Method != http.MethodPost {
				serveStatic(w, r, notFoundPage, options)
				return
			}
			accounts.serveOpenAITranscribe(w, r, provider)
		})
	}
}

// readTranscribeUpload reproduces what multer leaves behind for `upload.single('avatar')`: the file bytes
// and the plain fields, with presence distinguished from emptiness so an ABSENT `model` can be reproduced
// as the string "undefined" the way `formData.append('model', undefined)` does.
func readTranscribeUpload(request *http.Request) ([]byte, map[string]string, map[string]bool, bool) {
	reader, err := request.MultipartReader()
	if err != nil {
		return nil, nil, nil, false
	}
	fields := map[string]string{}
	present := map[string]bool{}
	var fileBytes []byte
	sawFile := false
	for {
		part, err := reader.NextPart()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, nil, nil, false
		}
		content, readErr := io.ReadAll(part)
		if readErr != nil {
			return nil, nil, nil, false
		}
		name := part.FormName()
		if part.FileName() != "" && name == transcribeUploadField {
			fileBytes = content
			sawFile = true
			continue
		}
		fields[name] = string(content)
		present[name] = true
	}
	if !sawFile {
		return nil, fields, present, true
	}
	return fileBytes, fields, present, true
}

func (runtime *accountRuntime) serveOpenAITranscribe(w http.ResponseWriter, request *http.Request, provider openAITranscribeProvider) {
	directories, ok := runtime.secretsDirectories(w, request)
	if !ok {
		return
	}
	key, err := startup.ReadSecretString(directories, provider.secretID)
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	if key == "" {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	fileBytes, fields, present, ok := readTranscribeUpload(request)
	if !ok {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	if fileBytes == nil {
		serveStatusText(w, http.StatusBadRequest)
		return
	}

	var buffer bytes.Buffer
	writer := multipart.NewWriter(&buffer)
	if err := writeSpeechFilePart(writer, "file", transcribeUpstreamFileName, transcribeUpstreamFileType, fileBytes); err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	model := fields["model"]
	if !present["model"] {
		// `formData.append('model', undefined)` writes the STRING "undefined", so an absent member is not
		// the same as an empty one.
		model = transcribeMissingMemberValue
	}
	if err := writer.WriteField("model", model); err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	if language := fields["language"]; language != "" {
		if err := writer.WriteField("language", language); err != nil {
			serveStatusText(w, http.StatusInternalServerError)
			return
		}
	}
	if err := writer.Close(); err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}

	target := strings.TrimRight(sdSeamURL(provider.environment, provider.fallback), "/") + provider.path
	body := buffer.Bytes()
	response, err := outbound.Send(request.Context(), outbound.Request{
		URL:    target,
		Method: http.MethodPost,
		Headers: []outbound.Header{
			{Name: "Host", Value: hostOf(target)},
			{Name: "Authorization", Value: "Bearer " + key},
			{Name: "Content-Type", Value: writer.FormDataContentType()},
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
	// `response.json(data)`: the provider's own JSON, passed through in its original key order.
	contentType := "application/json; charset=utf-8"
	if strings.TrimSpace(string(response.Body)) == "" {
		contentType = "application/json; charset=utf-8"
	}
	respondText(w, http.StatusOK, contentType, string(response.Body))
}
