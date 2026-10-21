package server

// The two pinned Gemini media routes that are a SINGLE forwarded request:
//
//	POST /api/google/caption-image    google.js:234
//	POST /api/google/generate-image   google.js:432
//
// Neither re-encodes an image, which is why both are comparable through HTTP rather than belonging to the
// Jimp codec boundary: caption-image only string-splits the incoming data URI and returns the model's
// TEXT, and generate-image passes the provider's `bytesBase64Encoded` straight through.
//
// Pinned details a reasonable implementation would flatten, each recorded in the oracle:
//
//   - caption-image splits `image` twice with no guard, so an absent or non-string member throws and the
//     catch answers 500 `Internal server error` with NO request;
//   - a malformed data URI leaves `mimeType`/`data` undefined, and `JSON.stringify` DROPS them, so the
//     forwarded part is `{"inlineData":{}}` rather than carrying the string "undefined";
//   - a provider error is flattened: caption-image answers 500 `{error:true}` whatever the provider
//     status was, and both routes answer 500 with a fixed TEXT message;
//   - generate-image's parameter block is built with `undefined` members that JSON.stringify drops, and
//     which members exist depends on `api === 'vertexai'` and on whether the model is deprecated
//     (`imagegeneration*`);
//   - `personGeneration` comes from the runtime config, so it is read through the same resolver the rest
//     of the server uses rather than hardcoded.

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/cocokoishi/gotavern/internal/outbound"
)

func init() {
	domainRouteRegistrars = append(domainRouteRegistrars, registerGoogleMediaRoutes)
}

func registerGoogleMediaRoutes(mux *http.ServeMux, accounts *accountRuntime, notFoundPage []byte, options HTTPHandlerOptions) {
	post := func(route string, handler func(http.ResponseWriter, *http.Request, HTTPHandlerOptions)) {
		mux.HandleFunc(route, func(w http.ResponseWriter, r *http.Request) {
			if r.Method != http.MethodPost {
				serveStatic(w, r, notFoundPage, options)
				return
			}
			handler(w, r, options)
		})
	}
	post("/api/google/caption-image", accounts.serveGoogleCaptionImage)
	post("/api/google/generate-image", accounts.serveGoogleGenerateImage)
}

// googleTextFailure writes the pinned `res.status(500).send('...')`, which Express types as html.
func googleTextFailure(w http.ResponseWriter, message string) {
	respondText(w, http.StatusInternalServerError, "text/html; charset=utf-8", message)
}

// googleCaptionJSONError writes the pinned `res.status(500).send({ error: true })`.
func googleCaptionJSONError(w http.ResponseWriter) {
	answer := nodeObject()
	answer.setMember("error", nodeBool(true))
	body, err := marshalCharacterJSON(answer)
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	respondJSONBytes(w, http.StatusInternalServerError, body)
}

// googleRawMemberString is `String(value)` for a raw member that the pinned code calls a string method on.
// The second result is false when the member is absent or not a string, which is the case the pinned code
// turns into a TypeError.
func googleRawMemberString(input map[string]json.RawMessage, name string) (string, bool) {
	raw, present := input[name]
	if !present || len(raw) == 0 {
		return "", false
	}
	value, err := decodeOrderedNodeJSON(raw)
	if err != nil || value.kind != 's' {
		return "", false
	}
	return value.scalar.(string), true
}

func (runtime *accountRuntime) serveGoogleCaptionImage(w http.ResponseWriter, request *http.Request, options HTTPHandlerOptions) {
	directories, ok := runtime.secretsDirectories(w, request)
	if !ok {
		return
	}
	_, input, bodyOK := readUserPresetRequestBody(request)
	if !bodyOK {
		googleTextFailure(w, "Internal server error")
		return
	}
	image, isString := googleRawMemberString(input, "image")
	if !isString {
		// `request.body.image.split(...)` on a missing member throws, and the pinned catch answers this.
		googleTextFailure(w, "Internal server error")
		return
	}
	mimeType := ""
	if head := strings.SplitN(image, ";", 2)[0]; strings.Contains(head, ":") {
		mimeType = strings.SplitN(head, ":", 2)[1]
	}
	base64Data := ""
	if parts := strings.SplitN(image, ",", 2); len(parts) > 1 {
		base64Data = parts[1]
	}
	model := "gemini-2.0-flash"
	if value, present := googleRawMemberString(input, "model"); present && value != "" {
		model = value
	}

	config, err := runtime.googleAPIConfigFor(request, directories, options, input, model, "generateContent")
	if err != nil {
		googleTextFailure(w, "Internal server error")
		return
	}

	inlineData := nodeObject()
	if mimeType != "" {
		inlineData.setMember("mimeType", nodeString(mimeType))
	}
	if base64Data != "" {
		inlineData.setMember("data", nodeString(base64Data))
	}
	imagePart := nodeObject()
	imagePart.setMember("inlineData", inlineData)
	parts := nodeArray()
	if prompt, present := googleRawMemberString(input, "prompt"); present {
		textPart := nodeObject()
		textPart.setMember("text", nodeString(prompt))
		parts.array = append(parts.array, textPart)
	} else {
		parts.array = append(parts.array, nodeObject())
	}
	parts.array = append(parts.array, imagePart)
	content := nodeObject()
	content.setMember("role", nodeString("user"))
	content.setMember("parts", parts)
	contents := nodeArray()
	contents.array = append(contents.array, content)
	payload := nodeObject()
	payload.setMember("contents", contents)
	payload.setMember("safetySettings", googleSafetyArray(config.safety))
	body, err := marshalCharacterJSON(payload)
	if err != nil {
		googleTextFailure(w, "Internal server error")
		return
	}

	response, err := outbound.Send(request.Context(), outbound.Request{
		URL:     config.url,
		Method:  http.MethodPost,
		Headers: googleRequestHeaders(config.url, config.headers, len(body)),
		Body:    body,
	}, 120*time.Second)
	if err != nil {
		googleTextFailure(w, "Internal server error")
		return
	}
	if !outboundOK(response) {
		googleCaptionJSONError(w)
		return
	}
	decoded, err := decodeOrderedNodeJSON(response.Body)
	if err != nil {
		googleTextFailure(w, "Internal server error")
		return
	}
	candidates := nodeGet(decoded, "candidates")
	if candidates.kind != 'a' {
		googleTextFailure(w, "No candidates found, image was most likely filtered.")
		return
	}
	caption := ""
	if len(candidates.array) > 0 {
		if content, present := candidates.array[0].member("content"); present {
			if parts, hasParts := content.member("parts"); hasParts && parts.kind == 'a' && len(parts.array) > 0 {
				if text, hasText := parts.array[0].member("text"); hasText && text.kind == 's' && text.scalar.(string) != "" {
					caption = text.scalar.(string)
				}
			}
		}
	}
	if caption == "" {
		googleTextFailure(w, "No caption found")
		return
	}
	answer := nodeObject()
	answer.setMember("caption", nodeString(caption))
	encoded, err := marshalCharacterJSON(answer)
	if err != nil {
		googleTextFailure(w, "Internal server error")
		return
	}
	respondJSONBytes(w, http.StatusOK, encoded)
}

// googleSafetyArray renders the pinned safety settings in order.
func googleSafetyArray(settings []googleSafetySetting) orderedNodeJSON {
	array := nodeArray()
	for _, setting := range settings {
		entry := nodeObject()
		entry.setMember("category", nodeString(setting.category))
		entry.setMember("threshold", nodeString(setting.threshold))
		array.array = append(array.array, entry)
	}
	return array
}

func googleRequestHeaders(target string, headers []outbound.Header, bodyLength int) []outbound.Header {
	result := append([]outbound.Header{{Name: "Host", Value: hostOf(target)}}, headers...)
	if bodyLength > 0 {
		result = append(result, outbound.Header{Name: "Content-Length", Value: strconvItoa(bodyLength)})
	}
	return result
}

func (runtime *accountRuntime) serveGoogleGenerateImage(w http.ResponseWriter, request *http.Request, options HTTPHandlerOptions) {
	directories, ok := runtime.secretsDirectories(w, request)
	if !ok {
		return
	}
	_, input, bodyOK := readUserPresetRequestBody(request)
	if !bodyOK {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	model := "imagen-3.0-generate-002"
	if value, present := googleRawMemberString(input, "model"); present && value != "" {
		model = value
	}
	config, err := runtime.googleAPIConfigFor(request, directories, options, input, model, "predict")
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}

	isVertex := false
	if value, present := googleRawMemberString(input, "api"); present {
		isVertex = value == "vertexai"
	}
	isDeprecated := strings.HasPrefix(model, "imagegeneration")
	personGeneration := googleConfigValue(options, []string{"gemini", "image", "personGeneration"}, "allow_adult")

	instance := nodeObject()
	prompt := ""
	if value, present := googleRawMemberString(input, "prompt"); present {
		prompt = value
	}
	instance.setMember("prompt", nodeString(prompt))
	instances := nodeArray()
	instances.array = append(instances.array, instance)

	parameters := nodeObject()
	parameters.setMember("sampleCount", nodeNumber(1))
	if isVertex {
		seed := nodeNumber(float64(sdRandomSeedNumber(1000000)))
		if raw, present := input["seed"]; present && len(raw) > 0 {
			if value, err := decodeOrderedNodeJSON(raw); err == nil {
				seed = nodeNumber(javascriptToNumber(value))
			}
		}
		parameters.setMember("seed", seed)
		enhance := false
		if raw, present := input["enhance"]; present && len(raw) > 0 {
			if value, err := decodeOrderedNodeJSON(raw); err == nil {
				enhance = jsTruthyNode(value)
			}
		}
		parameters.setMember("enhancePrompt", nodeBool(enhance))
		if value, present := googleRawMemberString(input, "negative_prompt"); present && value != "" {
			parameters.setMember("negativePrompt", nodeString(value))
		}
	}
	aspectRatio := "1:1"
	if value, present := googleRawMemberString(input, "aspect_ratio"); present && value != "" {
		aspectRatio = value
	}
	parameters.setMember("aspectRatio", nodeString(aspectRatio))
	if !isDeprecated && personGeneration != "" {
		parameters.setMember("personGeneration", nodeString(personGeneration))
	}
	if isVertex {
		parameters.setMember("language", nodeString("auto"))
	}
	if !isDeprecated {
		if isVertex {
			parameters.setMember("safetySetting", nodeString("block_only_high"))
		} else {
			parameters.setMember("safetySetting", nodeString("block_low_and_above"))
		}
	}
	if isVertex {
		parameters.setMember("addWatermark", nodeBool(false))
	}
	outputOptions := nodeObject()
	outputOptions.setMember("mimeType", nodeString("image/jpeg"))
	outputOptions.setMember("compressionQuality", nodeNumber(100))
	parameters.setMember("outputOptions", outputOptions)

	payload := nodeObject()
	payload.setMember("instances", instances)
	payload.setMember("parameters", parameters)
	body, err := marshalCharacterJSON(payload)
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}

	response, err := outbound.Send(request.Context(), outbound.Request{
		URL:     config.url,
		Method:  http.MethodPost,
		Headers: googleRequestHeaders(config.url, config.headers, len(body)),
		Body:    body,
	}, 120*time.Second)
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	if !outboundOK(response) {
		googleTextFailure(w, "Image generation request failed")
		return
	}
	decoded, err := decodeOrderedNodeJSON(response.Body)
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	image := ""
	if predictions := nodeGet(decoded, "predictions"); predictions.kind == 'a' && len(predictions.array) > 0 {
		if value, present := predictions.array[0].member("bytesBase64Encoded"); present && value.kind == 's' {
			image = value.scalar.(string)
		}
	}
	if image == "" {
		googleTextFailure(w, "No image data found in response")
		return
	}
	answer := nodeObject()
	answer.setMember("image", nodeString(image))
	encoded, err := marshalCharacterJSON(answer)
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	respondJSONBytes(w, http.StatusOK, encoded)
}
