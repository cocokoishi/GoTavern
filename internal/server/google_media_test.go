package server

// Replay of tests/oracle/sillytavern-1.19.0-google-media.json, recorded by tools/probe-google-media.mjs.
//
// The scenario/peer/secret helpers are the ones the native-TTS test established, because the recorded
// shape is identical: status, headers, body bytes, and the outbound method, path, body and contract
// headers in both directions. The AI Studio proxy scenarios carry the proxy URL in the REQUEST, so the
// test substitutes the peer origin and compares the path the route builds on top of that base.
//
// `googleConfigValue` is asserted separately: the pinned `getConfigValue` resolves an environment
// override, then the runtime config file, then a default, and a reader that looks at the wrong file or
// ignores the override would pass a body comparison made entirely of defaults.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"testing"
)

// googleSeedPattern masks a numeric seed exactly the way the probe masks it. The probe cannot tell an
// explicit seed from a randomized one, so the test masks the Go side too rather than comparing a number
// against the recorded marker.
var googleSeedPattern = regexp.MustCompile(`"seed":-?\d+`)

func normalizeGoogleSeed(body string) string {
	return googleSeedPattern.ReplaceAllString(body, `"seed":"<seed>"`)
}

func loadGoogleMediaOracle(t *testing.T) googleTTSFixture {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-google-media.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture googleTTSFixture
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	if len(fixture.Scenarios) < 15 {
		t.Fatalf("the google-media oracle records only %d scenarios", len(fixture.Scenarios))
	}
	return fixture
}

func TestGoogleMediaMatchesPinnedOracle(t *testing.T) {
	fixture := loadGoogleMediaOracle(t)
	names := make([]string, 0, len(fixture.Scenarios))
	for name := range fixture.Scenarios {
		names = append(names, name)
	}
	sort.Strings(names)

	for _, name := range names {
		scenario := fixture.Scenarios[name]
		t.Run(name, func(t *testing.T) {
			peer := newGoogleTTSPeer(t, scenario.Mocks)
			t.Setenv("GOTAVERN_GOOGLE_MAKERSUITE_URL", peer.server.URL)
			t.Setenv("GOTAVERN_GOOGLE_VERTEX_URL", peer.server.URL)
			t.Setenv("GOTAVERN_GOOGLE_VERTEX_GLOBAL_URL", peer.server.URL)
			t.Setenv("GOTAVERN_GOOGLE_OAUTH_URL", peer.server.URL)
			dataRoot := t.TempDir()
			handler := NewHTTPHandlerWithOptions(HTTPHandlerOptions{InstallRoot: dataRoot, DataRoot: dataRoot, DisableCSRF: true})
			writeGoogleTTSSecrets(t, dataRoot, scenario.Secrets)
			response := postSecretsRoute(t, handler, scenario.Route, requestBodyForPeer(t, scenario.RequestBody, peer))

			if response.Code != scenario.Response.Status {
				t.Fatalf("status = %d, pinned %d (body %q)", response.Code, scenario.Response.Status, response.Body.String())
			}
			if response.Body.String() != scenario.Response.BodyText {
				t.Fatalf("body = %q, pinned %q", response.Body.String(), scenario.Response.BodyText)
			}
			if got, want := response.Header().Get("Content-Type"), scenario.Response.Headers["content-type"]; got != want {
				t.Fatalf("content type = %q, pinned %q", got, want)
			}
			if len(peer.seen) != len(scenario.Outbound) {
				t.Fatalf("outbound requests = %d, pinned %d", len(peer.seen), len(scenario.Outbound))
			}
			for index, recorded := range scenario.Outbound {
				actual := peer.seen[index]
				if actual.Method != recorded.Method {
					t.Fatalf("request %d method = %s, pinned %s", index, actual.Method, recorded.Method)
				}
				if target := googleTTSPath(t, recorded.URL); actual.URL != target {
					t.Fatalf("request %d target = %q, pinned %q", index, actual.URL, target)
				}
				if normalizeGoogleSeed(actual.Body) != recorded.Body {
					t.Fatalf("request %d body = %q, pinned %q", index, actual.Body, recorded.Body)
				}
				for _, header := range []string{"authorization", "x-goog-api-key", "content-type"} {
					if got, want := actual.Headers[header], recorded.Headers[header]; got != want {
						t.Fatalf("request %d header %s = %q, pinned %q", index, header, got, want)
					}
				}
			}
		})
	}
}

// TestGoogleConfigValueResolvesLikePinned pins the three-step resolution the pinned getConfigValue uses.
func TestGoogleConfigValueResolvesLikePinned(t *testing.T) {
	options := HTTPHandlerOptions{}
	if got := googleAPIVersion(options); got != "v1beta" {
		t.Fatalf("the gemini.apiVersion default = %q, pinned v1beta", got)
	}
	if got := googleConfigValue(options, []string{"gemini", "image", "personGeneration"}, "allow_adult"); got != "allow_adult" {
		t.Fatalf("the personGeneration default = %q, pinned allow_adult", got)
	}

	// The environment override wins over the file.
	t.Setenv("SILLYTAVERN_GEMINI_IMAGE_PERSONGENERATION", "block_all")
	if got := googleConfigValue(options, []string{"gemini", "image", "personGeneration"}, "allow_adult"); got != "block_all" {
		t.Fatalf("the environment override = %q, pinned block_all", got)
	}
	t.Setenv("SILLYTAVERN_GEMINI_APIVERSION", "v1")
	if got := googleAPIVersion(options); got != "v1" {
		t.Fatalf("the apiVersion override = %q, pinned v1", got)
	}

	// The file is read from the resolved install root, and only from it. The overrides above are cleared
	// first, because an environment override legitimately wins over the file.
	if err := os.Unsetenv("SILLYTAVERN_GEMINI_IMAGE_PERSONGENERATION"); err != nil {
		t.Fatal(err)
	}
	if err := os.Unsetenv("SILLYTAVERN_GEMINI_APIVERSION"); err != nil {
		t.Fatal(err)
	}
	installRoot := t.TempDir()
	config := "gemini:\n  apiVersion: v1beta9\n  image:\n    personGeneration: block_none\n"
	if err := os.WriteFile(filepath.Join(installRoot, "config.yaml"), []byte(config), 0o600); err != nil {
		t.Fatal(err)
	}
	fileOptions := HTTPHandlerOptions{InstallRoot: installRoot}
	t.Setenv("SILLYTAVERN_GEMINI_APIVERSION", "")
	// An EMPTY override still wins, which is the pinned behaviour: the variable exists.
	if got := googleAPIVersion(fileOptions); got != "" {
		t.Fatalf("an empty environment override = %q, pinned the empty value", got)
	}
	if err := os.Unsetenv("SILLYTAVERN_GEMINI_APIVERSION"); err != nil {
		t.Fatal(err)
	}
	if got := googleAPIVersion(fileOptions); got != "v1beta9" {
		t.Fatalf("the config-file apiVersion = %q, pinned v1beta9", got)
	}
	if got := googleConfigValue(fileOptions, []string{"gemini", "image", "personGeneration"}, "allow_adult"); got != "block_none" {
		t.Fatalf("the config-file personGeneration = %q, pinned block_none", got)
	}
	if got := googleConfigValue(HTTPHandlerOptions{}, []string{"gemini", "apiVersion"}, "v1beta"); got != "v1beta" {
		t.Fatalf("an install root with no config falls back to %q", got)
	}
}
