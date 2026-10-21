package server

// Route-level replay of tests/oracle/sillytavern-1.19.0-sd-generate.json, recorded by
// tools/probe-sd-generate.mjs against the real pinned server.
//
// The image payload is compared through the response projection (base64 bytes) and the peer's answer is
// the synthetic image the fixture recorded. The random seed is normalized on BOTH sides (the fixture
// masks it, the implementation generates it), and the header assertion is bidirectional for the contract
// headers so an implementation cannot add an Authorization the pinned call does not send.

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"testing"
)

type sdGenerateRule struct {
	Run        string            `json:"run"`
	Match      string            `json:"match"`
	Status     int               `json:"status"`
	StatusText string            `json:"statusText"`
	Headers    map[string]string `json:"headers"`
	Body       string            `json:"body"`
	BinaryBody bool              `json:"binaryBody"`
	Throws     bool              `json:"throws"`
}

type sdGenerateScenario struct {
	Route       string                      `json:"route"`
	RequestBody string                      `json:"requestBody"`
	Mocks       []sdGenerateRule            `json:"mocks"`
	Secrets     map[string][]map[string]any `json:"secrets"`
	Response    struct {
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

type sdGenerateFixture struct {
	ImplementedRoutes []string                      `json:"implementedRoutes"`
	Scenarios         map[string]sdGenerateScenario `json:"scenarios"`
}

func loadSDGenerateOracle(t *testing.T) sdGenerateFixture {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-sd-generate.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture sdGenerateFixture
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	if len(fixture.Scenarios) == 0 {
		t.Fatal("the sd-generate oracle records no scenarios")
	}
	return fixture
}

type sdSeenRequest struct {
	Method string
	Path   string
	Header http.Header
	Body   string
}

type sdGeneratePeer struct {
	server *httptest.Server
	mu     sync.Mutex
	seen   []sdSeenRequest
}

// newSDGeneratePeer replays the scenario's rule list. A provider response that carries a fetchable URL in
// `data[0].url` gets a SECOND rule pointed at this listener, because that request leaves the provider seam
// and must still land on the controlled peer (AGENTS.md rule 14).
func newSDGeneratePeer(t *testing.T, scenario sdGenerateScenario) *sdGeneratePeer {
	t.Helper()
	peer := &sdGeneratePeer{}
	var rules []sdGenerateRule
	peer.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := readAllString(r)
		peer.mu.Lock()
		peer.seen = append(peer.seen, sdSeenRequest{Method: r.Method, Path: r.URL.RequestURI(), Header: r.Header.Clone(), Body: body})
		peer.mu.Unlock()
		var chosen *sdGenerateRule
		for index := range rules {
			if strings.Contains(r.URL.RequestURI(), rules[index].Match) {
				chosen = &rules[index]
				break
			}
		}
		if chosen == nil {
			w.WriteHeader(http.StatusInternalServerError)
			_, _ = w.Write([]byte(`{"message":"gotavern test: unstubbed outbound request"}`))
			return
		}
		if chosen.Throws {
			// A rejected fetch is a transport error, which is what an aborted connection produces.
			panic(http.ErrAbortHandler)
		}
		for name, value := range chosen.Headers {
			w.Header().Set(name, value)
		}
		status := chosen.Status
		if status == 0 {
			status = 200
		}
		w.WriteHeader(status)
		if chosen.BinaryBody {
			if decoded, err := base64.StdEncoding.DecodeString(chosen.Body); err == nil {
				_, _ = w.Write(decoded)
				return
			}
		}
		_, _ = w.Write([]byte(chosen.Body))
	}))
	t.Cleanup(peer.server.Close)
	rules = append([]sdGenerateRule{}, scenario.Mocks...)
	// The listener address is known now, so repoint any provider-response URL at it and add its rule.
	fetchedBody := ""
	for index := range rules {
		var payload map[string]any
		if json.Unmarshal([]byte(rules[index].Body), &payload) != nil {
			continue
		}
		data, ok := payload["data"].([]any)
		if !ok || len(data) == 0 {
			continue
		}
		entry, ok := data[0].(map[string]any)
		if !ok {
			continue
		}
		if _, present := entry["url"]; !present {
			continue
		}
		entry["url"] = peer.server.URL + "/fetched-image.png"
		if encoded, err := json.Marshal(payload); err == nil {
			rules[index].Body = string(encoded)
		}
		// The bytes the pinned route received are the base64 in the recorded answer.
		var answer map[string]any
		if json.Unmarshal([]byte(scenario.Response.BodyText), &answer) == nil {
			if text, isString := answer["data"].(string); isString {
				fetchedBody = text
			}
		}
		break
	}
	if fetchedBody != "" {
		rules = append(rules, sdGenerateRule{
			Match:      "/fetched-image.png",
			Headers:    map[string]string{"content-type": "image/png"},
			Body:       fetchedBody,
			BinaryBody: true,
		})
	}
	return peer
}

// sdSeamPath trims the pinned provider base from a recorded URL, keeping path and query. A URL that came
// from a provider response (the together fallback) is not under a seam and its host is not reproducible,
// so the observation is that the second GET happened at the rewritten path.
func sdSeamPath(recorded string) string {
	for _, base := range []string{sdPollinationsDefaultURL, sdTogetherDefaultURL} {
		if strings.HasPrefix(recorded, base) {
			return strings.TrimPrefix(recorded, base)
		}
	}
	if strings.Contains(recorded, "://") {
		return "/fetched-image.png"
	}
	return recorded
}

var sdUrlSeedPattern = regexp.MustCompile(`seed=\d+`)
var sdJsonSeedPattern = regexp.MustCompile(`"seed":\d+`)

func normalizeSdSeed(value string) string {
	// The fixture masks a JSON seed as the STRING "<seed>" and a URL seed as the bare marker, so both
	// sides are normalized to exactly those forms.
	value = sdJsonSeedPattern.ReplaceAllString(value, `"seed":"<seed>"`)
	return sdUrlSeedPattern.ReplaceAllString(value, "seed=<seed>")
}

func peerSummary(seen []sdSeenRequest) []string {
	result := make([]string, 0, len(seen))
	for _, entry := range seen {
		result = append(result, entry.Method+" "+entry.Path)
	}
	return result
}

func TestSDGenerateRoutesMatchPinnedOracle(t *testing.T) {
	fixture := loadSDGenerateOracle(t)
	if len(fixture.Scenarios) < 10 {
		t.Fatalf("the fixture records only %d scenarios", len(fixture.Scenarios))
	}
	t.Setenv("GOTAVERN_SD_POLLINATIONS_URL", "")
	t.Setenv("GOTAVERN_SD_TOGETHER_URL", "")
	statuses := map[int]int{}
	sawFallbackFetch := 0
	for label, scenario := range fixture.Scenarios {
		label, scenario := label, scenario
		t.Run(label, func(t *testing.T) {
			dataRoot := t.TempDir()
			userRoot := filepath.Join(dataRoot, "default-user")
			if err := os.MkdirAll(filepath.Join(userRoot, "backups"), 0o755); err != nil {
				t.Fatal(err)
			}
			if scenario.Secrets != nil {
				payload, err := json.Marshal(scenario.Secrets)
				if err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(filepath.Join(userRoot, "secrets.json"), payload, 0o644); err != nil {
					t.Fatal(err)
				}
			}
			peer := newSDGeneratePeer(t, scenario)
			t.Setenv("GOTAVERN_SD_POLLINATIONS_URL", peer.server.URL)
			t.Setenv("GOTAVERN_SD_TOGETHER_URL", peer.server.URL)
			handler := NewHTTPHandlerWithOptions(HTTPHandlerOptions{InstallRoot: dataRoot, DataRoot: dataRoot, DisableCSRF: true})
			response := postSecretsRoute(t, handler, scenario.Route, scenario.RequestBody)
			statuses[response.Code]++
			if response.Code != scenario.Response.Status {
				t.Fatalf("%s: status = %d, want %d (body %q; peer saw %v)", label, response.Code, scenario.Response.Status, response.Body.String(), peerSummary(peer.seen))
			}
			assertPinnedHeaders(t, response.Header(), scenario.Response.Headers)
			if got := normalizeSdSeed(response.Body.String()); got != normalizeSdSeed(scenario.Response.BodyText) {
				t.Fatalf("%s: body = %q, pinned %q", label, got, scenario.Response.BodyText)
			}
			if len(scenario.Outbound) == 0 {
				if len(peer.seen) != 0 {
					t.Fatalf("%s: Go reached the peer, the pinned handler did not", label)
				}
				return
			}
			if len(peer.seen) != len(scenario.Outbound) {
				t.Fatalf("%s: peer received %d requests, pinned %d", label, len(peer.seen), len(scenario.Outbound))
			}
			for index, recorded := range scenario.Outbound {
				seen := peer.seen[index]
				if seen.Method != recorded.Method {
					t.Fatalf("%s: request %d method = %s, pinned %s", label, index, seen.Method, recorded.Method)
				}
				if want := normalizeSdSeed(sdSeamPath(recorded.URL)); normalizeSdSeed(seen.Path) != want {
					t.Fatalf("%s: request %d target = %q, pinned %q", label, index, seen.Path, want)
				}
				for name, value := range recorded.Headers {
					if got := seen.Header.Get(name); got != value {
						t.Fatalf("%s: request %d header %q = %q, pinned %q", label, index, name, got, value)
					}
				}
				// A header the pinned call does NOT send must not appear either.
				for _, name := range []string{"authorization", "content-type"} {
					present := len(seen.Header[http.CanonicalHeaderKey(name)]) > 0
					recordedPresent := recorded.Headers[name] != ""
					if present && !recordedPresent {
						t.Fatalf("%s: request %d sent header %q the pinned call does not send", label, index, name)
					}
				}
				wantBody := ""
				if recorded.Body != nil {
					wantBody = normalizeSdSeed(*recorded.Body)
				}
				if got := normalizeSdSeed(seen.Body); got != wantBody {
					t.Fatalf("%s: request %d body = %q, pinned %q", label, index, got, wantBody)
				}
				if index == 1 {
					sawFallbackFetch++
				}
			}
		})
	}
	if statuses[200] == 0 || statuses[400] == 0 || statuses[500] == 0 {
		t.Fatalf("the fixture does not cover the 200/400/500 branches: %+v", statuses)
	}
	if sawFallbackFetch == 0 {
		t.Fatal("no scenario exercises the URL fallback fetch")
	}
}
