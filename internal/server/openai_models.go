package server

// Pinned /api/openai/* model-list routes, from src/endpoints/openai.js:
//
//	POST /api/openai/electronhub/models           openai.js:387
//	POST /api/openai/chutes/models/embedding      openai.js:461
//	POST /api/openai/nanogpt/models/embedding     openai.js:497
//	POST /api/openai/siliconflow/models/embedding openai.js:534
//	POST /api/openai/workers-ai/models/embedding  openai.js:575
//
// Every upstream here is a hardcoded literal with no configuration seam, so tools/probe-openai-models.mjs
// replaces only the pinned server's node-fetch module (tools/lib/pinned-outbound.mjs) and records the
// transformed response for a controlled peer payload plus the outbound request the pinned code sent.
// Each base URL below is a seam whose default is asserted against the recorded pinned URL.
//
// Pinned behaviours a "reasonable" implementation would get wrong, each recorded:
//
//   - ElectronHub answers `[]` with status 200 for a missing or non-array `data.data`, while the other
//     four answer 500 for a non-array payload;
//   - a non-ok peer forwards the peer's TEXT with status 500 for all five, but ElectronHub's catch
//     answers text/html "Internal server error" where the others answer sendStatus(500);
//   - SiliconFlow selects `.cn` only for the exact string "cn" from the body;
//   - Workers AI coerces the account id with `String(body.workers_ai_account_id || '').trim()`, so a
//     ZERO account id is falsy and answers 400, and builds the path with `encodeURIComponent`;
//   - Workers AI maps each entry with `{...m, id: m.name}`, which keeps the source member order and
//     APPENDS `id` (and omits it entirely when `name` is absent).

import (
	"encoding/json"
	"net/http"
	"os"
	"strconv"
	"strings"

	"github.com/cocokoishi/gotavern/internal/outbound"
	"github.com/cocokoishi/gotavern/internal/startup"
)

// The pinned upstream bases. Each is the seam default and is asserted by a test.
const (
	electronHubDefaultAPIURL     = "https://api.electronhub.ai"
	chutesDefaultAPIURL          = "https://api.chutes.ai"
	nanogptDefaultAPIURL         = "https://nano-gpt.com"
	siliconflowDefaultCNURL      = "https://api.siliconflow.cn"
	siliconflowDefaultGlobalURL  = "https://api.siliconflow.com"
	cloudflareDefaultAPIURL      = "https://api.cloudflare.com"
	electronHubDefaultModelsPath = "/v1/models"
)

func envSeamURL(name, fallback string) string {
	if override := strings.TrimSpace(os.Getenv(name)); override != "" {
		return strings.TrimSuffix(override, "/")
	}
	return fallback
}

func electronHubAPIURL() string {
	return envSeamURL("GOTAVERN_ELECTRONHUB_API_URL", electronHubDefaultAPIURL)
}
func chutesAPIURL() string  { return envSeamURL("GOTAVERN_CHUTES_API_URL", chutesDefaultAPIURL) }
func nanogptAPIURL() string { return envSeamURL("GOTAVERN_NANOGPT_API_URL", nanogptDefaultAPIURL) }
func siliconflowCNURL() string {
	return envSeamURL("GOTAVERN_SILICONFLOW_CN_API_URL", siliconflowDefaultCNURL)
}
func siliconflowGlobalURL() string {
	return envSeamURL("GOTAVERN_SILICONFLOW_GLOBAL_API_URL", siliconflowDefaultGlobalURL)
}
func cloudflareAPIURL() string {
	return envSeamURL("GOTAVERN_CLOUDFLARE_API_URL", cloudflareDefaultAPIURL)
}

func init() {
	domainRouteRegistrars = append(domainRouteRegistrars, registerOpenAIModelRoutes)
}

func registerOpenAIModelRoutes(mux *http.ServeMux, accounts *accountRuntime, notFoundPage []byte, options HTTPHandlerOptions) {
	post := func(route string, handler func(http.ResponseWriter, *http.Request)) {
		mux.HandleFunc(route, func(w http.ResponseWriter, r *http.Request) {
			if r.Method != http.MethodPost {
				serveStatic(w, r, notFoundPage, options)
				return
			}
			handler(w, r)
		})
	}
	post("/api/openai/electronhub/models", accounts.serveElectronHubModels)
	post("/api/openai/chutes/models/embedding", accounts.serveChutesEmbeddingModels)
	post("/api/openai/nanogpt/models/embedding", accounts.serveNanoGPTEmbeddingModels)
	post("/api/openai/siliconflow/models/embedding", accounts.serveSiliconFlowEmbeddingModels)
	post("/api/openai/workers-ai/models/embedding", accounts.serveWorkersAIEmbeddingModels)
}

// providerSecretString resolves one secret for an outbound route, answering the pinned 400 when it is
// missing and 500 when the file cannot be read.
func (runtime *accountRuntime) providerSecretString(w http.ResponseWriter, request *http.Request, keyID string) (startup.UserDirectories, string, bool) {
	directories, ok := runtime.secretsDirectories(w, request)
	if !ok {
		return nil, "", false
	}
	key, err := startup.ReadSecretString(directories, keyID)
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return nil, "", false
	}
	if key == "" {
		serveStatusText(w, http.StatusBadRequest)
		return nil, "", false
	}
	return directories, key, true
}

// providerFetchText answers the pinned `response.status(500).send(await result.text())` branch: the
// peer's body is forwarded with a text/html content type, because Express types a string body as html.
func providerFetchText(w http.ResponseWriter, response *outbound.Response) {
	respondText(w, http.StatusInternalServerError, "text/html; charset=utf-8", string(response.Body))
}

// serveElectronHubModels answers data.data, or [] when the payload has no array there.
func (runtime *accountRuntime) serveElectronHubModels(w http.ResponseWriter, request *http.Request) {
	_, key, ok := runtime.providerSecretString(w, request, "api_key_electronhub")
	if !ok {
		return
	}
	response, err := providerAuxGet(request, electronHubAPIURL()+electronHubDefaultModelsPath,
		[]outbound.Header{{Name: "Authorization", Value: "Bearer " + key}})
	if err != nil {
		respondText(w, http.StatusInternalServerError, "text/html; charset=utf-8", "Internal server error")
		return
	}
	if !outboundOK(response) {
		providerFetchText(w, response)
		return
	}
	data, err := orderedNodeJSONOf(response)
	if err != nil {
		respondText(w, http.StatusInternalServerError, "text/html; charset=utf-8", "Internal server error")
		return
	}
	var list orderedNodeJSON
	models := nodeGet(data, "data")
	if jsTruthyNode(data) && models.kind == 'a' {
		list = models
	} else {
		list = nodeArray()
	}
	body, err := marshalCharacterJSON(list)
	if err != nil {
		respondText(w, http.StatusInternalServerError, "text/html; charset=utf-8", "Internal server error")
		return
	}
	respondJSONBytes(w, http.StatusOK, body)
}

// serveChutesEmbeddingModels answers data.items.
func (runtime *accountRuntime) serveChutesEmbeddingModels(w http.ResponseWriter, request *http.Request) {
	_, key, ok := runtime.providerSecretString(w, request, "api_key_chutes")
	if !ok {
		return
	}
	response, err := providerAuxGet(request, chutesAPIURL()+"/chutes/?template=embedding&include_public=true&limit=999",
		[]outbound.Header{{Name: "Authorization", Value: "Bearer " + key}})
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	if !outboundOK(response) {
		providerFetchText(w, response)
		return
	}
	data, err := orderedNodeJSONOf(response)
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	items := nodeGet(data, "items")
	if items.kind != 'a' {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	body, err := marshalCharacterJSON(items)
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	respondJSONBytes(w, http.StatusOK, body)
}

// serveNanoGPTEmbeddingModels answers data.data.
func (runtime *accountRuntime) serveNanoGPTEmbeddingModels(w http.ResponseWriter, request *http.Request) {
	_, key, ok := runtime.providerSecretString(w, request, "api_key_nanogpt")
	if !ok {
		return
	}
	response, err := providerAuxGet(request, nanogptAPIURL()+"/api/v1/embedding-models", []outbound.Header{
		{Name: "Authorization", Value: "Bearer " + key},
		{Name: "Accept-Encoding", Value: "identity"},
	})
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	if !outboundOK(response) {
		providerFetchText(w, response)
		return
	}
	data, err := orderedNodeJSONOf(response)
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	models := nodeGet(data, "data")
	if models.kind != 'a' {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	body, err := marshalCharacterJSON(models)
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	respondJSONBytes(w, http.StatusOK, body)
}

// serveSiliconFlowEmbeddingModels answers data.data, from the .cn upstream only when the body asks
// for exactly "cn".
func (runtime *accountRuntime) serveSiliconFlowEmbeddingModels(w http.ResponseWriter, request *http.Request) {
	_, input, bodyOK := readUserPresetRequestBody(request)
	if !bodyOK {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	_, key, ok := runtime.providerSecretString(w, request, "api_key_siliconflow")
	if !ok {
		return
	}
	endpoint, err := javascriptStringOfBody(input["siliconflow_endpoint"])
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	base := siliconflowGlobalURL()
	if endpoint == "cn" {
		base = siliconflowCNURL()
	}
	response, err := providerAuxGet(request, base+"/v1/models?type=text&sub_type=embedding",
		[]outbound.Header{{Name: "Authorization", Value: "Bearer " + key}})
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	if !outboundOK(response) {
		providerFetchText(w, response)
		return
	}
	data, err := orderedNodeJSONOf(response)
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	models := nodeGet(data, "data")
	if models.kind != 'a' {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	body, err := marshalCharacterJSON(models)
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	respondJSONBytes(w, http.StatusOK, body)
}

// serveWorkersAIEmbeddingModels answers data.result.map(m => ({ ...m, id: m.name })).
func (runtime *accountRuntime) serveWorkersAIEmbeddingModels(w http.ResponseWriter, request *http.Request) {
	_, input, bodyOK := readUserPresetRequestBody(request)
	if !bodyOK {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	_, key, ok := runtime.providerSecretString(w, request, "api_key_workers_ai")
	if !ok {
		return
	}
	accountID, err := workersAIAccountID(input["workers_ai_account_id"])
	if err != nil {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	if accountID == "" {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	target := cloudflareAPIURL() + "/client/v4/accounts/" + encodeURIComponentJS(accountID) +
		"/ai/models/search?task=Text+Embeddings&per_page=100"
	response, err := providerAuxGet(request, target,
		[]outbound.Header{{Name: "Authorization", Value: "Bearer " + key}})
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	if !outboundOK(response) {
		providerFetchText(w, response)
		return
	}
	data, err := orderedNodeJSONOf(response)
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	result := nodeGet(data, "result")
	if result.kind != 'a' {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	mapped := make([]orderedNodeJSON, 0, len(result.array))
	for _, entry := range result.array {
		spread, err := spreadWithModelID(entry)
		if err != nil {
			serveStatusText(w, http.StatusInternalServerError)
			return
		}
		mapped = append(mapped, spread)
	}
	body, err := marshalCharacterJSON(nodeArray(mapped...))
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	respondJSONBytes(w, http.StatusOK, body)
}

// workersAIAccountID reproduces `String(request.body.workers_ai_account_id || ”).trim()`.
func workersAIAccountID(raw json.RawMessage) (string, error) {
	if len(raw) == 0 {
		return "", nil
	}
	value, err := decodeOrderedNodeJSON(raw)
	if err != nil {
		return "", err
	}
	text := ""
	if jsTruthyNode(value) {
		text, err = value.javascriptString()
		if err != nil {
			return "", err
		}
	}
	return strings.TrimFunc(text, isECMAScriptWhitespace), nil
}

// spreadWithModelID reproduces `{ ...m, id: m.name }`: the source members keep their order, an
// existing `id` is replaced in place, and an absent `name` leaves `id` undefined (omitted).
func spreadWithModelID(model orderedNodeJSON) (orderedNodeJSON, error) {
	output := nodeObject()
	switch model.kind {
	case 'o':
		entries, _ := model.entries()
		for _, entry := range entries {
			output.setMember(entry.key, entry.value)
		}
	case 's':
		// `{...'ab'}` produces index members.
		for index, character := range []rune(model.scalar.(string)) {
			output.setMember(strconv.Itoa(index), nodeString(string(character)))
		}
	case 'n':
		// `{ ...null }` is an empty object, but `null.name` throws; the pinned handler's catch answers
		// 500 and the fixture exercises that shape through the non-array case instead.
		return nodeObject(), nil
	}
	name, present := model.member("name")
	if model.kind == 'o' && present {
		output.setMember("id", name)
	}
	return output, nil
}

// encodeURIComponentJS reproduces JavaScript's encodeURIComponent exactly: every byte outside the
// unreserved set and `!~*'()` is percent-encoded. Go's url.PathEscape has a different unescaped set,
// and the account id is interpolated into a path, so the difference is observable.
func encodeURIComponentJS(value string) string {
	var builder strings.Builder
	for index := 0; index < len(value); index++ {
		character := value[index]
		if character >= 'A' && character <= 'Z' || character >= 'a' && character <= 'z' ||
			character >= '0' && character <= '9' || strings.ContainsRune("-_.!~*'()", rune(character)) {
			builder.WriteByte(character)
			continue
		}
		builder.WriteString("%")
		const hexDigits = "0123456789ABCDEF"
		builder.WriteByte(hexDigits[character>>4])
		builder.WriteByte(hexDigits[character&0x0f])
	}
	return builder.String()
}
