package server

// Pinned /api/translate/* routes, from src/endpoints/translate.js:
//
//	POST /api/translate/libre    translate.js:16
//	POST /api/translate/deepl    translate.js:203
//	POST /api/translate/yandex   translate.js:103
//	POST /api/translate/lingva   translate.js:159
//	POST /api/translate/onering  translate.js:265
//	POST /api/translate/deeplx   translate.js:322
//
// NOT implemented, and deliberately so:
//
//	POST /api/translate/google   translate.js:76
//	POST /api/translate/bing     translate.js:378
//
// Those two delegate to `google-translate-api-x` and `bing-translate-api`. The request flow is package
// code implementing Google's and Bing's private multi-request protocols, not endpoint code, so it
// cannot be pinned from the SillyTavern source and cannot be verified against a controlled peer.
// AGENTS.md rule 18: they stay `not implemented` rather than being approximated.
//
// The other six are pinned by tools/probe-translate.mjs (tests/oracle/sillytavern-1.19.0-translate.json).
// Four of them take their URL from a SECRET, which is a genuine user-controlled seam; DeepL and Yandex
// hardcode theirs, so those two are seams here whose defaults are asserted.
//
// Pinned details that a careful implementation would get wrong, each recorded:
//
//   - a route whose `response.send` receives `undefined` (an absent translatedText) answers 200 with NO
//     body, NO content-type and NO content-length;
//   - Lingva logs a non-ok answer and then PARSES it anyway, returning the translation, while the other
//     routes answer sendStatus(500);
//   - Libre always sends `api_key`, empty string included, and mutates the language BEFORE the text
//     check, so `target` is remapped even when the request is rejected;
//   - DeepL adds `formality` only for its nine supported languages, and maps zh-CN/zh-TW to uppercase ZH;
//   - Yandex appends one `text` parameter per chunk (order preserved, repeats allowed) and a fresh
//     uuid-derived ucid, so the query is not a sorted map;
//   - OneRing maps `lang` but never uses it: only from_lang/to_lang reach the query.

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/cocokoishi/gotavern/internal/outbound"
	"github.com/cocokoishi/gotavern/internal/startup"
)

// The pinned defaults for routes whose upstream has a built-in address.
const (
	deeplDefaultFreeURL  = "https://api-free.deepl.com/v2/translate"
	deeplDefaultProURL   = "https://api.deepl.com/v2/translate"
	yandexDefaultURL     = "https://translate.yandex.net/api/v1/tr.json/translate"
	deeplxDefaultURL     = "http://127.0.0.1:1188/translate"
	oneringDefaultURL    = "http://127.0.0.1:4990/translate"
	lingvaDefaultBaseURL = "https://lingva.ml/api/v1"
)

func deeplFreeURL() string { return envSeamURL("GOTAVERN_DEEPL_FREE_URL", deeplDefaultFreeURL) }
func deeplProURL() string  { return envSeamURL("GOTAVERN_DEEPL_PRO_URL", deeplDefaultProURL) }
func yandexTranslateURL() string {
	return envSeamURL("GOTAVERN_YANDEX_TRANSLATE_URL", yandexDefaultURL)
}
func deeplxDefaultTranslateURL() string {
	return envSeamURL("GOTAVERN_DEEPLX_URL", deeplxDefaultURL)
}
func oneringDefaultTranslateURL() string {
	return envSeamURL("GOTAVERN_ONERING_URL", oneringDefaultURL)
}
func lingvaDefaultTranslateURL() string {
	return envSeamURL("GOTAVERN_LINGVA_URL", lingvaDefaultBaseURL)
}

func init() {
	domainRouteRegistrars = append(domainRouteRegistrars, registerTranslateRoutes)
}

func registerTranslateRoutes(mux *http.ServeMux, accounts *accountRuntime, notFoundPage []byte, options HTTPHandlerOptions) {
	post := func(route string, handler func(http.ResponseWriter, *http.Request)) {
		mux.HandleFunc(route, func(w http.ResponseWriter, r *http.Request) {
			if r.Method != http.MethodPost {
				serveStatic(w, r, notFoundPage, options)
				return
			}
			handler(w, r)
		})
	}
	post("/api/translate/libre", accounts.serveTranslateLibre)
	post("/api/translate/deepl", accounts.serveTranslateDeepL)
	post("/api/translate/yandex", accounts.serveTranslateYandex)
	post("/api/translate/lingva", accounts.serveTranslateLingva)
	post("/api/translate/onering", accounts.serveTranslateOneRing)
	post("/api/translate/deeplx", accounts.serveTranslateDeepLX)
}

// translateSecret returns a secret value ("" when unset) for a translation route.
func (runtime *accountRuntime) translateSecret(directories startup.UserDirectories, keyID string) (string, error) {
	return startup.ReadSecretString(directories, keyID)
}

// sendTranslationValue reproduces `response.send(json.someField)`:
//   - undefined/null -> 200 with no body, no content-type and no content-length (Express only writes
//     the body, and the middleware's compression pass then leaves Vary at its CORS value);
//   - a string -> an html body, because Express types a string body as html;
//   - anything else -> a JSON body.
func sendTranslationValue(w http.ResponseWriter, value orderedNodeJSON) {
	switch {
	case value.isUndefined() || value.isNull():
		w.Header().Set("Vary", "Origin")
		w.WriteHeader(http.StatusOK)
	case value.kind == 's':
		respondText(w, http.StatusOK, "text/html; charset=utf-8", value.scalar.(string))
	default:
		respondOrderedNodeJSON(w, http.StatusOK, value)
	}
}

// serveTranslateLibre proxies LibreTranslate.
func (runtime *accountRuntime) serveTranslateLibre(w http.ResponseWriter, request *http.Request) {
	directories, ok := runtime.secretsDirectories(w, request)
	if !ok {
		return
	}
	_, input, bodyOK := readUserPresetRequestBody(request)
	if !bodyOK {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	key, err := runtime.translateSecret(directories, "libre")
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	url, err := runtime.translateSecret(directories, "libre_url")
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	if url == "" {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	// The pinned handler rewrites request.body.lang BEFORE the text/lang guard, so the remapping is
	// observable even on a request it then rejects.
	lang, ok := translateLanguage(input["lang"], map[string]string{"zh-CN": "zh", "zh-TW": "zt", "pt-BR": "pt", "pt-PT": "pt"})
	if !ok {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	text, hasText := translateTextValue(input["text"])
	if !hasText || lang == "" {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	payload := nodeObject()
	payload.setMember("q", nodeString(text))
	payload.setMember("source", nodeString("auto"))
	payload.setMember("target", nodeString(lang))
	payload.setMember("format", nodeString("text"))
	payload.setMember("api_key", nodeString(key))
	body, err := marshalCharacterJSON(payload)
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	response, err := outboundRequest(request, http.MethodPost, url, []outbound.Header{
		{Name: "Content-Type", Value: "application/json"},
	}, body)
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	if !outboundOK(response) {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	decoded, err := orderedNodeJSONOf(response)
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	sendTranslationValue(w, nodeGet(decoded, "translatedText"))
}

// serveTranslateDeepLX proxies DeepLX.
func (runtime *accountRuntime) serveTranslateDeepLX(w http.ResponseWriter, request *http.Request) {
	directories, ok := runtime.secretsDirectories(w, request)
	if !ok {
		return
	}
	_, input, bodyOK := readUserPresetRequestBody(request)
	if !bodyOK {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	secretURL, err := runtime.translateSecret(directories, "deeplx_url")
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	url := secretURL
	if url == "" {
		url = deeplxDefaultTranslateURL()
	}
	lang, ok := translateLanguage(input["lang"], map[string]string{"zh-CN": "ZH", "zh-TW": "ZH"})
	if !ok {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	text, hasText := translateTextValue(input["text"])
	if !hasText || lang == "" {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	payload := nodeObject()
	payload.setMember("text", nodeString(text))
	payload.setMember("source_lang", nodeString("auto"))
	payload.setMember("target_lang", nodeString(lang))
	body, err := marshalCharacterJSON(payload)
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	response, err := outboundRequest(request, http.MethodPost, url, []outbound.Header{
		{Name: "Accept", Value: "application/json"},
		{Name: "Content-Type", Value: "application/json"},
	}, body)
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	if !outboundOK(response) {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	decoded, err := orderedNodeJSONOf(response)
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	sendTranslationValue(w, nodeGet(decoded, "data"))
}

// deeplFormalityLanguages is the pinned list of target languages that accept a formality parameter.
var deeplFormalityLanguages = []string{"de", "fr", "it", "es", "nl", "ja", "ru", "pt-BR", "pt-PT"}

// serveTranslateDeepL proxies the DeepL API.
func (runtime *accountRuntime) serveTranslateDeepL(w http.ResponseWriter, request *http.Request) {
	directories, ok := runtime.secretsDirectories(w, request)
	if !ok {
		return
	}
	_, input, bodyOK := readUserPresetRequestBody(request)
	if !bodyOK {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	key, err := runtime.translateSecret(directories, "deepl")
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	if key == "" {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	lang, ok := translateLanguage(input["lang"], map[string]string{"zh-CN": "ZH", "zh-TW": "ZH"})
	if !ok {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	text, hasText := translateTextValue(input["text"])
	if !hasText || lang == "" {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	pairs := [][2]string{{"text", text}, {"target_lang", lang}}
	for _, candidate := range deeplFormalityLanguages {
		if candidate == lang {
			// getConfigValue('deepl.formality', 'default'): the probe does not configure it, so the
			// pinned default is what is recorded. A CONFIGURED formality is a known gap.
			pairs = append(pairs, [2]string{"formality", "default"})
			break
		}
	}
	endpoint := deeplFreeURL()
	if endpointValue := stringMemberOrEmpty(input["endpoint"]); endpointValue == "pro" {
		endpoint = deeplProURL()
	}
	response, err := outboundRequest(request, http.MethodPost, endpoint, []outbound.Header{
		{Name: "Accept", Value: "application/json"},
		{Name: "Authorization", Value: "DeepL-Auth-Key " + key},
		{Name: "Content-Type", Value: "application/x-www-form-urlencoded"},
	}, []byte(urlSearchParamsEncode(pairs)))
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	if !outboundOK(response) {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	decoded, err := orderedNodeJSONOf(response)
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	translations := nodeGet(decoded, "translations")
	if translations.kind != 'a' || len(translations.array) == 0 {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	sendTranslationValue(w, nodeGet(translations.array[0], "text"))
}

// serveTranslateYandex proxies the Yandex translate endpoint.
func (runtime *accountRuntime) serveTranslateYandex(w http.ResponseWriter, request *http.Request) {
	if _, ok := runtime.settingsRequestAccount(w, request); !ok {
		return
	}
	_, input, bodyOK := readUserPresetRequestBody(request)
	if !bodyOK {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	lang, ok := translateLanguage(input["lang"], map[string]string{"zh-CN": "zh", "zh-TW": "zh", "pt-PT": "pt"})
	if !ok {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	chunks := input["chunks"]
	// `if (!chunks || !lang)`: an EMPTY array is truthy, so it passes this guard.
	if len(chunks) == 0 || !nodeTruthyJSON(chunks) || lang == "" {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	decodedChunks, err := decodeOrderedNodeJSON(chunks)
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	pairs := make([][2]string, 0)
	if decodedChunks.kind == 'a' {
		for _, chunk := range decodedChunks.array {
			text, err := chunk.javascriptString()
			if err != nil {
				serveStatusText(w, http.StatusInternalServerError)
				return
			}
			pairs = append(pairs, [2]string{"text", text})
		}
	}
	pairs = append(pairs, [2]string{"lang", lang})
	ucid, err := randomUCID()
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	target := yandexTranslateURL() + "?ucid=" + ucid + "&srv=android&format=text"
	response, err := outboundRequest(request, http.MethodPost, target, []outbound.Header{
		{Name: "Content-Type", Value: "application/x-www-form-urlencoded"},
	}, []byte(urlSearchParamsEncode(pairs)))
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	if !outboundOK(response) {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	decoded, err := orderedNodeJSONOf(response)
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	// `json.text.join()` throws when text is not an array, and the pinned catch answers 500.
	texts := nodeGet(decoded, "text")
	if texts.kind != 'a' {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	parts := make([]string, 0, len(texts.array))
	for _, entry := range texts.array {
		part, err := entry.javascriptString()
		if err != nil {
			serveStatusText(w, http.StatusInternalServerError)
			return
		}
		parts = append(parts, part)
	}
	respondText(w, http.StatusOK, "text/html; charset=utf-8", strings.Join(parts, ","))
}

// serveTranslateOneRing proxies OneRingTranslator.
func (runtime *accountRuntime) serveTranslateOneRing(w http.ResponseWriter, request *http.Request) {
	directories, ok := runtime.secretsDirectories(w, request)
	if !ok {
		return
	}
	_, input, bodyOK := readUserPresetRequestBody(request)
	if !bodyOK {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	secretURL, err := runtime.translateSecret(directories, "oneringtranslator_url")
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	url := secretURL
	if url == "" {
		url = oneringDefaultTranslateURL()
	}
	// The pinned handler remaps `lang` here and then never uses it; only from_lang/to_lang are sent.
	if _, ok := translateLanguage(input["lang"], map[string]string{"pt-BR": "pt", "pt-PT": "pt"}); !ok {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	text, hasText := translateTextValue(input["text"])
	fromLang, hasFrom := translateTextValue(input["from_lang"])
	toLang, hasTo := translateTextValue(input["to_lang"])
	if !hasText || !hasFrom || !hasTo {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	query := urlSearchParamsEncode([][2]string{{"text", text}, {"from_lang", fromLang}, {"to_lang", toLang}})
	response, err := outboundRequest(request, http.MethodGet, url+"?"+query, nil, nil)
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	if !outboundOK(response) {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	decoded, err := orderedNodeJSONOf(response)
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	sendTranslationValue(w, nodeGet(decoded, "result"))
}

// serveTranslateLingva proxies a Lingva instance.
func (runtime *accountRuntime) serveTranslateLingva(w http.ResponseWriter, request *http.Request) {
	directories, ok := runtime.secretsDirectories(w, request)
	if !ok {
		return
	}
	_, input, bodyOK := readUserPresetRequestBody(request)
	if !bodyOK {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	secretURL, err := runtime.translateSecret(directories, "lingva_url")
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	base := secretURL
	if base == "" {
		base = lingvaDefaultTranslateURL()
	}
	lang, ok := translateLanguage(input["lang"], map[string]string{"zh-CN": "zh", "zh-TW": "zh", "pt-BR": "pt", "pt-PT": "pt"})
	if !ok {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	text, hasText := translateTextValue(input["text"])
	if !hasText || lang == "" {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	target := urlJoin(base, "auto", lang, encodeURIComponentJS(text))
	response, err := outboundRequest(request, http.MethodGet, target, nil, nil)
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	// NO ok check: the pinned handler logs a non-ok answer and then parses the body anyway.
	decoded, err := orderedNodeJSONOf(response)
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	sendTranslationValue(w, nodeGet(decoded, "translation"))
}

// translateLanguage applies the pinned per-route language remapping. The second result is false when
// the member is a JSON value that cannot be stringified.
func translateLanguage(raw json.RawMessage, remap map[string]string) (string, bool) {
	if len(raw) == 0 || !nodeTruthyJSON(raw) {
		return "", true
	}
	value, err := javascriptStringOfBody(raw)
	if err != nil {
		return "", false
	}
	if remapped, present := remap[value]; present {
		return remapped, true
	}
	return value, true
}

// translateTextValue reads a text-ish body member the way the pinned code does: truthiness decides
// acceptance, and String() is what reaches the upstream.
func translateTextValue(raw json.RawMessage) (string, bool) {
	if len(raw) == 0 || !nodeTruthyJSON(raw) {
		return "", false
	}
	value, err := javascriptStringOfBody(raw)
	if err != nil {
		return "", false
	}
	return value, true
}

// stringMemberOrEmpty reads a body member as a plain string, for the `endpoint === 'pro'` comparison.
func stringMemberOrEmpty(raw json.RawMessage) string {
	value, ok := secretsStringValue(raw)
	if !ok {
		return ""
	}
	return value
}

// outboundRequest performs one outbound call with the declared headers and an optional body.
//
// Content-Length is written explicitly: the shared transport writes the request verbatim, so without it
// an HTTP peer is entitled to treat a body as absent, and a receiver would see an empty body while the
// pinned node-fetch request carried one.
func outboundRequest(request *http.Request, method, target string, headers []outbound.Header, body []byte) (*outbound.Response, error) {
	all := append([]outbound.Header{{Name: "Host", Value: hostOf(target)}}, headers...)
	if len(body) > 0 {
		all = append(all, outbound.Header{Name: "Content-Length", Value: strconv.Itoa(len(body))})
	}
	return outbound.Send(request.Context(), outbound.Request{
		URL:     target,
		Method:  method,
		Headers: all,
		Body:    body,
	}, 120*time.Second)
}

// urlSearchParamsEncode reproduces URLSearchParams.toString(): insertion order preserved, repeated
// names allowed, spaces as '+', and only ASCII alphanumerics plus `*-._` left unescaped. Go's
// url.Values.Encode sorts keys and uses a different escape set, so it cannot be used here.
func urlSearchParamsEncode(pairs [][2]string) string {
	var builder strings.Builder
	for index, pair := range pairs {
		if index > 0 {
			builder.WriteByte('&')
		}
		writeFormComponent(&builder, pair[0])
		builder.WriteByte('=')
		writeFormComponent(&builder, pair[1])
	}
	return builder.String()
}

func writeFormComponent(builder *strings.Builder, value string) {
	const hexDigits = "0123456789ABCDEF"
	for index := 0; index < len(value); index++ {
		character := value[index]
		switch {
		case character == ' ':
			builder.WriteByte('+')
		case character >= 'A' && character <= 'Z', character >= 'a' && character <= 'z',
			character >= '0' && character <= '9',
			character == '*', character == '-', character == '.', character == '_':
			builder.WriteByte(character)
		default:
			builder.WriteByte('%')
			builder.WriteByte(hexDigits[character>>4])
			builder.WriteByte(hexDigits[character&0x0f])
		}
	}
}

// urlJoin reproduces url-join@5.0.0's normalize() for the pinned Lingva call
// (urlJoin(baseUrl, 'auto', lang, encodeURIComponent(text))): components are joined with a single
// slash, trailing slashes collapse, and a slash before a query or hash is removed.
func urlJoin(parts ...string) string {
	if len(parts) == 0 {
		return ""
	}
	components := make([]string, len(parts))
	copy(components, parts)
	components[0] = urlJoinProtocol(components[0])
	result := make([]string, 0, len(components))
	for index, component := range components {
		if component == "" {
			continue
		}
		if index > 0 {
			component = strings.TrimLeft(component, "/")
		}
		if index < len(components)-1 {
			component = strings.TrimRight(component, "/")
		} else if strings.HasSuffix(component, "/") {
			// Only the LAST component keeps a single trailing slash, and only when it had one.
			component = strings.TrimRight(component, "/") + "/"
		}
		result = append(result, component)
	}
	joined := strings.Join(result, "/")
	joined = urlJoinTrimSlashBeforeQuery(joined)
	pieces := strings.Split(joined, "?")
	return pieces[0] + urlJoinQuerySeparator(pieces) + strings.Join(pieces[1:], "&")
}

// urlJoinProtocol reproduces the protocol normalization: `scheme://` or `file:///`.
func urlJoinProtocol(value string) string {
	schemeEnd := strings.Index(value, ":")
	if schemeEnd <= 0 {
		return value
	}
	// The pinned regex is `^([^/:]+):\/*` -> '$1://', so a missing or duplicated slash group is
	// normalized to exactly two slashes.
	return value[:schemeEnd] + "://" + strings.TrimLeft(value[schemeEnd+1:], "/")
}

func urlJoinQuerySeparator(pieces []string) string {
	if len(pieces) > 1 {
		return "?"
	}
	return ""
}

// urlJoinTrimSlashBeforeQuery reproduces str.replace(/\/(\?|&|#[^!])/g, '$1').
func urlJoinTrimSlashBeforeQuery(value string) string {
	for _, marker := range []string{"/?", "/&"} {
		value = strings.ReplaceAll(value, marker, marker[1:])
	}
	// A slash before a hash whose second character is not '!'.
	for index := 0; index+2 < len(value); index++ {
		if value[index] == '/' && value[index+1] == '#' && value[index+2] != '!' {
			value = value[:index] + value[index+1:]
			index--
		}
	}
	return value
}

// randomUCID produces the 32 hexadecimal characters `uuidv4().replaceAll('-', ”)` yields.
func randomUCID() (string, error) {
	var identifier [16]byte
	if _, err := rand.Read(identifier[:]); err != nil {
		return "", err
	}
	identifier[6] = (identifier[6] & 0x0f) | 0x40
	identifier[8] = (identifier[8] & 0x3f) | 0x80
	encoded := make([]byte, 32)
	hex.Encode(encoded, identifier[:])
	return string(encoded), nil
}

// hostOf extracts the authority of an absolute URL for the Host header.
func hostOf(target string) string {
	trimmed := target
	for _, scheme := range []string{"https://", "http://"} {
		if strings.HasPrefix(trimmed, scheme) {
			trimmed = trimmed[len(scheme):]
			if slice := strings.IndexAny(trimmed, "/?#"); slice >= 0 {
				return trimmed[:slice]
			}
			return trimmed
		}
	}
	return ""
}
