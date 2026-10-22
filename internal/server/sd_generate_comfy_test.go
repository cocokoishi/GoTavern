package server

// Replay of tests/oracle/sillytavern-1.19.0-sd-comfy-generate.json, recorded by
// tools/probe-sd-comfy-generate.mjs against the real pinned server.
//
// Every scenario is INDEPENDENT by construction: each runs against its own data root, its own
// controlled peer and its own secrets file, so the fixture is a keyed map rather than an ordered
// array of steps and the iteration order cannot change an observation (AGENTS rule 16 applies to
// steps that SHARE state; these share none — the replay proves that by giving every scenario a fresh
// data root and a fresh peer). The labels are nevertheless iterated in sorted order so a failing run
// is reproducible.
//
// What is compared, per scenario:
//   - the route the fixture records (a replay must not infer which handler a scenario drives);
//   - status, every response header, and the exact response body BYTES, except the two scenarios the
//     fixture classifies `shape` (a V8 engine message), where only the status and the request count
//     are compared and the body must be non-empty;
//   - the outbound COUNT, method, escaped target, declared header set (in BOTH directions) and body.
//
// One assertion here is SOURCE-DERIVED rather than recorded and says so at its call site: the
// `text/plain;charset=UTF-8` content type node-fetch adds to a string body the route declares no type
// for. The pinned hook records what the route PASSES, so it can never see that default.

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"
)

type sdComfyResponse struct {
	Status   int               `json:"status"`
	Headers  map[string]string `json:"headers"`
	Body     json.RawMessage   `json:"body"`
	BodyText string            `json:"bodyText"`
}

type sdComfyRecordedRequest struct {
	URL     string            `json:"url"`
	Method  string            `json:"method"`
	Headers map[string]string `json:"headers"`
	Body    *string           `json:"body"`
}

type sdComfyShape struct {
	Fields []string `json:"fields"`
	Reason string   `json:"reason"`
}

type sdComfyScenario struct {
	Route         string                      `json:"route"`
	RequestBody   string                      `json:"requestBody"`
	Mocks         []sdGenerateRule            `json:"mocks"`
	Secrets       map[string][]map[string]any `json:"secrets"`
	Response      sdComfyResponse             `json:"response"`
	ResponseShape *sdComfyShape               `json:"responseShape"`
	Outbound      []sdComfyRecordedRequest    `json:"outbound"`
}

type sdComfyFixture struct {
	Baseline struct {
		Version string `json:"version"`
		Commit  string `json:"commit"`
	} `json:"baseline"`
	ImplementedRoutes []string                   `json:"implementedRoutes"`
	Scenarios         map[string]sdComfyScenario `json:"scenarios"`
}

func loadSDComfyOracle(t *testing.T) sdComfyFixture {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-sd-comfy-generate.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture sdComfyFixture
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	if fixture.Baseline.Version != "1.19.0" || fixture.Baseline.Commit != "06bde939fb1e9c4c8d8641d810f0a916b5bce127" {
		t.Fatalf("comfy oracle baseline = %+v", fixture.Baseline)
	}
	if len(fixture.Scenarios) == 0 {
		t.Fatal("the comfy oracle records no scenarios")
	}
	return fixture
}

func TestSDComfyGenerateRoutesMatchPinnedOracle(t *testing.T) {
	fixture := loadSDComfyOracle(t)
	if len(fixture.Scenarios) < 25 {
		t.Fatalf("the comfy fixture records only %d scenarios", len(fixture.Scenarios))
	}
	sorted := make([]string, 0, len(fixture.Scenarios))
	for label := range fixture.Scenarios {
		sorted = append(sorted, label)
	}
	sort.Strings(sorted)

	statuses := map[int]int{}
	shaped := 0
	routes := map[string]int{}
	for _, label := range sorted {
		label, scenario := label, fixture.Scenarios[label]
		t.Run(label, func(t *testing.T) {
			if scenario.Route == "" {
				t.Fatalf("%s: the fixture records no route; a replay must not infer which handler ran", label)
			}
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
			// The peer implements the same substring+times rule selection the probe stub does, so a
			// timed poll rule stops answering after its recorded count (AGENTS rule 20).
			peer := newSDGeneratePeer(t, sdGenerateScenario{Mocks: scenario.Mocks})
			handler := NewHTTPHandlerWithOptions(HTTPHandlerOptions{InstallRoot: dataRoot, DataRoot: dataRoot, DisableCSRF: true})
			requestBody := strings.ReplaceAll(scenario.RequestBody, "<mock>", peer.server.URL)
			response := postSecretsRoute(t, handler, scenario.Route, requestBody)

			statuses[response.Code]++
			routes[scenario.Route]++
			if response.Code != scenario.Response.Status {
				t.Fatalf("%s: status = %d, pinned %d (body %q; peer saw %v)",
					label, response.Code, scenario.Response.Status, response.Body.String(), peerSummary(peer.seen))
			}
			if scenario.ResponseShape != nil {
				// The pinned body is a V8 engine message whose text is engine-version specific, so the
				// fixture nulls it AND its derived fields (AGENTS rule 18). Compare the headers with the
				// nulled ones removed on both sides, then the status, then the request count.
				header := response.Header().Clone()
				delete(header, "Content-Length")
				delete(header, "Etag")
				assertPinnedHeaders(t, header, scenario.Response.Headers)
				shaped++
				if response.Body.Len() == 0 {
					t.Fatalf("%s: the shape-classified branch answered an EMPTY body; the pinned catch always sends error.message (%s)",
						label, scenario.ResponseShape.Reason)
				}
			} else {
				assertPinnedHeaders(t, response.Header(), scenario.Response.Headers)
				if got := response.Body.String(); got != scenario.Response.BodyText {
					t.Fatalf("%s: body = %q, pinned %q", label, got, scenario.Response.BodyText)
				}
			}

			if len(peer.seen) != len(scenario.Outbound) {
				t.Fatalf("%s: peer received %d requests, pinned %d (%v; recorded %v)",
					label, len(peer.seen), len(scenario.Outbound), peerSummary(peer.seen), sdComfyRecordedSummary(scenario.Outbound))
			}
			for index, recorded := range scenario.Outbound {
				seen := peer.seen[index]
				if seen.Method != recorded.Method {
					t.Fatalf("%s: request %d method = %s, pinned %s", label, index, seen.Method, recorded.Method)
				}
				// The fixture stores the body-supplied origin as `<mock>`, so the comparison is the
				// ESCAPED target the handler requested on this test's own listener.
				want := strings.TrimPrefix(recorded.URL, "<mock>")
				if seen.Path != want {
					t.Fatalf("%s: request %d target = %q, pinned %q", label, index, seen.Path, want)
				}
				for name, value := range recorded.Headers {
					if got := seen.Header.Get(name); got != value {
						t.Fatalf("%s: request %d header %q = %q, pinned %q", label, index, name, got, value)
					}
				}
				// A header the pinned call does NOT declare must not appear either. The one exception
				// is content-type on a STRING body: node-fetch adds text/plain;charset=UTF-8 for it
				// (node_modules/node-fetch/src/body.js:310 with request.js:90-93), which the pinned hook
				// cannot observe because it records only what the route passes.
				for _, name := range []string{"authorization", "content-type", "x-api-key", "accept"} {
					present := seen.Header.Get(name) != ""
					if !present || recorded.Headers[name] != "" {
						continue
					}
					if name == "content-type" && recorded.Body != nil {
						if got := seen.Header.Get("content-type"); got != sdComfyTextBodyType {
							t.Fatalf("%s: request %d content-type = %q; a node-fetch string body is %q",
								label, index, got, sdComfyTextBodyType)
						}
						continue
					}
					t.Fatalf("%s: request %d sent header %q the pinned call does not send", label, index, name)
				}
				wantBody := ""
				if recorded.Body != nil {
					wantBody = *recorded.Body
				}
				if seen.Body != wantBody {
					t.Fatalf("%s: request %d body = %q, pinned %q", label, index, seen.Body, wantBody)
				}
			}
		})
	}
	// A fixture that stopped covering a branch would otherwise still pass for every scenario it kept.
	if statuses[200] == 0 || statuses[400] == 0 || statuses[500] == 0 {
		t.Fatalf("the fixture does not cover the 200/400/500 branches: %+v", statuses)
	}
	if shaped == 0 {
		t.Fatal("no scenario exercises a shape-classified engine-message branch")
	}
	for _, route := range fixture.ImplementedRoutes {
		if routes[route] == 0 {
			t.Fatalf("the fixture declares %q implemented but records no scenario for it", route)
		}
	}
	if routes["/api/sd/comfy/generate"] == 0 || routes["/api/sd/comfyrunpod/generate"] == 0 {
		t.Fatalf("both routes must be replayed: %+v", routes)
	}
}

func sdComfyRecordedSummary(recorded []sdComfyRecordedRequest) []string {
	summary := make([]string, 0, len(recorded))
	for _, entry := range recorded {
		summary = append(summary, entry.Method+" "+entry.URL)
	}
	return summary
}

// TestSDComfyGeneratePollIntervalsArePinned is a SOURCE-DERIVED test, not a pinned observation.
//
// The local route polls `{url}/history/<id>` and awaits `delay(100)` between attempts
// (src/endpoints/stable-diffusion.js:601); the runpod route polls `/status/<id>` and awaits
// `delay(500)` (:726). Neither duration can be recorded: the oracle records the poll COUNT as data,
// and a wall-clock duration or a 100ms bucket would be a host property rather than a route property
// (AGENTS rule 18). Asserting the constants keeps the interval from drifting silently while the
// counts stay green — a 1ms poll would satisfy every recorded scenario.
func TestSDComfyGeneratePollIntervalsArePinned(t *testing.T) {
	if sdComfyLocalPollDelay != 100*time.Millisecond {
		t.Fatalf("the local ComfyUI poll interval = %s; stable-diffusion.js:601 awaits delay(100)", sdComfyLocalPollDelay)
	}
	if sdComfyRunPodPollDelay != 500*time.Millisecond {
		t.Fatalf("the runpod ComfyUI poll interval = %s; stable-diffusion.js:726 awaits delay(500)", sdComfyRunPodPollDelay)
	}
	if sdComfyRequestTimeout != 120*time.Second {
		t.Fatalf("the outbound request timeout = %s; the SD family uses the shared 120s bound", sdComfyRequestTimeout)
	}
}

// sdComfyCancelPeer is a controlled peer for the cancellation leg. It HOLDS one request open so the
// caller can go away while a generation is genuinely in flight — a peer that answers everything
// immediately has no in-flight request to abandon, which is why the pinned leg is unrecordable.
type sdComfyCancelPeer struct {
	server     *httptest.Server
	answers    map[string]string
	holdPath   string
	holdBody   string
	cancelPath string
	arrivals   chan string
	release    chan struct{}
}

func newSDComfyCancelPeer(t *testing.T, answers map[string]string, holdPath, holdBody, cancelPath string) *sdComfyCancelPeer {
	t.Helper()
	peer := &sdComfyCancelPeer{
		answers:    answers,
		holdPath:   holdPath,
		holdBody:   holdBody,
		cancelPath: cancelPath,
		arrivals:   make(chan string, 32),
		release:    make(chan struct{}),
	}
	peer.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		peer.arrivals <- r.Method + " " + r.URL.Path
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.URL.Path == peer.cancelPath:
			_, _ = w.Write([]byte(`{}`))
		case r.URL.Path == peer.holdPath:
			<-peer.release
			_, _ = w.Write([]byte(peer.holdBody))
		default:
			body, exists := peer.answers[r.URL.Path]
			if !exists {
				body = `{}`
			}
			_, _ = w.Write([]byte(body))
		}
	}))
	t.Cleanup(peer.server.Close)
	return peer
}

func (peer *sdComfyCancelPeer) await(t *testing.T, want string) {
	t.Helper()
	deadline := time.After(10 * time.Second)
	for {
		select {
		case got := <-peer.arrivals:
			if got == want {
				return
			}
		case <-deadline:
			t.Fatalf("the peer never received %q; it saw %d request(s)", want, len(peer.arrivals))
		}
	}
}

// TestSDComfyGenerateCancelOnClientClose is a LABELLED IMPLEMENTATION TEST, not a pinned observation.
//
// The pinned handlers register a socket-close listener that POSTs `{url}/interrupt` (local) or
// `{url}/cancel/<jobId>` (runpod) when the caller goes away before the answer is written and before a
// history item was seen. The probe peer answers every rule immediately, so there is never an in-flight
// generation whose caller can disappear: the pinned scenario is NOT recordable (the same limit the
// A1111 interrupt leg recorded). This asserts the Go behaviour only, without claiming parity.
func TestSDComfyGenerateCancelOnClientClose(t *testing.T) {
	historyItem := `{"gotavern-inflight":{"outputs":{"9":{"images":[{"filename":"p.png","subfolder":"","type":"output"}]}},"status":{"status_str":"success"}}}`
	cases := []struct {
		name       string
		route      string
		body       string
		secrets    string
		answers    map[string]string
		holdPath   string
		holdMethod string
		holdBody   string
		cancelPath string
	}{
		{
			name:     "comfyInterruptOnClientClose",
			route:    "/api/sd/comfy/generate",
			body:     `{"url":"<peer>","auth":"user:pass","prompt":"{}"}`,
			answers:  map[string]string{"/history/gotavern-inflight": historyItem},
			holdPath: "/prompt", holdMethod: "POST", holdBody: `{"prompt_id":"gotavern-inflight"}`,
			cancelPath: "/interrupt",
		},
		{
			name:     "runpodCancelOnClientClose",
			route:    "/api/sd/comfyrunpod/generate",
			body:     `{"url":"<peer>","prompt":"{}"}`,
			secrets:  `{"api_key_comfy_runpod":[{"id":"sid","value":"synthetic-key","label":"key","active":true}]}`,
			answers:  map[string]string{"/run": `{"id":"gotavern-job-1"}`},
			holdPath: "/status/gotavern-job-1", holdMethod: "GET",
			holdBody:   `{"output":{"images":[{"filename":"p.png","data":"QUJD"}]}}`,
			cancelPath: "/cancel/gotavern-job-1",
		},
	}
	for _, testCase := range cases {
		testCase := testCase
		t.Run(testCase.name, func(t *testing.T) {
			peer := newSDComfyCancelPeer(t, testCase.answers, testCase.holdPath, testCase.holdBody, testCase.cancelPath)
			dataRoot := t.TempDir()
			userRoot := filepath.Join(dataRoot, "default-user")
			if err := os.MkdirAll(userRoot, 0o755); err != nil {
				t.Fatal(err)
			}
			if testCase.secrets != "" {
				if err := os.WriteFile(filepath.Join(userRoot, "secrets.json"), []byte(testCase.secrets), 0o644); err != nil {
					t.Fatal(err)
				}
			}
			handler := NewHTTPHandlerWithOptions(HTTPHandlerOptions{InstallRoot: dataRoot, DataRoot: dataRoot, DisableCSRF: true})
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			request := httptest.NewRequest(http.MethodPost, testCase.route,
				strings.NewReader(strings.ReplaceAll(testCase.body, "<peer>", peer.server.URL)))
			request.Header.Set("Content-Type", "application/json")
			request = request.WithContext(ctx)
			done := make(chan struct{})
			go func() {
				handler.ServeHTTP(httptest.NewRecorder(), request)
				close(done)
			}()
			// The caller goes away while the generation is genuinely in flight: the held request has
			// reached the peer and has NOT been answered.
			peer.await(t, testCase.holdMethod+" "+testCase.holdPath)
			cancel()
			peer.await(t, "POST "+testCase.cancelPath)
			close(peer.release)
			select {
			case <-done:
			case <-time.After(10 * time.Second):
				t.Fatal("the handler did not finish after the held request was released")
			}
		})
	}
}
