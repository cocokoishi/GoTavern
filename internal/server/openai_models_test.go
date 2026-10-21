package server

// Route-level replay of tests/oracle/sillytavern-1.19.0-openai-models.json, recorded by
// tools/probe-openai-models.mjs against the real pinned server.
//
// The fixture is data-driven: it carries, per scenario, the controlled peer answer the pinned handler
// answered, the secrets it ran with, the response it produced, and the outbound request it attempted.
// The Go side replays the same controlled peer through a REAL local listener, so the real fetch path
// is exercised, and the failure path is produced by a CLOSED PORT.
//
// What makes this evidence rather than a smoke test: the response BYTES are compared (so the
// unwrapping, member order and omitted-undefined behaviour are pinned) and the outbound REQUEST URI is
// compared after the seam base is removed (so the constructed upstream path, endpoint selection and
// encodeURIComponent behaviour are pinned).

import (
	"encoding/json"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type openAIModelsFixture struct {
	Upstream  map[string]string             `json:"upstream"`
	Scenarios map[string]openRouterScenario `json:"scenarios"`
}

func loadOpenAIModelsOracle(t *testing.T) openAIModelsFixture {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-openai-models.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture openAIModelsFixture
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	if len(fixture.Scenarios) == 0 {
		t.Fatal("the openai-models oracle records no scenarios")
	}
	return fixture
}

// openAIModelSeam maps a route to its seam environment variable and pinned default base, so the test
// asserts the default the implementation actually ships, not one re-derived here.
type openAIModelSeam struct {
	env        string
	defaultURL string
}

// siliconflowRoute selects the route whose upstream base depends on the request body, and the two
// markers are appended to the seam override so the CHOSEN base is observable at the peer.
const (
	siliconflowRoute        = "/api/openai/siliconflow/models/embedding"
	siliconflowCNMarker     = "/cn-base"
	siliconflowGlobalMarker = "/global-base"
)

var openAIModelSeams = map[string]openAIModelSeam{
	"/api/openai/electronhub/models":           {env: "GOTAVERN_ELECTRONHUB_API_URL", defaultURL: electronHubDefaultAPIURL},
	"/api/openai/chutes/models/embedding":      {env: "GOTAVERN_CHUTES_API_URL", defaultURL: chutesDefaultAPIURL},
	"/api/openai/nanogpt/models/embedding":     {env: "GOTAVERN_NANOGPT_API_URL", defaultURL: nanogptDefaultAPIURL},
	"/api/openai/siliconflow/models/embedding": {env: "GOTAVERN_SILICONFLOW_GLOBAL_API_URL", defaultURL: siliconflowDefaultGlobalURL},
	"/api/openai/workers-ai/models/embedding":  {env: "GOTAVERN_CLOUDFLARE_API_URL", defaultURL: cloudflareDefaultAPIURL},
}

// TestOpenAIModelSeamDefaults pins every seam default to the recorded pinned base.
func TestOpenAIModelSeamDefaults(t *testing.T) {
	fixture := loadOpenAIModelsOracle(t)
	legacyFailures := map[string]string{
		"electronhub": "https://api.electronhub.ai",
		"chutes":      "https://api.chutes.ai",
		"nanogpt":     "https://nano-gpt.com",
		"cloudflare":  "https://api.cloudflare.com",
	}
	if len(fixture.Upstream) == 0 {
		t.Fatal("the fixture records no upstream bases")
	}
	for name, want := range legacyFailures {
		if got := fixture.Upstream[name]; got != want {
			t.Fatalf("fixture upstream %q = %q, want %q", name, got, want)
		}
	}
	for _, seam := range openAIModelSeams {
		t.Setenv(seam.env, "")
	}
	for route, seam := range openAIModelSeams {
		t.Setenv(seam.env, "")
		var got string
		switch route {
		case "/api/openai/electronhub/models":
			got = electronHubAPIURL()
		case "/api/openai/chutes/models/embedding":
			got = chutesAPIURL()
		case "/api/openai/nanogpt/models/embedding":
			got = nanogptAPIURL()
		case "/api/openai/siliconflow/models/embedding":
			got = siliconflowGlobalURL()
		case "/api/openai/workers-ai/models/embedding":
			got = cloudflareAPIURL()
		default:
			t.Fatalf("no seam accessor for route %q", route)
		}
		if got != seam.defaultURL {
			t.Fatalf("%s: seam default = %q, want %q", route, got, seam.defaultURL)
		}
	}
	t.Setenv("GOTAVERN_SILICONFLOW_CN_API_URL", "")
	if got := siliconflowCNURL(); got != siliconflowDefaultCNURL {
		t.Fatalf("siliconflow CN seam default = %q, want %q", got, siliconflowDefaultCNURL)
	}
}

func TestOpenAIModelsMatchPinnedOracle(t *testing.T) {
	fixture := loadOpenAIModelsOracle(t)
	if len(fixture.Scenarios) < 25 {
		t.Fatalf("the fixture records only %d scenarios; the domain pinning is incomplete", len(fixture.Scenarios))
	}
	sawClosedPort := 0
	sawForwardedPeerText := 0
	sawInvalidShape500 := 0
	for label, scenario := range fixture.Scenarios {
		label, scenario := label, scenario
		t.Run(label, func(t *testing.T) {
			seam, known := openAIModelSeams[scenario.Route]
			if !known {
				t.Fatalf("%s: route %q has no seam", label, scenario.Route)
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
			if scenario.Secrets != nil {
				body, err := json.Marshal(scenario.Secrets)
				if err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(filepath.Join(userRoot, "secrets.json"), body, 0o644); err != nil {
					t.Fatal(err)
				}
			}
			var peer *openRouterPeer
			if mock.Throws {
				t.Setenv(seam.env, hordeClosedPort)
				sawClosedPort++
			} else {
				peer = newOpenRouterPeer(t, mock)
				if scenario.Route == siliconflowRoute {
					// The two SiliconFlow bases must be DISTINGUISHABLE, or an implementation that
					// always picks one of them would pass: the marker prefix is what makes the
					// endpoint-selection assertion discriminating.
					t.Setenv("GOTAVERN_SILICONFLOW_CN_API_URL", peer.server.URL+siliconflowCNMarker)
					t.Setenv("GOTAVERN_SILICONFLOW_GLOBAL_API_URL", peer.server.URL+siliconflowGlobalMarker)
				} else {
					t.Setenv(seam.env, peer.server.URL)
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
			// The recorded request URI is the endpoint behaviour; the base is the seam.
			recorded := scenario.Outbound[len(scenario.Outbound)-1]
			parsed, err := url.Parse(recorded.URL)
			if err != nil {
				t.Fatal(err)
			}
			if len(peer.requests) != 1 {
				t.Fatalf("%s: peer received %d requests, pinned recorded 1", label, len(peer.requests))
			}
			if peer.requests[0].Method != recorded.Method {
				t.Fatalf("%s: method = %s, pinned %s", label, peer.requests[0].Method, recorded.Method)
			}
			wantPath := parsed.RequestURI()
			if scenario.Route == siliconflowRoute {
				if strings.Contains(recorded.URL, "api.siliconflow.cn") {
					wantPath = siliconflowCNMarker + wantPath
				} else {
					wantPath = siliconflowGlobalMarker + wantPath
				}
			}
			if peer.requests[0].Path != wantPath {
				t.Fatalf("%s: upstream target = %q, pinned %q", label, peer.requests[0].Path, wantPath)
			}
			for name, value := range recorded.Headers {
				if got := peer.requests[0].Header.Get(name); got != value {
					t.Fatalf("%s: outbound header %q = %q, pinned %q", label, name, got, value)
				}
			}
			if scenario.Response.Status == http.StatusInternalServerError && mock.Status >= 400 {
				sawForwardedPeerText++
			}
			if scenario.Response.Status == http.StatusInternalServerError && mock.Status < 400 {
				sawInvalidShape500++
			}
		})
	}
	if sawClosedPort == 0 {
		t.Fatal("no scenario exercises a rejected fetch; the 500-on-connection-failure branch is unproven")
	}
	if sawForwardedPeerText == 0 {
		t.Fatal("no scenario exercises the forwarded peer text branch")
	}
	if sawInvalidShape500 == 0 {
		t.Fatal("no scenario exercises the invalid-shape 500 branch")
	}
}
