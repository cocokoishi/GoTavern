package server

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"
)

// The tokenizer oracle fixture is the pinned Node capture of every /api/tokenizers
// route. This file owns two things that must hold before any Go implementation can
// claim tokenizer parity:
//
//  1. coverage: the fixture is complete and self-consistent, so a probe that silently
//     stops recording a route or a case fails the build instead of being cited later;
//  2. host independence: every value in the fixture is reproducible on another host,
//     which is what stops a package-version or mutable-branch difference from being
//     recorded as if it were pinned behavior.
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
	tokenizerRemoteRoutes = []string{
		"POST /api/tokenizers/remote/kobold/count",
		"POST /api/tokenizers/remote/textgenerationwebui/encode",
	}
	// A recorded value must never depend on where the oracle ran.
	tokenizerHostPathPattern = regexp.MustCompile(`([A-Za-z]:\\|/Users/|/home/|AppData\\|/tmp/|\\Temp\\)`)
)

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
	deferred := map[string]bool{}
	for _, route := range fixture.Coverage.DeferredRoutes {
		deferred[route] = true
	}
	if len(deferred) != len(tokenizerRemoteRoutes) {
		t.Fatalf("deferred route set = %v, want exactly %v", fixture.Coverage.DeferredRoutes, tokenizerRemoteRoutes)
	}
	for _, route := range tokenizerRemoteRoutes {
		if !deferred[route] {
			t.Fatalf("deferred route set %v is missing %q", fixture.Coverage.DeferredRoutes, route)
		}
	}
	seenRoutes := map[string]bool{}
	for _, route := range fixture.Coverage.Routes {
		if seenRoutes[route.Route] {
			t.Fatalf("route %q appears twice in the coverage list", route.Route)
		}
		seenRoutes[route.Route] = true
		switch {
		case deferred[route.Route]:
			if route.Status != "deferred" || route.Cases != 0 {
				t.Fatalf("deferred route %q is recorded as %s with %d cases", route.Route, route.Status, route.Cases)
			}
		default:
			if route.Status != "recorded" || route.Cases == 0 {
				t.Fatalf("route %q is %s with %d cases; every non-deferred route must have cases", route.Route, route.Status, route.Cases)
			}
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
	if len(recorded) < 600 {
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
	case strings.HasSuffix(routePath, "/count"):
		if _, ok := decodeTokenizerNumber(t, name, body["token_count"]); !ok {
			t.Fatalf("%s: count response has no numeric token_count", name)
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

	// No recorded value may embed the recording host's filesystem layout.
	var decoded any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatal(err)
	}
	for _, value := range tokenizerStrings(decoded) {
		if match := tokenizerHostPathPattern.FindString(value); match != "" {
			t.Fatalf("tokenizer oracle records a host-absolute path %q in %q", match, value)
		}
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
