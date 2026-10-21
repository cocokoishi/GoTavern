package server

// Handlers for the pinned /api/search routes. See search.go for the scope, evidence and the
// deliberate absence of /api/search/visit.

import (
	"context"
	"net/http"
	"regexp"
	"strings"

	"github.com/cocokoishi/gotavern/internal/startup"
)

// serveSearchSerpapi is search.js:95.
func (runtime *accountRuntime) serveSearchSerpapi(w http.ResponseWriter, request *http.Request) {
	_, directories, ok := runtime.sdUser(w, request)
	if !ok {
		return
	}
	body, ok := runtime.sdRequestBody(w, request)
	if !ok {
		return
	}
	key, err := sdReadSecret(directories, "api_key_serpapi")
	if err != nil {
		searchStatus(w, http.StatusInternalServerError)
		return
	}
	if key == "" {
		searchStatus(w, http.StatusBadRequest)
		return
	}
	query, err := pinnedJSStringValue(sdBodyMember(body, "query"))
	if err != nil {
		searchStatus(w, http.StatusInternalServerError)
		return
	}
	target := searchSerpapiURL() + "/search.json?q=" + sdEncodeURIComponent(query) + "&api_key=" + key
	response, err := searchFetch(request.Context(), searchRequest{Method: http.MethodGet, URL: target})
	if err != nil {
		searchStatus(w, http.StatusInternalServerError)
		return
	}
	if !sdResponseOK(response) {
		searchUpstreamError(w, response.Body)
		return
	}
	data, ok := sdReadJSON(response)
	if !ok {
		searchStatus(w, http.StatusInternalServerError)
		return
	}
	searchJSON(w, data)
}

// serveSearchTranscript is search.js:128. The video page is fetched and its text read WITHOUT an
// ok check, exactly as pinned; extraction failures are either reported as an empty transcript
// (json=true) or rethrown into the route's 500 catch.
func (runtime *accountRuntime) serveSearchTranscript(w http.ResponseWriter, request *http.Request) {
	_, directories, ok := runtime.sdUser(w, request)
	if !ok {
		return
	}
	body, ok := runtime.sdRequestBody(w, request)
	if !ok {
		return
	}
	_ = directories
	id := sdBodyMember(body, "id")
	lang := sdBodyMember(body, "lang")
	jsonOutput := pinnedJSTruthy(sdBodyMember(body, "json"))
	if !pinnedJSTruthy(id) {
		searchStatus(w, http.StatusBadRequest)
		return
	}
	idText, err := pinnedJSStringValue(id)
	if err != nil {
		searchStatus(w, http.StatusInternalServerError)
		return
	}
	pageHeaders := map[string]string{"user-agent": searchVisitUserAgent}
	if pinnedJSTruthy(lang) {
		langText, langErr := pinnedJSStringValue(lang)
		if langErr != nil {
			searchStatus(w, http.StatusInternalServerError)
			return
		}
		pageHeaders["accept-language"] = langText
	}
	response, err := searchFetch(request.Context(), searchRequest{
		Method: http.MethodGet, URL: searchYouTubeURL() + "/watch?v=" + idText, Headers: pageHeaders,
	})
	if err != nil {
		searchStatus(w, http.StatusInternalServerError)
		return
	}
	pageBody := string(response.Body)
	transcript, extracted := searchExtractTranscript(request.Context(), pageBody, lang)
	if !extracted {
		if jsonOutput {
			result := nodeObject()
			result.setMember("html", nodeString(pageBody))
			result.setMember("transcript", nodeString(""))
			searchJSON(w, result)
			return
		}
		searchStatus(w, http.StatusInternalServerError)
		return
	}
	if jsonOutput {
		result := nodeObject()
		result.setMember("transcript", nodeString(transcript))
		result.setMember("html", nodeString(pageBody))
		searchJSON(w, result)
		return
	}
	searchSendString(w, transcript)
}

var searchTranscriptLinePattern = regexp.MustCompile(`<text start="([^"]*)" dur="([^"]*)">([^<]*)</text>`)

// searchExtractTranscript reproduces extractTranscript (search.js:36). It reports false for every
// throw the pinned helper performs; the caller decides between the json and 500 branches.
func searchExtractTranscript(ctx context.Context, pageBody string, lang orderedNodeJSON) (string, bool) {
	split := strings.Split(pageBody, `"captions":`)
	if len(split) <= 1 {
		// The pinned helper distinguishes three messages here, but all three reach the same
		// caller branch, so only the branch is observable.
		return "", false
	}
	payload := strings.Split(split[1], `,"videoDetails`)[0]
	payload = strings.Replace(payload, "\n", "", 1)
	parsed, err := decodeOrderedNodeJSON([]byte(payload))
	if err != nil {
		// `captions` becomes undefined and the route reports "Transcript disabled".
		return "", false
	}
	captions, ok := sdMemberOf(parsed, "playerCaptionsTracklistRenderer")
	if !ok || !pinnedJSTruthy(captions) || captions.kind != 'o' {
		return "", false
	}
	tracks, exists := captions.member("captionTracks")
	if !exists || tracks.kind != 'a' {
		return "", false
	}
	var chosen orderedNodeJSON
	if pinnedJSTruthy(lang) {
		langText, langErr := pinnedJSStringValue(lang)
		if langErr != nil {
			return "", false
		}
		found := false
		for _, track := range tracks.array {
			code, codeOK := sdMemberOf(track, "languageCode")
			if !codeOK {
				return "", false
			}
			if text, isString := code.stringValue(); isString && text == langText {
				chosen, found = track, true
				break
			}
		}
		if !found {
			return "", false
		}
	} else {
		if len(tracks.array) == 0 {
			return "", false
		}
		chosen = tracks.array[0]
	}
	baseURL, ok := sdMemberOf(chosen, "baseUrl")
	if !ok {
		return "", false
	}
	baseURLText, isString := baseURL.stringValue()
	if !isString {
		return "", false
	}
	captionHeaders := map[string]string{"user-agent": searchVisitUserAgent}
	if pinnedJSTruthy(lang) {
		langText, langErr := pinnedJSStringValue(lang)
		if langErr != nil {
			return "", false
		}
		captionHeaders["accept-language"] = langText
	}
	response, err := searchFetch(ctx, searchRequest{Method: http.MethodGet, URL: baseURLText, Headers: captionHeaders})
	if err != nil || !sdResponseOK(response) {
		return "", false
	}
	matches := searchTranscriptLinePattern.FindAllStringSubmatch(string(response.Body), -1)
	lines := make([]string, 0, len(matches))
	for _, match := range matches {
		lines = append(lines, searchDecodeEntities(searchDecodeEntities(match[3])))
	}
	return strings.Join(lines, " "), true
}

// serveSearchSearxng is search.js:165: visit the main page, optionally warm the client CSS, then
// fetch /search with form-encoded query parameters and return the page text.
func (runtime *accountRuntime) serveSearchSearxng(w http.ResponseWriter, request *http.Request) {
	_, _, ok := runtime.sdUser(w, request)
	if !ok {
		return
	}
	body, ok := runtime.sdRequestBody(w, request)
	if !ok {
		return
	}
	baseValue := sdBodyMember(body, "baseUrl")
	queryValue := sdBodyMember(body, "query")
	if !pinnedJSTruthy(baseValue) || !pinnedJSTruthy(queryValue) {
		searchStatus(w, http.StatusBadRequest)
		return
	}
	base, ok := searchURLValue(baseValue)
	if !ok {
		searchStatus(w, http.StatusInternalServerError)
		return
	}
	response, err := searchFetch(request.Context(), searchRequest{
		Method: http.MethodGet, URL: base.String(), Headers: searchVisitHeaders(),
	})
	if err != nil || !sdResponseOK(response) {
		searchStatus(w, http.StatusInternalServerError)
		return
	}
	mainPage := string(response.Body)
	if match := searxngClientHrefPattern.FindStringSubmatch(mainPage); match != nil {
		if clientURL, clientErr := base.Parse(match[1]); clientErr == nil {
			// The pinned route awaits this request but never inspects it.
			_, _ = searchFetch(request.Context(), searchRequest{
				Method: http.MethodGet, URL: clientURL.String(), Headers: searchVisitHeaders(),
			})
		}
	}
	base.RawQuery = ""
	base.Fragment = ""
	base.Path = "/search"
	params := [][2]string{{"q", searchJSString(queryValue)}}
	if preferences := sdBodyMember(body, "preferences"); pinnedJSTruthy(preferences) {
		params = append(params, [2]string{"preferences", searchJSString(preferences)})
	}
	if categories := sdBodyMember(body, "categories"); pinnedJSTruthy(categories) {
		params = append(params, [2]string{"categories", searchJSString(categories)})
	}
	searchURL := base.String() + "?" + searchURLSearchParams(params)
	searchResponse, err := searchFetch(request.Context(), searchRequest{
		Method: http.MethodGet, URL: searchURL, Headers: searchVisitHeaders(),
	})
	if err != nil || !sdResponseOK(searchResponse) {
		searchStatus(w, http.StatusInternalServerError)
		return
	}
	searchSendString(w, string(searchResponse.Body))
}

var searxngClientHrefPattern = regexp.MustCompile(`href="(/client.+\.css)"`)

// serveSearchTavily is search.js:219: a fixed request body with the key inside it.
func (runtime *accountRuntime) serveSearchTavily(w http.ResponseWriter, request *http.Request) {
	_, directories, ok := runtime.sdUser(w, request)
	if !ok {
		return
	}
	body, ok := runtime.sdRequestBody(w, request)
	if !ok {
		return
	}
	key, err := sdReadSecret(directories, "api_key_tavily")
	if err != nil {
		searchStatus(w, http.StatusInternalServerError)
		return
	}
	if key == "" {
		searchStatus(w, http.StatusBadRequest)
		return
	}
	payload := nodeObject()
	if query := sdBodyMember(body, "query"); !query.isUndefined() {
		payload.setMember("query", query)
	}
	payload.setMember("api_key", nodeString(key))
	payload.setMember("search_depth", nodeString("basic"))
	payload.setMember("topic", nodeString("general"))
	payload.setMember("include_answer", nodeBool(true))
	payload.setMember("include_raw_content", nodeBool(false))
	payload.setMember("include_images", nodeBool(pinnedJSTruthy(sdBodyMember(body, "include_images"))))
	payload.setMember("include_image_descriptions", nodeBool(false))
	payload.setMember("include_domains", nodeArray())
	payload.setMember("max_results", nodeNumber(10))
	encoded, err := marshalOrderedNodeJSON(payload)
	if err != nil {
		searchStatus(w, http.StatusInternalServerError)
		return
	}
	response, err := searchFetch(request.Context(), searchRequest{
		Method:  http.MethodPost,
		URL:     searchTavilyURL() + "/search",
		Headers: map[string]string{"content-type": "application/json"},
		Body:    encoded,
	})
	if err != nil {
		searchStatus(w, http.StatusInternalServerError)
		return
	}
	if !sdResponseOK(response) {
		searchUpstreamError(w, response.Body)
		return
	}
	data, ok := sdReadJSON(response)
	if !ok {
		searchStatus(w, http.StatusInternalServerError)
		return
	}
	searchJSON(w, data)
}

// serveSearchKoboldcpp is search.js:268: the base URL comes from the request body, trimmed with
// trimV1, and setAdditionalHeaders adds secret-backed headers selected by api_type.
func (runtime *accountRuntime) serveSearchKoboldcpp(w http.ResponseWriter, request *http.Request) {
	_, directories, ok := runtime.sdUser(w, request)
	if !ok {
		return
	}
	body, ok := runtime.sdRequestBody(w, request)
	if !ok {
		return
	}
	urlValue := sdBodyMember(body, "url")
	if !pinnedJSTruthy(urlValue) {
		searchStatus(w, http.StatusBadRequest)
		return
	}
	baseURL := searchTrimV1(urlValue)
	headers, err := searchAdditionalHeaders(body, directories)
	if err != nil {
		searchStatus(w, http.StatusInternalServerError)
		return
	}
	payload := nodeObject()
	if query := sdBodyMember(body, "query"); !query.isUndefined() {
		payload.setMember("q", query)
	}
	encoded, err := marshalOrderedNodeJSON(payload)
	if err != nil {
		searchStatus(w, http.StatusInternalServerError)
		return
	}
	response, err := searchFetch(request.Context(), searchRequest{
		Method:  http.MethodPost,
		URL:     baseURL + "/api/extra/websearch",
		Headers: headers,
		Body:    encoded,
	})
	if err != nil {
		searchStatus(w, http.StatusInternalServerError)
		return
	}
	if !sdResponseOK(response) {
		searchUpstreamError(w, response.Body)
		return
	}
	data, ok := sdReadJSON(response)
	if !ok {
		searchStatus(w, http.StatusInternalServerError)
		return
	}
	searchJSON(w, data)
}

// serveSearchSerper is search.js:304: the key travels in X-API-KEY and the path depends on the
// images flag.
func (runtime *accountRuntime) serveSearchSerper(w http.ResponseWriter, request *http.Request) {
	_, directories, ok := runtime.sdUser(w, request)
	if !ok {
		return
	}
	body, ok := runtime.sdRequestBody(w, request)
	if !ok {
		return
	}
	key, err := sdReadSecret(directories, "api_key_serper")
	if err != nil {
		searchStatus(w, http.StatusInternalServerError)
		return
	}
	if key == "" {
		searchStatus(w, http.StatusBadRequest)
		return
	}
	path := "/search"
	if pinnedJSTruthy(sdBodyMember(body, "images")) {
		path = "/images"
	}
	payload := nodeObject()
	if query := sdBodyMember(body, "query"); !query.isUndefined() {
		payload.setMember("q", query)
	}
	encoded, err := marshalOrderedNodeJSON(payload)
	if err != nil {
		searchStatus(w, http.StatusInternalServerError)
		return
	}
	response, err := searchFetch(request.Context(), searchRequest{
		Method:  http.MethodPost,
		URL:     searchSerperURL() + path,
		Headers: map[string]string{"x-api-key": key, "content-type": "application/json"},
		Body:    encoded,
	})
	if err != nil {
		searchStatus(w, http.StatusInternalServerError)
		return
	}
	if !sdResponseOK(response) {
		searchUpstreamError(w, response.Body)
		return
	}
	data, ok := sdReadJSON(response)
	if !ok {
		searchStatus(w, http.StatusInternalServerError)
		return
	}
	searchJSON(w, data)
}

// serveSearchZai is search.js:346.
func (runtime *accountRuntime) serveSearchZai(w http.ResponseWriter, request *http.Request) {
	_, directories, ok := runtime.sdUser(w, request)
	if !ok {
		return
	}
	body, ok := runtime.sdRequestBody(w, request)
	if !ok {
		return
	}
	key, err := sdReadSecret(directories, "api_key_zai")
	if err != nil {
		searchStatus(w, http.StatusInternalServerError)
		return
	}
	if key == "" {
		searchStatus(w, http.StatusBadRequest)
		return
	}
	query := sdBodyMember(body, "query")
	if !pinnedJSTruthy(query) {
		searchStatus(w, http.StatusBadRequest)
		return
	}
	payload := nodeObject()
	payload.setMember("search_engine", nodeString("search-prime"))
	payload.setMember("search_query", query)
	encoded, err := marshalOrderedNodeJSON(payload)
	if err != nil {
		searchStatus(w, http.StatusInternalServerError)
		return
	}
	response, err := searchFetch(request.Context(), searchRequest{
		Method:  http.MethodPost,
		URL:     searchZaiURL() + "/api/paas/v4/web_search",
		Headers: map[string]string{"content-type": "application/json", "authorization": "Bearer " + key},
		Body:    encoded,
	})
	if err != nil {
		searchStatus(w, http.StatusInternalServerError)
		return
	}
	if !sdResponseOK(response) {
		searchUpstreamError(w, response.Body)
		return
	}
	data, ok := sdReadJSON(response)
	if !ok {
		searchStatus(w, http.StatusInternalServerError)
		return
	}
	searchJSON(w, data)
}

var _ = startup.UserDirectories{}
