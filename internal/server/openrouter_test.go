package server

// Route-level replay of tests/oracle/sillytavern-1.19.0-openrouter.json, recorded by
// tools/probe-openrouter.mjs against the real pinned server.
//
// The fixture is data-driven on purpose: it carries, per scenario, the controlled peer response the
// pinned handler answered, the secrets state it ran with, the response it produced, and the outbound
// request it attempted. This test replays the SAME controlled peer through a real local listener, so
// the Go side exercises its real fetch path (docs/tokenizer-parity-plan.md §11) instead of a
// simulated absence of network. The failure path is produced by a CLOSED PORT.
//
// Two assertions keep this from becoming a shape-only test:
//
//  1. the response BODY BYTES are compared, so the projection/filter/sort and the JavaScript number
//     and undefined semantics are pinned, not merely the status;
//  2. the outbound URL is compared after the seam base is removed, so the constructed upstream path
//     and query are endpoint behaviour and are asserted, not assumed.

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

type openRouterScenario struct {
	Route       string `json:"route"`
	RequestBody string `json:"requestBody"`
	Mocks       []struct {
		Match      string            `json:"match"`
		Status     int               `json:"status"`
		StatusText string            `json:"statusText"`
		Headers    map[string]string `json:"headers"`
		Body       string            `json:"body"`
		Throws     bool              `json:"throws"`
	} `json:"mocks"`
	Secrets  map[string][]map[string]any `json:"secrets"`
	Response struct {
		Status   int               `json:"status"`
		Headers  map[string]string `json:"headers"`
		Body     json.RawMessage   `json:"body"`
		BodyText string            `json:"bodyText"`
	} `json:"response"`
	Outbound []struct {
		URL     string            `json:"url"`
		Method  string            `json:"method"`
		Headers map[string]string `json:"headers"`
		Body    *string           `json:"body"`
	} `json:"outbound"`
}

type openRouterFixture struct {
	Inputs struct {
		OpenRouterAPI string `json:"openRouterApi"`
	} `json:"inputs"`
	Scenarios map[string]openRouterScenario `json:"scenarios"`
}

func loadOpenRouterOracle(t *testing.T) openRouterFixture {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-openrouter.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture openRouterFixture
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	if len(fixture.Scenarios) == 0 {
		t.Fatal("the openrouter oracle records no scenarios")
	}
	return fixture
}

// TestOpenRouterSeamDefault pins the seam default to the pinned URL: the routes hardcode
// `https://openrouter.ai/api/v1`, and a drift there would change production while every test kept
// passing against the override.
func TestOpenRouterSeamDefault(t *testing.T) {
	fixture := loadOpenRouterOracle(t)
	t.Setenv("GOTAVERN_OPENROUTER_API_URL", "")
	if got := openRouterAPIURL(); got != fixture.Inputs.OpenRouterAPI {
		t.Fatalf("seam default = %q, pinned %q", got, fixture.Inputs.OpenRouterAPI)
	}
}

// openRouterPeer is a controlled peer that records what Go actually sent.
type openRouterPeer struct {
	server   *httptest.Server
	mu       sync.Mutex
	requests []struct {
		Method string
		Path   string
		Header http.Header
		Body   string
	}
}

func newOpenRouterPeer(t *testing.T, mock struct {
	Match      string            `json:"match"`
	Status     int               `json:"status"`
	StatusText string            `json:"statusText"`
	Headers    map[string]string `json:"headers"`
	Body       string            `json:"body"`
	Throws     bool              `json:"throws"`
}) *openRouterPeer {
	t.Helper()
	peer := &openRouterPeer{}
	peer.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		peer.mu.Lock()
		peer.requests = append(peer.requests, struct {
			Method string
			Path   string
			Header http.Header
			Body   string
		}{Method: r.Method, Path: r.URL.RequestURI(), Header: r.Header.Clone(), Body: string(body)})
		peer.mu.Unlock()
		for name, value := range mock.Headers {
			w.Header().Set(name, value)
		}
		status := mock.Status
		if status == 0 {
			status = 200
		}
		w.WriteHeader(status)
		_, _ = w.Write([]byte(mock.Body))
	}))
	t.Cleanup(peer.server.Close)
	return peer
}

func TestOpenRouterRoutesMatchPinnedOracle(t *testing.T) {
	fixture := loadOpenRouterOracle(t)
	if len(fixture.Scenarios) < 20 {
		t.Fatalf("the fixture records only %d scenarios; the domain pinning is incomplete", len(fixture.Scenarios))
	}
	sawClosedPort := 0
	for label, scenario := range fixture.Scenarios {
		label, scenario := label, scenario
		t.Run(label, func(t *testing.T) {
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
			if mock.Throws {
				// A rejected fetch is produced by a CLOSED PORT, which is deterministic and does not
				// depend on the CI machine's connectivity.
				t.Setenv("GOTAVERN_OPENROUTER_API_URL", hordeClosedPort)
				sawClosedPort++
			} else {
				peer := newOpenRouterPeer(t, mock)
				t.Setenv("GOTAVERN_OPENROUTER_API_URL", peer.server.URL)
			}
			handler := NewHTTPHandlerWithOptions(HTTPHandlerOptions{
				InstallRoot: dataRoot, DataRoot: dataRoot, DisableCSRF: true,
			})
			response := postSecretsRoute(t, handler, scenario.Route, scenario.RequestBody)
			if response.Code != scenario.Response.Status {
				t.Fatalf("%s: status = %d, want %d (body %q)", label, response.Code, scenario.Response.Status, response.Body.String())
			}
			assertPinnedHeaders(t, response.Header(), scenario.Response.Headers)
			if got := response.Body.String(); got != scenario.Response.BodyText {
				t.Fatalf("%s: body = %q, pinned %q", label, got, scenario.Response.BodyText)
			}
			if mock.Throws {
				// The recorded outbound request must still be the one the pinned code attempted, so a
				// Go side that answered 500 without trying to fetch would be a different behaviour.
				if len(scenario.Outbound) == 0 {
					t.Fatalf("%s: the pinned oracle records no outbound request, so a 500 cannot be attributed", label)
				}
				return
			}
		})
	}
	if sawClosedPort == 0 {
		t.Fatal("no scenario exercises a rejected fetch; the 500-on-connection-failure branch is unproven")
	}
}

// TestOpenRouterOutboundTargetIsPinned replays every scenario a second time against a recording peer
// and asserts the constructed URL path, the method and the declared headers.
func TestOpenRouterOutboundTargetIsPinned(t *testing.T) {
	fixture := loadOpenRouterOracle(t)
	base := fixture.Inputs.OpenRouterAPI
	checked := 0
	for label, scenario := range fixture.Scenarios {
		label, scenario := label, scenario
		if len(scenario.Outbound) == 0 {
			continue
		}
		t.Run(label, func(t *testing.T) {
			mock := scenario.Mocks[0]
			peer := newOpenRouterPeer(t, mock)
			t.Setenv("GOTAVERN_OPENROUTER_API_URL", peer.server.URL)
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
			handler := NewHTTPHandlerWithOptions(HTTPHandlerOptions{InstallRoot: dataRoot, DataRoot: dataRoot, DisableCSRF: true})
			postSecretsRoute(t, handler, scenario.Route, scenario.RequestBody)
			if len(peer.requests) != 1 {
				t.Fatalf("%s: peer received %d requests, pinned recorded 1", label, len(peer.requests))
			}
			recorded := scenario.Outbound[len(scenario.Outbound)-1]
			wantPath := strings.TrimPrefix(recorded.URL, base)
			if peer.requests[0].Method != recorded.Method {
				t.Fatalf("%s: method = %s, pinned %s", label, peer.requests[0].Method, recorded.Method)
			}
			if peer.requests[0].Path != wantPath {
				t.Fatalf("%s: upstream target = %q, pinned %q", label, peer.requests[0].Path, wantPath)
			}
			for name, value := range recorded.Headers {
				if got := peer.requests[0].Header.Get(name); got != value {
					t.Fatalf("%s: outbound header %q = %q, pinned %q", label, name, got, value)
				}
			}
			checked++
		})
	}
	if checked < 15 {
		t.Fatalf("only %d scenarios asserted an outbound target; the URL construction is barely covered", checked)
	}
}
