package server

// Replay of tests/oracle/sillytavern-1.19.0-sd-zai.json, recorded by tools/probe-sd-zai.mjs, plus the
// LABELLED implementation tests this lane owes:
//
//	POST /api/sd/zai/generate         stable-diffusion.js:1880
//	POST /api/sd/zai/generate-video   stable-diffusion.js:1957
//
// This file is SELF-CONTAINED on purpose: it shares no helper with a sibling lane's test file, so the
// branch it lives on compiles against main alone. The peer replays the recorded rules with the probe
// stub's semantics (first substring match, `times`-bounded) and rewrites ONLY the hosts the route itself
// fetches as given — `media.example.test` — because the IMAGE route's hostname guard is the observation
// under test: rewriting those URLs onto 127.0.0.1 would make every refusal scenario fail for one trivial
// reason and none of them discriminate the apex or suffix traps.
//
// What the fixture can and cannot see, and why: the image route's SUCCESS path is not replayable. Its
// guard is `.z.ai`/`.ufileos.com` evaluated by the implementation, and no local listener can answer to a
// `.z.ai` name, so the fixture records the refusal and error branches only and counts the requests to
// prove a refused URL is never fetched. The video route's content fetch has no guard, so its whole success
// path is replayed here.

import (
	"context"
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

// sdZaiLabels is the scenario list this file is responsible for, spelled out so a renamed or dropped
// scenario fails here instead of silently shrinking the run.
var sdZaiLabels = []string{
	"zaiNoKey", "zaiSubmitNonOk", "zaiSubmitThrows", "zaiNoURL", "zaiInvalidURL",
	"zaiRefusedHost", "zaiRefusedApex", "zaiRefusedSuffixTrap", "zaiRefusedLabelInside",
	"zaiVideoNoKey", "zaiVideoSubmitNonOk", "zaiVideoSubmitThrows",
	"zaiVideoCompletedFirstPoll", "zaiVideoCompletedSecondPoll", "zaiVideoTaskFail",
	"zaiVideoPollNonOk", "zaiVideoNoURL", "zaiVideoContentNonOk", "zaiVideoReservedId", "zaiVideoNoId",
}

// sdZaiRefusalLabels are the scenarios whose WHOLE point is the request COUNT: a provider URL outside the
// hostname allowlist must never produce a second request.
var sdZaiRefusalLabels = []string{"zaiRefusedHost", "zaiRefusedApex", "zaiRefusedSuffixTrap", "zaiRefusedLabelInside"}

// sdZaiRewritableHost is the only host the replay peer owns. It is a host the VIDEO route fetches as given
// (no guard); the image route's provider URL is deliberately left as recorded.
const sdZaiRewritableHost = "media.example.test"

func loadSDZaiOracle(t *testing.T) sdGenerateFixture {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-sd-zai.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture sdGenerateFixture
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	if len(fixture.Scenarios) < len(sdZaiLabels) {
		t.Fatalf("the zai oracle records only %d scenarios, the replay needs %d", len(fixture.Scenarios), len(sdZaiLabels))
	}
	return fixture
}

// sdZaiTarget reduces a recorded URL to the wire target the peer observes: escaped path plus raw query.
// The hardcoded base is trimmed so the comparison is about the path the handler built; a provider URL
// keeps only its path, because its host belongs to the provider.
func sdZaiTarget(recorded string) string {
	remainder := strings.TrimPrefix(recorded, sdZaiDefaultURL)
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

type sdZaiPeer struct {
	server  *httptest.Server
	mu      sync.Mutex
	rules   []sdGenerateRule
	aliases map[string][]string
	usage   map[int]int
	seen    []sdZaiSeen
}

type sdZaiSeen struct {
	Method string
	Target string
	Header http.Header
	Body   string
}

func newSDZaiPeer(t *testing.T, scenario sdGenerateScenario) *sdZaiPeer {
	t.Helper()
	peer := &sdZaiPeer{usage: map[int]int{}, aliases: map[string][]string{}}
	peer.rules = append([]sdGenerateRule{}, scenario.Mocks...)
	for _, recorded := range scenario.Outbound {
		for _, rule := range peer.rules {
			if strings.Contains(recorded.URL, rule.Match) {
				peer.aliases[rule.Match] = append(peer.aliases[rule.Match], sdZaiTarget(recorded.URL))
			}
		}
	}
	peer.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := readAllString(r)
		target := r.URL.EscapedPath()
		if r.URL.RawQuery != "" {
			target += "?" + r.URL.RawQuery
		}
		peer.mu.Lock()
		peer.seen = append(peer.seen, sdZaiSeen{Method: r.Method, Target: target, Header: r.Header.Clone(), Body: body})
		var chosen *sdGenerateRule
		for index := range peer.rules {
			if peer.rules[index].Times > 0 && peer.usage[index] >= peer.rules[index].Times {
				continue
			}
			if !peer.matches(index, target) {
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
	// Only the host the route fetches as given is repointed at this listener.
	for index := range peer.rules {
		if !strings.Contains(peer.rules[index].Body, sdZaiRewritableHost) {
			continue
		}
		var document any
		if json.Unmarshal([]byte(peer.rules[index].Body), &document) != nil {
			continue
		}
		encoded, err := json.Marshal(rewriteSDZaiContentURL(document, peer.server.URL))
		if err != nil {
			continue
		}
		peer.rules[index].Body = string(encoded)
	}
	return peer
}

func rewriteSDZaiContentURL(value any, origin string) any {
	switch typed := value.(type) {
	case string:
		if strings.Contains(typed, sdZaiRewritableHost) {
			return origin + sdZaiTarget(typed)
		}
		return typed
	case []any:
		rewritten := make([]any, len(typed))
		for index, item := range typed {
			rewritten[index] = rewriteSDZaiContentURL(item, origin)
		}
		return rewritten
	case map[string]any:
		rewritten := make(map[string]any, len(typed))
		for key, item := range typed {
			rewritten[key] = rewriteSDZaiContentURL(item, origin)
		}
		return rewritten
	default:
		return value
	}
}

func (peer *sdZaiPeer) matches(index int, target string) bool {
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

func (peer *sdZaiPeer) summary() []string {
	peer.mu.Lock()
	defer peer.mu.Unlock()
	result := make([]string, 0, len(peer.seen))
	for _, entry := range peer.seen {
		result = append(result, entry.Method+" "+entry.Target)
	}
	return result
}

func sdZaiHandler(t *testing.T, scenario sdGenerateScenario) http.Handler {
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

// withFastZaiDelays collapses the three pinned cadences for the replay and restores them afterwards.
func withFastZaiDelays(t *testing.T) {
	t.Helper()
	previousRetry, previousBase, previousStep, previousSleep := sdZaiImageRetryInterval, sdZaiVideoPollBase, sdZaiVideoPollStep, sdZaiVideoSleep
	sdZaiImageRetryInterval = time.Millisecond
	sdZaiVideoPollBase = time.Millisecond
	sdZaiVideoPollStep = time.Millisecond
	sdZaiVideoSleep = func(_ context.Context, _ time.Duration) {}
	t.Cleanup(func() {
		sdZaiImageRetryInterval = previousRetry
		sdZaiVideoPollBase = previousBase
		sdZaiVideoPollStep = previousStep
		sdZaiVideoSleep = previousSleep
	})
}

// TestSDZaiCadencesArePinned pins the three cadences and the two attempt counts. They cannot be recorded
// in a fixture (wall clock does not cross that boundary), and a route that polled at the wrong cadence
// would behave nothing like pinned SillyTavern against the real provider while every replay stayed green.
func TestSDZaiCadencesArePinned(t *testing.T) {
	if sdZaiImageRetryInterval != 1000*time.Millisecond {
		t.Fatalf("image 404 retry interval = %s, pinned 1000ms", sdZaiImageRetryInterval)
	}
	if sdZaiVideoPollBase != 5000*time.Millisecond || sdZaiVideoPollStep != 1000*time.Millisecond {
		t.Fatalf("video poll cadence = %s + attempt*%s, pinned 5000ms + attempt*1000ms", sdZaiVideoPollBase, sdZaiVideoPollStep)
	}
	if sdZaiImageMaxAttempts != 5 {
		t.Fatalf("image attempts = %d, pinned 5", sdZaiImageMaxAttempts)
	}
	if sdZaiVideoMaxAttempts != 30 {
		t.Fatalf("video attempts = %d, pinned 30", sdZaiVideoMaxAttempts)
	}
}

// TestSDZaiSeamDefaults pins each seam default to the pinned literal.
func TestSDZaiSeamDefaults(t *testing.T) {
	for _, seam := range []struct {
		environment string
		accessor    func() string
	}{
		{"GOTAVERN_SD_ZAI_URL", sdZaiURL},
		{"GOTAVERN_SD_ZAI_VIDEO_URL", sdZaiVideoURL},
	} {
		t.Setenv(seam.environment, "")
		if got := seam.accessor(); got != sdZaiDefaultURL {
			t.Fatalf("%s seam default = %q, pinned %q", seam.environment, got, sdZaiDefaultURL)
		}
		t.Setenv(seam.environment, "http://127.0.0.1:9999/")
		if got := seam.accessor(); got != "http://127.0.0.1:9999" {
			t.Fatalf("%s override = %q, want the trailing slash trimmed", seam.environment, got)
		}
	}
}

func TestSDZaiRoutesMatchPinnedOracle(t *testing.T) {
	fixture := loadSDZaiOracle(t)
	withFastZaiDelays(t)
	for _, label := range sdZaiLabels {
		if _, present := fixture.Scenarios[label]; !present {
			t.Fatalf("the fixture does not record %q; the replay refuses to pass on a smaller set", label)
		}
	}
	statuses := map[int]int{}
	for _, label := range sdZaiLabels {
		label, scenario := label, fixture.Scenarios[label]
		t.Run(label, func(t *testing.T) {
			peer := newSDZaiPeer(t, scenario)
			t.Setenv("GOTAVERN_SD_ZAI_URL", peer.server.URL)
			t.Setenv("GOTAVERN_SD_ZAI_VIDEO_URL", peer.server.URL)
			handler := sdZaiHandler(t, scenario)
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
			// The request COUNT first, and named: for a refusal it is the observation, for the video route
			// it is the poll count.
			if len(peer.seen) != len(scenario.Outbound) {
				t.Fatalf("%s: peer received %d request(s), pinned %d (peer saw %v)", label, len(peer.seen), len(scenario.Outbound), peer.summary())
			}
			for index, recorded := range scenario.Outbound {
				seen := peer.seen[index]
				if seen.Method != recorded.Method {
					t.Fatalf("%s: request %d method = %s, pinned %s", label, index, seen.Method, recorded.Method)
				}
				if want := sdZaiTarget(recorded.URL); seen.Target != want {
					t.Fatalf("%s: request %d target = %q, pinned %q", label, index, seen.Target, want)
				}
				for _, name := range []string{"authorization", "content-type", "accept"} {
					present := len(seen.Header[http.CanonicalHeaderKey(name)]) > 0
					want, recordedPresent := recorded.Headers[name]
					if recordedPresent {
						if got := seen.Header.Get(name); got != want {
							t.Fatalf("%s: request %d header %q = %q, pinned %q", label, index, name, got, want)
						}
						continue
					}
					if present {
						t.Fatalf("%s: request %d sent header %q the pinned call does not send (%q)", label, index, name, seen.Header.Get(name))
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
		})
	}
	if statuses[200] == 0 || statuses[400] == 0 || statuses[500] == 0 {
		t.Fatalf("the zai scenarios do not cover the 200/400/500 branches: %+v", statuses)
	}
}

// TestSDZaiRefusalNeverFetchesTheProviderURL states the refusal contract on its own: exactly one outbound
// request (the submit), and it is the submit target. An implementation that fetched first and refused
// afterwards would answer the same 500 and be caught only here.
func TestSDZaiRefusalNeverFetchesTheProviderURL(t *testing.T) {
	fixture := loadSDZaiOracle(t)
	withFastZaiDelays(t)
	for _, label := range sdZaiRefusalLabels {
		scenario, present := fixture.Scenarios[label]
		if !present {
			t.Fatalf("%s is missing from the fixture", label)
		}
		if len(scenario.Outbound) != 1 {
			t.Fatalf("%s: the fixture must record exactly the submit, got %d requests", label, len(scenario.Outbound))
		}
		if !strings.HasSuffix(scenario.Outbound[0].URL, "/api/paas/v4/images/generations") {
			t.Fatalf("%s: the only request must be the submit, got %q", label, scenario.Outbound[0].URL)
		}
		peer := newSDZaiPeer(t, scenario)
		t.Setenv("GOTAVERN_SD_ZAI_URL", peer.server.URL)
		handler := sdZaiHandler(t, scenario)
		response := postSecretsRoute(t, handler, scenario.Route, scenario.RequestBody)
		if response.Code != http.StatusInternalServerError {
			t.Fatalf("%s: status = %d, want 500", label, response.Code)
		}
		if len(peer.seen) != 1 {
			t.Fatalf("%s: the provider URL was FETCHED (%v); a refused URL must never produce a second request", label, peer.summary())
		}
	}
}

// TestSDZaiVideoPollCountIsAFixtureProperty states the counts, so a loop that polls the wrong number of
// times fails with a message about the loop.
func TestSDZaiVideoPollCountIsAFixtureProperty(t *testing.T) {
	fixture := loadSDZaiOracle(t)
	one, two := fixture.Scenarios["zaiVideoCompletedFirstPoll"], fixture.Scenarios["zaiVideoCompletedSecondPoll"]
	if len(one.Outbound) != 3 || len(two.Outbound) != 4 {
		t.Fatalf("the fixture must record 3 and 4 requests, got %d and %d", len(one.Outbound), len(two.Outbound))
	}
	if one.Outbound[1].URL != two.Outbound[1].URL {
		t.Fatalf("both scenarios must poll the same URL, so only the COUNT differs (%q vs %q)", one.Outbound[1].URL, two.Outbound[1].URL)
	}
}

// TestSDZaiRecordedPollWaits keeps the pinned run's own timing evidence from rotting: the video scenarios
// with a poll must have spent a delay and the refusal branches must not have.
func TestSDZaiRecordedPollWaits(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-sd-zai.json"))
	if err != nil {
		t.Fatal(err)
	}
	var timing struct {
		Scenarios map[string]struct {
			ElapsedBucket string `json:"elapsedBucket"`
		} `json:"scenarios"`
	}
	if err := json.Unmarshal(raw, &timing); err != nil {
		t.Fatal(err)
	}
	for label, want := range map[string]string{
		"zaiRefusedHost": "under-4s", "zaiRefusedApex": "under-4s", "zaiRefusedSuffixTrap": "under-4s",
		"zaiVideoCompletedFirstPoll": "one-poll", "zaiVideoCompletedSecondPoll": "two-polls",
		"zaiVideoTaskFail": "one-poll", "zaiVideoPollNonOk": "one-poll",
	} {
		recorded, present := timing.Scenarios[label]
		if !present {
			t.Fatalf("%s is missing from the fixture", label)
		}
		if recorded.ElapsedBucket != want {
			t.Fatalf("%s: elapsedBucket = %q, want %q", label, recorded.ElapsedBucket, want)
		}
	}
}

// TestSDZaiImagePathExtension is a LABELLED SOURCE-DERIVED TABLE (AGENTS.md rule 4): the pinned expression
// is `path.extname(url.pathname).substring(1).toLowerCase() || 'png'`, and no fixture can observe it
// because reaching the image success path needs a `.z.ai` provider URL that a local peer cannot answer.
// The predicate is transcribed from the pinned source and stated as such, not presented as a capture.
func TestSDZaiImagePathExtension(t *testing.T) {
	for _, sample := range []struct {
		name     string
		expected string
	}{
		{"/one.png", "png"},
		{"/one.PNG", "png"},
		{"/dir/a.b.MP4", "mp4"},
		{"/noext", "png"},
		{"/trailing/", "png"},
		{"/.bashrc", "png"},
		{"/one.", "png"},
	} {
		if got := sdZaiPathExtension(sample.name); got != sample.expected {
			t.Fatalf("pathExtname(%q) = %q, want %q", sample.name, got, sample.expected)
		}
	}
}

// TestSDZaiVideoExhaustionIsAnImplementationTest is LABELLED: thirty polls at 5s..34s is 591 seconds, so
// parity was not recorded. The pinned observable IS reproduced — a bare 500 after the last poll — and the
// escalating schedule is asserted rather than waited for.
func TestSDZaiVideoExhaustionIsAnImplementationTest(t *testing.T) {
	previousSleep := sdZaiVideoSleep
	var mu sync.Mutex
	var requested []time.Duration
	sdZaiVideoSleep = func(_ context.Context, duration time.Duration) {
		mu.Lock()
		requested = append(requested, duration)
		mu.Unlock()
	}
	t.Cleanup(func() { sdZaiVideoSleep = previousSleep })

	polls := 0
	peer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.Method == http.MethodPost {
			_, _ = w.Write([]byte(`{"id":"job"}`))
			return
		}
		polls++
		_, _ = w.Write([]byte(`{"task_status":"PROCESSING"}`))
	}))
	t.Cleanup(peer.Close)
	t.Setenv("GOTAVERN_SD_ZAI_VIDEO_URL", peer.URL)

	handler := sdZaiHandler(t, sdGenerateScenario{
		Secrets: map[string][]map[string]any{"api_key_zai": {{"id": "sid", "value": "synthetic-zai-key", "active": true}}},
	})
	response := postSecretsRoute(t, handler, "/api/sd/zai/generate-video", `{"prompt":"a cat","model":"cogvideox-3"}`)

	if response.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", response.Code)
	}
	if response.Body.String() != "Internal Server Error" {
		t.Fatalf("body = %q, pinned %q", response.Body.String(), "Internal Server Error")
	}
	if polls != sdZaiVideoMaxAttempts {
		t.Fatalf("the loop polled %d times, pinned %d", polls, sdZaiVideoMaxAttempts)
	}
	if len(requested) != sdZaiVideoMaxAttempts {
		t.Fatalf("the loop asked for %d delays, pinned %d", len(requested), sdZaiVideoMaxAttempts)
	}
	for index, duration := range requested {
		want := time.Duration(5000+index*1000) * time.Millisecond
		if duration != want {
			t.Fatalf("delay %d = %v, pinned %v", index, duration, want)
		}
	}
}

// TestSDZaiVideoAbortIsAnImplementationTest is LABELLED: the pinned abort comes from
// `request.socket.on('close')`, which this suite cannot produce reliably through a probe. The sequence is
// still the pinned one — the abort is checked at the TOP of an iteration, so a submit that completed still
// happens, no poll follows, and the caller gets the pinned text.
func TestSDZaiVideoAbortIsAnImplementationTest(t *testing.T) {
	previousSleep := sdZaiVideoSleep
	var cancelOnce sync.Once
	var cancel context.CancelFunc
	// The caller vanishes DURING the first delay, which is the moment `request.socket.on('close')` fires on
	// the pinned server. The pinned abort check is at the TOP of an iteration, and the poll fetch carries no
	// abort signal, so the poll that was already due still happens and only the NEXT iteration notices.
	sdZaiVideoSleep = func(_ context.Context, _ time.Duration) {
		cancelOnce.Do(func() { cancel() })
	}
	t.Cleanup(func() { sdZaiVideoSleep = previousSleep })

	polls := 0
	peer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.Method == http.MethodPost {
			_, _ = w.Write([]byte(`{"id":"job"}`))
			return
		}
		polls++
		_, _ = w.Write([]byte(`{"task_status":"PROCESSING"}`))
	}))
	t.Cleanup(peer.Close)
	t.Setenv("GOTAVERN_SD_ZAI_VIDEO_URL", peer.URL)

	handler := sdZaiHandler(t, sdGenerateScenario{
		Secrets: map[string][]map[string]any{"api_key_zai": {{"id": "sid", "value": "synthetic-zai-key", "active": true}}},
	})
	request := httptest.NewRequest(http.MethodPost, "/api/sd/zai/generate-video", strings.NewReader(`{"prompt":"a cat"}`))
	request.Header.Set("Content-Type", "application/json")
	ctx, cancelFunc := context.WithCancel(request.Context())
	cancel = cancelFunc
	defer cancelFunc()
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request.WithContext(ctx))

	if recorder.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", recorder.Code)
	}
	if recorder.Body.String() != sdZaiVideoAbortedMessage {
		t.Fatalf("body = %q, pinned %q", recorder.Body.String(), sdZaiVideoAbortedMessage)
	}
	if polls != 1 {
		t.Fatalf("the loop polled %d time(s) after the disconnect; the pinned in-flight poll still happens and only the next iteration aborts", polls)
	}
}

// TestSDZaiImageRouteDoesNotAbortOnDisconnect is a LABELLED implementation test for the ABSENCE of a
// guard: the pinned image route has no socket-close handling at all, unlike its video sibling. A caller
// that vanished before the handler runs still gets the normal answer path rather than an abort message.
func TestSDZaiImageRouteDoesNotAbortOnDisconnect(t *testing.T) {
	peer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":[{"url":"https://images.example.test/one.png"}]}`))
	}))
	t.Cleanup(peer.Close)
	t.Setenv("GOTAVERN_SD_ZAI_URL", peer.URL)

	handler := sdZaiHandler(t, sdGenerateScenario{
		Secrets: map[string][]map[string]any{"api_key_zai": {{"id": "sid", "value": "synthetic-zai-key", "active": true}}},
	})
	request := httptest.NewRequest(http.MethodPost, "/api/sd/zai/generate", strings.NewReader(`{"prompt":"a tree"}`))
	request.Header.Set("Content-Type", "application/json")
	ctx, cancel := context.WithCancel(request.Context())
	cancel()
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request.WithContext(ctx))

	// The refusal branch answers a bare 500 with no abort text: there is no guard to fire.
	if recorder.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", recorder.Code)
	}
	if recorder.Body.String() != "Internal Server Error" {
		t.Fatalf("body = %q, want the bare status message (no abort handling on this route)", recorder.Body.String())
	}
}
