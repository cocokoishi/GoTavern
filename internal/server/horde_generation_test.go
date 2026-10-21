package server

// Route-level replay of tests/oracle/sillytavern-1.19.0-horde.json, recorded by tools/probe-horde.mjs
// against the real pinned server through a controlled peer.
//
// The peer here replays the fixture's own rule list, including its `times` counters, so a poll sequence
// produces the same number of upstream calls as the pinned recording. The poll INTERVAL is collapsed to
// a millisecond for the test; the production value is asserted separately, because a cadence cannot cross
// a fixture boundary but can still change observable behaviour.

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

type hordeMockRule struct {
	Run        string            `json:"run"`
	Match      string            `json:"match"`
	Status     int               `json:"status"`
	StatusText string            `json:"statusText"`
	Headers    map[string]string `json:"headers"`
	Body       string            `json:"body"`
	Throws     bool              `json:"throws"`
	Times      *int              `json:"times"`
}

type hordeOutbound struct {
	URL     string            `json:"url"`
	Method  string            `json:"method"`
	Headers map[string]string `json:"headers"`
	Body    *string           `json:"body"`
}

type hordeScenario struct {
	Route       string                      `json:"route"`
	RequestBody string                      `json:"requestBody"`
	Mocks       []hordeMockRule             `json:"mocks"`
	Secrets     map[string][]map[string]any `json:"secrets"`
	Response    struct {
		Status   int               `json:"status"`
		Headers  map[string]string `json:"headers"`
		Body     json.RawMessage   `json:"body"`
		BodyText string            `json:"bodyText"`
	} `json:"response"`
	Outbound []hordeOutbound `json:"outbound"`
}

type hordeFixture struct {
	Inputs struct {
		API          string `json:"api"`
		HordeKey     string `json:"hordeKey"`
		AnonymousKey string `json:"anonymousKey"`
	} `json:"inputs"`
	Scenarios map[string]hordeScenario `json:"scenarios"`
}

func loadHordeOracle(t *testing.T) hordeFixture {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-horde.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture hordeFixture
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	if len(fixture.Scenarios) == 0 {
		t.Fatal("the horde oracle records no scenarios")
	}
	return fixture
}

// TestHordePollIntervalIsThreeSeconds pins the cadence the routes sleep between checks. It cannot be
// recorded in a fixture (wall-clock does not cross that boundary), so it is asserted here instead.
func TestHordePollIntervalIsThreeSeconds(t *testing.T) {
	if hordePollCheckInterval != 3000*time.Millisecond {
		t.Fatalf("poll interval = %s, pinned 3000ms", hordePollCheckInterval)
	}
}

// withFastHordePolling collapses the poll interval for a route test and restores it afterwards.
func withFastHordePolling(t *testing.T) {
	t.Helper()
	previous := hordePollCheckInterval
	hordePollCheckInterval = time.Millisecond
	t.Cleanup(func() { hordePollCheckInterval = previous })
}

// hordeMockPeer replays the fixture's rule list with the same first-match, `times`-counted semantics the
// probe's controlled peer used.
type hordeMockPeer struct {
	server *httptest.Server
	mu     sync.Mutex
	used   map[int]int
	seen   []struct {
		Method string
		Path   string
		Header http.Header
		Body   string
	}
}

func newHordeMockPeer(t *testing.T, rules []hordeMockRule) *hordeMockPeer {
	t.Helper()
	peer := &hordeMockPeer{used: map[int]int{}}
	peer.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := readAllString(r)
		peer.mu.Lock()
		peer.seen = append(peer.seen, struct {
			Method string
			Path   string
			Header http.Header
			Body   string
		}{Method: r.Method, Path: r.URL.RequestURI(), Header: r.Header.Clone(), Body: body})
		var chosen *hordeMockRule
		chosenIndex := -1
		for index := range rules {
			rule := &rules[index]
			// The fixture stores the ABSOLUTE pinned URL in `match` (that is what the probe's peer
			// needed). Here the request goes to the local listener, so only the path is compared.
			pattern := rule.Match
			if cut := strings.Index(pattern, "/api/v2"); cut >= 0 {
				pattern = pattern[cut:]
			}
			if !strings.Contains(r.URL.RequestURI(), pattern) {
				continue
			}
			if rule.Times != nil {
				if peer.used[index] >= *rule.Times {
					continue
				}
				peer.used[index]++
			}
			chosen = rule
			chosenIndex = index
			break
		}
		peer.mu.Unlock()
		if chosen == nil {
			w.WriteHeader(http.StatusInternalServerError)
			_, _ = w.Write([]byte(`{"message":"gotavern test: unstubbed outbound request"}`))
			return
		}
		_ = chosenIndex
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
		_, _ = w.Write([]byte(chosen.Body))
	}))
	t.Cleanup(peer.server.Close)
	return peer
}

func readAllString(r *http.Request) (string, error) {
	var buffer bytes.Buffer
	_, err := buffer.ReadFrom(r.Body)
	return buffer.String(), err
}

func TestHordeGenerationRoutesMatchPinnedOracle(t *testing.T) {
	fixture := loadHordeOracle(t)
	if len(fixture.Scenarios) < 25 {
		t.Fatalf("the fixture records only %d scenarios; the domain pinning is incomplete", len(fixture.Scenarios))
	}
	withFastHordePolling(t)
	t.Setenv("GOTAVERN_HORDE_API_URL", "")
	t.Setenv("GOTAVERN_HORDE_METADATA_URL", "")
	statuses := map[int]int{}
	sawRejectedFetch := 0
	sawPollSequence := 0
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
			rules := scenario.Mocks
			peer := newHordeMockPeer(t, rules)
			t.Setenv("GOTAVERN_HORDE_API_URL", peer.server.URL)
			handler := NewHTTPHandlerWithOptions(HTTPHandlerOptions{InstallRoot: dataRoot, DataRoot: dataRoot, DisableCSRF: true})
			response := postSecretsRoute(t, handler, scenario.Route, scenario.RequestBody)
			statuses[response.Code]++
			if response.Code != scenario.Response.Status {
				t.Fatalf("%s: status = %d, want %d (body %q)", label, response.Code, scenario.Response.Status, response.Body.String())
			}
			assertPinnedHeaders(t, response.Header(), scenario.Response.Headers)
			if got := response.Body.String(); got != scenario.Response.BodyText {
				t.Fatalf("%s: body = %q, pinned %q", label, got, scenario.Response.BodyText)
			}
			if len(scenario.Outbound) == 0 {
				if len(peer.seen) != 0 {
					t.Fatalf("%s: Go reached the peer, but the pinned handler never did", label)
				}
				return
			}
			if len(peer.seen) != len(scenario.Outbound) {
				t.Fatalf("%s: peer received %d requests, pinned recorded %d: %v", label, len(peer.seen), len(scenario.Outbound), seenSummary(peer.seen))
			}
			for index, recorded := range scenario.Outbound {
				seen := peer.seen[index]
				if seen.Method != recorded.Method {
					t.Fatalf("%s: request %d method = %s, pinned %s", label, index, seen.Method, recorded.Method)
				}
				if want := requestURIPath(t, recorded.URL); seen.Path != want {
					t.Fatalf("%s: request %d target = %q, pinned %q", label, index, seen.Path, want)
				}
				for name, value := range recorded.Headers {
					if got := seen.Header.Get(name); got != value {
						t.Fatalf("%s: request %d header %q = %q, pinned %q", label, index, name, got, value)
					}
				}
				// A header the pinned call did NOT send must not appear either: iterating the recorded map
				// alone would let an implementation add an `apikey` the pinned SDK omits. Only the contract
				// headers are checked, because the transport adds its own (Host, Content-Length).
				for _, name := range []string{"client-agent", "content-type", "apikey", "x-fields"} {
					present := len(seen.Header[http.CanonicalHeaderKey(name)]) > 0
					recordedPresent := recorded.Headers[name] != ""
					if present && !recordedPresent {
						t.Fatalf("%s: request %d sent header %q which the pinned call does not send", label, index, name)
					}
					if !present && recordedPresent {
						t.Fatalf("%s: request %d is missing header %q", label, index, name)
					}
				}
				wantBody := ""
				if recorded.Body != nil {
					wantBody = *recorded.Body
				}
				if seen.Body != wantBody {
					t.Fatalf("%s: request %d body = %q, pinned %q", label, index, seen.Body, wantBody)
				}
			}
			if len(scenario.Outbound) > 1 && strings.Contains(scenario.Route, "caption-image") || strings.Contains(scenario.Route, "generate-image") {
				sawPollSequence++
			}
			for _, rule := range rules {
				if rule.Throws {
					sawRejectedFetch++
				}
			}
		})
	}
	if sawRejectedFetch == 0 {
		t.Fatal("no scenario exercises a rejected fetch")
	}
	if sawPollSequence == 0 {
		t.Fatal("no scenario exercises the polling loop")
	}
	for _, status := range []int{200, 400, 500, 503} {
		if statuses[status] == 0 {
			t.Fatalf("no scenario answers %d; that branch is unproven", status)
		}
	}
}

func seenSummary(seen []struct {
	Method string
	Path   string
	Header http.Header
	Body   string
}) []string {
	summary := make([]string, 0, len(seen))
	for _, entry := range seen {
		summary = append(summary, entry.Method+" "+entry.Path)
	}
	return summary
}

// TestHordeImageCancelOnDisconnect exercises the ONE Horde behaviour that could not be differentially
// verified: cancelling the provider request when the browser goes away. It asserts the implementation,
// not parity, and it is named that way in the compat row.
func TestHordeImageCancelOnDisconnect(t *testing.T) {
	withFastHordePolling(t)
	peer := newHordeMockPeer(t, []hordeMockRule{
		{Run: "cancel", Match: "/generate/async", Body: `{"id":"gen-cancel"}`},
		{Run: "cancel", Match: "/generate/check/", Body: `{"done":false}`},
		{Run: "cancel", Match: "/generate/status/", Body: `{}`},
	})
	t.Setenv("GOTAVERN_HORDE_API_URL", peer.server.URL)
	hordePollCheckInterval = time.Second
	dataRoot := t.TempDir()
	handler := NewHTTPHandlerWithOptions(HTTPHandlerOptions{InstallRoot: dataRoot, DataRoot: dataRoot, DisableCSRF: true})
	ctx, cancel := context.WithCancel(context.Background())
	request := httptest.NewRequest(http.MethodPost, "/api/horde/generate-image", strings.NewReader(`{"prompt":"a tree"}`)).WithContext(ctx)
	request.Header.Set("Content-Type", "application/json")
	done := make(chan struct{})
	go func() {
		handler.ServeHTTP(httptest.NewRecorder(), request)
		close(done)
	}()
	// Let the submission land, then disconnect.
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		peer.mu.Lock()
		submitted := len(peer.seen) > 0
		peer.mu.Unlock()
		if submitted {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	cancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("the handler did not return after the client went away")
	}
	peer.mu.Lock()
	defer peer.mu.Unlock()
	found := false
	for _, entry := range peer.seen {
		if entry.Method == http.MethodDelete && strings.Contains(entry.Path, "/generate/status/gen-cancel") {
			found = true
		}
	}
	if !found {
		t.Fatal("a cancelled request must send DELETE /generate/status/{id}; the implementation did not")
	}
}
