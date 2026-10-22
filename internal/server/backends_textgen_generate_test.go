package server

// Replay of tests/oracle/sillytavern-1.19.0-textgen.json, recorded by tools/probe-textgen.mjs against
// the real pinned server.
//
// Every scenario drives the SAME route with a different api_type, so the fixture is a keyed map of
// INDEPENDENT scenarios: each gets its own data root, its own peer and its own secrets file, so the
// iteration order cannot change an observation (AGENTS rule 16 applies to steps that share state;
// these share none). Labels are iterated in sorted order so a failing run is reproducible.
//
// Compared per scenario: status, every response header, the exact response bytes (except the two
// `shape` scenarios, where the pinned body is V8 engine text and only the status, the request count
// and a non-empty body are compared), and the outbound COUNT, method, escaped target, declared
// headers in BOTH directions and exact body.
//
// Two behaviours CANNOT be recorded and are LABELLED implementation tests below, not parity claims:
// non-buffering (the oracle peer answers one buffered chunk) and the koboldcpp abort leg (the peer
// answers immediately, so there is never an in-flight request to abandon).

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"
)

type textgenResponse struct {
	Status   int               `json:"status"`
	Headers  map[string]string `json:"headers"`
	BodyText string            `json:"bodyText"`
}

type textgenRecordedRequest struct {
	URL     string            `json:"url"`
	Method  string            `json:"method"`
	Headers map[string]string `json:"headers"`
	Body    *string           `json:"body"`
}

type textgenScenario struct {
	Route         string                   `json:"route"`
	BodyText      string                   `json:"bodyText"`
	Mocks         []sdGenerateRule         `json:"mocks"`
	Response      textgenResponse          `json:"response"`
	ResponseShape string                   `json:"responseShape"`
	Outbound      []textgenRecordedRequest `json:"outbound"`
}

type textgenFixture struct {
	Baseline struct {
		Version string `json:"version"`
		Commit  string `json:"commit"`
	} `json:"baseline"`
	Route     string                     `json:"route"`
	Scenarios map[string]textgenScenario `json:"scenarios"`
	Inputs    struct {
		Secrets map[string]string `json:"secrets"`
	} `json:"inputs"`
}

func loadTextgenOracle(t *testing.T) textgenFixture {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-textgen.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture textgenFixture
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	if fixture.Baseline.Version != "1.19.0" || fixture.Baseline.Commit != "06bde939fb1e9c4c8d8641d810f0a916b5bce127" {
		t.Fatalf("textgen oracle baseline = %+v", fixture.Baseline)
	}
	if len(fixture.Scenarios) == 0 || fixture.Route == "" {
		t.Fatal("the textgen oracle records no scenarios or no route")
	}
	return fixture
}

func textgenTestHandler(t *testing.T, secrets map[string]string) http.Handler {
	t.Helper()
	dataRoot := t.TempDir()
	userRoot := filepath.Join(dataRoot, "default-user")
	if err := os.MkdirAll(filepath.Join(userRoot, "backups"), 0o755); err != nil {
		t.Fatal(err)
	}
	if len(secrets) > 0 {
		encoded := map[string][]map[string]any{}
		for key, value := range secrets {
			encoded[key] = []map[string]any{{"id": "sid-" + key, "value": value, "label": key, "active": true}}
		}
		payload, err := json.Marshal(encoded)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(userRoot, "secrets.json"), payload, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return NewHTTPHandlerWithOptions(HTTPHandlerOptions{InstallRoot: dataRoot, DataRoot: dataRoot, DisableCSRF: true})
}

// textgenPeerPort is the port the replay peer listens on: the localhost-rewrite scenario records
// `127.0.0.1:<port>` and its request body carries `http://localhost:<port>`, so both sides get THIS
// listener's port substituted at replay time (the fixture holds no host and no port).
func textgenPeerPort(t *testing.T, origin string) string {
	t.Helper()
	parsed, ok := sdParseAbsoluteURL(origin)
	if !ok {
		t.Fatalf("peer origin %q is not parseable", origin)
	}
	return parsed.Port()
}

// textgenTarget is the request TARGET (escaped path + query) the recorded URL names. The fixture
// stores the body-supplied origin as `<mock>` and the localhost-rewrite port as `<port>`, and one
// scenario records an ABSOLUTE `127.0.0.1:<port>` origin because the pinned route rewrote it, so both
// forms are resolved against this test's own listener before the path is compared.
func textgenTarget(recorded, peerOrigin, port string) string {
	value := strings.ReplaceAll(recorded, "<port>", port)
	value = strings.ReplaceAll(value, "<mock>", peerOrigin)
	parsed, ok := sdParseAbsoluteURL(value)
	if !ok {
		return strings.TrimPrefix(recorded, "<mock>")
	}
	target := parsed.EscapedPath()
	if target == "" {
		target = "/"
	}
	if parsed.RawQuery != "" {
		target += "?" + parsed.RawQuery
	}
	return target
}

func TestBackendsTextgenGenerateMatchesPinnedOracle(t *testing.T) {
	fixture := loadTextgenOracle(t)
	if len(fixture.Scenarios) < 20 {
		t.Fatalf("the textgen fixture records only %d scenarios", len(fixture.Scenarios))
	}
	labels := make([]string, 0, len(fixture.Scenarios))
	for label := range fixture.Scenarios {
		labels = append(labels, label)
	}
	sort.Strings(labels)

	statuses := map[int]int{}
	shaped := 0
	for _, label := range labels {
		label, scenario := label, fixture.Scenarios[label]
		t.Run(label, func(t *testing.T) {
			peer := newSDGeneratePeer(t, sdGenerateScenario{Mocks: scenario.Mocks})
			port := textgenPeerPort(t, peer.server.URL)
			requestBody := strings.ReplaceAll(scenario.BodyText, "<mock>", peer.server.URL)
			requestBody = strings.ReplaceAll(requestBody, "<port>", port)
			handler := textgenTestHandler(t, fixture.Inputs.Secrets)
			response := postSecretsRoute(t, handler, scenario.Route, requestBody)

			statuses[response.Code]++
			if response.Code != scenario.Response.Status {
				t.Fatalf("%s: status = %d, pinned %d (body %q; peer saw %v)",
					label, response.Code, scenario.Response.Status, response.Body.String(), peerSummary(peer.seen))
			}
			if scenario.ResponseShape != "" {
				// The pinned body is V8 engine text (a property-read or JSON.parse message), so the
				// fixture nulls it and its derived fields (AGENTS rule 18). Compare the remaining
				// headers, then require a non-empty body: the pinned catch always sends the envelope.
				header := response.Header().Clone()
				delete(header, "Content-Length")
				delete(header, "Etag")
				assertPinnedHeaders(t, header, scenario.Response.Headers)
				shaped++
				if response.Body.Len() == 0 {
					t.Fatalf("%s: the shape-classified branch answered an EMPTY body (%s)", label, scenario.ResponseShape)
				}
			} else {
				assertPinnedHeaders(t, response.Header(), scenario.Response.Headers)
				if got := response.Body.String(); got != scenario.Response.BodyText {
					t.Fatalf("%s: body = %q, pinned %q", label, got, scenario.Response.BodyText)
				}
			}

			if len(peer.seen) != len(scenario.Outbound) {
				t.Fatalf("%s: peer received %d requests, pinned %d (%v)", label, len(peer.seen), len(scenario.Outbound), peerSummary(peer.seen))
			}
			for index, recorded := range scenario.Outbound {
				seen := peer.seen[index]
				if seen.Method != recorded.Method {
					t.Fatalf("%s: request %d method = %s, pinned %s", label, index, seen.Method, recorded.Method)
				}
				want := textgenTarget(recorded.URL, peer.server.URL, port)
				if seen.Path != want {
					t.Fatalf("%s: request %d target = %q, pinned %q", label, index, seen.Path, want)
				}
				for name, value := range recorded.Headers {
					if got := seen.Header.Get(name); got != value {
						t.Fatalf("%s: request %d header %q = %q, pinned %q", label, index, name, got, value)
					}
				}
				for _, name := range []string{"authorization", "content-type", "x-api-key", "http-referer", "x-title"} {
					present := seen.Header.Get(name) != ""
					if present && recorded.Headers[name] == "" {
						t.Fatalf("%s: request %d sent header %q the pinned call does not send", label, index, name)
					}
				}
				// The fixture stores the peer origin as `<mock>` and the localhost-rewrite port as
				// `<port>`; a type that forwards the WHOLE body (unknown, dreamgen) carries the origin
				// inside its body, so the substitution must be applied on the expected side too.
				wantBody := ""
				if recorded.Body != nil {
					wantBody = strings.ReplaceAll(*recorded.Body, "<mock>", peer.server.URL)
					wantBody = strings.ReplaceAll(wantBody, "<port>", port)
				}
				if seen.Body != wantBody {
					t.Fatalf("%s: request %d body = %q, pinned %q", label, index, seen.Body, wantBody)
				}
			}
		})
	}
	if statuses[200] == 0 {
		t.Fatalf("the fixture does not cover a 200 branch: %+v", statuses)
	}
	if shaped == 0 {
		t.Fatal("no scenario exercises a shape-classified engine-message branch")
	}
}

// TestBackendsTextgenGenerateStreamsWithoutBuffering is a LABELLED IMPLEMENTATION TEST.
//
// The pinned route pipes the provider body (`from.body.pipe(to)` in src/util.js forwardFetchResponse),
// which is SOURCE-DERIVED: no recorded scenario can show it, because the oracle peer answers one
// buffered chunk and a buffered reply is byte-identical however it was produced. This test uses a REAL
// listener for the Go side and a provider that writes one chunk and then BLOCKS, so a handler that
// buffers the whole reply cannot answer before the release and one that pipes must.
func TestBackendsTextgenGenerateStreamsWithoutBuffering(t *testing.T) {
	release := make(chan struct{})
	var released bool
	defer func() {
		if !released {
			close(release)
		}
	}()
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("data: first\n\n"))
		w.(http.Flusher).Flush()
		<-release
		_, _ = w.Write([]byte("data: second\n\n"))
		w.(http.Flusher).Flush()
	}))
	defer provider.Close()

	handler := textgenTestHandler(t, nil)
	server := httptest.NewServer(handler)
	defer server.Close()

	body := fmt.Sprintf(`{"api_server":%q,"api_type":"ooba","model":"m","prompt":"p","stream":true}`, provider.URL)
	response, err := http.Post(server.URL+"/api/backends/text-completions/generate", "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", response.StatusCode)
	}
	reader := bufio.NewReader(response.Body)
	firstLine := make(chan string, 1)
	go func() {
		line, _ := reader.ReadString('\n')
		firstLine <- line
	}()
	select {
	case line := <-firstLine:
		if !strings.Contains(line, "data: first") {
			t.Fatalf("the first streamed line was %q, want the provider's first chunk", line)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the route BUFFERED the provider reply: nothing reached the caller while the provider was held open")
	}
	close(release)
	released = true
	rest, readErr := readAllStringFrom(reader)
	if readErr != nil {
		t.Fatalf("reading the rest of the stream: %v", readErr)
	}
	if !strings.Contains(rest, "data: second") {
		t.Fatalf("the tail of the stream was %q, want the provider's second chunk", rest)
	}
}

func readAllStringFrom(reader *bufio.Reader) (string, error) {
	var builder strings.Builder
	buffer := make([]byte, 1024)
	for {
		count, err := reader.Read(buffer)
		if count > 0 {
			builder.Write(buffer[:count])
		}
		if err != nil {
			return builder.String(), nil
		}
	}
}

// TestBackendsTextgenGenerateAbortsKoboldCpp is a LABELLED IMPLEMENTATION TEST.
//
// The pinned handler registers a socket-close listener that, for api_type koboldcpp only, POSTs
// `{trimV1(api_server)}/api/extra/abort` with the additional headers before aborting the fetch. The
// oracle peer answers every rule immediately, so there is never an in-flight request whose caller can
// disappear and the pinned leg is NOT recordable: only the Go behaviour is asserted here.
func TestBackendsTextgenGenerateAbortsKoboldCpp(t *testing.T) {
	for _, apiType := range []string{"koboldcpp", "ooba"} {
		apiType := apiType
		t.Run(apiType, func(t *testing.T) {
			arrivals := make(chan string, 8)
			release := make(chan struct{})
			provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				select {
				case arrivals <- r.Method + " " + r.URL.Path:
				default:
				}
				w.Header().Set("Content-Type", "application/json")
				if r.URL.Path == "/api/extra/abort" {
					_, _ = w.Write([]byte(`{}`))
					return
				}
				<-release
				_, _ = w.Write([]byte(`{"choices":[{"text":"late"}]}`))
			}))
			defer provider.Close()
			var released bool
			defer func() {
				if !released {
					close(release)
				}
			}()

			handler := textgenTestHandler(t, nil)
			request := httptest.NewRequest(http.MethodPost, "/api/backends/text-completions/generate",
				strings.NewReader(fmt.Sprintf(`{"api_server":%q,"api_type":%q,"model":"m","prompt":"p"}`, provider.URL, apiType)))
			request.Header.Set("Content-Type", "application/json")
			ctx, cancel := context.WithCancel(context.Background())
			request = request.WithContext(ctx)
			done := make(chan struct{})
			go func() {
				handler.ServeHTTP(httptest.NewRecorder(), request)
				close(done)
			}()

			awaitArrival(t, arrivals, "POST /v1/completions")
			cancel()
			if apiType == "koboldcpp" {
				awaitArrival(t, arrivals, "POST /api/extra/abort")
			} else {
				select {
				case arrival := <-arrivals:
					if arrival == "POST /api/extra/abort" {
						t.Fatalf("%s must not abort the backend: only koboldcpp has an abort endpoint", apiType)
					}
				case <-time.After(500 * time.Millisecond):
					// No abort request, which is the pinned behaviour for every other type.
				}
			}
			close(release)
			released = true
			select {
			case <-done:
			case <-time.After(10 * time.Second):
				t.Fatal("the handler did not finish after the provider was released")
			}
		})
	}
}

func awaitArrival(t *testing.T, arrivals <-chan string, want string) {
	t.Helper()
	deadline := time.After(10 * time.Second)
	for {
		select {
		case got := <-arrivals:
			if got == want {
				return
			}
		case <-deadline:
			t.Fatalf("the provider never received %q", want)
		}
	}
}
