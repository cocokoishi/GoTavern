package server

// Pinned Volcengine text-to-speech route, from src/endpoints/volcengine.js:9, mounted by
// `app.use('/api/volcengine', volcengineRouter)` at src/server-startup.js:183:
//
//	POST /api/volcengine/generate-voice
//
// The stock frontend calls it at public/scripts/extensions/tts/volcengine.js:297, and the two
// credentials it needs are already declared in GoTavern's own secrets surface
// (internal/startup/secrets_state.go:105-106: `volcengine_app_id`, `volcengine_access_key`), so a
// user could save keys and then receive a 404 from every synthesis before this file existed.
//
// The pinned behaviour, in the order the source applies it:
//
//   - `provider_endpoint` comes from the body; when it is FALSY the pinned literal
//     `https://openspeech.bytedance.com/api/v3/tts/unidirectional` is used (volcengine.js:11-15).
//     The caller's value is used VERBATIM, so a relative or malformed endpoint reaches the transport
//     and the route's own catch answers 500;
//   - a missing/empty appId or accessKey answers `res.sendStatus(403)` (volcengine.js:20-23), and a
//     missing/falsy `resource_id`, `text` or `voice_speaker` answers 400 (:29-32) -- in that order;
//   - the request carries `X-Api-App-Id`, `X-Api-Access-Key`, `X-Api-Resource-Id` and
//     `Content-Type: application/json` (:36-40);
//   - the body is a single `req_params` member (:42-62) whose members are text, speaker,
//     audio_params{format:"mp3", speech_rate}, additions -- and `additions` is a STRING carrying
//     `JSON.stringify` of a nested object, not a nested object;
//   - `speech_rate` is `Number.parseInt(req.body.speed || '0')`, so an unparseable speed reaches the
//     provider as `"speech_rate":null` (JSON.stringify renders NaN as null) and `"0x10"` parses as 16;
//   - a non-ok upstream answer is 500 with the upstream's `X-Tt-Logid` copied onto the response and
//     the body `TTS Generation Failed: <statusText>` (:65-69);
//   - a successful answer is a newline-delimited JSON stream whose `data` members are base64 audio:
//     every complete line is parsed, a line whose `code` is neither `0` nor `20000000` rejects with
//     `Volcengine TTS stream line code <code>, <message>`, a line that fails to parse is logged and
//     skipped, and the trailing partial line is parsed at end-of-stream where a parse failure rejects
//     with `Error parsing final Volcengine TTS stream line: <error>` (:70-126). The concatenated audio
//     is answered as `Content-Type: audio/mpeg` (:130-131). Every rejection is caught by the outer
//     catch (:132-135) and rendered as `TTS Generation Failed: <error>`.
//
// The outbound client is node-fetch, so the request goes through `sdFetch` (its header construction,
// ordering and framing are already asserted byte for byte by the provider-wire tests).
//
// TEST SEAM. `GOTAVERN_VOLCENGINE_TTS_URL` replaces the DEFAULT endpoint literal only; a
// caller-supplied `provider_endpoint` still wins over it, exactly as a present member wins over the
// pinned fallback.

import (
	"math"
	"math/big"
	"net/http"
	"strconv"
	"strings"
)

const (
	// volcengineDefaultEndpoint is the pinned literal (volcengine.js:14).
	volcengineDefaultEndpoint = "https://openspeech.bytedance.com/api/v3/tts/unidirectional"

	// volcengineEndpointEnv is the test seam documented above.
	volcengineEndpointEnv = "GOTAVERN_VOLCENGINE_TTS_URL"

	// The two pinned credential keys (src/endpoints/secrets.js:70-71).
	volcengineAppIDSecretKey     = "volcengine_app_id"
	volcengineAccessKeySecretKey = "volcengine_access_key"

	// volcengineAdditions is the pinned `JSON.stringify({...})` of the additions member
	// (volcengine.js:50-60). It is a CONSTANT with a fixed member order because the pinned value is a
	// string literal in the request body, not a re-serialization of the caller's input.
	volcengineAdditions = `{"mute_cut_threshold":"400","mute_cut_remain_ms":"1",` +
		`"explicit_language":"crosslingual","enable_language_detector":true,` +
		`"disable_markdown_filter":true,"cache_config":{"use_cache":true,"text_type":1}}`
)

func init() {
	domainRouteRegistrars = append(domainRouteRegistrars, registerVolcengineRoutes)
}

func registerVolcengineRoutes(mux *http.ServeMux, accounts *accountRuntime, notFoundPage []byte, options HTTPHandlerOptions) {
	mux.HandleFunc("/api/volcengine/generate-voice", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			serveStatic(w, r, notFoundPage, options)
			return
		}
		accounts.serveVolcengineGenerateVoice(w, r)
	})
}

// volcengineEndpoint is the pinned DEFAULT endpoint, overridable only for tests.
func volcengineEndpoint() string {
	return sdSeamURL(volcengineEndpointEnv, volcengineDefaultEndpoint)
}

// volcengineFailure is the pinned outer catch:
// `res.status(500).send(\`TTS Generation Failed: ${error}\`)`. Express renders a string as text/html
// with a charset. The interpolated detail is the runtime's own error text and is therefore not
// reproducible across runtimes; the tests assert the status, the content type and the prefix.
func volcengineFailure(w http.ResponseWriter, detail string) {
	respondText(w, http.StatusInternalServerError, "text/html; charset=utf-8", "TTS Generation Failed: "+detail)
}

// volcengineParseInt is `Number.parseInt(value)` with an undefined radix, the only form the pinned
// route uses: ToString the value, trim JavaScript whitespace, take an optional sign, then the hex
// digits after a `0x`/`0X` prefix or the leading decimal digits, and report NaN when no digit
// follows. JSON.stringify renders NaN as null, which is why an unparseable `speed` is observable in
// the provider request body.
func volcengineParseInt(value orderedNodeJSON) float64 {
	text, err := characterString(value)
	if err != nil {
		return math.NaN()
	}
	digits := sdTrimJavaScriptSpace(text)
	sign := 1.0
	if strings.HasPrefix(digits, "+") {
		digits = digits[1:]
	} else if strings.HasPrefix(digits, "-") {
		sign = -1
		digits = digits[1:]
	}
	base := 10
	if len(digits) > 1 && digits[0] == '0' && (digits[1] == 'x' || digits[1] == 'X') {
		base = 16
		digits = digits[2:]
	}
	end := 0
	for end < len(digits) && volcengineIsDigit(digits[end], base) {
		end++
	}
	if end == 0 {
		return math.NaN()
	}
	if base == 16 {
		// The hex path goes through big.Int because parseInt does not overflow at 2^64: it keeps
		// accumulating and rounds to the nearest double.
		integer, ok := new(big.Int).SetString(digits[:end], 16)
		if !ok {
			return math.NaN()
		}
		approximate, _ := new(big.Float).SetInt(integer).Float64()
		return sign * approximate
	}
	number, parseErr := strconv.ParseFloat(digits[:end], 64)
	if parseErr != nil {
		return math.NaN()
	}
	return sign * number
}

func volcengineIsDigit(character byte, base int) bool {
	switch {
	case character >= '0' && character <= '9':
		return true
	case base == 16 && character >= 'a' && character <= 'f':
		return true
	case base == 16 && character >= 'A' && character <= 'F':
		return true
	default:
		return false
	}
}

// volcengineTextDecoder is TextDecoder's default (non-fatal) UTF-8 decode, which replaces malformed
// bytes instead of throwing. Go's ToValidUTF8 collapses a run of malformed bytes into one U+FFFD
// where TextDecoder emits one per byte; that difference is recorded as a boundary in the test file.
func volcengineTextDecoder(body []byte) string {
	return strings.ToValidUTF8(string(body), "\uFFFD")
}

// volcengineCodeAccepted is the pinned `code !== 0 && code !== 20000000` rejection test: the two
// accepted values are the NUMBERS 0 and 20000000, so the string "0", null and a missing member all
// count as failures.
func volcengineCodeAccepted(code orderedNodeJSON) bool {
	if code.kind != 'v' {
		return false
	}
	number := code.scalar.(float64)
	return number == 0 || number == 20000000
}

// volcengineProcessLine runs one stream line through the pinned try/catch body. It reports the audio
// the line contributed, the pinned rejection message when the line rejects, and a non-empty detail
// when the line threw inside the catch instead (a JSON syntax error, a destructuring of `null`, or a
// type error from the string/base64 conversions).
func volcengineProcessLine(line string) (audio []byte, reject string, parseError string) {
	decoded, decodeErr := decodeOrderedNodeJSON([]byte(line))
	if decodeErr != nil {
		return nil, "", "SyntaxError: the line is not valid JSON"
	}
	if decoded.kind == 'n' {
		// `const { data, code, message } = null` throws before any member is read.
		return nil, "", "TypeError: cannot destructure a null stream line"
	}
	code := nodeGet(decoded, "code")
	if !volcengineCodeAccepted(code) {
		codeText, codeErr := characterString(code)
		messageText, messageErr := characterString(nodeGet(decoded, "message"))
		if codeErr != nil || messageErr != nil {
			return nil, "", "TypeError: cannot convert the line's code or message to a string"
		}
		return nil, "Volcengine TTS stream line code " + codeText + ", " + messageText, ""
	}
	data := nodeGet(decoded, "data")
	if !pinnedJSTruthy(data) {
		return nil, "", ""
	}
	encoded, isString := data.stringValue()
	if !isString {
		// `Buffer.from(<non-string>, 'base64')` throws, and the throw is inside the same try/catch.
		return nil, "", "TypeError: the first argument must be of type string or an instance of Buffer, ArrayBuffer, or Array or an Array-like Object"
	}
	audio, base64Err := decodeBase64Node(encoded)
	if base64Err != nil {
		return nil, "", "Error: " + base64Err.Error()
	}
	return audio, "", ""
}

// volcengineStreamAudio is the pinned stream walk (volcengine.js:70-126). It returns the concatenated
// audio and the pinned rejection message, which is empty when the stream succeeded.
func volcengineStreamAudio(body []byte) ([]byte, string) {
	lines := strings.Split(volcengineTextDecoder(body), "\n")
	var audio []byte
	for index, line := range lines {
		final := index == len(lines)-1
		if sdTrimJavaScriptSpace(line) == "" {
			continue
		}
		lineAudio, reject, parseError := volcengineProcessLine(line)
		if parseError != "" {
			if final {
				return nil, "Error parsing final Volcengine TTS stream line: " + parseError
			}
			continue
		}
		if reject != "" {
			return nil, reject
		}
		audio = append(audio, lineAudio...)
	}
	return audio, ""
}

// serveVolcengineGenerateVoice is volcengine.js:9.
func (runtime *accountRuntime) serveVolcengineGenerateVoice(w http.ResponseWriter, request *http.Request) {
	directories, ok := runtime.secretsDirectories(w, request)
	if !ok {
		return
	}
	body, ok := runtime.sdRequestBody(w, request)
	if !ok {
		return
	}

	// The endpoint member is resolved first, exactly as the pinned handler does, but it is only
	// STRINGIFIED after the two guards, because that is where the pinned `fetch` would throw.
	endpoint := sdBodyMember(body, "provider_endpoint")
	if !pinnedJSTruthy(endpoint) {
		endpoint = nodeString(volcengineEndpoint())
	}

	appID, appIDErr := sdReadSecret(directories, volcengineAppIDSecretKey)
	if appIDErr != nil {
		volcengineFailure(w, "Internal server error")
		return
	}
	accessKey, accessKeyErr := sdReadSecret(directories, volcengineAccessKeySecretKey)
	if accessKeyErr != nil {
		volcengineFailure(w, "Internal server error")
		return
	}
	if appID == "" || accessKey == "" {
		// `if (!appId || !accessKey) { ... return res.sendStatus(403); }`
		serveSDStatus(w, http.StatusForbidden)
		return
	}

	resourceID := sdBodyMember(body, "resource_id")
	text := sdBodyMember(body, "text")
	speaker := sdBodyMember(body, "voice_speaker")
	if !pinnedJSTruthy(resourceID) || !pinnedJSTruthy(text) || !pinnedJSTruthy(speaker) {
		serveSDStatus(w, http.StatusBadRequest)
		return
	}

	endpointText, endpointErr := characterString(endpoint)
	if endpointErr != nil {
		volcengineFailure(w, "TypeError: cannot convert the provider endpoint to a string")
		return
	}
	resourceIDText, resourceIDErr := characterString(resourceID)
	if resourceIDErr != nil {
		volcengineFailure(w, "TypeError: cannot convert the resource id to a string")
		return
	}

	// `req.body.speed || '0'`: a falsy speed falls back to the STRING '0', which parseInt parses as 0.
	speed := sdBodyMember(body, "speed")
	if !pinnedJSTruthy(speed) {
		speed = nodeString("0")
	}
	audioParams := nodeObject()
	audioParams.setMember("format", nodeString("mp3"))
	audioParams.setMember("speech_rate", nodeNumber(volcengineParseInt(speed)))
	reqParams := nodeObject()
	reqParams.setMember("text", text)
	reqParams.setMember("speaker", speaker)
	reqParams.setMember("audio_params", audioParams)
	reqParams.setMember("additions", nodeString(volcengineAdditions))
	payload := nodeObject()
	payload.setMember("req_params", reqParams)
	encoded, marshalErr := marshalOrderedNodeJSON(payload)
	if marshalErr != nil {
		volcengineFailure(w, "Internal server error")
		return
	}

	response, fetchErr := sdFetch(request.Context(), sdRequest{
		Method: http.MethodPost,
		URL:    endpointText,
		Headers: map[string]string{
			"X-Api-App-Id":      appID,
			"X-Api-Access-Key":  accessKey,
			"X-Api-Resource-Id": resourceIDText,
			"Content-Type":      "application/json",
		},
		Body: encoded,
	})
	if fetchErr != nil || response == nil {
		volcengineFailure(w, "fetch failed")
		return
	}
	if !sdResponseOK(response) {
		// `res.header('X-Tt-Logid', logid).status(500).send(...)`, where logid is '' when the header
		// is absent -- so the response carries the header with an empty value rather than omitting it.
		w.Header().Set("X-Tt-Logid", response.Header("X-Tt-Logid"))
		respondText(w, http.StatusInternalServerError, "text/html; charset=utf-8",
			"TTS Generation Failed: "+response.Reason)
		return
	}

	audio, reject := volcengineStreamAudio(response.Body)
	if reject != "" {
		volcengineFailure(w, reject)
		return
	}
	w.Header().Set("Content-Type", "audio/mpeg")
	respondBinary(w, http.StatusOK, audio)
}
