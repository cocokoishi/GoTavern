package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The tokenizer routes are measured against the pinned capture, at route level. Engine tests
// cannot show that a route is wired correctly: they call the engine directly, while the route
// owns the body decoding, the dispatch and the response shape.
//
// The request bodies are sent VERBATIM from the fixture, which matters for the §6.1 cases:
// the fixture stores the raw escape `\ud800`, and re-encoding the parsed body through
// encoding/json would replace it with U+FFFD before the route ever saw it, hiding exactly the
// behaviour the route is required to preserve.

const tokenizerRouteOracleFile = "sillytavern-1.19.0-tokenizers.json"

// Expected route-level replay counts. The exclusions are explicit so a shrinking fixture
// fails the build rather than quietly reducing coverage.
const (
	wantTokenizerEncodeRouteCases   = 382
	wantTokenizerEncodeSkippedCases = 46 // 45 fallback-scenario captures plus the GET-on-a-POST-route case
	// The HF unpaired-surrogate class is partial (see plan 9.1), so its 8 cases are skipped
	// and counted rather than replayed against an engine that does not reproduce them.
	wantTokenizerHFSurrogateSkipped = 8
)

type tokenizerRouteFixture struct {
	Responses map[string]struct {
		Request struct {
			Path string          `json:"path"`
			Body json.RawMessage `json:"body"`
		} `json:"request"`
		Status int             `json:"status"`
		Body   json.RawMessage `json:"body"`
	} `json:"responses"`
}

func loadTokenizerRouteFixture(t *testing.T) tokenizerRouteFixture {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", tokenizerRouteOracleFile))
	if err != nil {
		t.Fatal(err)
	}
	var fixture tokenizerRouteFixture
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	if len(fixture.Responses) == 0 {
		t.Fatal("tokenizer oracle has no responses")
	}
	return fixture
}

// tokenizerRouteHandler builds the handler under test. InstallRoot is the repository root so
// the loader finds the vendored tree through its documented development candidate
// (<InstallRoot>/upstream/tokenizers), and DataRoot is a temp directory so the five external
// tokenizers are materialized into a fresh cache exactly as a fresh install would.
func tokenizerRouteHandler(t *testing.T) http.Handler {
	t.Helper()
	repositoryRoot, err := filepath.Abs(filepath.Join("..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	return NewHTTPHandlerWithOptions(HTTPHandlerOptions{
		InstallRoot: repositoryRoot,
		DataRoot:    t.TempDir(),
		DisableCSRF: true,
	})
}

func isTokenizerWebEncodeRoute(path string) bool {
	for _, model := range tokenizerWebModels {
		if path == "/api/tokenizers/"+model+"/encode" {
			return true
		}
	}
	return false
}

func isTokenizerEncodeRoute(path string) bool {
	if path == "/api/tokenizers/gpt2/encode" {
		return true
	}
	for _, model := range tokenizerSentencePieceModels {
		if path == "/api/tokenizers/"+model+"/encode" {
			return true
		}
	}
	for _, model := range tokenizerWebModels {
		if path == "/api/tokenizers/"+model+"/encode" {
			return true
		}
	}
	return false
}

func TestTokenizerEncodeRoutesMatchPinnedOracle(t *testing.T) {
	fixture := loadTokenizerRouteFixture(t)
	handler := tokenizerRouteHandler(t)

	replayed := 0
	skipped := 0
	surrogateSkipped := 0
	for name, capture := range fixture.Responses {
		if !isTokenizerEncodeRoute(capture.Request.Path) {
			continue
		}
		if strings.HasPrefix(name, "downloads-disabled-") {
			skipped++
			continue
		}
		if strings.Contains(name, "surrogate") && isTokenizerWebEncodeRoute(capture.Request.Path) {
			surrogateSkipped++
			continue
		}
		if strings.Contains(name, "method_mismatch") {
			// The GET-on-a-POST-route case: the pinned server falls through to the static
			// middleware, which is shared behaviour rather than tokenizer behaviour.
			skipped++
			continue
		}
		body := []byte(capture.Request.Body)
		response := httptest.NewRecorder()
		request := httptest.NewRequest(http.MethodPost, capture.Request.Path, strings.NewReader(string(body)))
		request.Header.Set("Content-Type", "application/json")
		handler.ServeHTTP(response, request)

		if response.Code != http.StatusOK {
			t.Fatalf("%s: status = %d, pinned 200", name, response.Code)
		}
		var got struct {
			IDs    []int    `json:"ids"`
			Count  int      `json:"count"`
			Chunks []string `json:"chunks"`
		}
		if err := json.Unmarshal(response.Body.Bytes(), &got); err != nil {
			t.Fatalf("%s: response is not an encode object: %v (%s)", name, err, response.Body.String())
		}
		var want struct {
			IDs    []int    `json:"ids"`
			Count  int      `json:"count"`
			Chunks []string `json:"chunks"`
		}
		if err := json.Unmarshal(capture.Body, &want); err != nil {
			t.Fatalf("%s: pinned body is not an encode object: %v", name, err)
		}
		if !equalIntSlicesRoute(got.IDs, want.IDs) {
			t.Fatalf("%s: ids = %v, pinned %v", name, got.IDs, want.IDs)
		}
		if got.Count != want.Count {
			t.Fatalf("%s: count = %d, pinned %d", name, got.Count, want.Count)
		}
		if !equalStringSlicesRoute(got.Chunks, want.Chunks) {
			t.Fatalf("%s: chunks = %q, pinned %q", name, got.Chunks, want.Chunks)
		}
		// The pinned response.send serializes the object in insertion order, so the route
		// must too; a map would emit chunks, count, ids.
		if order := tokenizerResponseKeyOrder(t, response.Body.Bytes()); order != "ids,count,chunks" {
			t.Fatalf("%s: response key order = %q, want ids,count,chunks", name, order)
		}
		replayed++
	}
	if replayed != wantTokenizerEncodeRouteCases {
		t.Fatalf("replayed %d encode route cases, want %d", replayed, wantTokenizerEncodeRouteCases)
	}
	if skipped != wantTokenizerEncodeSkippedCases {
		t.Fatalf("skipped %d encode route cases, want %d", skipped, wantTokenizerEncodeSkippedCases)
	}
	if surrogateSkipped != wantTokenizerHFSurrogateSkipped {
		t.Fatalf("skipped %d HF surrogate cases, want %d", surrogateSkipped, wantTokenizerHFSurrogateSkipped)
	}
}

// TestTokenizerRouteTextFieldPreservesUnpairedSurrogate is the §6.1 requirement at route
// level: a body carrying an unpaired surrogate escape must reach the tokenizer as the code
// unit the pinned server sees, not as the U+FFFD that encoding/json would substitute. The
// assertion is that the route reproduces the pinned capture for that exact raw body, which an
// encoding/json implementation cannot do.
func TestTokenizerRouteTextFieldPreservesUnpairedSurrogate(t *testing.T) {
	fixture := loadTokenizerRouteFixture(t)
	handler := tokenizerRouteHandler(t)

	cases := []struct {
		name string
		// exactAgainstPinned is false for the HuggingFace family, whose unpaired-surrogate
		// class is `partial` in plan §9.1: the route preserves the bytes (proven below) but
		// the engine's byte-pair segmentation of them does not yet match the pinned capture.
		exactAgainstPinned bool
	}{
		{name: "llama/encode#lone_surrogate", exactAgainstPinned: true},   // SentencePiece: pairs the surrogate with the next unit
		{name: "llama/encode#low_surrogate", exactAgainstPinned: true},    // SentencePiece: a trailing surrogate
		{name: "gpt2/encode#lone_surrogate", exactAgainstPinned: true},    // tiktoken: the WASM substitutes U+FFFD
		{name: "claude/encode#lone_surrogate", exactAgainstPinned: false}, // HF: the WTF-8 bytes, engine class partial
	}
	for _, test := range cases {
		name := test.name
		capture, ok := fixture.Responses[name]
		if !ok {
			t.Fatalf("required oracle case %q is missing from the fixture", name)
		}
		raw := []byte(capture.Request.Body)
		if !strings.Contains(string(raw), `\ud8`) && !strings.Contains(string(raw), `\udc`) {
			t.Fatalf("%s: the recorded request body carries no unpaired surrogate escape: %s", name, raw)
		}

		// The requirement itself, asserted directly: the route's text field must still carry
		// the surrogate's WTF-8 bytes. encoding/json would have produced U+FFFD (EF BF BD)
		// here, and every downstream difference follows from that substitution.
		extracted, ok := tokenizerTextRequest(httptest.NewRequest(http.MethodPost, capture.Request.Path, strings.NewReader(string(raw))))
		if !ok {
			t.Fatalf("%s: the route rejected the body", name)
		}
		if strings.Contains(extracted, "\ufffd") || !containsWTFSurrogate(extracted) {
			t.Fatalf("%s: the route extracted %q (bytes % x), which is not the surrogate's WTF-8 bytes", name, extracted, []byte(extracted))
		}

		response := httptest.NewRecorder()
		request := httptest.NewRequest(http.MethodPost, capture.Request.Path, strings.NewReader(string(raw)))
		request.Header.Set("Content-Type", "application/json")
		handler.ServeHTTP(response, request)

		var got, want struct {
			IDs    []int    `json:"ids"`
			Count  int      `json:"count"`
			Chunks []string `json:"chunks"`
		}
		if err := json.Unmarshal(response.Body.Bytes(), &got); err != nil {
			t.Fatalf("%s: %v (%s)", name, err, response.Body.String())
		}
		if err := json.Unmarshal(capture.Body, &want); err != nil {
			t.Fatal(err)
		}
		if test.exactAgainstPinned {
			if !equalIntSlicesRoute(got.IDs, want.IDs) || !equalStringSlicesRoute(got.Chunks, want.Chunks) {
				t.Fatalf("%s: route ids = %v chunks = %q, pinned %v %q", name, got.IDs, got.Chunks, want.IDs, want.Chunks)
			}
			continue
		}
		// The partial class: the route must produce exactly what the engine produces for the
		// same extracted text, so any divergence is attributed to the engine and not the route.
		engineIDs := tokenizerRouteEngineIDs(t, capture.Request.Path, extracted)
		if !equalIntSlicesRoute(got.IDs, engineIDs) {
			t.Fatalf("%s: route ids = %v, engine ids = %v: the route and the engine disagree on the same input", name, got.IDs, engineIDs)
		}
	}
}

// containsWTFSurrogate reports whether the text carries a surrogate code unit as its WTF-8
// bytes (ED A0..BF 80..BF), which is how UnescapeJSONString preserves an unpaired escape.
func containsWTFSurrogate(text string) bool {
	for index := 0; index+2 < len(text); index++ {
		if text[index] == 0xED && text[index+1] >= 0xA0 && text[index+1] <= 0xBF && text[index+2] >= 0x80 && text[index+2] <= 0xBF {
			return true
		}
	}
	return false
}

// tokenizerRouteEngineIDs runs the engine the route would use, directly, for one text.
func tokenizerRouteEngineIDs(t *testing.T, path string, text string) []int {
	t.Helper()
	repositoryRoot, err := filepath.Abs(filepath.Join("..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	set, ok := openTokenizerSet(HTTPHandlerOptions{InstallRoot: repositoryRoot, DataRoot: t.TempDir()})
	if !ok {
		t.Fatal("no tokenizer set")
	}
	for _, model := range tokenizerWebModels {
		if path == "/api/tokenizers/"+model+"/encode" {
			processor, err := set.web(model)
			if err != nil {
				t.Fatal(err)
			}
			ids, err := processor.Encode(text)
			if err != nil {
				t.Fatal(err)
			}
			return ids
		}
	}
	return nil
}

// tokenizerRouteReplacementIDs returns the ids the same route produces for the U+FFFD
// spelling of the input, so a test can prove the route did not simply lose the surrogate.

// TestTokenizerRouteRejectsMalformedBody pins that a body the pinned strict parser rejects is
// a 400 before the route runs, while a valid non-object body is not.
func TestTokenizerRouteRejectsMalformedBody(t *testing.T) {
	handler := tokenizerRouteHandler(t)
	for _, test := range []struct {
		name string
		body string
		want int
	}{
		{name: "malformed", body: "{", want: http.StatusBadRequest},
		{name: "empty body", body: "", want: http.StatusOK},
		{name: "array body", body: "[]", want: http.StatusOK},
		{name: "string body", body: `"text"`, want: http.StatusOK},
		{name: "object without text", body: "{}", want: http.StatusOK},
		{name: "numeric text", body: `{"text":42}`, want: http.StatusOK},
	} {
		response := httptest.NewRecorder()
		request := httptest.NewRequest(http.MethodPost, "/api/tokenizers/llama/encode", strings.NewReader(test.body))
		request.Header.Set("Content-Type", "application/json")
		handler.ServeHTTP(response, request)
		if response.Code != test.want {
			t.Fatalf("%s: status = %d, want %d", test.name, response.Code, test.want)
		}
		if test.want == http.StatusOK {
			var got struct {
				IDs    []int    `json:"ids"`
				Count  int      `json:"count"`
				Chunks []string `json:"chunks"`
			}
			if err := json.Unmarshal(response.Body.Bytes(), &got); err != nil {
				t.Fatalf("%s: response is not an encode object: %v", test.name, err)
			}
			if len(got.IDs) != 0 || got.Count != 0 {
				t.Fatalf("%s: ids = %v count = %d, want an empty result", test.name, got.IDs, got.Count)
			}
		}
	}
}

// tokenizerResponseKeyOrder returns the top-level key order of a JSON object response.
func tokenizerResponseKeyOrder(t *testing.T, raw []byte) string {
	t.Helper()
	decoder := json.NewDecoder(strings.NewReader(string(raw)))
	if _, err := decoder.Token(); err != nil {
		t.Fatalf("reading response object: %v", err)
	}
	keys := []string{}
	for decoder.More() {
		token, err := decoder.Token()
		if err != nil {
			t.Fatalf("reading response key: %v", err)
		}
		key, ok := token.(string)
		if !ok {
			t.Fatalf("response key is not a string: %v", token)
		}
		keys = append(keys, key)
		var discard json.RawMessage
		if err := decoder.Decode(&discard); err != nil {
			t.Fatalf("reading response value: %v", err)
		}
	}
	return strings.Join(keys, ",")
}

func equalIntSlicesRoute(left, right []int) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
}

func equalStringSlicesRoute(left, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
}
