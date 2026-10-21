package server

// Replay of tests/oracle/sillytavern-1.19.0-openai-generate-video.json, recorded by
// tools/probe-openai-generate-video.mjs, plus the TWO LABELLED implementation tests the increment promised.
//
// The TIMEOUT leg cannot be recorded: thirty polls with escalating delays is about ten minutes of wall
// clock, AND the pinned behaviour is a HANG rather than an answer, so parity is UNOBSERVED. The test below
// proves the implementation instead -- thirty attempts, nothing written, and a return once the caller goes
// away -- and it pins the delay formula by recording what the loop asks for.
//
// Cancellation is labelled for the same reason the Google route's was: the pinned abort rides on
// `request.socket.on('close')`, which this suite cannot rely on.

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"
)

type openAIVideoFixture struct {
	Inputs struct {
		PollCounts map[string]int `json:"pollCounts"`
		JobID      string         `json:"jobId"`
	} `json:"inputs"`
	Scenarios map[string]transcribeScenario `json:"scenarios"`
}

func loadOpenAIVideoOracle(t *testing.T) openAIVideoFixture {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-openai-generate-video.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture openAIVideoFixture
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	if len(fixture.Scenarios) < 10 {
		t.Fatalf("the openai video oracle records only %d scenarios", len(fixture.Scenarios))
	}
	return fixture
}

// openAIVideoPeer serves the recorded rules the way the PROBE's stub does: the FIRST rule whose match is
// CONTAINED in the request URL, honouring `times`. Serving by request order instead would hand the poll
// request the content mock in the reserved-job-id scenario, where the content rule is listed first because
// its path is the longer prefix.
type openAIVideoPeer struct {
	server *httptest.Server
	rules  []googleTTSMock
	used   map[int]int
	seen   []transcribeOutbound
}

func newOpenAIVideoPeer(t *testing.T, rules []googleTTSMock) *openAIVideoPeer {
	t.Helper()
	peer := &openAIVideoPeer{rules: rules, used: map[int]int{}}
	for index := range peer.rules {
		if peer.rules[index].BinaryBody {
			if decoded, err := base64.StdEncoding.DecodeString(peer.rules[index].Body); err == nil {
				peer.rules[index].Body = string(decoded)
			}
		}
	}
	peer.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		peer.seen = append(peer.seen, transcribeOutbound{
			URL:     r.URL.RequestURI(),
			Method:  r.Method,
			Headers: headerMapOf(r.Header),
			Body:    string(body),
		})
		chosen := -1
		for index := range peer.rules {
			if !strings.Contains(r.URL.RequestURI(), peer.rules[index].Match) {
				continue
			}
			if peer.rules[index].Times > 0 && peer.used[index] >= peer.rules[index].Times {
				continue
			}
			chosen = index
			break
		}
		if chosen < 0 {
			w.WriteHeader(http.StatusInternalServerError)
			_, _ = w.Write([]byte(`{"error":"gotavern test: unstubbed outbound request"}`))
			return
		}
		peer.used[chosen]++
		rule := peer.rules[chosen]
		for name, value := range rule.Headers {
			w.Header().Set(name, value)
		}
		status := rule.Status
		if status == 0 {
			status = 200
		}
		w.WriteHeader(status)
		_, _ = w.Write([]byte(rule.Body))
	}))
	t.Cleanup(peer.server.Close)
	return peer
}
func TestOpenAIGenerateVideoMatchesPinnedOracle(t *testing.T) {
	fixture := loadOpenAIVideoOracle(t)
	// The delays affect WHEN the polls happen, not WHAT is recorded, so the replay does not spend five to
	// eleven seconds per scenario; the fixture records the count, the order, the URLs, the bodies and the
	// messages, all of which are unchanged.
	previousSleep := openAIVideoSleep
	openAIVideoSleep = func(ctx context.Context, duration time.Duration) bool { return true }
	t.Cleanup(func() { openAIVideoSleep = previousSleep })
	names := make([]string, 0, len(fixture.Scenarios))
	for name := range fixture.Scenarios {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		scenario := fixture.Scenarios[name]
		t.Run(name, func(t *testing.T) {
			peer := newOpenAIVideoPeer(t, scenario.Mocks)

			t.Setenv("GOTAVERN_OPENAI_VIDEOS_URL", peer.server.URL)
			dataRoot := t.TempDir()
			handler := NewHTTPHandlerWithOptions(HTTPHandlerOptions{InstallRoot: dataRoot, DataRoot: dataRoot, DisableCSRF: true})
			writeGoogleTTSSecrets(t, dataRoot, scenario.Secrets)
			recorder := httptest.NewRecorder()
			request := httptest.NewRequest(http.MethodPost, scenario.Route, strings.NewReader(scenario.RequestBody))
			request.Header.Set("Content-Type", "application/json")
			handler.ServeHTTP(recorder, request)

			if recorder.Code != scenario.Response.Status {
				t.Fatalf("status = %d, pinned %d (body %q)", recorder.Code, scenario.Response.Status, recorder.Body.String())
			}
			if recorder.Body.String() != scenario.Response.BodyText {
				t.Fatalf("body = %q, pinned %q", recorder.Body.String(), scenario.Response.BodyText)
			}
			// THE POLL COUNT: when two requests are otherwise identical, the count is the only thing that
			// separates the real loop from a shortcut.
			if len(peer.seen) != len(scenario.Outbound) {
				t.Fatalf("outbound requests = %d, pinned %d (the poll count is behaviour)", len(peer.seen), len(scenario.Outbound))
			}
			for index, recorded := range scenario.Outbound {
				actual := peer.seen[index]
				if actual.Method != recorded.Method {
					t.Fatalf("request %d method = %s, pinned %s", index, actual.Method, recorded.Method)
				}
				if actual.URL != recordedURLPath(t, recorded.URL) {
					t.Fatalf("request %d target = %q, pinned %q", index, actual.URL, recordedURLPath(t, recorded.URL))
				}
				if actual.Body != recorded.Body {
					t.Fatalf("request %d body = %q, pinned %q", index, actual.Body, recorded.Body)
				}
				if got, want := actual.Headers["authorization"], recorded.Headers["authorization"]; got != want {
					t.Fatalf("request %d authorization = %q, pinned %q", index, got, want)
				}
			}
		})
	}
}

func recordedURLPath(t *testing.T, recorded string) string {
	t.Helper()
	request, err := http.NewRequest(http.MethodGet, recorded, nil)
	if err != nil {
		t.Fatal(err)
	}
	return request.URL.RequestURI()
}

// TestOpenAIGenerateVideoPollCountIsAFixtureProperty states the count explicitly, so a shortcut that skips a
// poll fails as a loop defect rather than as an opaque request-count mismatch.
func TestOpenAIGenerateVideoPollCountIsAFixtureProperty(t *testing.T) {
	fixture := loadOpenAIVideoOracle(t)
	onePoll := fixture.Scenarios["completedFirstPoll"]
	twoPolls := fixture.Scenarios["completedSecondPoll"]
	if len(onePoll.Outbound) != 3 || len(twoPolls.Outbound) != 4 {
		t.Fatalf("the fixture must record 3 requests for one poll and 4 for two, got %d and %d",
			len(onePoll.Outbound), len(twoPolls.Outbound))
	}
	if onePoll.Outbound[1].URL != twoPolls.Outbound[1].URL {
		t.Fatal("both scenarios must poll the same URL, so only the COUNT differs")
	}
	if fixture.Inputs.PollCounts["completedFirstPoll"] != 1 || fixture.Inputs.PollCounts["completedSecondPoll"] != 2 {
		t.Fatalf("the fixture's declared poll counts are %v", fixture.Inputs.PollCounts)
	}
}

// TestOpenAIGenerateVideoTimeoutIsAnImplementationTest is LABELLED: parity was UNOBSERVED, because thirty
// polls with escalating delays is about ten minutes of wall clock and the pinned answer is a HANG. It proves
// the implementation: thirty attempts, the pinned delay sequence, NOTHING written, and a return once the
// caller goes away.
func TestOpenAIGenerateVideoTimeoutIsAnImplementationTest(t *testing.T) {
	previousSleep := openAIVideoSleep
	var mu sync.Mutex
	requested := make([]time.Duration, 0, 40)
	openAIVideoSleep = func(ctx context.Context, duration time.Duration) bool {
		mu.Lock()
		requested = append(requested, duration)
		mu.Unlock()
		return true
	}
	t.Cleanup(func() { openAIVideoSleep = previousSleep })

	var counters sync.Mutex
	createCount := 0
	pollCount := 0
	peer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.Method == http.MethodPost {
			counters.Lock()
			createCount++
			counters.Unlock()
			_, _ = w.Write([]byte(`{"id":"video_never_finishes"}`))
			return
		}
		counters.Lock()
		pollCount++
		counters.Unlock()
		_, _ = w.Write([]byte(`{"id":"video_never_finishes","status":"in_progress"}`))
	}))
	t.Cleanup(peer.Close)
	t.Setenv("GOTAVERN_OPENAI_VIDEOS_URL", peer.URL)

	dataRoot := t.TempDir()
	handler := NewHTTPHandlerWithOptions(HTTPHandlerOptions{InstallRoot: dataRoot, DataRoot: dataRoot, DisableCSRF: true})
	writeGoogleTTSSecrets(t, dataRoot, map[string][]struct {
		Value string `json:"value"`
	}{"api_key_openai": {{Value: "synthetic-openai-key"}}})

	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/api/openai/generate-video", strings.NewReader(`{"prompt":"a cat"}`))
	request.Header.Set("Content-Type", "application/json")
	ctx, cancel := context.WithCancel(request.Context())
	done := make(chan struct{})
	go func() {
		handler.ServeHTTP(recorder, request.WithContext(ctx))
		close(done)
	}()

	// The handler must HANG: nothing written while the caller is still there.
	select {
	case <-done:
		t.Fatal("the handler returned before the caller went away; the exhausted job must hang, not answer")
	case <-time.After(200 * time.Millisecond):
	}
	if recorder.Body.Len() != 0 {
		t.Fatalf("the hung handler wrote %d bytes; pinned writes NOTHING", recorder.Body.Len())
	}

	cancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("the handler did not return after the caller was cancelled")
	}
	if recorder.Body.Len() != 0 {
		t.Fatalf("the handler wrote %q after the caller left; pinned writes nothing", recorder.Body.String())
	}
	counters.Lock()
	polls, creates := pollCount, createCount
	counters.Unlock()
	if polls != 30 {
		t.Fatalf("the loop polled %d times, pinned 30", polls)
	}
	if creates != 1 {
		t.Fatalf("the loop created %d jobs, pinned 1", creates)
	}
	if len(requested) != 30 {
		t.Fatalf("the loop asked for %d delays, pinned 30", len(requested))
	}
	for index, duration := range requested {
		want := time.Duration(5000+index*1000) * time.Millisecond
		if duration != want {
			t.Fatalf("delay %d = %v, pinned %v", index, duration, want)
		}
	}
}

// TestOpenAIGenerateVideoCancellationIsAnImplementationTest is LABELLED for the same reason the Google
// route's was. The disconnect is simulated where the client would vanish: during the first delay.
func TestOpenAIGenerateVideoCancellationIsAnImplementationTest(t *testing.T) {
	var cancel context.CancelFunc
	previousSleep := openAIVideoSleep
	openAIVideoSleep = func(ctx context.Context, duration time.Duration) bool {
		if cancel != nil {
			cancel()
		}
		return false
	}
	t.Cleanup(func() { openAIVideoSleep = previousSleep })

	peer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.Method == http.MethodPost {
			_, _ = w.Write([]byte(`{"id":"video_never_finishes"}`))
			return
		}
		_, _ = w.Write([]byte(`{"status":"in_progress"}`))
	}))
	t.Cleanup(peer.Close)
	t.Setenv("GOTAVERN_OPENAI_VIDEOS_URL", peer.URL)

	dataRoot := t.TempDir()
	handler := NewHTTPHandlerWithOptions(HTTPHandlerOptions{InstallRoot: dataRoot, DataRoot: dataRoot, DisableCSRF: true})
	writeGoogleTTSSecrets(t, dataRoot, map[string][]struct {
		Value string `json:"value"`
	}{"api_key_openai": {{Value: "synthetic-openai-key"}}})

	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/api/openai/generate-video", strings.NewReader(`{"prompt":"a cat"}`))
	request.Header.Set("Content-Type", "application/json")
	ctx, cancelFunc := context.WithCancel(request.Context())
	cancel = cancelFunc
	defer cancelFunc()
	handler.ServeHTTP(recorder, request.WithContext(ctx))

	if recorder.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", recorder.Code)
	}
	if recorder.Body.String() != "Video generation aborted by client" {
		t.Fatalf("body = %q, pinned %q", recorder.Body.String(), "Video generation aborted by client")
	}
}
