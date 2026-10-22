package server

// Pinned /api/openrouter/* routes, from src/endpoints/openrouter.js:
//
//	POST /api/openrouter/models/providers  openrouter.js:10
//	POST /api/openrouter/models/multimodal openrouter.js:73
//	POST /api/openrouter/models/embedding  openrouter.js:83
//	POST /api/openrouter/models/image      openrouter.js:93
//	POST /api/openrouter/credits           openrouter.js:103
//
// These are outbound routes with a HARDCODED upstream (`const API_OPENROUTER`, openrouter.js:8), so
// the probe cannot point the pinned server at a mock through configuration. tools/probe-openrouter.mjs
// therefore replaces only the pinned server's node-fetch module (tools/lib/pinned-outbound.mjs) and
// records the transformed response for a controlled peer payload plus the outbound request the
// pinned code actually sent. That is the same evidence a URL seam gives, one layer lower, and it is
// why `API_OPENROUTER` here is a seam whose default is asserted against the recorded pinned URL.
//
// Pinned behaviours that a "reasonable" implementation would get wrong, each recorded:
//
//   - a non-ok peer answers `[]` with status 200 for every model list (no error status);
//   - `/models/providers` interpolates a missing model as the literal string "undefined";
//   - `data.data.endpoints` entries without `provider_name` map to `undefined`, which JSON.stringify
//     writes as `null` inside an array;
//   - `/models/image` maps `{value: id, text: name || id}`, so an absent name falls back to the id;
//   - `/credits` uses `?? 0`, which does NOT coerce: string totals are echoed as strings while
//     `remaining` is coerced by the subtraction;
//   - the model sort is `a.id.localeCompare(b.id)` behind `a?.id && b?.id`, so a falsy id keeps the
//     comparator at 0 and a truthy non-string id throws (the catch answers 500).
//
// The model lists themselves are third-party data: the fixture supplies them and asserts the
// TRANSFORMATION, never a live list.

import (
	"errors"
	"math"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"

	"golang.org/x/text/collate"
	"golang.org/x/text/language"

	"github.com/cocokoishi/gotavern/internal/outbound"
	"github.com/cocokoishi/gotavern/internal/startup"
)

const openRouterDefaultAPIURL = "https://openrouter.ai/api/v1"

// openRouterAPIURL is the seam for the OpenRouter API. The default is the pinned URL and is asserted
// by a test, because a seam whose default drifts silently changes production while the tests keep
// passing against the override (docs/tokenizer-parity-plan.md section 11).
func openRouterAPIURL() string {
	if override := strings.TrimSpace(os.Getenv("GOTAVERN_OPENROUTER_API_URL")); override != "" {
		return strings.TrimSuffix(override, "/")
	}
	return openRouterDefaultAPIURL
}

func init() {
	domainRouteRegistrars = append(domainRouteRegistrars, registerOpenRouterRoutes)
}

func registerOpenRouterRoutes(mux *http.ServeMux, accounts *accountRuntime, notFoundPage []byte, options HTTPHandlerOptions) {
	post := func(route string, handler func(http.ResponseWriter, *http.Request)) {
		mux.HandleFunc(route, func(w http.ResponseWriter, r *http.Request) {
			if r.Method != http.MethodPost {
				serveStatic(w, r, notFoundPage, options)
				return
			}
			handler(w, r)
		})
	}
	post("/api/openrouter/models/providers", accounts.serveOpenRouterProviders)
	post("/api/openrouter/models/multimodal", accounts.serveOpenRouterMultimodal)
	post("/api/openrouter/models/embedding", accounts.serveOpenRouterEmbedding)
	post("/api/openrouter/models/image", accounts.serveOpenRouterImage)
	post("/api/openrouter/image/generate", accounts.serveOpenRouterImageGenerate)
	post("/api/openrouter/credits", accounts.serveOpenRouterCredits)
}

// providerAuxGet performs an outbound GET the way the pinned routes do: the declared headers, with
// Host and Connection appended last by the shared transport.
func providerAuxGet(request *http.Request, target string, headers []outbound.Header) (*outbound.Response, error) {
	all := make([]outbound.Header, 0, len(headers)+1)
	if parsed, err := url.Parse(target); err == nil {
		all = append(all, outbound.Header{Name: "Host", Value: parsed.Host})
	}
	all = append(all, headers...)
	return outbound.Send(request.Context(), outbound.Request{
		URL:     target,
		Method:  http.MethodGet,
		Headers: all,
	}, 120*time.Second)
}

// outboundOK mirrors `response.ok`: the 2xx range only.
func outboundOK(response *outbound.Response) bool {
	return response.Status >= 200 && response.Status <= 299
}

// orderedNodeJSONOf decodes an upstream body, mirroring `await response.json()`: a body that is not
// JSON makes the pinned handler throw, which its catch turns into 500.
func orderedNodeJSONOf(response *outbound.Response) (orderedNodeJSON, error) {
	return decodeOrderedNodeJSON(response.Body)
}

// javascriptStringOfBody decodes one request-body member and applies JavaScript String() to it,
// because the pinned route interpolates `${model}` into the upstream path.
func javascriptStringOfBody(raw []byte) (string, error) {
	if len(raw) == 0 {
		return "undefined", nil
	}
	value, err := decodeOrderedNodeJSON(raw)
	if err != nil {
		return "", err
	}
	return value.javascriptString()
}

// jsTruthyNode is JavaScript truthiness for a decoded value. The orderedNodeJSON truthy() method
// treats an `undefined` member as truthy, which is wrong for a property that was never present, so
// every `||` and `if (value)` in the pinned JS goes through here.
func jsTruthyNode(value orderedNodeJSON) bool {
	if value.isUndefined() {
		return false
	}
	return value.truthy()
}

// serveOpenRouterProviders answers the provider names for one model.
func (runtime *accountRuntime) serveOpenRouterProviders(w http.ResponseWriter, request *http.Request) {
	if _, ok := runtime.settingsRequestAccount(w, request); !ok {
		return
	}
	_, input, bodyOK := readUserPresetRequestBody(request)
	if !bodyOK {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	model, err := javascriptStringOfBody(input["model"])
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	response, err := providerAuxGet(request, openRouterAPIURL()+"/models/"+model+"/endpoints",
		[]outbound.Header{{Name: "Accept", Value: "application/json"}})
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	if !outboundOK(response) {
		respondJSONBytes(w, http.StatusOK, []byte("[]"))
		return
	}
	body, err := openRouterProviderNames(response)
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	respondJSONBytes(w, http.StatusOK, body)
}

func openRouterProviderNames(response *outbound.Response) ([]byte, error) {
	data, err := orderedNodeJSONOf(response)
	if err != nil {
		return nil, err
	}
	endpoints := nodeGet(data, "data", "endpoints")
	var list []orderedNodeJSON
	switch {
	case !jsTruthyNode(endpoints):
		list = nil
	case endpoints.kind == 'a':
		list = endpoints.array
	default:
		// `endpoints.map` on a non-array throws in the pinned handler.
		return nil, errors.New("endpoints is not an array")
	}
	names := make([]orderedNodeJSON, 0, len(list))
	for _, entry := range list {
		switch entry.kind {
		case 'o':
			name, _ := entry.member("provider_name")
			names = append(names, name)
		case 'n':
			// `e.provider_name` on null throws.
			return nil, errors.New("endpoint is null")
		default:
			names = append(names, nodeUndefined())
		}
	}
	return marshalCharacterJSON(nodeArray(names...))
}

// openRouterModelMode selects the pinned mapping applied to a filtered model list.
type openRouterModelMode int

const (
	openRouterMapToID openRouterModelMode = iota
	openRouterMapToEmbedding
	openRouterMapToImage
)

func (runtime *accountRuntime) serveOpenRouterMultimodal(w http.ResponseWriter, request *http.Request) {
	runtime.serveOpenRouterModelList(w, request, "image", "text", openRouterMapToID)
}

func (runtime *accountRuntime) serveOpenRouterEmbedding(w http.ResponseWriter, request *http.Request) {
	runtime.serveOpenRouterModelList(w, request, "text", "embeddings", openRouterMapToEmbedding)
}

func (runtime *accountRuntime) serveOpenRouterImage(w http.ResponseWriter, request *http.Request) {
	runtime.serveOpenRouterModelList(w, request, "text", "image", openRouterMapToImage)
}

// openRouterSplitDataURI mirrors the pinned `/^data:(.*);base64,(.*)$/`. The first group is GREEDY in
// the pinned regex, so the separator that splits the two groups is the LAST occurrence, not the first.
func openRouterSplitDataURI(value string) (string, string, bool) {
	if !strings.HasPrefix(value, "data:") {
		return "", "", false
	}
	rest := value[len("data:"):]
	const marker = ";base64,"
	index := strings.LastIndex(rest, marker)
	if index < 0 {
		return "", "", false
	}
	mimeType := rest[:index]
	base64Data := rest[index+len(marker):]
	if mimeType == "" || base64Data == "" {
		return "", "", false
	}
	return mimeType, base64Data, true
}

// openRouterImageHeaders is the pinned OPENROUTER_HEADERS pair plus the JSON content type and bearer,
// in the order the pinned object spreads them. The referer and title are part of the observed wire.
func openRouterImageHeaders(key string) []outbound.Header {
	headers := []outbound.Header{
		{Name: "HTTP-Referer", Value: "https://sillytavern.app"},
		{Name: "X-Title", Value: "SillyTavern"},
	}
	return append(headers, sdJSONHeaders(key)...)
}

// openRouterImageURL walks `choices[0].message.images[0].image_url.url` explicitly.
// nodeGet cannot express this path: it requires an OBJECT at every step, so the moment an array
// appears the lookup returns undefined and the route would answer 500 for a perfectly good answer.
// (Note that sdStringMemberOr(decoded, "data", "0", "b64_json") has the same limitation; this
// traversal exists so that this route does not inherit it.)
func openRouterImageURL(decoded orderedNodeJSON) (string, bool) {
	choices := nodeGet(decoded, "choices")
	if choices.kind != 'a' || len(choices.array) == 0 {
		return "", false
	}
	message := nodeGet(choices.array[0], "message")
	if message.kind != 'o' {
		return "", false
	}
	images := nodeGet(message, "images")
	if images.kind != 'a' || len(images.array) == 0 {
		return "", false
	}
	imageURL := nodeGet(images.array[0], "image_url")
	if imageURL.kind != 'o' {
		return "", false
	}
	resolved := nodeGet(imageURL, "url")
	if resolved.kind != 's' {
		return "", false
	}
	value, _ := resolved.scalar.(string)
	return value, true
}

// openRouterImageFormat is the pinned `format` projection: the subtype of the data URI's mime type,
// lowercased. `image/png` records `png`.
func openRouterImageFormat(mimeType string) string {
	subtype := mimeType
	if index := strings.LastIndex(mimeType, "/"); index >= 0 {
		subtype = mimeType[index+1:]
	}
	if subtype == "" {
		return "png"
	}
	return strings.ToLower(subtype)
}

// serveOpenRouterImageGenerate answers the pinned /api/openrouter/image/generate projection:
// { format, image }. Both refusals are JSON bodies rather than sendStatus, and a non-ok provider
// answer is a BARE 500 -- the provider text is logged upstream and NOT forwarded, which is the
// opposite of /api/openai/caption-image and the reason this handler must not be modelled on it.
func (runtime *accountRuntime) serveOpenRouterImageGenerate(w http.ResponseWriter, request *http.Request) {
	_, input, bodyOK := readUserPresetRequestBody(request)
	if !bodyOK {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	directories, ok := runtime.secretsDirectories(w, request)
	if !ok {
		return
	}
	keyText, err := startup.ReadSecretString(directories, "api_key_openrouter")
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	if keyText == "" {
		respondJSONBytes(w, http.StatusBadRequest, []byte(`{"error":"OpenRouter API key not found"}`))
		return
	}
	// `if (!model || !prompt)` is JS FALSINESS, so an ABSENT member must be refused even though a
	// string conversion of it would produce the non-empty literal "undefined".
	modelRaw, modelPresent := input["model"]
	promptRaw, promptPresent := input["prompt"]
	if !modelPresent || !promptPresent || !nodeTruthyJSON(modelRaw) || !nodeTruthyJSON(promptRaw) {
		respondJSONBytes(w, http.StatusBadRequest, []byte(`{"error":"Model and prompt are required"}`))
		return
	}
	model, modelErr := javascriptStringOfBody(modelRaw)
	prompt, promptErr := javascriptStringOfBody(promptRaw)
	if modelErr != nil || promptErr != nil || model == "" || prompt == "" {
		respondJSONBytes(w, http.StatusBadRequest, []byte(`{"error":"Model and prompt are required"}`))
		return
	}
	// `req.body.aspect_ratio || '1:1'` is JS OR-defaulting: a falsy member (absent, empty, 0) falls back.
	aspectRatio := "1:1"
	if raw, present := input["aspect_ratio"]; present && nodeTruthyJSON(raw) {
		if value, valueErr := javascriptStringOfBody(raw); valueErr == nil {
			aspectRatio = value
		}
	}
	message := nodeObject()
	message.setMember("role", nodeString("user"))
	message.setMember("content", nodeString(prompt))
	imageConfig := nodeObject()
	imageConfig.setMember("aspect_ratio", nodeString(aspectRatio))
	payload := nodeObject()
	setRawMember(&payload, "model", input["model"])
	payload.setMember("messages", nodeArray(message))
	payload.setMember("modalities", nodeArray(nodeString("image")))
	payload.setMember("image_config", imageConfig)
	body, err := marshalCharacterJSON(payload)
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	decoded, ok := sdPostJSON(request, openRouterAPIURL()+"/chat/completions", openRouterImageHeaders(keyText), body)
	if !ok {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	imageURL, found := openRouterImageURL(decoded)
	if !found {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	mimeType, base64Data, matched := openRouterSplitDataURI(imageURL)
	if !matched {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	answer := nodeObject()
	answer.setMember("format", nodeString(openRouterImageFormat(mimeType)))
	answer.setMember("image", nodeString(base64Data))
	encoded, err := marshalCharacterJSON(answer)
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	respondJSONBytes(w, http.StatusOK, encoded)
}

func (runtime *accountRuntime) serveOpenRouterModelList(w http.ResponseWriter, request *http.Request, inputModality, outputModality string, mode openRouterModelMode) {
	if _, ok := runtime.settingsRequestAccount(w, request); !ok {
		return
	}
	target := openRouterAPIURL() + "/models?output_modalities=" + url.QueryEscape(outputModality)
	response, err := providerAuxGet(request, target, []outbound.Header{{Name: "Accept", Value: "application/json"}})
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	body, err := openRouterFetchModelsByModality(response, inputModality, outputModality, mode)
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	respondJSONBytes(w, http.StatusOK, body)
}

// openRouterFetchModelsByModality reproduces fetchModelsByModality (openrouter.js:44). A non-ok peer
// answers an empty list with status 200; a body that is not JSON is an error (the caller answers
// 500); a `data` that is not an array answers an empty list.
func openRouterFetchModelsByModality(response *outbound.Response, inputModality, outputModality string, mode openRouterModelMode) ([]byte, error) {
	if !outboundOK(response) {
		return []byte("[]"), nil
	}
	data, err := orderedNodeJSONOf(response)
	if err != nil {
		return nil, err
	}
	models := nodeGet(data, "data")
	if models.kind != 'a' {
		return []byte("[]"), nil
	}
	filtered := make([]orderedNodeJSON, 0, len(models.array))
	for _, model := range models.array {
		if !openRouterModelMatches(model, inputModality, outputModality) {
			continue
		}
		filtered = append(filtered, model)
	}
	if err := sortOpenRouterModels(filtered); err != nil {
		return nil, err
	}
	mapped := make([]orderedNodeJSON, 0, len(filtered))
	for _, model := range filtered {
		mapped = append(mapped, openRouterMapModel(model, mode))
	}
	return marshalCharacterJSON(nodeArray(mapped...))
}

// openRouterModelMatches reproduces the four chained filters: both modality lists must be arrays and
// must include the requested value.
func openRouterModelMatches(model orderedNodeJSON, inputModality, outputModality string) bool {
	for _, pair := range [][2]string{{"input_modalities", inputModality}, {"output_modalities", outputModality}} {
		modalities := nodeGet(model, "architecture", pair[0])
		if modalities.kind != 'a' {
			return false
		}
		found := false
		for _, entry := range modalities.array {
			if entry.kind == 's' && entry.scalar.(string) == pair[1] {
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}
	return true
}

// sortOpenRouterModels reproduces `.sort((a, b) => a?.id && b?.id ? a.id.localeCompare(b.id) : 0)`.
// A falsy id on either side keeps the comparator at 0, and a truthy non-string id makes
// `localeCompare` throw, which the pinned catch answers with 500.
func sortOpenRouterModels(models []orderedNodeJSON) error {
	collator := collate.New(language.AmericanEnglish)
	var sortErr error
	sort.SliceStable(models, func(left, right int) bool {
		leftID := nodeGet(models[left], "id")
		rightID := nodeGet(models[right], "id")
		if !jsTruthyNode(leftID) || !jsTruthyNode(rightID) {
			return false
		}
		if leftID.kind != 's' || rightID.kind != 's' {
			sortErr = errors.New("model id is not a string")
			return false
		}
		return collator.CompareString(leftID.scalar.(string), rightID.scalar.(string)) < 0
	})
	return sortErr
}

// openRouterMapModel applies the pinned projection for each route.
func openRouterMapModel(model orderedNodeJSON, mode openRouterModelMode) orderedNodeJSON {
	id := nodeGet(model, "id")
	switch mode {
	case openRouterMapToEmbedding:
		output := nodeObject()
		output.setMember("id", id)
		name := nodeGet(model, "name")
		if !name.isUndefined() {
			output.setMember("name", name)
		}
		return output
	case openRouterMapToImage:
		output := nodeObject()
		output.setMember("value", id)
		name := nodeGet(model, "name")
		if jsTruthyNode(name) {
			output.setMember("text", name)
		} else {
			output.setMember("text", id)
		}
		return output
	default:
		return id
	}
}

// serveOpenRouterCredits answers { remaining, total_credits, total_usage }.
func (runtime *accountRuntime) serveOpenRouterCredits(w http.ResponseWriter, request *http.Request) {
	directories, ok := runtime.secretsDirectories(w, request)
	if !ok {
		return
	}
	keyText, err := startup.ReadSecretString(directories, "api_key_openrouter")
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	if keyText == "" {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	response, err := providerAuxGet(request, openRouterAPIURL()+"/credits", []outbound.Header{
		{Name: "Accept", Value: "application/json"},
		{Name: "Authorization", Value: "Bearer " + keyText},
	})
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	if !outboundOK(response) {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	body, err := openRouterCreditsBody(response)
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	respondJSONBytes(w, http.StatusOK, body)
}

func openRouterCreditsBody(response *outbound.Response) ([]byte, error) {
	data, err := orderedNodeJSONOf(response)
	if err != nil {
		return nil, err
	}
	// `data.data?.total_credits ?? 0`: the nullish operator does NOT coerce, so a string total stays
	// a string in the response while the subtraction below coerces it.
	totalCredits := nodeNullish(nodeGet(data, "data", "total_credits"), nodeNumber(0))
	totalUsage := nodeNullish(nodeGet(data, "data", "total_usage"), nodeNumber(0))
	remaining := nodeNumber(javascriptToNumber(totalCredits) - javascriptToNumber(totalUsage))
	body := nodeObject()
	body.setMember("remaining", remaining)
	body.setMember("total_credits", totalCredits)
	body.setMember("total_usage", totalUsage)
	return marshalCharacterJSON(body)
}

// javascriptToNumber mirrors JavaScript's ToNumber for JSON values. An array or object is NaN, which
// JSON.stringify writes as null.
func javascriptToNumber(value orderedNodeJSON) float64 {
	switch value.kind {
	case 'n', nodeUndefinedKind:
		return 0
	case 'b':
		if value.truthy() {
			return 1
		}
		return 0
	case 's':
		text := strings.TrimFunc(value.scalar.(string), isECMAScriptWhitespace)
		if text == "" {
			return 0
		}
		number, err := strconv.ParseFloat(text, 64)
		if err != nil {
			return math.NaN()
		}
		return number
	case 'v':
		return value.scalar.(float64)
	default:
		return math.NaN()
	}
}

// isECMAScriptWhitespace reports the code points Number() trims before parsing.
func isECMAScriptWhitespace(character rune) bool {
	switch character {
	case '\u0009', '\u000a', '\u000b', '\u000c', '\u000d', '\u0020', '\u00a0', '\u1680', '\u2028', '\u2029', '\u202f', '\u205f', '\u3000', '\ufeff':
		return true
	}
	return character >= '\u2000' && character <= '\u200a'
}
