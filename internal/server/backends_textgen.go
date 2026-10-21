package server

// Pinned text-completion backend routes, from src/endpoints/backends/text-completions.js:
//
//	POST /status                                   (100)
//	POST /props                                    (234)
//	POST /text-completions/llamacpp/props          (521)
//	POST /text-completions/llamacpp/slots          (549)
//	POST /text-completions/ollama/download         (445)
//	POST /text-completions/ollama/caption-image    (475)
//	POST /text-completions/tabby/download          (600)
//
// DEFERRED (not implemented, fixture knownDifferences): /text-completions/generate, the streaming
// proxy with per-api-type key filtering, Ollama JSON-frame streaming and cancellation.
//
// These routes take their upstream URL from the request body, so no seam is needed; the failure
// paths are exercised against a closed loopback port in the fixture (kobold/status) and through
// the mocked non-2xx responses for the rest.

import (
	"net/http"
	"regexp"
	"strings"
)

// backendsTextCompletionStatusSuffix is the pinned api_type -> models-path switch. A type that is
// not a string (or not in the switch) leaves the base URL unchanged, exactly like the JS switch.
func backendsTextCompletionStatusSuffix(apiType string) string {
	switch apiType {
	case "generic", "ooba", "vllm", "aphrodite", "koboldcpp", "llamacpp", "infermaticai", "openrouter", "featherless":
		return "/v1/models"
	case "dreamgen":
		return "/api/openai/v1/models"
	case "mancer":
		return "/oai/v1/models"
	case "tabby":
		return "/v1/model/list"
	case "togetherai":
		return "/api/models?&info"
	case "ollama":
		return "/api/tags"
	case "huggingface":
		return "/info"
	default:
		return ""
	}
}

// serveBackendsTextCompletionStatus is text-completions.js:100.
func (runtime *accountRuntime) serveBackendsTextCompletionStatus(w http.ResponseWriter, request *http.Request) {
	_, directories, ok := runtime.sdUser(w, request)
	if !ok {
		return
	}
	body, ok := runtime.sdRequestBody(w, request)
	if !ok {
		return
	}
	apiServerNode := sdBodyMember(body, "api_server")
	apiServer, err := pinnedJSStringValue(apiServerNode)
	if err != nil || apiServerNode.kind != 's' {
		// The pinned handler calls api_server.indexOf before any try/catch protection; a missing or
		// non-string value throws in the async handler. Answer 500 instead of terminating.
		backendsStatus(w, http.StatusInternalServerError)
		return
	}
	apiServer = backendsKoboldRewriteLocalhost(apiServer)
	baseURL := searchTrimV1(nodeString(apiServer))
	headers, err := backendsAdditionalHeaders(body, directories)
	if err != nil {
		backendsStatus(w, http.StatusInternalServerError)
		return
	}
	headers["content-type"] = "application/json"
	apiType, _ := sdBodyMember(body, "api_type").stringValue()
	target := baseURL + backendsTextCompletionStatusSuffix(apiType)

	response, err := backendsFetch(request, searchRequest{Method: http.MethodGet, URL: target, Headers: headers})
	if err != nil {
		backendsStatus(w, http.StatusInternalServerError)
		return
	}
	isPossiblyLmStudio := backendsHeaderValue(response, "x-powered-by") == "Express"
	if !sdResponseOK(response) {
		backendsStatus(w, http.StatusBadRequest)
		return
	}
	data, parsed := sdReadJSON(response)
	if !parsed {
		backendsStatus(w, http.StatusInternalServerError)
		return
	}

	if apiType == "togetherai" && data.kind == 'a' {
		wrapped := nodeArray()
		for _, item := range data.array {
			entry := nodeObject()
			name, nameOK := sdMemberOf(item, "name")
			if !nameOK {
				backendsStatus(w, http.StatusInternalServerError)
				return
			}
			entry.setMember("id", name)
			if item.kind == 'o' {
				for _, member := range item.object {
					entry.setMember(member.key, member.value)
				}
			}
			wrapped.array = append(wrapped.array, entry)
		}
		rewrapped := nodeObject()
		rewrapped.setMember("data", wrapped)
		data = rewrapped
	}
	if apiType == "ollama" {
		models, exists := sdMemberOf(data, "models")
		if exists && models.kind == 'a' {
			wrapped := nodeArray()
			for _, item := range models.array {
				entry := nodeObject()
				name, nameOK := sdMemberOf(item, "name")
				if !nameOK {
					backendsStatus(w, http.StatusInternalServerError)
					return
				}
				entry.setMember("id", name)
				if item.kind == 'o' {
					for _, member := range item.object {
						entry.setMember(member.key, member.value)
					}
				}
				wrapped.array = append(wrapped.array, entry)
			}
			rewrapped := nodeObject()
			rewrapped.setMember("data", wrapped)
			data = rewrapped
		}
	}
	if apiType == "huggingface" {
		rewrapped := nodeObject()
		rewrapped.setMember("data", nodeArray())
		data = rewrapped
	}

	entries, exists := sdMemberOf(data, "data")
	if !exists || entries.kind != 'a' {
		backendsStatus(w, http.StatusBadRequest)
		return
	}
	modelIDs := nodeArray()
	for _, entry := range entries.array {
		id, idOK := sdMemberOf(entry, "id")
		if !idOK {
			backendsStatus(w, http.StatusInternalServerError)
			return
		}
		modelIDs.array = append(modelIDs.array, id)
	}
	result := nodeString("Valid")
	if len(modelIDs.array) > 0 && pinnedJSTruthy(modelIDs.array[0]) {
		result = modelIDs.array[0]
	}

	if apiType == "ooba" && !isPossiblyLmStudio {
		if infoResponse, infoOK, infoErr := backendsGet(request, baseURL+"/v1/internal/model/info", headers); infoErr == nil && infoOK {
			if info, infoParsed := sdReadJSON(infoResponse); infoParsed {
				modelName, nameExists := sdMemberOf(info, "model_name")
				if nameExists && pinnedJSTruthy(modelName) {
					result = modelName
				}
				w.Header().Set("x-supports-tokenization", "true")
			}
		}
	} else if apiType == "tabby" {
		if infoResponse, infoOK, infoErr := backendsGet(request, baseURL+"/v1/model", headers); infoErr == nil && infoOK {
			if info, infoParsed := sdReadJSON(infoResponse); infoParsed {
				modelName, nameExists := sdMemberOf(info, "id")
				if nameExists && pinnedJSTruthy(modelName) {
					result = modelName
				}
			}
		} else if infoErr == nil {
			result = nodeString("None")
		}
	}

	payload := nodeObject()
	payload.setMember("result", result)
	payload.setMember("data", entries)
	backendsJSON(w, payload)
}

// serveBackendsTextCompletionProps is text-completions.js:234.
func (runtime *accountRuntime) serveBackendsTextCompletionProps(w http.ResponseWriter, request *http.Request) {
	_, directories, ok := runtime.sdUser(w, request)
	if !ok {
		return
	}
	body, ok := runtime.sdRequestBody(w, request)
	if !ok {
		return
	}
	apiServerNode := sdBodyMember(body, "api_server")
	if !pinnedJSTruthy(apiServerNode) {
		backendsStatus(w, http.StatusBadRequest)
		return
	}
	baseURL := searchTrimV1(apiServerNode)
	headers, err := backendsAdditionalHeaders(body, directories)
	if err != nil {
		backendsStatus(w, http.StatusInternalServerError)
		return
	}
	apiType, _ := sdBodyMember(body, "api_type").stringValue()
	target := baseURL + "/props"
	if apiType == "llamacpp" {
		if model := sdBodyMember(body, "model"); pinnedJSTruthy(model) {
			modelText, modelErr := pinnedJSStringValue(model)
			if modelErr != nil {
				backendsStatus(w, http.StatusInternalServerError)
				return
			}
			target += "?model=" + sdEncodeURIComponent(modelText)
		}
	}
	response, err := backendsFetch(request, searchRequest{Method: http.MethodGet, URL: target, Headers: headers})
	if err != nil {
		backendsStatus(w, http.StatusInternalServerError)
		return
	}
	if !sdResponseOK(response) {
		backendsStatus(w, http.StatusBadRequest)
		return
	}
	props, parsed := sdReadJSON(response)
	if !parsed {
		backendsStatus(w, http.StatusInternalServerError)
		return
	}
	chatTemplate, exists := sdMemberOf(props, "chat_template")
	if !exists {
		// `props.chat_template.endsWith` / `createHash().update(undefined)` throw in pinned.
		backendsStatus(w, http.StatusInternalServerError)
		return
	}
	templateText, isString := chatTemplate.stringValue()
	if !isString {
		backendsStatus(w, http.StatusInternalServerError)
		return
	}
	if apiType == "llamacpp" && strings.HasSuffix(templateText, "\x00") {
		templateText = strings.TrimSuffix(templateText, "\x00") + "\n"
		props.setMember("chat_template", nodeString(templateText))
	}
	props.setMember("chat_template_hash", nodeString(backendsSHA256Hex(templateText)))
	backendsJSON(w, props)
}

// serveBackendsLlamaCppProps is text-completions.js:521: a header-less GET of /props.
func (runtime *accountRuntime) serveBackendsLlamaCppProps(w http.ResponseWriter, request *http.Request) {
	if _, _, ok := runtime.sdUser(w, request); !ok {
		return
	}
	body, ok := runtime.sdRequestBody(w, request)
	if !ok {
		return
	}
	serverURL := sdBodyMember(body, "server_url")
	if !pinnedJSTruthy(serverURL) {
		backendsStatus(w, http.StatusBadRequest)
		return
	}
	baseURL := searchTrimV1(serverURL)
	response, err := backendsFetch(request, searchRequest{Method: http.MethodGet, URL: baseURL + "/props"})
	if err != nil {
		backendsStatus(w, http.StatusInternalServerError)
		return
	}
	if !sdResponseOK(response) {
		backendsStatusWithError(w, http.StatusInternalServerError)
		return
	}
	data, parsed := sdReadJSON(response)
	if !parsed {
		backendsStatus(w, http.StatusInternalServerError)
		return
	}
	backendsJSON(w, data)
}

// serveBackendsLlamaCppSlots is text-completions.js:549.
func (runtime *accountRuntime) serveBackendsLlamaCppSlots(w http.ResponseWriter, request *http.Request) {
	if _, _, ok := runtime.sdUser(w, request); !ok {
		return
	}
	body, ok := runtime.sdRequestBody(w, request)
	if !ok {
		return
	}
	serverURL := sdBodyMember(body, "server_url")
	if !pinnedJSTruthy(serverURL) {
		backendsStatus(w, http.StatusBadRequest)
		return
	}
	actionNode := sdBodyMember(body, "action")
	action, _ := actionNode.stringValue()
	if !backendsSlotActionPattern.MatchString(action) {
		backendsStatus(w, http.StatusBadRequest)
		return
	}
	baseURL := searchTrimV1(serverURL)
	var response *outboundResponseAlias
	var err error
	if action == "info" {
		response, err = backendsFetch(request, searchRequest{Method: http.MethodGet, URL: baseURL + "/slots"})
	} else {
		idSlotNode := sdBodyMember(body, "id_slot")
		idSlot, _ := pinnedJSStringValue(idSlotNode)
		if !backendsDigitsPattern.MatchString(idSlot) {
			backendsStatus(w, http.StatusBadRequest)
			return
		}
		filenameNode := sdBodyMember(body, "filename")
		if action != "erase" && !pinnedJSTruthy(filenameNode) {
			backendsStatus(w, http.StatusBadRequest)
			return
		}
		payload := nodeObject()
		if action != "erase" {
			filename, filenameErr := pinnedJSStringValue(filenameNode)
			if filenameErr != nil {
				backendsStatus(w, http.StatusInternalServerError)
				return
			}
			payload.setMember("filename", nodeString(filename))
		}
		encoded, encodeErr := marshalOrderedNodeJSON(payload)
		if encodeErr != nil {
			backendsStatus(w, http.StatusInternalServerError)
			return
		}
		response, err = backendsFetch(request, searchRequest{
			Method:  http.MethodPost,
			URL:     baseURL + "/slots/" + idSlot + "?action=" + action,
			Headers: map[string]string{"content-type": "application/json"},
			Body:    encoded,
		})
	}
	if err != nil {
		backendsStatus(w, http.StatusInternalServerError)
		return
	}
	if !sdResponseOK(response) {
		backendsStatusWithError(w, http.StatusInternalServerError)
		return
	}
	data, parsed := sdReadJSON(response)
	if !parsed {
		backendsStatus(w, http.StatusInternalServerError)
		return
	}
	backendsJSON(w, data)
}

var (
	backendsSlotActionPattern = regexp.MustCompile(`^(erase|info|restore|save)$`)
	backendsDigitsPattern     = regexp.MustCompile(`^\d+$`)
)

// serveBackendsOllamaDownload is text-completions.js:445.
func (runtime *accountRuntime) serveBackendsOllamaDownload(w http.ResponseWriter, request *http.Request) {
	if _, _, ok := runtime.sdUser(w, request); !ok {
		return
	}
	body, ok := runtime.sdRequestBody(w, request)
	if !ok {
		return
	}
	nameNode := sdBodyMember(body, "name")
	apiServerNode := sdBodyMember(body, "api_server")
	if !pinnedJSTruthy(nameNode) || !pinnedJSTruthy(apiServerNode) {
		backendsStatus(w, http.StatusBadRequest)
		return
	}
	baseURL := backendsTrimTrailingSlash(apiServerNode)
	payload := nodeObject()
	name, nameErr := pinnedJSStringValue(nameNode)
	if nameErr != nil {
		backendsStatus(w, http.StatusInternalServerError)
		return
	}
	payload.setMember("name", nodeString(name))
	payload.setMember("stream", nodeBool(false))
	encoded, err := marshalOrderedNodeJSON(payload)
	if err != nil {
		backendsStatus(w, http.StatusInternalServerError)
		return
	}
	response, _, err := backendsPost(request, baseURL+"/api/pull", map[string]string{"content-type": "application/json"}, encoded)
	if err != nil {
		backendsStatus(w, http.StatusInternalServerError)
		return
	}
	if !sdResponseOK(response) {
		backendsStatusWithError(w, http.StatusInternalServerError)
		return
	}
	if _, parsed := sdReadJSON(response); !parsed {
		// The pinned handler parses the pull response only to log it; a parse failure is caught by
		// the route's catch and answers 500.
		backendsStatus(w, http.StatusInternalServerError)
		return
	}
	backendsJSON(w, nodeObjectWith("ok", nodeBool(true)))
}

// serveBackendsOllamaCaptionImage is text-completions.js:475.
func (runtime *accountRuntime) serveBackendsOllamaCaptionImage(w http.ResponseWriter, request *http.Request) {
	if _, _, ok := runtime.sdUser(w, request); !ok {
		return
	}
	body, ok := runtime.sdRequestBody(w, request)
	if !ok {
		return
	}
	serverURLNode := sdBodyMember(body, "server_url")
	modelNode := sdBodyMember(body, "model")
	if !pinnedJSTruthy(serverURLNode) || !pinnedJSTruthy(modelNode) {
		backendsStatus(w, http.StatusBadRequest)
		return
	}
	baseURL := searchTrimV1(serverURLNode)
	payload := nodeObject()
	model, modelErr := pinnedJSStringValue(modelNode)
	if modelErr != nil {
		backendsStatus(w, http.StatusInternalServerError)
		return
	}
	payload.setMember("model", nodeString(model))
	if promptNode := sdBodyMember(body, "prompt"); !promptNode.isUndefined() {
		payload.setMember("prompt", promptNode)
	}
	images := nodeArray()
	if imageNode := sdBodyMember(body, "image"); !imageNode.isUndefined() {
		images.array = append(images.array, imageNode)
	}
	payload.setMember("images", images)
	payload.setMember("stream", nodeBool(false))
	encoded, err := marshalOrderedNodeJSON(payload)
	if err != nil {
		backendsStatus(w, http.StatusInternalServerError)
		return
	}
	response, _, err := backendsPost(request, baseURL+"/api/generate", map[string]string{"content-type": "application/json"}, encoded)
	if err != nil {
		backendsStatus(w, http.StatusInternalServerError)
		return
	}
	if !sdResponseOK(response) {
		backendsStatusWithError(w, http.StatusInternalServerError)
		return
	}
	data, parsed := sdReadJSON(response)
	if !parsed {
		backendsStatus(w, http.StatusInternalServerError)
		return
	}
	caption := nodeString("")
	if response, exists := sdMemberOf(data, "response"); exists && pinnedJSTruthy(response) {
		caption = response
	}
	if caption.kind == 's' && caption.scalar.(string) == "" {
		backendsStatusWithError(w, http.StatusInternalServerError)
		return
	}
	if caption.kind != 's' {
		// `caption` is truthy here; the response sends it as the caption.
		backendsJSON(w, nodeObjectWith("caption", caption))
		return
	}
	backendsJSON(w, nodeObjectWith("caption", caption))
}

// serveBackendsTabbyDownload is text-completions.js:600: an admin permission probe followed by
// the download request carrying the original body.
func (runtime *accountRuntime) serveBackendsTabbyDownload(w http.ResponseWriter, request *http.Request) {
	_, directories, ok := runtime.sdUser(w, request)
	if !ok {
		return
	}
	body, ok := runtime.sdRequestBody(w, request)
	if !ok {
		return
	}
	baseURL := backendsTrimTrailingSlash(sdBodyMember(body, "api_server"))
	headers, err := backendsAdditionalHeaders(body, directories)
	if err != nil {
		backendsStatus(w, http.StatusInternalServerError)
		return
	}
	headers["content-type"] = "application/json"
	encoded, err := marshalOrderedNodeJSON(body)
	if err != nil {
		backendsStatus(w, http.StatusInternalServerError)
		return
	}
	permission, permissionOK, permissionErr := backendsGet(request, baseURL+"/v1/auth/permission", headers)
	if permissionErr != nil {
		backendsStatus(w, http.StatusInternalServerError)
		return
	}
	if !permissionOK {
		backendsStatusWithError(w, http.StatusInternalServerError)
		return
	}
	permissionData, parsed := sdReadJSON(permission)
	if !parsed {
		backendsStatus(w, http.StatusInternalServerError)
		return
	}
	permissionValue, _ := sdMemberOf(permissionData, "permission")
	if permissionText, isString := permissionValue.stringValue(); !isString || permissionText != "admin" {
		backendsStatusWithError(w, http.StatusForbidden)
		return
	}
	response, _, err := backendsPost(request, baseURL+"/v1/download", headers, encoded)
	if err != nil {
		backendsStatus(w, http.StatusInternalServerError)
		return
	}
	if !sdResponseOK(response) {
		backendsStatusWithError(w, http.StatusInternalServerError)
		return
	}
	backendsJSON(w, nodeObjectWith("ok", nodeBool(true)))
}

// backendsStatusWithError is `response.status(code).send({error: true})`.
func backendsStatusWithError(w http.ResponseWriter, status int) {
	respondOrderedNodeJSON(w, status, nodeObjectWith("error", nodeBool(true)))
}
