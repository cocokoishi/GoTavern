package server

// Route-level replay of tests/oracle/sillytavern-1.19.0-translate.json, recorded by
// tools/probe-translate.mjs against the real pinned server.
//
// Six routes are covered: libre, deepl, yandex, lingva, onering, deeplx. `/api/translate/google` and
// `/api/translate/bing` have no fixture and no implementation, because their request flow lives in
// the `google-translate-api-x` / `bing-translate-api` packages rather than in the pinned endpoint.
//
// The Go side replays the SAME controlled peer through a real local listener. Libre/DeepLX/OneRing/
// Lingva take their URL from a secret, so the test rewrites that secret's origin to the listener; the
// default-URL scenarios (and DeepL/Yandex) point the module seam at the listener instead. Either way
// the peer sees the path and query the pinned code constructed, which is what is compared.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

type translateFixture struct {
	Inputs struct {
		TestUrls map[string]string `json:"testUrls"`
		Defaults map[string]string `json:"defaults"`
	} `json:"inputs"`
	Scenarios map[string]openRouterScenario `json:"scenarios"`
}

type translateRouteSeam struct {
	// secretKey is the secrets entry the route reads its URL from; empty when the route only has a
	// built-in default.
	secretKey string
	// env is the seam for the built-in default, and envPath is the path that default carries.
	env     string
	envPath string
	// extraEnv seams that must also point at the listener for this route.
	extraEnv []string
}

var translateRouteSeams = map[string]translateRouteSeam{
	"/api/translate/libre":   {secretKey: "libre_url"},
	"/api/translate/deeplx":  {secretKey: "deeplx_url", env: "GOTAVERN_DEEPLX_URL", envPath: "/translate"},
	"/api/translate/onering": {secretKey: "oneringtranslator_url", env: "GOTAVERN_ONERING_URL", envPath: "/translate"},
	"/api/translate/lingva":  {secretKey: "lingva_url", env: "GOTAVERN_LINGVA_URL", envPath: "/api/v1"},
	"/api/translate/deepl":   {env: "GOTAVERN_DEEPL_FREE_URL", envPath: "/v2/translate", extraEnv: []string{"GOTAVERN_DEEPL_PRO_URL"}},
	"/api/translate/yandex":  {env: "GOTAVERN_YANDEX_TRANSLATE_URL", envPath: "/api/v1/tr.json/translate"},
}

// yandexUCIDPattern is the one nondeterministic value in this domain: a fresh uuidv4 per request.
var yandexUCIDPattern = regexp.MustCompile(`ucid=[0-9a-f]{32}`)

func loadTranslateOracle(t *testing.T) translateFixture {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-translate.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture translateFixture
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	if len(fixture.Scenarios) == 0 {
		t.Fatal("the translate oracle records no scenarios")
	}
	return fixture
}

// TestTranslateSeamDefaults pins every built-in default to the recorded pinned value.
func TestTranslateSeamDefaults(t *testing.T) {
	fixture := loadTranslateOracle(t)
	for _, seam := range []struct {
		env      string
		accessor func() string
		recorded string
	}{
		{"GOTAVERN_DEEPL_FREE_URL", deeplFreeURL, fixture.Inputs.Defaults["deeplFree"]},
		{"GOTAVERN_DEEPL_PRO_URL", deeplProURL, fixture.Inputs.Defaults["deeplPro"]},
		{"GOTAVERN_YANDEX_TRANSLATE_URL", yandexTranslateURL, fixture.Inputs.Defaults["yandex"]},
		{"GOTAVERN_DEEPLX_URL", deeplxDefaultTranslateURL, fixture.Inputs.Defaults["deeplx"]},
		{"GOTAVERN_ONERING_URL", oneringDefaultTranslateURL, fixture.Inputs.Defaults["onering"]},
		{"GOTAVERN_LINGVA_URL", lingvaDefaultTranslateURL, fixture.Inputs.Defaults["lingva"]},
	} {
		t.Setenv(seam.env, "")
		if got := seam.accessor(); got != seam.recorded {
			t.Fatalf("%s seam default = %q, pinned %q", seam.env, got, seam.recorded)
		}
	}
}

// rewriteSecretOrigin keeps a configured URL's path and query but moves it onto the listener.
func rewriteSecretOrigin(value string, peerURL string) string {
	trimmed := value
	for _, scheme := range []string{"https://", "http://"} {
		if strings.HasPrefix(trimmed, scheme) {
			trimmed = trimmed[len(scheme):]
			break
		}
	}
	index := strings.IndexAny(trimmed, "/?#")
	if index < 0 {
		return peerURL
	}
	return peerURL + trimmed[index:]
}

func TestTranslateRoutesMatchPinnedOracle(t *testing.T) {
	fixture := loadTranslateOracle(t)
	if len(fixture.Scenarios) < 40 {
		t.Fatalf("the fixture records only %d scenarios; the domain pinning is incomplete", len(fixture.Scenarios))
	}
	sawEmptyBody := 0
	sawLingvaNonOk := 0
	sawJSONBody := 0
	sawFormBody := 0
	for label, scenario := range fixture.Scenarios {
		label, scenario := label, scenario
		t.Run(label, func(t *testing.T) {
			seam, known := translateRouteSeams[scenario.Route]
			if !known {
				t.Fatalf("%s: route %q is not implemented; the fixture must not record it", label, scenario.Route)
			}
			if len(scenario.Mocks) != 1 {
				t.Fatalf("%s: expected exactly one controlled peer rule, found %d", label, len(scenario.Mocks))
			}
			mock := scenario.Mocks[0]
			dataRoot := t.TempDir()
			userRoot := filepath.Join(dataRoot, "default-user")
			if err := os.MkdirAll(filepath.Join(userRoot, "backups"), 0o755); err != nil {
				t.Fatal(err)
			}
			secrets := map[string][]map[string]any{}
			for key, entries := range scenario.Secrets {
				secrets[key] = entries
			}
			var peer *openRouterPeer
			if mock.Throws {
				t.Setenv("GOTAVERN_DEEPLX_URL", hordeClosedPort)
				t.Setenv("GOTAVERN_ONERING_URL", hordeClosedPort)
				t.Setenv("GOTAVERN_LINGVA_URL", hordeClosedPort)
				t.Setenv("GOTAVERN_DEEPL_FREE_URL", hordeClosedPort)
				t.Setenv("GOTAVERN_DEEPL_PRO_URL", hordeClosedPort)
				t.Setenv("GOTAVERN_YANDEX_TRANSLATE_URL", hordeClosedPort)
				if seam.secretKey != "" {
					entries := secrets[seam.secretKey]
					if len(entries) == 0 {
						entries = []map[string]any{{"id": "sid", "value": "placeholder", "label": "l", "active": true}}
					}
					entries[0]["value"] = hordeClosedPort + seam.envPath
					secrets[seam.secretKey] = entries
				}
			} else {
				peer = newOpenRouterPeer(t, mock)
				if seam.env != "" {
					t.Setenv(seam.env, peer.server.URL+seam.envPath)
				}
				for _, extra := range seam.extraEnv {
					t.Setenv(extra, peer.server.URL+seam.envPath)
				}
				entries, hasSecretURL := secrets[seam.secretKey]
				if seam.secretKey != "" && hasSecretURL && len(entries) > 0 {
					if value, isString := entries[0]["value"].(string); isString {
						entries[0]["value"] = rewriteSecretOrigin(value, peer.server.URL)
						secrets[seam.secretKey] = entries
					}
				}
				if seam.secretKey != "" && seam.env != "" && (!hasSecretURL || len(entries) == 0) {
					// A default-URL scenario for a route that also accepts a secret: the secret is
					// absent, so the seam must carry the listener.
					t.Setenv(seam.env, peer.server.URL+seam.envPath)
				}
			}
			body, err := json.Marshal(secrets)
			if err != nil {
				t.Fatal(err)
			}
			if len(secrets) > 0 || scenario.Secrets != nil {
				if err := os.WriteFile(filepath.Join(userRoot, "secrets.json"), body, 0o644); err != nil {
					t.Fatal(err)
				}
			}
			handler := NewHTTPHandlerWithOptions(HTTPHandlerOptions{InstallRoot: dataRoot, DataRoot: dataRoot, DisableCSRF: true})
			response := postSecretsRoute(t, handler, scenario.Route, scenario.RequestBody)
			if response.Code != scenario.Response.Status {
				t.Fatalf("%s: status = %d, want %d (body %q)", label, response.Code, scenario.Response.Status, response.Body.String())
			}
			assertPinnedHeaders(t, response.Header(), scenario.Response.Headers)
			if got := response.Body.String(); got != scenario.Response.BodyText {
				t.Fatalf("%s: body = %q, pinned %q", label, got, scenario.Response.BodyText)
			}
			if scenario.Response.BodyText == "" && scenario.Response.Status == 200 {
				sawEmptyBody++
			}
			if scenario.Route == "/api/translate/lingva" && mock.Status >= 400 && scenario.Response.Status == 200 {
				sawLingvaNonOk++
			}
			if mock.Throws {
				if len(scenario.Outbound) == 0 {
					t.Fatalf("%s: the pinned oracle records no outbound request, so the 500 cannot be attributed", label)
				}
				return
			}
			if len(scenario.Outbound) == 0 {
				if len(peer.requests) != 0 {
					t.Fatalf("%s: Go reached the peer, but the pinned handler never did", label)
				}
				return
			}
			recorded := scenario.Outbound[len(scenario.Outbound)-1]
			if len(peer.requests) != 1 {
				t.Fatalf("%s: peer received %d requests, pinned recorded 1", label, len(peer.requests))
			}
			if peer.requests[0].Method != recorded.Method {
				t.Fatalf("%s: method = %s, pinned %s", label, peer.requests[0].Method, recorded.Method)
			}
			recordedPath := yandexUCIDPattern.ReplaceAllString(recorded.URL, "ucid=<uuid>")
			gotPath := yandexUCIDPattern.ReplaceAllString(peer.requests[0].Path, "ucid=<uuid>")
			if index := strings.Index(recordedPath, "://"); index >= 0 {
				recordedPath = recordedPath[index+3:]
				if slash := strings.IndexAny(recordedPath, "/?#"); slash >= 0 {
					recordedPath = recordedPath[slash:]
				} else {
					recordedPath = "/"
				}
			}
			if gotPath != recordedPath {
				t.Fatalf("%s: upstream target = %q, pinned %q", label, gotPath, recordedPath)
			}
			if recorded.Body != nil {
				wantBody := *recorded.Body
				if peer.requests[0].Body != wantBody {
					t.Fatalf("%s: outbound body = %q, pinned %q", label, peer.requests[0].Body, wantBody)
				}
				if strings.HasPrefix(wantBody, "{") {
					sawJSONBody++
				} else {
					sawFormBody++
				}
			}
			for name, value := range recorded.Headers {
				if got := peer.requests[0].Header.Get(name); got != value {
					t.Fatalf("%s: outbound header %q = %q, pinned %q", label, name, got, value)
				}
			}
		})
	}
	if sawEmptyBody == 0 {
		t.Fatal("no scenario exercises the send(undefined) empty-body branch")
	}
	if sawLingvaNonOk == 0 {
		t.Fatal("no scenario exercises Lingva's 'log a non-ok answer and parse it anyway' branch")
	}
	if sawJSONBody == 0 || sawFormBody == 0 {
		t.Fatalf("outbound bodies are not covered on both sides: json=%d form=%d", sawJSONBody, sawFormBody)
	}
}
