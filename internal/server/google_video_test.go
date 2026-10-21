package server

// Replay of tests/oracle/sillytavern-1.19.0-google-video.json, recorded by tools/probe-google-video.mjs,
// plus the TWO LABELLED IMPLEMENTATION TESTS this increment promised:
//
//   - the TIMEOUT branch cannot be recorded: thirty polls with `delay(5000 + attempt*1000)` is about ten
//     minutes of wall clock. Parity could not be observed, so the test below proves the IMPLEMENTATION
//     (thirty attempts, then the pinned message) and records the requested delays to pin the formula. The
//     probe deliberately does NOT shorten the delay, because that would record a behaviour the product
//     does not have.
//   - CANCELLATION is asserted from source for the same reason the Horde case was: the pinned route aborts
//     through `request.socket.on('close')`, and whether a destroyed socket produces that event on the
//     pinned server is not something this suite can rely on.
//
// The replay overrides `googleVideoSleep` so the suite does not spend eleven seconds per two-poll scenario.
// The delays affect WHEN the polls happen, not WHAT is recorded: the count, the order, the URLs, the
// bodies and the messages are all unchanged, and the fixture records the delay's effect as a bucket.

import (
	"context"
	"encoding/base64"
	"encoding/json"
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

func loadGoogleVideoOracle(t *testing.T) googleTTSFixture {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-google-video.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture googleTTSFixture
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	if len(fixture.Scenarios) < 12 {
		t.Fatalf("the google-video oracle records only %d scenarios", len(fixture.Scenarios))
	}
	return fixture
}

// writeGoogleVideoSecrets seeds the one API key the video scenarios need.
func writeGoogleVideoSecrets(t *testing.T, dataRoot, keyID, value string) {
	t.Helper()
	userRoot := filepath.Join(dataRoot, "default-user")
	if err := os.MkdirAll(userRoot, 0o755); err != nil {
		t.Fatal(err)
	}
	payload := map[string]any{keyID: []map[string]any{{
		"id": keyID + "-0", "value": value, "label": keyID, "active": true,
	}}}
	encoded, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(userRoot, "secrets.json"), encoded, 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestGoogleVideoMatchesPinnedOracle(t *testing.T) {
	fixture := loadGoogleVideoOracle(t)
	previousSleep := googleVideoSleep
	googleVideoSleep = func(ctx context.Context, duration time.Duration) bool { return true }
	t.Cleanup(func() { googleVideoSleep = previousSleep })

	names := make([]string, 0, len(fixture.Scenarios))
	for name := range fixture.Scenarios {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		scenario := fixture.Scenarios[name]
		t.Run(name, func(t *testing.T) {
			peer := newGoogleTTSPeer(t, scenario.Mocks)
			// A provider-supplied URI cannot point at the peer by itself: the recorded payload is rewritten
			// to the peer origin, and googleTTSPath keeps the comparison on the path the route chose.
			for index := range peer.mocks {
				if peer.mocks[index].BinaryBody {
					// The peer writes a mock body as a STRING, so a binary mock recorded as base64 must be
					// decoded here; otherwise the route would base64-encode the base64 text and the digest
					// would differ for a reason the product never causes.
					if decoded, err := base64.StdEncoding.DecodeString(peer.mocks[index].Body); err == nil {
						peer.mocks[index].Body = string(decoded)
					}
				}
				if strings.Contains(peer.mocks[index].Body, "video.example.test/one.mp4") {
					peer.mocks[index].Body = strings.ReplaceAll(peer.mocks[index].Body,
						"https://video.example.test/one.mp4", peer.server.URL+"/one.mp4")
				}
			}
			t.Setenv("GOTAVERN_GOOGLE_MAKERSUITE_URL", peer.server.URL)
			t.Setenv("GOTAVERN_GOOGLE_VERTEX_URL", peer.server.URL)
			t.Setenv("GOTAVERN_GOOGLE_VERTEX_GLOBAL_URL", peer.server.URL)
			t.Setenv("GOTAVERN_GOOGLE_OAUTH_URL", peer.server.URL)
			dataRoot := t.TempDir()
			handler := NewHTTPHandlerWithOptions(HTTPHandlerOptions{InstallRoot: dataRoot, DataRoot: dataRoot, DisableCSRF: true})
			writeGoogleTTSSecrets(t, dataRoot, scenario.Secrets)
			response := postSecretsRoute(t, handler, scenario.Route, requestBodyForPeer(t, scenario.RequestBody, peer))

			if response.Code != scenario.Response.Status {
				t.Fatalf("status = %d, pinned %d (body %q)", response.Code, scenario.Response.Status, response.Body.String())
			}
			if normalizeGoogleSeed(response.Body.String()) != normalizeGoogleSeed(scenario.Response.BodyText) {
				t.Fatalf("body = %q, pinned %q", response.Body.String(), scenario.Response.BodyText)
			}
			if got, want := response.Header().Get("Content-Type"), scenario.Response.Headers["content-type"]; got != want {
				t.Fatalf("content type = %q, pinned %q", got, want)
			}
			// THE POLL COUNT is compared explicitly: it is the only thing that discriminates a
			// cache-like shortcut from the real loop.
			if len(peer.seen) != len(scenario.Outbound) {
				t.Fatalf("outbound requests = %d, pinned %d (the poll count is behaviour)", len(peer.seen), len(scenario.Outbound))
			}
			for index, recorded := range scenario.Outbound {
				actual := peer.seen[index]
				if actual.Method != recorded.Method {
					t.Fatalf("request %d method = %s, pinned %s", index, actual.Method, recorded.Method)
				}
				if target := googleTTSPath(t, recorded.URL); actual.URL != target {
					t.Fatalf("request %d target = %q, pinned %q", index, actual.URL, target)
				}
				if normalizeGoogleSeed(actual.Body) != recorded.Body {
					t.Fatalf("request %d body = %q, pinned %q", index, actual.Body, recorded.Body)
				}
				for _, header := range []string{"authorization", "x-goog-api-key", "content-type"} {
					if got, want := actual.Headers[header], recorded.Headers[header]; got != want {
						t.Fatalf("request %d header %s = %q, pinned %q", index, header, got, want)
					}
				}
			}
		})
	}
}

// TestGoogleVideoPollCountIsAFixtureProperty states the count explicitly, so a shortcut that skips a poll
// fails here with a message about the loop rather than as an opaque request-count mismatch.
func TestGoogleVideoPollCountIsAFixtureProperty(t *testing.T) {
	fixture := loadGoogleVideoOracle(t)
	onePoll := fixture.Scenarios["vertexDoneFirstPoll"]
	twoPolls := fixture.Scenarios["vertexDoneSecondPoll"]
	if len(onePoll.Outbound) != 2 || len(twoPolls.Outbound) != 3 {
		t.Fatalf("the fixture must record 2 requests for one poll and 3 for two, got %d and %d",
			len(onePoll.Outbound), len(twoPolls.Outbound))
	}
	if onePoll.Outbound[1].URL != twoPolls.Outbound[1].URL {
		t.Fatal("both scenarios must poll the same endpoint, so only the COUNT differs")
	}
}

// TestGoogleVideoTimeoutIsAnImplementationTest is LABELLED: parity could not be observed (thirty polls
// with escalating delays is about ten minutes of wall clock). It proves the implementation instead, and
// it pins the delay FORMULA by recording what the loop asks for rather than by waiting.
func TestGoogleVideoTimeoutIsAnImplementationTest(t *testing.T) {
	previousSleep := googleVideoSleep
	var mu sync.Mutex
	requested := make([]time.Duration, 0, 40)
	googleVideoSleep = func(ctx context.Context, duration time.Duration) bool {
		mu.Lock()
		requested = append(requested, duration)
		mu.Unlock()
		return true
	}
	t.Cleanup(func() { googleVideoSleep = previousSleep })

	var mu2 sync.Mutex
	createCount := 0
	pollCount := 0
	peer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if strings.Contains(r.URL.Path, "predictLongRunning") {
			mu2.Lock()
			createCount++
			mu2.Unlock()
			_, _ = w.Write([]byte(`{"name":"operations/never-finishes"}`))
			return
		}
		mu2.Lock()
		pollCount++
		mu2.Unlock()
		_, _ = w.Write([]byte(`{"done":false}`))
	}))
	t.Cleanup(peer.Close)
	t.Setenv("GOTAVERN_GOOGLE_MAKERSUITE_URL", peer.URL)
	t.Setenv("GOTAVERN_GOOGLE_VERTEX_URL", peer.URL)
	t.Setenv("GOTAVERN_GOOGLE_VERTEX_GLOBAL_URL", peer.URL)

	dataRoot := t.TempDir()
	handler := NewHTTPHandlerWithOptions(HTTPHandlerOptions{InstallRoot: dataRoot, DataRoot: dataRoot, DisableCSRF: true})
	writeGoogleVideoSecrets(t, dataRoot, "api_key_makersuite", "synthetic-makersuite-key")
	response := postSecretsRoute(t, handler, "/api/google/generate-video", `{"prompt":"a cat","model":"veo-3.1-generate-preview"}`)

	if response.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", response.Code)
	}
	if response.Body.String() != "Video generation timed out" {
		t.Fatalf("body = %q, pinned %q", response.Body.String(), "Video generation timed out")
	}
	if pollCount != 30 {
		t.Fatalf("the loop polled %d times, pinned 30", pollCount)
	}
	if createCount != 1 {
		t.Fatalf("the loop created %d jobs, pinned 1", createCount)
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

// TestGoogleVideoCancellationIsAnImplementationTest is LABELLED for the same reason the Horde cancel case
// was: the pinned route aborts through `request.socket.on('close')`, and the parity leg (destroying a raw
// socket) is not something this suite can depend on. The abort ANSWER is asserted from source, and the
// disconnect is simulated at the moment the client would vanish: during the first delay.
func TestGoogleVideoCancellationIsAnImplementationTest(t *testing.T) {
	var cancel context.CancelFunc
	previousSleep := googleVideoSleep
	googleVideoSleep = func(ctx context.Context, duration time.Duration) bool {
		if cancel != nil {
			cancel()
		}
		return false
	}
	t.Cleanup(func() { googleVideoSleep = previousSleep })

	peer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if strings.Contains(r.URL.Path, "predictLongRunning") {
			_, _ = w.Write([]byte(`{"name":"operations/never-finishes"}`))
			return
		}
		_, _ = w.Write([]byte(`{"done":false}`))
	}))
	t.Cleanup(peer.Close)
	t.Setenv("GOTAVERN_GOOGLE_MAKERSUITE_URL", peer.URL)
	t.Setenv("GOTAVERN_GOOGLE_VERTEX_URL", peer.URL)
	t.Setenv("GOTAVERN_GOOGLE_VERTEX_GLOBAL_URL", peer.URL)

	dataRoot := t.TempDir()
	handler := NewHTTPHandlerWithOptions(HTTPHandlerOptions{InstallRoot: dataRoot, DataRoot: dataRoot, DisableCSRF: true})
	writeGoogleVideoSecrets(t, dataRoot, "api_key_makersuite", "synthetic-makersuite-key")

	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/api/google/generate-video", strings.NewReader(`{"prompt":"a cat"}`))
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

	// The SECOND abort site is the loop's entry check, and this case is DETERMINISTIC: the caller is
	// cancelled BEFORE the handler runs, so the create happens with a caller that is already gone. That is
	// the sequence CI exposed; on this host it was hidden because the cancellation happened to land after
	// the create had completed. The pinned route does NOT bind its create to the disconnect signal -- it
	// checks the controller only inside the loop -- so the create completes and the loop answers the abort
	// message. An implementation that lets the disconnect abort the create answers the generic catch message
	// instead, which is the defect this case catches on EVERY host.
	secondRecorder := httptest.NewRecorder()
	secondRequest := httptest.NewRequest(http.MethodPost, "/api/google/generate-video", strings.NewReader(`{"prompt":"a cat"}`))
	secondRequest.Header.Set("Content-Type", "application/json")
	secondCtx, secondCancel := context.WithCancel(secondRequest.Context())
	secondCancel()
	handler.ServeHTTP(secondRecorder, secondRequest.WithContext(secondCtx))
	if secondRecorder.Code != http.StatusInternalServerError {
		t.Fatalf("second status = %d, want 500", secondRecorder.Code)
	}
	if secondRecorder.Body.String() != "Video generation aborted by client" {
		t.Fatalf("second body = %q, pinned %q", secondRecorder.Body.String(), "Video generation aborted by client")
	}

	// The THIRD site is the create's own error path: the caller is gone AND the create fails, so the abort
	// answer must win over the generic catch message. The caller is gone either way, so this is deliberately
	// the abort answer rather than the generic one -- a caller that has vanished cannot read either, and
	// making it explicit is what removes the timing window.
	failing := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{"error":{"message":"create failed"}}`))
	}))
	t.Cleanup(failing.Close)
	t.Setenv("GOTAVERN_GOOGLE_MAKERSUITE_URL", failing.URL)
	t.Setenv("GOTAVERN_GOOGLE_VERTEX_URL", failing.URL)
	t.Setenv("GOTAVERN_GOOGLE_VERTEX_GLOBAL_URL", failing.URL)
	thirdRecorder := httptest.NewRecorder()
	thirdRequest := httptest.NewRequest(http.MethodPost, "/api/google/generate-video", strings.NewReader(`{"prompt":"a cat"}`))
	thirdRequest.Header.Set("Content-Type", "application/json")
	thirdCtx, thirdCancel := context.WithCancel(thirdRequest.Context())
	thirdCancel()
	handler.ServeHTTP(thirdRecorder, thirdRequest.WithContext(thirdCtx))
	if thirdRecorder.Code != http.StatusInternalServerError {
		t.Fatalf("third status = %d, want 500", thirdRecorder.Code)
	}
	// A provider-STATUS failure answers the provider message even with the caller gone, because the pinned
	// controller is only consulted inside the poll loop. Asserting the abort message here would have been a
	// stronger-than-pinned expectation, which is a test defect rather than a product one.
	if thirdRecorder.Body.String() != "Video generation request failed" {
		t.Fatalf("third body = %q, pinned %q", thirdRecorder.Body.String(), "Video generation request failed")
	}

	// The FOURTH site is the create TRANSPORT error path, which the pinned catch would answer generically
	// but which must answer the abort message when the caller has gone. A port with no listener produces the
	// transport failure deterministically, so this needs no timing at all.
	t.Setenv("GOTAVERN_GOOGLE_MAKERSUITE_URL", "http://127.0.0.1:1")
	t.Setenv("GOTAVERN_GOOGLE_VERTEX_URL", "http://127.0.0.1:1")
	t.Setenv("GOTAVERN_GOOGLE_VERTEX_GLOBAL_URL", "http://127.0.0.1:1")
	fourthRecorder := httptest.NewRecorder()
	fourthRequest := httptest.NewRequest(http.MethodPost, "/api/google/generate-video", strings.NewReader(`{"prompt":"a cat"}`))
	fourthRequest.Header.Set("Content-Type", "application/json")
	fourthCtx, fourthCancel := context.WithCancel(fourthRequest.Context())
	fourthCancel()
	handler.ServeHTTP(fourthRecorder, fourthRequest.WithContext(fourthCtx))
	if fourthRecorder.Code != http.StatusInternalServerError {
		t.Fatalf("fourth status = %d, want 500", fourthRecorder.Code)
	}
	if fourthRecorder.Body.String() != "Video generation aborted by client" {
		t.Fatalf("fourth body = %q, pinned %q", fourthRecorder.Body.String(), "Video generation aborted by client")
	}
}
