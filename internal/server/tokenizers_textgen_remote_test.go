package server

// Replay of the pinned remote text-generation tokenizer route:
//
//	POST /api/tokenizers/remote/textgenerationwebui/encode
//
// TWO PINNED CAPTURES ARE REPLAYED, because they were recorded with two different seams and each covers a
// class the other cannot:
//
//   - tests/oracle/sillytavern-1.19.0-tokenizers.json (the corpus the tokenizer plan already records) has the
//     six supported api_type wires and the three failure branches it could reach through its mock backend.
//   - tests/oracle/sillytavern-1.19.0-tokenizer-textgen-remote.json (tools/probe-tokenizer-textgen-remote.mjs)
//     boots the pinned server UNMODIFIED against a loopback backend, so it can record what the real
//     node-fetch does on a malformed URL or an unreachable endpoint, and it can toggle secrets.json and the
//     config between cases. That fixture is where the auth-header shaping, the requestOverrides precedence,
//     the String() coercions, the body-parser branches and the no-timeout observation come from.
//
// WHAT IS COMPARED, per case: the response status, the recorded stable headers (new fixture), the response
// BODY BYTES by digest, and the EXACT provider request(s) observed at the loopback backend -- method, path,
// the recorded headers and the body bytes. A case the fixture says sent nothing must produce zero observed
// requests, so a refusal or a malformed URL cannot silently become a fetch.

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"
)

// textgenRemoteFixture is the loopback-recorded fixture.
type textgenRemoteFixture struct {
	Cases map[string]struct {
		Request struct {
			Body    json.RawMessage   `json:"body"`
			Secrets map[string]string `json:"secrets"`
			Config  string            `json:"config"`
		} `json:"request"`
		Status          int                       `json:"status"`
		Headers         map[string]string         `json:"headers"`
		Body            json.RawMessage           `json:"body"`
		BodySha256      string                    `json:"bodySha256"`
		ContentType     string                    `json:"contentType"`
		ErrorPage       bool                      `json:"errorPage"`
		BackendRequests []tokenizerBackendRequest `json:"backendRequests"`
	} `json:"cases"`
	NotObservable []struct {
		Scenario string `json:"scenario"`
		Why      string `json:"why"`
	} `json:"notObservable"`
}

func loadTextgenRemoteFixture(t *testing.T) textgenRemoteFixture {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-tokenizer-textgen-remote.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture textgenRemoteFixture
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	if len(fixture.Cases) != 31 {
		t.Fatalf("fixture records %d cases, want the 31 recorded by the probe (a shrunk corpus must fail)", len(fixture.Cases))
	}
	if len(fixture.NotObservable) == 0 {
		t.Fatal("the fixture must record which scenarios pinned cannot observe (timeout, client cancel)")
	}
	return fixture
}

// textgenMockBackend is the loopback provider. The response table is the one the pinned probe used, and every
// request is captured so the replay can compare the WIRE (not just the response).
type textgenMockBackend struct {
	server *httptest.Server
	mu     sync.Mutex
	seen   []observedTextgenRequest
}

type observedTextgenRequest struct {
	Method  string
	Path    string
	Headers map[string]string
	Body    string
}

func newTextgenMockBackend(t *testing.T) *textgenMockBackend {
	t.Helper()
	backend := &textgenMockBackend{}
	responses := []struct {
		suffix string
		body   string
	}{
		{"/v1/token/encode", `{"length":7,"tokens":[4,5,6]}`},
		{"/v1/internal/encode", `{"value":5}`},
		{"/api/extra/tokencount", `{"count":9,"ids":[7,8]}`},
		{"/v1/tokenize", `{"ids":[12]}`},
		{"/tokenize", `{"tokens":[10,11]}`},
	}
	backend.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		headers := map[string]string{}
		for _, name := range []string{"content-type", "content-length", "authorization", "x-api-key", "x-probe-override"} {
			if values := r.Header.Values(name); len(values) > 0 {
				headers[name] = strings.Join(values, ", ")
			}
		}
		backend.mu.Lock()
		backend.seen = append(backend.seen, observedTextgenRequest{
			Method: r.Method, Path: r.URL.EscapedPath(), Headers: headers, Body: string(body),
		})
		backend.mu.Unlock()

		switch {
		case strings.Contains(r.URL.Path, "/fail"):
			w.WriteHeader(http.StatusInternalServerError)
			_, _ = w.Write([]byte(`{"error":"mock failure"}`))
			return
		case strings.Contains(r.URL.Path, "/notjson"):
			w.Header().Set("Content-Type", "text/plain")
			_, _ = w.Write([]byte("not json"))
			return
		case strings.Contains(r.URL.Path, "/slow"):
			time.Sleep(250 * time.Millisecond)
		}
		pathname := strings.ReplaceAll(strings.ReplaceAll(r.URL.Path, "/slow", ""), "/notjson", "")
		sort.Slice(responses, func(i, j int) bool { return len(responses[i].suffix) > len(responses[j].suffix) })
		for _, response := range responses {
			if strings.HasSuffix(pathname, response.suffix) {
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte(response.body))
				return
			}
		}
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"error":"unknown mock route"}`))
	}))
	t.Cleanup(backend.server.Close)
	return backend
}

func (backend *textgenMockBackend) reset() {
	backend.mu.Lock()
	backend.seen = nil
	backend.mu.Unlock()
}

func (backend *textgenMockBackend) requests() []observedTextgenRequest {
	backend.mu.Lock()
	defer backend.mu.Unlock()
	return append([]observedTextgenRequest(nil), backend.seen...)
}

// textgenHandler builds the handler under test and returns its data root, because secrets and the config are
// read from it per request by the route under test (pinned reads secrets.json and config.yaml the same way).
func textgenHandler(t *testing.T) (http.Handler, string) {
	t.Helper()
	dataRoot := t.TempDir()
	handler := NewHTTPHandlerWithOptions(HTTPHandlerOptions{DataRoot: dataRoot, DisableCSRF: true})
	return handler, dataRoot
}

func writeTextgenSecrets(t *testing.T, dataRoot string, secrets map[string]string) {
	t.Helper()
	userRoot := filepath.Join(dataRoot, "default-user")
	if err := os.MkdirAll(userRoot, 0o755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(userRoot, "secrets.json")
	if len(secrets) == 0 {
		_ = os.Remove(path)
		return
	}
	file := map[string][]map[string]any{}
	for key, value := range secrets {
		file[key] = []map[string]any{{"id": "probe-id-" + key, "value": value, "label": key, "active": true}}
	}
	encoded, err := json.MarshalIndent(file, "", "    ")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, encoded, 0o644); err != nil {
		t.Fatal(err)
	}
}

func writeTextgenConfig(t *testing.T, dataRoot, mode, backendHost string) {
	t.Helper()
	path := filepath.Join(dataRoot, "config.yaml")
	if mode != "requestOverrides" {
		_ = os.Remove(path)
		return
	}
	config := fmt.Sprintf("requestOverrides:\n  - hosts:\n      - %s\n    headers:\n      X-Probe-Override: override-value\n      Authorization: Bearer override-token\n", backendHost)
	if err := os.WriteFile(path, []byte(config), 0o644); err != nil {
		t.Fatal(err)
	}
}

// textgenRequestBytes turns the fixture's request.body into the bytes sent: the probe stored an OBJECT body
// as a JSON object and a RAW body (a malformed fragment, `null`, `[]`) as a JSON string, so a string is
// unquoted back to its literal bytes and everything else is sent as-is.
func textgenRequestBytes(t *testing.T, raw json.RawMessage) []byte {
	t.Helper()
	if len(raw) == 0 || string(raw) == "null" {
		return nil
	}
	if raw[0] == '"' {
		var literal string
		if err := json.Unmarshal(raw, &literal); err != nil {
			t.Fatal(err)
		}
		return []byte(literal)
	}
	return raw
}

func textgenPost(t *testing.T, handler http.Handler, body []byte) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(http.MethodPost, "/api/tokenizers/remote/textgenerationwebui/encode", bytes.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	return recorder
}

func compareTextgenWire(t *testing.T, name string, want []tokenizerBackendRequest, got []observedTextgenRequest) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("%s: provider requests = %d, pinned %d; got %+v, want %+v", name, len(got), len(want), got, want)
	}
	for index, expected := range want {
		actual := got[index]
		if actual.Method != expected.Method || actual.Path != expected.Path {
			t.Fatalf("%s: provider request %d = %s %s, pinned %s %s", name, index, actual.Method, actual.Path, expected.Method, expected.Path)
		}
		if actual.Body != expected.Body {
			t.Fatalf("%s: provider request %d body = %q, pinned %q", name, index, actual.Body, expected.Body)
		}
		for header, expectedValue := range expected.Headers {
			if actualValue := actual.Headers[header]; actualValue != expectedValue {
				t.Fatalf("%s: provider request %d header %q = %q, pinned %q", name, index, header, actualValue, expectedValue)
			}
		}
	}
}

// TestTokenizerRemoteTextgenEncodeMatchesLoopbackOracle replays the 31 cases recorded against an unmodified
// pinned server with a loopback provider.
func TestTokenizerRemoteTextgenEncodeMatchesLoopbackOracle(t *testing.T) {
	fixture := loadTextgenRemoteFixture(t)
	backend := newTextgenMockBackend(t)
	backendHost := strings.TrimPrefix(backend.server.URL, "http://")
	handler, dataRoot := textgenHandler(t)

	names := make([]string, 0, len(fixture.Cases))
	for name := range fixture.Cases {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		capture := fixture.Cases[name]
		writeTextgenSecrets(t, dataRoot, capture.Request.Secrets)
		writeTextgenConfig(t, dataRoot, capture.Request.Config, backendHost)
		body := textgenRequestBytes(t, capture.Request.Body)
		// The recorded request body is the pinned spelling with the loopback origin replaced by a marker.
		body = bytes.ReplaceAll(body, []byte("<mock-origin>"), []byte(backend.server.URL))
		backend.reset()
		recorder := textgenPost(t, handler, body)

		if recorder.Code != capture.Status {
			t.Fatalf("%s: status = %d, pinned %d", name, recorder.Code, capture.Status)
		}
		if capture.ErrorPage {
			// The pinned page is express.json's HTML error page, whose body is a V8 stack with host
			// absolute paths; only its status and content type are observable. GoTavern's inherited
			// divergence is a plain-text 400 (the middleware gap recorded in docs/api-inventory.md).
			if recorder.Code != http.StatusBadRequest {
				t.Fatalf("%s: pinned parser error page status %d was not reproduced (%d)", name, capture.Status, recorder.Code)
			}
		} else {
			for header, expected := range capture.Headers {
				if actual := recorder.Header().Get(header); !strings.EqualFold(actual, expected) {
					t.Fatalf("%s: header %q = %q, pinned %q", name, header, actual, expected)
				}
			}
			digest := sha256.Sum256(recorder.Body.Bytes())
			if actual := hex.EncodeToString(digest[:]); actual != capture.BodySha256 {
				t.Fatalf("%s: body digest = %s, pinned %s (body %q)", name, actual, capture.BodySha256, recorder.Body.String())
			}
		}
		compareTextgenWire(t, name, capture.BackendRequests, backend.requests())
	}
	if len(fixture.NotObservable) == 0 {
		t.Fatal("the fixture did not record its not-observable scenarios")
	}
}

// TestTokenizerRemoteTextgenEncodeMatchesTokenizerCorpus replays the same route from the tokenizer corpus, so
// the route is pinned by BOTH recordings rather than by the newer fixture alone.
func TestTokenizerRemoteTextgenEncodeMatchesTokenizerCorpus(t *testing.T) {
	fixture := loadTokenizerRouteFixture(t)
	backend := newTextgenMockBackend(t)
	handler, dataRoot := textgenHandler(t)
	writeTextgenSecrets(t, dataRoot, nil)
	writeTextgenConfig(t, dataRoot, "baseline", "")

	replayed := 0
	for name, capture := range fixture.Responses {
		if capture.Request.Path != "/api/tokenizers/remote/textgenerationwebui/encode" {
			continue
		}
		body := bytes.ReplaceAll(capture.Request.Body, []byte(`"<mock-origin>"`), []byte(`"`+backend.server.URL+`"`))
		body = bytes.ReplaceAll(body, []byte("<mock-origin>"), []byte(backend.server.URL))
		backend.reset()
		recorder := textgenPost(t, handler, body)
		if recorder.Code != capture.Status {
			t.Fatalf("%s: status = %d, pinned %d", name, recorder.Code, capture.Status)
		}
		var wantValue any
		if err := json.Unmarshal(capture.Body, &wantValue); err != nil {
			t.Fatalf("%s: pinned body is not JSON: %v", name, err)
		}
		switch wantTyped := wantValue.(type) {
		case map[string]any:
			// `res.send({count, ids})`: compare the exact member set and values.
			var got, want map[string]json.RawMessage
			if err := json.Unmarshal(recorder.Body.Bytes(), &got); err != nil {
				t.Fatalf("%s: response is not an object: %v (%s)", name, err, recorder.Body.String())
			}
			if err := json.Unmarshal(capture.Body, &want); err != nil {
				t.Fatalf("%s: pinned body is not an object: %v", name, err)
			}
			if len(got) != len(want) {
				t.Fatalf("%s: response keys = %v, pinned %v", name, tokenizerKeys(got), tokenizerKeys(want))
			}
			for key, wantRaw := range want {
				if !tokenizerSameJSON(t, got[key], wantRaw) {
					t.Fatalf("%s: %q = %s, pinned %s", name, key, got[key], wantRaw)
				}
			}
		case string:
			// `res.sendStatus(400)`: the pinned body is the status phrase, not a JSON document.
			if actual := strings.TrimSpace(recorder.Body.String()); actual != wantTyped {
				t.Fatalf("%s: body = %q, pinned %q", name, actual, wantTyped)
			}
		default:
			t.Fatalf("%s: unsupported pinned body type %T", name, wantValue)
		}
		recorded, recordedOK := fixture.BackendRequests[name]
		if recordedOK {
			compareTextgenWire(t, name, []tokenizerBackendRequest{recorded}, backend.requests())
		} else if len(backend.requests()) != 0 {
			t.Fatalf("%s: provider requests were made for a case pinned made none: %+v", name, backend.requests())
		}
		replayed++
	}
	if replayed != 12 {
		t.Fatalf("replayed %d text-generation tokenizer cases from the tokenizer corpus, want 12", replayed)
	}
}

// TestTokenizerRemoteTextgenEncodeInstallsNoTimeout is the labelled DERIVATION for the pinned no-timeout
// behaviour: pinned's handler passes no AbortSignal to fetch at all (src/endpoints/tokenizers.js:1085-1088),
// so a slow provider is simply waited for. The pinned capture records the strongest observable version of
// that (no_timeout#slow_upstream accepts a 250 ms answer); this test shows the Go route still accepts a
// provider that answers after the 250 ms mark rather than installing an invented deadline.
func TestTokenizerRemoteTextgenEncodeInstallsNoTimeout(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(600 * time.Millisecond)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"length":3,"tokens":[1,2,3]}`))
	}))
	defer backend.Close()
	handler, dataRoot := textgenHandler(t)
	writeTextgenSecrets(t, dataRoot, nil)
	writeTextgenConfig(t, dataRoot, "baseline", "")
	body := []byte(fmt.Sprintf(`{"text":"Hello, world!","url":%q,"model":"test-model","api_type":"tabby"}`, backend.URL))
	recorder := textgenPost(t, handler, body)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", recorder.Code)
	}
	if got := recorder.Body.String(); got != `{"count":3,"ids":[1,2,3]}` {
		t.Fatalf("body = %s, want the pinned projection", got)
	}
}

// TestTokenizerRemoteTextgenEncodeCancelsWithTheClient is the labelled DERIVATION for cancellation: the
// pinned handler never observes a client abort (it passes no signal and writes the response after fetch
// resolves), so pinned cannot be driven into this observable. GoTavern passes the request context through
// the shared outbound client, so cancelling the caller must return promptly instead of waiting out a slow
// provider. The assertion is the ELAPSED time and the error envelope, not a pinned capture.
func TestTokenizerRemoteTextgenEncodeCancelsWithTheClient(t *testing.T) {
	release := make(chan struct{})
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-release:
		case <-r.Context().Done():
		}
	}))
	defer backend.Close()
	defer close(release)
	handler, dataRoot := textgenHandler(t)
	writeTextgenSecrets(t, dataRoot, nil)
	writeTextgenConfig(t, dataRoot, "baseline", "")
	body := []byte(fmt.Sprintf(`{"text":"Hello, world!","url":%q,"model":"test-model","api_type":"tabby"}`, backend.URL))
	request := httptest.NewRequest(http.MethodPost, "/api/tokenizers/remote/textgenerationwebui/encode", bytes.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	ctx, cancel := context.WithCancel(request.Context())
	request = request.WithContext(ctx)
	go func() {
		time.Sleep(50 * time.Millisecond)
		cancel()
	}()
	started := time.Now()
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	elapsed := time.Since(started)
	if elapsed > 2*time.Second {
		t.Fatalf("the cancelled request took %s to return; the client context is not reaching the outbound call", elapsed)
	}
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want the pinned catch envelope status 200", recorder.Code)
	}
	if strings.TrimSpace(recorder.Body.String()) != `{"error":true}` {
		t.Fatalf("body = %s, want {\"error\":true}", recorder.Body.String())
	}
}
