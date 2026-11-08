package server

// THE PINNED /proxy/:url(*) CONTRACT, EXERCISED AGAINST A REAL LOCAL UPSTREAM.
//
// Every expectation below comes from the pinned source plus a probe that mounted the pinned middleware
// itself (express 4.22.1 + body-parser 1.20.4 + node-fetch 3.3.2 from the pinned node_modules, local
// upstream only, no browser). The probe's recorded observables that these tests encode:
//
//   - POST/PUT/PATCH body bytes: `{"2":"two","10":"ten","b":2,"a":1,"n":100,"z":[1,2],"s":"<&>",
//     "u":"\u00e9","dup":2}` for the fixture below (JSON.stringify order and number normalisation);
//   - a successful proxied response has NO Content-Type and NO upstream header, and is chunked;
//   - an upstream 401 becomes 400 with its body; a 404 keeps status/body;
//   - gzip and br are decompressed by node-fetch; br is this build's named divergence;
//   - /proxy (bare) is the pinned 404 page, /proxy/ (empty target) is 500;
//   - the forced accept-encoding is exactly "gzip, deflate, br".
//
// The upstream records the request it OBSERVED (method, escaped path+query, Host, headers, body bytes) so
// a forwarding regression fails with the observed value named, not with a status code alone.

import (
	"bytes"
	"compress/gzip"
	"compress/zlib"
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/cocokoishi/gotavern/internal/outbound"
)

type corsProxyObservedRequest struct {
	Method     string
	RequestURI string
	Host       string
	Header     http.Header
	Body       []byte
}

type corsProxyTestUpstream struct {
	server  *httptest.Server
	mutex   sync.Mutex
	records []corsProxyObservedRequest
}

func newCorsProxyTestUpstream(t *testing.T, respond func(http.ResponseWriter, *http.Request)) *corsProxyTestUpstream {
	t.Helper()
	upstream := &corsProxyTestUpstream{}
	upstream.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		r.Body = io.NopCloser(bytes.NewReader(body))
		upstream.mutex.Lock()
		upstream.records = append(upstream.records, corsProxyObservedRequest{
			Method:     r.Method,
			RequestURI: r.URL.RequestURI(),
			Host:       r.Host,
			Header:     r.Header.Clone(),
			Body:       body,
		})
		upstream.mutex.Unlock()
		respond(w, r)
	}))
	t.Cleanup(upstream.server.Close)
	return upstream
}

func (upstream *corsProxyTestUpstream) observed() []corsProxyObservedRequest {
	upstream.mutex.Lock()
	defer upstream.mutex.Unlock()
	return append([]corsProxyObservedRequest(nil), upstream.records...)
}

func (upstream *corsProxyTestUpstream) reset() {
	upstream.mutex.Lock()
	defer upstream.mutex.Unlock()
	upstream.records = nil
}

func newCorsProxyTestHandler(t *testing.T, enabled bool) *httptest.Server {
	t.Helper()
	return newCorsProxyTestHandlerWithOptions(t, HTTPHandlerOptions{EnableCorsProxy: enabled})
}

func newCorsProxyTestHandlerWithOptions(t *testing.T, options HTTPHandlerOptions) *httptest.Server {
	t.Helper()
	dataRoot := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dataRoot, "_errors"), 0o755); err != nil {
		t.Fatalf("create data root: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dataRoot, "_errors", "url-not-found.html"), []byte("<html>pinned 404 page</html>"), 0o644); err != nil {
		t.Fatalf("write pinned 404 page: %v", err)
	}
	options.DataRoot = dataRoot
	handler := NewHTTPHandlerWithOptions(options)
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	return server
}

func corsProxyTargetPath(handler *httptest.Server, target string) string {
	return handler.URL + "/proxy/" + url.PathEscape(target)
}

func corsProxyPerform(t *testing.T, handler *httptest.Server, method, requestURL string, headers map[string]string, body []byte) (*http.Response, []byte) {
	t.Helper()
	var reader io.Reader
	if body != nil {
		reader = bytes.NewReader(body)
	}
	request, err := http.NewRequest(method, requestURL, reader)
	if err != nil {
		t.Fatalf("build %s %s: %v", method, requestURL, err)
	}
	for name, value := range headers {
		request.Header.Set(name, value)
	}
	client := &http.Client{Timeout: 20 * time.Second}
	response, err := client.Do(request)
	if err != nil {
		t.Fatalf("%s %s: %v", method, requestURL, err)
	}
	defer response.Body.Close()
	payload, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatalf("%s %s: read body: %v", method, requestURL, err)
	}
	return response, payload
}

func corsProxyAssertNoContentType(t *testing.T, response *http.Response, label string) {
	t.Helper()
	if value := response.Header.Get("Content-Type"); value != "" {
		t.Fatalf("%s Content-Type = %q; pinned's forwardFetchResponse copies NO upstream headers, so a proxied response carries no Content-Type", label, value)
	}
	if _, present := response.Header["Content-Type"]; present {
		t.Fatalf("%s carries a Content-Type header; pinned's forwardFetchResponse copies NO upstream headers", label)
	}
}

// ---------------------------------------------------------------- the disabled branch

func TestCorsProxyDisabledAnswersThePinnedRefusal(t *testing.T) {
	handler := NewHTTPHandlerWithOptions(HTTPHandlerOptions{DataRoot: t.TempDir()})
	for _, path := range []string{
		"/proxy/https%3A%2F%2Fexample.invalid%2Fx",
		"/proxy/example.invalid%2Fx",
		"/proxy/",
	} {
		request := httptest.NewRequest(http.MethodGet, path, nil)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)

		if response.Code != http.StatusNotFound {
			t.Fatalf("GET %s answered %d; pinned's disabled CORS-proxy branch answers 404 (server-main.js:260-264)", path, response.Code)
		}
		if got := response.Body.String(); got == "404 page not found\n" {
			t.Fatalf("GET %s answered the Go mux's generic 404 page; pinned answers %q", path, pinnedCorsProxyDisabledMessage)
		} else if got != pinnedCorsProxyDisabledMessage {
			t.Fatalf("GET %s body = %q; pinned's disabled CORS-proxy message is %q", path, got, pinnedCorsProxyDisabledMessage)
		}
		if got := response.Header().Get("Content-Type"); got != "text/html; charset=utf-8" {
			t.Fatalf("GET %s Content-Type = %q; Express res.send(string) answers text/html; charset=utf-8", path, got)
		}
	}
}

func TestCorsProxyDisabledDoesNotForwardARequest(t *testing.T) {
	upstream := newCorsProxyTestUpstream(t, func(w http.ResponseWriter, _ *http.Request) {
		t.Error("the disabled CORS proxy forwarded a request upstream")
	})
	handler := newCorsProxyTestHandler(t, false)
	response, body := corsProxyPerform(t, handler, http.MethodGet, corsProxyTargetPath(handler, upstream.server.URL+"/x"), nil, nil)
	if response.StatusCode != http.StatusNotFound || string(body) != pinnedCorsProxyDisabledMessage {
		t.Fatalf("disabled proxy = %d %q; want 404 %q", response.StatusCode, body, pinnedCorsProxyDisabledMessage)
	}
	if len(upstream.observed()) != 0 {
		t.Fatalf("disabled proxy forwarded %d request(s)", len(upstream.observed()))
	}
}

// ---------------------------------------------------------------- the enabled branch exists

func TestCorsProxyEnabledNoLongerAnswersThePlaceholder(t *testing.T) {
	upstream := newCorsProxyTestUpstream(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, "pong")
	})
	handler := newCorsProxyTestHandler(t, true)
	response, body := corsProxyPerform(t, handler, http.MethodGet, corsProxyTargetPath(handler, upstream.server.URL+"/ping"), nil, nil)

	if response.StatusCode != http.StatusOK {
		t.Fatalf("enabled proxy answered %d %q; it must proxy (the alpha.17 placeholder answered 501)", response.StatusCode, body)
	}
	if string(body) != "pong" {
		t.Fatalf("enabled proxy body = %q; want the upstream's %q", body, "pong")
	}
	if response.StatusCode == http.StatusNotImplemented {
		t.Fatalf("enabled proxy still answers 501")
	}
}

func TestCorsProxyForwardsGetWithAnEncodedQueryString(t *testing.T) {
	upstream := newCorsProxyTestUpstream(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	handler := newCorsProxyTestHandler(t, true)
	target := upstream.server.URL + "/echo?a=1&b=two"
	response, _ := corsProxyPerform(t, handler, http.MethodGet, corsProxyTargetPath(handler, target), map[string]string{"User-Agent": "oracle"}, nil)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("GET proxied target answered %d", response.StatusCode)
	}
	observed := upstream.observed()
	if len(observed) != 1 {
		t.Fatalf("upstream observed %d requests; want exactly 1", len(observed))
	}
	if observed[0].Method != http.MethodGet {
		t.Fatalf("upstream method = %q; want GET", observed[0].Method)
	}
	if observed[0].RequestURI != "/echo?a=1&b=two" {
		t.Fatalf("upstream request target = %q; want the query string carried inside the encoded target", observed[0].RequestURI)
	}
	if len(observed[0].Body) != 0 {
		t.Fatalf("GET carried %d body bytes upstream; pinned sends no body for GET", len(observed[0].Body))
	}
}

func TestCorsProxyDropsAQueryStringThatWasNotEncodedIntoTheTarget(t *testing.T) {
	upstream := newCorsProxyTestUpstream(t, func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })
	handler := newCorsProxyTestHandler(t, true)
	// `?raw=1` is the OUTER query string; express's :url(*) param is the path and never includes it.
	requestURL := handler.URL + "/proxy/" + url.PathEscape(upstream.server.URL+"/echo") + "?raw=1"
	response, _ := corsProxyPerform(t, handler, http.MethodGet, requestURL, nil, nil)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("GET answered %d", response.StatusCode)
	}
	observed := upstream.observed()
	if len(observed) != 1 || observed[0].RequestURI != "/echo" {
		t.Fatalf("upstream observed %v; the outer ?raw=1 must be dropped (only a query encoded INSIDE the target reaches pinned's fetch)", observed)
	}
}

// ---------------------------------------------------------------- request bodies

func TestCorsProxyReserializesJSONBodiesForPostPutPatch(t *testing.T) {
	// The fixture and the expected bytes are taken from the pinned probe: whitespace removed, integer-like
	// keys first in numeric order, duplicate key collapsed to its first position with the last value,
	// 1.0 -> 1, 1e2 -> 100, `<&>` not HTML-escaped, the unicode escape decoded. \u00e9 keeps this source
	// ASCII while the expected byte is the two-byte UTF-8 sequence node-fetch sent.
	input := "{\n  \"b\": 2,\n  \"a\": 1.0,\n  \"n\": 1e2,\n  \"z\": [1, 2],\n  \"s\": \"<&>\",\n  \"u\": \"\\u00e9\",\n  \"dup\": 1,\n  \"dup\": 2,\n  \"10\": \"ten\",\n  \"2\": \"two\"\n}"
	want := "{\"2\":\"two\",\"10\":\"ten\",\"b\":2,\"a\":1,\"n\":100,\"z\":[1,2],\"s\":\"<&>\",\"u\":\"\u00e9\",\"dup\":2}"

	upstream := newCorsProxyTestUpstream(t, func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })
	handler := newCorsProxyTestHandler(t, true)
	for _, method := range []string{http.MethodPost, http.MethodPut, http.MethodPatch} {
		upstream.reset()
		response, _ := corsProxyPerform(t, handler, method, corsProxyTargetPath(handler, upstream.server.URL+"/echo"),
			map[string]string{"Content-Type": "application/json", "User-Agent": "oracle"}, []byte(input))
		if response.StatusCode != http.StatusOK {
			t.Fatalf("%s answered %d; the proxy must forward a valid JSON body", method, response.StatusCode)
		}
		observed := upstream.observed()
		if len(observed) != 1 {
			t.Fatalf("%s: upstream observed %d requests; want 1", method, len(observed))
		}
		if string(observed[0].Body) != want {
			t.Fatalf("%s upstream body = %q; pinned sends JSON.stringify(req.body) = %q", method, observed[0].Body, want)
		}
		if methodObserved := observed[0].Method; methodObserved != method {
			t.Fatalf("%s method = %q", method, methodObserved)
		}
		if contentType := observed[0].Header.Get("Content-Type"); contentType != "application/json" {
			t.Fatalf("%s upstream Content-Type = %q; pinned forwards the request's own content type", method, contentType)
		}
	}
}

func TestCorsProxyAddsNodeFetchDefaultsForASentStringBody(t *testing.T) {
	upstream := newCorsProxyTestUpstream(t, func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })
	handler := newCorsProxyTestHandler(t, true)

	// Mimic a caller that sent no content type and no user-agent: body-parser leaves req.body as {},
	// JSON.stringify sends "{}", and node-fetch labels that string text/plain;charset=UTF-8 and adds its
	// own Accept and User-Agent. The empty User-Agent key stops Go's client from adding its own.
	request, err := http.NewRequest(http.MethodPost, corsProxyTargetPath(handler, upstream.server.URL+"/echo"), strings.NewReader("ignored"))
	if err != nil {
		t.Fatalf("build request: %v", err)
	}
	request.Header["User-Agent"] = []string{""}
	response, err := (&http.Client{Timeout: 20 * time.Second}).Do(request)
	if err != nil {
		t.Fatalf("POST: %v", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("POST answered %d", response.StatusCode)
	}

	observed := upstream.observed()
	if len(observed) != 1 {
		t.Fatalf("upstream observed %d requests; want 1", len(observed))
	}
	if string(observed[0].Body) != "{}" {
		t.Fatalf("upstream body = %q; req.body is {} when body-parser does not parse, so JSON.stringify sends %q", observed[0].Body, "{}")
	}
	if got := observed[0].Header.Get("Content-Type"); got != "text/plain;charset=UTF-8" {
		t.Fatalf("upstream Content-Type = %q; node-fetch labels a string body text/plain;charset=UTF-8", got)
	}
	if got := observed[0].Header.Get("Accept"); got != "*/*" {
		t.Fatalf("upstream Accept = %q; node-fetch's default is */*", got)
	}
	if got := observed[0].Header.Get("User-Agent"); got != "node-fetch" {
		t.Fatalf("upstream User-Agent = %q; node-fetch's default is node-fetch", got)
	}
}

func TestCorsProxyInflatesAGzipJSONRequestBodyLikeBodyParser(t *testing.T) {
	upstream := newCorsProxyTestUpstream(t, func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })
	handler := newCorsProxyTestHandler(t, true)

	var compressed bytes.Buffer
	writer := gzip.NewWriter(&compressed)
	_, _ = io.WriteString(writer, `{"b": 2, "a": 1}`)
	_ = writer.Close()

	response, _ := corsProxyPerform(t, handler, http.MethodPost, corsProxyTargetPath(handler, upstream.server.URL+"/echo"),
		map[string]string{"Content-Type": "application/json", "Content-Encoding": "gzip"}, compressed.Bytes())
	if response.StatusCode != http.StatusOK {
		t.Fatalf("gzip request body answered %d; body-parser inflates gzip before JSON.parse", response.StatusCode)
	}
	observed := upstream.observed()
	if len(observed) != 1 {
		t.Fatalf("upstream observed %d requests; want 1", len(observed))
	}
	if string(observed[0].Body) != `{"b":2,"a":1}` {
		t.Fatalf("upstream body = %q; the inflated body is JSON.stringify'd", observed[0].Body)
	}
	// PINNED QUIRK, reproduced: body-parser inflates the request, corsProxy.js re-serializes req.body, and
	// the original content-encoding header is still forwarded -- so the upstream receives plain JSON
	// labelled gzip. This assertion is pinned's observable, not an endorsement of it.
	if got := observed[0].Header.Get("Content-Encoding"); got != "gzip" {
		t.Fatalf("upstream Content-Encoding = %q; pinned forwards the original header alongside the re-serialized body", got)
	}
}

func TestCorsProxyRefusesAnUnsupportedRequestContentEncoding(t *testing.T) {
	upstream := newCorsProxyTestUpstream(t, func(http.ResponseWriter, *http.Request) {
		t.Error("a request body with an unsupported content-encoding reached the upstream")
	})
	handler := newCorsProxyTestHandler(t, true)
	response, body := corsProxyPerform(t, handler, http.MethodPost, corsProxyTargetPath(handler, upstream.server.URL+"/echo"),
		map[string]string{"Content-Type": "application/json", "Content-Encoding": "br"}, []byte("not-really-brotli"))
	if response.StatusCode != http.StatusUnsupportedMediaType {
		t.Fatalf("br request body answered %d; body-parser's contentstream refuses an encoding other than gzip/deflate with 415", response.StatusCode)
	}
	if got := response.Header.Get("Content-Type"); got != "text/html; charset=utf-8" {
		t.Fatalf("unsupported request encoding Content-Type = %q; finalhandler answers text/html; charset=utf-8", got)
	}
	if !bytes.Contains(body, []byte("Unsupported Media Type")) {
		t.Fatalf("unsupported request encoding body = %q; the finalhandler document carries the status text", body)
	}
	if len(upstream.observed()) != 0 {
		t.Fatalf("unsupported request encoding forwarded %d request(s)", len(upstream.observed()))
	}
}

func TestCorsProxySendsAnEmptyObjectForAnEmptyJSONBody(t *testing.T) {
	upstream := newCorsProxyTestUpstream(t, func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })
	handler := newCorsProxyTestHandler(t, true)
	response, _ := corsProxyPerform(t, handler, http.MethodPost, corsProxyTargetPath(handler, upstream.server.URL+"/echo"),
		map[string]string{"Content-Type": "application/json"}, nil)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("empty JSON body answered %d", response.StatusCode)
	}
	observed := upstream.observed()
	if len(observed) != 1 || string(observed[0].Body) != "{}" {
		t.Fatalf("upstream body = %v; body-parser's parse() maps a zero-length JSON body to {}, so JSON.stringify sends %q", observed, "{}")
	}
}

// NAMED LIMITATION, not parity: body-parser also mounts urlencoded({extended:true}) after json(), so
// pinned turns a form body into a parsed object and forwards `{"a":"1","b":"two"}`. This implementation
// does not port the qs grammar and forwards `{}` instead. The test records the limit rather than hiding it.
func TestCorsProxyDoesNotPortTheUrlencodedBodyParser(t *testing.T) {
	upstream := newCorsProxyTestUpstream(t, func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })
	handler := newCorsProxyTestHandler(t, true)
	response, _ := corsProxyPerform(t, handler, http.MethodPost, corsProxyTargetPath(handler, upstream.server.URL+"/echo"),
		map[string]string{"Content-Type": "application/x-www-form-urlencoded"}, []byte("a=1&b=two"))
	if response.StatusCode != http.StatusOK {
		t.Fatalf("form body answered %d", response.StatusCode)
	}
	observed := upstream.observed()
	if len(observed) != 1 || string(observed[0].Body) != "{}" {
		t.Fatalf("upstream body = %v; this build does not parse urlencoded bodies, so req.body stays {} and the forwarded body is %q (pinned sends the parsed form as JSON)", observed, "{}")
	}
}

func TestCorsProxySendsNoBodyForDeleteHeadAndOptions(t *testing.T) {
	upstream := newCorsProxyTestUpstream(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodHead {
			w.WriteHeader(http.StatusOK)
			return
		}
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, "ok")
	})
	// Pinned's cors() middleware is mounted before /proxy and answers every OPTIONS request with 204
	// (cors.enabled defaults to true), so OPTIONS only reaches the proxy when CORS is disabled -- which is
	// the configuration the probe used. DELETE and HEAD reach the proxy in the default configuration.
	corsDisabled := false
	noCORSHandler := newCorsProxyTestHandlerWithOptions(t, HTTPHandlerOptions{
		EnableCorsProxy:        true,
		CorsSettingsConfigured: true,
		CorsEnabled:            &corsDisabled,
	})
	defaultHandler := newCorsProxyTestHandler(t, true)
	for _, test := range []struct {
		method  string
		handler *httptest.Server
	}{
		{http.MethodDelete, defaultHandler},
		{http.MethodHead, defaultHandler},
		{http.MethodOptions, noCORSHandler},
	} {
		upstream.reset()
		response, body := corsProxyPerform(t, test.handler, test.method, corsProxyTargetPath(test.handler, upstream.server.URL+"/echo"),
			map[string]string{"Content-Type": "application/json"}, []byte(`{"a":1}`))
		if response.StatusCode != http.StatusOK {
			t.Fatalf("%s answered %d", test.method, response.StatusCode)
		}
		if test.method == http.MethodHead && len(body) != 0 {
			t.Fatalf("HEAD response carried %d body bytes; a HEAD response has no body", len(body))
		}
		observed := upstream.observed()
		if len(observed) != 1 {
			t.Fatalf("%s: upstream observed %d requests; want 1", test.method, len(observed))
		}
		if observed[0].Method != test.method {
			t.Fatalf("upstream method = %q; want %q", observed[0].Method, test.method)
		}
		if len(observed[0].Body) != 0 {
			t.Fatalf("%s carried %d body bytes upstream; pinned's bodyMethods list is POST/PUT/PATCH only", test.method, len(observed[0].Body))
		}
	}
}

// ---------------------------------------------------------------- request headers

func TestCorsProxyStripsThePinnedHeaderListAndForcesAcceptEncoding(t *testing.T) {
	upstream := newCorsProxyTestUpstream(t, func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })
	handler := newCorsProxyTestHandler(t, true)

	removed := map[string]string{
		"X-Csrf-Token":         "token",
		"Referer":              "http://referrer.example/",
		"Origin":               "http://origin.example/",
		"Cookie":               "session=secret",
		"X-Forwarded-For":      "1.2.3.4",
		"X-Forwarded-Protocol": "https",
		"X-Forwarded-Proto":    "https",
		"X-Forwarded-Host":     "forwarded.example",
		"X-Real-Ip":            "5.6.7.8",
		"Sec-Fetch-Mode":       "cors",
		"Sec-Fetch-Site":       "cross-site",
		"Sec-Fetch-Dest":       "empty",
	}
	requestURL := corsProxyTargetPath(handler, upstream.server.URL+"/echo")
	request, err := http.NewRequest(http.MethodGet, requestURL, nil)
	if err != nil {
		t.Fatalf("build request: %v", err)
	}
	for name, value := range removed {
		request.Header.Set(name, value)
	}
	request.Header.Set("X-Benign", "kept")
	request.Header.Set("Accept-Encoding", "zstd")
	request.Header.Set("User-Agent", "cors-proxy-oracle")
	request.Host = "downstream.example"

	response, err := (&http.Client{Timeout: 20 * time.Second}).Do(request)
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("GET answered %d", response.StatusCode)
	}

	observed := upstream.observed()
	if len(observed) != 1 {
		t.Fatalf("upstream observed %d requests; want 1", len(observed))
	}
	for name := range removed {
		if value := observed[0].Header.Get(name); value != "" {
			t.Fatalf("upstream received %s: %q; pinned's headersToRemove deletes it (corsProxy.js:20-25)", name, value)
		}
	}
	if got := observed[0].Header.Get("X-Benign"); got != "kept" {
		t.Fatalf("upstream X-Benign = %q; a header outside the removal list must be forwarded", got)
	}
	if got := observed[0].Header.Get("Accept-Encoding"); got != pinnedCorsProxyAcceptEncoding {
		t.Fatalf("upstream Accept-Encoding = %q; pinned forces %q", got, pinnedCorsProxyAcceptEncoding)
	}
	if observed[0].Host == "downstream.example" {
		t.Fatalf("upstream Host = %q; pinned removes the incoming host header and node-fetch uses the target's", observed[0].Host)
	}
	if want := strings.TrimPrefix(upstream.server.URL, "http://"); observed[0].Host != want {
		t.Fatalf("upstream Host = %q; want the target authority %q", observed[0].Host, want)
	}
	if got := observed[0].Header.Get("User-Agent"); got != "cors-proxy-oracle" {
		t.Fatalf("upstream User-Agent = %q; a supplied user agent must be forwarded", got)
	}
}

// ---------------------------------------------------------------- response passthrough

func TestCorsProxyPassesThroughABinaryResponseBody(t *testing.T) {
	payload := []byte{0x00, 0x01, 0x02, 0xff, 0xfe, 0x0a, 0x0d, 0x00}
	upstream := newCorsProxyTestUpstream(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set("X-Secret", "leak")
		w.Header().Set("Set-Cookie", "a=b")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(payload)
	})
	handler := newCorsProxyTestHandler(t, true)
	response, body := corsProxyPerform(t, handler, http.MethodGet, corsProxyTargetPath(handler, upstream.server.URL+"/binary"), nil, nil)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("binary response status = %d", response.StatusCode)
	}
	if !bytes.Equal(body, payload) {
		t.Fatalf("binary body = % x; want the upstream bytes % x", body, payload)
	}
	if got := response.Header.Get("X-Secret"); got != "" {
		t.Fatalf("proxied response leaked upstream X-Secret = %q; forwardFetchResponse copies no response headers", got)
	}
	if got := response.Header.Get("Set-Cookie"); got != "" {
		t.Fatalf("proxied response leaked upstream Set-Cookie = %q; forwardFetchResponse copies no response headers", got)
	}
	corsProxyAssertNoContentType(t, response, "binary response")
	if response.ContentLength != -1 || len(response.TransferEncoding) == 0 || response.TransferEncoding[0] != "chunked" {
		t.Fatalf("successful proxied response framing = content-length %d, transfer-encoding %v; pinned streams the body, so the probe recorded chunked framing and no content-length", response.ContentLength, response.TransferEncoding)
	}
}

func TestCorsProxyCopiesNoUpstreamResponseHeadersAndKeepsTheStatus(t *testing.T) {
	upstream := newCorsProxyTestUpstream(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.Header().Set("X-Secret", "leak")
		w.Header().Set("Set-Cookie", "a=b")
		w.Header().Set("Content-Language", "en")
		w.WriteHeader(http.StatusNotFound)
		_, _ = io.WriteString(w, "missing")
	})
	handler := newCorsProxyTestHandler(t, true)
	response, body := corsProxyPerform(t, handler, http.MethodGet, corsProxyTargetPath(handler, upstream.server.URL+"/notfound"), nil, nil)
	if response.StatusCode != http.StatusNotFound {
		t.Fatalf("upstream 404 answered %d; forwardFetchResponse sets statusCode from the upstream", response.StatusCode)
	}
	if string(body) != "missing" {
		t.Fatalf("error body = %q; forwardFetchResponse ends the response with the upstream error text", body)
	}
	for _, name := range []string{"X-Secret", "Set-Cookie", "Content-Language"} {
		if got := response.Header.Get(name); got != "" {
			t.Fatalf("proxied response leaked upstream %s = %q; forwardFetchResponse copies no response headers", name, got)
		}
	}
	corsProxyAssertNoContentType(t, response, "upstream 404")
	if response.ContentLength != int64(len("missing")) {
		t.Fatalf("error body content-length = %d; pinned ends the response with the error text, which node labels with its length (%d)", response.ContentLength, len("missing"))
	}
}

func TestCorsProxyMapsAnUpstream401To400(t *testing.T) {
	upstream := newCorsProxyTestUpstream(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = io.WriteString(w, "nope")
	})
	handler := newCorsProxyTestHandler(t, true)
	response, body := corsProxyPerform(t, handler, http.MethodGet, corsProxyTargetPath(handler, upstream.server.URL+"/unauth"), nil, nil)
	if response.StatusCode != http.StatusBadRequest {
		t.Fatalf("upstream 401 answered %d; forwardFetchResponse rewrites 401 to 400 so the client's Basic auth is not reset (util.js:741-743)", response.StatusCode)
	}
	if string(body) != "nope" {
		t.Fatalf("401 body = %q; want the upstream body %q", body, "nope")
	}
	corsProxyAssertNoContentType(t, response, "upstream 401")
}

func TestCorsProxyDecompressesAGzipUpstreamResponse(t *testing.T) {
	upstream := newCorsProxyTestUpstream(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Encoding", "gzip")
		var compressed bytes.Buffer
		writer := gzip.NewWriter(&compressed)
		_, _ = io.WriteString(writer, "hello gzip")
		_ = writer.Close()
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(compressed.Bytes())
	})
	handler := newCorsProxyTestHandler(t, true)
	response, body := corsProxyPerform(t, handler, http.MethodGet, corsProxyTargetPath(handler, upstream.server.URL+"/gzip"), nil, nil)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("gzip response status = %d", response.StatusCode)
	}
	if string(body) != "hello gzip" {
		t.Fatalf("gzip body = %q; node-fetch decompresses the upstream body before forwardFetchResponse streams it", body)
	}
	if got := response.Header.Get("Content-Encoding"); got != "" {
		t.Fatalf("proxied response Content-Encoding = %q; forwardFetchResponse copies no response headers", got)
	}
	corsProxyAssertNoContentType(t, response, "gzip response")
}

func TestCorsProxyDecompressesADeflateUpstreamResponse(t *testing.T) {
	upstream := newCorsProxyTestUpstream(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Encoding", "deflate")
		var compressed bytes.Buffer
		writer := zlib.NewWriter(&compressed)
		_, _ = io.WriteString(writer, "hello deflate")
		_ = writer.Close()
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(compressed.Bytes())
	})
	handler := newCorsProxyTestHandler(t, true)
	response, body := corsProxyPerform(t, handler, http.MethodGet, corsProxyTargetPath(handler, upstream.server.URL+"/deflate"), nil, nil)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("deflate response status = %d", response.StatusCode)
	}
	if string(body) != "hello deflate" {
		t.Fatalf("deflate body = %q; node-fetch decompresses zlib-wrapped deflate", body)
	}
	if got := response.Header.Get("Content-Encoding"); got != "" {
		t.Fatalf("proxied response Content-Encoding = %q; forwardFetchResponse copies no response headers", got)
	}
	corsProxyAssertNoContentType(t, response, "deflate response")
}

// NAMED DIVERGENCE: pinned's node-fetch decodes br, so pinned answers 200 with the decompressed body.
// Go's standard library has no brotli decoder and this project may not add a dependency. The forced
// accept-encoding still advertises br (that is the pinned wire value); a br reply to a SAFE method is
// retried once without br (the next test), and a request with side effects is refused with the same 500
// shape as any other upstream failure instead of being served as compressed garbage or re-sent.
func TestCorsProxyRefusesABrotliResponseItCannotDecodeForAMutatingMethod(t *testing.T) {
	upstream := newCorsProxyTestUpstream(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Encoding", "br")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte{0x1b, 0x2e, 0x00, 0xe2, 0x9c, 0x00, 0xde, 0xad})
	})
	handler := newCorsProxyTestHandler(t, true)
	response, body := corsProxyPerform(t, handler, http.MethodPost,
		corsProxyTargetPath(handler, upstream.server.URL+"/brotli"),
		map[string]string{"Content-Type": "application/json"}, []byte(`{"a":1}`))
	if response.StatusCode != http.StatusInternalServerError || string(body) != "Internal Server Error" {
		t.Fatalf("br response to POST = %d %q; this build cannot decode br and refuses it instead of re-sending a mutating request", response.StatusCode, body)
	}
	if observed := upstream.observed(); len(observed) != 1 {
		t.Fatalf("the upstream observed %d requests; a POST whose reply is br must NOT be retried (a second POST could duplicate the mutation)", len(observed))
	}
}

// The Cloudflare case: an origin chooses br when it is offered. The pinned wire value offers br on the
// first request, and a GET/HEAD reply in br is retried once with `gzip, deflate`, so the client gets a
// decodable body instead of a 500. A side-effect-free method may be re-sent; the retry's accept-encoding
// is the only header that changes.
func TestCorsProxyRetriesASafeRequestWithoutBrotliWhenTheUpstreamAnswersBr(t *testing.T) {
	var mutex sync.Mutex
	encodings := make([]string, 0, 2)
	upstream := newCorsProxyTestUpstream(t, func(w http.ResponseWriter, r *http.Request) {
		accepted := r.Header.Get("Accept-Encoding")
		mutex.Lock()
		encodings = append(encodings, accepted)
		mutex.Unlock()
		if strings.Contains(accepted, "br") {
			w.Header().Set("Content-Encoding", "br")
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte{0x1b, 0x2e, 0x00, 0xe2, 0x9c, 0x00, 0xde, 0xad})
			return
		}
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, "fallback plain")
	})
	handler := newCorsProxyTestHandler(t, true)
	response, body := corsProxyPerform(t, handler, http.MethodGet,
		corsProxyTargetPath(handler, upstream.server.URL+"/cdn"), nil, nil)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("GET through a br-answering origin answered %d %q; a safe request must be retried without br", response.StatusCode, body)
	}
	if string(body) != "fallback plain" {
		t.Fatalf("client body = %q; want the retry's decodable %q", body, "fallback plain")
	}
	mutex.Lock()
	observedEncodings := append([]string(nil), encodings...)
	mutex.Unlock()
	if len(observedEncodings) != 2 {
		t.Fatalf("upstream observed %d requests (%v); want exactly 2: the br attempt and the retry", len(observedEncodings), observedEncodings)
	}
	if observedEncodings[0] != pinnedCorsProxyAcceptEncoding {
		t.Fatalf("first attempt Accept-Encoding = %q; pinned forces %q", observedEncodings[0], pinnedCorsProxyAcceptEncoding)
	}
	if observedEncodings[1] != "gzip, deflate" {
		t.Fatalf("retry Accept-Encoding = %q; the retry must drop only br", observedEncodings[1])
	}
}

// Pinned installs its private request filter on the GLOBAL http/https agents (src/private-request-filter.js:252-255),
// so an operator who enables privateAddressWhitelist expects /proxy to honour it too. This build applies the
// same policy through outbound.UserURLDialContext; without it, enabling the filter would silently not
// constrain /proxy — a security divergence in the unsafe direction.
func TestCorsProxyHonoursTheConfiguredPrivateAddressFilterLikePinned(t *testing.T) {
	t.Cleanup(outbound.DisablePrivateAddressFilter)
	upstream := newCorsProxyTestUpstream(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, "loopback")
	})
	handler := newCorsProxyTestHandler(t, true)

	// Pinned's default: the filter is disabled, so a loopback target is proxied (local model servers).
	response, body := corsProxyPerform(t, handler, http.MethodGet, corsProxyTargetPath(handler, upstream.server.URL+"/local"), nil, nil)
	if response.StatusCode != http.StatusOK || string(body) != "loopback" {
		t.Fatalf("with the private filter disabled (pinned's default) loopback proxying = %d %q; want 200 %q", response.StatusCode, body, "loopback")
	}

	if err := outbound.ConfigurePrivateAddressFilter(outbound.PrivateAddressFilterOptions{
		Enabled:       true,
		AllowedRanges: []string{"10.0.0.0/8"},
		LogBlocked:    false,
		LogAllowed:    false,
	}); err != nil {
		t.Fatalf("ConfigurePrivateAddressFilter: %v", err)
	}
	// The first (allowed) request pooled a loopback socket. Production installs the filter at BOOT, before
	// any request, so no socket can predate the policy; drop the idle connection so this row tests the
	// policy instead of a reused socket (the same trap the provider-filter boot test names).
	corsProxyHTTPClient().CloseIdleConnections()
	blocked, blockedBody := corsProxyPerform(t, handler, http.MethodGet, corsProxyTargetPath(handler, upstream.server.URL+"/local"), nil, nil)
	if blocked.StatusCode != http.StatusInternalServerError || string(blockedBody) != "Internal Server Error" {
		t.Fatalf("with privateAddressWhitelist enabled and loopback NOT allowed, /proxy to 127.0.0.1 = %d %q; pinned's global agent blocks it, so this route must too", blocked.StatusCode, blockedBody)
	}
	if observed := upstream.observed(); len(observed) != 1 {
		t.Fatalf("the upstream observed %d requests; the blocked dial must not reach the upstream", len(observed))
	}
}

func TestCorsProxyFollowsARedirectChain(t *testing.T) {
	upstream := newCorsProxyTestUpstream(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/redirect1":
			w.Header().Set("Location", "/redirect2")
			w.WriteHeader(http.StatusFound)
		case "/redirect2":
			w.Header().Set("Location", "/final")
			w.WriteHeader(http.StatusMovedPermanently)
		default:
			w.WriteHeader(http.StatusOK)
			_, _ = io.WriteString(w, "final")
		}
	})
	handler := newCorsProxyTestHandler(t, true)
	response, body := corsProxyPerform(t, handler, http.MethodGet, corsProxyTargetPath(handler, upstream.server.URL+"/redirect1"), nil, nil)
	if response.StatusCode != http.StatusOK || string(body) != "final" {
		t.Fatalf("redirect chain = %d %q; want the final 200 %q", response.StatusCode, body, "final")
	}
	observed := upstream.observed()
	if len(observed) != 3 {
		t.Fatalf("upstream observed %d hops; want 3 (/redirect1, /redirect2, /final)", len(observed))
	}
	for index, want := range []string{"/redirect1", "/redirect2", "/final"} {
		if observed[index].RequestURI != want {
			t.Fatalf("hop %d = %q; want %q", index, observed[index].RequestURI, want)
		}
		if observed[index].Method != http.MethodGet {
			t.Fatalf("hop %d method = %q; want GET", index, observed[index].Method)
		}
	}
}

func TestCorsProxyPreservesPutAcrossA302RedirectLikeNodeFetch(t *testing.T) {
	upstream := newCorsProxyTestUpstream(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/put-redirect" {
			w.Header().Set("Location", "/echo")
			w.WriteHeader(http.StatusFound)
			return
		}
		w.WriteHeader(http.StatusOK)
	})
	handler := newCorsProxyTestHandler(t, true)
	response, _ := corsProxyPerform(t, handler, http.MethodPut, corsProxyTargetPath(handler, upstream.server.URL+"/put-redirect"),
		map[string]string{"Content-Type": "application/json"}, []byte(`{"a":1}`))
	if response.StatusCode != http.StatusOK {
		t.Fatalf("PUT redirect answered %d", response.StatusCode)
	}
	observed := upstream.observed()
	if len(observed) != 2 {
		t.Fatalf("upstream observed %d hops; want 2", len(observed))
	}
	// node-fetch rewrites a 301/302 to GET only when the method was POST (src/index.js:223); for PUT it
	// keeps the method AND re-sends the clone of the body. Go's client rewrites every non-GET/HEAD
	// method, which is the divergence corsProxyCheckRedirect restores.
	if observed[1].Method != http.MethodPut {
		t.Fatalf("redirected hop method = %q; node-fetch preserves PUT across 302", observed[1].Method)
	}
	if string(observed[1].Body) != `{"a":1}` {
		t.Fatalf("redirected hop body = %q; node-fetch re-sends the PUT body across 302", observed[1].Body)
	}
}

func TestCorsProxyRewritesAPostToGetAcrossA302(t *testing.T) {
	upstream := newCorsProxyTestUpstream(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/post-redirect" {
			w.Header().Set("Location", "/echo")
			w.WriteHeader(http.StatusFound)
			return
		}
		w.WriteHeader(http.StatusOK)
	})
	handler := newCorsProxyTestHandler(t, true)
	response, _ := corsProxyPerform(t, handler, http.MethodPost, corsProxyTargetPath(handler, upstream.server.URL+"/post-redirect"),
		map[string]string{"Content-Type": "application/json"}, []byte(`{"a":1}`))
	if response.StatusCode != http.StatusOK {
		t.Fatalf("POST redirect answered %d", response.StatusCode)
	}
	observed := upstream.observed()
	if len(observed) != 2 {
		t.Fatalf("upstream observed %d hops; want 2", len(observed))
	}
	if observed[1].Method != http.MethodGet {
		t.Fatalf("redirected POST hop method = %q; node-fetch rewrites a 301/302 POST to GET", observed[1].Method)
	}
	if len(observed[1].Body) != 0 {
		t.Fatalf("redirected POST hop body = %q; the rewritten GET carries no body", observed[1].Body)
	}
}

// ---------------------------------------------------------------- refusals and failures

func TestCorsProxyRefusesCircularRequestsWithThePinnedBody(t *testing.T) {
	upstream := newCorsProxyTestUpstream(t, func(w http.ResponseWriter, _ *http.Request) {
		t.Error("a circular target reached an upstream")
	})
	handler := newCorsProxyTestHandler(t, true)
	target := handler.URL + "/anything"
	response, body := corsProxyPerform(t, handler, http.MethodGet, corsProxyTargetPath(handler, target), nil, nil)
	if response.StatusCode != http.StatusBadRequest {
		t.Fatalf("circular target answered %d; pinned answers 400 (corsProxy.js:14-16)", response.StatusCode)
	}
	if string(body) != pinnedCorsProxyCircularMessage {
		t.Fatalf("circular body = %q; want %q", body, pinnedCorsProxyCircularMessage)
	}
	if got := response.Header.Get("Content-Type"); got != "text/html; charset=utf-8" {
		t.Fatalf("circular Content-Type = %q; Express res.send(string) answers text/html; charset=utf-8", got)
	}
	if len(upstream.observed()) != 0 {
		t.Fatalf("circular target forwarded %d request(s)", len(upstream.observed()))
	}
}

func TestCorsProxyBarePathIsNotTheProxyMount(t *testing.T) {
	handler := newCorsProxyTestHandler(t, true)
	response, body := corsProxyPerform(t, handler, http.MethodGet, handler.URL+"/proxy", nil, nil)
	if response.StatusCode == http.StatusMovedPermanently || response.StatusCode == http.StatusFound {
		t.Fatalf("GET /proxy answered a redirect (%d); express's /proxy/:url(*) does not match the bare path, which reaches the pinned 404 page", response.StatusCode)
	}
	if response.StatusCode != http.StatusNotFound {
		t.Fatalf("GET /proxy answered %d; pinned answers its 404 page", response.StatusCode)
	}
	if string(body) != "<html>pinned 404 page</html>" {
		t.Fatalf("GET /proxy body = %q; want the pinned 404 page", body)
	}
	// /proxy/ with an empty target IS matched, and fetch('') throws -> 500.
	empty, emptyBody := corsProxyPerform(t, handler, http.MethodGet, handler.URL+"/proxy/", nil, nil)
	if empty.StatusCode != http.StatusInternalServerError || string(emptyBody) != "Internal Server Error" {
		t.Fatalf("GET /proxy/ = %d %q; pinned's fetch('') throws and corsProxy answers 500 %q", empty.StatusCode, emptyBody, "Internal Server Error")
	}
}

func TestCorsProxyAnswers500WhenTheUpstreamConnectionFails(t *testing.T) {
	upstream := newCorsProxyTestUpstream(t, func(http.ResponseWriter, *http.Request) {})
	closedPort := upstream.server.Listener.Addr().(*net.TCPAddr).Port
	upstream.server.Close()

	handler := newCorsProxyTestHandler(t, true)
	target := fmt.Sprintf("http://127.0.0.1:%d/x", closedPort)
	response, body := corsProxyPerform(t, handler, http.MethodGet, corsProxyTargetPath(handler, target), nil, nil)
	if response.StatusCode != http.StatusInternalServerError {
		t.Fatalf("unreachable upstream answered %d; corsProxy.js catches the fetch error and sendStatus(500)", response.StatusCode)
	}
	if string(body) != "Internal Server Error" {
		t.Fatalf("unreachable upstream body = %q; res.sendStatus(500) answers %q", body, "Internal Server Error")
	}
	if got := response.Header.Get("Content-Type"); got != "text/plain; charset=utf-8" {
		t.Fatalf("unreachable upstream Content-Type = %q; res.sendStatus(500) answers text/plain; charset=utf-8", got)
	}
}

func TestCorsProxyRejectsANonHTTPSchemeLikePinned(t *testing.T) {
	handler := newCorsProxyTestHandler(t, true)
	response, body := corsProxyPerform(t, handler, http.MethodGet, handler.URL+"/proxy/"+url.PathEscape("file:///etc/passwd"), nil, nil)
	if response.StatusCode != http.StatusInternalServerError || string(body) != "Internal Server Error" {
		t.Fatalf("file: target = %d %q; node-fetch rejects the scheme and pinned answers 500 %q", response.StatusCode, body, "Internal Server Error")
	}
}

func TestCorsProxyRefusesInvalidJSONBeforeItForwards(t *testing.T) {
	upstream := newCorsProxyTestUpstream(t, func(http.ResponseWriter, *http.Request) {
		t.Error("an invalid JSON body reached the proxy's upstream")
	})
	handler := newCorsProxyTestHandler(t, true)
	response, body := corsProxyPerform(t, handler, http.MethodPost, corsProxyTargetPath(handler, upstream.server.URL+"/echo"),
		map[string]string{"Content-Type": "application/json"}, []byte(`{"a":`))
	if response.StatusCode != http.StatusBadRequest {
		t.Fatalf("invalid JSON answered %d; body-parser runs before the proxy mount and answers 400 (server-main.js:110)", response.StatusCode)
	}
	if !bytes.Contains(body, []byte("Bad Request")) {
		t.Fatalf("invalid JSON body = %q; the finalhandler document carries the status text", body)
	}
	if got := response.Header.Get("Content-Type"); got != "text/html; charset=utf-8" {
		t.Fatalf("invalid JSON Content-Type = %q; express finalhandler answers text/html; charset=utf-8", got)
	}
	if got := response.Header.Get("Content-Security-Policy"); got != "default-src 'none'" {
		t.Fatalf("invalid JSON Content-Security-Policy = %q; finalhandler sets %q", got, "default-src 'none'")
	}
	if len(upstream.observed()) != 0 {
		t.Fatalf("invalid JSON forwarded %d request(s)", len(upstream.observed()))
	}
}

// ---------------------------------------------------------------- SSRF policy

func corsProxyInstallNetworkSeams(t *testing.T, resolve func(context.Context, string) ([]netip.Addr, error), dial func(context.Context, string, string) (net.Conn, error)) {
	t.Helper()
	originalResolve := corsProxyResolveAddresses
	originalDial := corsProxyDialAddress
	if resolve != nil {
		corsProxyResolveAddresses = resolve
	}
	if dial != nil {
		corsProxyDialAddress = dial
	}
	t.Cleanup(func() {
		corsProxyResolveAddresses = originalResolve
		corsProxyDialAddress = originalDial
	})
}

func TestCorsProxyRefusesCloudMetadataLiteralTargets(t *testing.T) {
	var dialled int32
	corsProxyInstallNetworkSeams(t, nil, func(context.Context, string, string) (net.Conn, error) {
		atomic.AddInt32(&dialled, 1)
		return nil, fmt.Errorf("test dial must not happen")
	})
	handler := newCorsProxyTestHandler(t, true)
	for _, target := range []string{
		"http://169.254.169.254/latest/meta-data/",
		"http://169.254.170.2/v2/credentials",
		"http://[::ffff:169.254.169.254]/latest/meta-data/",
		"http://100.100.100.200/latest/meta-data/",
	} {
		response, body := corsProxyPerform(t, handler, http.MethodGet, corsProxyTargetPath(handler, target), nil, nil)
		if response.StatusCode != http.StatusInternalServerError || string(body) != "Internal Server Error" {
			t.Fatalf("%s answered %d %q; the cloud metadata refusal must fail like any upstream failure", target, response.StatusCode, body)
		}
	}
	if dialled != 0 {
		t.Fatalf("the proxy dialled a cloud metadata address %d time(s); the refusal must happen before the socket", dialled)
	}
}

func TestCorsProxyRefusesAHostnameThatResolvesToCloudMetadata(t *testing.T) {
	var dialled int32
	corsProxyInstallNetworkSeams(t,
		func(_ context.Context, host string) ([]netip.Addr, error) {
			if host != "metadata.test" {
				return nil, fmt.Errorf("unexpected lookup for %s", host)
			}
			return []netip.Addr{netip.MustParseAddr("169.254.169.254")}, nil
		},
		func(context.Context, string, string) (net.Conn, error) {
			atomic.AddInt32(&dialled, 1)
			return nil, fmt.Errorf("test dial must not happen")
		})
	handler := newCorsProxyTestHandler(t, true)
	response, body := corsProxyPerform(t, handler, http.MethodGet, corsProxyTargetPath(handler, "http://metadata.test/latest/meta-data/"), nil, nil)
	if response.StatusCode != http.StatusInternalServerError || string(body) != "Internal Server Error" {
		t.Fatalf("metadata hostname answered %d %q; want 500 Internal Server Error", response.StatusCode, body)
	}
	if dialled != 0 {
		t.Fatalf("the proxy dialled a hostname that resolved to a cloud metadata address")
	}
}

func TestCorsProxyRefusesARedirectToCloudMetadata(t *testing.T) {
	upstream := newCorsProxyTestUpstream(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Location", "http://metadata.test/latest/meta-data/")
		w.WriteHeader(http.StatusFound)
	})
	var dialledToMetadata int32
	originalDial := corsProxyDialAddress
	corsProxyInstallNetworkSeams(t,
		func(_ context.Context, host string) ([]netip.Addr, error) {
			if host != "metadata.test" {
				return nil, fmt.Errorf("unexpected lookup for %s", host)
			}
			return []netip.Addr{netip.MustParseAddr("169.254.169.254")}, nil
		},
		func(ctx context.Context, network, address string) (net.Conn, error) {
			if strings.HasPrefix(address, "169.254.169.254:") {
				atomic.AddInt32(&dialledToMetadata, 1)
				return nil, fmt.Errorf("test dial must not happen")
			}
			return originalDial(ctx, network, address)
		})
	handler := newCorsProxyTestHandler(t, true)
	response, body := corsProxyPerform(t, handler, http.MethodGet, corsProxyTargetPath(handler, upstream.server.URL+"/to-metadata"), nil, nil)
	if response.StatusCode != http.StatusInternalServerError || string(body) != "Internal Server Error" {
		t.Fatalf("redirect to metadata answered %d %q; want 500 Internal Server Error", response.StatusCode, body)
	}
	if dialledToMetadata != 0 {
		t.Fatalf("the proxy dialled the metadata address a redirect pointed at")
	}
}

func TestCorsProxyDialsOnlyAnAddressItChecked(t *testing.T) {
	upstream := newCorsProxyTestUpstream(t, func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })
	port := upstream.server.Listener.Addr().(*net.TCPAddr).Port
	var dialled []string
	var mutex sync.Mutex
	originalDial := corsProxyDialAddress
	corsProxyInstallNetworkSeams(t,
		func(_ context.Context, host string) ([]netip.Addr, error) {
			if host != "rebind.test" {
				return nil, fmt.Errorf("unexpected lookup for %s", host)
			}
			return []netip.Addr{
				netip.MustParseAddr("169.254.169.254"),
				netip.MustParseAddr("127.0.0.1"),
			}, nil
		},
		func(ctx context.Context, network, address string) (net.Conn, error) {
			mutex.Lock()
			dialled = append(dialled, address)
			mutex.Unlock()
			return originalDial(ctx, network, address)
		})

	handler := newCorsProxyTestHandler(t, true)
	target := fmt.Sprintf("http://rebind.test:%d/echo", port)
	response, body := corsProxyPerform(t, handler, http.MethodGet, corsProxyTargetPath(handler, target), nil, nil)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("rebinding host answered %d %q; the reactor must dial the checked public address", response.StatusCode, body)
	}
	mutex.Lock()
	defer mutex.Unlock()
	if len(dialled) != 1 || dialled[0] != fmt.Sprintf("127.0.0.1:%d", port) {
		t.Fatalf("dialled %v; the proxy must dial exactly the checked non-metadata address, never the metadata candidate", dialled)
	}
	observed := upstream.observed()
	if len(observed) != 1 {
		t.Fatalf("upstream observed %d requests; want 1", len(observed))
	}
	if want := fmt.Sprintf("rebind.test:%d", port); observed[0].Host != want {
		t.Fatalf("upstream Host = %q; want the target authority %q (DNS rebinding must not rewrite Host)", observed[0].Host, want)
	}
}

// ---------------------------------------------------------------- bounds and concurrency

func TestCorsProxyBodyIdleBoundEndsAStalledResponse(t *testing.T) {
	originalIdle := corsProxyBodyIdleTimeout
	corsProxyBodyIdleTimeout = 150 * time.Millisecond
	t.Cleanup(func() { corsProxyBodyIdleTimeout = originalIdle })

	upstream := newCorsProxyTestUpstream(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, "partial")
		if flusher, ok := w.(http.Flusher); ok {
			flusher.Flush()
		}
		select {
		case <-r.Context().Done():
		case <-time.After(5 * time.Second):
		}
	})
	handler := newCorsProxyTestHandler(t, true)
	started := time.Now()
	response, body := corsProxyPerform(t, handler, http.MethodGet, corsProxyTargetPath(handler, upstream.server.URL+"/stall"), nil, nil)
	elapsed := time.Since(started)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("stalled upstream status = %d", response.StatusCode)
	}
	if elapsed > 5*time.Second {
		t.Fatalf("a stalled upstream body was not bounded: the request took %s; the body-idle bound is %s", elapsed, corsProxyBodyIdleTimeout)
	}
	if !strings.HasPrefix(string(body), "partial") {
		t.Fatalf("stalled response body = %q; the bytes received before the bound fired must reach the client", body)
	}
}

func TestCorsProxyConcurrentRequestsStayIsolated(t *testing.T) {
	upstream := newCorsProxyTestUpstream(t, func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		_, _ = fmt.Fprintf(w, "%s|%s|%s", r.Method, r.URL.RequestURI(), body)
	})
	handler := newCorsProxyTestHandler(t, true)

	// A goroutine-safe request helper: t.Fatalf must not be called from a non-test goroutine, so the
	// concurrent test reports through a channel and fails on the test goroutine.
	perform := func(method, requestURL string, headers map[string]string, body []byte) (int, string, error) {
		var reader io.Reader
		if body != nil {
			reader = bytes.NewReader(body)
		}
		request, err := http.NewRequest(method, requestURL, reader)
		if err != nil {
			return 0, "", err
		}
		for name, value := range headers {
			request.Header.Set(name, value)
		}
		response, err := (&http.Client{Timeout: 20 * time.Second}).Do(request)
		if err != nil {
			return 0, "", err
		}
		defer response.Body.Close()
		payload, err := io.ReadAll(response.Body)
		if err != nil {
			return 0, "", err
		}
		return response.StatusCode, string(payload), nil
	}

	const parallel = 8
	var wait sync.WaitGroup
	failures := make(chan string, parallel*2)
	for index := 0; index < parallel; index++ {
		index := index
		wait.Add(2)
		go func() {
			defer wait.Done()
			want := fmt.Sprintf("GET|/echo?i=%d|", index)
			status, body, err := perform(http.MethodGet, corsProxyTargetPath(handler, fmt.Sprintf("%s/echo?i=%d", upstream.server.URL, index)), nil, nil)
			if err != nil || status != http.StatusOK || body != want {
				failures <- fmt.Sprintf("GET %d = %d %q err=%v; want 200 %q", index, status, body, err, want)
			}
		}()
		go func() {
			defer wait.Done()
			want := fmt.Sprintf("POST|/echo|{\"i\":%d}", index)
			status, body, err := perform(http.MethodPost, corsProxyTargetPath(handler, upstream.server.URL+"/echo"),
				map[string]string{"Content-Type": "application/json"}, []byte(fmt.Sprintf(`{"i":%d}`, index)))
			if err != nil || status != http.StatusOK || body != want {
				failures <- fmt.Sprintf("POST %d = %d %q err=%v; want 200 %q", index, status, body, err, want)
			}
		}()
	}
	wait.Wait()
	close(failures)
	for failure := range failures {
		t.Fatal(failure)
	}
}
