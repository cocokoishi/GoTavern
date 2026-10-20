package server

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"
)

// The tokenizer oracle fixture is the pinned Node capture of every /api/tokenizers
// route. This file owns the properties that must hold before any Go implementation can
// claim tokenizer parity:
//
//  1. coverage: the fixture is complete and self-consistent, so a probe that silently
//     stops recording a route or a case fails the build instead of being cited later;
//  2. host independence: every value in the fixture is reproducible on another host,
//     which is what stops a package-version or mutable-branch difference from being
//     recorded as if it were pinned behavior;
//  3. the downloads-disabled trap: with the cache cold and downloads off, pinned
//     upstream serves all five externally fetched tokenizers from llama3.json, and an
//     existing cached copy wins over that fallback. Go must reproduce both, and must
//     not silently prefer the vendored bytes in the cold case.
//
// The differential replay of these cases against the Go handlers lands with the
// implementation; until then no tokenizer route may be called compatible.

const (
	tokenizerOracleFile   = "sillytavern-1.19.0-tokenizers.json"
	tokenizerExternalRepo = "SillyTavern/SillyTavern-Tokenizers"
	// Pinned upstream 1.19.0 fetches the five external tokenizers from this repository's
	// mutable `main` branch, so this commit is a GoTavern choice, not an upstream pin.
	tokenizerExternalCommit = "798bcd823dfd04227a79b487e1cf29e6de9aaece"
	tokenizerExternalRef    = "main"
)

var (
	tokenizerPinnedPackages = map[string]string{
		"tiktoken":                "1.0.22",
		"@agnai/web-tokenizers":   "0.1.3",
		"@agnai/sentencepiece-js": "1.1.1",
	}
	// The two remote passthrough routes. They are recorded now, against a local mock
	// backend, so a route disappearing from the inventory is a failure.
	tokenizerRemoteRoutes = []string{
		"POST /api/tokenizers/remote/kobold/count",
		"POST /api/tokenizers/remote/textgenerationwebui/encode",
	}
	tokenizerExternalModels = []string{"qwen2", "command-r", "command-a", "nemo", "deepseek"}
	tokenizerFallbackInputs = []string{"ascii", "cjk", "emoji", "special_endoftext", "added_llama3"}
	tokenizerGzCacheInputs  = []string{"ascii", "cjk", "emoji"}
	// A recorded value must never depend on where the oracle ran.
	tokenizerHostPathPattern = regexp.MustCompile(`([A-Za-z]:\\|/Users/|/home/|AppData\\|/tmp/|\\Temp\\|127\.0\.0\.1|localhost:)`)
)

type tokenizerCacheEntry struct {
	Path   string `json:"path"`
	Kind   string `json:"kind"`
	Bytes  int    `json:"bytes"`
	SHA256 string `json:"sha256"`
}

type tokenizerCacheState struct {
	Exists  bool                  `json:"exists"`
	Entries []tokenizerCacheEntry `json:"entries"`
}

type tokenizerOracleFixture struct {
	SchemaVersion int `json:"schemaVersion"`
	Baseline      struct {
		Version string `json:"version"`
		Commit  string `json:"commit"`
	} `json:"baseline"`
	Probe          string   `json:"probe"`
	Normalizations []string `json:"normalizations"`
	Inputs         struct {
		CookieSecret       string            `json:"cookieSecret"`
		TokenizerPackages  map[string]string `json:"tokenizerPackages"`
		TokenizerData      map[string]string `json:"tokenizerData"`
		ExternalTokenizers struct {
			Repository string            `json:"repository"`
			Ref        string            `json:"ref"`
			Commit     string            `json:"commit"`
			Note       string            `json:"note"`
			Files      map[string]string `json:"files"`
		} `json:"externalTokenizers"`
		CacheSeed map[string]string `json:"cacheSeed"`
	} `json:"inputs"`
	Coverage struct {
		Routes []struct {
			Route  string `json:"route"`
			Cases  int    `json:"cases"`
			Status string `json:"status"`
		} `json:"routes"`
		DeferredRoutes     []string `json:"deferredRoutes"`
		RequiredCases      []string `json:"requiredCases"`
		RequiredErrorPages []string `json:"requiredErrorPages"`
	} `json:"coverage"`
	Responses map[string]struct {
		Request struct {
			Path  string          `json:"path"`
			Query json.RawMessage `json:"query"`
			Body  json.RawMessage `json:"body"`
		} `json:"request"`
		Status  int               `json:"status"`
		Headers map[string]string `json:"headers"`
		Body    json.RawMessage   `json:"body"`
	} `json:"responses"`
	ErrorPages map[string]struct {
		Status      int    `json:"status"`
		ContentType string `json:"contentType"`
	} `json:"errorPages"`
	BackendRequests map[string]struct {
		Method  string            `json:"method"`
		Path    string            `json:"path"`
		Headers map[string]string `json:"headers"`
		Body    string            `json:"body"`
	} `json:"backendRequests"`
	DownloadsDisabled struct {
		ColdCache struct {
			CacheBefore tokenizerCacheState `json:"cacheBefore"`
			CacheAfter  tokenizerCacheState `json:"cacheAfter"`
		} `json:"coldCache"`
		GzCache struct {
			CacheBefore tokenizerCacheState `json:"cacheBefore"`
			CacheAfter  tokenizerCacheState `json:"cacheAfter"`
		} `json:"gzCache"`
	} `json:"downloadsDisabled"`
}

func loadTokenizerOracle(t *testing.T) (tokenizerOracleFixture, []byte) {
	t.Helper()
	path := filepath.Join("..", "..", "tests", "oracle", tokenizerOracleFile)
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var fixture tokenizerOracleFixture
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	return fixture, raw
}

// TestPinnedNodeTokenizerOracleCoverage fails when a route or a case that the oracle is
// required to record is missing, so the fixture cannot rot into a smaller capture that
// still looks green.
func TestPinnedNodeTokenizerOracleCoverage(t *testing.T) {
	fixture, _ := loadTokenizerOracle(t)
	if fixture.Baseline.Version != "1.19.0" || fixture.Baseline.Commit != "06bde939fb1e9c4c8d8641d810f0a916b5bce127" {
		t.Fatalf("tokenizer oracle baseline = %+v", fixture.Baseline)
	}
	if fixture.SchemaVersion != 1 || fixture.Probe == "" || fixture.Inputs.CookieSecret == "" {
		t.Fatalf("tokenizer oracle header is incomplete: schema=%d probe=%q", fixture.SchemaVersion, fixture.Probe)
	}
	if len(fixture.Normalizations) == 0 {
		t.Fatal("tokenizer oracle records no normalization reasons")
	}

	// The route inventory is the pinned mount's complete surface: 35 routes.
	if len(fixture.Coverage.Routes) != 35 {
		t.Fatalf("tokenizer oracle covers %d routes, pinned /api/tokenizers mounts 35", len(fixture.Coverage.Routes))
	}
	// Every route is recorded now, including the two remote passthrough routes, so a
	// non-empty deferred set is a regression rather than a plan.
	if len(fixture.Coverage.DeferredRoutes) != 0 {
		t.Fatalf("tokenizer oracle defers routes: %v", fixture.Coverage.DeferredRoutes)
	}
	seenRoutes := map[string]bool{}
	for _, route := range fixture.Coverage.Routes {
		if seenRoutes[route.Route] {
			t.Fatalf("route %q appears twice in the coverage list", route.Route)
		}
		seenRoutes[route.Route] = true
		if route.Status != "recorded" || route.Cases == 0 {
			t.Fatalf("route %q is %s with %d cases; every route must record cases", route.Route, route.Status, route.Cases)
		}
	}
	for _, route := range tokenizerRemoteRoutes {
		if !seenRoutes[route] {
			t.Fatalf("remote route %q is missing from the coverage list", route)
		}
	}

	// requiredCases must equal the recorded cases exactly, in both directions: a dropped
	// case and an unrecorded extra case both fail.
	required := append([]string(nil), fixture.Coverage.RequiredCases...)
	recorded := make([]string, 0, len(fixture.Responses))
	for name := range fixture.Responses {
		recorded = append(recorded, name)
	}
	sort.Strings(required)
	sort.Strings(recorded)
	if strings.Join(required, "\n") != strings.Join(recorded, "\n") {
		t.Fatalf("requiredCases and responses differ:\nrequired %d: %v\nrecorded %d: %v",
			len(required), firstDifference(required, recorded), len(recorded), firstDifference(recorded, required))
	}
	if len(recorded) < 700 {
		t.Fatalf("tokenizer oracle recorded only %d cases; the corpus is expected to be several hundred", len(recorded))
	}
	if len(fixture.Coverage.RequiredErrorPages) != len(fixture.ErrorPages) {
		t.Fatalf("requiredErrorPages has %d entries but errorPages has %d", len(fixture.Coverage.RequiredErrorPages), len(fixture.ErrorPages))
	}
	for _, name := range fixture.Coverage.RequiredErrorPages {
		if _, ok := fixture.ErrorPages[name]; !ok {
			t.Fatalf("required error page %q is absent from the fixture", name)
		}
	}
	if len(fixture.ErrorPages) == 0 {
		t.Fatal("tokenizer oracle records no error pages")
	}

	for name, capture := range fixture.Responses {
		if !strings.HasPrefix(capture.Request.Path, "/api/tokenizers/") {
			t.Fatalf("%s: request path %q is outside the tokenizer mount", name, capture.Request.Path)
		}
		if capture.Status == 0 || capture.Headers == nil {
			t.Fatalf("%s: incomplete capture status=%d headers=%v", name, capture.Status, capture.Headers)
		}
		if capture.Status != 200 {
			continue
		}
		checkTokenizerResponseShape(t, name, capture.Request.Path, capture.Body)
	}
	for name, page := range fixture.ErrorPages {
		if page.Status == 0 || page.ContentType == "" {
			t.Fatalf("%s: error page capture is incomplete: %+v", name, page)
		}
		if !strings.HasPrefix(page.ContentType, "text/html") {
			t.Fatalf("%s: error page content type %q is not the pinned Express error page", name, page.ContentType)
		}
	}
}

// checkTokenizerResponseShape asserts the handler's own invariants on a recorded body.
// A capture that lost fields, or that recorded a different route's answer, fails here.
func checkTokenizerResponseShape(t *testing.T, name, routePath string, raw json.RawMessage) {
	t.Helper()
	var body map[string]json.RawMessage
	if err := json.Unmarshal(raw, &body); err != nil {
		t.Fatalf("%s: response body is not a JSON object: %v", name, err)
	}
	switch {
	case routePath == "/api/tokenizers/openai/count":
		if _, ok := decodeTokenizerNumber(t, name, body["token_count"]); !ok {
			t.Fatalf("%s: count response has no numeric token_count", name)
		}
	case routePath == "/api/tokenizers/remote/kobold/count" || routePath == "/api/tokenizers/remote/textgenerationwebui/encode":
		// The remote routes project the backend response as {count, ids} or, on any
		// failure, {"error":true}. The pinned `??` chain can also resolve count to
		// undefined, in which case the key is absent from the response.
		if errorRaw, ok := body["error"]; ok {
			var errored bool
			if err := json.Unmarshal(errorRaw, &errored); err != nil || !errored {
				t.Fatalf("%s: remote error response is not {\"error\":true}: %s", name, raw)
			}
			return
		}
		var ids []int64
		if err := json.Unmarshal(body["ids"], &ids); err != nil {
			t.Fatalf("%s: remote response has no ids array: %v", name, err)
		}
		if countRaw, ok := body["count"]; ok {
			if _, ok := decodeTokenizerNumber(t, name, countRaw); !ok {
				t.Fatalf("%s: remote count is not numeric", name)
			}
		}
	case strings.HasSuffix(routePath, "/encode"):
		ids := decodeTokenizerIDs(t, name, body["ids"])
		count, ok := decodeTokenizerNumber(t, name, body["count"])
		if !ok {
			t.Fatalf("%s: encode response has no count", name)
		}
		if int(count) != len(ids) {
			t.Fatalf("%s: encode count %v does not match %d ids", name, count, len(ids))
		}
		var chunks []string
		if err := json.Unmarshal(body["chunks"], &chunks); err != nil {
			t.Fatalf("%s: encode response has no string chunks array: %v", name, err)
		}
		// The HF handlers merge partial-byte ids into one chunk, so chunks never exceed
		// ids; the SentencePiece and tiktoken handlers emit exactly one chunk per id.
		if len(chunks) > len(ids) {
			t.Fatalf("%s: encode response has %d chunks for %d ids", name, len(chunks), len(ids))
		}
		if tokenizerChunksMatchIDs(routePath) && len(chunks) != len(ids) {
			t.Fatalf("%s: encode response has %d chunks for %d ids but this handler emits one chunk per id", name, len(chunks), len(ids))
		}
	case strings.HasSuffix(routePath, "/decode"):
		var text string
		if err := json.Unmarshal(body["text"], &text); err != nil {
			t.Fatalf("%s: decode response has no text: %v", name, err)
		}
		if chunksRaw, ok := body["chunks"]; ok {
			var chunks []string
			if err := json.Unmarshal(chunksRaw, &chunks); err != nil {
				t.Fatalf("%s: decode chunks is not a string array: %v", name, err)
			}
			// The pinned SentencePiece and HF decode handlers join per-id decodes.
			if strings.Join(chunks, "") != text {
				t.Fatalf("%s: decode text %q is not the join of its chunks %q", name, text, chunks)
			}
		}
	}
}

func decodeTokenizerIDs(t *testing.T, name string, raw json.RawMessage) []int64 {
	t.Helper()
	var ids []int64
	if err := json.Unmarshal(raw, &ids); err != nil {
		t.Fatalf("%s: ids is not a number array: %v", name, err)
	}
	return ids
}

// tokenizerChunksMatchIDs reports whether the route is served by a handler that emits one
// chunk per token id. The HF web-tokenizer handlers merge partial-byte ids instead.
func tokenizerChunksMatchIDs(routePath string) bool {
	for _, model := range []string{"llama", "nerdstash", "nerdstash_v2", "mistral", "yi", "gemma", "jamba", "gpt2"} {
		if routePath == "/api/tokenizers/"+model+"/encode" {
			return true
		}
	}
	return false
}

func decodeTokenizerNumber(t *testing.T, name string, raw json.RawMessage) (float64, bool) {
	t.Helper()
	if len(raw) == 0 {
		return 0, false
	}
	var value float64
	if err := json.Unmarshal(raw, &value); err != nil {
		t.Fatalf("%s: value is not a number: %v", name, err)
	}
	return value, true
}

func firstDifference(left, right []string) []string {
	rightSet := map[string]bool{}
	for _, item := range right {
		rightSet[item] = true
	}
	var missing []string
	for _, item := range left {
		if !rightSet[item] {
			missing = append(missing, item)
			if len(missing) == 5 {
				break
			}
		}
	}
	return missing
}

// TestPinnedNodeTokenizerOracleIsHostIndependent fails when the fixture records a value
// that another host would not reproduce: a different tokenizer package version, tokenizer
// data that does not match the vendored manifest, or a host-absolute path.
func TestPinnedNodeTokenizerOracleIsHostIndependent(t *testing.T) {
	fixture, raw := loadTokenizerOracle(t)

	if len(fixture.Inputs.TokenizerPackages) != len(tokenizerPinnedPackages) {
		t.Fatalf("recorded tokenizer packages = %v, want %v", fixture.Inputs.TokenizerPackages, tokenizerPinnedPackages)
	}
	for name, want := range tokenizerPinnedPackages {
		if got := fixture.Inputs.TokenizerPackages[name]; got != want {
			t.Fatalf("recorded %s version = %q, want %q; regenerate on a host with the pinned packages", name, got, want)
		}
	}

	manifest := readTokenizerManifest(t)
	if len(fixture.Inputs.TokenizerData) == 0 {
		t.Fatal("fixture records no tokenizer data hashes")
	}
	for path, digest := range fixture.Inputs.TokenizerData {
		relative := strings.TrimPrefix(path, "upstream/tokenizers/")
		if relative == path {
			t.Fatalf("tokenizer data path %q is not under upstream/tokenizers/", path)
		}
		want, ok := manifest[relative]
		if !ok {
			t.Fatalf("manifest has no entry for %q", relative)
		}
		if digest != want {
			t.Fatalf("recorded digest for %s is %s but the vendored manifest pins %s", relative, digest, want)
		}
	}

	external := fixture.Inputs.ExternalTokenizers
	if external.Repository != tokenizerExternalRepo || external.Ref != tokenizerExternalRef || external.Commit != tokenizerExternalCommit {
		t.Fatalf("external tokenizer pin = %s@%s (%s), want %s@%s (%s)",
			external.Repository, external.Commit, external.Ref, tokenizerExternalRepo, tokenizerExternalCommit, tokenizerExternalRef)
	}
	if !strings.Contains(strings.ToLower(external.Note), "mutable") {
		t.Fatalf("external tokenizer note does not record that upstream fetches from a mutable branch: %q", external.Note)
	}
	if len(external.Files) != 5 {
		t.Fatalf("external tokenizer file list has %d entries, want 5", len(external.Files))
	}
	for name, digest := range external.Files {
		want, ok := manifest["external/"+name]
		if !ok {
			t.Fatalf("manifest has no entry for external/%s", name)
		}
		if digest != want {
			t.Fatalf("recorded digest for external/%s is %s but the vendored manifest pins %s", name, digest, want)
		}
	}
	if len(fixture.Inputs.CacheSeed) != 5 {
		t.Fatalf("cache seed has %d entries, want 5", len(fixture.Inputs.CacheSeed))
	}
	for name, digest := range fixture.Inputs.CacheSeed {
		if !strings.HasSuffix(name, ".json") || len(digest) != 64 {
			t.Fatalf("cache seed entry %q = %q is not a 64-character digest of an uncompressed tokenizer", name, digest)
		}
	}

	// No recorded value may embed the recording host's filesystem layout or the mock
	// backend's per-run port.
	var decoded any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatal(err)
	}
	for _, value := range tokenizerStrings(decoded) {
		if match := tokenizerHostPathPattern.FindString(value); match != "" {
			t.Fatalf("tokenizer oracle records a host-dependent value %q in %q", match, value)
		}
	}
}

// TestPinnedNodeTokenizerDownloadsDisabledFallback pins the documented trap: with
// enableDownloadableTokenizers false and a cold cache, pinned upstream cannot fetch and
// serves all five externally fetched tokenizers from llama3.json. Go must reproduce the
// fallback rather than silently preferring the vendored bytes.
func TestPinnedNodeTokenizerDownloadsDisabledFallback(t *testing.T) {
	fixture, _ := loadTokenizerOracle(t)

	for _, model := range tokenizerExternalModels {
		for _, input := range tokenizerFallbackInputs {
			want, ok := fixture.Responses["downloads-disabled-cold/llama3/encode#"+input]
			if !ok {
				t.Fatalf("fixture is missing the llama3 comparison case for %q", input)
			}
			got, ok := fixture.Responses["downloads-disabled-cold/"+model+"/encode#"+input]
			if !ok {
				t.Fatalf("fixture is missing the cold-cache case for %s/%s", model, input)
			}
			if !bytes.Equal(want.Body, got.Body) {
				t.Fatalf("cold-cache %s/%s did not fall back to llama3:\nllama3: %s\n%s: %s", model, input, want.Body, model, got.Body)
			}
			// The fallback must be distinguishable from the pinned tokenizer, otherwise
			// the comparison above could pass for the wrong reason.
			pinned, ok := fixture.Responses[model+"/encode#"+input]
			if !ok {
				t.Fatalf("fixture is missing the pinned case for %s/%s", model, input)
			}
			if bytes.Equal(pinned.Body, got.Body) {
				t.Fatalf("cold-cache %s/%s equals the pinned capture, so the fallback assertion is vacuous", model, input)
			}
		}
		wantDecode, ok := fixture.Responses["downloads-disabled-cold/llama3/decode#roundtrip_ascii"]
		if !ok {
			t.Fatal("fixture is missing the llama3 decode comparison case")
		}
		gotDecode, ok := fixture.Responses["downloads-disabled-cold/"+model+"/decode#roundtrip_ascii"]
		if !ok {
			t.Fatalf("fixture is missing the cold-cache decode case for %s", model)
		}
		if !bytes.Equal(wantDecode.Body, gotDecode.Body) {
			t.Fatalf("cold-cache %s decode did not fall back to llama3:\nllama3: %s\n%s: %s", model, wantDecode.Body, model, gotDecode.Body)
		}
	}

	// Pinned startup still creates <DATA_ROOT>/_cache, but no tokenizer file is written
	// when the fallback is used.
	cold := fixture.DownloadsDisabled.ColdCache
	if cold.CacheBefore.Exists {
		t.Fatalf("cold-cache run started with an existing cache: %+v", cold.CacheBefore)
	}
	if !cold.CacheAfter.Exists {
		t.Fatal("pinned startup did not create <DATA_ROOT>/_cache")
	}
	for _, entry := range cold.CacheAfter.Entries {
		if entry.Kind == "file" {
			t.Fatalf("cold-cache run wrote %q into the tokenizer cache", entry.Path)
		}
	}
}

// TestPinnedNodeTokenizerGzCacheWinsOverFallback pins that an existing cached copy is
// used even when downloads are disabled, and that pinned upstream decompresses it in
// place and unlinks the .gz.
func TestPinnedNodeTokenizerGzCacheWinsOverFallback(t *testing.T) {
	fixture, _ := loadTokenizerOracle(t)

	for _, model := range tokenizerExternalModels {
		for _, input := range tokenizerGzCacheInputs {
			pinned, ok := fixture.Responses[model+"/encode#"+input]
			if !ok {
				t.Fatalf("fixture is missing the pinned case for %s/%s", model, input)
			}
			cached, ok := fixture.Responses["downloads-disabled-gz/"+model+"/encode#"+input]
			if !ok {
				t.Fatalf("fixture is missing the gz-cache case for %s/%s", model, input)
			}
			if !bytes.Equal(pinned.Body, cached.Body) {
				t.Fatalf("gz-cache %s/%s did not use the pinned bytes:\npinned: %s\ncached: %s", model, input, pinned.Body, cached.Body)
			}
		}
	}

	gz := fixture.DownloadsDisabled.GzCache
	if len(gz.CacheBefore.Entries) != 5 {
		t.Fatalf("gz-cache run started with %d cache entries, want the five .gz files", len(gz.CacheBefore.Entries))
	}
	for _, entry := range gz.CacheBefore.Entries {
		if entry.Kind != "file" || !strings.HasSuffix(entry.Path, ".json.gz") {
			t.Fatalf("gz-cache run started with an unexpected entry %+v", entry)
		}
	}
	seen := map[string]bool{}
	for _, entry := range gz.CacheAfter.Entries {
		if entry.Kind != "file" {
			continue
		}
		if strings.HasSuffix(entry.Path, ".json.gz") {
			t.Fatalf("pinned upstream did not unlink %q", entry.Path)
		}
		want, ok := fixture.Inputs.CacheSeed[entry.Path]
		if !ok {
			t.Fatalf("gz-cache run wrote unexpected file %q", entry.Path)
		}
		if entry.SHA256 != want {
			t.Fatalf("gz-cache run wrote %q with digest %s, want the pinned %s", entry.Path, entry.SHA256, want)
		}
		seen[entry.Path] = true
	}
	for _, model := range tokenizerExternalModels {
		if !seen[model+".json"] {
			t.Fatalf("gz-cache run did not materialize %s.json", model)
		}
	}
}

// TestPinnedNodeTokenizerRemoteRoutes pins the request the pinned server builds for the
// two remote passthrough routes, and the response projection each backend family gets.
func TestPinnedNodeTokenizerRemoteRoutes(t *testing.T) {
	fixture, _ := loadTokenizerOracle(t)

	expectations := map[string]struct {
		path string
		keys []string
	}{
		"remote/kobold/count#ok":                                 {"/extra/tokencount", []string{"prompt"}},
		"remote/textgenerationwebui/encode#tabby":                {"/v1/token/encode", []string{"add_bos_token", "encode_special_tokens", "text"}},
		"remote/textgenerationwebui/encode#koboldcpp":            {"/api/extra/tokencount", []string{"prompt", "special"}},
		"remote/textgenerationwebui/encode#llamacpp":             {"/tokenize", []string{"content", "model"}},
		"remote/textgenerationwebui/encode#vllm":                 {"/tokenize", []string{"model", "prompt"}},
		"remote/textgenerationwebui/encode#aphrodite":            {"/v1/tokenize", []string{"model", "prompt"}},
		"remote/textgenerationwebui/encode#ooba":                 {"/v1/internal/encode", []string{"text"}},
		"remote/textgenerationwebui/encode#tabby#trailing_v1":    {"/v1/token/encode", []string{"add_bos_token", "encode_special_tokens", "text"}},
		"remote/textgenerationwebui/encode#tabby#trailing_slash": {"/v1/token/encode", []string{"add_bos_token", "encode_special_tokens", "text"}},
	}
	for name, want := range expectations {
		request, ok := fixture.BackendRequests[name]
		if !ok {
			t.Fatalf("%s: no backend request was recorded", name)
		}
		if request.Method != "POST" {
			t.Fatalf("%s: backend method = %q, want POST", name, request.Method)
		}
		if request.Path != want.path {
			t.Fatalf("%s: backend path = %q, want %q", name, request.Path, want.path)
		}
		if contentType := request.Headers["content-type"]; contentType != "application/json" {
			t.Fatalf("%s: backend content-type = %q, want application/json", name, contentType)
		}
		var body map[string]json.RawMessage
		if err := json.Unmarshal([]byte(request.Body), &body); err != nil {
			t.Fatalf("%s: backend body is not a JSON object: %v", name, err)
		}
		keys := make([]string, 0, len(body))
		for key := range body {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		if strings.Join(keys, ",") != strings.Join(want.keys, ",") {
			t.Fatalf("%s: backend body keys = %v, want %v", name, keys, want.keys)
		}
	}

	// These cases must never reach a backend: a missing url fails before the request, and
	// an unknown api_type is rejected with 400.
	for _, name := range []string{
		"remote/kobold/count#missing_url",
		"remote/textgenerationwebui/encode#tabby#missing_url",
		"remote/textgenerationwebui/encode#ollama",
	} {
		if request, ok := fixture.BackendRequests[name]; ok {
			t.Fatalf("%s reached the mock backend: %+v", name, request)
		}
	}
	if capture := fixture.Responses["remote/textgenerationwebui/encode#ollama"]; capture.Status != 400 {
		t.Fatalf("unknown api_type status = %d, want 400", capture.Status)
	}

	// A backend failure or a non-JSON body becomes {"error":true} at HTTP 200, and the
	// failing request is still observable at the backend.
	for _, name := range []string{"remote/kobold/count#error_status", "remote/kobold/count#not_json", "remote/textgenerationwebui/encode#koboldcpp#error_status"} {
		capture := fixture.Responses[name]
		if capture.Status != 200 {
			t.Fatalf("%s: status = %d, want 200", name, capture.Status)
		}
		var body map[string]json.RawMessage
		if err := json.Unmarshal(capture.Body, &body); err != nil {
			t.Fatalf("%s: body is not a JSON object: %v", name, err)
		}
		if errorRaw, ok := body["error"]; !ok || string(errorRaw) != "true" {
			t.Fatalf("%s: body = %s, want {\"error\":true}", name, capture.Body)
		}
	}
	if request, ok := fixture.BackendRequests["remote/kobold/count#error_status"]; !ok || request.Path != "/fail/extra/tokencount" {
		t.Fatalf("the failing backend request was not observed: %+v", request)
	}

	// The projection follows the pinned `??` chain, so a backend that answers only
	// {"ids":[...]} produces a body with no count key at all, and one that answers only
	// {"value":N} produces ids: [].
	var aphrodite map[string]json.RawMessage
	if err := json.Unmarshal(fixture.Responses["remote/textgenerationwebui/encode#aphrodite"].Body, &aphrodite); err != nil {
		t.Fatal(err)
	}
	if _, hasCount := aphrodite["count"]; hasCount {
		t.Fatalf("aphrodite projection = %s, want no count key", fixture.Responses["remote/textgenerationwebui/encode#aphrodite"].Body)
	}
	var ooba map[string]json.RawMessage
	if err := json.Unmarshal(fixture.Responses["remote/textgenerationwebui/encode#ooba"].Body, &ooba); err != nil {
		t.Fatal(err)
	}
	var oobaIDs []int64
	if err := json.Unmarshal(ooba["ids"], &oobaIDs); err != nil || len(oobaIDs) != 0 {
		t.Fatalf("ooba projection = %s, want an empty ids array", fixture.Responses["remote/textgenerationwebui/encode#ooba"].Body)
	}
}

func readTokenizerManifest(t *testing.T) map[string]string {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "upstream", "manifests", "tokenizers.sha256"))
	if err != nil {
		t.Fatal(err)
	}
	entries := map[string]string{}
	for _, line := range strings.Split(strings.ReplaceAll(string(raw), "\r\n", "\n"), "\n") {
		if line == "" {
			continue
		}
		separator := strings.Index(line, "  ")
		if separator < 0 {
			t.Fatalf("manifest line %q is malformed", line)
		}
		entries[line[separator+2:]] = line[:separator]
	}
	return entries
}

func tokenizerStrings(value any) []string {
	var found []string
	switch typed := value.(type) {
	case string:
		found = append(found, typed)
	case []any:
		for _, item := range typed {
			found = append(found, tokenizerStrings(item)...)
		}
	case map[string]any:
		for _, item := range typed {
			found = append(found, tokenizerStrings(item)...)
		}
	}
	return found
}
