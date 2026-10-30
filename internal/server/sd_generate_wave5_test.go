package server

// Route-level replay of the WAVE 5 scenarios in tests/oracle/sillytavern-1.19.0-sd-generate-wave5.json, plus
// the labelled implementation tests this wave owes:
//
//	POST /api/sd/bfl/generate     stable-diffusion.js:1473
//	POST /api/sd/falai/generate   stable-diffusion.js:1641
//
// The two routes are POLLING routes, so three things about this file are deliberate:
//
//   - the request COUNT is asserted before anything else, because an implementation that polls once
//     where the pinned handler polls twice is a different observable with the same status and body;
//   - the follow-up URLs are PROVIDER-SUPPLIED, so the mock bodies are rewritten onto this test's own
//     listener and the comparison is the WIRE TARGET (escaped path + query) the route chose. The host is
//     the provider's choice, not the implementation's, and comparing it would assert nothing (rule 15);
//   - the recorded rule list is replayed with the SAME substring + `times` selection the probe's stub
//     used, because a peer that serves mocks by request order would hand the wrong answer to the wrong
//     shape (rule 20).
//
// The wall-clock interval is collapsed through a test seam, so `elapsedBucket` is evidence about the
// PINNED run and is not compared here; TestSDBFLPollIntervalIs2500ms and
// TestSDFalaiPollIntervalIs2500ms pin the production value instead.

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// sdWave5Labels is the scenario list this file is responsible for. It is spelled out rather than derived
// from a prefix so a renamed or dropped scenario is a failure here instead of a silently smaller run.
var sdWave5Labels = []string{
	"bflNoKey",
	"bflPro11ReadyFirstPoll",
	"bflPendingThenReady",
	"bflFallbackPollingUrl",
	"bflUltraSimplifiedRatio",
	"bflUltraMaxAspect",
	"bflUltraMinAspect",
	"bflUltraMissingDimensions",
	"bflSubmitNonOk",
	"bflPlainModelKeepsSteps",
	"bflPollNonOk",
	"bflUnexpectedStatus",
	"bflSampleFetchNonOk",
	"bflSubmitThrows",
	"bflReservedModelRaw",
	"falaiNoKey",
	"falaiCompletedFirstPoll",
	"falaiInQueueThenCompleted",
	"falaiSubmitNonOk",
	"falaiUnexpectedStatus",
	"falaiResultDetail",
	"falaiPollNonOk",
	"falaiSubmitThrows",
	"falaiReservedModelRaw",
}

// TestSDGenerateWave5SeamDefaults pins each seam default to the pinned literal. A seam whose default
// drifts silently changes production while every replay keeps passing against the override.
func TestSDGenerateWave5SeamDefaults(t *testing.T) {
	for _, seam := range []struct {
		environment string
		accessor    func() string
		pinned      string
	}{
		{"GOTAVERN_SD_BFL_URL", sdBFLURL, sdBFLDefaultURL},
		{"GOTAVERN_SD_FALAI_QUEUE_URL", sdFalaiQueueURL, sdFalaiQueueDefaultURL},
	} {
		t.Setenv(seam.environment, "")
		if got := seam.accessor(); got != seam.pinned {
			t.Fatalf("%s seam default = %q, pinned %q", seam.environment, got, seam.pinned)
		}
		t.Setenv(seam.environment, "http://127.0.0.1:9999/")
		if got := seam.accessor(); got != "http://127.0.0.1:9999" {
			t.Fatalf("%s override = %q, want the trailing slash trimmed", seam.environment, got)
		}
	}
}

// TestSDBFLPollIntervalIs2500ms and TestSDFalaiPollIntervalIs2500ms pin the cadence the routes sleep
// between polls. It cannot be recorded in a fixture (wall clock does not cross that boundary), so it is
// asserted here: a route that polled at 250ms would look identical to a fixture and behave nothing like
// pinned SillyTavern against the real providers.
func TestSDBFLPollIntervalIs2500ms(t *testing.T) {
	if sdBFLPollInterval != 2500*time.Millisecond {
		t.Fatalf("bfl poll interval = %s, pinned 2500ms", sdBFLPollInterval)
	}
	if sdBFLMaxAttempts != 100 {
		t.Fatalf("bfl max attempts = %d, pinned 100", sdBFLMaxAttempts)
	}
}

func TestSDFalaiPollIntervalIs2500ms(t *testing.T) {
	if sdFalaiPollInterval != 2500*time.Millisecond {
		t.Fatalf("fal.ai poll interval = %s, pinned 2500ms", sdFalaiPollInterval)
	}
	if sdFalaiMaxAttempts != 100 {
		t.Fatalf("fal.ai max attempts = %d, pinned 100", sdFalaiMaxAttempts)
	}
}

// withFastSDPolling collapses both poll intervals for a route test and restores them afterwards.
func withFastSDPolling(t *testing.T) {
	t.Helper()
	previousBFL, previousFalai := sdBFLPollInterval, sdFalaiPollInterval
	sdBFLPollInterval = time.Millisecond
	sdFalaiPollInterval = time.Millisecond
	t.Cleanup(func() {
		sdBFLPollInterval = previousBFL
		sdFalaiPollInterval = previousFalai
	})
}

// loadSDWave5Oracle reads the wave-5 fixture. It lives in its OWN file rather than in
// sillytavern-1.19.0-sd-generate.json because that file's `scenarios` is the replay list of
// TestSDGenerateRoutesMatchPinnedOracle, whose controlled peer has no `times` rule support, no wave-5 seam
// and no provider-URL rewriting: adding poll scenarios there would hand them to a peer that cannot answer
// them. The wave-1..4 fixture lists both routes as implemented and points here.
func loadSDWave5Oracle(t *testing.T) sdGenerateFixture {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-sd-generate-wave5.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture sdGenerateFixture
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	if len(fixture.Scenarios) < len(sdWave5Labels) {
		t.Fatalf("the wave-5 oracle records only %d scenarios, the replay needs %d", len(fixture.Scenarios), len(sdWave5Labels))
	}
	return fixture
}

// sdWave5Target reduces a recorded request URL to the WIRE TARGET the peer can observe: escaped path plus
// raw query. A seam-default prefix is trimmed first so the comparison is about the path the handler built;
// a provider-supplied URL keeps only its path and query, because its host belongs to the provider.
//
// EscapedPath is used rather than Path on purpose: the decoded form has already thrown away the
// distinction between `%2F` and `/`, which is exactly what the reserved-character scenarios record.
func sdWave5Target(recorded string) string {
	remainder := recorded
	for _, base := range []string{sdBFLDefaultURL, sdFalaiQueueDefaultURL} {
		if strings.HasPrefix(remainder, base) {
			remainder = strings.TrimPrefix(remainder, base)
			break
		}
	}
	parsed, err := url.Parse(remainder)
	if err != nil {
		return remainder
	}
	target := parsed.EscapedPath()
	if target == "" {
		target = remainder
	}
	if parsed.RawQuery != "" {
		target += "?" + parsed.RawQuery
	}
	return target
}

// rewriteSDProviderURLs replaces every absolute URL inside a mock body with this listener's origin plus
// the URL's path and query, so a provider-supplied follow-up URL lands on the controlled peer. Only the
// HOST changes: the path and query the route must reproduce are preserved verbatim.
func rewriteSDProviderURLs(value any, origin string) any {
	switch typed := value.(type) {
	case string:
		if strings.HasPrefix(typed, "https://") || strings.HasPrefix(typed, "http://") {
			return origin + sdWave5Target(typed)
		}
		return typed
	case []any:
		rewritten := make([]any, len(typed))
		for index, item := range typed {
			rewritten[index] = rewriteSDProviderURLs(item, origin)
		}
		return rewritten
	case map[string]any:
		rewritten := make(map[string]any, len(typed))
		for key, item := range typed {
			rewritten[key] = rewriteSDProviderURLs(item, origin)
		}
		return rewritten
	default:
		return value
	}
}

// sdWave5Peer replays a scenario's recorded rules with the probe stub's semantics: the FIRST rule whose
// match is a substring of the request target answers, and a `times`-bounded rule stops answering once it
// has been used that many times.
//
// A rule whose match names a PROVIDER HOST (the follow-up URLs) cannot match the request that reaches
// this listener, because the mock body was rewritten onto 127.0.0.1. For those rules the recorded wire
// targets of the requests that URL served are the match, so the same shape answers the same request.
type sdWave5Peer struct {
	server  *httptest.Server
	mu      sync.Mutex
	rules   []sdGenerateRule
	aliases map[string][]string
	usage   map[int]int
	seen    []sdWave5Seen
}

type sdWave5Seen struct {
	Method string
	Target string
	Header http.Header
	Body   string
}

func newSDWave5Peer(t *testing.T, scenario sdGenerateScenario) *sdWave5Peer {
	t.Helper()
	peer := &sdWave5Peer{usage: map[int]int{}, aliases: map[string][]string{}}
	peer.rules = append([]sdGenerateRule{}, scenario.Mocks...)
	// A recorded URL that a provider-host rule served becomes an ALIAS so the rewritten request matches.
	for _, recorded := range scenario.Outbound {
		for _, rule := range peer.rules {
			if !strings.Contains(recorded.URL, rule.Match) {
				continue
			}
			target := sdWave5Target(recorded.URL)
			peer.aliases[rule.Match] = append(peer.aliases[rule.Match], target)
		}
	}
	peer.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := readAllString(r)
		target := r.URL.EscapedPath()
		if r.URL.RawQuery != "" {
			target += "?" + r.URL.RawQuery
		}
		peer.mu.Lock()
		peer.seen = append(peer.seen, sdWave5Seen{Method: r.Method, Target: target, Header: r.Header.Clone(), Body: body})
		var chosen *sdGenerateRule
		for index := range peer.rules {
			if peer.rules[index].Times > 0 && peer.usage[index] >= peer.rules[index].Times {
				continue
			}
			if !peer.matches(index, r.URL.EscapedPath()+"?"+r.URL.RawQuery) {
				continue
			}
			chosen = &peer.rules[index]
			if peer.rules[index].Times > 0 {
				peer.usage[index]++
			}
			break
		}
		peer.mu.Unlock()
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
	// The listener exists now, so the provider URLs in the recorded answers can be pointed at it.
	for index := range peer.rules {
		// A body with no URL in it is left BYTE-IDENTICAL. Re-marshalling it would re-order its members
		// (Go maps are unordered), and a scenario whose provider answer BECOMES the response body — the
		// fal.ai "unknown status" cause — would then differ from the pinned recording for a reason the
		// product never causes.
		if !strings.Contains(peer.rules[index].Body, "http") {
			continue
		}
		var document any
		if json.Unmarshal([]byte(peer.rules[index].Body), &document) != nil {
			continue
		}
		rewritten := rewriteSDProviderURLs(document, peer.server.URL)
		encoded, err := json.Marshal(rewritten)
		if err != nil {
			continue
		}
		peer.rules[index].Body = string(encoded)
	}
	return peer
}

// matches implements the probe stub's selection: a substring match on the request target, plus the alias
// targets of a provider-host rule.
func (peer *sdWave5Peer) matches(index int, target string) bool {
	rule := peer.rules[index]
	if strings.Contains(target, rule.Match) {
		return true
	}
	for _, alias := range peer.aliases[rule.Match] {
		if alias != "" && strings.Contains(target, alias) {
			return true
		}
	}
	return false
}

// recorded returns a COPY of the requests this peer answered, taken under the mutex its handler writes
// with. Reading peer.seen from test code without it is a data race: the handler records before it answers,
// the test reads after the response arrives, and a late or leaked handler from the previous subtest can
// append in between (found by the CI race job, 2026-10-29).
func (peer *sdWave5Peer) recorded() []sdWave5Seen {
	peer.mu.Lock()
	defer peer.mu.Unlock()
	return append([]sdWave5Seen(nil), peer.seen...)
}

func (peer *sdWave5Peer) summary() []string {
	peer.mu.Lock()
	defer peer.mu.Unlock()
	result := make([]string, 0, len(peer.recorded()))
	for _, entry := range peer.recorded() {
		result = append(result, entry.Method+" "+entry.Target)
	}
	return result
}

// sdWave5Handler seeds the one secrets file the scenario needs and builds a handler over a fresh data root.
func sdWave5Handler(t *testing.T, scenario sdGenerateScenario) http.Handler {
	t.Helper()
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
	return NewHTTPHandlerWithOptions(HTTPHandlerOptions{InstallRoot: dataRoot, DataRoot: dataRoot, DisableCSRF: true})
}

// sdWave5ContractHeaders are the provider headers whose ABSENCE is also behaviour. The check is
// bidirectional: a header the pinned call sends must match, and one it does not send must not appear.
func sdWave5ContractHeaders(t *testing.T, label string, index int, seen http.Header, recorded map[string]string) {
	t.Helper()
	for _, name := range []string{"authorization", "content-type", "x-key", "accept"} {
		present := len(seen[http.CanonicalHeaderKey(name)]) > 0
		want, recordedPresent := recorded[name]
		if recordedPresent {
			if got := seen.Get(name); got != want {
				t.Fatalf("%s: request %d header %q = %q, pinned %q", label, index, name, got, want)
			}
			continue
		}
		if present {
			t.Fatalf("%s: request %d sent header %q the pinned call does not send (value %q)", label, index, name, seen.Get(name))
		}
	}
}

func TestSDGenerateWave5RoutesMatchPinnedOracle(t *testing.T) {
	fixture := loadSDWave5Oracle(t)
	withFastSDPolling(t)

	implemented := map[string]bool{}
	for _, route := range fixture.ImplementedRoutes {
		implemented[route] = true
	}
	for _, label := range sdWave5Labels {
		scenario, present := fixture.Scenarios[label]
		if !present {
			t.Fatalf("the fixture does not record the wave-5 scenario %q; the replay refuses to pass on a smaller set", label)
		}
		if !implemented[scenario.Route] {
			t.Fatalf("%s: %s is missing from implementedRoutes", label, scenario.Route)
		}
	}

	statuses := map[int]int{}
	sawPollSequence, sawSampleFetch := 0, 0
	for _, label := range sdWave5Labels {
		label, scenario := label, fixture.Scenarios[label]
		t.Run(label, func(t *testing.T) {
			peer := newSDWave5Peer(t, scenario)
			t.Setenv("GOTAVERN_SD_BFL_URL", peer.server.URL)
			t.Setenv("GOTAVERN_SD_FALAI_QUEUE_URL", peer.server.URL)
			handler := sdWave5Handler(t, scenario)
			response := postSecretsRoute(t, handler, scenario.Route, scenario.RequestBody)
			statuses[response.Code]++

			if response.Code != scenario.Response.Status {
				t.Fatalf("%s: status = %d, pinned %d (body %q; peer saw %v)",
					label, response.Code, scenario.Response.Status, response.Body.String(), peer.summary())
			}
			assertPinnedHeaders(t, response.Header(), scenario.Response.Headers)
			if got, want := response.Body.String(), scenario.Response.BodyText; got != want {
				t.Fatalf("%s: body = %q, pinned %q", label, got, want)
			}
			// THE POLL COUNT, asserted first among the outbound observations and named as such: a route
			// that skipped or repeated a poll fails here with a message about the loop.
			if len(peer.recorded()) != len(scenario.Outbound) {
				t.Fatalf("%s: peer received %d request(s), pinned %d - the poll count is behaviour (peer saw %v)",
					label, len(peer.recorded()), len(scenario.Outbound), peer.summary())
			}
			if len(scenario.Outbound) == 0 {
				return
			}
			for index, recorded := range scenario.Outbound {
				seen := peer.recorded()[index]
				if seen.Method != recorded.Method {
					t.Fatalf("%s: request %d method = %s, pinned %s", label, index, seen.Method, recorded.Method)
				}
				if want := sdWave5Target(recorded.URL); seen.Target != want {
					t.Fatalf("%s: request %d target = %q, pinned %q", label, index, seen.Target, want)
				}
				sdWave5ContractHeaders(t, label, index, seen.Header, recorded.Headers)
				wantBody := ""
				if recorded.Body != nil {
					wantBody = *recorded.Body
				}
				if seen.Body != wantBody {
					t.Fatalf("%s: request %d body = %q, pinned %q", label, index, seen.Body, wantBody)
				}
			}
			if len(scenario.Outbound) >= 3 {
				sawPollSequence++
			}
			for _, recorded := range scenario.Outbound {
				if strings.Contains(recorded.URL, "media.example.test") {
					sawSampleFetch++
				}
			}
		})
	}
	if statuses[200] == 0 || statuses[400] == 0 || statuses[500] == 0 {
		t.Fatalf("the wave-5 scenarios do not cover the 200/400/500 branches: %+v", statuses)
	}
	if sawPollSequence == 0 {
		t.Fatal("no wave-5 scenario records a submit-then-poll sequence")
	}
	if sawSampleFetch == 0 {
		t.Fatal("no wave-5 scenario records the media fetch")
	}
}

// TestSDGenerateWave5PollCountIsAFixtureProperty states the counts explicitly, so a loop that polls the
// wrong number of times fails with a message about the loop rather than as an opaque count mismatch. The
// paired scenarios differ ONLY in how many Pending/IN_QUEUE answers the peer served, so only the count
// can explain a difference.
func TestSDGenerateWave5PollCountIsAFixtureProperty(t *testing.T) {
	fixture := loadSDWave5Oracle(t)
	for _, pair := range []struct {
		one    string
		oneLen int
		two    string
		twoLen int
	}{
		{"bflPro11ReadyFirstPoll", 3, "bflPendingThenReady", 4},
		{"falaiCompletedFirstPoll", 4, "falaiInQueueThenCompleted", 5},
	} {
		first, second := fixture.Scenarios[pair.one], fixture.Scenarios[pair.two]
		if len(first.Outbound) != pair.oneLen || len(second.Outbound) != pair.twoLen {
			t.Fatalf("%s/%s: the fixture must record %d and %d requests, got %d and %d",
				pair.one, pair.two, pair.oneLen, pair.twoLen, len(first.Outbound), len(second.Outbound))
		}
		if first.Outbound[1].URL != second.Outbound[1].URL {
			t.Fatalf("%s/%s: both scenarios must poll the same URL, so only the COUNT differs (%q vs %q)",
				pair.one, pair.two, first.Outbound[1].URL, second.Outbound[1].URL)
		}
	}
}

// sdWave5Timing reads the one fixture field the replay cannot compare: `elapsedBucket`. The Go replay
// collapses the interval through a test seam, so the bucket is evidence about the PINNED run — it shows
// that the poll scenarios really spent a 2500ms delay and the pre-loop failures did not — and asserting it
// here keeps that evidence from rotting into decoration.
type sdWave5Timing struct {
	Scenarios map[string]struct {
		ElapsedBucket string `json:"elapsedBucket"`
	} `json:"scenarios"`
}

func TestSDGenerateWave5RecordedPollWaits(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-sd-generate-wave5.json"))
	if err != nil {
		t.Fatal(err)
	}
	var timing sdWave5Timing
	if err := json.Unmarshal(raw, &timing); err != nil {
		t.Fatal(err)
	}
	for _, label := range sdWave5Labels {
		recorded, present := timing.Scenarios[label]
		if !present {
			t.Fatalf("%s is missing from the fixture", label)
		}
		want := "under-2s"
		for _, scenarioLabel := range []string{
			"bflPro11ReadyFirstPoll", "bflPendingThenReady", "bflFallbackPollingUrl",
			"bflUltraSimplifiedRatio", "bflUltraMaxAspect", "bflUltraMinAspect",
			"bflPollNonOk", "bflUnexpectedStatus", "bflSampleFetchNonOk",
			"falaiCompletedFirstPoll", "falaiInQueueThenCompleted",
			"falaiUnexpectedStatus", "falaiResultDetail", "falaiPollNonOk",
		} {
			if label == scenarioLabel {
				want = "waited-for-poll"
			}
		}
		if recorded.ElapsedBucket != want {
			t.Fatalf("%s: elapsedBucket = %q, want %q (the pinned run's own measurement)", label, recorded.ElapsedBucket, want)
		}
	}
}

// sdCountingWriter records whether a handler answered at all. An exhausted poll loop leaves the request
// unanswered on the pinned server, and "wrote nothing" is invisible to an httptest.ResponseRecorder
// because its zero value already reports 200.
type sdCountingWriter struct {
	header  http.Header
	status  int
	written bool
	body    bytes.Buffer
}

func (writer *sdCountingWriter) Header() http.Header {
	if writer.header == nil {
		writer.header = http.Header{}
	}
	return writer.header
}

func (writer *sdCountingWriter) WriteHeader(status int) {
	if !writer.written {
		writer.status = status
		writer.written = true
	}
}

func (writer *sdCountingWriter) Write(payload []byte) (int, error) {
	writer.written = true
	return writer.body.Write(payload)
}

// TestSDBFLTimeoutIsAnImplementationTest is LABELLED: the exhaustion branch needs 100 polls of 2500ms,
// about four minutes of wall clock, so parity could not be recorded and the probe does not shorten the
// delay. The pinned observable IS reproduced here — after MAX_ATTEMPTS Pending answers the handler ends
// without writing a response, so the caller waits for its own timeout — and the loop's shape (one
// submit, exactly 100 polls) is asserted.
func TestSDBFLTimeoutIsAnImplementationTest(t *testing.T) {
	withFastSDPolling(t)
	var mu sync.Mutex
	polls := 0
	peer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.Method == http.MethodPost {
			_, _ = w.Write([]byte(`{"id":"task","polling_url":"http://` + r.Host + `/v1/poll"}`))
			return
		}
		mu.Lock()
		polls++
		mu.Unlock()
		_, _ = w.Write([]byte(`{"status":"Pending"}`))
	}))
	t.Cleanup(peer.Close)
	t.Setenv("GOTAVERN_SD_BFL_URL", peer.URL)

	handler := sdWave5Handler(t, sdGenerateScenario{
		Secrets: map[string][]map[string]any{"api_key_bfl": {{"id": "sid", "value": "synthetic-bfl-key", "active": true}}},
	})
	writer := &sdCountingWriter{}
	request := httptest.NewRequest(http.MethodPost, "/api/sd/bfl/generate", strings.NewReader(`{"prompt":"a tree","model":"flux-pro-1.1"}`))
	request.Header.Set("Content-Type", "application/json")
	handler.ServeHTTP(writer, request)

	if polls != sdBFLMaxAttempts {
		t.Fatalf("the loop polled %d times, pinned %d", polls, sdBFLMaxAttempts)
	}
	if writer.written {
		t.Fatalf("the exhausted loop answered %d with body %q; the pinned handler writes NOTHING", writer.status, writer.body.String())
	}
}

// TestSDFalaiTimeoutIsAnImplementationTest is the same labelled case for fal.ai: 100 IN_QUEUE answers,
// then no response at all.
func TestSDFalaiTimeoutIsAnImplementationTest(t *testing.T) {
	withFastSDPolling(t)
	var mu sync.Mutex
	polls := 0
	peer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.Method == http.MethodPost {
			_, _ = w.Write([]byte(`{"status_url":"http://` + r.Host + `/v1/status"}`))
			return
		}
		mu.Lock()
		polls++
		mu.Unlock()
		_, _ = w.Write([]byte(`{"status":"IN_QUEUE"}`))
	}))
	t.Cleanup(peer.Close)
	t.Setenv("GOTAVERN_SD_FALAI_QUEUE_URL", peer.URL)

	handler := sdWave5Handler(t, sdGenerateScenario{
		Secrets: map[string][]map[string]any{"api_key_falai": {{"id": "sid", "value": "synthetic-falai-key", "active": true}}},
	})
	writer := &sdCountingWriter{}
	request := httptest.NewRequest(http.MethodPost, "/api/sd/falai/generate", strings.NewReader(`{"prompt":"a tree","model":"flux-pro"}`))
	request.Header.Set("Content-Type", "application/json")
	handler.ServeHTTP(writer, request)

	if polls != sdFalaiMaxAttempts {
		t.Fatalf("the loop polled %d times, pinned %d", polls, sdFalaiMaxAttempts)
	}
	if writer.written {
		t.Fatalf("the exhausted loop answered %d with body %q; the pinned handler writes NOTHING", writer.status, writer.body.String())
	}
}

// TestSDBFLMissingSampleIsAnImplementationTest is LABELLED per AGENTS.md rule 4: this branch has no
// oracle. The pinned code fetches `undefined`, node-fetch rejects it and the catch answers 500, but the
// controlled peer cannot record that — it records the request for the string "undefined", finds no rule
// and synthesises a 500 RESPONSE, which the sample fetch does not check, so the pinned route would answer
// 200 with the stub's own text. The Go behaviour asserted here is therefore a derivation from the pinned
// source, not a pinned observation, and it is named as such.
func TestSDBFLMissingSampleIsAnImplementationTest(t *testing.T) {
	withFastSDPolling(t)
	peer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.Method == http.MethodPost {
			_, _ = w.Write([]byte(`{"id":"task","polling_url":"http://` + r.Host + `/v1/poll"}`))
			return
		}
		_, _ = w.Write([]byte(`{"status":"Ready","result":{}}`))
	}))
	t.Cleanup(peer.Close)
	t.Setenv("GOTAVERN_SD_BFL_URL", peer.URL)

	handler := sdWave5Handler(t, sdGenerateScenario{
		Secrets: map[string][]map[string]any{"api_key_bfl": {{"id": "sid", "value": "synthetic-bfl-key", "active": true}}},
	})
	response := postSecretsRoute(t, handler, "/api/sd/bfl/generate", `{"prompt":"a tree","model":"flux-pro-1.1"}`)
	if response.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500 (body %q)", response.Code, response.Body.String())
	}
}

// TestSDBFLAspectRatioHelper pins the arithmetic the fixture records, including the two branches the
// recorded scenarios cannot reach on their own: the simplification and the "NaN:NaN" a zero height
// produces (the pinned helper does not throw there, because `gcd(0, 0)` terminates).
func TestSDBFLAspectRatioHelper(t *testing.T) {
	for _, sample := range []struct {
		width    orderedNodeJSON
		height   orderedNodeJSON
		expected string
		ok       bool
	}{
		{nodeNumber(512), nodeNumber(768), "2:3", true},
		{nodeNumber(1000), nodeNumber(100), "233:100", true},
		{nodeNumber(100), nodeNumber(1000), "100:233", true},
		{nodeNumber(512), nodeNumber(0), "NaN:NaN", true},
		{nodeUndefined(), nodeNumber(768), "", false},
		{nodeNumber(512), nodeUndefined(), "", false},
	} {
		got, ok := sdBFLClosestAspectRatio(sample.width, sample.height)
		if ok != sample.ok {
			t.Fatalf("ratio for %v/%v reported ok=%v, want %v", sample.width.scalar, sample.height.scalar, ok, sample.ok)
		}
		if got != sample.expected {
			t.Fatalf("ratio = %q, want %q", got, sample.expected)
		}
	}
}

// sdWave5FixtureSanity fails loudly if the fixture's wave-5 rules lost their `times` bounds: without them
// the poll count would stop being fixture data and the replay would answer the poll with the submit rule.
func TestSDGenerateWave5FixtureKeepsTimedRules(t *testing.T) {
	fixture := loadSDWave5Oracle(t)
	for label, wantSteps := range map[string]int{
		"bflPendingThenReady":       4,
		"falaiInQueueThenCompleted": 5,
	} {
		scenario, present := fixture.Scenarios[label]
		if !present {
			t.Fatalf("%s is missing from the fixture", label)
		}
		if len(scenario.Outbound) != wantSteps {
			t.Fatalf("%s: recorded %d requests, want %d", label, len(scenario.Outbound), wantSteps)
		}
		timed := 0
		for _, rule := range scenario.Mocks {
			if rule.Times > 0 {
				timed++
			}
		}
		if timed < 2 {
			t.Fatalf("%s: only %d timed rule(s); the submit and the first poll must both be bounded", label, timed)
		}
	}
}
