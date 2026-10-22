package server

// Pinned MiniMax text-to-speech route, from src/endpoints/minimax.js:19:
//
//	POST /api/minimax/generate-voice
//
// The handler has EIGHT destructuring initializers on the request body (apiHost, model, speed,
// volume, pitch, audioSampleRate, bitrate, format). A destructuring initializer fires on
// `undefined` ONLY, which is NOT the `||` rule: `apiHost: null` is used verbatim and produces the
// relative URL `null/v1/t2a_v2`, which the transport rejects, and the route's outer catch answers
// 500 "Internal server error". Every default is an observable, so the fixture records both
// directions for each of the eight (sillytavern-1.19.0-minimax.json, recorded by
// tools/probe-minimax.mjs).
//
// The five numeric members go through `Number()`, and `JSON.stringify` renders NaN as null, so an
// unparseable `speed` reaches the provider as `"speed":null` rather than as 0 or as a string.
//
// `format` is used verbatim in the body AND selects the response MIME type through
// `getAudioMimeType`, whose table lookup is followed by a `|| 'audio/mpeg'` fallback.
//
// The response is either a decoded hex payload or (when the provider answers with a URL) a SECOND
// outbound request whose bytes are streamed back.
//
// The upstream host is the pinned literal `https://api.minimax.io` and is reachable only through
// this route's own seam, whose default is asserted against the fixture so it cannot drift.

import (
	"math"
	"net/http"
	"strconv"
	"strings"
	"unicode/utf16"
)

const minimaxDefaultAPIHost = "https://api.minimax.io"

// minimaxAPIHost is the seam for the destructuring DEFAULT of `apiHost`. A host supplied in the
// request body wins over it, exactly as a present destructured member wins over its initializer;
// the seam only replaces the pinned literal.
func minimaxAPIHost() string { return sdSeamURL("GOTAVERN_MINIMAX_API_URL", minimaxDefaultAPIHost) }

func init() {
	domainRouteRegistrars = append(domainRouteRegistrars, registerMiniMaxRoutes)
}

func registerMiniMaxRoutes(mux *http.ServeMux, accounts *accountRuntime, notFoundPage []byte, options HTTPHandlerOptions) {
	mux.HandleFunc("/api/minimax/generate-voice", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			serveStatic(w, r, notFoundPage, options)
			return
		}
		accounts.serveMiniMaxGenerateVoice(w, r)
	})
}

// minimaxAudioMIMETypes is the pinned getAudioMimeType table. A value outside it falls back to
// audio/mpeg through the `||` in the pinned code.
var minimaxAudioMIMETypes = map[string]string{
	"mp3":  "audio/mpeg",
	"wav":  "audio/wav",
	"pcm":  "audio/pcm",
	"flac": "audio/flac",
	"aac":  "audio/aac",
}

// minimaxAudioMIMEType is `getAudioMimeType(format)`. The table is indexed by the JavaScript String
// conversion of the value, but every key is a lowercase word, so only a string can ever match and
// everything else (a number, null, an object) takes the fallback.
func minimaxAudioMIMEType(format orderedNodeJSON) string {
	if format.kind == 's' {
		if mimeType, exists := minimaxAudioMIMETypes[format.scalar.(string)]; exists {
			return mimeType
		}
	}
	return "audio/mpeg"
}

// minimaxMember is one destructured member: the body's value when the member is PRESENT (including
// null, "", 0 and false), and the default only when it is absent. That is the difference between a
// destructuring initializer and a `||` default.
func minimaxMember(body orderedNodeJSON, key string, fallback orderedNodeJSON) orderedNodeJSON {
	value := sdBodyMember(body, key)
	if value.isUndefined() {
		return fallback
	}
	return value
}

// minimaxNumber is JavaScript `Number(value)` for the shapes a JSON body can carry.
func minimaxNumber(value orderedNodeJSON) float64 {
	// Number('0x10') is 16 while ParseFloat rejects the prefix, so the pinned hex forms are handled
	// before delegating to the shared Number() port.
	if value.kind == 's' {
		text := sdTrimJavaScriptSpace(value.scalar.(string))
		sign := 1.0
		digits := text
		if strings.HasPrefix(digits, "+") {
			digits = digits[1:]
		} else if strings.HasPrefix(digits, "-") {
			sign = -1
			digits = digits[1:]
		}
		if len(digits) > 2 && (strings.HasPrefix(digits, "0x") || strings.HasPrefix(digits, "0X")) {
			if parsed, err := strconv.ParseUint(digits[2:], 16, 64); err == nil {
				return sign * float64(parsed)
			}
		}
	}
	number, ok := jsNumber(value)
	if !ok {
		return math.NaN()
	}
	return number
}

// minimaxJSONNumber is `JSON.stringify(Number(value))`, which renders NaN and ±Infinity as null.
func minimaxJSONNumber(value orderedNodeJSON) orderedNodeJSON {
	return nodeNumber(minimaxNumber(value))
}

// minimaxIsJSSpace reports whether the rune is matched by a JavaScript `\s`, which is wider than
// Go's `\s`: it includes the no-break spaces and the line/paragraph separators.
func minimaxIsJSSpace(character rune) bool {
	switch character {
	case '\t', '\n', '\v', '\f', '\r', ' ',
		'\u00a0', '\u1680', '\u2028', '\u2029', '\u202f', '\u205f', '\u3000', '\ufeff':
		return true
	}
	return character >= '\u2000' && character <= '\u200a'
}

// minimaxStripHexPrefixAndSpace is `hex.replace(/^0x/, ”).replace(/\s/g, ”)`.
func minimaxStripHexPrefixAndSpace(value string) string {
	trimmed := strings.TrimPrefix(value, "0x")
	var builder strings.Builder
	builder.Grow(len(trimmed))
	for _, character := range trimmed {
		if minimaxIsJSSpace(character) {
			continue
		}
		builder.WriteRune(character)
	}
	return builder.String()
}

// minimaxIsHex reports whether the string matches `/^[0-9a-fA-F]*$/`.
func minimaxIsHex(value string) bool {
	for index := 0; index < len(value); index++ {
		character := value[index]
		switch {
		case character >= '0' && character <= '9':
		case character >= 'a' && character <= 'f':
		case character >= 'A' && character <= 'F':
		default:
			return false
		}
	}
	return true
}

// minimaxJSStringLength is JavaScript's `string.length`, which counts UTF-16 code units.
func minimaxJSStringLength(value string) int {
	return len(utf16.Encode([]rune(value)))
}

// minimaxAudioBytes decodes the hex payload into the response bytes, returning the pinned error
// message when the payload is not decodable.
func minimaxAudioBytes(hexAudio string) ([]byte, string) {
	cleanHex := minimaxStripHexPrefixAndSpace(hexAudio)
	if !minimaxIsHex(cleanHex) {
		return nil, "Invalid audio data format"
	}
	paddedHex := cleanHex
	if len(paddedHex)%2 != 0 {
		// The pinned code LEFT-pads, so "abc" decodes as 0x0a 0xbc.
		paddedHex = "0" + paddedHex
	}
	if paddedHex == "" {
		// `''.match(/.{1,2}/g)` is null, which the pinned code reports as a hex-format failure.
		return nil, "Invalid hex string format"
	}
	bytes := make([]byte, 0, len(paddedHex)/2)
	for index := 0; index < len(paddedHex); index += 2 {
		value, err := strconv.ParseUint(paddedHex[index:index+2], 16, 8)
		if err != nil {
			return nil, "Invalid audio data format"
		}
		bytes = append(bytes, byte(value))
	}
	if len(bytes) == 0 {
		return nil, "Audio data conversion failed"
	}
	return bytes, ""
}

// minimaxErrorBody is `response.status(code).json({ error: message })`.
func minimaxErrorBody(w http.ResponseWriter, status int, message string) {
	body := nodeObject()
	body.setMember("error", nodeString(message))
	respondOrderedNodeJSON(w, status, body)
}

// minimaxUpstreamError is the message the pinned non-ok branch derives from the provider's error
// body: JSON first (with the base_resp taxonomy), then the raw text.
func minimaxUpstreamError(response *outboundResponseAlias) string {
	status := response.Status
	fallback := "HTTP " + strconv.Itoa(status)
	data, parsed := sdReadJSON(response)
	if parsed {
		if baseResp := nodeGet(data, "base_resp"); pinnedJSTruthy(baseResp) {
			statusCode := nodeGet(baseResp, "status_code")
			isZero := statusCode.kind == 'v' && statusCode.scalar.(float64) == 0
			if !isZero {
				if statusCode.kind == 'v' && statusCode.scalar.(float64) == 1004 {
					return "Authentication failed - Please check your API key and API host"
				}
				return "API Error: " + jsTemplateString(nodeGet(baseResp, "status_msg"))
			}
		}
		// `errorData.error?.message || errorData.message || errorData.detail || HTTP <status>`
		for _, candidate := range []orderedNodeJSON{
			nodeGet(data, "error", "message"),
			nodeGet(data, "message"),
			nodeGet(data, "detail"),
		} {
			if pinnedJSTruthy(candidate) {
				return jsTemplateString(candidate)
			}
		}
		return fallback
	}
	errorText := string(response.Body)
	if errorText != "" && minimaxJSStringLength(errorText) > 500 {
		return fallback + ": Response too large (" + strconv.Itoa(minimaxJSStringLength(errorText)) + " characters)"
	}
	if errorText != "" {
		return errorText
	}
	return fallback
}

// minimaxBaseRespError is the pinned `base_resp.status_code !== 0` check on a 200 answer, including
// its STRICT comparison: the string "0" and null both count as errors, and an absent status_msg
// interpolates the literal "undefined".
func minimaxBaseRespError(data orderedNodeJSON) (string, bool) {
	baseResp := nodeGet(data, "base_resp")
	if !pinnedJSTruthy(baseResp) {
		return "", false
	}
	statusCode := nodeGet(baseResp, "status_code")
	if statusCode.kind == 'v' && statusCode.scalar.(float64) == 0 {
		return "", false
	}
	if statusCode.kind == 'v' && statusCode.scalar.(float64) == 1004 {
		return "Authentication failed - Please check your API key and API host", true
	}
	return "API Error: " + jsTemplateString(nodeGet(baseResp, "status_msg")), true
}

// serveMiniMaxGenerateVoice is minimax.js:19.
func (runtime *accountRuntime) serveMiniMaxGenerateVoice(w http.ResponseWriter, request *http.Request) {
	directories, ok := runtime.secretsDirectories(w, request)
	if !ok {
		return
	}
	body, ok := runtime.sdRequestBody(w, request)
	if !ok {
		return
	}
	text := minimaxMember(body, "text", nodeUndefined())
	voiceID := minimaxMember(body, "voiceId", nodeUndefined())
	apiHost := minimaxMember(body, "apiHost", nodeString(minimaxAPIHost()))
	model := minimaxMember(body, "model", nodeString("speech-02-hd"))
	speed := minimaxMember(body, "speed", nodeNumber(1))
	volume := minimaxMember(body, "volume", nodeNumber(1))
	pitch := minimaxMember(body, "pitch", nodeNumber(1))
	audioSampleRate := minimaxMember(body, "audioSampleRate", nodeNumber(32000))
	bitrate := minimaxMember(body, "bitrate", nodeNumber(128000))
	format := minimaxMember(body, "format", nodeString("mp3"))
	language := minimaxMember(body, "language", nodeUndefined())

	apiKey, err := sdReadSecret(directories, "api_key_minimax")
	if err != nil {
		minimaxErrorBody(w, http.StatusInternalServerError, "Internal server error")
		return
	}
	if !pinnedJSTruthy(text) || !pinnedJSTruthy(voiceID) || apiKey == "" {
		minimaxErrorBody(w, http.StatusBadRequest, "Missing required parameters: text, voiceId, and apiKey are required")
		return
	}

	voiceSetting := nodeObject()
	voiceSetting.setMember("voice_id", voiceID)
	voiceSetting.setMember("speed", minimaxJSONNumber(speed))
	voiceSetting.setMember("vol", minimaxJSONNumber(volume))
	voiceSetting.setMember("pitch", minimaxJSONNumber(pitch))
	audioSetting := nodeObject()
	audioSetting.setMember("sample_rate", minimaxJSONNumber(audioSampleRate))
	audioSetting.setMember("bitrate", minimaxJSONNumber(bitrate))
	audioSetting.setMember("format", format)
	audioSetting.setMember("channel", nodeNumber(1))
	requestBody := nodeObject()
	requestBody.setMember("model", model)
	requestBody.setMember("text", text)
	requestBody.setMember("stream", nodeBool(false))
	requestBody.setMember("voice_setting", voiceSetting)
	requestBody.setMember("audio_setting", audioSetting)
	if pinnedJSTruthy(language) {
		// The pinned member is appended AFTER audio_setting, so its position is observable.
		requestBody.setMember("lang", language)
	}
	payload, err := marshalOrderedNodeJSON(requestBody)
	if err != nil {
		minimaxErrorBody(w, http.StatusInternalServerError, "Internal server error")
		return
	}

	hostText, stringErr := characterString(apiHost)
	if stringErr != nil {
		minimaxErrorBody(w, http.StatusInternalServerError, "Internal server error")
		return
	}
	apiURL := hostText + "/v1/t2a_v2"
	response, fetchErr := searchFetch(request.Context(), searchRequest{
		Method: http.MethodPost,
		URL:    apiURL,
		Headers: map[string]string{
			"Authorization": "Bearer " + apiKey,
			"Content-Type":  "application/json",
			"MM-API-Source": "SillyTavern-TTS",
		},
		Body: payload,
	})
	if fetchErr != nil || response == nil {
		// The pinned outer catch: a transport failure (including a non-absolute URL the transport
		// refuses) never reaches the client as anything but this message.
		minimaxErrorBody(w, http.StatusInternalServerError, "Internal server error")
		return
	}
	if !sdResponseOK(response) {
		minimaxErrorBody(w, http.StatusInternalServerError, minimaxUpstreamError(response))
		return
	}
	responseData, parsed := sdReadJSON(response)
	if !parsed {
		minimaxErrorBody(w, http.StatusInternalServerError, "Invalid response format from MiniMax API")
		return
	}
	if message, failed := minimaxBaseRespError(responseData); failed {
		minimaxErrorBody(w, http.StatusInternalServerError, message)
		return
	}

	data := nodeGet(responseData, "data")
	if pinnedJSTruthy(data) && pinnedJSTruthy(nodeGet(data, "audio")) {
		hexAudio, isString := nodeGet(data, "audio").stringValue()
		if !isString {
			minimaxErrorBody(w, http.StatusInternalServerError, "Invalid audio data format")
			return
		}
		audioBytes, message := minimaxAudioBytes(hexAudio)
		if message != "" {
			minimaxErrorBody(w, http.StatusInternalServerError, message)
			return
		}
		w.Header().Set("Content-Type", minimaxAudioMIMEType(format))
		respondBinary(w, http.StatusOK, audioBytes)
		return
	}
	if pinnedJSTruthy(data) && pinnedJSTruthy(nodeGet(data, "url")) {
		audioURL, _ := nodeGet(data, "url").stringValue()
		audioResponse, audioErr := searchFetch(request.Context(), searchRequest{
			Method: http.MethodGet,
			URL:    audioURL,
		})
		if audioErr != nil || audioResponse == nil {
			// The pinned branch interpolates the transport's own message, which carries the request
			// authority and is therefore not part of the contract; the fixture records this body as
			// shape and compares the status only.
			minimaxErrorBody(w, http.StatusInternalServerError, "Failed to fetch audio: fetch failed")
			return
		}
		if !sdResponseOK(audioResponse) {
			minimaxErrorBody(w, http.StatusInternalServerError,
				"Failed to fetch audio from URL: "+strconv.Itoa(audioResponse.Status))
			return
		}
		w.Header().Set("Content-Type", minimaxAudioMIMEType(format))
		respondBinary(w, http.StatusOK, audioResponse.Body)
		return
	}
	message := "Unknown error"
	for _, candidate := range []orderedNodeJSON{
		nodeGet(responseData, "base_resp", "status_msg"),
		nodeGet(responseData, "error", "message"),
	} {
		if pinnedJSTruthy(candidate) {
			message = jsTemplateString(candidate)
			break
		}
	}
	minimaxErrorBody(w, http.StatusInternalServerError, "API Error: "+message)
}
