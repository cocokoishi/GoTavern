package e2e

// STREAMING AND CANCELLATION, MEASURED ON REAL SOCKETS (alpha.18 lane).
//
// The alpha.17 coverage compared SSE TEXT. That cannot see the properties this file exists for: a
// frame split across TCP writes, a rune split across TCP writes, a coalesced chunk, a clean end with no
// [DONE], a provider that dies inside a frame, a provider that stops talking, a browser cancel, a
// browser disconnect, a slow reader, and N simultaneous cancels. Each case here drives the REAL route
// (POST /api/backends/chat-completions/generate) through a real net/http server on a real TCP socket,
// with a real TCP provider peer, and asserts socket, goroutine and connection facts rather than
// ctx.Err() on a synthetic writer.
//
// WHY IN-PROCESS, AND WHY IN THIS PACKAGE: the server is httptest.NewServer(server.
// NewHTTPHandlerWithOptions(...)) rather than a subprocess, so runtime.NumGoroutine() covers the ROUTE
// HANDLER, the OUTBOUND TRANSPORT and the MOCK PROVIDER's connection handlers in one number; the other
// files in this package start a subprocess and can only count the HTTP client's goroutines.
//
// It lives in tests/e2e rather than internal/server on purpose, and that is a measurement constraint
// rather than a style choice: internal/server's test binary pins GOTAVERN_OUTBOUND_WIRE_EXACT=1 in its
// TestMain (transport_mode_test.go) so the provider-wire replay can compare pinned's exact request
// bytes. A streaming test in that package would therefore exercise the ORACLE-ONLY raw client -- no
// connection pool, no response decoding, and a cancellation mechanism that is a goroutine closing the
// socket on ctx.Done -- and a defect in the PRODUCTION client's cancellation would stay invisible while
// the suite went green. requireProductionTransport below makes that failure impossible to repeat.
//
// PROVIDER PEER: tests/mockprovider is the peer wherever a static script can express the case (a
// scripted Stream is written one chunked-transfer frame per entry, i.e. one TCP write boundary per
// entry). Three cases cannot be expressed by it -- a per-connection DISTINGUISHABLE held frame
// (cross-talk), a response head followed by no bytes at all (stall), and a byte counter that proves the
// server stopped draining (backpressure) -- so those use a ~100-line raw TCP peer in this file rather
// than changing the shared harness.
//
// FD COUNTING: on windows/arm64 this repository has no in-process handle-count facility (no x/sys
// dependency is allowed), so file-descriptor counting is NOT claimed. What is asserted instead, honestly:
//   - downstream sockets: the net/http Server's ConnState hook counts accepted and closed connections,
//     so opened == closed is a real server-side socket fact;
//   - upstream sockets: the provider peer reports EOF/close on the connection it is holding open, which
//     is the provider-observable half of pinned's `request.socket.on('close', () => controller.abort())`
//     contract (chat-completions.js:241-244) and of forwardFetchResponse's `from.body.destroy()`
//     (src/util.js:765-769);
//   - goroutines: runtime.NumGoroutine() with a named baseline and a deadline, never a bare sleep.
//
// PINNED ORACLE for the truncation case: tests/oracle/sillytavern-1.19.0-provider-wire.json records
// openai-reverse-proxy-midstream-truncation with driverTimedOut:true and both delivered frames, i.e.
// pinned pipes the partial bytes and NEVER ends the browser response until the client disconnects. The
// test below asserts exactly that observable (and the bounded unwinding on cancel), not an invented
// terminal error frame.

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/cocokoishi/gotavern/internal/outbound"
	"github.com/cocokoishi/gotavern/internal/server"
	"github.com/cocokoishi/gotavern/tests/mockprovider"
)

// streamingGenerateRoute is the compatibility surface. The literal is repeated rather than imported from
// a helper so a route rename cannot silently point this suite at a different handler.
const streamingGenerateRoute = "/api/backends/chat-completions/generate"

// ---------------------------------------------------------------- the real server

// streamingRoute is a live net/http server carrying the production handler chain over a temporary data
// root. The client disables keep-alives so every request has exactly one downstream socket, which is
// what makes the ConnState opened/closed accounting exact.
type streamingRoute struct {
	origin string
	server *httptest.Server
	client *http.Client
	opened int32
	closed int32
}

func newStreamingRoute(t *testing.T) *streamingRoute {
	t.Helper()
	// THIS SUITE MUST MEASURE THE PRODUCTION TRANSPORT. internal/server's own test binary pins
	// GOTAVERN_OUTBOUND_WIRE_EXACT=1 for the provider-wire replay (transport_mode_test.go), so a streaming
	// test placed in that package would measure the ORACLE-ONLY raw client: it has no connection pool, no
	// response decoding and a different cancellation mechanism (a goroutine that closes the socket on
	// ctx.Done), which would make a production cancellation defect invisible here. This file therefore
	// lives in tests/e2e, where the harness already refuses the seam, and asserts the mode itself.
	requireProductionTransport(t)
	// The environment check above is the harness rule; this is the resolved client, which is what the
	// assertions below actually measure. A seam that left the process in wire-exact mode would make every
	// streaming assertion here evidence about the measuring instrument (AGENTS.md rule 7).
	if mode := outbound.TransportMode(); mode != "production" {
		t.Fatalf("this suite needs the PRODUCTION provider transport, but the process resolved %q; every socket and cancellation assertion below would be about a different client", mode)
	}
	dataRoot := t.TempDir()
	userRoot := filepath.Join(dataRoot, "default-user")
	if err := os.MkdirAll(filepath.Join(userRoot, "backups"), 0o755); err != nil {
		t.Fatalf("create the probe user tree: %v", err)
	}
	// A real install reaches this route with a stored credential; the CUSTOM source reads api_key_custom.
	secrets, err := json.Marshal(map[string][]map[string]any{
		"api_key_custom": {{"id": "sid-api_key_custom", "value": "synthetic-streaming-key", "label": "api_key_custom", "active": true}},
	})
	if err != nil {
		t.Fatalf("encode the probe secrets: %v", err)
	}
	if err := os.WriteFile(filepath.Join(userRoot, "secrets.json"), secrets, 0o600); err != nil {
		t.Fatalf("write the probe secrets: %v", err)
	}

	handler := server.NewHTTPHandlerWithOptions(server.HTTPHandlerOptions{InstallRoot: dataRoot, DataRoot: dataRoot, DisableCSRF: true})
	server := httptest.NewUnstartedServer(handler)
	route := &streamingRoute{server: server}
	server.Config.ConnState = func(_ net.Conn, state http.ConnState) {
		switch state {
		case http.StateNew:
			atomic.AddInt32(&route.opened, 1)
		case http.StateClosed, http.StateHijacked:
			atomic.AddInt32(&route.closed, 1)
		}
	}
	server.Start()
	route.origin = server.URL
	route.client = &http.Client{Transport: &http.Transport{DisableKeepAlives: true}}
	t.Cleanup(func() {
		route.client.CloseIdleConnections()
		// A streaming handler that leaked is exactly the defect this suite looks for, and
		// httptest.Server.Close blocks until outstanding requests finish -- so an unqualified Close would turn
		// a named assertion failure into a hung test binary. Abort the downstream connections, then bound the
		// close and REPORT it instead of hanging.
		server.CloseClientConnections()
		closed := make(chan struct{})
		go func() {
			server.Close()
			close(closed)
		}()
		select {
		case <-closed:
		case <-time.After(10 * time.Second):
			t.Logf("the probe server did not finish closing within 10s: a streaming handler is still live; the assertion that failed above names which one")
		}
	})

	// Warm the server up on a non-generate route so the baseline goroutine count is not measuring
	// one-time startup work. A warmup on the generate route would consume a scripted provider response.
	warmup, err := route.client.Get(route.origin + "/version")
	if err != nil {
		t.Fatalf("warm up the probe server: %v", err)
	}
	_, _ = io.Copy(io.Discard, warmup.Body)
	_ = warmup.Body.Close()
	return route
}

// postCUSTOM sends the recorded CUSTOM-source streaming shape at providerAddress. The marker rides in
// `model`, so the provider records it inside the request body and a peer can echo it back: that is what
// makes a crossed stream visible instead of plausible.
func (route *streamingRoute) postCUSTOM(ctx context.Context, providerAddress, marker string) (*http.Response, error) {
	body := fmt.Sprintf(
		`{"chat_completion_source":"custom","custom_url":"http://%s/v1","model":%q,"messages":[{"role":"user","content":"streaming probe"}],"stream":true}`,
		providerAddress, marker)
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, route.origin+streamingGenerateRoute, strings.NewReader(body))
	if err != nil {
		return nil, err
	}
	request.Header.Set("Content-Type", "application/json")
	return route.client.Do(request)
}

// postCUSTOMBounded posts with a BACKSTOP deadline. Without one, a route that buffered the response head
// (the exact failure a missing flush produces) would leave http.Client.Do blocked forever and hang the
// whole test binary instead of failing the case by name. 60s is far beyond any assertion here, so the
// bound can only fire on a hang.
func (route *streamingRoute) postCUSTOMBounded(t *testing.T, providerAddress, marker string) *http.Response {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	t.Cleanup(cancel)
	response, err := route.postCUSTOM(ctx, providerAddress, marker)
	if err != nil {
		t.Fatalf("%s: POST the streaming generate route: %v (a route that never writes a response head is the hang this backstop exists for)", marker, err)
	}
	return response
}

// streamingRequestContext is the context a cancellation case starts from. The timeout is a BACKSTOP: the
// case asserts cancellation long before it, and the bound only exists so a wedged handler cannot hang the
// test binary.
func streamingRequestContext(t *testing.T) (context.Context, context.CancelFunc) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	t.Cleanup(cancel)
	return ctx, cancel
}

// requireConnectionsClosed asserts a REAL downstream socket fact: every accepted connection has been
// closed. It polls to a deadline (a closed socket is reported asynchronously) and reports the numbers.
func (route *streamingRoute) requireConnectionsClosed(t *testing.T, label string, deadline time.Duration) {
	t.Helper()
	start := time.Now()
	for {
		opened := atomic.LoadInt32(&route.opened)
		closed := atomic.LoadInt32(&route.closed)
		if opened > 0 && closed >= opened {
			t.Logf("%s: downstream sockets opened %d, closed %d (after %s)", label, opened, closed, time.Since(start).Round(time.Millisecond))
			return
		}
		if time.Since(start) > deadline {
			t.Fatalf("%s: %d of %d accepted downstream connections are still open after %s; the handler's socket did not close",
				label, opened-closed, opened, deadline)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// ---------------------------------------------------------------- goroutine measurements

// goroutineFloor samples the count and returns the SMALLEST value seen, so a goroutine that happens to
// be exiting during sampling cannot inflate the baseline and hide a leak.
func goroutineFloor(samples int, gap time.Duration) int {
	floor := runtime.NumGoroutine()
	for index := 0; index < samples; index++ {
		time.Sleep(gap)
		if count := runtime.NumGoroutine(); count < floor {
			floor = count
		}
	}
	return floor
}

// requireGoroutinesReturnTo polls until at most floor+slack goroutines remain. On failure it names the
// measured counts and dumps the live stacks, because "goroutine leak" without the stacks costs a turn.
func requireGoroutinesReturnTo(t *testing.T, label string, floor, slack int, deadline time.Duration) int {
	t.Helper()
	start := time.Now()
	for {
		count := runtime.NumGoroutine()
		if count <= floor+slack {
			t.Logf("%s: goroutines %d after settle (baseline %d, delta +%d) in %s",
				label, count, floor, count-floor, time.Since(start).Round(time.Millisecond))
			return count
		}
		if time.Since(start) > deadline {
			stack := make([]byte, 64*1024)
			length := runtime.Stack(stack, true)
			t.Fatalf("%s: %d goroutines remain after %s (baseline %d, allowed +%d); a handler, transport or provider goroutine did not return:\n%s",
				label, count, deadline, floor, slack, stack[:length])
			return count
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// ---------------------------------------------------------------- mock provider helpers

// startMockStream starts a recording provider from tests/mockprovider and returns its authority and the
// recorder. Its `Stream` entries are written as separate chunked-transfer frames (one TCP write each),
// which is how this suite controls the UPSTREAM write boundaries.
func startMockStream(t *testing.T, responses []mockprovider.Response) (string, *mockprovider.Recorder) {
	t.Helper()
	recorder := mockprovider.New(responses)
	address, err := recorder.Listen(0)
	if err != nil {
		t.Fatalf("start the recording provider: %v", err)
	}
	t.Cleanup(func() { _ = recorder.Close() })
	return address.String(), recorder
}

// disconnectedReports counts provider requests the peer marked as abandoned by their caller.
func disconnectedReports(recording mockprovider.Recording) int {
	count := 0
	for _, request := range recording.Requests {
		if request.ClientDisconnected {
			count++
		}
	}
	return count
}

// requireProviderObservedDisconnect asserts the UPSTREAM socket fact: the provider peer saw its caller
// go away (EOF on the connection it was holding open) within the deadline. This is the observable that
// pinned's socket-close -> controller.abort() exists to produce; an implementation that only stops
// reading would leave the provider generating and billing a reply nobody reads.
func requireProviderObservedDisconnect(t *testing.T, label string, recorder *mockprovider.Recorder, want int, deadline time.Duration) time.Duration {
	t.Helper()
	start := time.Now()
	for {
		recording := recorder.Recording()
		if len(recording.Requests) >= want && disconnectedReports(recording) >= want {
			elapsed := time.Since(start)
			t.Logf("%s: provider observed %d/%d callers disconnect after %s", label, disconnectedReports(recording), want, elapsed.Round(time.Millisecond))
			return elapsed
		}
		if time.Since(start) > deadline {
			recording := recorder.Recording()
			t.Fatalf("%s: the provider never observed the disconnect within %s (%d request(s) recorded, %d marked disconnected); the upstream TCP connection was not closed",
				label, deadline, len(recording.Requests), disconnectedReports(recording))
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// readFrame reads one complete SSE frame (through the blank-line terminator) so a test can synchronise
// on data having arrived without depending on a particular read size.
func readFrame(t *testing.T, body io.Reader, subject string, deadline time.Duration) []byte {
	t.Helper()
	type result struct {
		frame []byte
		err   error
	}
	done := make(chan result, 1)
	go func() {
		frame := make([]byte, 0, 256)
		chunk := make([]byte, 128)
		for !strings.Contains(string(frame), "\n\n") {
			count, err := body.Read(chunk)
			frame = append(frame, chunk[:count]...)
			if err != nil {
				done <- result{frame, err}
				return
			}
		}
		done <- result{frame, nil}
	}()
	select {
	case outcome := <-done:
		if outcome.err != nil {
			t.Fatalf("%s: reading the streamed frame: %v (after %q)", subject, outcome.err, string(outcome.frame))
		}
		return outcome.frame
	case <-time.After(deadline):
		t.Fatalf("%s: no complete SSE frame arrived within %s", subject, deadline)
		return nil
	}
}

// ---------------------------------------------------------------- 1, 2, 3: byte transparency

// TestStreamingSSEFrameSplitAtEveryByteOffsetIsTransparent is REQUIRED COVERAGE 1 and 2 in one shape.
// A canonical stream carrying a multi-byte rune is split at EVERY internal byte offset, one case per
// offset, plus coalesced and multi-write shapes. Each split offset is a separate upstream chunked-
// transfer frame, i.e. a separate TCP write, and the client must receive the identical decompressed
// bytes: no re-framing, no dropped byte, no U+FFFD from a rune split between writes.
func TestStreamingSSEFrameSplitAtEveryByteOffsetIsTransparent(t *testing.T) {
	// é (2 bytes) and 🚀 (4 bytes) make the multi-byte case unavoidable at most offsets; the trailing
	// [DONE] frame makes a re-framer that invents or drops a terminator visible.
	whole := "data: {\"text\":\"h\u00e9llo \U0001F680\"}\n\ndata: [DONE]\n\n"
	if len(whole) < 32 {
		t.Fatalf("the canonical stream is only %d bytes, too short to split meaningfully", len(whole))
	}

	type leg struct {
		label  string
		chunks []string
	}
	legs := make([]leg, 0, len(whole)+3)
	for offset := 1; offset < len(whole); offset++ {
		legs = append(legs, leg{
			label:  fmt.Sprintf("split at byte offset %d of %d", offset, len(whole)),
			chunks: []string{whole[:offset], whole[offset:]},
		})
	}
	legs = append(legs,
		leg{label: "every byte its own write", chunks: func() []string {
			chunks := make([]string, 0, len(whole))
			for index := 0; index < len(whole); index++ {
				chunks = append(chunks, whole[index:index+1])
			}
			return chunks
		}()},
		leg{label: "two frames plus terminator in ONE chunk", chunks: []string{whole}},
		leg{label: "three writes, boundaries inside a rune and inside the blank line", chunks: []string{
			whole[:strings.Index(whole, "\u00e9")+1],
			whole[strings.Index(whole, "\u00e9")+1 : len(whole)-8],
			whole[len(whole)-8:],
		}},
	)

	responses := make([]mockprovider.Response, 0, len(legs))
	for _, entry := range legs {
		responses = append(responses, mockprovider.Response{
			Status:  http.StatusOK,
			Headers: []mockprovider.Header{{Name: "Content-Type", Value: "text/event-stream"}, {Name: "Connection", Value: "close"}},
			Stream:  append([]string(nil), entry.chunks...),
		})
	}
	provider, recorder := startMockStream(t, responses)
	route := newStreamingRoute(t)

	for index, entry := range legs {
		response := route.postCUSTOMBounded(t, provider, "probe-stream-split")
		body, readErr := io.ReadAll(response.Body)
		_ = response.Body.Close()
		if readErr != nil {
			t.Fatalf("%s: reading the streamed answer: %v (after %q)", entry.label, readErr, string(body))
		}
		if response.StatusCode != http.StatusOK {
			t.Fatalf("%s: status = %d, want 200", entry.label, response.StatusCode)
		}
		if string(body) != whole {
			firstDifference := -1
			limit := len(body)
			if len(whole) < limit {
				limit = len(whole)
			}
			for offset := 0; offset < limit; offset++ {
				if body[offset] != whole[offset] {
					firstDifference = offset
					break
				}
			}
			t.Fatalf("%s: the client did not receive the provider's bytes (wrote %d, received %d, first difference at byte %d)\n  provider: %q\n  client:   %q",
				entry.label, len(whole), len(body), firstDifference, whole, string(body))
		}
		if strings.Contains(string(body), "\uFFFD") {
			t.Fatalf("%s: the client received U+FFFD: a multi-byte rune was corrupted by a write-boundary split", entry.label)
		}
		recorded := recorder.Recording().Requests
		if len(recorded) != index+1 {
			t.Fatalf("%s: the provider received %d request(s), want %d: each leg must make exactly one provider call",
				entry.label, len(recorded), index+1)
		}
	}
	t.Logf("byte transparency: %d write-boundary shapes delivered the canonical %d-byte stream byte for byte", len(legs), len(whole))

	// Requirement 11: after the last case, no request goroutine and no downstream socket survives.
	requireGoroutinesReturnTo(t, "byte transparency", goroutineFloor(3, 20*time.Millisecond), 8, 5*time.Second)
	route.requireConnectionsClosed(t, "byte transparency", 5*time.Second)
}

// ---------------------------------------------------------------- incremental delivery

// TestStreamingDeliversEachUpstreamChunkBeforeTheNextIsWritten asserts the property that makes this a
// STREAM rather than a buffered reply: each provider chunk must reach the browser before the provider
// writes the next one. The peer writes chunk 1, then REFUSES to write chunk 2 until the client has read
// chunk 1; a forwarder that forgot to flush (or that buffered the reply) cannot satisfy that ordering and
// fails by timeout with a named assertion. Pinned's forwardFetchResponse pipes through Express's
// res.write, which flushes per chunk, so incremental delivery is the pinned observable.
func TestStreamingDeliversEachUpstreamChunkBeforeTheNextIsWritten(t *testing.T) {
	first := "data: {\"chunk\":1}\n\n"
	second := "data: {\"chunk\":2}\n\n"
	release := make(chan struct{})
	peer := startRawStreamPeer(t, func(connection net.Conn, _ *bufio.Reader, _ []byte, _ int) {
		writePeerStreamHead(t, connection)
		if err := writePeerChunk(connection, first); err != nil {
			return
		}
		select {
		case <-release:
		case <-time.After(10 * time.Second):
			return
		}
		if err := writePeerChunk(connection, second); err != nil {
			return
		}
		_, _ = io.WriteString(connection, "0\r\n\r\n")
	})
	route := newStreamingRoute(t)
	floor := goroutineFloor(3, 20*time.Millisecond)

	response := route.postCUSTOMBounded(t, peer.address(), "probe-stream-incremental")
	// A buffered (unflushed) response cannot produce this frame while the provider is holding chunk 2.
	frame := readFrame(t, response.Body, "incremental delivery of the first chunk", 5*time.Second)
	if string(frame) != first {
		t.Fatalf("first delivered chunk = %q, want the provider's first chunk %q", string(frame), first)
	}
	t.Logf("incremental delivery: first chunk reached the client while the provider was holding the second")
	close(release)

	rest, readErr := io.ReadAll(response.Body)
	_ = response.Body.Close()
	if readErr != nil {
		t.Fatalf("reading the remainder after the provider resumed: %v", readErr)
	}
	if string(rest) != second {
		t.Fatalf("remainder = %q, want exactly the second chunk %q (bytes must not be duplicated across the resume)", string(rest), second)
	}
	requireGoroutinesReturnTo(t, "incremental delivery", floor, 8, 5*time.Second)
	route.requireConnectionsClosed(t, "incremental delivery", 5*time.Second)
}

// ---------------------------------------------------------------- gzip-encoded streams

// TestStreamingGzipProviderStreamIsDecompressedAndCancelStillAbortsTheUpstream covers the DECOMPRESSED
// half of byte transparency on the production client, and it exists because the only other gate for it --
// TestUnsolicitedGzipIsDecodedByTheTransportAndTheConnectionIsReleased in internal/server -- always SKIPS
// there: that package's TestMain pins GOTAVERN_OUTBOUND_WIRE_EXACT=1, so outbound.TransportMode() can
// never be "production" inside it. (Reported as a coverage gap rather than changed here: that file is
// outside this lane's scope.)
//
// Two legs: a complete gzip-encoded SSE stream split across chunked-transfer frames must be delivered as
// the identical decompressed bytes, and an encoded stream the provider holds open must still abort
// upstream when the browser cancels.
func TestStreamingGzipProviderStreamIsDecompressedAndCancelStillAbortsTheUpstream(t *testing.T) {
	plain := "data: {\"text\":\"h\u00e9llo \U0001F680\"}\n\ndata: [DONE]\n\n"
	var compressed bytes.Buffer
	writer := gzip.NewWriter(&compressed)
	if _, err := writer.Write([]byte(plain)); err != nil {
		t.Fatalf("gzip the canonical stream: %v", err)
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("finish the gzip stream: %v", err)
	}
	payload := compressed.Bytes()
	// Three chunked-transfer frames, so the decompressor is fed across write boundaries.
	first := len(payload) / 3
	second := first * 2
	provider, recorder := startMockStream(t, []mockprovider.Response{{
		Status: http.StatusOK,
		Headers: []mockprovider.Header{
			{Name: "Content-Type", Value: "text/event-stream"},
			{Name: "Content-Encoding", Value: "gzip"},
			{Name: "Connection", Value: "close"},
		},
		Stream: []string{string(payload[:first]), string(payload[first:second]), string(payload[second:])},
	}})
	route := newStreamingRoute(t)
	floor := goroutineFloor(3, 20*time.Millisecond)

	response := route.postCUSTOMBounded(t, provider, "probe-stream-gzip")
	body, readErr := io.ReadAll(response.Body)
	_ = response.Body.Close()
	if readErr != nil {
		t.Fatalf("reading the gzip-encoded stream: %v (after %q)", readErr, string(body))
	}
	if string(body) != plain {
		t.Fatalf("decompressed client bytes = %q, want the provider's plain stream %q; the production client must decode the encoding it advertised (the transport owns Accept-Encoding)", string(body), plain)
	}
	if strings.Contains(string(body), "\uFFFD") {
		t.Fatalf("the decompressed stream carries U+FFFD: a rune was corrupted across a decompression boundary")
	}
	t.Logf("gzip: %d compressed bytes split across three chunks decompressed to the canonical %d-byte stream", len(payload), len(plain))
	if len(recorder.Recording().Requests) != 1 {
		t.Fatalf("provider request count = %d, want 1", len(recorder.Recording().Requests))
	}
	requireGoroutinesReturnTo(t, "gzip stream", floor, 8, 5*time.Second)
	route.requireConnectionsClosed(t, "gzip stream", 5*time.Second)

	// Leg 2: an ENDLESS gzip stream. A close-delimited body (no Content-Length, no Transfer-Encoding) lets
	// the peer stream a gzip encoder straight to the connection and then hold it open.
	const heldFrame = "data: {\"held\":true}\n\n"
	var peerReads int32
	peer := startRawStreamPeer(t, func(connection net.Conn, _ *bufio.Reader, _ []byte, _ int) {
		if _, err := io.WriteString(connection, "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Encoding: gzip\r\nConnection: close\r\n\r\n"); err != nil {
			return
		}
		encoder := gzip.NewWriter(connection)
		if _, err := encoder.Write([]byte(heldFrame)); err != nil {
			return
		}
		if err := encoder.Flush(); err != nil {
			return
		}
		// Return without closing: the gzip stream has no terminator yet, so the body stays open.
		atomic.AddInt32(&peerReads, 1)
	})
	heldRoute := newStreamingRoute(t)
	secondFloor := goroutineFloor(3, 20*time.Millisecond)
	ctx, cancel := streamingRequestContext(t)
	cancelResponse, err := heldRoute.postCUSTOM(ctx, peer.address(), "probe-stream-gzip-held")
	if err != nil {
		cancel()
		t.Fatalf("POST the gzip held-open stream: %v", err)
	}
	frame := readFrame(t, cancelResponse.Body, "gzip held stream", 10*time.Second)
	if string(frame) != heldFrame {
		cancel()
		_ = cancelResponse.Body.Close()
		t.Fatalf("gzip held stream delivered %q, want the decompressed held frame %q", string(frame), heldFrame)
	}
	cancel()
	_ = cancelResponse.Body.Close()
	if atomic.LoadInt32(&peerReads) != 1 {
		t.Fatalf("the gzip peer served %d connection(s), want 1", atomic.LoadInt32(&peerReads))
	}
	peer.requireClosed(t, "gzip held stream cancel", 1, 5*time.Second)
	requireGoroutinesReturnTo(t, "gzip held stream cancel", secondFloor, 8, 5*time.Second)
	heldRoute.requireConnectionsClosed(t, "gzip held stream cancel", 5*time.Second)
}

// ---------------------------------------------------------------- 4: clean EOF without [DONE]

// TestStreamingUpstreamWithoutDoneEndsCleanlyAtEOF is REQUIRED COVERAGE 4. A provider that finishes its
// body without the [DONE] sentinel (a clean chunked end) must end the client's stream cleanly: the
// pinned forwarder's 'end' handler calls to.end(), and no terminal sentinel is invented.
func TestStreamingUpstreamWithoutDoneEndsCleanlyAtEOF(t *testing.T) {
	frames := "data: {\"delta\":\"one\"}\n\ndata: {\"delta\":\"two\"}\n\n"
	if strings.Contains(frames, "[DONE]") {
		t.Fatal("the fixture carries [DONE], so this case would prove nothing")
	}
	provider, recorder := startMockStream(t, []mockprovider.Response{{
		Status:  http.StatusOK,
		Headers: []mockprovider.Header{{Name: "Content-Type", Value: "text/event-stream"}, {Name: "Connection", Value: "close"}},
		Stream:  []string{frames[:20], frames[20:]},
	}})
	route := newStreamingRoute(t)
	floor := goroutineFloor(3, 20*time.Millisecond)

	started := time.Now()
	response := route.postCUSTOMBounded(t, provider, "probe-stream-no-done")
	body, readErr := io.ReadAll(response.Body)
	_ = response.Body.Close()
	elapsed := time.Since(started)
	if readErr != nil {
		t.Fatalf("a provider that ended cleanly WITHOUT [DONE] produced a client read error %v; a clean end must be indistinguishable from a finished reply (bytes %q)", readErr, string(body))
	}
	if string(body) != frames {
		t.Fatalf("client bytes = %q, want the provider's exact frames %q", string(body), frames)
	}
	if strings.Contains(string(body), "[DONE]") {
		t.Fatalf("the route invented a terminal sentinel the provider never sent: %q", string(body))
	}
	if elapsed > 5*time.Second {
		t.Fatalf("a clean 40-byte stream took %s to terminate; the client hung instead of seeing EOF", elapsed)
	}
	t.Logf("clean end without [DONE]: %d bytes delivered, EOF in %s", len(body), elapsed.Round(time.Millisecond))
	if len(recorder.Recording().Requests) != 1 {
		t.Fatalf("provider request count = %d, want 1", len(recorder.Recording().Requests))
	}
	requireGoroutinesReturnTo(t, "clean end without [DONE]", floor, 6, 5*time.Second)
	route.requireConnectionsClosed(t, "clean end without [DONE]", 5*time.Second)
}

// ---------------------------------------------------------------- 5: upstream dies mid-frame

// TestStreamingUpstreamTruncationForwardsPartialBytesAndHoldsTheResponseOpen is REQUIRED COVERAGE 5.
//
// The PINNED observable is the oracle, and it is a recorded one: the provider-wire capture
// openai-reverse-proxy-midstream-truncation records driverTimedOut:true with both delivered frames, so
// pinned delivers what arrived and leaves the browser response OPEN until the client disconnects. This
// test asserts exactly that (partial bytes delivered, then no EOF and no error inside a measured
// window), then proves the situation is not unrecoverable: the client's own cancel returns the handler,
// the downstream socket closes and the goroutine count returns to baseline. It deliberately does NOT
// invent a terminal error frame, which would be a divergence from the capture.
func TestStreamingUpstreamTruncationForwardsPartialBytesAndHoldsTheResponseOpen(t *testing.T) {
	// The provider dies INSIDE the second frame: the first frame is complete and the second has no
	// terminator. A forwarder that dropped the trailing partial bytes would lose the beginning of the
	// model's last sentence; one that invented a terminator would make a truncated answer look complete.
	completeFrame := "data: {\"delta\":\"partial output\"}\n\n"
	incompleteFrame := "data: {\"delta\":\"unfinished"
	partial := completeFrame + incompleteFrame
	if strings.HasSuffix(partial, "\n\n") {
		t.Fatal("the fixture ends on a frame boundary, so this case would not truncate mid-frame")
	}
	provider, recorder := startMockStream(t, []mockprovider.Response{{
		Status:              http.StatusOK,
		Headers:             []mockprovider.Header{{Name: "Content-Type", Value: "text/event-stream"}, {Name: "Connection", Value: "close"}},
		Stream:              []string{completeFrame, incompleteFrame},
		TruncateAfterFrames: true,
	}})
	route := newStreamingRoute(t)
	floor := goroutineFloor(3, 20*time.Millisecond)

	ctx, cancel := context.WithCancel(context.Background())
	response, err := route.postCUSTOM(ctx, provider, "probe-stream-truncated")
	if err != nil {
		cancel()
		t.Fatalf("POST the streaming generate route: %v", err)
	}
	received := make([]byte, len(partial))
	if _, err := io.ReadFull(response.Body, received); err != nil {
		cancel()
		_ = response.Body.Close()
		t.Fatalf("the route did not forward the provider's partial frame: %v", err)
	}
	if string(received) != partial {
		cancel()
		_ = response.Body.Close()
		t.Fatalf("partial bytes = %q, want the provider's frame %q", string(received), partial)
	}

	// The provider is dead; pinned's pipe() never ends the browser response. Measure that the response
	// is OPEN (no EOF, no error) inside a bounded window instead of blocking the test forever.
	type termination struct {
		count int
		err   error
	}
	pending := make(chan termination, 1)
	go func() {
		buffer := make([]byte, 1)
		count, readErr := response.Body.Read(buffer)
		pending <- termination{count, readErr}
	}()
	select {
	case outcome := <-pending:
		cancel()
		_ = response.Body.Close()
		t.Fatalf("a provider that died mid-frame TERMINATED the browser response (read returned n=%d err=%v); the pinned capture records driverTimedOut:true, i.e. the response stays open until the client disconnects",
			outcome.count, outcome.err)
	case <-time.After(750 * time.Millisecond):
		t.Logf("truncation: response still open with no bytes and no error after 750ms (pinned: driverTimedOut:true)")
	}

	cancel()
	select {
	case outcome := <-pending:
		if outcome.err == nil {
			t.Fatalf("after the client cancelled a truncated stream the read returned n=%d with NO error", outcome.count)
		}
		if !isClientCancellation(outcome.err) {
			t.Fatalf("after the client cancelled, the read returned %v; want a cancellation error a user can classify", outcome.err)
		}
		t.Logf("truncation: client cancel unwound the pending read: %v", outcome.err)
	case <-time.After(5 * time.Second):
		t.Fatalf("the client cancelled a truncated stream but its pending read did not return within 5s; the handler is wedged")
	}
	_ = response.Body.Close()

	if len(recorder.Recording().Requests) != 1 {
		t.Fatalf("provider request count = %d, want 1", len(recorder.Recording().Requests))
	}
	requireGoroutinesReturnTo(t, "truncated stream after client cancel", floor, 6, 5*time.Second)
	route.requireConnectionsClosed(t, "truncated stream after client cancel", 5*time.Second)
}

// isClientCancellation reports whether err is the cancellation a browser's aborted request produces.
func isClientCancellation(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, context.Canceled) {
		return true
	}
	message := strings.ToLower(err.Error())
	return strings.Contains(message, "context canceled") || strings.Contains(message, "operation was canceled") ||
		strings.Contains(message, "canceled") || strings.Contains(message, "cancelled")
}

// ---------------------------------------------------------------- 7: client cancel

// TestStreamingClientCancelClosesTheUpstreamConnection is REQUIRED COVERAGE 7 (a)-(d) for one cancel.
// The provider holds the stream open (NeverEnds) and marks ClientDisconnected only when the caller
// actually goes away; the assertions are: the client observes cancellation, the provider observes its
// connection closed, the downstream socket closes, and the route goroutines return to baseline.
func TestStreamingClientCancelClosesTheUpstreamConnection(t *testing.T) {
	provider, recorder := startMockStream(t, []mockprovider.Response{{
		Status:    http.StatusOK,
		Headers:   []mockprovider.Header{{Name: "Content-Type", Value: "text/event-stream"}, {Name: "Connection", Value: "close"}},
		NeverEnds: true,
	}})
	route := newStreamingRoute(t)
	floor := goroutineFloor(3, 20*time.Millisecond)
	t.Logf("baseline goroutines before the cancel cycle: %d", floor)

	ctx, cancel := context.WithCancel(context.Background())
	response, err := route.postCUSTOM(ctx, provider, "probe-stream-cancel")
	if err != nil {
		cancel()
		t.Fatalf("POST the streaming generate route: %v", err)
	}
	frame := readFrame(t, response.Body, "client cancel", 10*time.Second)
	if !strings.Contains(string(frame), "held") {
		t.Fatalf("the held-open stream delivered %q, want the mock's held frame", string(frame))
	}
	// The stream must still be LIVE here: the provider is holding it open, so the route's handler and the
	// transport goroutines must be in flight. A handler that already returned would make the disconnect
	// assertion below prove nothing.
	if inFlight := runtime.NumGoroutine(); inFlight <= floor {
		t.Fatalf("the held-open request is not holding a goroutine (in flight %d, baseline %d); the stream was already over and the cancel case would prove nothing", inFlight, floor)
	}

	cancel()
	buffer := make([]byte, 64)
	_, readErr := response.Body.Read(buffer)
	if readErr == nil {
		t.Fatalf("after the client cancelled, the response body read returned no error; cancellation was not observed by the client")
	}
	if !isClientCancellation(readErr) {
		t.Fatalf("after the client cancelled, the body read returned %v; want a cancellation error a user can classify", readErr)
	}
	if !errors.Is(readErr, context.Canceled) && !strings.Contains(strings.ToLower(readErr.Error()), "cancel") {
		t.Fatalf("client cancellation error = %v, want context.Canceled", readErr)
	}
	_ = response.Body.Close()

	requireProviderObservedDisconnect(t, "client cancel", recorder, 1, 5*time.Second)
	requireGoroutinesReturnTo(t, "client cancel", floor, 6, 5*time.Second)
	route.requireConnectionsClosed(t, "client cancel", 5*time.Second)
}

// ---------------------------------------------------------------- 8: client disconnect

// TestStreamingClientBodyCloseClosesTheUpstreamConnection is REQUIRED COVERAGE 8. Closing the response
// body without cancelling the request context is the other way a browser abandons a stream (a page
// navigation, an aborted reader). Pinned's to.socket 'close' handler destroys the remote body; the
// assertions are the same socket facts as the cancel case.
func TestStreamingClientBodyCloseClosesTheUpstreamConnection(t *testing.T) {
	provider, recorder := startMockStream(t, []mockprovider.Response{{
		Status:    http.StatusOK,
		Headers:   []mockprovider.Header{{Name: "Content-Type", Value: "text/event-stream"}, {Name: "Connection", Value: "close"}},
		NeverEnds: true,
	}})
	route := newStreamingRoute(t)
	floor := goroutineFloor(3, 20*time.Millisecond)

	response := route.postCUSTOMBounded(t, provider, "probe-stream-body-close")
	frame := readFrame(t, response.Body, "client body close", 10*time.Second)
	if !strings.Contains(string(frame), "held") {
		t.Fatalf("the held-open stream delivered %q, want the mock's held frame", string(frame))
	}

	// Disconnect the way a page that navigates away does: close the body, never cancel a context.
	if err := response.Body.Close(); err != nil {
		t.Fatalf("closing the halfway-read response body: %v", err)
	}
	requireProviderObservedDisconnect(t, "client body close", recorder, 1, 5*time.Second)
	requireGoroutinesReturnTo(t, "client body close", floor, 6, 5*time.Second)
	route.requireConnectionsClosed(t, "client body close", 5*time.Second)
}

// ---------------------------------------------------------------- 7(d), 7(e): 50 cancel cycles

// TestStreamingFiftyCancelsLeakNoGoroutinesOrConnections is REQUIRED COVERAGE 7(d) and 7(e): N=50
// cancel cycles on ONE server, one held-open provider stream each. A single leaked handler, transport
// or provider goroutine per cycle would show up as ~50-150 extra goroutines, so a slack of 10 is a real
// assertion rather than a rubber stamp. File descriptors are not counted in-process on windows/arm64
// (see the file header); the socket fact asserted instead is that every accepted downstream connection
// was closed and every upstream provider request was observed abandoned.
func TestStreamingFiftyCancelsLeakNoGoroutinesOrConnections(t *testing.T) {
	const cycles = 50
	responses := make([]mockprovider.Response, 0, cycles)
	for index := 0; index < cycles; index++ {
		responses = append(responses, mockprovider.Response{
			Status:    http.StatusOK,
			Headers:   []mockprovider.Header{{Name: "Content-Type", Value: "text/event-stream"}, {Name: "Connection", Value: "close"}},
			NeverEnds: true,
		})
	}
	provider, recorder := startMockStream(t, responses)
	route := newStreamingRoute(t)
	floor := goroutineFloor(5, 20*time.Millisecond)
	t.Logf("baseline goroutines before %d cancel cycles: %d", cycles, floor)

	started := time.Now()
	for cycle := 0; cycle < cycles; cycle++ {
		ctx, cancel := context.WithCancel(context.Background())
		response, err := route.postCUSTOM(ctx, provider, fmt.Sprintf("probe-stream-cycle-%d", cycle))
		if err != nil {
			cancel()
			t.Fatalf("cycle %d: POST the streaming generate route: %v", cycle, err)
		}
		frame := readFrame(t, response.Body, fmt.Sprintf("cycle %d", cycle), 10*time.Second)
		if !strings.Contains(string(frame), "held") {
			cancel()
			_ = response.Body.Close()
			t.Fatalf("cycle %d: held stream delivered %q", cycle, string(frame))
		}
		cancel()
		_ = response.Body.Close()
		requireProviderObservedDisconnect(t, fmt.Sprintf("cycle %d", cycle), recorder, cycle+1, 5*time.Second)
	}
	t.Logf("%d cancel cycles completed in %s", cycles, time.Since(started).Round(time.Millisecond))

	if len(recorder.Recording().Requests) != cycles {
		t.Fatalf("provider request count = %d, want %d", len(recorder.Recording().Requests), cycles)
	}
	requireGoroutinesReturnTo(t, fmt.Sprintf("%d cancel cycles", cycles), floor, 10, 10*time.Second)
	route.requireConnectionsClosed(t, fmt.Sprintf("%d cancel cycles", cycles), 10*time.Second)
}

// ---------------------------------------------------------------- the raw TCP peer

// rawStreamPeer is a real TCP provider used only where tests/mockprovider cannot express the case:
//   - a per-connection DISTINGUISHABLE held frame, so a crossed response is visible (concurrent cancels);
//   - a response head followed by NO bytes at all (stall);
//   - a byte counter proving the server stopped draining (backpressure).
//
// It speaks just enough HTTP/1.1 for one request per connection. `closed` advances only when the CLIENT
// ends the connection, which is the socket-level cancellation fact these cases assert.
type rawStreamPeer struct {
	listener net.Listener
	opened   int32
	closed   int32
}

func startRawStreamPeer(t *testing.T, serve func(connection net.Conn, reader *bufio.Reader, body []byte, index int)) *rawStreamPeer {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen for the raw streaming peer: %v", err)
	}
	peer := &rawStreamPeer{listener: listener}
	go func() {
		for {
			connection, acceptErr := listener.Accept()
			if acceptErr != nil {
				return
			}
			index := int(atomic.AddInt32(&peer.opened, 1)) - 1
			go func() {
				defer connection.Close()
				reader := bufio.NewReader(connection)
				body, readErr := readPeerRequest(reader)
				if readErr != nil {
					return
				}
				serve(connection, reader, body, index)
				// Hold the connection until the CLIENT closes: an EOF here is the upstream close
				// observation, not a timer. The deadline only stops a broken test from hanging forever.
				_ = connection.SetReadDeadline(time.Now().Add(30 * time.Second))
				_, _ = io.Copy(io.Discard, reader)
				atomic.AddInt32(&peer.closed, 1)
			}()
		}
	}()
	t.Cleanup(func() { _ = listener.Close() })
	return peer
}

func (peer *rawStreamPeer) address() string { return peer.listener.Addr().String() }

// requireOpened waits until the peer has accepted at least `want` connections, so a test can act from a
// real observed state instead of a sleep-derived assumption.
func (peer *rawStreamPeer) requireOpened(t *testing.T, label string, want int, deadline time.Duration) {
	t.Helper()
	start := time.Now()
	for {
		if opened := int(atomic.LoadInt32(&peer.opened)); opened >= want {
			t.Logf("%s: raw provider accepted %d connection(s) after %s", label, opened, time.Since(start).Round(time.Millisecond))
			return
		}
		if time.Since(start) > deadline {
			t.Fatalf("%s: the raw provider accepted only %d of %d connection(s) within %s; the route never reached the provider",
				label, atomic.LoadInt32(&peer.opened), want, deadline)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// requireClosed asserts the peer observed the client close every connection it accepted.
func (peer *rawStreamPeer) requireClosed(t *testing.T, label string, want int, deadline time.Duration) {
	t.Helper()
	start := time.Now()
	for {
		opened := int(atomic.LoadInt32(&peer.opened))
		closed := int(atomic.LoadInt32(&peer.closed))
		if opened >= want && closed >= want {
			t.Logf("%s: raw provider accepted %d connection(s), observed close on %d after %s", label, opened, closed, time.Since(start).Round(time.Millisecond))
			return
		}
		if time.Since(start) > deadline {
			t.Fatalf("%s: the raw provider accepted %d connection(s) and observed only %d close(s) within %s; the upstream TCP connection stayed open",
				label, opened, closed, deadline)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// readPeerRequest reads one request head and its Content-Length body.
func readPeerRequest(reader *bufio.Reader) ([]byte, error) {
	head := strings.Builder{}
	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			return nil, err
		}
		head.WriteString(line)
		if line == "\r\n" {
			break
		}
	}
	length := 0
	for _, line := range strings.Split(head.String(), "\r\n") {
		if strings.HasPrefix(strings.ToLower(line), "content-length:") {
			value := strings.TrimSpace(strings.TrimPrefix(line, line[:strings.IndexByte(line, ':')+1]))
			if _, err := fmt.Sscanf(value, "%d", &length); err != nil {
				return nil, fmt.Errorf("parse Content-Length %q: %w", value, err)
			}
		}
	}
	body := make([]byte, length)
	if length > 0 {
		if _, err := io.ReadFull(reader, body); err != nil {
			return nil, err
		}
	}
	return body, nil
}

// writePeerStreamHead writes a 200 text/event-stream response head with chunked framing.
func writePeerStreamHead(t *testing.T, connection net.Conn) {
	t.Helper()
	if _, err := io.WriteString(connection, "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n"); err != nil {
		t.Errorf("write the raw provider response head: %v", err)
	}
}

// writePeerChunk writes one chunked-transfer frame, which is one TCP write.
func writePeerChunk(connection net.Conn, frame string) error {
	_, err := fmt.Fprintf(connection, "%x\r\n%s\r\n", len(frame), frame)
	return err
}

// markerFromBody finds `"model":"<marker>"` in the provider request body, so a peer can echo the
// caller's own marker back and a crossed stream becomes a byte mismatch rather than a plausible answer.
func markerFromBody(body []byte) string {
	const prefix = `"model":"`
	text := string(body)
	index := strings.Index(text, prefix)
	if index < 0 {
		return ""
	}
	rest := text[index+len(prefix):]
	end := strings.IndexByte(rest, '"')
	if end < 0 {
		return ""
	}
	return rest[:end]
}

// ---------------------------------------------------------------- 10: concurrent cancels

// TestStreamingConcurrentCancelsDoNotCrossTalk is REQUIRED COVERAGE 10: eight simultaneous streams, all
// cancelled at once. Each peer connection echoes the marker from ITS OWN request body, so if any
// response were crossed the client would read a different marker. After the simultaneous cancel the
// assertions are: every client sees cancellation, every upstream connection is closed, every downstream
// socket is closed, and no goroutine survives.
func TestStreamingConcurrentCancelsDoNotCrossTalk(t *testing.T) {
	const streams = 8
	peer := startRawStreamPeer(t, func(connection net.Conn, _ *bufio.Reader, body []byte, _ int) {
		marker := markerFromBody(body)
		if marker == "" {
			return
		}
		writePeerStreamHead(t, connection)
		_ = writePeerChunk(connection, fmt.Sprintf("data: {\"probe\":%q}\n\n", marker))
		// Return without the terminal zero-length chunk: the stream stays open until the client goes.
	})
	route := newStreamingRoute(t)
	floor := goroutineFloor(5, 20*time.Millisecond)
	t.Logf("baseline goroutines before %d concurrent streams: %d", streams, floor)

	type streamState struct {
		marker   string
		cancel   context.CancelFunc
		response *http.Response
		readErr  error
		frame    string
	}
	states := make([]*streamState, streams)
	var waitGroup sync.WaitGroup
	waitGroup.Add(streams)
	for index := 0; index < streams; index++ {
		state := &streamState{marker: fmt.Sprintf("probe-concurrent-%d", index)}
		states[index] = state
		go func() {
			defer waitGroup.Done()
			ctx, cancel := context.WithCancel(context.Background())
			state.cancel = cancel
			response, err := route.postCUSTOM(ctx, peer.address(), state.marker)
			if err != nil {
				state.readErr = fmt.Errorf("POST: %w", err)
				cancel()
				return
			}
			state.response = response
			frame := make([]byte, 0, 128)
			buffer := make([]byte, 64)
			for !strings.Contains(string(frame), "\n\n") {
				count, readErr := response.Body.Read(buffer)
				frame = append(frame, buffer[:count]...)
				if readErr != nil {
					state.readErr = readErr
					return
				}
			}
			state.frame = string(frame)
		}()
	}
	waitGroup.Wait()
	for index, state := range states {
		if state.readErr != nil {
			t.Fatalf("stream %d (%s): reading its own frame: %v", index, state.marker, state.readErr)
		}
		if !strings.Contains(state.frame, fmt.Sprintf("%q", state.marker)) {
			t.Fatalf("stream %d (%s) received %q, which does not carry its own marker: responses were CROSSED between concurrent streams",
				index, state.marker, state.frame)
		}
	}

	// Cancel every stream at the same moment.
	for _, state := range states {
		state.cancel()
	}
	for index, state := range states {
		_, readErr := state.response.Body.Read(make([]byte, 64))
		if readErr == nil || !isClientCancellation(readErr) {
			t.Errorf("stream %d: after the simultaneous cancel the body read returned %v; want a cancellation error", index, readErr)
		}
		_ = state.response.Body.Close()
	}
	peer.requireClosed(t, "concurrent cancels", streams, 10*time.Second)
	route.requireConnectionsClosed(t, "concurrent cancels", 10*time.Second)
	requireGoroutinesReturnTo(t, "concurrent cancels", floor, 10, 10*time.Second)
}

// ---------------------------------------------------------------- 6: upstream stall

// TestStreamingUpstreamStallIsBoundedOnlyByTheClient is REQUIRED COVERAGE 6, and it MEASURES rather
// than invents. A provider that answers 200 and then sends no bytes holds the route's body read; the
// production transport deliberately has no body timeout (transport.go: "There is deliberately no bound
// on the body"), and pinned's node-fetch has none either, so the honest result is: no automatic
// termination, governed only by the client. This test measures a 2s window in which NOTHING terminates
// the response, then proves the harness CAN terminate it: the client cancels, the handler unwinds, the
// provider observes the close and the goroutines return.
func TestStreamingUpstreamStallIsBoundedOnlyByTheClient(t *testing.T) {
	const stallWindow = 2 * time.Second
	peer := startRawStreamPeer(t, func(connection net.Conn, _ *bufio.Reader, _ []byte, _ int) {
		writePeerStreamHead(t, connection)
		// No chunks at all: the response body stalls after a complete head.
	})
	route := newStreamingRoute(t)
	floor := goroutineFloor(3, 20*time.Millisecond)

	ctx, cancel := context.WithCancel(context.Background())
	response, err := route.postCUSTOM(ctx, peer.address(), "probe-stream-stall")
	if err != nil {
		cancel()
		t.Fatalf("POST the streaming generate route against a stalled provider: %v", err)
	}
	if response.StatusCode != http.StatusOK {
		cancel()
		_ = response.Body.Close()
		t.Fatalf("stalled provider status = %d, want 200: the head must arrive before the body stalls", response.StatusCode)
	}

	type stallRead struct {
		count int
		err   error
	}
	pending := make(chan stallRead, 1)
	go func() {
		buffer := make([]byte, 1)
		count, readErr := response.Body.Read(buffer)
		pending <- stallRead{count, readErr}
	}()
	inFlight := runtime.NumGoroutine()
	if inFlight <= floor {
		t.Fatalf("the stalled request is not holding a goroutine (in flight %d, baseline %d); the test is not measuring a live stall", inFlight, floor)
	}
	select {
	case outcome := <-pending:
		cancel()
		_ = response.Body.Close()
		t.Fatalf("a provider that stalled with no body bytes produced a terminal read (n=%d err=%v) before %s; measure a bounded behaviour, do not assume one",
			outcome.count, outcome.err, stallWindow)
	case <-time.After(stallWindow):
		t.Logf("stall: no byte, no EOF and no error for %s; the live request held %d goroutines (baseline %d). No server-side body timeout exists, matching pinned and the transport's documented decision",
			stallWindow, inFlight, floor)
	}

	unwindStart := time.Now()
	cancel()
	select {
	case outcome := <-pending:
		if outcome.err == nil || !isClientCancellation(outcome.err) {
			t.Fatalf("after cancelling a stalled stream the pending read returned n=%d err=%v; want a cancellation error", outcome.count, outcome.err)
		}
		t.Logf("stall: client cancel unwound the stalled read in %s (%v)", time.Since(unwindStart).Round(time.Millisecond), outcome.err)
	case <-time.After(5 * time.Second):
		t.Fatalf("the client cancelled a stalled stream but the pending read did not return within 5s; the route is wedged")
	}
	_ = response.Body.Close()

	peer.requireClosed(t, "stalled stream after client cancel", 1, 5*time.Second)
	requireGoroutinesReturnTo(t, "stalled stream after client cancel", floor, 8, 5*time.Second)
	route.requireConnectionsClosed(t, "stalled stream after client cancel", 5*time.Second)
}

// ---------------------------------------------------------------- 9: slow client / backpressure

// TestStreamingSlowClientDoesNotBufferUnboundedly is REQUIRED COVERAGE 9. The provider writes an endless
// stream as fast as the socket accepts it while the browser does not read at all. If the route buffered
// the reply in memory (or in an unbounded queue), the provider would keep writing; because net/http's
// response write blocks once the client's receive window is full, the provider's byte counter must STALL.
// The assertion is that stall (two samples 500ms apart do not advance), which is a boundedness proof
// independent of any particular buffer size; the absolute count and the heap delta are reported.
func TestStreamingSlowClientDoesNotBufferUnboundedly(t *testing.T) {
	var written int64
	frame := "data: {\"filler\":\"" + strings.Repeat("x", 1024) + "\"}\n\n"
	peer := startRawStreamPeer(t, func(connection net.Conn, _ *bufio.Reader, _ []byte, _ int) {
		writePeerStreamHead(t, connection)
		for {
			if err := writePeerChunk(connection, frame); err != nil {
				return
			}
			atomic.AddInt64(&written, int64(len(frame)))
		}
	})
	route := newStreamingRoute(t)
	floor := goroutineFloor(3, 20*time.Millisecond)

	ctx, cancel := context.WithCancel(context.Background())
	response, err := route.postCUSTOM(ctx, peer.address(), "probe-stream-backpressure")
	if err != nil {
		cancel()
		t.Fatalf("POST the streaming generate route: %v", err)
	}
	// The browser deliberately does NOT read the body. Let the pipeline fill, then measure.
	time.Sleep(500 * time.Millisecond)
	var memoryBefore runtime.MemStats
	runtime.ReadMemStats(&memoryBefore)
	first := atomic.LoadInt64(&written)
	time.Sleep(500 * time.Millisecond)
	second := atomic.LoadInt64(&written)
	var memoryAfter runtime.MemStats
	runtime.ReadMemStats(&memoryAfter)
	growth := second - first
	t.Logf("backpressure: provider wrote %d bytes by +500ms and %d by +1000ms (growth %d); heap %d -> %d bytes",
		first, second, growth, memoryBefore.HeapAlloc, memoryAfter.HeapAlloc)
	if first == 0 {
		cancel()
		_ = response.Body.Close()
		t.Fatal("the provider wrote nothing at all; the stream never started, so nothing was measured")
	}
	// 256 KiB of slack covers TCP window updates and scheduler jitter; an unbounded buffer would keep
	// advancing by megabytes in this window, because the provider writes as fast as it is drained.
	if growth > 256*1024 {
		cancel()
		_ = response.Body.Close()
		t.Fatalf("the provider advanced %d bytes while the client read NOTHING; the route is draining and buffering the reply instead of propagating backpressure", growth)
	}
	if first > 64*1024*1024 {
		cancel()
		_ = response.Body.Close()
		t.Fatalf("the provider wrote %d bytes before backpressure stopped it; that is far beyond any socket buffer", first)
	}

	// The pipeline must RESUME when the client reads again: a bounded buffer that never drains would be
	// the mirror defect.
	resume := make([]byte, 4096)
	if _, err := io.ReadFull(response.Body, resume); err != nil {
		cancel()
		_ = response.Body.Close()
		t.Fatalf("after the client resumed reading, the stream did not deliver bytes: %v", err)
	}
	if !strings.Contains(string(resume), "data: ") {
		cancel()
		_ = response.Body.Close()
		t.Fatalf("after resuming, the client received %q, which is not the provider's SSE bytes", string(resume[:min(len(resume), 80)]))
	}
	t.Logf("backpressure: resumed delivery after the client read 4096 bytes")

	cancel()
	_ = response.Body.Close()
	peer.requireClosed(t, "slow client cancel", 1, 5*time.Second)
	requireGoroutinesReturnTo(t, "slow client cancel", floor, 8, 5*time.Second)
	route.requireConnectionsClosed(t, "slow client cancel", 5*time.Second)
}

// ---------------------------------------------------------------- 9+7: cancel while blocked writing

// TestStreamingClientCancelWhileTheServerIsBlockedWritingToASlowClient is the hardest cancellation
// position: the route is blocked inside w.Write because the browser has stopped reading, so it is NOT
// sitting in a read that the context can interrupt. A user closing the tab at that moment must still
// close the upstream provider connection and release the handler. This is the case where a forwarder
// that only checks the context between reads, and never notices a failed write, would leak a goroutine
// and keep a provider billing.
func TestStreamingClientCancelWhileTheServerIsBlockedWritingToASlowClient(t *testing.T) {
	var written int64
	frame := "data: {\"filler\":\"" + strings.Repeat("y", 1024) + "\"}\n\n"
	peer := startRawStreamPeer(t, func(connection net.Conn, _ *bufio.Reader, _ []byte, _ int) {
		writePeerStreamHead(t, connection)
		for {
			if err := writePeerChunk(connection, frame); err != nil {
				return
			}
			atomic.AddInt64(&written, int64(len(frame)))
		}
	})
	route := newStreamingRoute(t)
	floor := goroutineFloor(3, 20*time.Millisecond)

	ctx, cancel := context.WithCancel(context.Background())
	response, err := route.postCUSTOM(ctx, peer.address(), "probe-stream-blocked-write")
	if err != nil {
		cancel()
		t.Fatalf("POST the streaming generate route: %v", err)
	}
	// Let the pipeline fill so the route is provably blocked in w.Write, then cancel from that state.
	time.Sleep(600 * time.Millisecond)
	first := atomic.LoadInt64(&written)
	time.Sleep(300 * time.Millisecond)
	second := atomic.LoadInt64(&written)
	if second-first > 256*1024 {
		cancel()
		_ = response.Body.Close()
		t.Fatalf("the provider advanced %d bytes while the client read nothing; the route never became write-blocked, so this case did not reach the state it exists for", second-first)
	}
	t.Logf("blocked-write: provider stalled at %d bytes (growth %d over 300ms), so the route is inside w.Write", second, second-first)

	unwindStart := time.Now()
	cancel()
	// The client's receive buffer already holds the bytes the route flushed before it blocked, so the
	// first reads after the cancel still return data with a nil error. Drain until the transport reports
	// the cancellation; that is what a browser-aborted reader eventually observes.
	buffer := make([]byte, 64*1024)
	var readErr error
	for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); {
		if _, err := response.Body.Read(buffer); err != nil {
			readErr = err
			break
		}
	}
	if readErr == nil || !isClientCancellation(readErr) {
		t.Errorf("after the client cancelled, draining the response returned %v; want a cancellation error", readErr)
	}
	_ = response.Body.Close()
	peer.requireClosed(t, "cancel while write-blocked", 1, 10*time.Second)
	t.Logf("blocked-write: client cancel unwound the blocked response write in %s", time.Since(unwindStart).Round(time.Millisecond))
	requireGoroutinesReturnTo(t, "cancel while write-blocked", floor, 8, 10*time.Second)
	route.requireConnectionsClosed(t, "cancel while write-blocked", 10*time.Second)
}

// ---------------------------------------------------------------- 7: cancel before provider headers

// TestStreamingClientCancelBeforeTheProviderAnswers adds the other cancellation position: the client
// aborts while the route is still waiting for the provider's response head. Nothing downstream has been
// written, so this is the path a user takes by pressing Stop while the model is still thinking. The
// assertions are the same socket facts: the provider sees its connection closed, the accepted
// downstream connection closes, and no goroutine is left holding the request.
func TestStreamingClientCancelBeforeTheProviderAnswers(t *testing.T) {
	peer := startRawStreamPeer(t, func(connection net.Conn, _ *bufio.Reader, _ []byte, _ int) {
		// Read the request and then say NOTHING: no status line, so the route is blocked waiting for the
		// provider's head, which transport.go bounds only by ResponseHeaderTimeout (120s).
	})
	route := newStreamingRoute(t)
	floor := goroutineFloor(3, 20*time.Millisecond)

	ctx, cancel := context.WithCancel(context.Background())
	requestResult := make(chan error, 1)
	go func() {
		response, err := route.postCUSTOM(ctx, peer.address(), "probe-stream-cancel-before-head")
		if err == nil {
			_ = response.Body.Close()
		}
		requestResult <- err
	}()
	// Wait until the provider has actually accepted the request, then cancel from that state. There is no
	// sleep-derived assumption here: the accept is counted by the peer.
	peer.requireOpened(t, "cancel before provider headers", 1, 10*time.Second)
	cancel()
	select {
	case err := <-requestResult:
		if err == nil {
			t.Fatalf("the client cancelled while the provider had sent no headers, but the request completed successfully")
		}
		if !isClientCancellation(err) {
			t.Fatalf("the cancelled request returned %v; want a cancellation error a user can classify", err)
		}
		t.Logf("cancel before provider headers: client saw %v", err)
	case <-time.After(5 * time.Second):
		t.Fatalf("the client cancelled while waiting for the provider's headers, but the request did not return within 5s")
	}
	peer.requireClosed(t, "cancel before provider headers", 1, 5*time.Second)
	requireGoroutinesReturnTo(t, "cancel before provider headers", floor, 8, 5*time.Second)
	route.requireConnectionsClosed(t, "cancel before provider headers", 5*time.Second)
}
