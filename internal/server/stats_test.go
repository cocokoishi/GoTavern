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
