package server

// Route tests for POST /api/stats/get. The pinned handler answers the stored stats object or `{}`,
// so both branches are covered here: a user with no stats.json and a user whose file is present.

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func statsRouteHandler(t *testing.T, statsBody string) http.Handler {
	t.Helper()
	dataRoot := t.TempDir()
	userRoot := filepath.Join(dataRoot, "default-user")
	if err := os.MkdirAll(filepath.Join(userRoot, "backups"), 0o755); err != nil {
		t.Fatal(err)
	}
	if statsBody != "" {
		if err := os.WriteFile(filepath.Join(userRoot, "stats.json"), []byte(statsBody), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return NewHTTPHandlerWithOptions(HTTPHandlerOptions{InstallRoot: dataRoot, DataRoot: dataRoot, DisableCSRF: true})
}

func postStatsGet(t *testing.T, handler http.Handler) *httptest.ResponseRecorder {
	t.Helper()
	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/api/stats/get", strings.NewReader("{}"))
	request.Header.Set("Content-Type", "application/json")
	handler.ServeHTTP(response, request)
	return response
}

func TestStatsGetAnswersEmptyObjectWhenNoStatsFile(t *testing.T) {
	response := postStatsGet(t, statsRouteHandler(t, ""))
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d", response.Code)
	}
	if body := strings.TrimSpace(response.Body.String()); body != "{}" {
		t.Fatalf("body = %q, want {}", body)
	}
}

func TestStatsGetAnswersTheStoredObjectVerbatim(t *testing.T) {
	// Key order is part of the body we forward, so the assertion is on the exact bytes.
	stored := `{"total_gen_time":42,"characters":{"Seraphina":{"total_gen_time":42}}}`
	response := postStatsGet(t, statsRouteHandler(t, stored))
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d", response.Code)
	}
	if body := strings.TrimSpace(response.Body.String()); body != stored {
		t.Fatalf("body = %q, want %q", body, stored)
	}
}

func TestStatsUpdateRequiresABody(t *testing.T) {
	handler := statsRouteHandler(t, "")
	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/api/stats/update", strings.NewReader(""))
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", response.Code)
	}
}

func TestStatsUpdatePersistsWithRefreshedTimestamp(t *testing.T) {
	handler := statsRouteHandler(t, `{"timestamp":1}`)
	body := `{"characters":{"Seraphina":{"total_gen_time":7}}}`
	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/api/stats/update", strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", response.Code, response.Body.String())
	}
	stored, err := readStoredStatsForTest(t, handler)
	if err != nil {
		t.Fatal(err)
	}
	if string(stored) == "" {
		t.Fatal("nothing was persisted")
	}
	var decoded map[string]any
	if err := json.Unmarshal(stored, &decoded); err != nil {
		t.Fatalf("stored body is not JSON: %v", err)
	}
	timestamp, present := decoded["timestamp"].(float64)
	if !present {
		t.Fatalf("no timestamp in %s", stored)
	}
	if timestamp <= 1 {
		t.Fatalf("the timestamp was not refreshed: %v", timestamp)
	}
	if _, present := decoded["characters"]; !present {
		t.Fatalf("the posted body was not stored: %s", stored)
	}
}

func TestStatsAliasesRedirectToTheCanonicalRoutes(t *testing.T) {
	handler := statsRouteHandler(t, "")
	for source, destination := range map[string]string{
		"/getstats":      "/api/stats/get",
		"/updatestats":   "/api/stats/update",
		"/recreatestats": "/api/stats/recreate",
	} {
		response := httptest.NewRecorder()
		request := httptest.NewRequest(http.MethodPost, source, strings.NewReader("{}"))
		handler.ServeHTTP(response, request)
		if response.Code != http.StatusFound {
			t.Fatalf("%s: status = %d, want 302", source, response.Code)
		}
		if location := response.Header().Get("Location"); location != destination {
			t.Fatalf("%s: Location = %q, want %q", source, location, destination)
		}
	}
}

// readStoredStatsForTest reads back the stats file the route wrote.
func readStoredStatsForTest(t *testing.T, handler http.Handler) ([]byte, error) {
	t.Helper()
	response := postStatsGet(t, handler)
	return response.Body.Bytes(), nil
}

// statsRecreateHandler builds a user tree with one character and one chat file, so the recreate
// route has something to aggregate, plus an optional pre-existing stats.json.
func statsRecreateHandler(t *testing.T, statsBody string) (http.Handler, string) {
	t.Helper()
	dataRoot := t.TempDir()
	userRoot := filepath.Join(dataRoot, "default-user")
	for _, directory := range []string{"backups", "characters", filepath.Join("chats", "Seraphina")} {
		if err := os.MkdirAll(filepath.Join(userRoot, directory), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(userRoot, "characters", "Seraphina.png"), nil, 0o644); err != nil {
		t.Fatal(err)
	}
	chat := "{\"mes\":\"Hello there\",\"is_user\":true,\"send_date\":\"2024-01-02T03:04:05.006Z\"}\n"
	if err := os.WriteFile(filepath.Join(userRoot, "chats", "Seraphina", "chat.jsonl"), []byte(chat), 0o644); err != nil {
		t.Fatal(err)
	}
	if statsBody != "" {
		if err := os.WriteFile(filepath.Join(userRoot, "stats.json"), []byte(statsBody), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return NewHTTPHandlerWithOptions(HTTPHandlerOptions{InstallRoot: dataRoot, DataRoot: dataRoot, DisableCSRF: true}), userRoot
}

func postStatsRoute(t *testing.T, handler http.Handler, route string) *httptest.ResponseRecorder {
	t.Helper()
	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, route, strings.NewReader("{}"))
	request.Header.Set("Content-Type", "application/json")
	handler.ServeHTTP(response, request)
	return response
}

// TestStatsRecreateWritesStatsWhenThereIsNone pins POST /api/stats/recreate (stats.js:452): the route
// recalculates from the chat files, persists them, and answers Express's sendStatus(200) body.
func TestStatsRecreateWritesStatsWhenThereIsNone(t *testing.T) {
	handler, userRoot := statsRecreateHandler(t, "")
	response := postStatsRoute(t, handler, "/api/stats/recreate")
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", response.Code)
	}
	if body := response.Body.String(); body != "OK" {
		t.Fatalf("body = %q, want the Express sendStatus body", body)
	}
	written, err := os.ReadFile(filepath.Join(userRoot, "stats.json"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(written), `"Seraphina.png"`) {
		t.Fatalf("the recalculated stats do not mention the character: %s", written)
	}
	if !strings.Contains(string(written), `"timestamp"`) {
		t.Fatalf("the recalculated stats carry no timestamp: %s", written)
	}
}

// TestStatsRecreateReplacesAValidStatsFile is the discriminating case: unlike the startup hook, the
// route must overwrite a valid stored file rather than return it untouched.
func TestStatsRecreateReplacesAValidStatsFile(t *testing.T) {
	handler, userRoot := statsRecreateHandler(t, `{"marker":true,"timestamp":1}`)
	response := postStatsRoute(t, handler, "/api/stats/recreate")
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", response.Code)
	}
	written, err := os.ReadFile(filepath.Join(userRoot, "stats.json"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(written), "marker") {
		t.Fatalf("the valid stale stats file survived the recreate: %s", written)
	}
	if !strings.Contains(string(written), `"Seraphina.png"`) {
		t.Fatalf("the recalculated stats do not mention the character: %s", written)
	}
	// GET reads the file back, so it must now serve the recalculated object.
	served := postStatsGet(t, handler).Body.String()
	if served != string(written) {
		t.Fatalf("/api/stats/get served %q, want the rewritten %q", served, written)
	}
}
