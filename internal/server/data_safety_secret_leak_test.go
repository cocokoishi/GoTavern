package server

// SECRET-IN-LOG / SECRET-IN-BODY SWEEP ACROSS ERROR PATHS.
//
// The committed oracle proves the SECRETS ROUTES answer the pinned shapes on their recorded runs. This
// file is the broad half: a distinctive planted secret is driven through the error paths of every
// secret-touching route (malformed bodies, missing members, type errors, the no-exposure gate) and
// every response body and header must be free of it. Before this file the only leak assertion was the
// outbound transport's error-string test (internal/outbound/transport_matrix_test.go) and the oracle
// rows, neither of which sweeps the route error paths.
//
// What is swept here: /api/secrets/{read,view,find,write,delete,rotate,rename,settings} and
// /api/settings/save. The assertion is deliberately byte-level on the whole response (body + headers),
// because a leak does not have to be JSON: a status detail or a header value is enough.
//
// NOT swept, stated rather than implied: provider error surfaces (they need an outbound peer and are
// covered by the outbound secret-leak test), stdout/stderr log capture (the handler options do not
// expose the console writers to tests; the audit of log statements is recorded in
// docs/data-safety.md), and request-side echo of the secret by the CLIENT (not a server leak).

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const plantedSecretMarker = "sk-gotavern-planted-DEADBEEF-0123456789abcdef"

func TestSecretValueIsNeverEchoedOnRouteErrorPaths(t *testing.T) {
	dataRoot := t.TempDir()
	userRoot := filepath.Join(dataRoot, "default-user")
	if err := os.MkdirAll(filepath.Join(userRoot, "backups"), 0o755); err != nil {
		t.Fatal(err)
	}
	secrets, err := marshalNodeJSON(struct {
		Key    string `json:"key"`
		Value  string `json:"value"`
		Label  string `json:"label"`
		Active bool   `json:"active"`
	}{"api_key_openai", plantedSecretMarker, "planted", true})
	if err != nil {
		t.Fatal(err)
	}
	seeded := []byte(`{"api_key_openai":[` + string(secrets) + `],"api_key_claude":[` + string(secrets) + `]}`)
	if err := os.WriteFile(filepath.Join(userRoot, "secrets.json"), seeded, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(userRoot, "settings.json"), []byte(`{"seed":true}`), 0o600); err != nil {
		t.Fatal(err)
	}
	handler := NewHTTPHandlerWithOptions(HTTPHandlerOptions{
		InstallRoot: dataRoot, DataRoot: dataRoot, DisableCSRF: true, AllowKeysExposure: false,
	})

	// Parameter guard: the seeded entry must be the ACTIVE one, or the server never reads its value
	// and every leak assertion below would pass for the wrong reason (the entry would be absent).
	stateRequest := httptest.NewRequest(http.MethodPost, "/api/secrets/read", strings.NewReader(`{}`))
	stateRequest.Header.Set("Content-Type", "application/json")
	stateResponse := httptest.NewRecorder()
	handler.ServeHTTP(stateResponse, stateRequest)
	if !strings.Contains(stateResponse.Body.String(), `"api_key_openai"`) ||
		strings.Contains(stateResponse.Body.String(), `"api_key_openai":null`) {
		t.Fatalf("the planted secret is not visible in the served state map, so the sweep would be "+
			"vacuous: %s", stateResponse.Body.String())
	}
	if strings.Contains(stateResponse.Body.String(), plantedSecretMarker) {
		t.Fatalf("the state map exposed the raw secret value instead of masking it: %s", stateResponse.Body.String())
	}

	scenarios := []struct {
		name  string
		route string
		body  string
	}{
		{name: "read state map masks values", route: "/api/secrets/read", body: `{}`},
		{name: "view without exposure", route: "/api/secrets/view", body: `{}`},
		{name: "find without exposure", route: "/api/secrets/find", body: `{"key":"api_key_openai"}`},
		{name: "settings without exposure", route: "/api/secrets/settings", body: `{}`},
		{name: "write malformed", route: "/api/secrets/write", body: `{"key":`},
		{name: "write non-string value", route: "/api/secrets/write", body: `{"key":"api_key_openai","value":42}`},
		{name: "write missing value", route: "/api/secrets/write", body: `{"key":"api_key_openai"}`},
		{name: "delete malformed", route: "/api/secrets/delete", body: `{"key":`},
		{name: "delete unknown key", route: "/api/secrets/delete", body: `{"key":"nope"}`},
		{name: "rotate malformed", route: "/api/secrets/rotate", body: `{"old_key":`},
		{name: "rotate unknown key", route: "/api/secrets/rotate", body: `{"old_key":"nope","new_key":"api_key_claude"}`},
		{name: "rename malformed", route: "/api/secrets/rename", body: `{"old_name":`},
		{name: "rename unknown key", route: "/api/secrets/rename", body: `{"old_name":"nope","new_name":"api_key_claude"}`},
		{name: "settings save malformed", route: "/api/settings/save", body: `{"truncated":`},
		{name: "settings save scalar", route: "/api/settings/save", body: `42`},
	}
	for _, scenario := range scenarios {
		t.Run(scenario.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodPost, scenario.route, strings.NewReader(scenario.body))
			request.Header.Set("Content-Type", "application/json")
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			if response.Code == http.StatusOK && scenario.route == "/api/secrets/read" {
				// The masked state map is allowed to answer 200; it must still not carry the value.
			}
			if strings.Contains(response.Body.String(), plantedSecretMarker) {
				t.Fatalf("%s echoed the planted secret in its response body (status %d): %q",
					scenario.route, response.Code, truncateForReport(response.Body.String()))
			}
			for name, values := range response.Header() {
				for _, value := range values {
					if strings.Contains(value, plantedSecretMarker) {
						t.Fatalf("%s echoed the planted secret in header %s: %q", scenario.route, name, value)
					}
				}
			}
		})
	}
}

func truncateForReport(body string) string {
	if len(body) <= 300 {
		return body
	}
	return body[:300] + "..."
}
