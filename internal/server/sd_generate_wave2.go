package server

// Pinned stable-diffusion GENERATION routes, wave 2: the one-shot providers whose request is a single
// forwarded call. From src/endpoints/stable-diffusion.js:
//
//	POST /api/sd/huggingface/generate          stable-diffusion.js:1145
//	POST /api/sd/electronhub/generate          stable-diffusion.js:1224
//	POST /api/sd/chutes/generate               stable-diffusion.js:1343
//	POST /api/sd/nanogpt/generate              stable-diffusion.js:1430
//	POST /api/sd/xai/generate                  stable-diffusion.js:1738
//	POST /api/sd/aimlapi/generate-image        stable-diffusion.js:1837
//
// Every upstream is a hardcoded literal, so each provider has its own seam whose default is the pinned
// base. `chutes` and `nanogpt` deliberately do NOT reuse the seams of their sibling list routes: the
// generate calls go to different hosts (image.chutes.ai) or different paths, and sharing a seam would
// make one route's override silently move another route.
//
// Pinned details a careful implementation would get wrong, each recorded:
//
//   - huggingface interpolates the model into the path with NO encoding, so a slash in the model is a
//     path separator and a space is re-normalized by the URL parser;
//   - electronhub's body order is model, prompt, response_format and then ONLY truthy size/quality;
//   - chutes uses `||` (not `??`), so an empty string also falls back to the default;
//   - nanogpt and aimlapi forward the WHOLE submitted body re-serialized;
//   - xai accepts plain base64 or a data URL and derives the format from the mime type;
//   - aimlapi sends HTTP-Referer and X-Title, accepts images[0] or data[0], b64_json or base64, falls
//     back to fetching the url, and forwards the provider TEXT with a 500 when the call fails.

import (
	"encoding/base64"
	"net/http"
	"regexp"
	"time"

	"github.com/cocokoishi/gotavern/internal/outbound"
	"github.com/cocokoishi/gotavern/internal/startup"
)

const (
	sdHuggingFaceDefaultURL     = "https://api-inference.huggingface.co"
	sdXaiDefaultURL             = "https://api.x.ai"
	sdChutesImageDefaultURL     = "https://image.chutes.ai"
	sdNanoGPTGenerateDefaultURL = "https://nano-gpt.com"
	sdAimlapiReferer            = "https://sillytavern.app"
	sdAimlapiTitle              = "SillyTavern"
)

func sdHuggingFaceURL() string {
	return sdSeamURL("GOTAVERN_SD_HUGGINGFACE_URL", sdHuggingFaceDefaultURL)
}

func sdXaiURL() string { return sdSeamURL("GOTAVERN_SD_XAI_URL", sdXaiDefaultURL) }

// sdChutesImageURL is separate from sdChutesURL because the list route talks to api.chutes.ai while the
// generate route talks to image.chutes.ai.
func sdChutesImageURL() string {
	return sdSeamURL("GOTAVERN_SD_CHUTES_IMAGE_URL", sdChutesImageDefaultURL)
}

// sdNanoGPTGenerateURL is separate from sdNanoGPTURL for the same reason its credits route has its own
// seam: two routes appending different paths to the same host must be overrideable independently.
func sdNanoGPTGenerateURL() string {
	return sdSeamURL("GOTAVERN_SD_NANOGPT_GENERATE_URL", sdNanoGPTGenerateDefaultURL)
}

func init() {
	domainRouteRegistrars = append(domainRouteRegistrars, registerSDGenerateWave2Routes)
}

func registerSDGenerateWave2Routes(mux *http.ServeMux, accounts *accountRuntime, notFoundPage []byte, options HTTPHandlerOptions) {
	post := func(route string, handler func(http.ResponseWriter, *http.Request)) {
		mux.HandleFunc(route, func(w http.ResponseWriter, r *http.Request) {
			if r.Method != http.MethodPost {
				serveStatic(w, r, notFoundPage, options)
				return
			}
			handler(w, r)
		})
	}
	post("/api/sd/huggingface/generate", accounts.serveSDHuggingFaceGenerate)
	post("/api/sd/electronhub/generate", accounts.serveSDElectronHubGenerate)
	post("/api/sd/chutes/generate", accounts.serveSDChutesGenerate)
	post("/api/sd/nanogpt/generate", accounts.serveSDNanoGPTGenerate)
	post("/api/sd/xai/generate", accounts.serveSDXaiGenerate)
	post("/api/sd/aimlapi/generate-image", accounts.serveSDAimlapiGenerate)
}

// sdProviderSecret reads one provider key, answering the pinned 400 when it is absent.
func (runtime *accountRuntime) sdProviderSecret(w http.ResponseWriter, request *http.Request, keyID string) (startup.UserDirectories, string, bool) {
	directories, ok := runtime.secretsDirectories(w, request)
	if !ok {
		return nil, "", false
	}
	key, err := startup.ReadSecretString(directories, keyID)
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return nil, "", false
	}
	if key == "" {
		serveStatusText(w, http.StatusBadRequest)
		return nil, "", false
	}
	return directories, key, true
}

// sdPostJSON performs one provider POST and returns the decoded JSON answer.
func sdPostJSON(request *http.Request, target string, headers []outbound.Header, body []byte) (orderedNodeJSON, bool) {
	all := append([]outbound.Header{{Name: "Host", Value: hostOf(target)}}, headers...)
	if len(body) > 0 {
		// The shared transport writes the request verbatim, so an explicit Content-Length is what makes the
		// body visible to a real HTTP peer.
		all = append(all, outbound.Header{Name: "Content-Length", Value: strconvItoa(len(body))})
	}
	response, err := outbound.Send(request.Context(), outbound.Request{
		URL:     target,
		Method:  http.MethodPost,
		Headers: all,
		Body:    body,
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

// sdPostBytes performs one provider POST and returns the raw answer bytes.
func sdPostBytes(request *http.Request, target string, headers []outbound.Header, body []byte) ([]byte, bool) {
	all := append([]outbound.Header{{Name: "Host", Value: hostOf(target)}}, headers...)
	if len(body) > 0 {
		// The shared transport writes the request verbatim, so an explicit Content-Length is what makes the
		// body visible to a real HTTP peer.
		all = append(all, outbound.Header{Name: "Content-Length", Value: strconvItoa(len(body))})
	}
	response, err := outbound.Send(request.Context(), outbound.Request{
		URL:     target,
		Method:  http.MethodPost,
		Headers: all,
		Body:    body,
	}, 120*time.Second)
	if err != nil || !outboundOK(response) {
		return nil, false
	}
	return response.Body, true
}

// sdJSONHeaders is the pinned pair most of these providers send.
func sdJSONHeaders(key string) []outbound.Header {
	return []outbound.Header{
		{Name: "Content-Type", Value: "application/json"},
		{Name: "Authorization", Value: "Bearer " + key},
	}
}

// sdRawBody re-serializes the WHOLE submitted body, which is what `JSON.stringify(request.body)` does.
func sdRawBody(w http.ResponseWriter, body []byte) ([]byte, bool) {
	decoded, err := decodeOrderedNodeJSON(body)
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return nil, false
	}
	encoded, err := marshalCharacterJSON(decoded)
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return nil, false
	}
	return encoded, true
}

// sdStringMemberOr reports a string member of a decoded object.
func sdStringMemberOr(value orderedNodeJSON, path ...string) (string, bool) {
	found := nodeGet(value, path...)
	if found.kind != 's' {
		return "", false
	}
	return found.scalar.(string), true
}

// serveSDHuggingFaceGenerate posts {inputs} to the model endpoint and answers {image}.
func (runtime *accountRuntime) serveSDHuggingFaceGenerate(w http.ResponseWriter, request *http.Request) {
	_, key, ok := runtime.sdProviderSecret(w, request, "api_key_huggingface")
	if !ok {
		return
	}
	_, input, bodyOK := readUserPresetRequestBody(request)
	if !bodyOK {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	model := sdRawJavaScriptString(input["model"])
	payload := nodeObject()
	setRawMember(&payload, "inputs", input["prompt"])
	body, err := marshalCharacterJSON(payload)
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	// The model is interpolated RAW: no encodeURIComponent here, and that is deliberate.
	content, ok := sdPostBytes(request, sdHuggingFaceURL()+"/models/"+model, sdJSONHeaders(key), body)
	if !ok {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	answer := nodeObject()
	answer.setMember("image", nodeString(base64.StdEncoding.EncodeToString(content)))
	encoded, err := marshalCharacterJSON(answer)
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	respondJSONBytes(w, http.StatusOK, encoded)
}

// serveSDElectronHubGenerate posts an OpenAI-shaped image request and answers {image}.
func (runtime *accountRuntime) serveSDElectronHubGenerate(w http.ResponseWriter, request *http.Request) {
	_, key, ok := runtime.sdProviderSecret(w, request, "api_key_electronhub")
	if !ok {
		return
	}
	_, input, bodyOK := readUserPresetRequestBody(request)
	if !bodyOK {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	payload := nodeObject()
	setRawMember(&payload, "model", input["model"])
	setRawMember(&payload, "prompt", input["prompt"])
	payload.setMember("response_format", nodeString("b64_json"))
	if raw, present := input["size"]; present && nodeTruthyJSON(raw) {
		setRawMember(&payload, "size", raw)
	}
	if raw, present := input["quality"]; present && nodeTruthyJSON(raw) {
		setRawMember(&payload, "quality", raw)
	}
	body, err := marshalCharacterJSON(payload)
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	decoded, ok := sdPostJSON(request, sdElectronHubURL()+"/v1/images/generations", sdJSONHeaders(key), body)
	if !ok {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	if base64Value, found := sdImageAt(decoded); found {
		answer := nodeObject()
		answer.setMember("image", nodeString(base64Value))
		encoded, err := marshalCharacterJSON(answer)
		if err != nil {
			serveStatusText(w, http.StatusInternalServerError)
			return
		}
		respondJSONBytes(w, http.StatusOK, encoded)
		return
	}
	serveStatusText(w, http.StatusInternalServerError)
}

// sdImageAt is `data?.data?.[0]?.b64_json` as a string, for the providers that share that shape.
func sdImageAt(decoded orderedNodeJSON) (string, bool) {
	data := nodeGet(decoded, "data")
	if data.kind != 'a' || len(data.array) == 0 {
		return "", false
	}
	entry := data.array[0]
	if entry.kind != 'o' {
		return "", false
	}
	value, present := entry.member("b64_json")
	if !present || value.kind != 's' {
		return "", false
	}
	text := value.scalar.(string)
	return text, text != ""
}

// serveSDChutesGenerate posts the pinned body with `||` defaults and answers {image}.
func (runtime *accountRuntime) serveSDChutesGenerate(w http.ResponseWriter, request *http.Request) {
	_, key, ok := runtime.sdProviderSecret(w, request, "api_key_chutes")
	if !ok {
		return
	}
	_, input, bodyOK := readUserPresetRequestBody(request)
	if !bodyOK {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	payload := nodeObject()
	setRawMember(&payload, "model", input["model"])
	setRawMember(&payload, "prompt", input["prompt"])
	setRawMember(&payload, "negative_prompt", input["negative_prompt"])
	payload.setMember("guidance_scale", sdOrDefaultNumber(input["guidance_scale"], 7.0))
	payload.setMember("width", sdOrDefaultNumber(input["width"], 1024))
	payload.setMember("height", sdOrDefaultNumber(input["height"], 1024))
	payload.setMember("num_inference_steps", sdOrDefaultNumber(input["steps"], 10))
	body, err := marshalCharacterJSON(payload)
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	content, ok := sdPostBytes(request, sdChutesImageURL()+"/generate", sdJSONHeaders(key), body)
	if !ok {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	answer := nodeObject()
	answer.setMember("image", nodeString(base64.StdEncoding.EncodeToString(content)))
	encoded, err := marshalCharacterJSON(answer)
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	respondJSONBytes(w, http.StatusOK, encoded)
}

// sdOrDefaultNumber reproduces `value || fallback` for a numeric body member, which is TRUTHINESS, not
// nullish: an empty string, zero or null all fall back.
func sdOrDefaultNumber(raw []byte, fallback float64) orderedNodeJSON {
	if len(raw) == 0 {
		return nodeNumber(fallback)
	}
	value, err := decodeOrderedNodeJSON(raw)
	if err != nil || !value.truthy() || !jsTruthyNode(value) {
		return nodeNumber(fallback)
	}
	return value
}

// serveSDNanoGPTGenerate forwards the whole submitted body and answers {image}.
func (runtime *accountRuntime) serveSDNanoGPTGenerate(w http.ResponseWriter, request *http.Request) {
	_, key, ok := runtime.sdProviderSecret(w, request, "api_key_nanogpt")
	if !ok {
		return
	}
	body, _, bodyOK := readUserPresetRequestBody(request)
	if !bodyOK {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	payload, ok := sdRawBody(w, body)
	if !ok {
		return
	}
	decoded, ok := sdPostJSON(request, sdNanoGPTGenerateURL()+"/api/generate-image", []outbound.Header{
		{Name: "x-api-key", Value: key},
		{Name: "Content-Type", Value: "application/json"},
	}, payload)
	if !ok {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	if base64Value, found := sdImageAt(decoded); found {
		answer := nodeObject()
		answer.setMember("image", nodeString(base64Value))
		encoded, err := marshalCharacterJSON(answer)
		if err != nil {
			serveStatusText(w, http.StatusInternalServerError)
			return
		}
		respondJSONBytes(w, http.StatusOK, encoded)
		return
	}
	serveStatusText(w, http.StatusInternalServerError)
}

// sdDataURLPattern is `/^data:(.+);base64,(.+)$/`.
var sdDataURLPattern = regexp.MustCompile(`^data:(.+);base64,(.+)$`)

// serveSDXaiGenerate posts the pinned body and answers {image, format}.
func (runtime *accountRuntime) serveSDXaiGenerate(w http.ResponseWriter, request *http.Request) {
	_, key, ok := runtime.sdProviderSecret(w, request, "api_key_xai")
	if !ok {
		return
	}
	_, input, bodyOK := readUserPresetRequestBody(request)
	if !bodyOK {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	payload := nodeObject()
	setRawMember(&payload, "prompt", input["prompt"])
	setRawMember(&payload, "model", input["model"])
	setRawMember(&payload, "aspect_ratio", input["aspect_ratio"])
	setRawMember(&payload, "resolution", input["resolution"])
	payload.setMember("response_format", nodeString("b64_json"))
	body, err := marshalCharacterJSON(payload)
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	decoded, ok := sdPostJSON(request, sdXaiURL()+"/v1/images/generations", sdJSONHeaders(key), body)
	if !ok {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	encodedImage := ""
	if data := nodeGet(decoded, "data"); data.kind == 'a' && len(data.array) > 0 && data.array[0].kind == 'o' {
		if value, present := data.array[0].member("b64_json"); present {
			text, err := value.javascriptString()
			if err == nil {
				encodedImage = text
			}
		}
	}
	if encodedImage == "" {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	image := encodedImage
	format := "jpg"
	if match := sdDataURLPattern.FindStringSubmatch(encodedImage); match != nil {
		format = sdImageExtensionFromContentType(match[1])
		image = match[2]
	} else {
		format = sdImageExtensionFromContentType("image/jpeg")
	}
	answer := nodeObject()
	answer.setMember("image", nodeString(image))
	answer.setMember("format", nodeString(format))
	encoded, err := marshalCharacterJSON(answer)
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	respondJSONBytes(w, http.StatusOK, encoded)
}

// serveSDAimlapiGenerate forwards the whole body and answers {format, data}.
func (runtime *accountRuntime) serveSDAimlapiGenerate(w http.ResponseWriter, request *http.Request) {
	_, key, ok := runtime.sdProviderSecret(w, request, "api_key_aimlapi")
	if !ok {
		return
	}
	body, _, bodyOK := readUserPresetRequestBody(request)
	if !bodyOK {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	payload, ok := sdRawBody(w, body)
	if !ok {
		return
	}
	target := sdAimlapiURL() + "/v1/images/generations"
	headers := []outbound.Header{
		{Name: "Host", Value: hostOf(target)},
		{Name: "Content-Type", Value: "application/json"},
		{Name: "Authorization", Value: "Bearer " + key},
		{Name: "HTTP-Referer", Value: sdAimlapiReferer},
		{Name: "X-Title", Value: sdAimlapiTitle},
		{Name: "Content-Length", Value: strconvItoa(len(payload))},
	}
	response, err := outbound.Send(request.Context(), outbound.Request{
		URL:     target,
		Method:  http.MethodPost,
		Headers: headers,
		Body:    payload,
	}, 120*time.Second)
	if err != nil {
		respondText(w, http.StatusInternalServerError, "text/html; charset=utf-8", "Internal error")
		return
	}
	if !outboundOK(response) {
		// `res.status(500).send(err)` forwards the provider TEXT.
		respondText(w, http.StatusInternalServerError, "text/html; charset=utf-8", string(response.Body))
		return
	}
	decoded, err := decodeOrderedNodeJSON(response.Body)
	if err != nil {
		respondText(w, http.StatusInternalServerError, "text/html; charset=utf-8", "Internal error")
		return
	}
	// `Array.isArray(data.images) ? data.images[0] : data.data?.[0]`
	entry := nodeUndefined()
	if images := nodeGet(decoded, "images"); images.kind == 'a' {
		if len(images.array) > 0 {
			entry = images.array[0]
		}
	} else if data := nodeGet(decoded, "data"); data.kind == 'a' && len(data.array) > 0 {
		entry = data.array[0]
	}
	if entry.isUndefined() || entry.kind != 'o' {
		respondText(w, http.StatusInternalServerError, "text/html; charset=utf-8", "No image returned")
		return
	}
	base64Value := ""
	for _, member := range []string{"b64_json", "base64"} {
		if value, present := entry.member(member); present && jsTruthyNode(value) {
			if text, err := value.javascriptString(); err == nil {
				base64Value = text
				break
			}
		}
	}
	if base64Value == "" {
		if value, present := entry.member("url"); present && jsTruthyNode(value) {
			url, err := value.javascriptString()
			if err != nil {
				respondText(w, http.StatusInternalServerError, "text/html; charset=utf-8", "Internal error")
				return
			}
			fetched, err := outbound.Send(request.Context(), outbound.Request{
				URL:     url,
				Method:  http.MethodGet,
				Headers: []outbound.Header{{Name: "Host", Value: hostOf(url)}},
			}, 120*time.Second)
			if err != nil || !outboundOK(fetched) {
				respondText(w, http.StatusInternalServerError, "text/html; charset=utf-8", "Internal error")
				return
			}
			base64Value = base64.StdEncoding.EncodeToString(fetched.Body)
		} else {
			respondText(w, http.StatusInternalServerError, "text/html; charset=utf-8", "Internal error")
			return
		}
	}
	answer := nodeObject()
	answer.setMember("format", nodeString("png"))
	answer.setMember("data", nodeString(base64Value))
	encoded, err := marshalCharacterJSON(answer)
	if err != nil {
		respondText(w, http.StatusInternalServerError, "text/html; charset=utf-8", "Internal error")
		return
	}
	respondJSONBytes(w, http.StatusOK, encoded)
}
