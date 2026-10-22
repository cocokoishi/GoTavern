package server

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"sort"
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
	// 382 before the corpus gained one encode input (`probe user marker`) and the explicit gpt-3.5-turbo
	// model; every family gained the input, so the route cases move together.
	wantTokenizerEncodeRouteCases   = 397
	wantTokenizerEncodeSkippedCases = 46 // 45 fallback-scenario captures (covered by the downloads-disabled test) plus the GET-on-a-POST-route case
	// The HF unpaired-surrogate class is partial (see plan §9.1), so its 8 cases are skipped
	// and counted rather than replayed against an engine that does not reproduce them.
	wantTokenizerHFSurrogateSkipped = 8
	// Decode and openai route replay counts, measured from the fixture.
	wantTokenizerDecodeRouteCases   = 105
	wantTokenizerDecodeSkippedCases = 6
	wantTokenizerOpenAIEncodeCases  = 144
	wantTokenizerOpenAIDecodeCases  = 30
	// 170 before the corpus gained the ROLE-LESS count bodies the frontend actually sends, one new
	// message body, and gpt-3.5-turbo as a model. Measured from the 1022-case corpus, not derived.
	wantTokenizerOpenAICountCases        = 242
	wantTokenizerColdScenarioEncodeCases = 30
	wantTokenizerColdScenarioDecodeCases = 6
	wantTokenizerGzScenarioEncodeCases   = 15
	wantTokenizerRemoteKoboldCases       = 5
)

type tokenizerBackendRequest struct {
	Method  string            `json:"method"`
	Path    string            `json:"path"`
	Headers map[string]string `json:"headers"`
	Body    string            `json:"body"`
}
type tokenizerRouteFixture struct {
	Responses map[string]struct {
		Request struct {
			Path  string            `json:"path"`
			Query map[string]string `json:"query"`
			Body  json.RawMessage   `json:"body"`
		} `json:"request"`
		Status int             `json:"status"`
		Body   json.RawMessage `json:"body"`
	} `json:"responses"`
	// BackendRequests records what the pinned server sent to the mock provider, keyed by case.
	BackendRequests map[string]tokenizerBackendRequest `json:"backendRequests"`
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

func isTokenizerDecodeRoute(path string) bool {
	if path == "/api/tokenizers/gpt2/decode" {
		return true
	}
	for _, model := range tokenizerSentencePieceModels {
		if path == "/api/tokenizers/"+model+"/decode" {
			return true
		}
	}
	for _, model := range tokenizerWebModels {
		if path == "/api/tokenizers/"+model+"/decode" {
			return true
		}
	}
	return false
}

// TestTokenizerDecodeRoutesMatchPinnedOracle replays the 15 decode routes. The three decode
// handlers do not share a response shape: tiktoken answers {text} alone, while SentencePiece
// and HuggingFace answer {text, chunks}.
func TestTokenizerDecodeRoutesMatchPinnedOracle(t *testing.T) {
	fixture := loadTokenizerRouteFixture(t)
	handler := tokenizerRouteHandler(t)
	replayed := 0
	skipped := 0
	for name, capture := range fixture.Responses {
		if !isTokenizerDecodeRoute(capture.Request.Path) {
			continue
		}
		if strings.HasPrefix(name, "downloads-disabled-") {
			skipped++
			continue
		}
		response := httptest.NewRecorder()
		request := httptest.NewRequest(http.MethodPost, capture.Request.Path, strings.NewReader(string(capture.Request.Body)))
		request.Header.Set("Content-Type", "application/json")
		handler.ServeHTTP(response, request)
		if response.Code != http.StatusOK {
			t.Fatalf("%s: status = %d, pinned 200", name, response.Code)
		}
		var got map[string]json.RawMessage
		if err := json.Unmarshal(response.Body.Bytes(), &got); err != nil {
			t.Fatalf("%s: response is not an object: %v (%s)", name, err, response.Body.String())
		}
		var want map[string]json.RawMessage
		if err := json.Unmarshal(capture.Body, &want); err != nil {
			t.Fatalf("%s: pinned body is not an object: %v", name, err)
		}
		if len(got) != len(want) {
			t.Fatalf("%s: response keys = %v, pinned %v", name, tokenizerKeys(got), tokenizerKeys(want))
		}
		for key, wantRaw := range want {
			gotRaw, present := got[key]
			if !present {
				t.Fatalf("%s: response is missing %q, pinned %v", name, key, tokenizerKeys(want))
			}
			if !tokenizerSameJSON(t, gotRaw, wantRaw) {
				t.Fatalf("%s: %q = %s, pinned %s", name, key, gotRaw, wantRaw)
			}
		}
		replayed++
	}
	if replayed != wantTokenizerDecodeRouteCases {
		t.Fatalf("replayed %d decode route cases, want %d", replayed, wantTokenizerDecodeRouteCases)
	}
	if skipped != wantTokenizerDecodeSkippedCases {
		t.Fatalf("skipped %d decode route cases, want %d", skipped, wantTokenizerDecodeSkippedCases)
	}
}

// TestTokenizerOpenAIRoutesMatchPinnedOracle replays openai/encode, openai/decode and
// openai/count. The count route is the important one: the arithmetic already exists in the
// engines, so this is where a correct engine can be wired into an incorrect route.
func TestTokenizerOpenAIRoutesMatchPinnedOracle(t *testing.T) {
	fixture := loadTokenizerRouteFixture(t)
	handler := tokenizerRouteHandler(t)
	replayed := map[string]int{}
	for name, capture := range fixture.Responses {
		var suffix string
		switch capture.Request.Path {
		case "/api/tokenizers/openai/encode":
			suffix = "encode"
		case "/api/tokenizers/openai/decode":
			suffix = "decode"
		case "/api/tokenizers/openai/count":
			suffix = "count"
		default:
			continue
		}
		if capture.Request.Body == nil {
			continue
		}
		target := capture.Request.Path
		if model := capture.Request.Query["model"]; model != "" {
			target += "?model=" + url.QueryEscape(model)
		}
		response := httptest.NewRecorder()
		request := httptest.NewRequest(http.MethodPost, target, strings.NewReader(string(capture.Request.Body)))
		request.Header.Set("Content-Type", "application/json")
		handler.ServeHTTP(response, request)
		if response.Code != http.StatusOK {
			t.Fatalf("%s: status = %d, pinned 200", name, response.Code)
		}
		var got map[string]json.RawMessage
		if err := json.Unmarshal(response.Body.Bytes(), &got); err != nil {
			t.Fatalf("%s: response is not an object: %v (%s)", name, err, response.Body.String())
		}
		var want map[string]json.RawMessage
		if err := json.Unmarshal(capture.Body, &want); err != nil {
			t.Fatalf("%s: pinned body is not an object: %v", name, err)
		}
		for key, wantRaw := range want {
			gotRaw, present := got[key]
			if !present {
				t.Fatalf("%s: response is missing %q, got %v, pinned %v", name, key, tokenizerKeys(got), tokenizerKeys(want))
			}
			if !tokenizerSameJSON(t, gotRaw, wantRaw) {
				t.Fatalf("%s: %q = %s, pinned %s", name, key, gotRaw, wantRaw)
			}
		}
		replayed[suffix]++
	}
	for suffix, want := range map[string]int{
		"encode": wantTokenizerOpenAIEncodeCases,
		"decode": wantTokenizerOpenAIDecodeCases,
		"count":  wantTokenizerOpenAICountCases,
	} {
		if replayed[suffix] != want {
			t.Fatalf("replayed %d openai/%s cases, want %d", replayed[suffix], suffix, want)
		}
	}
}

func tokenizerKeys(object map[string]json.RawMessage) []string {
	keys := make([]string, 0, len(object))
	for key := range object {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

// tokenizerSameJSON compares two JSON values semantically, so key order inside a nested object
// does not matter while values and array order do.
func tokenizerSameJSON(t *testing.T, left, right json.RawMessage) bool {
	t.Helper()
	var leftValue, rightValue any
	if err := json.Unmarshal(left, &leftValue); err != nil {
		t.Fatalf("left is not JSON: %v", err)
	}
	if err := json.Unmarshal(right, &rightValue); err != nil {
		t.Fatalf("right is not JSON: %v", err)
	}
	return reflect.DeepEqual(leftValue, rightValue)
}

// TestTokenizerRouteReproducesTheDownloadsDisabledScenarios replays the two scenarios the
// probe recorded against the pinned server, which exercise the paths that only exist when
// enableDownloadableTokenizers is false or when the cache holds a compressed manual download.
// Cold cache: every external tokenizer falls back to llama3.json. Compressed cache: the file
// is decompressed into place and the .gz is removed, exactly as getPathToTokenizer does.
func TestTokenizerRouteReproducesTheDownloadsDisabledScenarios(t *testing.T) {
	fixture := loadTokenizerRouteFixture(t)
	repositoryRoot, err := filepath.Abs(filepath.Join("..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	disabled := false
	assets := filepath.Join(repositoryRoot, "upstream", "tokenizers")

	coldRoot := t.TempDir()
	cold := NewHTTPHandlerWithOptions(HTTPHandlerOptions{
		InstallRoot:                  repositoryRoot,
		DataRoot:                     coldRoot,
		DisableCSRF:                  true,
		EnableDownloadableTokenizers: &disabled,
	})

	gzRoot := t.TempDir()
	gzCache := filepath.Join(gzRoot, "_cache")
	if err := os.MkdirAll(gzCache, 0o755); err != nil {
		t.Fatal(err)
	}
	for _, model := range tokenizerExternalAssetModels {
		compressed, err := os.ReadFile(filepath.Join(assets, "external", model+".json.gz"))
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(gzCache, model+".json.gz"), compressed, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	gz := NewHTTPHandlerWithOptions(HTTPHandlerOptions{
		InstallRoot:                  repositoryRoot,
		DataRoot:                     gzRoot,
		DisableCSRF:                  true,
		EnableDownloadableTokenizers: &disabled,
	})

	coldCounts := map[string]int{}
	gzCounts := map[string]int{}
	for name, capture := range fixture.Responses {
		var handler http.Handler
		var counts map[string]int
		switch {
		case strings.HasPrefix(name, "downloads-disabled-cold/"):
			handler, counts = cold, coldCounts
		case strings.HasPrefix(name, "downloads-disabled-gz/"):
			handler, counts = gz, gzCounts
		default:
			continue
		}
		response := httptest.NewRecorder()
		request := httptest.NewRequest(http.MethodPost, capture.Request.Path, strings.NewReader(string(capture.Request.Body)))
		request.Header.Set("Content-Type", "application/json")
		handler.ServeHTTP(response, request)
		if response.Code != http.StatusOK {
			t.Fatalf("%s: status = %d, pinned 200", name, response.Code)
		}
		var got, want map[string]json.RawMessage
		if err := json.Unmarshal(response.Body.Bytes(), &got); err != nil {
			t.Fatalf("%s: response is not an object: %v (%s)", name, err, response.Body.String())
		}
		if err := json.Unmarshal(capture.Body, &want); err != nil {
			t.Fatal(err)
		}
		for key, wantRaw := range want {
			gotRaw, present := got[key]
			if !present {
				t.Fatalf("%s: response is missing %q, got %v, pinned %v", name, key, tokenizerKeys(got), tokenizerKeys(want))
			}
			if !tokenizerSameJSON(t, gotRaw, wantRaw) {
				t.Fatalf("%s: %q = %s, pinned %s", name, key, gotRaw, wantRaw)
			}
		}
		if capture.Request.Body != nil && strings.Contains(string(capture.Request.Body), `"ids"`) {
			counts["decode"]++
		} else {
			counts["encode"]++
		}
	}
	if coldCounts["encode"] != wantTokenizerColdScenarioEncodeCases {
		t.Fatalf("replayed %d cold-cache encode cases, want %d", coldCounts["encode"], wantTokenizerColdScenarioEncodeCases)
	}
	if coldCounts["decode"] != wantTokenizerColdScenarioDecodeCases {
		t.Fatalf("replayed %d cold-cache decode cases, want %d", coldCounts["decode"], wantTokenizerColdScenarioDecodeCases)
	}
	if gzCounts["encode"] != wantTokenizerGzScenarioEncodeCases {
		t.Fatalf("replayed %d gz-cache encode cases, want %d", gzCounts["encode"], wantTokenizerGzScenarioEncodeCases)
	}
	// The compressed cache file must have been replaced by the uncompressed one, matching the
	// pinned unlink.
	for _, model := range tokenizerExternalAssetModels {
		if _, err := os.Stat(filepath.Join(gzCache, model+".json.gz")); err == nil {
			t.Fatalf("%s: the compressed cache file was not removed", model)
		}
		if _, err := os.Stat(filepath.Join(gzCache, model+".json")); err != nil {
			t.Fatalf("%s: the uncompressed cache file was not written", model)
		}
	}
}

// TestTokenizerRemoteKoboldRouteMatchesPinnedOracle replays the five recorded
// /remote/kobold/count cases against a stub backend, and asserts the outbound request body is
// the pinned wire form ({prompt: String(text)} with a JSON content type).
func TestTokenizerRemoteKoboldRouteMatchesPinnedOracle(t *testing.T) {
	fixture := loadTokenizerRouteFixture(t)

	var requestBodies []string
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		requestBodies = append(requestBodies, r.Method+" "+r.URL.Path+" "+r.Header.Get("Content-Type")+" "+r.Header.Get("Content-Length")+" "+string(body))
		switch {
		case strings.HasPrefix(r.URL.Path, "/fail/"):
			w.WriteHeader(http.StatusInternalServerError)
		case strings.HasPrefix(r.URL.Path, "/notjson/"):
			_, _ = w.Write([]byte("not json"))
		default:
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"value":42,"ids":[1,2,3]}`))
		}
	}))
	defer backend.Close()

	handler := tokenizerRouteHandler(t)
	replayed := 0
	for name, capture := range fixture.Responses {
		if capture.Request.Path != "/api/tokenizers/remote/kobold/count" {
			continue
		}
		body := strings.ReplaceAll(string(capture.Request.Body), "<mock-origin>", backend.URL)
		requestBodies = nil
		response := httptest.NewRecorder()
		request := httptest.NewRequest(http.MethodPost, capture.Request.Path, strings.NewReader(body))
		request.Header.Set("Content-Type", "application/json")
		handler.ServeHTTP(response, request)
		if response.Code != http.StatusOK {
			t.Fatalf("%s: status = %d, pinned 200", name, response.Code)
		}
		var got, want map[string]json.RawMessage
		if err := json.Unmarshal(response.Body.Bytes(), &got); err != nil {
			t.Fatalf("%s: response is not an object: %v (%s)", name, err, response.Body.String())
		}
		if err := json.Unmarshal(capture.Body, &want); err != nil {
			t.Fatal(err)
		}
		for key, wantRaw := range want {
			gotRaw, present := got[key]
			if !present {
				t.Fatalf("%s: response is missing %q, got %v, pinned %v", name, key, tokenizerKeys(got), tokenizerKeys(want))
			}
			if !tokenizerSameJSON(t, gotRaw, wantRaw) {
				t.Fatalf("%s: %q = %s, pinned %s", name, key, gotRaw, wantRaw)
			}
		}
		// The wire form, asserted against the pinned capture of what the server sent to the
		// provider: method, path, content type, content length and body.
		if strings.HasPrefix(name, "remote/kobold/count#error_status") || strings.HasPrefix(name, "remote/kobold/count#not_json") || strings.HasPrefix(name, "remote/kobold/count#missing_url") {
			if name == "remote/kobold/count#missing_url" {
				if len(requestBodies) != 0 {
					t.Fatalf("%s: a request was sent without a url: %v", name, requestBodies)
				}
			}
			replayed++
			continue
		}
		recorded, hasRecord := fixture.BackendRequests[name]
		if !hasRecord {
			t.Fatalf("%s: the fixture has no recorded backend request", name)
		}
		wantWire := recorded.Method + " " + recorded.Path + " " +
			recorded.Headers["content-type"] + " " + recorded.Headers["content-length"] + " " + recorded.Body
		if len(requestBodies) != 1 {
			t.Fatalf("%s: outbound requests = %d, want exactly one", name, len(requestBodies))
		}
		if requestBodies[0] != wantWire {
			t.Fatalf("%s: outbound request = %q, pinned %q", name, requestBodies[0], wantWire)
		}
		replayed++
	}
	if replayed != wantTokenizerRemoteKoboldCases {
		t.Fatalf("replayed %d remote kobold cases, want %d", replayed, wantTokenizerRemoteKoboldCases)
	}
}
