package server

// Replay of tools/probe-compression.mjs's contract: tests/oracle/sillytavern-1.19.0-compression.json.
//
// WHAT IS COMPARED, and why each comparison is the contract:
//   - status, content-encoding, content-length presence/value, vary, content-type, content-range;
//   - the DECODED body (sha256 + length), because pinned zlib and Go compress/gzip emit different deflate
//     streams: the raw compressed bytes are recorded as evidence but are NOT a byte-equality target;
//   - the one RECORDED DEVIATION, asserted on BOTH halves: pinned prefers `br` when the client offers it
//     (Node 24 has brotli), GoTavern answers `gzip` because it has no brotli encoder. A br-only client gets
//     identity from GoTavern; the probe records pinned's br and this test asserts the pinned half from the
//     fixture and the Go half from the live response.
//
// WHY THE CLIENT DISABLES COMPRESSION. Go's http.Client adds `Accept-Encoding: gzip` and transparently
// decompresses unless DisableCompression is set, which would hide the very headers this contract is about.

import (
	"bytes"
	"compress/gzip"
	"compress/zlib"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/cocokoishi/gotavern/internal/startup"
	"github.com/cocokoishi/gotavern/tests/mockprovider"
)

type compressionFixture struct {
	Baseline struct {
		Version string `json:"version"`
		Commit  string `json:"commit"`
	} `json:"baseline"`
	Middleware struct {
		ThresholdBytes int `json:"thresholdBytes"`
	} `json:"middleware"`
	Inputs struct {
		SettingsJSON string `json:"settingsJson"`
	} `json:"inputs"`
	Scenarios map[string]struct {
		Request struct {
			Method        string            `json:"method"`
			Path          string            `json:"path"`
			Headers       map[string]string `json:"headers"`
			Authenticated bool              `json:"authenticated"`
			Conditional   bool              `json:"conditional"`
			Body          string            `json:"body"`
		} `json:"request"`
		Response struct {
			Status           int     `json:"status"`
			ContentEncoding  *string `json:"contentEncoding"`
			TransferEncoding *string `json:"transferEncoding"`
			ContentLength    *string `json:"contentLength"`
			Vary             *string `json:"vary"`
			ContentType      *string `json:"contentType"`
			ContentRange     *string `json:"contentRange"`
		} `json:"response"`
		Raw struct {
			Bytes  int    `json:"bytes"`
			Sha256 string `json:"sha256"`
		} `json:"raw"`
		Decoded struct {
			Bytes  int     `json:"bytes"`
			Sha256 string  `json:"sha256"`
			Text   *string `json:"text"`
		} `json:"decoded"`
	} `json:"scenarios"`
}

func loadCompressionFixture(t *testing.T) compressionFixture {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-compression.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture compressionFixture
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	if fixture.Baseline.Version != "1.19.0" || fixture.Baseline.Commit != "06bde939fb1e9c4c8d8641d810f0a916b5bce127" {
		t.Fatalf("compression oracle baseline = %+v", fixture.Baseline)
	}
	if fixture.Middleware.ThresholdBytes != 1024 {
		t.Fatalf("compression oracle threshold = %d, pinned is 1024", fixture.Middleware.ThresholdBytes)
	}
	if len(fixture.Scenarios) < 10 {
		t.Fatalf("compression oracle records only %d scenarios; the contract is incomplete", len(fixture.Scenarios))
	}
	return fixture
}

// startCompressionTestServer builds the shipped handler over a temp tree with the SAME settings document the
// probe seeded, and performs the product's own CSRF+login handshake so authenticated scenarios are reachable.
func startCompressionTestServer(t *testing.T, settingsJSON string) (origin, cookie, token string) {
	t.Helper()
	root := t.TempDir()
	dataRoot := filepath.Join(root, "data")
	installRoot := root
	if err := os.MkdirAll(dataRoot, 0o755); err != nil {
		t.Fatal(err)
	}
	// The probe pins the two config knobs the settings aggregation echoes, so the recorded body is a compression
	// observation rather than GoTavern's auto-update-off product divergence. The replay writes the same file.
	if err := os.WriteFile(filepath.Join(root, "config.yaml"), []byte("enableUserAccounts: true\nextensions:\n  enabled: false\n  autoUpdate: false\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	accountJSON, err := marshalNodeJSON(map[string]any{
		"handle": "default-user", "name": "Compression", "created": 1700000000000,
		"password": "", "admin": true, "enabled": true, "salt": "",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := startup.SetNodePersistRecord(dataRoot, userStoragePrefix+"default-user", accountJSON); err != nil {
		t.Fatal(err)
	}
	const cookieSecret = "gotavern-compression-cookie-secret"
	if err := os.WriteFile(filepath.Join(dataRoot, "cookie-secret.txt"), []byte(cookieSecret), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := startup.EnsureDirectories(installRoot, dataRoot, []string{"default-user"}); err != nil {
		t.Fatal(err)
	}
	userRoot := filepath.Join(dataRoot, "default-user")
	if err := os.MkdirAll(userRoot, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(userRoot, "settings.json"), []byte(settingsJSON), 0o600); err != nil {
		t.Fatal(err)
	}
	// The pinned probe records ETag-present and the 304 revalidation contract, and the pinned middleware serves
	// <serverDirectory>/public FROM DISK, so the replay must do the same: the embedded tree has no mtime and
	// therefore no ETag. The bytes are the vendored upstream assets, which the asset-manifest gate keeps
	// byte-identical to the pinned checkout; the mtime is fixed so the ETag is a property of this test rather
	// than of the host.
	when := time.Unix(1700000000, 0)
	for _, relative := range []string{"script.js", "index.html", "img/default-expressions/admiration.png"} {
		content, err := os.ReadFile(filepath.Join("..", "..", "upstream", "public", filepath.FromSlash(relative)))
		if err != nil {
			t.Fatal(err)
		}
		target := filepath.Join(installRoot, "public", filepath.FromSlash(relative))
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(target, content, 0o644); err != nil {
			t.Fatal(err)
		}
		if err := os.Chtimes(target, when, when); err != nil {
			t.Fatal(err)
		}
	}
	handler := NewHTTPHandlerWithOptions(HTTPHandlerOptions{
		InstallRoot: installRoot, DataRoot: dataRoot, CookieSecret: cookieSecret, AccountsEnabled: true,
	})
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	client := &http.Client{Timeout: 30 * time.Second}
	csrfResponse, err := client.Get(server.URL + "/csrf-token")
	if err != nil {
		t.Fatal(err)
	}
	csrfBody, _ := io.ReadAll(csrfResponse.Body)
	csrfResponse.Body.Close()
	var csrf struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(csrfBody, &csrf); err != nil {
		t.Fatal(err)
	}
	loginRequest, _ := http.NewRequest(http.MethodPost, server.URL+"/api/users/login", strings.NewReader(`{"handle":"default-user","password":""}`))
	loginRequest.Header.Set("Content-Type", "application/json")
	loginRequest.Header.Set("X-CSRF-Token", csrf.Token)
	loginRequest.Header.Set("Cookie", cookiePair(csrfResponse.Cookies()))
	loginResponse, err := client.Do(loginRequest)
	if err != nil {
		t.Fatal(err)
	}
	io.Copy(io.Discard, loginResponse.Body)
	loginResponse.Body.Close()
	if loginResponse.StatusCode != http.StatusOK {
		t.Fatalf("login = %d", loginResponse.StatusCode)
	}
	return server.URL, cookiePair(loginResponse.Cookies()), csrf.Token
}

type compressionRawResponse struct {
	status           int
	header           http.Header
	transferEncoding []string
	raw              []byte
}

// rawCompressionClient never negotiates or decodes on its own: the test must see the wire bytes and headers.
func rawCompressionClient(t *testing.T) *http.Client {
	t.Helper()
	return &http.Client{
		Timeout:   30 * time.Second,
		Transport: &http.Transport{DisableCompression: true},
	}
}

func doCompressionRequest(t *testing.T, client *http.Client, origin, method, path string, headers map[string]string, body string) compressionRawResponse {
	t.Helper()
	var reader io.Reader
	if body != "" {
		reader = strings.NewReader(body)
	}
	request, err := http.NewRequest(method, origin+path, reader)
	if err != nil {
		t.Fatal(err)
	}
	for name, value := range headers {
		request.Header.Set(name, value)
	}
	response, err := client.Do(request)
	if err != nil {
		t.Fatalf("%s %s: %v", method, path, err)
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	return compressionRawResponse{status: response.StatusCode, header: response.Header, transferEncoding: response.TransferEncoding, raw: raw}
}

func decodeCompressedBody(t *testing.T, encoding string, raw []byte) []byte {
	t.Helper()
	switch strings.ToLower(strings.TrimSpace(encoding)) {
	case "", "identity":
		return raw
	case "gzip":
		reader, err := gzip.NewReader(bytes.NewReader(raw))
		if err != nil {
			t.Fatalf("body claims gzip but is not gzip: %v", err)
		}
		defer reader.Close()
		decoded, err := io.ReadAll(reader)
		if err != nil {
			t.Fatalf("decode gzip: %v", err)
		}
		return decoded
	case "deflate":
		reader, err := zlib.NewReader(bytes.NewReader(raw))
		if err != nil {
			t.Fatalf("body claims deflate but is not zlib deflate: %v", err)
		}
		defer reader.Close()
		decoded, err := io.ReadAll(reader)
		if err != nil {
			t.Fatalf("decode deflate: %v", err)
		}
		return decoded
	default:
		t.Fatalf("unexpected content-encoding %q", encoding)
		return nil
	}
}

func compressionSha256Hex(value []byte) string {
	sum := sha256.Sum256(value)
	return hex.EncodeToString(sum[:])
}

func TestPinnedCompressionContract(t *testing.T) {
	fixture := loadCompressionFixture(t)
	origin, cookie, token := startCompressionTestServer(t, fixture.Inputs.SettingsJSON)
	client := rawCompressionClient(t)

	// The ETag VALUE is host-specific; take it from the live response for the conditional scenario.
	probe := doCompressionRequest(t, client, origin, http.MethodGet, "/script.js", map[string]string{"Accept-Encoding": "gzip, deflate"}, "")
	etag := probe.header.Get("ETag")
	if etag == "" {
		t.Fatal("the static response carries no ETag, so the 304 contract cannot be replayed")
	}

	for name, scenario := range fixture.Scenarios {
		name, scenario := name, scenario
		if name == "sse.generateStream" {
			continue // exercised by TestPinnedCompressionSSEIsNotCompressed
		}
		t.Run(name, func(t *testing.T) {
			headers := map[string]string{}
			for headerName, value := range scenario.Request.Headers {
				headers[headerName] = value
			}
			if scenario.Request.Authenticated {
				headers["Cookie"] = cookie
				headers["X-CSRF-Token"] = token
			}
			if scenario.Request.Conditional {
				headers["If-None-Match"] = etag
			}
			method := scenario.Request.Method
			if method == "" {
				method = http.MethodGet
			}
			got := doCompressionRequest(t, client, origin, method, scenario.Request.Path, headers, scenario.Request.Body)
			if got.status != scenario.Response.Status {
				t.Fatalf("status = %d, pinned recorded %d", got.status, scenario.Response.Status)
			}
			pinnedEncoding := ""
			if scenario.Response.ContentEncoding != nil {
				pinnedEncoding = *scenario.Response.ContentEncoding
			}
			gotEncoding := got.header.Get("Content-Encoding")
			switch pinnedEncoding {
			case "br":
				// THE RECORDED DEVIATION, asserted on both halves: pinned answered br (from the fixture) and
				// GoTavern answers gzip because it has no brotli encoder. A br-only request is covered below.
				if gotEncoding != "gzip" {
					t.Fatalf("pinned recorded content-encoding br, GoTavern answered %q; the recorded deviation is that GoTavern answers gzip", gotEncoding)
				}
			case "gzip":
				if gotEncoding != "gzip" {
					decoded := decodeCompressedBody(t, "", got.raw)
					preview := string(decoded)
					if len(preview) > 500 {
						preview = preview[:500]
					}
					t.Fatalf("content-encoding = %q, pinned recorded gzip (content-type %q, content-length %q, raw %d bytes, decoded %d bytes: %s)",
						gotEncoding, got.header.Get("Content-Type"), got.header.Get("Content-Length"), len(got.raw), len(decoded), preview)
				}
			default:
				if gotEncoding != "" {
					t.Fatalf("content-encoding = %q, pinned recorded identity", gotEncoding)
				}
			}
			if scenario.Response.Vary != nil {
				if gotVary := got.header.Get("Vary"); gotVary != *scenario.Response.Vary {
					t.Fatalf("Vary = %q, pinned recorded %q", gotVary, *scenario.Response.Vary)
				}
			}
			if scenario.Response.ContentLength == nil {
				if length := got.header.Get("Content-Length"); length != "" {
					t.Fatalf("Content-Length = %q, pinned recorded none (compressed body)", length)
				}
			} else if gotLength := got.header.Get("Content-Length"); gotLength != *scenario.Response.ContentLength {
				t.Fatalf("Content-Length = %q, pinned recorded %q", gotLength, *scenario.Response.ContentLength)
			}
			if scenario.Response.TransferEncoding != nil {
				if len(got.transferEncoding) == 0 || got.transferEncoding[0] != *scenario.Response.TransferEncoding {
					t.Fatalf("transfer-encoding = %v, pinned recorded %q", got.transferEncoding, *scenario.Response.TransferEncoding)
				}
			} else if len(got.transferEncoding) != 0 {
				t.Fatalf("transfer-encoding = %v, pinned recorded none", got.transferEncoding)
			}
			if scenario.Response.ContentType != nil && got.header.Get("Content-Type") != *scenario.Response.ContentType {
				t.Fatalf("Content-Type = %q, pinned recorded %q", got.header.Get("Content-Type"), *scenario.Response.ContentType)
			}
			if scenario.Response.ContentRange != nil && got.header.Get("Content-Range") != *scenario.Response.ContentRange {
				t.Fatalf("Content-Range = %q, pinned recorded %q", got.header.Get("Content-Range"), *scenario.Response.ContentRange)
			}
			decoded := decodeCompressedBody(t, gotEncoding, got.raw)
			if len(decoded) != scenario.Decoded.Bytes {
				detail := ""
				if scenario.Decoded.Text != nil {
					want := *scenario.Decoded.Text
					limit := len(want)
					if len(decoded) < limit {
						limit = len(decoded)
					}
					index := 0
					for index < limit && decoded[index] == want[index] {
						index++
					}
					detail = fmt.Sprintf("; first difference at byte %d; got tail %q want tail %q", index, string(decoded[index:]), want[index:])
				}
				t.Fatalf("decoded body = %d bytes, pinned recorded %d%s", len(decoded), scenario.Decoded.Bytes, detail)
			}
			if digest := compressionSha256Hex(decoded); digest != scenario.Decoded.Sha256 {
				detail := ""
				if scenario.Decoded.Text != nil {
					want := *scenario.Decoded.Text
					limit := len(want)
					if len(decoded) < limit {
						limit = len(decoded)
					}
					index := 0
					for index < limit && decoded[index] == want[index] {
						index++
					}
					start := index - 40
					if start < 0 {
						start = 0
					}
					gotEnd := index + 80
					if gotEnd > len(decoded) {
						gotEnd = len(decoded)
					}
					wantEnd := index + 80
					if wantEnd > len(want) {
						wantEnd = len(want)
					}
					detail = fmt.Sprintf("; first difference at byte %d: got %q want %q", index, string(decoded[start:gotEnd]), want[start:wantEnd])
				}
				t.Fatalf("decoded body sha256 = %s, pinned recorded %s%s", digest, scenario.Decoded.Sha256, detail)
			}
			if scenario.Decoded.Text != nil && string(decoded) != *scenario.Decoded.Text {
				t.Fatalf("decoded text differs from the recorded body (got %d bytes)", len(decoded))
			}
			if gotEncoding != "" && len(got.raw) >= len(decoded) {
				t.Fatalf("compressed body is not smaller than its decoded body (%d >= %d)", len(got.raw), len(decoded))
			}
		})
	}

	// The br-only half of the deviation: pinned compresses br, GoTavern answers identity because it cannot
	// produce br. Both halves are asserted so neither side can silently change.
	brOnly := doCompressionRequest(t, client, origin, http.MethodGet, "/script.js", map[string]string{"Accept-Encoding": "br"}, "")
	if brOnly.header.Get("Content-Encoding") != "" {
		t.Fatalf("a br-only client received content-encoding %q; GoTavern has no brotli encoder and must answer identity", brOnly.header.Get("Content-Encoding"))
	}
	if brOnly.header.Get("Content-Length") != probe.header.Get("Content-Length") && brOnly.header.Get("Content-Length") == "" {
		t.Fatal("the identity response for a br-only client lost its Content-Length")
	}
}

// TestPinnedCompressionSSEIsNotCompressed replays the probe's SSE scenario: pinned forwards the provider stream
// with NO Content-Type, so the compression filter never matches it. GoTavern sets no Content-Type on that path
// either (chat_completions.go), and this test guards that it stays so -- compression must never re-frame SSE.
func TestPinnedCompressionSSEIsNotCompressed(t *testing.T) {
	fixture := loadCompressionFixture(t)
	scenario := fixture.Scenarios["sse.generateStream"]
	if scenario.Decoded.Text == nil {
		t.Fatal("the compression fixture records no SSE decoded text")
	}
	scenarioWire := providerWireScenario{
		Name: "compression-sse",
		Secrets: map[string]any{"api_key_openai": []any{map[string]any{
			"id": "sid-compression-openai", "value": "probe-openai-key", "label": "openai", "active": true,
		}}},
	}
	scenarioWire.Request.Path = "/api/backends/chat-completions/generate"
	recorder := mockprovider.New([]mockprovider.Response{{
		Status:  http.StatusOK,
		Headers: []mockprovider.Header{{Name: "content-type", Value: "text/event-stream"}},
		Body:    *scenario.Decoded.Text,
	}})
	address, err := recorder.Listen(0)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = recorder.Close() })
	t.Setenv("GOTAVERN_OPENAI_CHAT_URL", "http://"+address.String())
	origin, cookie, token := startChatCompletionTestServer(t, scenarioWire)
	client := rawCompressionClient(t)
	got := doCompressionRequest(t, client, origin, http.MethodPost, scenarioWire.Request.Path, map[string]string{
		"Accept-Encoding": "gzip, deflate",
		"Content-Type":    "application/json",
		"Cookie":          cookie,
		"X-CSRF-Token":    token,
	}, `{"chat_completion_source":"openai","model":"probe-model","messages":[{"role":"user","content":"hello"}],"stream":true,"max_tokens":8}`)
	if got.status != scenario.Response.Status {
		t.Fatalf("SSE status = %d, pinned recorded %d", got.status, scenario.Response.Status)
	}
	if encoding := got.header.Get("Content-Encoding"); encoding != "" {
		t.Fatalf("the SSE stream was compressed (content-encoding %q); pinned's forwardFetchResponse sets no Content-Type, so the filter must not match", encoding)
	}
	if vary := got.header.Get("Vary"); scenario.Response.Vary != nil && vary != *scenario.Response.Vary {
		t.Fatalf("SSE Vary = %q, pinned recorded %q", vary, *scenario.Response.Vary)
	}
	if string(got.raw) != *scenario.Decoded.Text {
		t.Fatalf("SSE frames differ from the recorded stream (got %d bytes, want %d)", len(got.raw), len(*scenario.Decoded.Text))
	}
}
