package server

// The model-list routes that talk to a HARDCODED third-party base URL. Pinned source:
// src/endpoints/stable-diffusion.js, line numbers per handler.
//
// Each URL is a seam whose default is the pinned literal (asserted in sd_routes_test.go) so the
// tests can point the route at a controlled local peer; the pinned server has no seam, so what the
// fixture compares is the complete wire request this implementation makes and the exact mapped
// response, plus the pinned status branches (missing key 400, non-2xx 500, invalid data 500).
//
// The fixture records every header of every request except `connection` (shape: transport
// framing). That means the Authorization scheme, the x-api-key name, and the fact that
// /api/sd/electronhub/sizes sends NO authorization header at all are all compared values, not
// assumptions.

import (
	"net/http"
	"sort"
	"strconv"
	"strings"
	"unicode"

	"golang.org/x/text/collate"
	"golang.org/x/text/language"

	"github.com/cocokoishi/gotavern/internal/startup"
)

// sdProviderSecretRequest fetches without request.body.url: the URL is built from a seam.
func sdProviderSecretRequest(method, target string, headers map[string]string) sdRequest {
	return sdRequest{Method: method, URL: target, Headers: headers}
}

// serveSDTogetherModels is stable-diffusion.js:739: the secret is required (400 when missing), the
// list is filtered to `type === 'image'`, and the option text is the display name.
func (runtime *accountRuntime) serveSDTogetherModels(w http.ResponseWriter, request *http.Request) {
	_, directories, ok := runtime.sdUser(w, request)
	if !ok {
		return
	}
	if _, ok := runtime.sdRequestBody(w, request); !ok {
		return
	}
	key, ok := runtime.sdProviderKey(w, directories, "api_key_togetherai")
	if !ok {
		return
	}
	response, err := sdFetch(request.Context(), sdProviderSecretRequest(http.MethodGet, sdTogetherURL()+"/api/models",
		map[string]string{"authorization": "Bearer " + key}))
	if err != nil || !sdResponseOK(response) {
		serveSDStatus(w, http.StatusInternalServerError)
		return
	}
	data, ok := sdReadJSON(response)
	if !ok || data.kind != 'a' {
		serveSDStatus(w, http.StatusInternalServerError)
		return
	}
	models := nodeArray()
	for _, item := range data.array {
		itemType, ok := sdMemberOf(item, "type")
		if !ok {
			serveSDStatus(w, http.StatusInternalServerError)
			return
		}
		if itemType.kind != 's' || itemType.scalar.(string) != "image" {
			continue
		}
		id, ok := sdMemberOf(item, "id")
		if !ok {
			serveSDStatus(w, http.StatusInternalServerError)
			return
		}
		displayName, ok := sdMemberOf(item, "display_name")
		if !ok {
			serveSDStatus(w, http.StatusInternalServerError)
			return
		}
		option := nodeObject()
		option.setMember("value", id)
		option.setMember("text", displayName)
		models.array = append(models.array, option)
	}
	serveSDRespondJSON(w, models)
}

// serveSDChutesModels is stable-diffusion.js:1310: names are mapped to options and sorted with
// `a?.text?.localeCompare(b?.text)`.
func (runtime *accountRuntime) serveSDChutesModels(w http.ResponseWriter, request *http.Request) {
	_, directories, ok := runtime.sdUser(w, request)
	if !ok {
		return
	}
	if _, ok := runtime.sdRequestBody(w, request); !ok {
		return
	}
	key, ok := runtime.sdProviderKey(w, directories, "api_key_chutes")
	if !ok {
		return
	}
	response, err := sdFetch(request.Context(), sdProviderSecretRequest(http.MethodGet,
		sdChutesURL()+"/chutes/?template=diffusion&include_public=true&limit=999",
		map[string]string{"authorization": "Bearer " + key, "content-type": "application/json"}))
	if err != nil || !sdResponseOK(response) {
		serveSDStatus(w, http.StatusInternalServerError)
		return
	}
	data, ok := sdReadJSON(response)
	if !ok {
		serveSDStatus(w, http.StatusInternalServerError)
		return
	}
	items, ok := sdMemberOf(data, "items")
	if !ok || items.kind != 'a' {
		serveSDStatus(w, http.StatusInternalServerError)
		return
	}
	models := nodeArray()
	for _, item := range items.array {
		name, ok := sdMemberOf(item, "name")
		if !ok {
			serveSDStatus(w, http.StatusInternalServerError)
			return
		}
		option := nodeObject()
		option.setMember("value", name)
		option.setMember("text", name)
		models.array = append(models.array, option)
	}
	// A non-string, non-undefined text would make localeCompare throw inside the comparator.
	for _, option := range models.array {
		text, _ := option.member("text")
		if text.kind != 's' && !text.isUndefined() {
			serveSDStatus(w, http.StatusInternalServerError)
			return
		}
	}
	collator := collate.New(language.AmericanEnglish)
	sort.SliceStable(models.array, func(left, right int) bool {
		leftText, leftExists := models.array[left].member("text")
		rightText, rightExists := models.array[right].member("text")
		leftString, leftIsString := leftText.stringValue()
		rightString, rightIsString := rightText.stringValue()
		if !leftExists || !rightExists || !leftIsString || !rightIsString {
			return false
		}
		return collator.CompareString(leftString, rightString) < 0
	})
	serveSDRespondJSON(w, models)
}

// serveSDElectronHubModels is stable-diffusion.js:1184: the whole upstream object is spread into
// each option and then value/text are appended, so upstream value/text members are overwritten and
// keep their position.
func (runtime *accountRuntime) serveSDElectronHubModels(w http.ResponseWriter, request *http.Request) {
	_, directories, ok := runtime.sdUser(w, request)
	if !ok {
		return
	}
	if _, ok := runtime.sdRequestBody(w, request); !ok {
		return
	}
	key, ok := runtime.sdProviderKey(w, directories, "api_key_electronhub")
	if !ok {
		return
	}
	response, err := sdFetch(request.Context(), sdProviderSecretRequest(http.MethodGet, sdElectronHubURL()+"/v1/models",
		map[string]string{"authorization": "Bearer " + key, "content-type": "application/json"}))
	if err != nil || !sdResponseOK(response) {
		serveSDStatus(w, http.StatusInternalServerError)
		return
	}
	data, ok := sdReadJSON(response)
	if !ok {
		serveSDStatus(w, http.StatusInternalServerError)
		return
	}
	entries, ok := sdMemberOf(data, "data")
	if !ok || entries.kind != 'a' {
		serveSDStatus(w, http.StatusInternalServerError)
		return
	}
	models := nodeArray()
	for _, item := range entries.array {
		if item.kind == 'n' || item.kind == nodeUndefinedKind {
			continue
		}
		endpoints, ok := sdMemberOf(item, "endpoints")
		if !ok || endpoints.kind != 'a' {
			continue
		}
		offered := false
		for _, endpoint := range endpoints.array {
			if text, isString := endpoint.stringValue(); isString && text == "/v1/images/generations" {
				offered = true
				break
			}
		}
		if !offered {
			continue
		}
		option := nodeObject()
		if item.kind == 'o' {
			option.object = append(option.object, item.object...)
		}
		id, ok := sdMemberOf(item, "id")
		if !ok {
			serveSDStatus(w, http.StatusInternalServerError)
			return
		}
		name, ok := sdMemberOf(item, "name")
		if !ok {
			serveSDStatus(w, http.StatusInternalServerError)
			return
		}
		option.setMember("value", id)
		option.setMember("text", name)
		models.array = append(models.array, option)
	}
	serveSDRespondJSON(w, models)
}

// serveSDElectronHubSizes is stable-diffusion.js:1282. Unlike its siblings it has NO try/catch and
// NO secret: the request carries only a Content-Type. A thrown fetch or JSON parse escapes the
// handler; in Express 4 that leaves an unhandled rejection and the pinned process exits (recorded
// in the routes fixture's knownDifferences). GoTavern answers 500 instead of terminating.
func (runtime *accountRuntime) serveSDElectronHubSizes(w http.ResponseWriter, request *http.Request) {
	if _, _, ok := runtime.sdUser(w, request); !ok {
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
	response, err := sdFetch(request.Context(), sdProviderSecretRequest(http.MethodGet,
		sdElectronHubURL()+"/v1/models/"+sdEncodeURLPath(model),
		map[string]string{"content-type": "application/json"}))
	if err != nil {
		serveSDStatus(w, http.StatusInternalServerError)
		return
	}
	if !sdResponseOK(response) {
		serveSDStatus(w, http.StatusInternalServerError)
		return
	}
	data, ok := sdReadJSON(response)
	if !ok {
		serveSDStatus(w, http.StatusInternalServerError)
		return
	}
	sizes, ok := sdMemberOf(data, "sizes")
	if !ok || !pinnedJSTruthy(sizes) {
		serveSDStatus(w, http.StatusInternalServerError)
		return
	}
	result := nodeObject()
	result.setMember("sizes", sizes)
	serveSDRespondJSON(w, result)
}

// serveSDNanoGPTModels is stable-diffusion.js:1391: `data.models.image` must be an object (arrays
// pass `typeof` and are accepted too), then every value becomes an option.
func (runtime *accountRuntime) serveSDNanoGPTModels(w http.ResponseWriter, request *http.Request) {
	_, directories, ok := runtime.sdUser(w, request)
	if !ok {
		return
	}
	if _, ok := runtime.sdRequestBody(w, request); !ok {
		return
	}
	key, ok := runtime.sdProviderKey(w, directories, "api_key_nanogpt")
	if !ok {
		return
	}
	response, err := sdFetch(request.Context(), sdProviderSecretRequest(http.MethodGet, sdNanoGPTURL()+"/api/models",
		map[string]string{"x-api-key": key, "content-type": "application/json"}))
	if err != nil || !sdResponseOK(response) {
		serveSDStatus(w, http.StatusInternalServerError)
		return
	}
	data, ok := sdReadJSON(response)
	if !ok {
		serveSDStatus(w, http.StatusInternalServerError)
		return
	}
	modelsGroup, ok := sdMemberOf(data, "models")
	if !ok {
		serveSDStatus(w, http.StatusInternalServerError)
		return
	}
	imageModels, ok := sdMemberOf(modelsGroup, "image")
	if !ok {
		serveSDStatus(w, http.StatusInternalServerError)
		return
	}
	if !pinnedJSTruthy(imageModels) || (imageModels.kind != 'o' && imageModels.kind != 'a') {
		serveSDStatus(w, http.StatusInternalServerError)
		return
	}
	// Object.values: array elements in index order, object values in key order.
	values := imageModels.array
	if imageModels.kind == 'o' {
		values = values[:0]
		for _, entry := range imageModels.object {
			values = append(values, entry.value)
		}
	}
	models := nodeArray()
	for _, item := range values {
		model, ok := sdMemberOf(item, "model")
		if !ok {
			serveSDStatus(w, http.StatusInternalServerError)
			return
		}
		name, ok := sdMemberOf(item, "name")
		if !ok {
			serveSDStatus(w, http.StatusInternalServerError)
			return
		}
		option := nodeObject()
		option.setMember("value", model)
		option.setMember("text", name)
		models.array = append(models.array, option)
	}
	serveSDRespondJSON(w, models)
}

// serveSDAimlapiModels is stable-diffusion.js:1796: `(data.data || [])` filtered to image models
// and wrapped in `{data: [...]}`.
func (runtime *accountRuntime) serveSDAimlapiModels(w http.ResponseWriter, request *http.Request) {
	_, directories, ok := runtime.sdUser(w, request)
	if !ok {
		return
	}
	if _, ok := runtime.sdRequestBody(w, request); !ok {
		return
	}
	key, ok := runtime.sdProviderKey(w, directories, "api_key_aimlapi")
	if !ok {
		return
	}
	response, err := sdFetch(request.Context(), sdProviderSecretRequest(http.MethodGet, sdAimlapiURL()+"/v1/models",
		map[string]string{"authorization": "Bearer " + key}))
	if err != nil || !sdResponseOK(response) {
		serveSDStatus(w, http.StatusInternalServerError)
		return
	}
	data, ok := sdReadJSON(response)
	if !ok {
		serveSDStatus(w, http.StatusInternalServerError)
		return
	}
	entries, ok := sdMemberOf(data, "data")
	if !ok {
		serveSDStatus(w, http.StatusInternalServerError)
		return
	}
	if !pinnedJSTruthy(entries) {
		entries = nodeArray()
	}
	if entries.kind != 'a' {
		serveSDStatus(w, http.StatusInternalServerError)
		return
	}
	models := nodeArray()
	for _, model := range entries.array {
		modelType, ok := sdMemberOf(model, "type")
		if !ok {
			serveSDStatus(w, http.StatusInternalServerError)
			return
		}
		id, ok := sdMemberOf(model, "id")
		if !ok {
			serveSDStatus(w, http.StatusInternalServerError)
			return
		}
		if modelType.kind != 's' || modelType.scalar.(string) != "image" {
			continue
		}
		if id.kind == 's' && (id.scalar.(string) == "triposr" || id.scalar.(string) == "flux/dev/image-to-image") {
			continue
		}
		// `model.info?.name || model.id`: the optional chain never throws.
		name := nodeUndefined()
		if info, exists := model.member("info"); exists && info.kind == 'o' {
			if infoName, hasName := info.member("name"); hasName {
				name = infoName
			}
		}
		text := name
		if !pinnedJSTruthy(text) {
			text = id
		}
		option := nodeObject()
		option.setMember("value", id)
		option.setMember("text", text)
		models.array = append(models.array, option)
	}
	result := nodeObject()
	result.setMember("data", models)
	serveSDRespondJSON(w, result)
}

// serveSDWorkersAIModels is stable-diffusion.js:2062: the secret is required, the account id is
// trimmed from its string form and required, and the search query is fixed.
func (runtime *accountRuntime) serveSDWorkersAIModels(w http.ResponseWriter, request *http.Request) {
	_, directories, ok := runtime.sdUser(w, request)
	if !ok {
		return
	}
	body, ok := runtime.sdRequestBody(w, request)
	if !ok {
		return
	}
	key, ok := runtime.sdProviderKey(w, directories, "api_key_workers_ai")
	if !ok {
		return
	}
	accountID := ""
	if raw := sdBodyMember(body, "account_id"); pinnedJSTruthy(raw) {
		text, err := pinnedJSStringValue(raw)
		if err != nil {
			serveSDStatus(w, http.StatusInternalServerError)
			return
		}
		accountID = sdTrimJavaScriptSpace(text)
	}
	if accountID == "" {
		serveSDStatus(w, http.StatusBadRequest)
		return
	}
	response, err := sdFetch(request.Context(), sdProviderSecretRequest(http.MethodGet,
		sdWorkersAIURL()+"/client/v4/accounts/"+sdEncodeURIComponent(accountID)+"/ai/models/search?task=Text-to-Image&per_page=1000",
		map[string]string{"authorization": "Bearer " + key}))
	if err != nil || !sdResponseOK(response) {
		serveSDStatus(w, http.StatusInternalServerError)
		return
	}
	data, ok := sdReadJSON(response)
	if !ok {
		serveSDStatus(w, http.StatusInternalServerError)
		return
	}
	success, ok := sdMemberOf(data, "success")
	if !ok {
		serveSDStatus(w, http.StatusInternalServerError)
		return
	}
	result, ok := sdMemberOf(data, "result")
	if !ok {
		serveSDStatus(w, http.StatusInternalServerError)
		return
	}
	if !pinnedJSTruthy(success) || result.kind != 'a' {
		serveSDStatus(w, http.StatusInternalServerError)
		return
	}
	models := nodeArray()
	for _, item := range result.array {
		name, valueOK := sdMemberOf(item, "name")
		if !valueOK {
			serveSDStatus(w, http.StatusInternalServerError)
			return
		}
		option := nodeObject()
		option.setMember("value", name)
		option.setMember("text", name)
		models.array = append(models.array, option)
	}
	serveSDRespondJSON(w, models)
}

// serveSDPollinationsModels is stable-diffusion.js:1013: no secret and no headers.
func (runtime *accountRuntime) serveSDPollinationsModels(w http.ResponseWriter, request *http.Request) {
	if _, _, ok := runtime.sdUser(w, request); !ok {
		return
	}
	if _, ok := runtime.sdRequestBody(w, request); !ok {
		return
	}
	response, err := sdFetch(request.Context(), sdProviderSecretRequest(http.MethodGet, sdPollinationsURL()+"/image/models", nil))
	if err != nil || !sdResponseOK(response) {
		serveSDStatus(w, http.StatusInternalServerError)
		return
	}
	data, ok := sdReadJSON(response)
	if !ok || data.kind != 'a' {
		serveSDStatus(w, http.StatusInternalServerError)
		return
	}
	models := nodeArray()
	for _, item := range data.array {
		name, ok := sdMemberOf(item, "name")
		if !ok {
			serveSDStatus(w, http.StatusInternalServerError)
			return
		}
		option := nodeObject()
		option.setMember("value", name)
		option.setMember("text", name)
		models.array = append(models.array, option)
	}
	serveSDRespondJSON(w, models)
}

// serveSDFalaiModels is stable-diffusion.js:1593: a paged model list, filtered by title, sorted by
// title and labelled `<title> (<id>)`.
func (runtime *accountRuntime) serveSDFalaiModels(w http.ResponseWriter, request *http.Request) {
	if _, _, ok := runtime.sdUser(w, request); !ok {
		return
	}
	if _, ok := runtime.sdRequestBody(w, request); !ok {
		return
	}
	page := 1
	items := nodeArray()
	for {
		response, err := sdFetch(request.Context(), sdProviderSecretRequest(http.MethodGet,
			sdFalaiURL()+"/api/models?categories=text-to-image&page="+strconv.Itoa(page), nil))
		if err != nil || !sdResponseOK(response) {
			serveSDStatus(w, http.StatusInternalServerError)
			return
		}
		modelsResponse, ok := sdReadJSON(response)
		if !ok || modelsResponse.kind != 'o' {
			serveSDStatus(w, http.StatusInternalServerError)
			return
		}
		pageItems, exists := modelsResponse.member("items")
		if !exists || pageItems.kind != 'a' {
			serveSDStatus(w, http.StatusInternalServerError)
			return
		}
		for _, item := range pageItems.array {
			title, ok := sdMemberOf(item, "title")
			if !ok {
				serveSDStatus(w, http.StatusInternalServerError)
				return
			}
			titleText, isString := title.stringValue()
			if !isString {
				// `x.title.toLowerCase()` throws for a non-string title.
				serveSDStatus(w, http.StatusInternalServerError)
				return
			}
			lowered := strings.ToLower(titleText)
			if strings.Contains(lowered, "inpainting") || strings.Contains(lowered, "control") ||
				strings.Contains(lowered, "upscale") || strings.Contains(lowered, "lora") {
				continue
			}
			items.array = append(items.array, item)
		}
		// `page = modelsResponse.page + 1`: a non-number page makes the loop condition false.
		pageValue, exists := modelsResponse.member("page")
		if !exists || pageValue.kind != 'v' {
			break
		}
		page = int(pageValue.scalar.(float64)) + 1
		pagesValue, exists := modelsResponse.member("pages")
		if !exists || pagesValue.kind != 'v' || !(float64(page) < pagesValue.scalar.(float64)) {
			break
		}
	}
	// `.sort((a, b) => a.title.localeCompare(b.title))`
	collator := collate.New(language.AmericanEnglish)
	sort.SliceStable(items.array, func(left, right int) bool {
		leftTitle, _ := items.array[left].member("title")
		rightTitle, _ := items.array[right].member("title")
		leftText, _ := leftTitle.stringValue()
		rightText, _ := rightTitle.stringValue()
		return collator.CompareString(leftText, rightText) < 0
	})
	modelOptions := nodeArray()
	for _, item := range items.array {
		title, _ := item.member("title")
		titleText, _ := title.stringValue()
		modelURL, ok := sdMemberOf(item, "modelUrl")
		if !ok {
			serveSDStatus(w, http.StatusInternalServerError)
			return
		}
		modelURLText, isString := modelURL.stringValue()
		if !isString {
			// `x.modelUrl.split` throws for a non-string.
			serveSDStatus(w, http.StatusInternalServerError)
			return
		}
		// `x.modelUrl.split('fal-ai/')[1]` is undefined when the marker is absent.
		value := nodeUndefined()
		if parts := strings.Split(modelURLText, "fal-ai/"); len(parts) > 1 {
			value = nodeString(parts[1])
		}
		valueText, err := pinnedJSStringValue(value)
		if err != nil {
			serveSDStatus(w, http.StatusInternalServerError)
			return
		}
		option := nodeObject()
		option.setMember("value", value)
		option.setMember("text", nodeString(titleText+" ("+valueText+")"))
		modelOptions.array = append(modelOptions.array, option)
	}
	serveSDRespondJSON(w, modelOptions)
}

// ---- helpers -----------------------------------------------------------------------------

// sdProviderKey reads one provider secret and answers 400 when it is not configured, which is the
// pinned `if (!key) return response.sendStatus(400)` branch shared by these routes.
func (runtime *accountRuntime) sdProviderKey(w http.ResponseWriter, directories startup.UserDirectories, key string) (string, bool) {
	value, err := sdReadSecret(directories, key)
	if err != nil {
		serveSDStatus(w, http.StatusInternalServerError)
		return "", false
	}
	if !sdTruthyString(value) {
		serveSDStatus(w, http.StatusBadRequest)
		return "", false
	}
	return value, true
}

// sdTrimJavaScriptSpace reproduces String.prototype.trim: JavaScript's whitespace set plus the
// byte-order mark.
func sdTrimJavaScriptSpace(value string) string {
	return strings.TrimFunc(value, func(character rune) bool {
		return unicode.IsSpace(character) || character == '\ufeff'
	})
}
