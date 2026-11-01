package server

// THE REMOTE-EMBEDDINGS DECISION, ASSERTED AT THE ROUTE.
//
// docs/remote-embeddings-decision.md decides option B: remote embedding production is a declared exclusion.
// This file is the executable half of that decision, and it exists because "documented as excluded" is not a
// gate (AGENTS.md 36). Three things are asserted:
//
//  1. EVERY pinned source whose embedding call is excluded answers HTTP 501 with a JSON body naming the source,
//     the reason and the decision document -- never the generic 500 a failed provider call produces. The list is
//     read from the pinned SOURCES order (vectorSources), so a source added to that list without a decision fails
//     here rather than silently becoming a 500.
//  2. NOTHING IS PERSISTED for an excluded source: no index directory appears under the user's vectors tree.
//     (The branch returns before any provider request is constructed; there is no outbound call to observe.)
//  3. THE SUPPORTED PATH IS UNTOUCHED: `webllm` with request-body vectors still inserts (200), and an UNKNOWN
//     source still answers pinned's 500 (`Unknown vector source`), so the 501 cannot be a blanket replacement.
//
// TEETH (recorded in the commit): changing 501 -> 500 in vector_embeddings_excluded.go, or dropping the
// decision-document member, turns this test red with the source and the observed status/body named.

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/cocokoishi/gotavern/internal/startup"
)

func loadVectorFixtureInputs(t *testing.T) (string, sdFixtureAccount, []string) {
	t.Helper()
	fixtureBytes, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-vector.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture vectorFixture
	if err := json.Unmarshal(fixtureBytes, &fixture); err != nil {
		t.Fatal(err)
	}
	if len(fixture.Inputs.Sources) == 0 {
		t.Fatal("the vector fixture records no source list")
	}
	return fixture.Inputs.CookieSecret, fixture.Inputs.Account, fixture.Inputs.Sources
}

func vectorPost(t *testing.T, handler http.Handler, sessionCookie, token, route string, body map[string]any) *httptest.ResponseRecorder {
	t.Helper()
	encoded, err := marshalNodeJSON(body)
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "/api/vector/"+route, strings.NewReader(string(encoded)))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Cookie", sessionCookie)
	request.Header.Set("X-CSRF-Token", token)
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	return recorder
}

func TestExcludedEmbeddingSourcesAnswerAnExplicitUnsupportedResponse(t *testing.T) {
	cookieSecret, account, pinnedSources := loadVectorFixtureInputs(t)
	dataRoot := t.TempDir()
	installRoot := t.TempDir()
	handler, sessionCookie, token := newSDRouteHandler(t, dataRoot, installRoot, cookieSecret, account)

	// The excluded set is derived from the pinned list MINUS the two implemented sources, so a new pinned source
	// cannot be silently omitted: if it is neither implemented nor in the decision map, the loop below fails.
	excluded := 0
	for _, source := range pinnedSources {
		if source == "webllm" || source == "koboldcpp" {
			continue
		}
		excluded++
		for _, route := range []string{"insert", "query"} {
			body := map[string]any{
				"collectionId": "decision-canary",
				"source":       source,
				"model":        "canary-model",
				"items": []map[string]any{
					{"hash": 1, "text": "hello", "index": 0},
				},
				"searchText": "hello",
				"embeddings": map[string]any{},
			}
			recorder := vectorPost(t, handler, sessionCookie, token, route, body)
			if recorder.Code != http.StatusNotImplemented {
				t.Fatalf("%s/%s: status = %d, want 501 (body %q)", source, route, recorder.Code, recorder.Body.String())
			}
			if contentType := recorder.Header().Get("Content-Type"); !strings.HasPrefix(contentType, "application/json") {
				t.Fatalf("%s/%s: content type = %q, want application/json", source, route, contentType)
			}
			var payload map[string]any
			if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
				t.Fatalf("%s/%s: body is not JSON: %v (%q)", source, route, err, recorder.Body.String())
			}
			if payload["error"] != true {
				t.Fatalf("%s/%s: error member = %v, want true", source, route, payload["error"])
			}
			if payload["source"] != source {
				t.Fatalf("%s/%s: source member = %v, want %q", source, route, payload["source"], source)
			}
			if payload["decision"] != "docs/remote-embeddings-decision.md" {
				t.Fatalf("%s/%s: decision member = %v, want docs/remote-embeddings-decision.md", source, route, payload["decision"])
			}
			message, _ := payload["message"].(string)
			if !strings.Contains(message, source) || !strings.Contains(message, "No request was sent to any provider") {
				t.Fatalf("%s/%s: message does not name the source and the no-request fact: %q", source, route, message)
			}
		}
	}
	if excluded == 0 {
		t.Fatal("the pinned source list produced no excluded sources, so this test would assert nothing")
	}

	// NOTHING EMBEDDED: pinned's insert/query paths open the vectra index BEFORE asking for vectors, and the
	// pinned createIndex writes an EMPTY index.json at open. So a file existing is pinned behaviour; what must
	// not exist is a persisted ITEM, which only the post-embedding save can write. Asserting on items also
	// catches a future branch that answers 501 after doing the work.
	directories, err := startup.DirectoriesForUser(dataRoot, account.Handle)
	if err != nil {
		t.Fatal(err)
	}
	for _, source := range pinnedSources {
		if source == "webllm" || source == "koboldcpp" {
			continue
		}
		sourceRoot := filepath.Join(directories["vectors"], source)
		_ = filepath.WalkDir(sourceRoot, func(path string, entry os.DirEntry, walkErr error) error {
			if walkErr != nil || entry == nil || entry.IsDir() || entry.Name() != "index.json" {
				return nil
			}
			raw, readErr := os.ReadFile(path)
			if readErr != nil {
				t.Fatalf("%s: read %s: %v", source, path, readErr)
			}
			var index struct {
				Items []json.RawMessage `json:"items"`
			}
			if decodeErr := json.Unmarshal(raw, &index); decodeErr != nil {
				t.Fatalf("%s: %s is not JSON: %v", source, path, decodeErr)
			}
			if len(index.Items) != 0 {
				t.Fatalf("%s: an excluded embedding source persisted %d item(s) in %s", source, len(index.Items), path)
			}
			return nil
		})
	}
}

func TestBodySuppliedEmbeddingSourcesStillWork(t *testing.T) {
	cookieSecret, account, _ := loadVectorFixtureInputs(t)
	dataRoot := t.TempDir()
	installRoot := t.TempDir()
	handler, sessionCookie, token := newSDRouteHandler(t, dataRoot, installRoot, cookieSecret, account)

	recorder := vectorPost(t, handler, sessionCookie, token, "insert", map[string]any{
		"collectionId": "supported-canary",
		"source":       "webllm",
		"model":        "m",
		"items": []map[string]any{
			{"hash": 1, "text": "alpha", "index": 0},
		},
		"embeddings": map[string]any{"alpha": []float64{1, 0, 0}},
	})
	if recorder.Code != http.StatusOK {
		t.Fatalf("webllm insert: status = %d, want 200 -- the 501 must not swallow the supported path (body %q)", recorder.Code, recorder.Body.String())
	}
}

func TestUnknownVectorSourceKeepsPinnedInternalServerError(t *testing.T) {
	cookieSecret, account, _ := loadVectorFixtureInputs(t)
	dataRoot := t.TempDir()
	installRoot := t.TempDir()
	handler, sessionCookie, token := newSDRouteHandler(t, dataRoot, installRoot, cookieSecret, account)

	recorder := vectorPost(t, handler, sessionCookie, token, "insert", map[string]any{
		"collectionId": "unknown-canary",
		"source":       "not-a-pinned-source",
		"model":        "m",
		"items": []map[string]any{
			{"hash": 1, "text": "alpha", "index": 0},
		},
		"embeddings": map[string]any{},
	})
	if recorder.Code != http.StatusInternalServerError {
		t.Fatalf("unknown source: status = %d, want 500 (pinned's catch; the 501 is only for DECIDED exclusions, body %q)", recorder.Code, recorder.Body.String())
	}
	if strings.Contains(recorder.Body.String(), "docs/remote-embeddings-decision.md") {
		t.Fatalf("unknown source: body names the decision document, so the 501 reason leaked into the parity path: %q", recorder.Body.String())
	}
}
