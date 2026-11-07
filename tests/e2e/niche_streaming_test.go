package e2e

// NICHE STREAMING TORTURE (alpha.17; domain IDs SSE-001..SSE-004).
//
// The route under test is the real production path: the shipped binary, POST /api/backends/chat-completions/
// generate with the recorded DEEPSEEK streaming driver body, the PRODUCTION transport, and tests/mockprovider
// as the provider. The mock writes each `Stream` entry as one chunked-transfer frame, so a case can control
// the UPSTREAM CHUNK BOUNDARIES exactly: one SSE frame split across three chunks, several frames in one
// chunk, a UTF-8 rune split between two chunks, a CRLF pair split between two chunks, multiline data with a
// comment and an event id, and an invalid-JSON data payload.
//
// THE CONTRACT IS BYTE TRANSPARENCY. forwardPinnedChatCompletionStream (internal/server/chat_completions.go:
// 294-349) pipes the provider body with a 32 KiB copy buffer and does not parse or re-frame it, so whatever
// the provider wrote must arrive at the browser in the same order and with the same bytes. A route that
// implemented its own SSE parser would pass a status-only check and fail nicheCheckStreamBytes here.
//
// CANCEL CONTRACT. Pinned's `request.socket.on('close', () => controller.abort())` means a browser disconnect
// must abort the UPSTREAM request; the recording peer observes it as ClientDisconnected. A client that only
// closes its own body would leave the provider generating (and billing) a reply nobody reads, so this case
// asserts the peer's observation rather than the absence of an error downstream.
//
// GOROUTINE SCOPE. The server is a SUBPROCESS, so runtime.NumGoroutine() can only speak about the TEST
// process (the HTTP client and its transport goroutines). Server-side release is covered by two observable
// halves -- the peer's ClientDisconnected and the server still serving after the cancel -- and the limitation
// is recorded in the evidence document instead of being overstated.

import (
	"context"
	"io"
	"net/http"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/cocokoishi/gotavern/tests/mockprovider"
)

// nicheStreamPOST sends the recorded streaming driver body and returns the live HTTP response (the caller
// owns the body). Failure to send is fatal.
func nicheStreamPOST(t *testing.T, client *session, driverBody string, ctx context.Context) *http.Response {
	t.Helper()
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, client.origin+generateRoute, strings.NewReader(driverBody))
	if err != nil {
		t.Fatalf("build the streaming generate request: %v", err)
	}
	request.Header.Set("Content-Type", "application/json")
	if client.cookie != "" {
		request.Header.Set("Cookie", client.cookie)
	}
	if client.token != "" {
		request.Header.Set("X-CSRF-Token", client.token)
	}
	response, err := client.client.Do(request)
	if err != nil {
		t.Fatalf("POST %s (stream): %v", generateRoute, err)
	}
	return response
}

// SSE-001: upstream chunk boundaries are transparent, and invalid/missing-DONE streams are forwarded
// verbatim (no terminal sentinel is invented). One boot, one positional recorder script: request N is
// answered by response N, so every leg asserts the request count it expects.
func TestNicheStreamingChunkBoundariesAndFrameContentAreByteExact(t *testing.T) {
	fixture := loadProviderWireFixture(t)
	streamScenario := fixture.scenario(t, "deepseek-stream")
	seam := deepSeekSeam(t, streamScenario)
	driverBody := streamScenario.driverBody(t, "deepseek-stream")

	splitFrame := "data: {\"text\":\"split frame\"}\n\n"
	multiFrames := "data: {\"n\":1}\n\ndata: {\"n\":2}\n\n"
	unicodeFrame := "data: {\"text\":\"h\u00e9llo \U0001F680\"}\n\n"
	crlfFrame := "data: {\"crlf\":true}\r\n\r\n"
	multilineFrame := ": comment frame\nid: 7\ndata: line-one\ndata: line-two\n\n"
	invalidFrame := "data: not-json\n\ndata: \n\ndata: {\"valid\":1}\n\n"

	splitFrameAt := len(splitFrame) / 2
	crlfSplitAt := strings.Index(crlfFrame, "\r\n")
	if crlfSplitAt < 0 {
		t.Fatal("the CRLF frame has no CRLF, so this case could not split it")
	}
	unicodeSplitAt := strings.Index(unicodeFrame, "\u00e9")
	if unicodeSplitAt < 0 {
		t.Fatal("the unicode frame does not contain the rune this case splits")
	}

	connectionClose := mockprovider.Header{Name: "Connection", Value: "close"}
	eventStreamHeaders := []mockprovider.Header{
		{Name: "Content-Type", Value: "text/event-stream"},
		connectionClose,
	}
	legs := []struct {
		label    string
		chunks   []string
		expected string
	}{
		{"frame split across three chunks", []string{splitFrame[:splitFrameAt], splitFrame[splitFrameAt : splitFrameAt+3], splitFrame[splitFrameAt+3:]}, splitFrame},
		{"two frames in one chunk", []string{multiFrames}, multiFrames},
		{"UTF-8 rune split between chunks", []string{unicodeFrame[:unicodeSplitAt+1], unicodeFrame[unicodeSplitAt+1:]}, unicodeFrame},
		{"CRLF split between chunks", []string{crlfFrame[:crlfSplitAt+1], crlfFrame[crlfSplitAt+1:]}, crlfFrame},
		{"multiline data, comment and event id", []string{multilineFrame}, multilineFrame},
		{"invalid JSON and empty data payloads", []string{invalidFrame}, invalidFrame},
	}
	responses := make([]mockprovider.Response, 0, len(legs))
	for range legs {
		responses = append(responses, mockprovider.Response{Status: http.StatusOK, Headers: eventStreamHeaders, Stream: nil})
	}
	// Fill the scripted chunks per leg (index-aligned with legs).
	for index, leg := range legs {
		responses[index].Stream = append([]string(nil), leg.chunks...)
	}
	recorder := mockprovider.New(responses)
	peer, err := recorder.Listen(0)
	if err != nil {
		t.Fatalf("start the recording peer: %v", err)
	}
	t.Cleanup(func() { _ = recorder.Close() })

	tree := newNicheTree(t)
	booted := tree.boot(t, map[string]string{seam: "http://" + peer.String()})
	writeSecret(t, booted.client, deepSeekSecretKey, syntheticDeepSeekKey)
	client := booted.client

	for index, leg := range legs {
		response := nicheStreamPOST(t, client, driverBody, context.Background())
		body, readErr := io.ReadAll(response.Body)
		_ = response.Body.Close()
		if readErr != nil {
			t.Fatalf("%s: read the streamed answer: %v", leg.label, readErr)
		}
		if err := nicheCheckStatus(leg.label, response.StatusCode, http.StatusOK); err != nil {
			t.Fatalf("%v", err)
		}
		if err := nicheCheckStreamBytes(leg.label, string(body), leg.expected); err != nil {
			t.Fatalf("%v", err)
		}
		recorded := recorder.Recording().Requests
		if len(recorded) != index+1 {
			t.Fatalf("%s: the peer received %d requests, want %d: each leg must make exactly one provider call",
				leg.label, len(recorded), index+1)
		}
		if recorded[index].BodySHA256 == "" {
			t.Fatalf("%s: the peer recorded no body digest, so the request was not the production transport's", leg.label)
		}
	}

	// The last leg's payload deliberately has no [DONE]. Assert the route did not invent a terminal sentinel:
	// the exact-byte comparison above already forbids extra bytes, and this names the property so a failure
	// says which contract broke.
	last := legs[len(legs)-1]
	if err := nicheCheckNotContains("missing [DONE] is not synthesised", last.expected, "[DONE]"); err != nil {
		t.Fatalf("the fixture itself contains [DONE]; the assertion would be vacuous: %v", err)
	}
}

// SSE-002: a provider that dies mid-stream leaves the downstream response OPEN (pinned's pipe() does not
// forward the source error and never ends the response) and the bytes received so far are delivered. The
// case cancels the browser side, which is the only thing that ends pinned's response, and asserts the
// partial bytes are an exact PREFIX of the provider's bytes -- not a re-framed or invented ending.
func TestNicheStreamingUpstreamTruncationForwardsPartialBytesThenEndsOnCancel(t *testing.T) {
	fixture := loadProviderWireFixture(t)
	streamScenario := fixture.scenario(t, "deepseek-stream")
	seam := deepSeekSeam(t, streamScenario)
	driverBody := streamScenario.driverBody(t, "deepseek-stream")
	partial := "data: {\"delta\":\"partial output\"}\n\n"

	recorder := mockprovider.New([]mockprovider.Response{{
		Status:              http.StatusOK,
		Headers:             []mockprovider.Header{{Name: "Content-Type", Value: "text/event-stream"}, {Name: "Connection", Value: "close"}},
		Stream:              []string{partial},
		TruncateAfterFrames: true,
	}})
	peer, err := recorder.Listen(0)
	if err != nil {
		t.Fatalf("start the recording peer: %v", err)
	}
	t.Cleanup(func() { _ = recorder.Close() })

	tree := newNicheTree(t)
	booted := tree.boot(t, map[string]string{seam: "http://" + peer.String()})
	writeSecret(t, booted.client, deepSeekSecretKey, syntheticDeepSeekKey)
	ctx, cancel := context.WithCancel(context.Background())
	response := nicheStreamPOST(t, booted.client, driverBody, ctx)

	received := make([]byte, len(partial))
	if _, err := io.ReadFull(response.Body, received); err != nil {
		cancel()
		_ = response.Body.Close()
		t.Fatalf("the downstream route did not forward the provider's partial frame: %v", err)
	}
	if err := nicheCheckStreamBytes("truncated stream prefix", string(received), partial); err != nil {
		cancel()
		_ = response.Body.Close()
		t.Fatalf("%v", err)
	}

	// The provider is gone; pinned keeps the response open until the caller disconnects. Cancel and require
	// the read to terminate inside a bounded window (a hang here is the pinned defect this route reproduces,
	// but the TEST must not hang).
	cancel()
	remainder := make(chan []byte, 1)
	go func() {
		body, _ := io.ReadAll(response.Body)
		_ = response.Body.Close()
		remainder <- body
	}()
	select {
	case extra := <-remainder:
		if len(extra) != 0 {
			t.Fatalf("after cancelling, the route wrote %d more byte(s) (%q); no background writes may follow a client cancel",
				len(extra), truncateForLog(string(extra), 120))
		}
	case <-time.After(10 * time.Second):
		t.Fatalf("the response did not terminate within 10s of the client cancelling a truncated provider stream; the case would otherwise hang on the pinned behaviour it is measuring")
	}
	// The server must still be serving after the cancel.
	status, _, body := booted.client.postJSON(t, "/api/settings/get", "{}")
	if err := nicheCheckStatus("server alive after truncation cancel", status, 200); err != nil {
		t.Fatalf("%v: %s", err, truncateForLog(body, 160))
	}
}

// SSE-003: a client cancel reaches the PROVIDER. The peer holds the response open (NeverEnds) and records
// ClientDisconnected when the caller goes away; the assertion is on that observation, plus no test-process
// goroutine leak and continued server liveness.
func TestNicheStreamingClientCancelAbortsTheUpstreamRequest(t *testing.T) {
	fixture := loadProviderWireFixture(t)
	streamScenario := fixture.scenario(t, "deepseek-stream")
	seam := deepSeekSeam(t, streamScenario)
	driverBody := streamScenario.driverBody(t, "deepseek-stream")
	held := "data: {\"held\":true}\n\n"

	recorder := mockprovider.New([]mockprovider.Response{{
		Status:    http.StatusOK,
		Headers:   []mockprovider.Header{{Name: "Content-Type", Value: "text/event-stream"}, {Name: "Connection", Value: "close"}},
		NeverEnds: true,
	}})
	peer, err := recorder.Listen(0)
	if err != nil {
		t.Fatalf("start the recording peer: %v", err)
	}
	t.Cleanup(func() { _ = recorder.Close() })

	tree := newNicheTree(t)
	booted := tree.boot(t, map[string]string{seam: "http://" + peer.String()})
	writeSecret(t, booted.client, deepSeekSecretKey, syntheticDeepSeekKey)
	before := runtime.NumGoroutine()

	ctx, cancel := context.WithCancel(context.Background())
	response := nicheStreamPOST(t, booted.client, driverBody, ctx)
	prefix := make([]byte, len(held))
	if _, err := io.ReadFull(response.Body, prefix); err != nil {
		cancel()
		_ = response.Body.Close()
		t.Fatalf("the held-open stream delivered no frame: %v", err)
	}
	if err := nicheCheckStreamBytes("held frame", string(prefix), held); err != nil {
		cancel()
		_ = response.Body.Close()
		t.Fatalf("%v", err)
	}
	cancel()
	_ = response.Body.Close()

	observed := false
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		requests := recorder.Recording().Requests
		flags := make([]string, 0, len(requests))
		for _, request := range requests {
			if request.ClientDisconnected {
				flags = append(flags, "disconnected")
			}
		}
		if len(requests) > 0 && len(flags) > 0 {
			if err := nicheCheckCancelPropagation("client cancel", flags, true); err != nil {
				t.Fatalf("%v", err)
			}
			observed = true
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if !observed {
		t.Fatalf("cancel-not-propagated: the peer never observed the client disconnect within 15s; pinned's socket-close -> abort contract is broken or the mock cannot see it")
	}

	// No test-process goroutine leak: bounded poll, then the named comparator.
	leaked := true
	for deadline := time.Now().Add(10 * time.Second); time.Now().Before(deadline); {
		after := runtime.NumGoroutine()
		if downturn := after - before; downturn <= 12 {
			if err := nicheCheckGoroutines("client cancel", before, after, 12); err != nil {
				t.Fatalf("%v", err)
			}
			leaked = false
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if leaked {
		if err := nicheCheckGoroutines("client cancel", before, runtime.NumGoroutine(), 12); err != nil {
			t.Fatalf("%v", err)
		}
	}

	// The server is still alive and answers after the aborted stream.
	status, _, body := booted.client.postJSON(t, "/api/settings/get", "{}")
	if err := nicheCheckStatus("server alive after cancel", status, 200); err != nil {
		t.Fatalf("%v: %s", err, truncateForLog(body, 160))
	}
}

// SSE-004: an upstream HTTP error on a STREAMING request is forwarded with its status and body. Pinned's
// forwardFetchResponse writes the provider's status (401 is rewritten to 400 so a streamed reply cannot reset
// the browser's Basic Auth prompt) and pipes the body; a route that turned this into 200 {error:true} would
// hide the provider's own error from the frontend.
func TestNicheStreamingUpstreamErrorStatusIsForwarded(t *testing.T) {
	fixture := loadProviderWireFixture(t)
	streamScenario := fixture.scenario(t, "deepseek-stream")
	seam := deepSeekSeam(t, streamScenario)
	driverBody := streamScenario.driverBody(t, "deepseek-stream")
	upstreamBody := `{"error":"upstream-down"}`

	recorder := mockprovider.New([]mockprovider.Response{{
		Status:  http.StatusServiceUnavailable,
		Headers: []mockprovider.Header{{Name: "Content-Type", Value: "application/json"}},
		Body:    upstreamBody,
	}})
	peer, err := recorder.Listen(0)
	if err != nil {
		t.Fatalf("start the recording peer: %v", err)
	}
	t.Cleanup(func() { _ = recorder.Close() })

	tree := newNicheTree(t)
	booted := tree.boot(t, map[string]string{seam: "http://" + peer.String()})
	writeSecret(t, booted.client, deepSeekSecretKey, syntheticDeepSeekKey)
	response := nicheStreamPOST(t, booted.client, driverBody, context.Background())
	body, readErr := io.ReadAll(response.Body)
	_ = response.Body.Close()
	if readErr != nil {
		t.Fatalf("read the upstream-error answer: %v", readErr)
	}
	if err := nicheCheckStatus("streaming upstream 503", response.StatusCode, http.StatusServiceUnavailable); err != nil {
		t.Fatalf("%v (body %s)", err, truncateForLog(string(body), 200))
	}
	if err := nicheCheckBody("streaming upstream 503", string(body), upstreamBody); err != nil {
		t.Fatalf("%v", err)
	}
	requests := recorder.Recording().Requests
	if len(requests) != 1 {
		t.Fatalf("the peer received %d requests, want 1", len(requests))
	}
}
