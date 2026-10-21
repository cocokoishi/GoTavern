package server

// Route-level replay of the pinned secrets oracle for the P1 routes (/settings, /read, /write).
//
// The oracle is tests/oracle/sillytavern-1.19.0-secrets.json, produced by tools/probe-secrets.mjs
// from the pinned runtime. It pins the state map, the masking, and the three file states (absent,
// empty, populated) — not just one happy path.

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

type secretsOracleFixture struct {
	Runs map[string]struct {
		AllowKeysExposure bool                       `json:"allowKeysExposure"`
		KeyIDs            map[string]string          `json:"keyIds"`
		State             map[string]json.RawMessage `json:"state"`
		SeededFile        map[string]json.RawMessage `json:"seededFile"`
	} `json:"runs"`
	HTTPRuns []secretsOracleRun `json:"httpRuns"`
}

func loadSecretsOracle(t *testing.T) secretsOracleFixture {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-secrets.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture secretsOracleFixture
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	if len(fixture.Runs) == 0 {
		t.Fatal("secrets oracle has no runs")
	}
	return fixture
}

// secretsRouteHandler builds a handler whose data root holds the given secrets.json content, or no
// secrets.json at all when seed is nil. The user root always exists: a real runtime has the per-user
// directory because startup creates it, and a route that creates secrets.json (the pinned
// _ensureSecretsFile does) needs the parent directory, so a fixture without one would make the
// handler fail for a reason the pinned server never faces.
func secretsRouteHandler(t *testing.T, seed []byte, allowKeysExposure bool) http.Handler {
	t.Helper()
	dataRoot := t.TempDir()
	userRoot := filepath.Join(dataRoot, "default-user")
	if err := os.MkdirAll(filepath.Join(userRoot, "backups"), 0o755); err != nil {
		t.Fatal(err)
	}
	if seed != nil {
		if err := os.WriteFile(filepath.Join(userRoot, "secrets.json"), seed, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return NewHTTPHandlerWithOptions(HTTPHandlerOptions{
		InstallRoot:       dataRoot,
		DataRoot:          dataRoot,
		DisableCSRF:       true,
		AllowKeysExposure: allowKeysExposure,
	})
}

func postSecretsRoute(t *testing.T, handler http.Handler, route string, body string) *httptest.ResponseRecorder {
	t.Helper()
	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, route, strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	handler.ServeHTTP(response, request)
	return response
}

func TestSecretsReadMatchesPinnedState(t *testing.T) {
	fixture := loadSecretsOracle(t)
	for _, name := range []string{"exposureDisabled", "exposureEnabled"} {
		run := fixture.Runs[name]
		seed := marshalSeededFile(t, run.SeededFile)
		handler := secretsRouteHandler(t, seed, run.AllowKeysExposure)
		response := postSecretsRoute(t, handler, "/api/secrets/read", "{}")
		if response.Code != http.StatusOK {
			t.Fatalf("%s: status = %d, want 200 (%s)", name, response.Code, response.Body.String())
		}
		var got map[string]json.RawMessage
		if err := json.Unmarshal(response.Body.Bytes(), &got); err != nil {
			t.Fatalf("%s: response is not an object: %v", name, err)
		}
		if len(got) != len(run.State) {
			t.Fatalf("%s: %d keys, pinned %d", name, len(got), len(run.State))
		}
		for key, wantRaw := range run.State {
			gotRaw, present := got[key]
			if !present {
				t.Fatalf("%s: response is missing %q", name, key)
			}
			if !sameJSONValueRoute(t, gotRaw, wantRaw) {
				t.Fatalf("%s: %q = %s, pinned %s", name, key, gotRaw, wantRaw)
			}
		}
	}
}

func TestSecretsReadOnMissingAndEmptyFileIsAllNull(t *testing.T) {
	fixture := loadSecretsOracle(t)
	for _, name := range []string{"fileAbsent", "fileEmpty"} {
		run := fixture.Runs[name]
		var seed []byte
		if name == "fileEmpty" {
			seed = []byte("{}\n")
		}
		handler := secretsRouteHandler(t, seed, run.AllowKeysExposure)
		response := postSecretsRoute(t, handler, "/api/secrets/read", "{}")
		if response.Code != http.StatusOK {
			t.Fatalf("%s: status = %d", name, response.Code)
		}
		var got map[string]json.RawMessage
		if err := json.Unmarshal(response.Body.Bytes(), &got); err != nil {
			t.Fatal(err)
		}
		if len(got) != len(run.State) {
			t.Fatalf("%s: %d keys, pinned %d", name, len(got), len(run.State))
		}
		for key, value := range got {
			if string(value) != "null" {
				t.Fatalf("%s: %q = %s, want null", name, key, value)
			}
		}
	}
}

func TestSecretsSettingsMatchesPinnedFlag(t *testing.T) {
	for _, allow := range []bool{false, true} {
		handler := secretsRouteHandler(t, nil, allow)
		response := postSecretsRoute(t, handler, "/api/secrets/settings", "{}")
		var got struct {
			AllowKeysExposure *bool `json:"allowKeysExposure"`
		}
		if err := json.Unmarshal(response.Body.Bytes(), &got); err != nil {
			t.Fatalf("allow=%v: %v (%s)", allow, err, response.Body.String())
		}
		if got.AllowKeysExposure == nil || *got.AllowKeysExposure != allow {
			t.Fatalf("allow=%v: answer = %s", allow, response.Body.String())
		}
	}
}

func TestSecretsWriteRejectsInvalidInput(t *testing.T) {
	handler := secretsRouteHandler(t, nil, false)
	for _, test := range []struct {
		name string
		body string
		want int
		text string
	}{
		{name: "no key", body: `{"value":"x"}`, want: http.StatusBadRequest, text: "Invalid key or value"},
		{name: "non-string value", body: `{"key":"api_key_openai","value":42}`, want: http.StatusBadRequest, text: "Invalid key or value"},
		{name: "empty key", body: `{"key":"","value":"x"}`, want: http.StatusBadRequest, text: "Invalid key or value"},
	} {
		response := postSecretsRoute(t, handler, "/api/secrets/write", test.body)
		if response.Code != test.want {
			t.Fatalf("%s: status = %d, want %d", test.name, response.Code, test.want)
		}
		if response.Body.String() != test.text {
			t.Fatalf("%s: body = %q, want %q", test.name, response.Body.String(), test.text)
		}
	}
}

func TestSecretsWriteStoresEntryAndKeepsUnknownFields(t *testing.T) {
	fixture := loadSecretsOracle(t)
	seed := marshalSeededFile(t, fixture.Runs["exposureDisabled"].SeededFile)
	dataRoot := t.TempDir()
	userRoot := filepath.Join(dataRoot, "default-user")
	if err := os.MkdirAll(filepath.Join(userRoot, "backups"), 0o755); err != nil {
		t.Fatal(err)
	}
	secretsPath := filepath.Join(userRoot, "secrets.json")
	if err := os.WriteFile(secretsPath, seed, 0o644); err != nil {
		t.Fatal(err)
	}
	handler := NewHTTPHandlerWithOptions(HTTPHandlerOptions{InstallRoot: dataRoot, DataRoot: dataRoot, DisableCSRF: true})

	response := postSecretsRoute(t, handler, "/api/secrets/write", `{"key":"api_key_openai","value":"sk-synthetic-new-value","label":"third"}`)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", response.Code, response.Body.String())
	}
	var answer struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &answer); err != nil || answer.ID == "" {
		t.Fatalf("answer = %s", response.Body.String())
	}

	written, err := os.ReadFile(secretsPath)
	if err != nil {
		t.Fatal(err)
	}
	var file map[string][]map[string]any
	if err := json.Unmarshal(written, &file); err != nil {
		t.Fatalf("written file is not the pinned shape: %v", err)
	}
	entries := file["api_key_openai"]
	if len(entries) != 4 {
		t.Fatalf("entries = %d, want 4 (three seeded plus one)", len(entries))
	}
	if entries[3]["id"] != answer.ID || entries[3]["value"] != "sk-synthetic-new-value" || entries[3]["label"] != "third" || entries[3]["active"] != true {
		t.Fatalf("new entry = %v", entries[3])
	}
	// Rule 11: the unknown field on the first entry survives the write.
	if _, present := entries[0]["unknown_field"]; !present {
		t.Fatalf("the unknown field was dropped: %v", entries[0])
	}
}

func marshalSeededFile(t *testing.T, seeded map[string]json.RawMessage) []byte {
	t.Helper()
	body, err := json.Marshal(seeded)
	if err != nil {
		t.Fatal(err)
	}
	return body
}

// sameJSONValueRoute compares two JSON values semantically.
func sameJSONValueRoute(t *testing.T, left, right json.RawMessage) bool {
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
