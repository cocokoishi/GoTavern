package server

// Pinned non-generate /api/sd routes, from src/endpoints/stable-diffusion.js, mounted by
// src/server-startup.js:169. This domain owns the 34 routes that are NOT `*/generate*`:
//
//	root        ping (31), upscalers (54), vaes (108), samplers (140), schedulers (166),
//	            models (192), get-model (218), set-model (238), sd-next/upscalers (352)
//	comfy       ping (387), samplers (403), models (421), schedulers (449), vaes (467),
//	            workflows (485), workflow (495), save-workflow (509), delete-workflow (521),
//	            rename-workflow (534)
//	comfyrunpod ping (637)
//	sdcpp       ping (834), models (850)
//	drawthings  ping (919), get-model (939), get-upscaler (958)
//	model lists together/models (739), chutes/models (1310), electronhub/models (1184),
//	            electronhub/sizes (1282), nanogpt/models (1391), aimlapi/models (1796),
//	            workersai/models (2062), pollinations/models (1013), falai/models (1593)
//
// The 19 `*/generate*` routes ARE IMPLEMENTED, and the sentence that stood here ("out of scope and remain
// `not implemented`") was WRONG -- corrected 2026-10-29 by reading the registrations, which are spread across
// `sd_generate.go`, `sd_generate_wave2.go`, `sd_generate_wave5.go`, `sd_generate_comfy.go`, `sd_zai.go` and
// `sd.go:108,132,136,145,146`. `docs/compat-matrix.md` already recorded all 19 as implemented, so the code and
// the ledger agreed and only this header disagreed with both. Whether a route is implemented is answered by the
// registrations and the rule-43 inventory, never by a comment.
//
// EVERYTHING HERE IS ORACLE-BACKED. tools/probe-sd-routes.mjs starts the pinned server, drives
// these routes (against a local mock peer, or with `request.body.url` pointed at one) and records
// tests/oracle/sillytavern-1.19.0-sd-routes.json and ...-sd-workflows.json. Each recorded
// observation classifies every field as `compared` or `shape`, and internal/server/sd_*_test.go
// replays the fixture against this implementation, so a claim in the compatibility matrix can be
// traced to a value the pinned code actually produced.
//
// Outbound routes follow docs/tokenizer-parity-plan.md §11: the upstream base URL is a seam that
// defaults to the pinned URL (asserted by sd_routes_test.go), the tests point the seam at a local
// mock, and the failure path is exercised by a closed port. Routes whose upstream is the body's
// `url` field need no seam — the caller supplies it, exactly as upstream.
//
// The pinned outbound client is node-fetch 3.3.2, whose observable request shape is reproduced
// here rather than approximated: header names lowercase and sorted, `accept`/`accept-encoding`/
// `user-agent` defaults appended, `Host` and `Connection` last, and up to 20 redirects followed
// with node-fetch's method/body/header rules. The test asserts the recorded wire form hop by hop.

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"io"
	"math"
	"mime"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strconv"
	"strings"

	"github.com/cocokoishi/gotavern/internal/outbound"
	"github.com/cocokoishi/gotavern/internal/startup"
)

// Seam defaults. Each is the pinned literal and is asserted by TestSDSeamDefaults, because a
// seam whose default drifts changes production while the tests keep passing against a mock.
const (
	sdTogetherDefaultURL     = "https://api.together.xyz"
	sdChutesDefaultURL       = "https://api.chutes.ai"
	sdElectronHubDefaultURL  = "https://api.electronhub.ai"
	sdNanoGPTDefaultURL      = "https://nano-gpt.com"
	sdAimlapiDefaultURL      = "https://api.aimlapi.com"
	sdWorkersAIDefaultURL    = "https://api.cloudflare.com"
	sdPollinationsDefaultURL = "https://gen.pollinations.ai"
	sdFalaiDefaultURL        = "https://fal.ai"
)

func sdSeamURL(environmentName, fallback string) string {
	if override := strings.TrimSpace(os.Getenv(environmentName)); override != "" {
		return strings.TrimSuffix(override, "/")
	}
	return fallback
}

// Seam accessors are functions, not package variables, so an overridden environment is read per
// request exactly as the pinned hardcoded string is evaluated per request.
func sdTogetherURL() string { return sdSeamURL("GOTAVERN_SD_TOGETHER_URL", sdTogetherDefaultURL) }
func sdChutesURL() string   { return sdSeamURL("GOTAVERN_SD_CHUTES_URL", sdChutesDefaultURL) }
func sdElectronHubURL() string {
	return sdSeamURL("GOTAVERN_SD_ELECTRONHUB_URL", sdElectronHubDefaultURL)
}
func sdNanoGPTURL() string   { return sdSeamURL("GOTAVERN_SD_NANOGPT_URL", sdNanoGPTDefaultURL) }
func sdAimlapiURL() string   { return sdSeamURL("GOTAVERN_SD_AIMLAPI_URL", sdAimlapiDefaultURL) }
func sdWorkersAIURL() string { return sdSeamURL("GOTAVERN_SD_WORKERSAI_URL", sdWorkersAIDefaultURL) }
func sdPollinationsURL() string {
	return sdSeamURL("GOTAVERN_SD_POLLINATIONS_URL", sdPollinationsDefaultURL)
}
func sdFalaiURL() string { return sdSeamURL("GOTAVERN_SD_FALAI_URL", sdFalaiDefaultURL) }

func init() {
	domainRouteRegistrars = append(domainRouteRegistrars, registerSDRoutes)
}

func registerSDRoutes(mux *http.ServeMux, accounts *accountRuntime, notFoundPage []byte, options HTTPHandlerOptions) {
	post := func(route string, handler func(http.ResponseWriter, *http.Request)) {
		mux.HandleFunc(route, func(w http.ResponseWriter, r *http.Request) {
			if r.Method != http.MethodPost {
				serveStatic(w, r, notFoundPage, options)
				return
			}
			handler(w, r)
		})
	}

	post("/api/sd/ping", accounts.serveSDPing)
	post("/api/sd/generate", accounts.serveSDA1111Generate)
	post("/api/sd/upscalers", accounts.serveSDUpscalers)
	post("/api/sd/vaes", accounts.serveSDVaes)
	post("/api/sd/samplers", accounts.serveSDSamplers)
	post("/api/sd/schedulers", accounts.serveSDSchedulers)
	post("/api/sd/models", accounts.serveSDModels)
	post("/api/sd/get-model", accounts.serveSDGetModel)
	post("/api/sd/set-model", accounts.serveSDSetModel)
	post("/api/sd/sd-next/upscalers", accounts.serveSDSDNextUpscalers)

	post("/api/sd/comfy/ping", accounts.serveSDComfyPing)
	post("/api/sd/comfy/samplers", accounts.serveSDComfySamplers)
	post("/api/sd/comfy/models", accounts.serveSDComfyModels)
	post("/api/sd/comfy/schedulers", accounts.serveSDComfySchedulers)
	post("/api/sd/comfy/vaes", accounts.serveSDComfyVaes)
	post("/api/sd/comfy/workflows", accounts.serveSDComfyWorkflows)
	post("/api/sd/comfy/workflow", accounts.serveSDComfyWorkflow)
	post("/api/sd/comfy/save-workflow", accounts.serveSDComfySaveWorkflow)
	post("/api/sd/comfy/delete-workflow", accounts.serveSDComfyDeleteWorkflow)
	post("/api/sd/comfy/rename-workflow", accounts.serveSDComfyRenameWorkflow)

	post("/api/sd/comfyrunpod/ping", accounts.serveSDComfyRunPodPing)
	post("/api/sd/sdcpp/ping", accounts.serveSDSDCppPing)
	post("/api/sd/sdcpp/models", accounts.serveSDSDCppModels)
	post("/api/sd/sdcpp/generate", accounts.serveSDSdcppGenerate)
	post("/api/sd/drawthings/ping", accounts.serveSDDrawThingsPing)
	post("/api/sd/drawthings/get-model", accounts.serveSDDrawThingsGetModel)
	post("/api/sd/drawthings/get-upscaler", accounts.serveSDDrawThingsGetUpscaler)
	post("/api/sd/drawthings/generate", accounts.serveSDDrawThingsGenerate)

	post("/api/sd/together/models", accounts.serveSDTogetherModels)
	post("/api/sd/chutes/models", accounts.serveSDChutesModels)
	post("/api/sd/electronhub/models", accounts.serveSDElectronHubModels)
	post("/api/sd/electronhub/sizes", accounts.serveSDElectronHubSizes)
	post("/api/sd/nanogpt/models", accounts.serveSDNanoGPTModels)
	post("/api/sd/aimlapi/models", accounts.serveSDAimlapiModels)
	post("/api/sd/workersai/models", accounts.serveSDWorkersAIModels)
	post("/api/sd/workersai/generate", accounts.serveSDWorkersAIGenerate)
	post("/api/sd/stability/generate", accounts.serveSDStabilityGenerate)
	post("/api/sd/pollinations/models", accounts.serveSDPollinationsModels)
	post("/api/sd/falai/models", accounts.serveSDFalaiModels)
}

// ---- request identity and body parsing ---------------------------------------------------

// sdUser resolves the authenticated account and its pinned directory map, mirroring
// `request.user` and `request.user.directories`. The SD router is mounted behind the private
// login middleware, so an unauthenticated request never reaches a handler.
func (runtime *accountRuntime) sdUser(w http.ResponseWriter, request *http.Request) (*storedAccount, startup.UserDirectories, bool) {
	account, ok := runtime.settingsRequestAccount(w, request)
	if !ok {
		return nil, nil, false
	}
	directories, err := startup.DirectoriesForUser(runtime.options.DataRoot, account.string("handle"))
	if err != nil {
		serveSDStatus(w, http.StatusInternalServerError)
		return nil, nil, false
	}
	return account, directories, true
}

// sdRequestBody reproduces the pinned body-parser result for `request.body`.
//
// Two parsers are mounted globally (src/server-main.js:110-111): `bodyParser.json` with a 500 MiB
// limit, and `bodyParser.urlencoded({extended:true})` with the same limit. A JSON body is parsed
// strictly (object or array only); anything else leaves `request.body` an empty object, which is
// why a request declared `text/plain` reaches a handler with no `url` and answers 500. A
// malformed JSON body is rejected with 400 before the handler runs. The urlencoded parser is
// reproduced for flat keys, which are the only shape these routes read.
func (runtime *accountRuntime) sdRequestBody(w http.ResponseWriter, request *http.Request) (orderedNodeJSON, bool) {
	body, err := io.ReadAll(io.LimitReader(request.Body, 500<<20))
	if err != nil {
		serveSDStatus(w, http.StatusBadRequest)
		return orderedNodeJSON{}, false
	}
	mediaType, _, err := mime.ParseMediaType(request.Header.Get("Content-Type"))
	if err != nil {
		mediaType = ""
	}
	switch mediaType {
	case "application/json":
		trimmed := bytes.TrimSpace(body)
		if len(trimmed) == 0 {
			return nodeObject(), true
		}
		if trimmed[0] != '{' && trimmed[0] != '[' {
			serveSDStatus(w, http.StatusBadRequest)
			return orderedNodeJSON{}, false
		}
		value, decodeErr := decodeOrderedNodeJSON(trimmed)
		if decodeErr != nil || (value.kind != 'o' && value.kind != 'a') {
			serveSDStatus(w, http.StatusBadRequest)
			return orderedNodeJSON{}, false
		}
		return value, true
	case "application/x-www-form-urlencoded":
		return sdParseFormBody(string(body)), true
	default:
		return nodeObject(), true
	}
}

// sdParseFormBody reproduces qs's flat-key result for request bodies: keys keep first-appearance
// order, a repeated key becomes a string array, and '+' decodes to a space.
func sdParseFormBody(body string) orderedNodeJSON {
	result := nodeObject()
	if body == "" {
		return result
	}
	positions := map[string]int{}
	for _, pair := range strings.Split(body, "&") {
		if pair == "" {
			continue
		}
		rawKey, rawValue, hasValue := strings.Cut(pair, "=")
		if !hasValue {
			rawValue = ""
		}
		key, keyErr := url.QueryUnescape(rawKey)
		if keyErr != nil {
			continue
		}
		value, valueErr := url.QueryUnescape(rawValue)
		if valueErr != nil {
			continue
		}
		if position, seen := positions[key]; seen {
			members := result.object
			if members[position].value.kind == 'a' {
				members[position].value.array = append(members[position].value.array, nodeString(value))
			} else {
				members[position].value = nodeArray(members[position].value, nodeString(value))
			}
			continue
		}
		positions[key] = len(result.object)
		result.setMember(key, nodeString(value))
	}
	return result
}

// sdBodyMember is `request.body.X` for a decoded body, including the `undefined` a missing
// member or a non-object body produces.
func sdBodyMember(body orderedNodeJSON, key string) orderedNodeJSON {
	if body.kind != 'o' {
		return nodeUndefined()
	}
	if value, exists := body.member(key); exists {
		return value
	}
	return nodeUndefined()
}

// sdMemberOf is `value.X` for a value decoded from an upstream JSON answer. Property access on
// null or undefined throws in JavaScript, so those report false; every other primitive reports
// an undefined member, exactly as JavaScript does.
func sdMemberOf(value orderedNodeJSON, key string) (orderedNodeJSON, bool) {
	switch value.kind {
	case 'o':
		if member, exists := value.member(key); exists {
			return member, true
		}
		return nodeUndefined(), true
	case 'n', nodeUndefinedKind:
		return orderedNodeJSON{}, false
	default:
		return nodeUndefined(), true
	}
}

// sdIndex is `array[0]` / `value[0]`, which throws for null/undefined and is undefined for every
// other primitive or a missing index.
func sdIndex(value orderedNodeJSON, index int) (orderedNodeJSON, bool) {
	switch value.kind {
	case 'a':
		if index < 0 || index >= len(value.array) {
			return nodeUndefined(), true
		}
		return value.array[index], true
	case 'n', nodeUndefinedKind:
		return orderedNodeJSON{}, false
	default:
		return nodeUndefined(), true
	}
}

// ---- JavaScript coercions used by the handlers -------------------------------------------

// sdURLValue reproduces `new URL(request.body.url)`. The constructor stringifies its argument
// (so a missing member becomes the invalid string "undefined" and throws) and only a URL with a
// scheme and authority successfully parses. node-fetch then refuses any protocol other than
// http/https before connecting, which the pinned catch turns into 500 as well.
func sdURLValue(value orderedNodeJSON) (*url.URL, bool) {
	text, err := pinnedJSStringValue(value)
	if err != nil {
		return nil, false
	}
	return sdParseAbsoluteURL(text)
}

// sdParseAbsoluteURL is `new URL(text)`: an absolute http/https URL with a host, everything
// else throwing.
func sdParseAbsoluteURL(text string) (*url.URL, bool) {
	parsed, err := url.Parse(strings.TrimSpace(text))
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return nil, false
	}
	scheme := strings.ToLower(parsed.Scheme)
	if scheme != "http" && scheme != "https" {
		return nil, false
	}
	parsed.Scheme = scheme
	return parsed, true
}

// sdURLWithPath is `url.pathname = path`, which replaces the path and keeps the query string.
func sdURLWithPath(parsed *url.URL, pathname string) string {
	copied := *parsed
	copied.Path = pathname
	copied.RawPath = ""
	copied.Fragment = ""
	copied.RawFragment = ""
	return copied.String()
}

// sdURLJoin reproduces url-join 5.0.0 for the two-part joins these routes perform:
// `urlJoin(request.body.url, '/system_stats')`. It normalizes the scheme slashes, strips the
// base's trailing slashes and the component's leading slashes, joins with '/', removes a slash
// directly before a query separator, and turns later '?' separators into '&'.
func sdURLJoin(base, component string) string {
	first := sdURLJoinBase(base)
	first = strings.TrimRight(first, "/")
	second := strings.TrimLeft(component, "/")
	if strings.HasSuffix(second, "/") {
		second = strings.TrimRight(second, "/") + "/"
	}
	joined := first + "/" + second
	var cleaned strings.Builder
	for index := 0; index < len(joined); index++ {
		character := joined[index]
		if character == '/' && index+1 < len(joined) {
			next := joined[index+1]
			if next == '?' || next == '&' || (next == '#' && index+2 < len(joined) && joined[index+2] != '!') {
				continue
			}
		}
		cleaned.WriteByte(character)
	}
	joined = cleaned.String()
	if index := strings.IndexByte(joined, '?'); index >= 0 {
		joined = joined[:index] + "?" + strings.ReplaceAll(joined[index+1:], "?", "&")
	}
	return joined
}

// sdURLJoinBase is url-join's `strArray[0].replace(/^([^/:]+):\/*/, '$1://')`: the scheme's
// slash run is rewritten to exactly two slashes.
func sdURLJoinBase(input string) string {
	colon := strings.IndexByte(input, ':')
	if colon <= 0 || strings.ContainsRune(input[:colon], '/') {
		return input
	}
	return input[:colon] + "://" + strings.TrimLeft(input[colon+1:], "/")
}

// sdEncodeURIComponent is encodeURIComponent: it leaves A-Z a-z 0-9 - _ . ! ~ * ' ( ) untouched
// and percent-encodes every other UTF-8 byte.
func sdEncodeURIComponent(value string) string {
	const unescaped = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()"
	var builder strings.Builder
	for _, iterator := range []byte(value) {
		if strings.IndexByte(unescaped, iterator) >= 0 {
			builder.WriteByte(iterator)
			continue
		}
		builder.WriteByte('%')
		builder.WriteString(strings.ToUpper(strconv.FormatUint(uint64(iterator), 16)))
	}
	return builder.String()
}

// sdEncodeURLPath percent-encodes a path segment the way the WHATWG URL parser does: C0 controls,
// space, and " # < > ? ` { } and every non-ASCII byte are escaped; an existing percent escape is
// left alone so a value that was already encoded is not double-encoded.
func sdEncodeURLPath(value string) string {
	var builder strings.Builder
	for index := 0; index < len(value); index++ {
		iterator := value[index]
		switch {
		case iterator == '%':
			builder.WriteByte(iterator)
		case iterator <= 0x20 || iterator >= 0x7f ||
			iterator == '"' || iterator == '#' || iterator == '<' || iterator == '>' ||
			iterator == '?' || iterator == '`' || iterator == '{' || iterator == '}':
			builder.WriteByte('%')
			builder.WriteString(strings.ToUpper(strconv.FormatUint(uint64(iterator), 16)))
		default:
			builder.WriteByte(iterator)
		}
	}
	return builder.String()
}

// sdBasicAuthHeader reproduces getBasicAuthHeader (src/util.js:126): it never omits the header,
// and a missing `auth` becomes the literal string "undefined".
func sdBasicAuthHeader(value orderedNodeJSON) (string, bool) {
	text, err := pinnedJSStringValue(value)
	if err != nil {
		return "", false
	}
	return "Basic " + base64.StdEncoding.EncodeToString([]byte(text)), true
}

// sdTruthyString is `const key = readSecret(...); if (!key)`. readSecret returns a string, so an
// empty value means "not configured".
func sdTruthyString(value string) bool { return value != "" }

// ---- upstream requests -------------------------------------------------------------------

const (
	sdNodeFetchAccept         = "*/*"
	sdNodeFetchAcceptEncoding = "gzip, deflate, br"
	sdNodeFetchUserAgent      = "node-fetch"
	sdMaxRedirects            = 20
)

// sdRequest is one outbound request in the form a pinned handler writes it.
type sdRequest struct {
	Method string
	URL    string
	// Headers are the headers the handler passes explicitly. node-fetch lowercases them, sorts
	// the final set and appends its own defaults and framing, which is what sdFetch does.
	Headers map[string]string
	Body    []byte
}

// sdFetch performs the pinned outbound request: node-fetch header construction, redirect
// following, and TLS-capable transport through the shared outbound client.
func sdFetch(ctx context.Context, request sdRequest) (*outbound.Response, error) {
	current := request
	currentURL, err := url.Parse(current.URL)
	if err != nil || currentURL.Host == "" {
		return nil, errors.New("invalid upstream url")
	}
	for redirects := 0; ; redirects++ {
		headers := sdNodeFetchHeaders(current.Headers, current.Body)
		headers = append(headers,
			outbound.Header{Name: "Host", Value: sdHostHeader(currentURL)},
			outbound.Header{Name: "Connection", Value: "close"},
		)
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
		// node-fetch: 303 always becomes GET; 301/302 becomes GET only for POST.
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

func sdIsRedirectStatus(status int) bool {
	switch status {
	case http.StatusMovedPermanently, http.StatusFound, http.StatusSeeOther,
		http.StatusTemporaryRedirect, http.StatusPermanentRedirect:
		return true
	default:
		return false
	}
}

func sdDomainOrSubdomain(original, next *url.URL) bool {
	originalHost := strings.ToLower(original.Hostname())
	nextHost := strings.ToLower(next.Hostname())
	if nextHost == originalHost {
		return true
	}
	return strings.HasSuffix(nextHost, "."+originalHost)
}

// sdNodeFetchHeaders builds the header lines node-fetch 3.3.2 emits, in the order Node writes
// them: lowercase names sorted alphabetically, then Host, then Connection (added by sdFetch).
func sdNodeFetchHeaders(explicit map[string]string, body []byte) []outbound.Header {
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

// sdHostHeader is the Host line Node derives from the request URL: the hostname lowercased, a
// default port omitted, an IPv6 literal bracketed.
func sdHostHeader(parsed *url.URL) string {
	scheme := strings.ToLower(parsed.Scheme)
	host := strings.ToLower(parsed.Hostname())
	port := parsed.Port()
	if (scheme == "http" && port == "80") || (scheme == "https" && port == "443") {
		port = ""
	}
	if strings.Contains(host, ":") {
		host = "[" + host + "]"
	}
	if port != "" {
		return host + ":" + port
	}
	return host
}

// sdReadJSON is the pinned `await result.json()`. A body that is not JSON throws, which the
// route's catch turns into 500.
func sdReadJSON(response *outbound.Response) (orderedNodeJSON, bool) {
	value, err := decodeOrderedNodeJSON(response.Body)
	if err != nil {
		return orderedNodeJSON{}, false
	}
	return value, true
}

func sdResponseOK(response *outbound.Response) bool {
	return response.Status >= 200 && response.Status <= 299
}

// ---- documented HTTP response helpers ----------------------------------------------------

// serveSDStatus reproduces `res.sendStatus(status)`: a text/plain body of the status message with
// Express's weak ETag. For 204/304 Express removes the type, length and framing headers but keeps
// the ETag it already generated, so the ETag is written on its own there.
func serveSDStatus(w http.ResponseWriter, status int) {
	body := []byte(http.StatusText(status))
	if status == http.StatusNoContent || status == http.StatusNotModified {
		w.Header().Set("ETag", expressWeakETag(body))
		w.WriteHeader(status)
		return
	}
	respondText(w, status, "text/plain; charset=utf-8", string(body))
}

// serveSDValue reproduces `res.send(value)` for a value that came from an upstream JSON answer.
//
// Express dispatches on the JavaScript type, and the branches are observable:
//   - a string is sent as text/html with a charset;
//   - null is an empty body with Content-Length: 0 and the ETag of the empty string;
//   - undefined is an empty body with no Content-Length from Express at all;
//   - a number is Express's deprecated `res.send(status)` form, so it becomes a status code and
//     the body is that status's message — an out-of-range number throws and the route answers 500;
//   - a boolean, object or array is serialized as JSON.
func serveSDValue(w http.ResponseWriter, value orderedNodeJSON) {
	switch value.kind {
	case nodeUndefinedKind:
		w.WriteHeader(http.StatusOK)
	case 'n':
		w.Header().Set("Content-Length", "0")
		w.Header().Set("ETag", expressWeakETag(nil))
		w.WriteHeader(http.StatusOK)
	case 's':
		text, _ := value.stringValue()
		respondText(w, http.StatusOK, "text/html; charset=utf-8", text)
	case 'v':
		serveSDNumberValue(w, value.scalar.(float64))
	default:
		respondOrderedNodeJSON(w, http.StatusOK, value)
	}
}

// serveSDNumberValue is res.send(number) in Express 4.21: a number with a single argument is the
// deprecated res.send(status) form. Node rejects a non-integer or out-of-range status code while
// writing the head, and the pinned route's catch answers 500.
func serveSDNumberValue(w http.ResponseWriter, value float64) {
	if math.IsNaN(value) || math.IsInf(value, 0) || value != math.Trunc(value) || value < 100 || value > 999 {
		serveSDStatus(w, http.StatusInternalServerError)
		return
	}
	status := int(value)
	if http.StatusText(status) == "" {
		w.Header().Set("Content-Type", "text/plain")
		w.WriteHeader(status)
		return
	}
	serveSDStatus(w, status)
}

// ---- secrets -----------------------------------------------------------------------------

// sdReadSecret reproduces `readSecret(request.user.directories, SECRET_KEYS.X)` for the flat
// active entry. It reuses the pinned reader and JS truthiness the chat-completion secrets path
// already implements rather than inventing a second secrets representation: an empty or falsy
// value is "not configured".
func sdReadSecret(directories startup.UserDirectories, key string) (string, error) {
	value, err := pinnedReadSecret(directories, key, nodeUndefined())
	if err != nil {
		return "", err
	}
	if !pinnedJSTruthy(value) {
		return "", nil
	}
	text, stringErr := pinnedJSStringValue(value)
	if stringErr != nil {
		return "", stringErr
	}
	return text, nil
}
