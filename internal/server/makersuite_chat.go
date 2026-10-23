package server

import (
	"regexp"
	"strings"
)

// MAKERSUITE (Google AI Studio) and VERTEXAI, both served by ONE pinned function:
// src/endpoints/backends/chat-completions.js:454 `sendMakerSuiteRequest`, dispatched twice at :2262 and
// :2263. This file is the URL and credential layer of that shared transform, which is where the two
// sources genuinely differ. The request BODY builder (:502-667) is NOT ported here; see the boundary at the
// end of this comment.
//
// WHAT IS SHARED (so a lane must not implement two independent transforms):
//   - one body builder (`getGeminiBody`), one prompt converter, one generationConfig, one tool config;
//   - two body-level differences only: VERTEX appends VERTEX_SAFETY to the safety list (:569) and clears
//     `includeThoughts` when the thinking budget is 0 (:616-619), a combination Vertex rejects.
//
// WHAT IS DIFFERENT, and it is NOT a single literal with a flag:
//
//	                          MAKERSUITE                                   VERTEXAI
//	base literal      https://generativelanguage.googleapis.com     https://us-central1-aiplatform.googleapis.com (:80, :81)
//	api version       getConfigValue('gemini.apiVersion','v1beta')   HARDCODED `v1` -- it never reads the config (:697-726)
//	path              /{version}/models/{model}:{type}               /v1/publishers/google/models/{model}:{type}
//	                                                                  (express WITH project: /v1/projects/{p}/locations/{r}/publishers/...)
//	credential        ?key=<apiKey> in the QUERY, never a header      express: ?key=;  full/proxy: Authorization header
//	stream marker     &alt=sse (after the key)                        ?alt=sse  -- there is no key to put first
//	status arm        EXISTS, and it is its OWN shape (:1908-1924)     NO ARM: it falls to the shared else at :2062-2065, 400 {error:true}
//
// Three further pinned quirks reproduced below rather than tidied:
//   - express mode WITH a project id ALWAYS uses the global host `aiplatform.googleapis.com`, even when the
//     location is regional (:696-698). Without a project id the host is built from the region.
//   - `region === 'global'` means `aiplatform.googleapis.com`; any other region prefixes the host (:693-695,
//     718-722).
//   - the makersuite status URL drops the `?key=` parameter entirely when a reverse_proxy is set and no key
//     is available (:1912-1914), while still refusing with 400 when there is neither a key nor a proxy.
//
// NOT PORTED HERE, named rather than silently missing: the body builder and its six dependencies --
// convertGooglePrompt, getPromptNames, calculateGoogleBudgetTokens, GEMINI_SAFETY, VERTEX_SAFETY and
// getVertexAIAuth (which mints service-account credentials). Until those land, neither source may be
// dispatched, because a route that answered a differently shaped body would be a fabricated success. This
// file therefore adds NO dispatch line; the Lead wires dispatch centrally once the body layer exists.

const (
	// :80 and :81 -- two DIFFERENT base literals, so two seams rather than one combined value.
	pinnedMakerSuiteAPIURL  = "https://generativelanguage.googleapis.com"
	pinnedMakerSuiteSeamEnv = "GOTAVERN_MAKERSUITE_CHAT_URL"
	pinnedVertexAIAPIURL    = "https://us-central1-aiplatform.googleapis.com"
	pinnedVertexAISeamEnv   = "GOTAVERN_VERTEXAI_CHAT_URL"

	// SECRET_KEYS.MAKERSUITE and SECRET_KEYS.VERTEXAI_SERVICE_ACCOUNT.
	pinnedMakerSuiteSecretKey    = "api_key_makersuite"
	pinnedVertexAIServiceAccount = "vertexai_service_account"

	// getConfigValue('gemini.apiVersion', 'v1beta') (:679). VERTEXAI never consults it.
	pinnedGeminiDefaultAPIVersion = "v1beta"
	// Vertex hardcodes the v1 path (:697-726); the constant exists so the difference is visible.
	pinnedVertexAIAPIVersion = "v1"

	chatCompletionSourceMakerSuite = "makersuite"
	chatCompletionSourceVertexAI   = "vertexai"
)

// pinnedMakerSuiteBaseURL and pinnedVertexAIBaseURL are the two pinned literals, each replaceable only by
// its OWN seam: a shared seam would let one source's replay point the other at the wrong host.
func pinnedMakerSuiteBaseURL() string {
	return sdSeamURL(pinnedMakerSuiteSeamEnv, pinnedMakerSuiteAPIURL)
}

func pinnedVertexAIBaseURL() string {
	return sdSeamURL(pinnedVertexAISeamEnv, pinnedVertexAIAPIURL)
}

// pinnedVertexAIHost is `region === 'global' ? 'https://aiplatform.googleapis.com'
// : 'https://' + region + '-aiplatform.googleapis.com'` (:693-695, :718-722).
func pinnedVertexAIHost(region string) string {
	if region == "global" {
		return "https://aiplatform.googleapis.com"
	}
	return "https://" + region + "-aiplatform.googleapis.com"
}

// pinnedGoogleResponseType is `stream ? 'streamGenerateContent' : 'generateContent'` (:680).
func pinnedGoogleResponseType(stream bool) string {
	if stream {
		return "streamGenerateContent"
	}
	return "generateContent"
}

// trimmedGoogleBase is `apiUrl.toString().replace(/\/$/, ”)` (:726, :730): exactly one trailing slash is
// removed, which is what a reverse_proxy entered as `https://host/` needs.
func trimmedGoogleBase(base string) string {
	if len(base) > 0 && base[len(base)-1] == '/' {
		return base[:len(base)-1]
	}
	return base
}

// pinnedMakerSuiteGenerateURL is :730:
//
//	`${apiUrl}/${apiVersion}/models/${model}:${responseType}?key=${apiKey}${stream ? '&alt=sse' : ''}`
//
// The key is a QUERY parameter and no Authorization header is attached for this source: `authHeader` is
// assigned at :484 and then never used on the makersuite path, which is easy to misread.
func pinnedMakerSuiteGenerateURL(base, apiVersion, model string, stream bool, apiKey string) string {
	url := trimmedGoogleBase(base) + "/" + apiVersion + "/models/" + model + ":" + pinnedGoogleResponseType(stream) + "?key=" + apiKey
	if stream {
		url += "&alt=sse"
	}
	return url
}

// pinnedVertexAIProxyGenerateURL is the proxy auth mode (:726): the reverse_proxy base is used verbatim and
// the credential travels in the Authorization header, so the URL carries only `?alt=sse` when streaming.
func pinnedVertexAIProxyGenerateURL(base, model string, stream bool) string {
	url := trimmedGoogleBase(base) + "/" + pinnedVertexAIAPIVersion + "/publishers/google/models/" + model + ":" + pinnedGoogleResponseType(stream)
	if stream {
		url += "?alt=sse"
	}
	return url
}

// pinnedVertexAIExpressGenerateURL is the express (API key) mode (:696-698). A project id, when present,
// selects the PROJECT path AND forces the global host even for a regional location.
func pinnedVertexAIExpressGenerateURL(model string, stream bool, apiKey, projectID, region string) string {
	url := ""
	if projectID != "" {
		url = "https://aiplatform.googleapis.com/" + pinnedVertexAIAPIVersion +
			"/projects/" + projectID + "/locations/" + region +
			"/publishers/google/models/" + model + ":" + pinnedGoogleResponseType(stream)
	} else {
		url = pinnedVertexAIHost(region) + "/" + pinnedVertexAIAPIVersion +
			"/publishers/google/models/" + model + ":" + pinnedGoogleResponseType(stream)
	}
	url += "?key=" + apiKey
	if stream {
		url += "&alt=sse"
	}
	return url
}

// pinnedVertexAIServiceAccountGenerateURL is the full (service account) mode (:716-722): the project id
// comes from the service-account JSON, the host is regional, and the credential is an Authorization header
// added by the caller, so the URL carries only `?alt=sse` when streaming.
func pinnedVertexAIServiceAccountGenerateURL(model string, stream bool, projectID, region string) string {
	url := pinnedVertexAIHost(region) + "/" + pinnedVertexAIAPIVersion +
		"/projects/" + projectID + "/locations/" + region +
		"/publishers/google/models/" + model + ":" + pinnedGoogleResponseType(stream)
	if stream {
		url += "?alt=sse"
	}
	return url
}

// pinnedMakerSuiteStatusURL is the makersuite status arm's OWN URL shape (:1912-1914):
//
//	!apiKey && reverse_proxy  ->  `${apiUrl}/${apiVersion}/models`
//	otherwise                 ->  `${apiUrl}/${apiVersion}/models?key=${apiKey}`
//
// Unlike every other source in the status matrix this arm builds its URL itself and answers `{data: models}`
// (a projection of fetchGoogleModels), not the shared `{data: {...}}` envelope.
func pinnedMakerSuiteStatusURL(base, apiVersion, apiKey string, hasReverseProxy bool) string {
	url := trimmedGoogleBase(base) + "/" + apiVersion + "/models"
	if apiKey == "" && hasReverseProxy {
		return url
	}
	return url + "?key=" + apiKey
}

// THE GEMINI BODY LAYER (chat-completions.js:497-660, prompt-converters.js).
//
// This file ports the REQUEST BODY the two Google sources send. The URL/credential layer lives in
// makersuite_chat.go and vertexai_chat.go; the prompt converter (convertGooglePrompt) is the one piece NOT
// ported here, and it is named as a boundary at the bottom of this file rather than half-implemented.

const (
	pinnedGoogleResponseMimeJSON = "application/json"
)

// pinnedGoogleReasoningEffort is REASONING_EFFORT.auto/min/low/medium/high/max as the string the pinned code
// compares against. The values are the ones the frontend sends.
var pinnedGoogleNoSamplingModel = regexp.MustCompile(`gemini-3\.[67]-flash|gemini-3\.5-flash-lite`)
var pinnedGoogleNoPrefillModel = regexp.MustCompile(`gemini-3\.[67]-flash|gemini-3\.5-flash-lite`)
var pinnedGoogleGemma3 = regexp.MustCompile(`gemma-3`)
var pinnedGoogleThinkingConfigModel = regexp.MustCompile(`^gemini-2\.5-(flash|pro)|^gemini-3[.\d]*-(flash|pro)`)
var pinnedGoogleThinkingConfigImageExclusion = regexp.MustCompile(`-image(-preview)?$`)
var pinnedGoogleImageSizeModel = regexp.MustCompile(`^gemini-3`)
var pinnedGoogleGemini3FlashBudget = regexp.MustCompile(`gemini-3\.7-flash`)

var pinnedGoogleImageGenerationModels = []string{
	"gemini-2.0-flash-exp",
	"gemini-2.0-flash-exp-image-generation",
	"gemini-2.0-flash-preview-image-generation",
	"gemini-2.5-flash-image-preview",
	"gemini-2.5-flash-image",
	"gemini-3-pro-image",
	"gemini-3.1-flash-image",
}

var pinnedGoogleNoSearchModels = []string{
	"gemini-2.0-flash-lite",
	"gemini-2.0-flash-lite-001",
	"gemini-2.0-flash-lite-preview-02-05",
	"gemini-robotics-er-1.5-preview",
}

// pinnedGoogleCalculateBudgetTokens is calculateGoogleBudgetTokens (prompt-converters.js): a NUMBER for a token
// budget, the string "auto" where the pinned code returns -1 (which the caller sends as thinkingBudget -1),
// and no value where the pinned code returns null/undefined.
func pinnedGoogleCalculateBudgetTokens(maxTokens orderedNodeJSON, reasoningEffort string, model string) (orderedNodeJSON, bool) {
	limit := 0
	if number, ok := maxTokens.scalar.(float64); ok {
		limit = int(number)
	}
	if pinnedGoogleThinkingConfigModel.MatchString(model) && pinnedGoogleThinkingConfigImageExclusion.MatchString(model) {
		// The image variants are excluded from the thinking-config model list entirely.
		return nodeUndefined(), false
	}
	switch {
	case strings.HasPrefix(model, "gemini-3"):
		// getGemini3FlashBudget / getGemini3ProBudget: no "auto" budget, and a floor of 128 except for min.
		if pinnedGoogleGemini3FlashBudget.MatchString(model) {
			switch reasoningEffort {
			case "auto":
				return nodeUndefined(), false
			}
		}
		switch reasoningEffort {
		case "min":
			return nodeNumber(0), true
		case "low":
			return nodeNumber(float64(limit) * 0.1), true
		case "medium":
			return nodeNumber(float64(limit) * 0.25), true
		case "high":
			return nodeNumber(float64(limit) * 0.5), true
		case "max":
			return nodeNumber(float64(limit)), true
		}
		return nodeUndefined(), false
	case strings.Contains(model, "flash-lite"):
		switch reasoningEffort {
		case "auto":
			return nodeNumber(-1), true
		case "min":
			return nodeNumber(128), true
		case "low", "medium", "high", "max":
			budget := map[string]float64{"low": 0.1, "medium": 0.25, "high": 0.5}[reasoningEffort] * float64(limit)
			if reasoningEffort == "max" {
				budget = float64(limit)
			}
			if budget > 32768 {
				budget = 32768
			}
			if budget < 128 {
				budget = 128
			}
			return nodeNumber(budget), true
		}
		return nodeUndefined(), false
	default:
		switch reasoningEffort {
		case "auto":
			return nodeNumber(-1), true
		case "min":
			return nodeNumber(0), true
		case "low", "medium", "high", "max":
			budget := map[string]float64{"low": 0.1, "medium": 0.25, "high": 0.5}[reasoningEffort] * float64(limit)
			if reasoningEffort == "max" {
				budget = float64(limit)
			}
			if budget > 24576 {
				budget = 24576
			}
			return nodeNumber(budget), true
		}
		return nodeUndefined(), false
	}
}

// pinnedGoogleGenerationConfig is the generationConfig object, member order included.
func pinnedGoogleGenerationConfig(body orderedNodeJSON, model string) orderedNodeJSON {
	config := nodeObject()
	if stop, exists := body.member("stop"); exists && stop.kind == 'a' && len(stop.array) > 0 {
		config.setMember("stopSequences", stop)
	}
	config.setMember("candidateCount", nodeNumber(1))
	for _, pair := range [][2]string{{"maxOutputTokens", "max_tokens"}, {"temperature", "temperature"}, {"topP", "top_p"}} {
		if value, exists := body.member(pair[1]); exists && !value.isUndefined() {
			config.setMember(pair[0], value)
		}
	}
	// `topK: request.body.top_k || undefined` -- a zero or absent top_k is OMITTED.
	if topK, exists := body.member("top_k"); exists && pinnedJSTruthy(topK) {
		config.setMember("topK", topK)
	}
	responseMimeType := nodeUndefined()
	if value, exists := body.member("responseMimeType"); exists && !value.isUndefined() {
		responseMimeType = value
	} else if _, hasSchema := body.member("json_schema"); hasSchema && pinnedJSTruthy(mustMember(body, "json_schema")) {
		responseMimeType = nodeString(pinnedGoogleResponseMimeJSON)
	}
	if !responseMimeType.isUndefined() {
		config.setMember("responseMimeType", responseMimeType)
	}
	responseSchema := nodeUndefined()
	if value, exists := body.member("responseSchema"); exists && !value.isUndefined() {
		responseSchema = value
	} else if schema, hasSchema := body.member("json_schema"); hasSchema && pinnedJSTruthy(schema) {
		responseSchema = mustMember(schema, "value")
	}
	if !responseSchema.isUndefined() {
		config.setMember("responseSchema", responseSchema)
	}
	if seed, exists := body.member("seed"); exists && !seed.isUndefined() {
		config.setMember("seed", seed)
	}
	if pinnedGoogleNoSamplingModel.MatchString(model) {
		for _, member := range []string{"temperature", "topP", "topK", "candidateCount"} {
			config.deleteMember(member)
		}
	}
	return config
}

// pinnedGoogleApplyImageModality adds responseModalities and imageConfig, and reports whether the request is an
// image request (which excludes the system prompt, tools and web search).
func pinnedGoogleApplyImageModality(config *orderedNodeJSON, body orderedNodeJSON, model string) bool {
	requestImages := false
	if value, exists := body.member("request_images"); exists && pinnedJSTruthy(value) {
		requestImages = true
	}
	enable := requestImages && pinnedGoogleContains(pinnedGoogleImageGenerationModels, model)
	if !enable {
		return false
	}
	modalities := nodeArray(nodeString("text"), nodeString("image"))
	config.setMember("responseModalities", modalities)
	aspectRatio := ""
	if value, exists := body.member("request_image_aspect_ratio"); exists {
		if text, err := pinnedJSStringValue(value); err == nil && text != "" && text != "undefined" {
			aspectRatio = text
		}
	}
	imageSize := ""
	if value, exists := body.member("request_image_resolution"); exists {
		if text, err := pinnedJSStringValue(value); err == nil && text != "" && text != "undefined" {
			imageSize = text
		}
	}
	if aspectRatio == "" && imageSize == "" {
		return true
	}
	imageConfig := nodeObject()
	if imageSize != "" && pinnedGoogleImageSizeModel.MatchString(model) {
		imageConfig.setMember("imageSize", nodeString(imageSize))
	}
	if aspectRatio != "" {
		imageConfig.setMember("aspectRatio", nodeString(aspectRatio))
	}
	config.setMember("imageConfig", imageConfig)
	return true
}

// pinnedGoogleTools is the tools array: function_declarations with the $schema and empty-properties deletion,
// custom tools only when no function calling is present, and google_search only when it is allowed.
func pinnedGoogleTools(body orderedNodeJSON, model string, imageModality bool) orderedNodeJSON {
	tools := nodeArray()
	enableWebSearch := false
	if value, exists := body.member("enable_web_search"); exists && pinnedJSTruthy(value) {
		enableWebSearch = true
	}
	if listed, exists := body.member("tools"); exists && listed.kind == 'a' && len(listed.array) > 0 && !imageModality && !pinnedGoogleGemma3.MatchString(model) {
		declarations := nodeArray()
		customTools := nodeArray()
		for _, tool := range listed.array {
			if tool.kind != 'o' {
				continue
			}
			toolType := ""
			if value, ok := tool.member("type"); ok {
				toolType, _ = pinnedJSStringValue(value)
			}
			if toolType == "function" {
				function, hasFunction := tool.member("function")
				if !hasFunction {
					continue
				}
				if parameters, hasParameters := function.member("parameters"); hasParameters && parameters.kind == 'o' {
					parameters.deleteMember("$schema")
					if properties, hasProperties := parameters.member("properties"); hasProperties && properties.kind == 'o' && len(properties.object) == 0 {
						function.deleteMember("parameters")
					}
					function.setMember("parameters", parameters)
				}
				declarations.array = append(declarations.array, function)
			} else if toolType != "" {
				if value, ok := tool.member(toolType); ok {
					custom := nodeObject()
					custom.setMember(toolType, value)
					customTools.array = append(customTools.array, custom)
				}
			}
		}
		if len(declarations.array) > 0 {
			wrapper := nodeObject()
			wrapper.setMember("function_declarations", declarations)
			tools.array = append(tools.array, wrapper)
		}
		// Custom tools are only supported when no function calling is present.
		if len(declarations.array) == 0 && len(customTools.array) > 0 {
			tools.array = append(tools.array, customTools.array...)
		}
	}
	isLearnLM := strings.Contains(model, "learnlm")
	if enableWebSearch && !imageModality && !pinnedGoogleGemma3.MatchString(model) && !isLearnLM && !pinnedGoogleContains(pinnedGoogleNoSearchModels, model) {
		hasDeclarations := false
		for _, tool := range tools.array {
			if _, ok := tool.member("function_declarations"); ok {
				hasDeclarations = true
				break
			}
		}
		if !hasDeclarations {
			search := nodeObject()
			search.setMember("google_search", nodeObject())
			tools.array = append(tools.array, search)
		}
	}
	return tools
}

// pinnedGoogleToolConfig is the tool_choice -> functionCallingConfig translation, applied only when tools exist.
func pinnedGoogleToolConfig(body orderedNodeJSON) (orderedNodeJSON, bool) {
	toolChoice, exists := body.member("tool_choice")
	if !exists {
		return nodeUndefined(), false
	}
	config := nodeObject()
	if text, err := pinnedJSStringValue(toolChoice); err == nil {
		switch text {
		case "none":
			config.setMember("mode", nodeString("NONE"))
		case "required":
			config.setMember("mode", nodeString("ANY"))
		case "auto":
			config.setMember("mode", nodeString("AUTO"))
		default:
			return nodeUndefined(), false
		}
	} else if toolChoice.kind == 'o' {
		function, hasFunction := toolChoice.member("function")
		if !hasFunction {
			return nodeUndefined(), false
		}
		name, hasName := function.member("name")
		if !hasName || name.isUndefined() {
			return nodeUndefined(), false
		}
		config.setMember("mode", nodeString("ANY"))
		config.setMember("allowedFunctionNames", nodeArray(name))
	} else {
		return nodeUndefined(), false
	}
	wrapper := nodeObject()
	wrapper.setMember("functionCallingConfig", config)
	return wrapper, true
}

// pinnedGoogleApplyThinkingConfig is the thinkingConfig member and Vertex's zero-budget clearing, which is the
// one documented asymmetry between the two sources.
func pinnedGoogleApplyThinkingConfig(config *orderedNodeJSON, body orderedNodeJSON, model string, useVertexAI bool) {
	if !pinnedGoogleThinkingConfigModel.MatchString(model) || pinnedGoogleThinkingConfigImageExclusion.MatchString(model) {
		return
	}
	includeReasoning := false
	if value, exists := body.member("include_reasoning"); exists && pinnedJSTruthy(value) {
		includeReasoning = true
	}
	thinking := nodeObject()
	thinking.setMember("includeThoughts", nodeBool(includeReasoning))
	effort := ""
	if value, exists := body.member("reasoning_effort"); exists {
		effort, _ = pinnedJSStringValue(value)
	}
	maxTokens, _ := body.member("max_tokens")
	budget, hasBudget := pinnedGoogleCalculateBudgetTokens(maxTokens, effort, model)
	if hasBudget {
		if number, ok := budget.scalar.(float64); ok && number == -1 {
			thinking.setMember("thinkingBudget", budget)
		} else if _, isString := budget.scalar.(string); isString {
			thinking.setMember("thinkingLevel", budget)
		} else {
			thinking.setMember("thinkingBudget", budget)
		}
	}
	// Vertex does not allow mixing disabled thinking with includeThoughts.
	if useVertexAI && hasBudget && !budget.isUndefined() {
		if number, ok := budget.scalar.(float64); ok && number == 0 && includeReasoning {
			thinking.setMember("includeThoughts", nodeBool(false))
		}
	}
	config.setMember("thinkingConfig", thinking)
}

func pinnedGoogleContains(list []string, value string) bool {
	for _, entry := range list {
		if entry == value {
			return true
		}
	}
	return false
}

// NOT PORTED, named: `convertGooglePrompt` (prompt-converters.js) converts the message array into
// `contents` (role rewriting, tool_calls -> functionCall, tool_call_id -> functionResponse, image parts, the
// system-prompt collapse and the trailing-prefill rewrite for the newest models) and builds the
// `systemInstruction` the body carries. Until it is ported, `pinnedGoogleBody` REFUSES rather than emitting a
// body without contents, because a request with an empty message array would be a fabricated success.
