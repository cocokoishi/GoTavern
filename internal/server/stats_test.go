package server

// Route tests for POST /api/stats/get. The pinned handler answers the stored stats object or `{}`,
// so both branches are covered here: a user with no stats.json and a user whose file is present.

import (
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
