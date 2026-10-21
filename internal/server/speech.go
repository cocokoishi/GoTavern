package server

// Pinned /api/speech/* routes, from src/endpoints/speech.js:
//
//	POST /api/speech/pollinations/voices        speech.js:88
//	POST /api/speech/pollinations/generate      speech.js:117
//	POST /api/speech/elevenlabs/voices          speech.js:179
//	POST /api/speech/elevenlabs/voice-settings  speech.js:207
//	POST /api/speech/elevenlabs/synthesize      speech.js:234
//	POST /api/speech/elevenlabs/history         speech.js:274
//	POST /api/speech/elevenlabs/history-audio   speech.js:302
//	POST /api/speech/elevenlabs/voices/add      speech.js:338
//	POST /api/speech/elevenlabs/recognize       speech.js:390
//
// NOT implemented, and deliberately so:
//
//	POST /api/speech/recognize   speech.js:42
//	POST /api/speech/synthesize  speech.js:61
//
// Both call `getPipeline()` from src/transformers.js: LOCAL ONNX inference whose weights are
// downloaded from the Hugging Face hub and whose output depends on those weights. There is no
// third-party request to point at a controlled peer and a transcription or waveform cannot be pinned,
// so they stay `not implemented` rather than being approximated (AGENTS.md rule 18).
//
// Every upstream here is a hardcoded literal, so tools/probe-speech.mjs replaces only the pinned
// server's node-fetch with a controlled peer and records the transformed response plus the outbound
// request. Each base URL below is a seam whose default is asserted.
//
// Pinned details a careful implementation would get wrong, each recorded:
//
//   - a non-ok peer answers sendStatus(500) for every route here; the 401-to-400 rewrite inside
//     forwardFetchResponse is unreachable because the !ok guard fires first;
//   - the Pollinations request body has a FIXED member order and a per-request random seed, and its
//     audio payload is base64-decoded with Node's LENIENT decoder (invalid characters are dropped);
//   - an EMPTY `request` object is truthy, so /elevenlabs/synthesize accepts it, and the sub-object is
//     re-serialized as the upstream JSON body;
//   - the upstream multipart part order is name/description/labels then files, and an entry that is
//     not a data URI is SKIPPED while a data URI whose base64 is malformed is still sent (decoded
//     leniently); the file extension comes from mime-types, which maps audio/mpeg to mpga;
//   - /elevenlabs/recognize reads the upload from multer's global `.single('avatar')` field and always
//     forwards it as filename audio.wav with type audio/wav, followed by a model_id part.

import (
	"bytes"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"math/big"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"strconv"
	"strings"
	"time"

	"github.com/cocokoishi/gotavern/internal/outbound"
	"github.com/cocokoishi/gotavern/internal/startup"
)

const (
	pollinationsDefaultAPIURL  = "https://gen.pollinations.ai"
	elevenLabsDefaultAPIURL    = "https://api.elevenlabs.io"
	pollinationsDefaultModel   = "openai-audio"
	pollinationsDefaultVoice   = "alloy"
	elevenLabsRecognizeFormKey = "avatar"
)

func pollinationsAPIURL() string {
	return envSeamURL("GOTAVERN_POLLINATIONS_API_URL", pollinationsDefaultAPIURL)
}

func elevenLabsAPIURL() string {
	return envSeamURL("GOTAVERN_ELEVENLABS_API_URL", elevenLabsDefaultAPIURL)
}

func init() {
	domainRouteRegistrars = append(domainRouteRegistrars, registerSpeechRoutes)
}

func registerSpeechRoutes(mux *http.ServeMux, accounts *accountRuntime, notFoundPage []byte, options HTTPHandlerOptions) {
	post := func(route string, handler func(http.ResponseWriter, *http.Request)) {
		mux.HandleFunc(route, func(w http.ResponseWriter, r *http.Request) {
			if r.Method != http.MethodPost {
				serveStatic(w, r, notFoundPage, options)
				return
			}
			handler(w, r)
		})
	}
	post("/api/speech/pollinations/voices", accounts.servePollinationsVoices)
	post("/api/speech/pollinations/generate", accounts.servePollinationsGenerate)
	post("/api/speech/elevenlabs/voices", accounts.serveElevenLabsVoices)
	post("/api/speech/elevenlabs/voice-settings", accounts.serveElevenLabsVoiceSettings)
	post("/api/speech/elevenlabs/synthesize", accounts.serveElevenLabsSynthesize)
	post("/api/speech/elevenlabs/history", accounts.serveElevenLabsHistory)
	post("/api/speech/elevenlabs/history-audio", accounts.serveElevenLabsHistoryAudio)
	post("/api/speech/elevenlabs/voices/add", accounts.serveElevenLabsVoicesAdd)
	post("/api/speech/elevenlabs/recognize", accounts.serveElevenLabsRecognize)
}

// speechUpstreamJSON performs one upstream call and decodes the body as JSON. The pinned routes wrap
// every failure (fetch rejection, non-ok status, unparsable body) in the same catch, which answers
// sendStatus(500), so the caller only needs to know that it failed.
func speechUpstreamJSON(request *http.Request, method, target string, headers []outbound.Header, body []byte) (orderedNodeJSON, bool) {
	response, err := outboundRequest(request, method, target, headers, body)
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

// servePollinationsVoices answers the voice list of one Pollinations audio model.
func (runtime *accountRuntime) servePollinationsVoices(w http.ResponseWriter, request *http.Request) {
	if _, ok := runtime.settingsRequestAccount(w, request); !ok {
		return
	}
	_, input, bodyOK := readUserPresetRequestBody(request)
	if !bodyOK {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	model := pollinationsDefaultModel
	if raw, present := input["model"]; present && nodeTruthyJSON(raw) {
		value, err := javascriptStringOfBody(raw)
		if err != nil {
			serveStatusText(w, http.StatusInternalServerError)
			return
		}
		model = value
	}
	decoded, ok := speechUpstreamJSON(request, http.MethodGet, pollinationsAPIURL()+"/text/models", nil, nil)
	if !ok {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	if decoded.kind != 'a' {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	// `data.find(m => m.name === model || m.aliases?.includes(model))`
	found := nodeUndefined()
	for _, entry := range decoded.array {
		if entry.kind != 'o' {
			continue
		}
		name := nodeGet(entry, "name")
		matches := name.kind == 's' && name.scalar.(string) == model
		if !matches {
			aliases := nodeGet(entry, "aliases")
			if aliases.kind == 'a' {
				for _, alias := range aliases.array {
					if alias.kind == 's' && alias.scalar.(string) == model {
						matches = true
						break
					}
				}
			}
		}
		if matches {
			found = entry
			break
		}
	}
	if !jsTruthyNode(found) {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	voices := nodeGet(found, "voices")
	if voices.kind != 'a' {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	body, err := marshalCharacterJSON(voices)
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	respondJSONBytes(w, http.StatusOK, body)
}

// servePollinationsGenerate synthesizes speech through the Pollinations chat completions endpoint.
func (runtime *accountRuntime) servePollinationsGenerate(w http.ResponseWriter, request *http.Request) {
	directories, key, ok := runtime.providerSecretString(w, request, "api_key_pollinations")
	if !ok {
		return
	}
	_ = directories
	_, input, bodyOK := readUserPresetRequestBody(request)
	if !bodyOK {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	model := pollinationsDefaultModel
	if raw, present := input["model"]; present && nodeTruthyJSON(raw) {
		if value, err := javascriptStringOfBody(raw); err == nil {
			model = value
		}
	}
	voice := pollinationsDefaultVoice
	if raw, present := input["voice"]; present && nodeTruthyJSON(raw) {
		if value, err := javascriptStringOfBody(raw); err == nil {
			voice = value
		}
	}
	// `JSON.stringify({model, stream, modalities, seed, audio, messages})`: the member order is the
	// literal's order, and the seed is a fresh `Math.floor(Math.random() * 2 ** 32)` per request.
	seed, err := randomPollinationsSeed()
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	audio := nodeObject()
	audio.setMember("format", nodeString("mp3"))
	audio.setMember("voice", nodeString(voice))
	message := nodeObject()
	message.setMember("role", nodeString("user"))
	if raw, present := input["text"]; present {
		text, err := decodeOrderedNodeJSON(raw)
		if err != nil {
			serveStatusText(w, http.StatusInternalServerError)
			return
		}
		message.setMember("content", text)
	} else {
		message.setMember("content", nodeUndefined())
	}
	payload := nodeObject()
	payload.setMember("model", nodeString(model))
	payload.setMember("stream", nodeBool(false))
	payload.setMember("modalities", nodeArray(nodeString("text"), nodeString("audio")))
	payload.setMember("seed", nodeNumber(seed))
	payload.setMember("audio", audio)
	payload.setMember("messages", nodeArray(message))
	body, err := marshalCharacterJSON(payload)
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	decoded, ok := speechUpstreamJSON(request, http.MethodPost, pollinationsAPIURL()+"/v1/chat/completions",
		[]outbound.Header{
			{Name: "Authorization", Value: "Bearer " + key},
			{Name: "Content-Type", Value: "application/json"},
		}, body)
	if !ok {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	audioData := nodeGet(decoded, "choices")
	if audioData.kind != 'a' || len(audioData.array) == 0 {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	data := nodeGet(audioData.array[0], "message", "audio", "data")
	if !jsTruthyNode(data) || data.kind != 's' {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	bytes, err := decodeBase64Node(data.scalar.(string))
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "audio/mpeg")
	respondBinary(w, http.StatusOK, bytes)
}

// randomPollinationsSeed reproduces `Math.floor(Math.random() * Math.pow(2, 32))`.
func randomPollinationsSeed() (float64, error) {
	limit := new(big.Int).Lsh(big.NewInt(1), 32)
	value, err := rand.Int(rand.Reader, limit)
	if err != nil {
		return 0, err
	}
	return float64(value.Int64()), nil
}

// respondBinary writes bytes with the framing headers respondJSON uses, plus the pinned `Vary: Origin`:
// the compression middleware only appends Accept-Encoding when it will compress the body, and it does
// not compress audio/mpeg, so an audio reply carries Vary: Origin alone.
func respondBinary(w http.ResponseWriter, status int, body []byte) {
	w.Header().Set("Content-Length", strconvItoa(len(body)))
	w.Header().Set("ETag", expressWeakETag(body))
	w.Header().Set("Vary", "Origin")
	w.WriteHeader(status)
	_, _ = w.Write(body)
}

func strconvItoa(value int) string {
	return strconv.Itoa(value)
}

// decodeBase64Node reproduces Node's Buffer.from(value, 'base64'): characters outside the base64 and
// base64url alphabets (and whitespace) are dropped, '-' and '_' are accepted as '+' and '/', a lone
// trailing character is discarded, and a short final group is decoded as if padded. Go's standard
// decoder rejects every one of those inputs.
func decodeBase64Node(value string) ([]byte, error) {
	var builder strings.Builder
	for _, character := range value {
		switch {
		case character >= 'A' && character <= 'Z',
			character >= 'a' && character <= 'z',
			character >= '0' && character <= '9',
			character == '+', character == '/':
			builder.WriteRune(character)
		case character == '-':
			// Node's decoder also accepts the base64url alphabet.
			builder.WriteRune('+')
		case character == '_':
			builder.WriteRune('/')
		case character == '=':
			// Padding is re-added below; a stray '=' mid-string is dropped like any other character.
			continue
		}
	}
	filtered := builder.String()
	if remainder := len(filtered) % 4; remainder == 1 {
		filtered = filtered[:len(filtered)-1]
	} else if remainder != 0 {
		filtered += strings.Repeat("=", 4-remainder)
	}
	return base64.StdEncoding.DecodeString(filtered)
}

// elevenLabsKey resolves the ElevenLabs key, answering the pinned 400 when it is absent.
func (runtime *accountRuntime) elevenLabsKey(w http.ResponseWriter, request *http.Request) (startup.UserDirectories, string, bool) {
	return runtime.providerSecretString(w, request, "api_key_elevenlabs")
}

// elevenLabsJSONRequest is the shared shape of /voices, /voice-settings and /history: GET, JSON out.
func (runtime *accountRuntime) elevenLabsJSONRequest(w http.ResponseWriter, request *http.Request, path string) {
	_, key, ok := runtime.elevenLabsKey(w, request)
	if !ok {
		return
	}
	decoded, ok := speechUpstreamJSON(request, http.MethodGet, elevenLabsAPIURL()+path,
		[]outbound.Header{{Name: "xi-api-key", Value: key}}, nil)
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

func (runtime *accountRuntime) serveElevenLabsVoices(w http.ResponseWriter, request *http.Request) {
	runtime.elevenLabsJSONRequest(w, request, "/v1/voices")
}

func (runtime *accountRuntime) serveElevenLabsVoiceSettings(w http.ResponseWriter, request *http.Request) {
	runtime.elevenLabsJSONRequest(w, request, "/v1/voices/settings/default")
}

func (runtime *accountRuntime) serveElevenLabsHistory(w http.ResponseWriter, request *http.Request) {
	runtime.elevenLabsJSONRequest(w, request, "/v1/history")
}

// serveElevenLabsSynthesize streams the synthesized audio back to the browser.
func (runtime *accountRuntime) serveElevenLabsSynthesize(w http.ResponseWriter, request *http.Request) {
	_, key, ok := runtime.elevenLabsKey(w, request)
	if !ok {
		return
	}
	_, input, bodyOK := readUserPresetRequestBody(request)
	if !bodyOK {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	voiceID, hasVoice := input["voiceId"]
	requestBody, hasRequest := input["request"]
	if !hasVoice || !nodeTruthyJSON(voiceID) || !hasRequest || !nodeTruthyJSON(requestBody) {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	voiceText, err := javascriptStringOfBody(voiceID)
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	// `JSON.stringify(request)`: the sub-object is re-serialized from the parsed body.
	serialized, err := decodeOrderedNodeJSON(requestBody)
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	body, err := marshalCharacterJSON(serialized)
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	runtime.forwardElevenLabsAudio(w, request, http.MethodPost, elevenLabsAPIURL()+"/v1/text-to-speech/"+voiceText, key, body)
}

// serveElevenLabsHistoryAudio streams one history item's audio back to the browser.
func (runtime *accountRuntime) serveElevenLabsHistoryAudio(w http.ResponseWriter, request *http.Request) {
	_, key, ok := runtime.elevenLabsKey(w, request)
	if !ok {
		return
	}
	_, input, bodyOK := readUserPresetRequestBody(request)
	if !bodyOK {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	historyID, hasID := input["historyItemId"]
	if !hasID || !nodeTruthyJSON(historyID) {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	idText, err := javascriptStringOfBody(historyID)
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	runtime.forwardElevenLabsAudio(w, request, http.MethodGet, elevenLabsAPIURL()+"/v1/history/"+idText+"/audio", key, nil)
}

// forwardElevenLabsAudio reproduces the pinned `res.set('Content-Type','audio/mpeg')` followed by
// forwardFetchResponse: the upstream status and bytes are streamed with no content length, so the
// reply is chunked exactly as the pinned one is.
func (runtime *accountRuntime) forwardElevenLabsAudio(w http.ResponseWriter, request *http.Request, method, target, key string, body []byte) {
	headers := []outbound.Header{{Name: "Host", Value: hostOf(target)}, {Name: "xi-api-key", Value: key}}
	if body != nil {
		headers = append(headers, outbound.Header{Name: "Content-Type", Value: "application/json"})
		headers = append(headers, outbound.Header{Name: "Content-Length", Value: strconvItoa(len(body))})
	}
	response, err := outbound.SendStreaming(request.Context(), outbound.Request{
		URL:     target,
		Method:  method,
		Headers: headers,
		Body:    body,
	}, 120*time.Second)
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	defer response.Stream.Close()
	if !outboundOK(response) {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	// forwardFetchResponse copies the upstream status (401 becomes 400 there, but the !ok guard above
	// already turned every non-2xx into a 500) and pipes the body.
	w.Header().Set("Content-Type", "audio/mpeg")
	// The streamed body is audio, so the pinned compression middleware leaves Vary at its CORS value.
	w.Header().Set("Vary", "Origin")
	w.WriteHeader(response.Status)
	_, _ = io.Copy(w, response.Stream)
}

// serveElevenLabsVoicesAdd uploads a custom voice as multipart/form-data.
func (runtime *accountRuntime) serveElevenLabsVoicesAdd(w http.ResponseWriter, request *http.Request) {
	_, key, ok := runtime.elevenLabsKey(w, request)
	if !ok {
		return
	}
	_, input, bodyOK := readUserPresetRequestBody(request)
	if !bodyOK {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	name := "Custom Voice"
	if raw, present := input["name"]; present && nodeTruthyJSON(raw) {
		if value, err := javascriptStringOfBody(raw); err == nil {
			name = value
		}
	}
	description := "Uploaded via SillyTavern"
	if raw, present := input["description"]; present && nodeTruthyJSON(raw) {
		if value, err := javascriptStringOfBody(raw); err == nil {
			description = value
		}
	}
	labels := ""
	if raw, present := input["labels"]; present && nodeTruthyJSON(raw) {
		if value, err := javascriptStringOfBody(raw); err == nil {
			labels = value
		}
	}
	var buffer bytes.Buffer
	writer := multipart.NewWriter(&buffer)
	if err := writer.WriteField("name", name); err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	if err := writer.WriteField("description", description); err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	if err := writer.WriteField("labels", labels); err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	if raw, present := input["files"]; present {
		files, err := decodeOrderedNodeJSON(raw)
		if err == nil && files.kind == 'a' {
			for _, entry := range files.array {
				fileData, err := entry.javascriptString()
				if err != nil {
					continue
				}
				mimeType, base64Data, matched := parseDataURI(fileData)
				if !matched {
					continue
				}
				decoded, err := decodeBase64Node(base64Data)
				if err != nil {
					continue
				}
				if err := writeSpeechFilePart(writer, "files", "audio."+extensionForAudioMimeType(mimeType), mimeType, decoded); err != nil {
					serveStatusText(w, http.StatusInternalServerError)
					return
				}
			}
		}
	}
	if err := writer.Close(); err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	decoded, ok := speechUpstreamJSON(request, http.MethodPost, elevenLabsAPIURL()+"/v1/voices/add",
		[]outbound.Header{
			{Name: "xi-api-key", Value: key},
			{Name: "Content-Type", Value: writer.FormDataContentType()},
		}, buffer.Bytes())
	if !ok {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	responseBody, err := marshalCharacterJSON(decoded)
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	respondJSONBytes(w, http.StatusOK, responseBody)
}

// writeSpeechFilePart writes one file part with an EXPLICIT content type. multipart.Writer.CreateFormFile
// always sets application/octet-stream, while the pinned form-data part carries the data-URI mime type
// (or audio/wav for an upload), and that difference is visible to the upstream service.
func writeSpeechFilePart(writer *multipart.Writer, field, filename, contentType string, content []byte) error {
	header := textproto.MIMEHeader{}
	escapedFilename := strings.NewReplacer(`"`, `%22`, "\r", "%0D", "\n", "%0A").Replace(filename)
	header.Set("Content-Disposition", fmt.Sprintf(`form-data; name="%s"; filename="%s"`, field, escapedFilename))
	header.Set("Content-Type", contentType)
	part, err := writer.CreatePart(header)
	if err != nil {
		return err
	}
	_, err = part.Write(content)
	return err
}

// parseDataURI reproduces `/^data:(.+);base64,(.+)$/.exec(fileData)?.slice(1) || []`. The greedy first
// group takes the LAST ";base64," in the string, which is what a JS regex does here.
func parseDataURI(value string) (string, string, bool) {
	const marker = ";base64,"
	index := strings.LastIndex(value, marker)
	if !strings.HasPrefix(value, "data:") || index < len("data:") {
		return "", "", false
	}
	mimeType := value[len("data:"):index]
	base64Data := value[index+len(marker):]
	if mimeType == "" || base64Data == "" {
		return "", "", false
	}
	return mimeType, base64Data, true
}

// extensionForAudioMimeType reproduces `mime.extension(mimeType) || 'wav'` for the audio types the
// oracle pins. mime-types answers `mpga` for audio/mpeg, which a guess would get wrong.
func extensionForAudioMimeType(mimeType string) string {
	switch strings.ToLower(mimeType) {
	case "audio/wav", "audio/wave", "audio/x-wav":
		return "wav"
	case "audio/mpeg":
		return "mpga"
	case "audio/mp4":
		return "m4a"
	case "audio/ogg":
		return "oga"
	case "audio/webm":
		return "weba"
	default:
		return "wav"
	}
}

// serveElevenLabsRecognize forwards an uploaded audio file to the speech-to-text endpoint.
func (runtime *accountRuntime) serveElevenLabsRecognize(w http.ResponseWriter, request *http.Request) {
	_, key, ok := runtime.elevenLabsKey(w, request)
	if !ok {
		return
	}
	fileBytes, model, found := readSpeechUpload(request)
	if !found {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	var buffer bytes.Buffer
	writer := multipart.NewWriter(&buffer)
	if err := writeSpeechFilePart(writer, "file", "audio.wav", "audio/wav", fileBytes); err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	if err := writer.WriteField("model_id", model); err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	if err := writer.Close(); err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	decoded, ok := speechUpstreamJSON(request, http.MethodPost, elevenLabsAPIURL()+"/v1/speech-to-text",
		[]outbound.Header{
			{Name: "xi-api-key", Value: key},
			{Name: "Content-Type", Value: writer.FormDataContentType()},
		}, buffer.Bytes())
	if !ok {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	responseBody, err := marshalCharacterJSON(decoded)
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	respondJSONBytes(w, http.StatusOK, responseBody)
}

// readSpeechUpload reads the multipart upload the pinned global `multer().single('avatar')` would
// have parsed, plus the `model` text field.
func readSpeechUpload(request *http.Request) ([]byte, string, bool) {
	reader, err := request.MultipartReader()
	if err != nil {
		return nil, "", false
	}
	model := ""
	var fileBytes []byte
	found := false
	for {
		part, err := reader.NextPart()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, "", false
		}
		content, err := io.ReadAll(part)
		if err != nil {
			_ = part.Close()
			return nil, "", false
		}
		name := part.FormName()
		if name == elevenLabsRecognizeFormKey {
			fileBytes = content
			found = true
		} else if name == "model" {
			model = string(content)
		}
		_ = part.Close()
	}
	return fileBytes, model, found
}
