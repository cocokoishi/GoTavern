package server

// The GEMINI TRANSPORT: sendMakerSuiteRequest (chat-completions.js:454-792) for BOTH Google sources.
//
// The URL/credential layer (pinnedMakerSuiteGenerateURL, pinnedVertexAI*GenerateURL, pinnedVertexAIAuth) and the
// body layer (pinnedGoogleBody) already exist; this file adds the missing third: assembling the request from
// them, and the response side. Both sources share one function upstream, and the ONLY structural differences
// are the URL shape and which credential travels where -- so they share one plan here too, with `useVertexAI`
// as the switch, rather than two copies that could drift.
//
// WHAT IS EASY TO GET WRONG, each read from the pinned lines:
//   - MAKERSUITE AUTHENTICATES WITH A QUERY PARAMETER. `authHeader = 'Bearer ' + apiKey` is ASSIGNED at :484 and
//     then never attached to the request: the key travels as `?key=` (:730) and the header set is ONLY
//     `Content-Type` (:683-685). A port that adds Authorization would send a header upstream never sends.
//   - the two sources have DIFFERENT failure shapes for a credential problem: makersuite answers
//     `400 {"error":true}` (:479-482) while vertex answers `400 {"error":true,"message":<pinned message>}`
//     (:471-474). The vertex message comes from the auth catch, so it is a real sentence, not a flag.
//   - VERTEX EXPRESS puts the key in the query (`?key=`), VERTEX PROXY and VERTEX FULL put it in the
//     Authorization header (:723, :727), and full mode reads the project id out of the service-account JSON at
//     :702-715 with two of its own `400 {"error":true}` paths.
//   - the stream marker differs by source: makersuite appends `&alt=sse` to a query that already carries
//     `?key=`, vertex appends `?alt=sse` because its base query may be empty (:697-698, :719-726, :730).
//   - a NON-2xx provider answer is answered 500 with `tryParse(errorText) ?? {error:true}` (:751-755) -- the
//     body is the provider's own JSON when it parses, not a fixed flag.
//   - a 2xx answer with NO candidates, or with candidates whose text is empty and which carry neither a
//     functionCall nor an inlineData, answers **200** `{"error":{"message":...}}` (:762-781): the two messages
//     name the source, and the no-candidate one appends the block reason when promptFeedback reports one.
//   - the successful rewrap is `{choices:[{message:{content}}], responseContent}` (:784) where
//     `responseContent` is the candidate's OWN content object, and the text is
//     `content.parts.filter(p => !p.thought).map(p => p.text).join('\n\n')` -- thought parts are dropped.
//
// NOT COVERED, stated rather than silently different:
//   - `gemini.apiVersion` (:679, :1911) is a config value that is not projected into HTTPHandlerOptions, so the
//     pinned default `v1beta` is used. This is the same named gap the claude and deepseek routes carry.
//   - VERTEX FULL MODE mints a service-account JWT and exchanges it for an OAuth token. `pinnedVertexAIAuth`
//     returns a NAMED failure for it instead of fabricating a credential, so the observable is that failure
//     carried through the pinned `400 {"error":true,"message"}` shape. The transport's full-mode URL branch is
//     implemented below for completeness but is unreachable behind that boundary.

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"github.com/cocokoishi/gotavern/internal/outbound"
	"github.com/cocokoishi/gotavern/internal/startup"
)

const (
	pinnedGoogleMimeJSON       = "application/json"
	pinnedGoogleModelsPageSize = 1000
)

// pinnedGoogleAPIName is `useVertexAi ? 'Google Vertex AI' : 'Google AI Studio'` (:456). The name is part of the
// 200-shaped error messages, so it is not cosmetic.
func pinnedGoogleAPIName(useVertexAI bool) string {
	if useVertexAI {
		return "Google Vertex AI"
	}
	return "Google AI Studio"
}

// pinnedGoogleAPIVersion is `getConfigValue('gemini.apiVersion', 'v1beta')` (:679).
func pinnedGoogleAPIVersion() string { return pinnedGeminiDefaultAPIVersion }

// pinnedGoogleRegion is `request.body.vertexai_region || 'us-central1'` (:691, :716).
func pinnedGoogleRegion(body orderedNodeJSON) string {
	if region, exists := body.member("vertexai_region"); exists && pinnedJSTruthy(region) {
		if text, isString := region.stringValue(); isString {
			return text
		}
	}
	return "us-central1"
}

// pinnedGoogleExpressProjectID is `request.body.vertexai_express_project_id`, whose truthiness selects the
// project path AND the global host (:696-698).
func pinnedGoogleExpressProjectID(body orderedNodeJSON) string {
	if project, exists := body.member("vertexai_express_project_id"); exists && pinnedJSTruthy(project) {
		if text, isString := project.stringValue(); isString {
			return text
		}
	}
	return ""
}

// pinnedGoogleErrorMessage builds `{error: {message}}`, the 200-shaped failure the pinned handler sends when a
// successful answer carries no usable candidate (:768, :780).
func pinnedGoogleErrorMessage(message string) orderedNodeJSON {
	inner := nodeObject()
	inner.setMember("message", nodeString(message))
	envelope := nodeObject()
	envelope.setMember("error", inner)
	return envelope
}

// pinnedGoogleAuthFailureBody is `{error:true, message}` for the vertex credential failure (:473).
func pinnedGoogleAuthFailureBody(message string) orderedNodeJSON {
	body := nodeObject()
	body.setMember("error", nodeBool(true))
	body.setMember("message", nodeString(message))
	return body
}

// pinnedGoogleSourceName reports whether this request is one of the two Google sources, and which one. Both
// share one pinned function upstream, so every dispatch point asks this once instead of testing two names.
func pinnedGoogleSourceName(body orderedNodeJSON) (useVertexAI bool, isGoogle bool) {
	switch pinnedChatCompletionSourceName(body) {
	case chatCompletionSourceMakerSuite:
		return false, true
	case chatCompletionSourceVertexAI:
		return true, true
	}
	return false, false
}

// pinnedGooglePlan assembles the outbound request for either Google source.
func pinnedGooglePlan(body orderedNodeJSON, directories startup.UserDirectories, useVertexAI bool) (*outbound.Request, *pinnedChatCompletionFailure) {
	model := pinnedGoogleModel(body)
	stream := pinnedChatCompletionStreams(body)

	var endpointURL string
	headers := map[string]string{"content-type": pinnedGoogleMimeJSON}

	if useVertexAI {
		// `apiUrl = new URL(request.body.reverse_proxy || API_VERTEX_AI)` (:464); the base only feeds proxy mode.
		base := pinnedVertexAIBaseURL()
		if reverseProxy, exists := body.member("reverse_proxy"); exists && pinnedJSTruthy(reverseProxy) {
			if normalized, ok := pinnedJSURLString(reverseProxy); ok {
				base = normalized
			} else {
				return nil, pinnedChatCompletionJSONFailure(http.StatusInternalServerError, pinnedChatCompletionErrorFlag())
			}
		}
		auth, authErr := pinnedVertexAIAuth(body, directories)
		if authErr != nil {
			// :471-474 -- the ONLY source whose credential failure carries a message.
			return nil, pinnedChatCompletionJSONFailure(http.StatusBadRequest, pinnedGoogleAuthFailureBody(authErr.Error()))
		}
		switch auth.AuthType {
		case pinnedVertexAIExpressAuthMode:
			// `const keyParam = authHeader.replace('Bearer ', '')` (:690): a plain first-occurrence replace.
			keyParam := strings.Replace(auth.AuthHeader, "Bearer ", "", 1)
			endpointURL = pinnedVertexAIExpressGenerateURL(model, stream, keyParam, pinnedGoogleExpressProjectID(body), pinnedGoogleRegion(body))
		case pinnedVertexAIFullAuthMode:
			// :702-715 -- the service-account JSON is re-read here, and both rejections are `400 {error:true}`.
			serviceAccount, secretErr := startup.ReadSecretString(directories, pinnedVertexAIServiceAccountSecretKey)
			if secretErr != nil || serviceAccount == "" {
				return nil, pinnedChatCompletionJSONFailure(http.StatusBadRequest, pinnedChatCompletionErrorFlag())
			}
			projectID, projectErr := pinnedVertexAIProjectIDFromServiceAccount(serviceAccount)
			if projectErr != nil {
				return nil, pinnedChatCompletionJSONFailure(http.StatusBadRequest, pinnedChatCompletionErrorFlag())
			}
			endpointURL = pinnedVertexAIServiceAccountGenerateURL(model, stream, projectID, pinnedGoogleRegion(body))
			headers["authorization"] = auth.AuthHeader
		default:
			// proxy mode: the reverse_proxy base verbatim, credential in the header (:726-727).
			endpointURL = pinnedVertexAIProxyGenerateURL(base, model, stream)
			headers["authorization"] = auth.AuthHeader
		}
	} else {
		// `apiUrl = new URL(reverse_proxy || API_MAKERSUITE)`; key = proxy password or the MAKERSUITE secret.
		base := pinnedMakerSuiteBaseURL()
		apiKey := nodeUndefined()
		proxyTruthy := false
		if reverseProxy, exists := body.member("reverse_proxy"); exists && pinnedJSTruthy(reverseProxy) {
			if normalized, ok := pinnedJSURLString(reverseProxy); ok {
				base = normalized
			} else {
				return nil, pinnedChatCompletionJSONFailure(http.StatusInternalServerError, pinnedChatCompletionErrorFlag())
			}
			proxyTruthy = true
			if password, exists := body.member("proxy_password"); exists {
				apiKey = password
			}
		} else {
			secret, err := pinnedReadSecret(directories, pinnedMakerSuiteSecretKey, pinnedSecretID(body))
			if err != nil {
				return nil, pinnedChatCompletionJSONFailure(http.StatusInternalServerError, pinnedChatCompletionErrorFlag())
			}
			apiKey = secret
		}
		if !proxyTruthy && !pinnedJSTruthy(apiKey) {
			// :479-482 -- bare flag, no message.
			return nil, pinnedChatCompletionJSONFailure(http.StatusBadRequest, pinnedChatCompletionErrorFlag())
		}
		keyText := "undefined"
		if pinnedJSTruthy(apiKey) {
			if value, isString := apiKey.stringValue(); isString {
				keyText = value
			} else {
				keyText = pinnedClaudeJSString(apiKey)
			}
		}
		endpointURL = pinnedMakerSuiteGenerateURL(base, pinnedGoogleAPIVersion(), model, stream, keyText)
	}

	payload := pinnedGoogleBody(body, useVertexAI)
	encoded, encodeErr := marshalOrderedNodeJSON(payload)
	if encodeErr != nil {
		return nil, pinnedChatCompletionJSONFailure(http.StatusInternalServerError, pinnedChatCompletionErrorFlag())
	}

	// THE HEADER SET IS `{Content-Type}` PLUS node-fetch's own defaults. No Authorization on makersuite: the key
	// is in the query (:730), which is the single easiest thing to get wrong here.
	headers["accept"] = "*/*"
	headers["accept-encoding"] = "gzip, deflate, br"
	headers["user-agent"] = "node-fetch"
	headers["content-length"] = strconv.Itoa(len(encoded))

	parsedEndpoint, parseErr := url.Parse(endpointURL)
	if parseErr != nil || parsedEndpoint.Host == "" {
		return nil, pinnedChatCompletionJSONFailure(http.StatusInternalServerError, pinnedChatCompletionErrorFlag())
	}
	requestHeaders := pinnedChatCompletionRequestFraming(headers, parsedEndpoint)
	return &outbound.Request{URL: endpointURL, Method: http.MethodPost, Headers: requestHeaders, Body: encoded}, nil
}

// pinnedGoogleResponseContentText is `responseText` (:776): a string content is used as-is, otherwise the parts
// are filtered to drop `thought` ones and joined with a blank line.
func pinnedGoogleResponseContentText(responseContent orderedNodeJSON) string {
	if text, isString := responseContent.stringValue(); isString {
		return text
	}
	parts, exists := responseContent.member("parts")
	if !exists || parts.kind != 'a' {
		return ""
	}
	texts := make([]string, 0, len(parts.array))
	for _, part := range parts.array {
		if _, isThought := part.member("thought"); isThought {
			thought := sdBodyMember(part, "thought")
			if pinnedJSTruthy(thought) {
				continue
			}
		}
		if text, isString := sdBodyMember(part, "text").stringValue(); isString {
			texts = append(texts, text)
		}
	}
	return strings.Join(texts, "\n\n")
}

// serveGoogleChatCompletionResponse is the shared response side for both Google sources.
func serveGoogleChatCompletionResponse(w http.ResponseWriter, request *http.Request, response *outbound.Response, body orderedNodeJSON, useVertexAI bool) {
	apiName := pinnedGoogleAPIName(useVertexAI)
	if pinnedChatCompletionStreams(body) {
		// :740-749 -- the shared forwarder; a forwarding failure answers 500 {error:true} when headers have not
		// been sent, which forwardPinnedChatCompletionStream already handles.
		forwardPinnedChatCompletionStream(w, request, response)
		return
	}
	defer response.Stream.Close()
	providerBody, readErr := io.ReadAll(response.Stream)
	if readErr != nil && !errors.Is(readErr, io.EOF) {
		respondOrderedNodeJSON(w, http.StatusInternalServerError, pinnedChatCompletionErrorFlag())
		return
	}
	if response.Status < 200 || response.Status > 299 {
		// :751-755 -- the provider's parsed body when it parses, otherwise the bare flag, both at 500.
		parsed, parseErr := decodeOrderedNodeJSON(providerBody)
		if parseErr != nil {
			respondOrderedNodeJSON(w, http.StatusInternalServerError, pinnedChatCompletionErrorFlag())
			return
		}
		respondOrderedNodeJSON(w, http.StatusInternalServerError, parsed)
		return
	}
	parsed, parseErr := decodeOrderedNodeJSON(providerBody)
	if parseErr != nil {
		// `await generateResponse.json()` throws inside the pinned try (:759) -> catch at :787-791.
		respondOrderedNodeJSON(w, http.StatusInternalServerError, pinnedChatCompletionErrorFlag())
		return
	}

	candidates := sdBodyMember(parsed, "candidates")
	if candidates.kind != 'a' || len(candidates.array) == 0 {
		message := apiName + " API returned no candidate"
		if blockReason, isString := sdBodyMember(sdBodyMember(parsed, "promptFeedback"), "blockReason").stringValue(); isString && blockReason != "" {
			message += "\nPrompt was blocked due to : " + blockReason
		}
		respondOrderedNodeJSON(w, http.StatusOK, pinnedGoogleErrorMessage(message))
		return
	}
	first := candidates.array[0]
	responseContent, hasContent := first.member("content")
	if !hasContent {
		responseContent = sdBodyMember(first, "output")
	}
	parts := sdBodyMember(responseContent, "parts")
	hasFunctionCall := false
	hasInlineData := false
	if parts.kind == 'a' {
		for _, part := range parts.array {
			if _, exists := part.member("functionCall"); exists && pinnedJSTruthy(sdBodyMember(part, "functionCall")) {
				hasFunctionCall = true
			}
			if _, exists := part.member("inlineData"); exists && pinnedJSTruthy(sdBodyMember(part, "inlineData")) {
				hasInlineData = true
			}
		}
	}
	responseText := pinnedGoogleResponseContentText(responseContent)
	if responseText == "" && !hasFunctionCall && !hasInlineData {
		respondOrderedNodeJSON(w, http.StatusOK, pinnedGoogleErrorMessage(apiName+" Candidate text empty"))
		return
	}
	message := nodeObject()
	message.setMember("content", nodeString(responseText))
	choice := nodeObject()
	choice.setMember("message", message)
	choices := nodeArray()
	choices.array = append(choices.array, choice)
	reply := nodeObject()
	reply.setMember("choices", choices)
	reply.setMember("responseContent", responseContent)
	respondOrderedNodeJSON(w, http.StatusOK, reply)
}

// pinnedGoogleFetchModels is fetchGoogleModels (google-models.js:36-99): every page, `pageSize` forced, then the
// models that support generateContent, each gaining `id` = `name` with the `models/` prefix removed.
func pinnedGoogleFetchModels(ctx context.Context, modelsURL string, hasReverseProxy bool, apiKey string) (orderedNodeJSON, error) {
	parsed, parseErr := url.Parse(modelsURL)
	if parseErr != nil {
		return orderedNodeJSON{}, errGoogleModelsResponse
	}
	query := parsed.Query()
	query.Set("pageSize", strconv.Itoa(pinnedGoogleModelsPageSize))
	query.Del("pageToken")
	parsed.RawQuery = query.Encode()
	requestURL := parsed.String()

	collected := make([]orderedNodeJSON, 0, 8)
	seenTokens := map[string]bool{}
	for page := 1; ; page++ {
		response, fetchErr := searchFetch(ctx, searchRequest{Method: http.MethodGet, URL: requestURL, Headers: map[string]string{}})
		if fetchErr != nil {
			return orderedNodeJSON{}, errGoogleModelsResponse
		}
		if !sdResponseOK(response) {
			return orderedNodeJSON{}, errGoogleModelsHTTP
		}
		pageJSON, decodeErr := decodeOrderedNodeJSON(response.Body)
		if decodeErr != nil {
			return orderedNodeJSON{}, errGoogleModelsResponse
		}
		models := sdBodyMember(pageJSON, "models")
		if models.kind != 'a' {
			return orderedNodeJSON{}, errGoogleModelsResponse
		}
		collected = append(collected, models.array...)

		nextToken := sdBodyMember(pageJSON, "nextPageToken")
		if nextToken.kind == nodeUndefinedKind {
			break
		}
		tokenText, isString := nextToken.stringValue()
		if isString && tokenText == "" {
			break
		}
		if !isString {
			return orderedNodeJSON{}, errGoogleModelsResponse
		}
		if seenTokens[tokenText] {
			return orderedNodeJSON{}, errGoogleModelsResponse
		}
		seenTokens[tokenText] = true
		nextQuery := parsed.Query()
		nextQuery.Set("pageSize", strconv.Itoa(pinnedGoogleModelsPageSize))
		nextQuery.Set("pageToken", tokenText)
		parsed.RawQuery = nextQuery.Encode()
		requestURL = parsed.String()
	}

	supported := nodeArray()
	for _, model := range collected {
		methods := sdBodyMember(model, "supportedGenerationMethods")
		generates := false
		if methods.kind == 'a' {
			for _, method := range methods.array {
				if text, isString := method.stringValue(); isString && text == "generateContent" {
					generates = true
					break
				}
			}
		}
		if !generates {
			continue
		}
		name, isString := sdBodyMember(model, "name").stringValue()
		if !isString {
			return orderedNodeJSON{}, errGoogleModelsResponse
		}
		entry := model
		entry.setMember("id", nodeString(strings.Replace(name, "models/", "", 1)))
		supported.array = append(supported.array, entry)
	}
	return supported, nil
}

var (
	errGoogleModelsHTTP     = errors.New("google models endpoint failed")
	errGoogleModelsResponse = errors.New("google models response invalid")
)

// serveMakerSuiteChatCompletionStatus is the MAKERSUITE-only status arm (:1908-1933). It is unlike every other
// arm in the matrix: it builds its own URL (dropping `?key=` when a reverse_proxy supplies the credential),
// answers `{data: models}` where `models` is the FILTERED, id-annotated list, and every failure path answers
// 200 `{error:true, bypass:true, data:{data:[]}}` except the missing-credential one, which is `400 {error:true}`.
//
// VERTEXAI has NO arm and must keep falling through to the shared `400 {error:true}`.
func (runtime *accountRuntime) serveMakerSuiteChatCompletionStatus(w http.ResponseWriter, request *http.Request, body orderedNodeJSON, directories startup.UserDirectories) {
	apiKey := nodeUndefined()
	proxyTruthy := false
	base := pinnedMakerSuiteBaseURL()
	if reverseProxy, exists := body.member("reverse_proxy"); exists && pinnedJSTruthy(reverseProxy) {
		if normalized, ok := pinnedJSURLString(reverseProxy); ok {
			base = normalized
		} else {
			searchGoogleStatusFailure(w)
			return
		}
		proxyTruthy = true
		if password, exists := body.member("proxy_password"); exists {
			apiKey = password
		}
	} else {
		secret, err := pinnedReadSecret(directories, pinnedMakerSuiteSecretKey, pinnedSecretID(body))
		if err != nil {
			searchGoogleStatusFailure(w)
			return
		}
		apiKey = secret
	}
	if !pinnedJSTruthy(apiKey) && !proxyTruthy {
		// :1916-1919 -- 400 with the bare flag.
		respondOrderedNodeJSON(w, http.StatusBadRequest, pinnedChatCompletionErrorFlag())
		return
	}
	keyText := ""
	if pinnedJSTruthy(apiKey) {
		if value, isString := apiKey.stringValue(); isString {
			keyText = value
		} else {
			keyText = pinnedClaudeJSString(apiKey)
		}
	}
	modelsURL := pinnedMakerSuiteStatusURL(base, pinnedGoogleAPIVersion(), keyText, proxyTruthy)
	models, fetchErr := pinnedGoogleFetchModels(request.Context(), modelsURL, proxyTruthy, keyText)
	if fetchErr != nil {
		searchGoogleStatusFailure(w)
		return
	}
	envelope := nodeObject()
	envelope.setMember("data", models)
	respondOrderedNodeJSON(w, http.StatusOK, envelope)
}

// searchGoogleStatusFailure is the pinned 200 `{error:true, bypass:true, data:{data:[]}}` (:1928, :1932).
func searchGoogleStatusFailure(w http.ResponseWriter) {
	envelope := nodeObject()
	envelope.setMember("error", nodeBool(true))
	envelope.setMember("bypass", nodeBool(true))
	data := nodeObject()
	data.setMember("data", nodeArray())
	envelope.setMember("data", data)
	searchJSON(w, envelope)
}

// pinnedMakerSuitePlan and pinnedVertexAIPlan are the TWO registry rows the Google transport needs, one per
// credential mode. They are separate named functions rather than one function with a captured bool because
// the registry row must name a real function: a nil or half-bound callback would let a source lose its plan
// without a compile error. Both call the one pinned function.
func pinnedMakerSuitePlan(request chatCompletionRequest) (*outbound.Request, *pinnedChatCompletionFailure) {
	return pinnedGooglePlan(request.body, request.directories, false)
}

func pinnedVertexAIPlan(request chatCompletionRequest) (*outbound.Request, *pinnedChatCompletionFailure) {
	return pinnedGooglePlan(request.body, request.directories, true)
}

// serveMakerSuiteChatCompletionResponse and serveVertexAIChatCompletionResponse are the two response rows,
// for the same reason: the shared Google mapping branches on the credential mode, and the mode belongs to the
// ROW, not to a runtime test of the request body.
func serveMakerSuiteChatCompletionResponse(w http.ResponseWriter, request *http.Request, response *outbound.Response, body orderedNodeJSON) {
	serveGoogleChatCompletionResponse(w, request, response, body, false)
}

func serveVertexAIChatCompletionResponse(w http.ResponseWriter, request *http.Request, response *outbound.Response, body orderedNodeJSON) {
	serveGoogleChatCompletionResponse(w, request, response, body, true)
}
