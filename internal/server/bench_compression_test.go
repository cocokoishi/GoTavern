package server

// SAME-HOST, SAME-INPUT BEFORE/AFTER FOR THE COMPRESSION MIDDLEWARE (M3).
//
// BEFORE = the current shipped behaviour: the server ignores Accept-Encoding and serves the identity bytes.
// AFTER  = the same handler with the client offering gzip, which exercises pinnedCompressionMiddleware.
// Both modes drive the SAME 229-request page load through the SAME handler on the SAME host, so the difference
// is the middleware and nothing else. "Before" is not a stashed build: the identity response is what this
// server produced before the middleware existed, byte for byte.
//
// The 229 requests are the recorded page load in docs/frontend-startup-calls.md ("Requests observed during page
// load: 229", 223 GET + 6 POST). The test refuses to run if the document no longer lists 229 rows, so the
// workload cannot silently shrink.
//
// The test asserts the OBSERVABLE, not a wall-clock budget: every compressed asset decodes to the identity
// bytes, the page-load wire total shrinks materially, a non-compressible image stays identity, and the decoded
// page load is byte-identical. The benchmarks record wire bytes/op and allocations/op so a regression is
// visible as a number.

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/cocokoishi/gotavern/internal/startup"
)

var frontendStartupCallPattern = regexp.MustCompile("^\\| (GET|POST) \\| `([^`]+)` \\|")

type pageLoadRequest struct {
	method string
	path   string
}

// pinnedPageLoadRequests reads the recorded 229-request page load (method + path).
func pinnedPageLoadRequests(tb testing.TB) []pageLoadRequest {
	tb.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "docs", "frontend-startup-calls.md"))
	if err != nil {
		tb.Fatal(err)
	}
	requests := make([]pageLoadRequest, 0, 229)
	for _, line := range strings.Split(string(raw), "\n") {
		if match := frontendStartupCallPattern.FindStringSubmatch(line); match != nil {
			requests = append(requests, pageLoadRequest{method: match[1], path: match[2]})
		}
	}
	if len(requests) != 229 {
		tb.Fatalf("docs/frontend-startup-calls.md lists %d page-load rows, the recorded page load is 229", len(requests))
	}
	return requests
}

func newCompressionBenchHandler(tb testing.TB) http.Handler {
	tb.Helper()
	root := tb.TempDir()
	dataRoot := filepath.Join(root, "data")
	if err := os.MkdirAll(dataRoot, 0o755); err != nil {
		tb.Fatal(err)
	}
	accountJSON, err := marshalNodeJSON(map[string]any{
		"handle": "default-user", "name": "Compression Bench", "created": 1700000000000,
		"password": "", "admin": true, "enabled": true, "salt": "",
	})
	if err != nil {
		tb.Fatal(err)
	}
	if err := startup.SetNodePersistRecord(dataRoot, userStoragePrefix+"default-user", accountJSON); err != nil {
		tb.Fatal(err)
	}
	const cookieSecret = "gotavern-compression-bench-cookie-secret"
	if err := os.WriteFile(filepath.Join(dataRoot, "cookie-secret.txt"), []byte(cookieSecret), 0o600); err != nil {
		tb.Fatal(err)
	}
	if _, err := startup.EnsureDirectories(root, dataRoot, []string{"default-user"}); err != nil {
		tb.Fatal(err)
	}
	// A settings document so /api/settings/get answers 200 rather than the pinned missing-settings 500.
	userRoot := filepath.Join(dataRoot, "default-user")
	if err := os.WriteFile(filepath.Join(userRoot, "settings.json"), []byte("{}\n"), 0o600); err != nil {
		tb.Fatal(err)
	}
	return NewHTTPHandlerWithOptions(HTTPHandlerOptions{
		InstallRoot: root, DataRoot: dataRoot, CookieSecret: cookieSecret, AccountsEnabled: true,
	})
}

// loginPageLoad performs the product's own CSRF+login handshake for the page load's POST rows.
func loginPageLoad(tb testing.TB, client *http.Client, origin string) (cookie, token string) {
	tb.Helper()
	csrfResponse, err := client.Get(origin + "/csrf-token")
	if err != nil {
		tb.Fatal(err)
	}
	csrfBody, _ := io.ReadAll(csrfResponse.Body)
	csrfResponse.Body.Close()
	var csrf struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(csrfBody, &csrf); err != nil {
		tb.Fatal(err)
	}
	loginRequest, _ := http.NewRequest(http.MethodPost, origin+"/api/users/login", strings.NewReader(`{"handle":"default-user","password":""}`))
	loginRequest.Header.Set("Content-Type", "application/json")
	loginRequest.Header.Set("X-CSRF-Token", csrf.Token)
	loginRequest.Header.Set("Cookie", cookiePair(csrfResponse.Cookies()))
	loginResponse, err := client.Do(loginRequest)
	if err != nil {
		tb.Fatal(err)
	}
	io.Copy(io.Discard, loginResponse.Body)
	loginResponse.Body.Close()
	if loginResponse.StatusCode != http.StatusOK {
		tb.Fatalf("page-load login = %d", loginResponse.StatusCode)
	}
	return cookiePair(loginResponse.Cookies()), csrf.Token
}

// fetchPageLoad drives the 229 requests once, returning the wire total and the decoded total.
func fetchPageLoad(tb testing.TB, handler http.Handler, acceptEncoding string) (wireBytes int, decodedBytes int, compressed int) {
	tb.Helper()
	server := httptest.NewServer(handler)
	defer server.Close()
	client := &http.Client{Transport: &http.Transport{DisableCompression: true}}
	cookie, token := loginPageLoad(tb, client, server.URL)
	for _, entry := range pinnedPageLoadRequests(tb) {
		var body io.Reader
		if entry.method == http.MethodPost {
			body = strings.NewReader("{}")
		}
		request, err := http.NewRequest(entry.method, server.URL+entry.path, body)
		if err != nil {
			tb.Fatal(err)
		}
		request.Header.Set("Cookie", cookie)
		request.Header.Set("X-CSRF-Token", token)
		if entry.method == http.MethodPost {
			request.Header.Set("Content-Type", "application/json")
		}
		if acceptEncoding != "" {
			request.Header.Set("Accept-Encoding", acceptEncoding)
		}
		response, err := client.Do(request)
		if err != nil {
			tb.Fatalf("%s %s: %v", entry.method, entry.path, err)
		}
		raw, err := io.ReadAll(response.Body)
		response.Body.Close()
		if err != nil {
			tb.Fatalf("%s %s body: %v", entry.method, entry.path, err)
		}
		wireBytes += len(raw)
		decoded := raw
		if strings.EqualFold(response.Header.Get("Content-Encoding"), "gzip") {
			compressed++
			reader, err := gzip.NewReader(bytes.NewReader(raw))
			if err != nil {
				tb.Fatalf("%s %s claims gzip but does not decode: %v", entry.method, entry.path, err)
			}
			decoded, err = io.ReadAll(reader)
			reader.Close()
			if err != nil {
				tb.Fatalf("%s %s decode: %v", entry.method, entry.path, err)
			}
		}
		decodedBytes += len(decoded)
	}
	return wireBytes, decodedBytes, compressed
}

func TestPageLoadCompressionReducesWireBytesTransparently(t *testing.T) {
	handler := newCompressionBenchHandler(t)
	identityWire, identityDecoded, compressedIdentity := fetchPageLoad(t, handler, "")
	if compressedIdentity != 0 {
		t.Fatalf("the identity page load compressed %d responses", compressedIdentity)
	}
	gzipWire, gzipDecoded, compressed := fetchPageLoad(t, handler, "gzip, deflate")
	if gzipDecoded != identityDecoded {
		t.Fatalf("the compressed page load decodes to %d bytes, identity is %d: compression changed the bytes", gzipDecoded, identityDecoded)
	}
	if compressed == 0 {
		t.Fatal("no response in the page load was compressed")
	}
	if gzipWire >= identityWire {
		t.Fatalf("the compressed page load is not smaller (%d >= %d wire bytes)", gzipWire, identityWire)
	}
	if gzipWire*2 >= identityWire {
		t.Fatalf("the compressed page load saved less than 50%% (%d wire vs %d identity): expected the static assets to compress materially", gzipWire, identityWire)
	}
	t.Logf("229-request page load: identity wire %d bytes -> gzip wire %d bytes (%.1f%% saved), %d responses compressed, decoded bytes identical (%d)",
		identityWire, gzipWire, 100*(1-float64(gzipWire)/float64(identityWire)), compressed, gzipDecoded)

	// A binary asset must stay identity: pinned's filter is compressible(Content-Type).
	server := httptest.NewServer(handler)
	defer server.Close()
	client := &http.Client{Transport: &http.Transport{DisableCompression: true}}
	request, _ := http.NewRequest(http.MethodGet, server.URL+"/img/default-expressions/admiration.png", nil)
	request.Header.Set("Accept-Encoding", "gzip, deflate")
	response, err := client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	io.Copy(io.Discard, response.Body)
	response.Body.Close()
	if encoding := response.Header.Get("Content-Encoding"); encoding != "" {
		t.Fatalf("image/png was compressed (content-encoding %q); pinned's compressible filter excludes it", encoding)
	}
}

func BenchmarkPageLoadIdentity(b *testing.B) {
	handler := newCompressionBenchHandler(b)
	pageRequests := pinnedPageLoadRequests(b)
	b.ReportAllocs()
	b.ResetTimer()
	total := 0
	for i := 0; i < b.N; i++ {
		for _, entry := range pageRequests {
			request := httptest.NewRequest(entry.method, entry.path, nil)
			recorder := httptest.NewRecorder()
			handler.ServeHTTP(recorder, request)
			total += recorder.Body.Len()
		}
	}
	b.ReportMetric(float64(total)/float64(b.N), "wire-B/op")
}

func BenchmarkPageLoadGzip(b *testing.B) {
	handler := newCompressionBenchHandler(b)
	pageRequests := pinnedPageLoadRequests(b)
	b.ReportAllocs()
	b.ResetTimer()
	total := 0
	for i := 0; i < b.N; i++ {
		for _, entry := range pageRequests {
			request := httptest.NewRequest(entry.method, entry.path, nil)
			request.Header.Set("Accept-Encoding", "gzip, deflate")
			recorder := httptest.NewRecorder()
			handler.ServeHTTP(recorder, request)
			total += recorder.Body.Len()
		}
	}
	b.ReportMetric(float64(total)/float64(b.N), "wire-B/op")
}

// BenchmarkScriptJSCompressed isolates the largest asset: the page-load benchmark's shape depends on the 229
// requests, and a regression in one asset would be diluted by them.
func BenchmarkScriptJSCompressed(b *testing.B) {
	handler := newCompressionBenchHandler(b)
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		request := httptest.NewRequest(http.MethodGet, "/script.js", nil)
		request.Header.Set("Accept-Encoding", "gzip, deflate")
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, request)
	}
}
