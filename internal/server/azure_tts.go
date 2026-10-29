package server

// Pinned Azure text-to-speech routes, from src/endpoints/azure.js, mounted by
// `app.use('/api/azure', azureRouter)` at src/server-startup.js:182:
//
//	POST /api/azure/list      azure.js:8   voice list, JSON passthrough
//	POST /api/azure/generate  azure.js:46  SSML synthesis, audio/ogg bytes
//
// This is the TTS provider the stock frontend offers at
// public/scripts/extensions/tts/azure.js:143 (`/api/azure/list`) and :191
// (`/api/azure/generate`). It is NOT the `azure_openai` chat-completion source,
// which is a different provider with a different secret.
//
// The pinned behaviour, in the order the source applies it:
//
//   - the credential is `readSecret(directories, SECRET_KEYS.AZURE_TTS)` =
//     `api_key_azure_tts` (src/endpoints/secrets.js:42). A missing/empty key
//     answers `res.sendStatus(403)` BEFORE any body member is read, so a request
//     with neither key nor region is 403, not 400;
//   - `/list` requires a truthy `region` (400 otherwise) and GETs
//     `https://${region}.tts.speech.microsoft.com/cognitiveservices/voices/list`
//     with only `Ocp-Apim-Subscription-Key`; a non-ok answer is 500 and the JSON
//     body is passed through `res.json`;
//   - `/generate` requires truthy `text`, `voice` AND `region` (400 otherwise),
//     builds `lang` as `String(voice).split('-').slice(0, 2).join('-')`, escapes
//     `&`, `<`, `>` on `String(text)` IN THAT ORDER, and interpolates the RAW
//     `voice` into both `xml:lang` and `name` of the SSML (azure.js:64) — the
//     escaping is applied to `text` only, so a quote in `voice` reaches the
//     provider unescaped exactly as pinned;
//   - the synthesis POST carries `Ocp-Apim-Subscription-Key`,
//     `Content-Type: application/ssml+xml` and
//     `X-Microsoft-OutputFormat: webm-24khz-16bit-mono-opus` (azure.js:71), and a
//     non-ok answer is 500 while a successful one is answered with
//     `Content-Type: audio/ogg` (azure.js:82) whatever the provider sent.
//
// Every `${region}` is a RAW string interpolation into the URL (azure.js:24,
// :61), including a region that contains a slash or a query separator; this
// implementation keeps the interpolation raw rather than validating the region,
// because pinned validates nothing and "safer but different" is a parity break
// (AGENTS.md boundary 5).
//
// The outbound client is node-fetch, so the request goes through `sdFetch`, whose
// header construction, ordering and framing the SD/provider-wire tests already
// assert byte for byte.
//
// TEST SEAM. The pinned URL interpolates the CALLER's region into the host, so a
// plain base-URL override would make the region unobservable at a controlled
// local peer — and a mutation that hardcoded the region would then survive.
// `GOTAVERN_AZURE_TTS_BASE_TEMPLATE` therefore replaces the pinned base TEMPLATE
// `https://%s.tts.speech.microsoft.com`; the test points it at a loopback peer
// with the region kept in the path, so the region the handler read from the body
// is visible in the peer's request target. Production leaves it unset and the
// default template is asserted against the pinned literal. THE CONTRACT IS THAT THE
// OVERRIDE CARRIES `%s`: a template without it would drop the region from the URL,
// so every test that sets this seam also asserts the region in the peer's target,
// and `TestAzureTTSSeamDefault` asserts the default template is the pinned literal.

import (
	"net/http"
	"strings"

	"github.com/cocokoishi/gotavern/internal/startup"
)

const (
	// azureTTSSecretKey is SECRET_KEYS.AZURE_TTS (src/endpoints/secrets.js:42).
	azureTTSSecretKey = "api_key_azure_tts"

	// azureTTSDefaultBaseTemplate is the pinned `https://${region}.tts.speech.microsoft.com`
	// with its single interpolation point made explicit (azure.js:24, :61).
	azureTTSDefaultBaseTemplate = "https://%s.tts.speech.microsoft.com"

	azureTTSVoicesPath   = "/cognitiveservices/voices/list"
	azureTTSGeneratePath = "/cognitiveservices/v1"

	// azureTTSOutputFormat is the pinned X-Microsoft-OutputFormat (azure.js:71). It asks for
	// Opus-in-WebM while the route answers `audio/ogg`; the mismatch is pinned's own.
	azureTTSOutputFormat = "webm-24khz-16bit-mono-opus"

	// azureTTSBaseTemplateEnv is the test seam documented above.
	azureTTSBaseTemplateEnv = "GOTAVERN_AZURE_TTS_BASE_TEMPLATE"
)

func init() {
	domainRouteRegistrars = append(domainRouteRegistrars, registerAzureTTSRoutes)
}

func registerAzureTTSRoutes(mux *http.ServeMux, accounts *accountRuntime, notFoundPage []byte, options HTTPHandlerOptions) {
	post := func(route string, handler func(http.ResponseWriter, *http.Request)) {
		mux.HandleFunc(route, func(w http.ResponseWriter, r *http.Request) {
			if r.Method != http.MethodPost {
				serveStatic(w, r, notFoundPage, options)
				return
			}
			handler(w, r)
		})
	}
	post("/api/azure/list", accounts.serveAzureTTSList)
	post("/api/azure/generate", accounts.serveAzureTTSGenerate)
}

// azureTTSBase is the pinned `https://${region}.tts.speech.microsoft.com`. The region is substituted
// into the template RAW, exactly as the pinned template literal interpolates it.
func azureTTSBase(region string) string {
	template := sdSeamURL(azureTTSBaseTemplateEnv, azureTTSDefaultBaseTemplate)
	return strings.Replace(template, "%s", region, 1)
}

// azureTTSLanguage is `String(voice).split('-').slice(0, 2).join('-')` (azure.js:62): the first two
// dash-separated fields, or the whole value when it has fewer than two.
func azureTTSLanguage(voice string) string {
	parts := strings.Split(voice, "-")
	if len(parts) > 2 {
		parts = parts[:2]
	}
	return strings.Join(parts, "-")
}

// azureTTSEscape is the pinned chain `String(text).replace(/&/g,'&amp;').replace(/</g,'&lt;')
// .replace(/>/g,'&gt;')` (azure.js:63). The order is observable only through `&`, which must be
// escaped first or the `&` of a later replacement would be escaped twice.
func azureTTSEscape(text string) string {
	text = strings.ReplaceAll(text, "&", "&amp;")
	text = strings.ReplaceAll(text, "<", "&lt;")
	return strings.ReplaceAll(text, ">", "&gt;")
}

// azureTTSSecret resolves the Azure TTS credential and applies the pinned guard. A reader error is
// the route's own catch (500); an empty value is the 403 the pinned `if (!key)` produces.
func azureTTSSecret(w http.ResponseWriter, directories startup.UserDirectories) (string, bool) {
	key, err := sdReadSecret(directories, azureTTSSecretKey)
	if err != nil {
		serveSDStatus(w, http.StatusInternalServerError)
		return "", false
	}
	if key == "" {
		// `if (!key) { console.warn('Azure TTS API Key not set'); return res.sendStatus(403); }`
		serveSDStatus(w, http.StatusForbidden)
		return "", false
	}
	return key, true
}

// serveAzureTTSList is azure.js:8.
func (runtime *accountRuntime) serveAzureTTSList(w http.ResponseWriter, request *http.Request) {
	directories, ok := runtime.secretsDirectories(w, request)
	if !ok {
		return
	}
	// The body parser is middleware in pinned (src/server-main.js:110-111), so a malformed JSON body
	// is refused before the handler runs -- ahead of the credential guard, which is why the parse is
	// first here as well.
	body, ok := runtime.sdRequestBody(w, request)
	if !ok {
		return
	}
	key, ok := azureTTSSecret(w, directories)
	if !ok {
		return
	}

	region := sdBodyMember(body, "region")
	if !pinnedJSTruthy(region) {
		// `if (!region) { console.warn('Azure TTS region not set'); return res.sendStatus(400); }`
		serveSDStatus(w, http.StatusBadRequest)
		return
	}
	regionText, regionErr := characterString(region)
	if regionErr != nil {
		serveSDStatus(w, http.StatusInternalServerError)
		return
	}

	response, fetchErr := sdFetch(request.Context(), sdRequest{
		Method:  http.MethodGet,
		URL:     azureTTSBase(regionText) + azureTTSVoicesPath,
		Headers: map[string]string{"Ocp-Apim-Subscription-Key": key},
	})
	if fetchErr != nil || response == nil {
		serveSDStatus(w, http.StatusInternalServerError)
		return
	}
	if !sdResponseOK(response) {
		// `if (!response.ok) { ... return res.sendStatus(500); }`
		serveSDStatus(w, http.StatusInternalServerError)
		return
	}
	voices, parsed := sdReadJSON(response)
	if !parsed {
		// `await response.json()` throws on a body that is not JSON, which the route's catch turns
		// into the same 500.
		serveSDStatus(w, http.StatusInternalServerError)
		return
	}
	respondOrderedNodeJSON(w, http.StatusOK, voices)
}

// serveAzureTTSGenerate is azure.js:46.
func (runtime *accountRuntime) serveAzureTTSGenerate(w http.ResponseWriter, request *http.Request) {
	directories, ok := runtime.secretsDirectories(w, request)
	if !ok {
		return
	}
	body, ok := runtime.sdRequestBody(w, request)
	if !ok {
		return
	}
	key, ok := azureTTSSecret(w, directories)
	if !ok {
		return
	}

	text := sdBodyMember(body, "text")
	voice := sdBodyMember(body, "voice")
	region := sdBodyMember(body, "region")
	if !pinnedJSTruthy(text) || !pinnedJSTruthy(voice) || !pinnedJSTruthy(region) {
		serveSDStatus(w, http.StatusBadRequest)
		return
	}

	// The pinned template literals stringify each member; a member whose ToString throws (an object
	// carrying a `toString` member) is caught by the route's own try/catch and answers 500.
	textText, textErr := characterString(text)
	if textErr != nil {
		serveSDStatus(w, http.StatusInternalServerError)
		return
	}
	voiceText, voiceErr := characterString(voice)
	if voiceErr != nil {
		serveSDStatus(w, http.StatusInternalServerError)
		return
	}
	regionText, regionErr := characterString(region)
	if regionErr != nil {
		serveSDStatus(w, http.StatusInternalServerError)
		return
	}

	lang := azureTTSLanguage(voiceText)
	ssml := "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='" + lang +
		"'><voice xml:lang='" + lang + "' name='" + voiceText + "'>" + azureTTSEscape(textText) +
		"</voice></speak>"

	response, fetchErr := sdFetch(request.Context(), sdRequest{
		Method: http.MethodPost,
		URL:    azureTTSBase(regionText) + azureTTSGeneratePath,
		Headers: map[string]string{
			"Ocp-Apim-Subscription-Key": key,
			"Content-Type":              "application/ssml+xml",
			"X-Microsoft-OutputFormat":  azureTTSOutputFormat,
		},
		Body: []byte(ssml),
	})
	if fetchErr != nil || response == nil {
		serveSDStatus(w, http.StatusInternalServerError)
		return
	}
	if !sdResponseOK(response) {
		serveSDStatus(w, http.StatusInternalServerError)
		return
	}

	// `res.set('Content-Type', 'audio/ogg'); res.send(audio)` -- the pinned type is fixed and does
	// not depend on what the provider answered.
	w.Header().Set("Content-Type", "audio/ogg")
	respondBinary(w, http.StatusOK, response.Body)
}
