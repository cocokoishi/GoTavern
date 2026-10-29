package server

// Pinned /api/backends/* routes implemented in this round, from src/endpoints/backends/*.js:
//
//	chat-completions:  POST /bias (2158), POST /process (2979)
//	multimodal lists:  POST /multimodal-models/{pollinations,aimlapi,nanogpt,electronhub,chutes,
//	                   mistral,xai,moonshot,workers_ai} (2733-2975)
//	kobold:            POST /status (143), POST /embed (241)
//	text-completions:  POST /status (100), POST /props (234)
//	llamacpp:          POST /props (521), POST /slots (549)
//	ollama:            POST /download (445), POST /caption-image (475)
//	tabby:             POST /download (600)
//
// THE "DEFERRED THIS ROUND" LIST THAT STOOD HERE HAS BEEN DELETED, because it was WRONG IN THE DANGEROUS
// DIRECTION: it described four routes as `not implemented` that are registered and tested. A stale TODO
// understates the product and manufactures a phantom boundary, so a reader -- or a lane deciding what to build
// next -- is told a capability is absent when it exists. Corrected 2026-10-29 by reading the registrations
// rather than the comment:
//
//	/chat-completions/status     backends.go:125                       (accounts.serveBackendsChatCompletionStatus)
//	/kobold/generate             backends_kobold_deferred.go:66
//	/kobold/transcribe-audio     backends_kobold_deferred.go:67
//	/text-completions/generate   backends_textgen_generate.go:59
//
// THE RULE THIS FILE LEARNED: whether a route is implemented is answered by the registrations and by the
// rule-43 route inventory, never by a header comment. A header may say what a file DOES; it may not be the
// only place a capability is denied.
//
// `/chat-completions/generate` is implemented elsewhere and is NOT touched here.
//
// Evidence: tools/probe-backends.mjs drives the pinned server with node-fetch replaced by a
// controlled peer (tools/lib/pinned-outbound.mjs), records
// tests/oracle/sillytavern-1.19.0-backends.json, and internal/server/backends_test.go replays it.
// Every response field and every outbound request (method, raw target, explicit headers, body) is
// compared. The one `shape` field is the transport `Connection` header; routes that set it
// themselves have it compared as an explicit header instead.
//
// This file reuses the domain-agnostic outbound and body helpers established by the SD and search
// domains (searchFetch, searchStatus, searchJSON, sdUser, sdRequestBody, sdNodeFetchHeaders,
// sdIsRedirectStatus, sdSeamURL) rather than duplicating node-fetch emulation or a body parser.

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"math"
	"net/http"
	"strconv"
	"strings"

	"github.com/cocokoishi/gotavern/internal/outbound"
	"github.com/cocokoishi/gotavern/internal/startup"
	"github.com/cocokoishi/gotavern/internal/tokenizers"
)

// Backend host seams. Defaults are the pinned literals and are asserted by
// TestBackendsSeamDefaults.
const (
	backendsPollinationsDefaultURL = "https://gen.pollinations.ai"
	backendsAimlapiDefaultURL      = "https://api.aimlapi.com"
	backendsNanoGPTDefaultURL      = "https://nano-gpt.com"
	backendsElectronHubDefaultURL  = "https://api.electronhub.ai"
	backendsChutesDefaultURL       = "https://llm.chutes.ai"
	backendsMistralDefaultURL      = "https://api.mistral.ai"
	backendsXaiDefaultURL          = "https://api.x.ai"
	backendsMoonshotDefaultURL     = "https://api.moonshot.ai"
	backendsWorkersAIDefaultURL    = "https://api.cloudflare.com"
)

func backendsPollinationsURL() string {
	return sdSeamURL("GOTAVERN_BACKENDS_POLLINATIONS_URL", backendsPollinationsDefaultURL)
}
func backendsAimlapiURL() string {
	return sdSeamURL("GOTAVERN_BACKENDS_AIMLAPI_URL", backendsAimlapiDefaultURL)
}
func backendsNanoGPTURL() string {
	return sdSeamURL("GOTAVERN_BACKENDS_NANOGPT_URL", backendsNanoGPTDefaultURL)
}
func backendsElectronHubURL() string {
	return sdSeamURL("GOTAVERN_BACKENDS_ELECTRONHUB_URL", backendsElectronHubDefaultURL)
}
func backendsChutesURL() string {
	return sdSeamURL("GOTAVERN_BACKENDS_CHUTES_URL", backendsChutesDefaultURL)
}
func backendsMistralURL() string {
	return sdSeamURL("GOTAVERN_BACKENDS_MISTRAL_URL", backendsMistralDefaultURL)
}
func backendsXaiURL() string {
	return sdSeamURL("GOTAVERN_BACKENDS_XAI_URL", backendsXaiDefaultURL)
}
func backendsMoonshotURL() string {
	return sdSeamURL("GOTAVERN_BACKENDS_MOONSHOT_URL", backendsMoonshotDefaultURL)
}
func backendsWorkersAIURL() string {
	return sdSeamURL("GOTAVERN_BACKENDS_WORKERSAI_URL", backendsWorkersAIDefaultURL)
}

// backendsNotArray / backendsBadMessage are the shapes the prompt merge cannot process; the pinned
// expressions throw on them and the /process catch answers 500.
var (
	errBackendsNotArray   = errors.New("messages is not an array")
	errBackendsBadMessage = errors.New("message is not an object")
)

// backendsPromptPlaceholder is the effective pinned `promptPlaceholder` in a default install. The
// JS fallback in prompt-converters.js:4 is "Let's get started.", but config-init merges
// default/config.yaml into the runtime config and that file sets promptPlaceholder to
// "[Start a new chat]" (default/config.yaml:324), which is what the oracle observed. A custom
// value from the user's config.yaml is not projected into HTTPHandlerOptions and is a documented
// gap for POST /chat-completions/process.
const backendsPromptPlaceholder = "[Start a new chat]"

// backendsProcessTypes is Object.values(PROMPT_PROCESSING_TYPE) from prompt-converters.js:15.
var backendsProcessTypes = []string{
	"", "claude", "merge", "merge_tools", "semi", "semi_tools", "strict", "strict_tools", "single",
}

func init() {
	domainRouteRegistrars = append(domainRouteRegistrars, registerBackendsRoutes)
}

func registerBackendsRoutes(mux *http.ServeMux, accounts *accountRuntime, notFoundPage []byte, options HTTPHandlerOptions) {
	post := func(route string, handler func(http.ResponseWriter, *http.Request)) {
		mux.HandleFunc(route, func(w http.ResponseWriter, r *http.Request) {
			if r.Method != http.MethodPost {
				serveStatic(w, r, notFoundPage, options)
				return
			}
			handler(w, r)
		})
	}

	post("/api/backends/chat-completions/bias", accounts.serveBackendsBias)
	post("/api/backends/chat-completions/process", accounts.serveBackendsProcess)
	post("/api/backends/chat-completions/status", accounts.serveBackendsChatCompletionStatus)

	post("/api/backends/chat-completions/multimodal-models/pollinations", accounts.serveBackendsMultimodalPollinations)
	post("/api/backends/chat-completions/multimodal-models/aimlapi", accounts.serveBackendsMultimodalAimlapi)
	post("/api/backends/chat-completions/multimodal-models/nanogpt", accounts.serveBackendsMultimodalNanoGPT)
	post("/api/backends/chat-completions/multimodal-models/electronhub", accounts.serveBackendsMultimodalElectronHub)
	post("/api/backends/chat-completions/multimodal-models/chutes", accounts.serveBackendsMultimodalChutes)
	post("/api/backends/chat-completions/multimodal-models/mistral", accounts.serveBackendsMultimodalMistral)
	post("/api/backends/chat-completions/multimodal-models/xai", accounts.serveBackendsMultimodalXai)
	post("/api/backends/chat-completions/multimodal-models/moonshot", accounts.serveBackendsMultimodalMoonshot)
	post("/api/backends/chat-completions/multimodal-models/workers_ai", accounts.serveBackendsMultimodalWorkersAI)

	post("/api/backends/kobold/status", accounts.serveBackendsKoboldStatus)
	post("/api/backends/kobold/embed", accounts.serveBackendsKoboldEmbed)

	post("/api/backends/text-completions/status", accounts.serveBackendsTextCompletionStatus)
	post("/api/backends/text-completions/props", accounts.serveBackendsTextCompletionProps)
	post("/api/backends/text-completions/llamacpp/props", accounts.serveBackendsLlamaCppProps)
	post("/api/backends/text-completions/llamacpp/slots", accounts.serveBackendsLlamaCppSlots)
	post("/api/backends/text-completions/ollama/download", accounts.serveBackendsOllamaDownload)
	post("/api/backends/text-completions/ollama/caption-image", accounts.serveBackendsOllamaCaptionImage)
	post("/api/backends/text-completions/tabby/download", accounts.serveBackendsTabbyDownload)
}

// ---- shared pinned helpers ---------------------------------------------------------------

// backendsFetch is the pinned node-fetch semantics already reproduced for the search domain.
func backendsFetch(request *http.Request, spec searchRequest) (*outbound.Response, error) {
	return searchFetch(request.Context(), spec)
}

// backendsStatus is Express `res.sendStatus`.
func backendsStatus(w http.ResponseWriter, status int) { searchStatus(w, status) }

// backendsJSON is `res.json(value)`.
func backendsJSON(w http.ResponseWriter, value orderedNodeJSON) { searchJSON(w, value) }

// backendsJSONStatus is `res.status(status).send(objectValue)`: the Express object send path, which
// keeps the JSON content type and ETag of a normal JSON response.
func backendsJSONStatus(w http.ResponseWriter, status int, value orderedNodeJSON) {
	respondOrderedNodeJSON(w, status, value)
}

// outboundResponseAlias names the shared outbound response type in the handler helpers.
type outboundResponseAlias = outbound.Response

// backendsEmptyList is the pinned `res.json([])` of the multimodal list routes.
func backendsEmptyList(w http.ResponseWriter) { searchJSON(w, nodeArray()) }

// backendsArrayOfValues is `res.json(array)` for a value this package built.
func backendsArray(w http.ResponseWriter, values []orderedNodeJSON) {
	array := nodeArray()
	array.array = append(array.array, values...)
	searchJSON(w, array)
}

// backendsStringMember is `String(value)` for a decoded member.
func backendsStringMember(value orderedNodeJSON) string { return searchJSString(value) }

// backendsTruthyString is `const x = String(value || ”).trim()`-style handling of a required
// non-empty request field.
func backendsTruthyString(value orderedNodeJSON) (string, bool) {
	if !pinnedJSTruthy(value) {
		return "", false
	}
	text, err := pinnedJSStringValue(value)
	if err != nil {
		return "", false
	}
	return text, true
}

// backendsAdditionalHeaders reproduces setAdditionalHeaders(request, args, server): the header set
// selected by request.body.api_type plus the secret_id pass-through.
func backendsAdditionalHeaders(body orderedNodeJSON, directories startup.UserDirectories) (map[string]string, error) {
	headers, err := searchAdditionalHeaders(body, directories)
	if err != nil {
		return nil, err
	}
	if headers == nil {
		headers = map[string]string{}
	}
	return headers, nil
}

// backendsAdditionalHeadersForType reproduces setAdditionalHeadersByType(headers, type, server,
// directories, secretId) where the type is FIXED by the route (kobold/embed forces koboldcpp). It
// reuses the body-driven table rather than duplicating it.
func backendsAdditionalHeadersForType(body orderedNodeJSON, apiType string, directories startup.UserDirectories) (map[string]string, error) {
	synthetic := nodeObject()
	synthetic.setMember("api_type", nodeString(apiType))
	headers, err := searchAdditionalHeaders(synthetic, directories)
	if err != nil {
		return nil, err
	}
	if headers == nil {
		headers = map[string]string{}
	}
	return headers, nil
}

// backendsGet performs a pinned node-fetch GET and returns the response and the pinned "resolved
// with 2xx" boolean.
func backendsGet(request *http.Request, target string, headers map[string]string) (*outbound.Response, bool, error) {
	response, err := backendsFetch(request, searchRequest{Method: http.MethodGet, URL: target, Headers: headers})
	if err != nil {
		return nil, false, err
	}
	return response, sdResponseOK(response), nil
}

// backendsPost performs a pinned node-fetch POST with a JSON body.
func backendsPost(request *http.Request, target string, headers map[string]string, body []byte) (*outbound.Response, bool, error) {
	response, err := backendsFetch(request, searchRequest{Method: http.MethodPost, URL: target, Headers: headers, Body: body})
	if err != nil {
		return nil, false, err
	}
	return response, sdResponseOK(response), nil
}

// backendsHeaderValue is `response.headers.get(name)`, case-insensitive.
func backendsHeaderValue(response *outbound.Response, name string) string {
	return response.Header(name)
}

// ---- ordered JSON helpers ----------------------------------------------------------------

// backendsSetMemberIfDefined is a JS object-literal assignment: a present member is set, an
// `undefined` one is omitted (JSON.stringify drops it).
func backendsSetMemberIfDefined(target *orderedNodeJSON, key string, value orderedNodeJSON) {
	if value.isUndefined() {
		return
	}
	target.setMember(key, value)
}

// backendsAppendMember appends a member, keeping an existing member's position (JS assignment
// semantics).
func backendsAppendMember(target *orderedNodeJSON, key string, value orderedNodeJSON) {
	target.setMember(key, value)
}

// backendsSHA256Hex is createHash('sha256').update(text).digest('hex').
func backendsSHA256Hex(text string) string {
	sum := sha256.Sum256([]byte(text))
	return hex.EncodeToString(sum[:])
}

// backendsNumberedObject builds a JS object from integer-like keys: JSON.stringify emits integer
// indices in ascending numeric order before any other key. Token-bias results are exactly that.
func backendsNumberedObject(values map[uint32]orderedNodeJSON) orderedNodeJSON {
	keys := make([]uint32, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sortUint32(keys)
	object := nodeObject()
	for _, key := range keys {
		value := values[key]
		if value.isUndefined() {
			continue
		}
		object.setMember(strconv.FormatUint(uint64(key), 10), value)
	}
	return object
}

func sortUint32(values []uint32) {
	// Small n in every realistic bias request; insertion sort keeps the numeric order explicit.
	for index := 1; index < len(values); index++ {
		current := values[index]
		position := index - 1
		for position >= 0 && values[position] > current {
			values[position+1] = values[position]
			position--
		}
		values[position+1] = current
	}
}

// ---- JS coercions ------------------------------------------------------------------------

// backendsToUint32 is `new Uint32Array([...])` element conversion: ToNumber, truncate toward zero,
// then modulo 2^32.
func backendsToUint32(value orderedNodeJSON) uint32 {
	number := pinnedJSToNumber(value)
	if math.IsNaN(number) || math.IsInf(number, 0) {
		return 0
	}
	truncated := math.Trunc(number)
	modulo := math.Mod(truncated, 4294967296)
	if modulo < 0 {
		modulo += 4294967296
	}
	return uint32(modulo)
}

// backendsToUint32List converts a JSON array of token ids the way Uint32Array does.
func backendsToUint32List(value orderedNodeJSON) []uint32 {
	ids := make([]uint32, 0, len(value.array))
	for _, item := range value.array {
		ids = append(ids, backendsToUint32(item))
	}
	return ids
}

// backendsJSNumberMember is `Number(value)`.
func backendsJSNumberMember(value orderedNodeJSON) float64 { return pinnedJSToNumber(value) }

// backendsTrimTrailingSlash is `String(value).replace(/\/$/, ”)` (one slash).
func backendsTrimTrailingSlash(value orderedNodeJSON) string {
	text := backendsStringMember(value)
	return strings.TrimSuffix(text, "/")
}

// backendsSanitizeWorkersAIAccountID is `String(value || ”).trim()` for the Workers AI account.
func backendsWorkersAIAccountID(body orderedNodeJSON) string {
	raw := sdBodyMember(body, "workers_ai_account_id")
	if !pinnedJSTruthy(raw) {
		return ""
	}
	text, err := pinnedJSStringValue(raw)
	if err != nil {
		return ""
	}
	return sdTrimJavaScriptSpace(text)
}

// backendsTokenizerModelName is getTokenizerModel(String(queryModel || ”)).
func backendsTokenizerModelName(queryModel string) string {
	return tokenizers.GetTokenizerModel(queryModel)
}
