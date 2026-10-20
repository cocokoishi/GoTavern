package server

// Route-level tests for the two Horde startup routes. Under the seam convention in
// docs/tokenizer-parity-plan.md §11 these tests point the route at a local mock and exercise the REAL
// fetch path, with the failure path produced by pointing the seam at a closed port.
//
// Each of the seven observables in §11 is asserted, including the two a careful implementation would
// get wrong: a non-2xx peer must answer `{ok:false}` with our status 200 (not 500), and a metadata
// failure must still return the UNMERGED list.

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

const hordeClosedPort = "http://127.0.0.1:1"

type hordeMock struct {
	server        *httptest.Server
	heartbeatHits atomic.Int32
	modelsHits    atomic.Int32
	metadataHits  atomic.Int32
	agentSeen     atomic.Value
	lastPath      atomic.Value
}

func newHordeMock(t *testing.T, behaviour func(w http.ResponseWriter, r *http.Request)) *hordeMock {
	t.Helper()
	mock := &hordeMock{}
	mock.agentSeen.Store("")
	mock.lastPath.Store("")
	mock.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mock.agentSeen.Store(r.Header.Get("Client-Agent"))
		mock.lastPath.Store(r.URL.Path + "?" + r.URL.RawQuery)
		switch {
		case strings.HasPrefix(r.URL.Path, "/api/v2/status/heartbeat"):
			mock.heartbeatHits.Add(1)
		case strings.HasPrefix(r.URL.Path, "/api/v2/status/models"):
			mock.modelsHits.Add(1)
		default:
			mock.metadataHits.Add(1)
		}
		behaviour(w, r)
	}))
	t.Cleanup(mock.server.Close)
	return mock
}

func hordeRouteHandler(t *testing.T, mock *hordeMock) http.Handler {
	t.Helper()
	if mock != nil {
		t.Setenv("GOTAVERN_HORDE_API_URL", mock.server.URL)
		t.Setenv("GOTAVERN_HORDE_METADATA_URL", mock.server.URL+"/metadata")
	}
	hordeModels.clear()
	return NewHTTPHandlerWithOptions(HTTPHandlerOptions{InstallRoot: t.TempDir(), DataRoot: t.TempDir(), DisableCSRF: true})
}

func postHorde(t *testing.T, handler http.Handler, route string, body string) *httptest.ResponseRecorder {
	t.Helper()
	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, route, strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	handler.ServeHTTP(response, request)
	return response
}

func isModelsRequest(r *http.Request) bool {
	return strings.HasPrefix(r.URL.Path, "/api/v2/status/models")
}

// TestHordeSeamDefaults pins the seam defaults to the pinned URLs, so a drift cannot silently change
// production while tests keep passing against an override.
func TestHordeSeamDefaults(t *testing.T) {
	t.Setenv("GOTAVERN_HORDE_API_URL", "")
	t.Setenv("GOTAVERN_HORDE_METADATA_URL", "")
	if got := hordeAPIBaseURL(); got != "https://aihorde.net" {
		t.Fatalf("API seam default = %q", got)
	}
	if got := hordeMetadataURL(); got != "https://raw.githubusercontent.com/db0/AI-Horde-text-model-reference/main/db.json" {
		t.Fatalf("metadata seam default = %q", got)
	}
}

// TestHordeStatusResolvedNonOkAnswersFalse is the case a `if !ok return 500` guard would break: the
// fetch RESOLVED, so the pinned handler sends the boolean with our own status 200.
func TestHordeStatusResolvedNonOkAnswersFalse(t *testing.T) {
	mock := newHordeMock(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	})
	handler := hordeRouteHandler(t, mock)
	response := postHorde(t, handler, "/api/horde/status", "{}")
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 carrying {ok:false}", response.Code)
	}
	if body := strings.TrimSpace(response.Body.String()); body != `{"ok":false}` {
		t.Fatalf("body = %q, want {\"ok\":false}", body)
	}
}

func TestHordeStatusResolvedOkAnswersTrue(t *testing.T) {
	mock := newHordeMock(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"message":"OK"}`))
	})
	handler := hordeRouteHandler(t, mock)
	response := postHorde(t, handler, "/api/horde/status", "{}")
	if body := strings.TrimSpace(response.Body.String()); body != `{"ok":true}` {
		t.Fatalf("body = %q", body)
	}
	if agent, _ := mock.agentSeen.Load().(string); agent != upstreamAgent {
		t.Fatalf("Client-Agent = %q, want %q", agent, upstreamAgent)
	}
}

// TestHordeStatusClosedPortAnswers500 is the REJECTED-fetch case, the only path to a 500.
func TestHordeStatusClosedPortAnswers500(t *testing.T) {
	t.Setenv("GOTAVERN_HORDE_API_URL", hordeClosedPort)
	hordeModels.clear()
	handler := NewHTTPHandlerWithOptions(HTTPHandlerOptions{InstallRoot: t.TempDir(), DataRoot: t.TempDir(), DisableCSRF: true})
	response := postHorde(t, handler, "/api/horde/status", "{}")
	if response.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", response.Code)
	}
}

// TestHordeTextModelsMergesMetadata asserts the merge, including is_whitelisted true for a known
// model and false for an unknown one.
func TestHordeTextModelsMergesMetadata(t *testing.T) {
	mock := newHordeMock(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if isModelsRequest(r) {
			_, _ = w.Write([]byte(`[{"name":"known","count":3},{"name":"unknown","count":1}]`))
			return
		}
		_, _ = w.Write([]byte(`{"known":{"description":"described"}}`))
	})
	handler := hordeRouteHandler(t, mock)
	response := postHorde(t, handler, "/api/horde/text-models", "{}")
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", response.Code, response.Body.String())
	}
	var models []map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &models); err != nil {
		t.Fatalf("not a list: %v (%s)", err, response.Body.String())
	}
	if models[0]["is_whitelisted"] != true || models[0]["description"] != "described" || models[0]["count"] != float64(3) {
		t.Fatalf("known model = %v", models[0])
	}
	if models[1]["is_whitelisted"] != false {
		t.Fatalf("unknown model = %v", models[1])
	}
}

// TestHordeTextModelsNonOkWithValidJSONIsReturnedAsIs pins the missing `ok` guard: the pinned handler
// parses without checking, so an error-status body with valid JSON comes back as-is.
func TestHordeTextModelsNonOkWithValidJSONIsReturnedAsIs(t *testing.T) {
	mock := newHordeMock(t, func(w http.ResponseWriter, r *http.Request) {
		if isModelsRequest(r) {
			w.WriteHeader(http.StatusInternalServerError)
			_, _ = w.Write([]byte(`[{"name":"from-error-body"}]`))
			return
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{}`))
	})
	handler := hordeRouteHandler(t, mock)
	response := postHorde(t, handler, "/api/horde/text-models", "{}")
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (no ok guard); body=%s", response.Code, response.Body.String())
	}
	var models []map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &models); err != nil {
		t.Fatalf("not a list: %v (%s)", err, response.Body.String())
	}
	if models[0]["name"] != "from-error-body" {
		t.Fatalf("list = %v", models)
	}
}

func TestHordeTextModelsNonJSONAnswers500(t *testing.T) {
	mock := newHordeMock(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`not json at all`))
	})
	handler := hordeRouteHandler(t, mock)
	response := postHorde(t, handler, "/api/horde/text-models", "{}")
	if response.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", response.Code)
	}
}

func TestHordeTextModelsClosedPortAnswers500(t *testing.T) {
	t.Setenv("GOTAVERN_HORDE_API_URL", hordeClosedPort)
	hordeModels.clear()
	handler := NewHTTPHandlerWithOptions(HTTPHandlerOptions{InstallRoot: t.TempDir(), DataRoot: t.TempDir(), DisableCSRF: true})
	response := postHorde(t, handler, "/api/horde/text-models", "{}")
	if response.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", response.Code)
	}
}

// TestHordeTextModelsMetadataFailureKeepsUnmergedList proves the UNMERGED list is returned, not merely
// that the route did not fail: the upstream models come back and no is_whitelisted was added.
func TestHordeTextModelsMetadataFailureKeepsUnmergedList(t *testing.T) {
	mock := newHordeMock(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`[{"name":"only"}]`))
	})
	t.Setenv("GOTAVERN_HORDE_API_URL", mock.server.URL)
	t.Setenv("GOTAVERN_HORDE_METADATA_URL", hordeClosedPort)
	hordeModels.clear()
	handler := NewHTTPHandlerWithOptions(HTTPHandlerOptions{InstallRoot: t.TempDir(), DataRoot: t.TempDir(), DisableCSRF: true})
	response := postHorde(t, handler, "/api/horde/text-models", "{}")
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", response.Code, response.Body.String())
	}
	var models []map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &models); err != nil {
		t.Fatal(err)
	}
	if len(models) != 1 || models[0]["name"] != "only" {
		t.Fatalf("list = %v", models)
	}
	if _, present := models[0]["is_whitelisted"]; present {
		t.Fatalf("the list was merged despite the metadata failure: %v", models[0])
	}
}

// TestHordeTextModelsCache pins the 60-second cache, the `models` key and the force bypass by counting
// peer requests rather than by timing.
func TestHordeTextModelsCache(t *testing.T) {
	mock := newHordeMock(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if isModelsRequest(r) {
			_, _ = w.Write([]byte(`[{"name":"cached"}]`))
			return
		}
		_, _ = w.Write([]byte(`{}`))
	})
	handler := hordeRouteHandler(t, mock)
	postHorde(t, handler, "/api/horde/text-models", "{}")
	postHorde(t, handler, "/api/horde/text-models", "{}")
	if hits := mock.modelsHits.Load(); hits != 1 {
		t.Fatalf("the second call hit the peer: modelsHits = %d, want 1", hits)
	}
	postHorde(t, handler, "/api/horde/text-models", `{"force":true}`)
	if hits := mock.modelsHits.Load(); hits != 2 {
		t.Fatalf("force did not bypass the cache: modelsHits = %d, want 2", hits)
	}
}
