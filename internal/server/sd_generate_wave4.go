// Wave 4 of the SD generation routes: the two providers that were left `not implemented` behind a
// STALE reason. The old `notImplementedReasons` entries claimed their native FormData parts were not
// observable through the probe peer; `tools/lib/pinned-outbound.mjs` `recordBody` has since gained
// `[object FormData]` part capture, so both routes are pinnable and that reason is deleted rather
// than repeated.
//
//   /api/sd/stability/generate  stable-diffusion.js:1085
//   /api/sd/workersai/generate  stable-diffusion.js:2108

package server

import (
	"bytes"
	"encoding/base64"
	"math"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"regexp"
	"strings"
	"time"

	"github.com/cocokoishi/gotavern/internal/outbound"
)

const sdStabilityDefaultURL = "https://api.stability.ai"

// sdStabilityURL is its own seam: the endpoint depends on the selected model, and the base is the
// hardcoded literal `https://api.stability.ai`.
func sdStabilityURL() string {
	return sdSeamURL("GOTAVERN_SD_STABILITY_URL", sdStabilityDefaultURL)
}

// sdMultipartPart is one string field of a native FormData body. The pinned routes build FormData
// with `formData.append(name, String(value))`, so every part is a plain string field in insertion
// order and the boundary is the only random part (which the fixture never records).
type sdMultipartPart struct {
	name  string
	value string
}

func sdMultipartBody(parts []sdMultipartPart) ([]byte, string, error) {
	var buffer bytes.Buffer
	writer := multipart.NewWriter(&buffer)
	for _, part := range parts {
		header := textproto.MIMEHeader{}
		header.Set("Content-Disposition", `form-data; name="`+part.name+`"`)
		field, err := writer.CreatePart(header)
		if err != nil {
			return nil, "", err
		}
		if _, err := field.Write([]byte(part.value)); err != nil {
			return nil, "", err
		}
	}
	if err := writer.Close(); err != nil {
		return nil, "", err
	}
	return buffer.Bytes(), writer.FormDataContentType(), nil
}

// serveSDStabilityGenerate is stable-diffusion.js:1085. The key is required (400), the model selects
// one of three hardcoded endpoints (anything else throws into the catch, 500), the payload becomes a
// native FormData whose entries skip `undefined` values and stringify everything else, the request
// carries Bearer auth and `Accept: image/*`, and the answer bytes are returned as plain base64 text.
func (runtime *accountRuntime) serveSDStabilityGenerate(w http.ResponseWriter, request *http.Request) {
	_, directories, ok := runtime.sdUser(w, request)
	if !ok {
		return
	}
	key, err := sdReadSecret(directories, "api_key_stability")
	if err != nil {
		serveSDStatus(w, http.StatusInternalServerError)
		return
	}
	if key == "" {
		serveSDStatus(w, http.StatusBadRequest)
		return
	}
	body, ok := runtime.sdRequestBody(w, request)
	if !ok {
		return
	}
	model, err := pinnedJSStringValue(sdBodyMember(body, "model"))
	if err != nil {
		serveSDStatus(w, http.StatusInternalServerError)
		return
	}
	var endpoint string
	switch model {
	case "stable-image-ultra":
		endpoint = sdStabilityURL() + "/v2beta/stable-image/generate/ultra"
	case "stable-image-core":
		endpoint = sdStabilityURL() + "/v2beta/stable-image/generate/core"
	case "stable-diffusion-3":
		endpoint = sdStabilityURL() + "/v2beta/stable-image/generate/sd3"
	default:
		serveSDStatus(w, http.StatusInternalServerError)
		return
	}
	payload := sdBodyMember(body, "payload")
	// `Object.entries(payload)` throws on undefined or null, which the pinned catch turns into 500.
	if payload.kind != 'o' {
		serveSDStatus(w, http.StatusInternalServerError)
		return
	}
	parts := make([]sdMultipartPart, 0, len(payload.object))
	for _, entry := range payload.object {
		if entry.value.isUndefined() {
			continue
		}
		text, stringErr := pinnedJSStringValue(entry.value)
		if stringErr != nil {
			serveSDStatus(w, http.StatusInternalServerError)
			return
		}
		parts = append(parts, sdMultipartPart{name: entry.key, value: text})
	}
	encoded, contentType, buildErr := sdMultipartBody(parts)
	if buildErr != nil {
		serveSDStatus(w, http.StatusInternalServerError)
		return
	}
	data, ok := sdPostBytes(request, endpoint, []outbound.Header{
		{Name: "Authorization", Value: "Bearer " + key},
		{Name: "Accept", Value: "image/*"},
		{Name: "Content-Type", Value: contentType},
	}, encoded)
	if !ok {
		serveSDStatus(w, http.StatusInternalServerError)
		return
	}
	respondText(w, http.StatusOK, "text/html; charset=utf-8", base64.StdEncoding.EncodeToString(data))
}

var sdWorkersAIFlux2 = regexp.MustCompile(`flux-2`)

// sdWorkersAINumber is `Number(value)` for a JSON member, mapped to the `null` JSON.stringify emits
// for NaN.
func sdWorkersAINumber(value orderedNodeJSON) orderedNodeJSON {
	number := pinnedJSToNumber(value)
	if math.IsNaN(number) || math.IsInf(number, 0) {
		return orderedNodeJSON{kind: 'n'}
	}
	return nodeNumber(number)
}

// serveSDWorkersAIGenerate is stable-diffusion.js:2108. The key, the trimmed account id and the
// trimmed model are all required (400 each). The account id is `encodeURIComponent`'d into the path
// while the model is interpolated RAW, the body is a projection with JS truthiness/Number coercion
// and a `seed >= 0` gate, and `/flux-2/` selects a native FormData body instead of JSON. A non-ok
// answer forwards the provider TEXT at 500; a JSON answer yields `{format:'png', image}` from
// `result.image` or `image`, and any other content type is returned as base64 bytes.
func (runtime *accountRuntime) serveSDWorkersAIGenerate(w http.ResponseWriter, request *http.Request) {
	_, directories, ok := runtime.sdUser(w, request)
	if !ok {
		return
	}
	key, err := sdReadSecret(directories, "api_key_workers_ai")
	if err != nil {
		serveSDStatus(w, http.StatusInternalServerError)
		return
	}
	if key == "" {
		serveSDStatus(w, http.StatusBadRequest)
		return
	}
	body, ok := runtime.sdRequestBody(w, request)
	if !ok {
		return
	}
	accountID, err := pinnedJSStringValue(sdBodyMember(body, "account_id"))
	if err != nil {
		serveSDStatus(w, http.StatusInternalServerError)
		return
	}
	accountID = strings.TrimSpace(accountID)
	if accountID == "" {
		serveSDStatus(w, http.StatusBadRequest)
		return
	}
	model, err := pinnedJSStringValue(sdBodyMember(body, "model"))
	if err != nil {
		serveSDStatus(w, http.StatusInternalServerError)
		return
	}
	model = strings.TrimSpace(model)
	if model == "" {
		serveSDStatus(w, http.StatusBadRequest)
		return
	}
	target := sdWorkersAIURL() + "/client/v4/accounts/" + sdEncodeURIComponent(accountID) + "/ai/run/" + model

	projection := nodeObject()
	if prompt := sdBodyMember(body, "prompt"); !prompt.isUndefined() {
		projection.setMember("prompt", prompt)
	}
	if negative := sdBodyMember(body, "negative_prompt"); pinnedJSTruthy(negative) {
		projection.setMember("negative_prompt", negative)
	}
	if width := sdBodyMember(body, "width"); pinnedJSTruthy(width) {
		projection.setMember("width", sdWorkersAINumber(width))
	}
	if height := sdBodyMember(body, "height"); pinnedJSTruthy(height) {
		projection.setMember("height", sdWorkersAINumber(height))
	}
	if steps := sdBodyMember(body, "steps"); pinnedJSTruthy(steps) {
		projection.setMember("num_steps", sdWorkersAINumber(steps))
	}
	if scale := sdBodyMember(body, "scale"); pinnedJSTruthy(scale) {
		projection.setMember("guidance", sdWorkersAINumber(scale))
	}
	// `request.body.seed >= 0` is a JS comparison: null >= 0 is TRUE, undefined is false, a numeric
	// string coerces.
	if seed := sdBodyMember(body, "seed"); pinnedJSGreaterThanOrEqualZero(seed) {
		projection.setMember("seed", sdWorkersAINumber(seed))
	}

	headers := []outbound.Header{{Name: "Authorization", Value: "Bearer " + key}}
	var payload []byte
	if sdWorkersAIFlux2.MatchString(model) {
		parts := make([]sdMultipartPart, 0, len(projection.object))
		for _, entry := range projection.object {
			text, stringErr := pinnedJSStringValue(entry.value)
			if stringErr != nil {
				serveSDStatus(w, http.StatusInternalServerError)
				return
			}
			parts = append(parts, sdMultipartPart{name: entry.key, value: text})
		}
		encoded, contentType, buildErr := sdMultipartBody(parts)
		if buildErr != nil {
			serveSDStatus(w, http.StatusInternalServerError)
			return
		}
		payload = encoded
		headers = append(headers, outbound.Header{Name: "Content-Type", Value: contentType})
	} else {
		encoded, marshalErr := marshalOrderedNodeJSON(projection)
		if marshalErr != nil {
			serveSDStatus(w, http.StatusInternalServerError)
			return
		}
		payload = encoded
		headers = append(headers, outbound.Header{Name: "Content-Type", Value: "application/json"})
	}
	all := append([]outbound.Header{{Name: "Host", Value: hostOf(target)}}, headers...)
	if len(payload) > 0 {
		all = append(all, outbound.Header{Name: "Content-Length", Value: strconvItoa(len(payload))})
	}
	response, sendErr := outbound.Send(request.Context(), outbound.Request{
		URL:     target,
		Method:  http.MethodPost,
		Headers: all,
		Body:    payload,
	}, 120*time.Second)
	if sendErr != nil || response == nil {
		serveSDStatus(w, http.StatusInternalServerError)
		return
	}
	if !outboundOK(response) {
		// A non-ok answer forwards the provider TEXT at 500; a transport error above is a plain 500.
		respondText(w, http.StatusInternalServerError, "text/html; charset=utf-8", string(response.Body))
		return
	}
	data := response.Body
	if strings.Contains(response.Header("content-type"), "application/json") {
		decoded, decodeErr := decodeOrderedNodeJSON(data)
		if decodeErr != nil {
			serveSDStatus(w, http.StatusInternalServerError)
			return
		}
		image := nodeUndefined()
		if result := sdBodyMember(decoded, "result"); result.kind == 'o' {
			image = sdBodyMember(result, "image")
		}
		if !pinnedJSTruthy(image) {
			image = sdBodyMember(decoded, "image")
		}
		if !pinnedJSTruthy(image) {
			serveSDStatus(w, http.StatusInternalServerError)
			return
		}
		result := nodeObject()
		result.setMember("format", nodeString("png"))
		result.setMember("image", image)
		searchJSON(w, result)
		return
	}
	result := nodeObject()
	result.setMember("format", nodeString("png"))
	result.setMember("image", nodeString(base64.StdEncoding.EncodeToString(data)))
	searchJSON(w, result)
}

// pinnedJSGreaterThanOrEqualZero is `value >= 0` with JavaScript ToNumber coercion: null coerces to
// 0 and passes, undefined is false, and a numeric string coerces.
func pinnedJSGreaterThanOrEqualZero(value orderedNodeJSON) bool {
	if value.isUndefined() {
		return false
	}
	number := pinnedJSToNumber(value)
	return !math.IsNaN(number) && number >= 0
}
