package server

// Pinned stable-diffusion GENERATION routes, wave 1. From src/endpoints/stable-diffusion.js:
//
//	POST /api/sd/pollinations/generate  stable-diffusion.js:1038
//	POST /api/sd/together/generate      stable-diffusion.js:778
//
// These are the two single-request shapes of the generate family and they establish the pattern the rest
// reuse: an image payload carried as base64 with a content-type-derived format, a request body whose
// member ORDER and omitted-undefined members are behaviour, and a per-provider seam asserted against the
// pinned literal.
//
// THE SENTENCE THAT STOOD HERE -- "the other seventeen `/api/sd/*/generate*` routes stay `not implemented`" --
// WAS WRONG, and corrected 2026-10-29 by reading the registrations: all nineteen are implemented, in
// `sd_generate.go` (this file), `sd_generate_wave2.go`, `sd_generate_wave5.go`, `sd_generate_comfy.go`,
// `sd_zai.go` and `sd.go:108,132,136,145,146`. `docs/compat-matrix.md` already recorded all 19 as implemented,
// so the code and the ledger agreed and only this header disagreed with both -- which is exactly how a stale
// comment becomes a phantom boundary. The registrations are the answer; a header is not.
//
// Pinned details a careful implementation would get wrong, each recorded:
//
//   - Pollinations builds its upstream URL as `/image/<encodeURIComponent(prompt)>` with a query whose
//     members are model, negative_prompt, seed, width, height (in that order), `String(undefined)` for an
//     absent prompt/negative prompt, the 1024 defaults via `??`, and `enhance=true` only when truthy;
//   - Pollinations derives the answer FORMAT from the response content type (`mime.extension || 'jpg'`),
//     so the bytes and the format come from different places;
//   - Together's body is a fixed member order with `n: 1` and a seed that is randomized when the request
//     seed is negative or absent, and it FALLS BACK to fetching `data[0].url` when `b64_json` is missing.

import (
	"crypto/rand"
	"encoding/base64"
	"math/big"
	"net/http"
	"strconv"
	"time"

	"github.com/cocokoishi/gotavern/internal/outbound"
	"github.com/cocokoishi/gotavern/internal/startup"
)

func init() {
	domainRouteRegistrars = append(domainRouteRegistrars, registerSDGenerateRoutes)
}

func registerSDGenerateRoutes(mux *http.ServeMux, accounts *accountRuntime, notFoundPage []byte, options HTTPHandlerOptions) {
	post := func(route string, handler func(http.ResponseWriter, *http.Request)) {
		mux.HandleFunc(route, func(w http.ResponseWriter, r *http.Request) {
			if r.Method != http.MethodPost {
				serveStatic(w, r, notFoundPage, options)
				return
			}
			handler(w, r)
		})
	}
	post("/api/sd/pollinations/generate", accounts.serveSDPollinationsGenerate)
	post("/api/sd/together/generate", accounts.serveSDTogetherGenerate)
}

// serveSDPollinationsGenerate fetches one image and answers `{ image, format }`.
func (runtime *accountRuntime) serveSDPollinationsGenerate(w http.ResponseWriter, request *http.Request) {
	directories, ok := runtime.secretsDirectories(w, request)
	if !ok {
		return
	}
	key, err := startup.ReadSecretString(directories, "api_key_pollinations")
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	if key == "" {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	_, input, bodyOK := readUserPresetRequestBody(request)
	if !bodyOK {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	prompt := sdRawJavaScriptString(input["prompt"])
	model := sdRawJavaScriptString(input["model"])
	negativePrompt := sdRawJavaScriptString(input["negative_prompt"])
	seed := sdRandomSeed(input["seed"], 10000000)
	width := sdRawJavaScriptString(sdNullishRaw(input["width"], "1024"))
	height := sdRawJavaScriptString(sdNullishRaw(input["height"], "1024"))
	pairs := [][2]string{
		{"model", model},
		{"negative_prompt", negativePrompt},
		{"seed", seed},
		{"width", width},
		{"height", height},
	}
	if raw, present := input["enhance"]; present && nodeTruthyJSON(raw) {
		pairs = append(pairs, [2]string{"enhance", "true"})
	}
	target := sdPollinationsURL() + "/image/" + encodeURIComponentJS(prompt) + "?" + urlSearchParamsEncode(pairs)
	response, err := outbound.Send(request.Context(), outbound.Request{
		URL:    target,
		Method: http.MethodGet,
		Headers: []outbound.Header{
			{Name: "Host", Value: hostOf(target)},
			{Name: "Authorization", Value: "Bearer " + key},
		},
	}, 120*time.Second)
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	if !outboundOK(response) {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	contentType := response.Header("Content-Type")
	if contentType == "" {
		contentType = "image/jpeg"
	}
	format := sdImageExtensionFromContentType(contentType)
	answer := nodeObject()
	answer.setMember("image", nodeString(base64.StdEncoding.EncodeToString(response.Body)))
	answer.setMember("format", nodeString(format))
	encoded, err := marshalCharacterJSON(answer)
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	respondJSONBytes(w, http.StatusOK, encoded)
}

// serveSDTogetherGenerate posts to the Together image endpoint and answers `{ format, data }`.
func (runtime *accountRuntime) serveSDTogetherGenerate(w http.ResponseWriter, request *http.Request) {
	directories, ok := runtime.secretsDirectories(w, request)
	if !ok {
		return
	}
	key, err := startup.ReadSecretString(directories, "api_key_togetherai")
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	if key == "" {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	_, input, bodyOK := readUserPresetRequestBody(request)
	if !bodyOK {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	payload := nodeObject()
	setRawMember(&payload, "prompt", input["prompt"])
	setRawMember(&payload, "negative_prompt", input["negative_prompt"])
	setRawMember(&payload, "height", input["height"])
	setRawMember(&payload, "width", input["width"])
	setRawMember(&payload, "model", input["model"])
	setRawMember(&payload, "steps", input["steps"])
	payload.setMember("n", nodeNumber(1))
	if raw, present := input["seed"]; present && !isJSONNull(raw) {
		value, decodeErr := decodeOrderedNodeJSON(raw)
		if decodeErr == nil && javascriptToNumber(value) >= 0 {
			payload.setMember("seed", value)
		} else {
			payload.setMember("seed", nodeNumber(float64(sdRandomSeedNumber(10000000))))
		}
	} else {
		payload.setMember("seed", nodeNumber(float64(sdRandomSeedNumber(10000000))))
	}
	body, err := marshalCharacterJSON(payload)
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	target := sdTogetherURL() + "/v1/images/generations"
	response, err := outbound.Send(request.Context(), outbound.Request{
		URL:    target,
		Method: http.MethodPost,
		Headers: []outbound.Header{
			{Name: "Host", Value: hostOf(target)},
			{Name: "Content-Type", Value: "application/json"},
			{Name: "Authorization", Value: "Bearer " + key},
			{Name: "Content-Length", Value: strconvItoa(len(body))},
		},
		Body: body,
	}, 120*time.Second)
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	if !outboundOK(response) {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	decoded, err := decodeOrderedNodeJSON(response.Body)
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	// `data?.data?.[0]` then `choice.b64_json`: a missing entry or member throws in the pinned handler.
	data := nodeGet(decoded, "data")
	if data.kind != 'a' || len(data.array) == 0 {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	b64, hasB64 := hordeStringMember(data.array[0], "b64_json")
	if !hasB64 || b64 == "" {
		url, hasURL := hordeStringMember(data.array[0], "url")
		if !hasURL || url == "" {
			serveStatusText(w, http.StatusInternalServerError)
			return
		}
		fetched, err := outbound.Send(request.Context(), outbound.Request{
			URL:     url,
			Method:  http.MethodGet,
			Headers: []outbound.Header{{Name: "Host", Value: hostOf(url)}},
		}, 120*time.Second)
		if err != nil {
			serveStatusText(w, http.StatusInternalServerError)
			return
		}
		b64 = base64.StdEncoding.EncodeToString(fetched.Body)
	}
	answer := nodeObject()
	answer.setMember("format", nodeString("jpg"))
	answer.setMember("data", nodeString(b64))
	encoded, err := marshalCharacterJSON(answer)
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	respondJSONBytes(w, http.StatusOK, encoded)
}

// sdRawJavaScriptString is `String(value)` for a raw body member, with an absent member reading as
// `undefined` (which is what the pinned template literals and URLSearchParams produce).
func sdRawJavaScriptString(raw []byte) string {
	if len(raw) == 0 {
		return "undefined"
	}
	value, err := decodeOrderedNodeJSON(raw)
	if err != nil {
		return "undefined"
	}
	return javascriptStringOf(value)
}

// sdNullishRaw applies `??` to a raw member, returning a JSON string for the fallback when absent or null.
func sdNullishRaw(raw []byte, fallback string) []byte {
	if len(raw) == 0 || isJSONNull(raw) {
		return marshalJSONString(fallback)
	}
	return raw
}

// sdRandomSeed reproduces `String(request.body.seed >= 0 ? request.body.seed : Math.floor(Math.random() * max))`.
func sdRandomSeed(raw []byte, limit int64) string {
	if len(raw) > 0 {
		if value, err := decodeOrderedNodeJSON(raw); err == nil && javascriptToNumber(value) >= 0 {
			return javascriptStringOf(value)
		}
	}
	return strconv.FormatInt(sdRandomSeedNumber(limit), 10)
}

// sdRandomSeedNumber is the shared random integer used by both providers.
func sdRandomSeedNumber(limit int64) int64 {
	bigLimit := big.NewInt(limit)
	value, err := rand.Int(rand.Reader, bigLimit)
	if err != nil {
		return 0
	}
	return value.Int64()
}

// sdImageExtensionFromContentType reproduces `mime.extension(type) || 'jpg'` for the media types the
// oracle pins. The mapping is a table rather than the host MIME database so it cannot vary by machine.
func sdImageExtensionFromContentType(contentType string) string {
	mediaType := contentType
	for index := 0; index < len(mediaType); index++ {
		if mediaType[index] == ';' {
			mediaType = mediaType[:index]
			break
		}
	}
	switch lowerTrim(mediaType) {
	case "image/png":
		return "png"
	case "image/jpeg":
		return "jpg"
	case "image/webp":
		return "webp"
	case "image/gif":
		return "gif"
	default:
		return "jpg"
	}
}

// lowerTrim lowercases and trims a media type; kept local so the SD file does not pull in strings for one
// call site in a hot path.
func lowerTrim(value string) string {
	start := 0
	end := len(value)
	for start < end && (value[start] == ' ' || value[start] == '\t') {
		start++
	}
	for end > start && (value[end-1] == ' ' || value[end-1] == '\t') {
		end--
	}
	trimmed := value[start:end]
	result := make([]byte, len(trimmed))
	for index := 0; index < len(trimmed); index++ {
		character := trimmed[index]
		if character >= 'A' && character <= 'Z' {
			character = character + ('a' - 'A')
		}
		result[index] = character
	}
	return string(result)
}
