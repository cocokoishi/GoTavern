package server

// Pinned /api/search/* routes, from src/endpoints/search.js (mounted at /api/search by
// src/server-startup.js:175):
//
//	POST /api/search/serpapi     search.js:95
//	POST /api/search/transcript  search.js:128
//	POST /api/search/searxng     search.js:165
//	POST /api/search/tavily      search.js:219
//	POST /api/search/koboldcpp   search.js:268
//	POST /api/search/serper      search.js:304
//	POST /api/search/zai         search.js:346
//
// `/api/search/visit` (search.js:392) is deliberately NOT registered. It fetches an arbitrary
// caller-supplied URL through `getUntrustedRequestAgent()`, the private-request-filter SSRF agent
// (DNS-resolved private-address blocking, per-hop redirect validation, rebinding pinning).
// GoTavern has no shared private-address transport policy yet, so a route that fetched without it
// would be strictly LESS safe than pinned, and a route-local dial policy would be a second
// outbound policy. The fixture's `knownDifferences` records this decision; the route stays
// `not implemented` rather than faked.
//
// Evidence: tools/probe-search.mjs drives the pinned server with node-fetch replaced by a
// controlled peer (tools/lib/pinned-outbound.mjs), records
// tests/oracle/sillytavern-1.19.0-search.json, and internal/server/search_test.go replays it.
// Each observation compares the HTTP response (status/content-type/content-length/ETag/body) and
// every outbound request (url, method, explicit headers, body); the node-fetch wire defaults are
// asserted separately from `nodeFetchWireDefaults`, whose values are the ones the committed SD
// wire capture observed on a real peer.
//
// This file reuses the domain-agnostic pinned helpers introduced with the SD domain
// (sdUser/sdRequestBody/sdReadSecret/sdNodeFetchHeaders/orderedNodeJSON machinery) rather than
// duplicating them. The one thing it cannot reuse is sdFetch: `visitHeaders` sets `Connection`
// explicitly, and sdFetch always appends a transport `Connection`, which would emit the header
// twice. searchFetch below keeps the same node-fetch semantics with that rule fixed.

import (
	"context"
	"errors"
	"html"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"

	"github.com/cocokoishi/gotavern/internal/outbound"
	"github.com/cocokoishi/gotavern/internal/startup"
)

// Search-provider seams. Every default is the pinned literal and is asserted by
// TestSearchSeamDefaults.
const (
	searchSerpapiDefaultURL = "https://serpapi.com"
	searchYouTubeDefaultURL = "https://www.youtube.com"
	searchTavilyDefaultURL  = "https://api.tavily.com"
	searchSerperDefaultURL  = "https://google.serper.dev"
	searchZaiDefaultURL     = "https://api.z.ai"
)

func searchSerpapiURL() string {
	return sdSeamURL("GOTAVERN_SEARCH_SERPAPI_URL", searchSerpapiDefaultURL)
}
func searchYouTubeURL() string {
	return sdSeamURL("GOTAVERN_SEARCH_YOUTUBE_URL", searchYouTubeDefaultURL)
}
func searchTavilyURL() string { return sdSeamURL("GOTAVERN_SEARCH_TAVILY_URL", searchTavilyDefaultURL) }
func searchSerperURL() string { return sdSeamURL("GOTAVERN_SEARCH_SERPER_URL", searchSerperDefaultURL) }
func searchZaiURL() string    { return sdSeamURL("GOTAVERN_SEARCH_ZAI_URL", searchZaiDefaultURL) }

func init() {
	domainRouteRegistrars = append(domainRouteRegistrars, registerSearchRoutes)
}

func registerSearchRoutes(mux *http.ServeMux, accounts *accountRuntime, notFoundPage []byte, options HTTPHandlerOptions) {
	post := func(route string, handler func(http.ResponseWriter, *http.Request)) {
		mux.HandleFunc(route, func(w http.ResponseWriter, r *http.Request) {
			if r.Method != http.MethodPost {
				serveStatic(w, r, notFoundPage, options)
				return
			}
			handler(w, r)
		})
	}
	post("/api/search/serpapi", accounts.serveSearchSerpapi)
	post("/api/search/transcript", accounts.serveSearchTranscript)
	post("/api/search/searxng", accounts.serveSearchSearxng)
	post("/api/search/tavily", accounts.serveSearchTavily)
	post("/api/search/koboldcpp", accounts.serveSearchKoboldcpp)
	post("/api/search/serper", accounts.serveSearchSerper)
	post("/api/search/zai", accounts.serveSearchZai)
}

// ---- shared pinned helpers ---------------------------------------------------------------

// searchStatus is Express `res.sendStatus(status)`; the SD domain already reproduces its exact
// body/ETag/framing rules.
func searchStatus(w http.ResponseWriter, status int) { serveSDStatus(w, status) }

// searchSendString is Express `res.send(string)`: text/html with a charset, plus ETag.
func searchSendString(w http.ResponseWriter, value string) {
	respondText(w, http.StatusOK, "text/html; charset=utf-8", value)
}

// searchUpstreamError is `res.status(500).send(text)` from an upstream response body.
func searchUpstreamError(w http.ResponseWriter, body []byte) {
	respondText(w, http.StatusInternalServerError, "text/html; charset=utf-8", string(body))
}

// searchJSON is `res.json(data)` for a value decoded from an upstream JSON body.
func searchJSON(w http.ResponseWriter, value orderedNodeJSON) {
	respondOrderedNodeJSON(w, http.StatusOK, value)
}

// searchJSString is JavaScript `String(value)` for a decoded body member.
func searchJSString(value orderedNodeJSON) string {
	text, err := pinnedJSStringValue(value)
	if err != nil {
		return ""
	}
	return text
}

// searchRequest is one outbound request in the form the pinned route writes it.
type searchRequest struct {
	Method  string
	URL     string
	Headers map[string]string
	Body    []byte
}

// searchFetch reproduces node-fetch 3.3.2 for these routes: explicit headers lowercased and
// sorted, node-fetch defaults added when absent, Content-Length for a body, redirects followed
// with node-fetch's method/body rules, and a transport `Connection: close` ONLY when the route
// did not set `Connection` itself (visitHeaders does set it).
func searchFetch(ctx context.Context, request searchRequest) (*outbound.Response, error) {
	current := request
	currentURL, err := url.Parse(current.URL)
	if err != nil || currentURL.Host == "" {
		return nil, errors.New("invalid upstream url")
	}
	for redirects := 0; ; redirects++ {
		headers := searchNodeFetchHeaders(current.Headers, current.Body)
		headers = append(headers, outbound.Header{Name: "Host", Value: sdHostHeader(currentURL)})
		if !searchHasHeader(current.Headers, "connection") {
			headers = append(headers, outbound.Header{Name: "Connection", Value: "close"})
		}
		response, sendErr := outbound.Send(ctx, outbound.Request{
			URL:     currentURL.String(),
			Method:  current.Method,
			Headers: headers,
			Body:    current.Body,
		}, 0)
		if sendErr != nil {
			return nil, sendErr
		}
		if !sdIsRedirectStatus(response.Status) {
			return response, nil
		}
		location := response.Header("Location")
		if location == "" {
			return response, nil
		}
		nextURL, locationErr := currentURL.Parse(location)
		if locationErr != nil {
			return nil, locationErr
		}
		if redirects >= sdMaxRedirects {
			return nil, errors.New("maximum redirect reached")
		}
		nextHeaders := map[string]string{}
		for name, value := range current.Headers {
			nextHeaders[name] = value
		}
		if !sdDomainOrSubdomain(currentURL, nextURL) || !strings.EqualFold(currentURL.Scheme, nextURL.Scheme) {
			for _, name := range []string{"authorization", "www-authenticate", "cookie", "cookie2"} {
				delete(nextHeaders, name)
			}
		}
		method := current.Method
		body := current.Body
		if response.Status == http.StatusSeeOther ||
			((response.Status == http.StatusMovedPermanently || response.Status == http.StatusFound) && method == http.MethodPost) {
			method = http.MethodGet
			body = nil
		}
		currentURL = nextURL
		current.Method = method
		current.Body = body
		current.Headers = nextHeaders
	}
}

func searchNodeFetchHeaders(explicit map[string]string, body []byte) []outbound.Header {
	values := map[string]string{
		"accept":          sdNodeFetchAccept,
		"accept-encoding": sdNodeFetchAcceptEncoding,
		"user-agent":      sdNodeFetchUserAgent,
	}
	if body != nil {
		values["content-length"] = strconv.Itoa(len(body))
	}
	for name, value := range explicit {
		values[strings.ToLower(name)] = value
	}
	names := make([]string, 0, len(values))
	for name := range values {
		names = append(names, name)
	}
	sort.Strings(names)
	headers := make([]outbound.Header, 0, len(names))
	for _, name := range names {
		headers = append(headers, outbound.Header{Name: name, Value: values[name]})
	}
	return headers
}

func searchHasHeader(headers map[string]string, name string) bool {
	for candidate := range headers {
		if strings.EqualFold(candidate, name) {
			return true
		}
	}
	return false
}

// searchReadSecret is `readSecret(directories, key, id)` with the optional secret id these routes
// pass through (setAdditionalHeaders forwards `request.body.secret_id`).
func searchReadSecret(directories startup.UserDirectories, key string, secretID orderedNodeJSON) (string, error) {
	value, err := pinnedReadSecret(directories, key, secretID)
	if err != nil {
		return "", err
	}
	if !pinnedJSTruthy(value) {
		return "", nil
	}
	return pinnedJSStringValue(value)
}

// searchSecretIDNode is the `request.body.secret_id` argument: a missing or null member is
// `null`, which readSecret treats as "active entry".
func searchSecretIDNode(body orderedNodeJSON) orderedNodeJSON {
	return sdBodyMember(body, "secret_id")
}

// searchURLValue is `new URL(value)`.
func searchURLValue(value orderedNodeJSON) (*url.URL, bool) {
	text := searchJSString(value)
	parsed, err := url.Parse(text)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return nil, false
	}
	return parsed, true
}

// searchURLSearchParams reproduces `new URLSearchParams().append(...).toString()`: form encoding
// where a space becomes '+', alphanumerics and *-._ stay literal, everything else is a UTF-8
// percent escape.
func searchURLSearchParams(pairs [][2]string) string {
	parts := make([]string, 0, len(pairs))
	for _, pair := range pairs {
		parts = append(parts, searchFormEncode(pair[0])+"="+searchFormEncode(pair[1]))
	}
	return strings.Join(parts, "&")
}

func searchFormEncode(value string) string {
	var builder strings.Builder
	for _, iterator := range []byte(value) {
		if iterator == ' ' {
			builder.WriteByte('+')
			continue
		}
		if (iterator >= 'a' && iterator <= 'z') || (iterator >= 'A' && iterator <= 'Z') ||
			(iterator >= '0' && iterator <= '9') || strings.IndexByte("*-._", iterator) >= 0 {
			builder.WriteByte(iterator)
			continue
		}
		builder.WriteByte('%')
		builder.WriteString(strings.ToUpper(strconv.FormatUint(uint64(iterator), 16)))
	}
	return builder.String()
}

// searchTrimV1 reproduces `String(value ?? ”).replace(/\/$/, ”).replace(/\/v1$/, ”)`.
func searchTrimV1(value orderedNodeJSON) string {
	text := searchJSString(value)
	text = strings.TrimSuffix(text, "/")
	text = strings.TrimSuffix(text, "/v1")
	return text
}

// searchDecodeEntities is html-entities' decode(); the transcript text is decoded twice, so this
// is applied twice by the caller.
func searchDecodeEntities(value string) string { return html.UnescapeString(value) }

// searchVisitHeaders is the pinned `visitHeaders` object used by /searxng (and by /visit, which is
// not implemented). The keys are the observable contract; node-fetch sends them lowercased and
// sorted.
func searchVisitHeaders() map[string]string {
	return map[string]string{
		"accept":          "text/html",
		"user-agent":      searchVisitUserAgent,
		"accept-language": "en-US,en;q=0.5",
		"accept-encoding": "gzip, deflate, br",
		"connection":      "keep-alive",
		"cache-control":   "no-cache",
		"pragma":          "no-cache",
		"te":              "trailers",
		"dnt":             "1",
		"sec-fetch-dest":  "document",
		"sec-fetch-mode":  "navigate",
		"sec-fetch-site":  "none",
		"sec-fetch-user":  "?1",
	}
}

// searchVisitUserAgent is search.js:16.
const searchVisitUserAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36"

// searchAdditionalHeaders reproduces setAdditionalHeadersByType (src/additional-headers.js) for the
// koboldcpp route: the api_type selects a secret-backed header set. `requestOverrides` is applied by the
// CALLER, because the pinned `Object.assign` happens after the caller's own Content-Type and therefore wins
// over it -- see request_overrides.go and pinnedApplyRequestOverrides.
func searchAdditionalHeaders(body orderedNodeJSON, directories startup.UserDirectories) (map[string]string, error) {
	apiType := searchJSString(sdBodyMember(body, "api_type"))
	secretID := searchSecretIDNode(body)
	read := func(key string) (string, error) {
		return searchReadSecret(directories, key, secretID)
	}
	authorization := func(key string) (map[string]string, error) {
		value, err := read(key)
		if err != nil || value == "" {
			return nil, err
		}
		return map[string]string{"authorization": "Bearer " + value}, nil
	}
	switch apiType {
	case "mancer":
		value, err := read("api_key_mancer")
		if err != nil || value == "" {
			return nil, err
		}
		return map[string]string{"x-api-key": value, "authorization": "Bearer " + value}, nil
	case "vllm":
		return authorization("api_key_vllm")
	case "aphrodite":
		value, err := read("api_key_aphrodite")
		if err != nil || value == "" {
			return nil, err
		}
		return map[string]string{"x-api-key": value, "authorization": "Bearer " + value}, nil
	case "tabby":
		value, err := read("api_key_tabby")
		if err != nil || value == "" {
			return nil, err
		}
		return map[string]string{"x-api-key": value, "authorization": "Bearer " + value}, nil
	case "togetherai":
		return authorization("api_key_togetherai")
	case "ooba":
		return authorization("api_key_ooba")
	case "infermaticai":
		return authorization("api_key_infermaticai")
	case "dreamgen":
		return authorization("api_key_dreamgen")
	case "openrouter":
		headers, err := authorization("api_key_openrouter")
		if err != nil {
			return nil, err
		}
		if headers == nil {
			headers = map[string]string{}
		}
		headers["http-referer"] = "https://sillytavern.app"
		headers["x-title"] = "SillyTavern"
		return headers, nil
	case "koboldcpp":
		return authorization("api_key_koboldcpp")
	case "llamacpp":
		return authorization("api_key_llamacpp")
	case "featherless":
		headers, err := authorization("api_key_featherless")
		if err != nil {
			return nil, err
		}
		if headers == nil {
			headers = map[string]string{}
		}
		headers["http-referer"] = "https://sillytavern.app"
		headers["x-title"] = "SillyTavern"
		return headers, nil
	case "huggingface":
		return authorization("api_key_huggingface")
	case "generic":
		return authorization("api_key_generic")
	default:
		// No getter for this type (including ollama) means an empty header set.
		return map[string]string{}, nil
	}
}
