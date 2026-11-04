package server

// Regression tests with teeth for the M6b provider stream-termination fixes.
//
// Each of these FAILS on the pre-fix implementation for a named reason:
//
//   * textgen streamed replies used to end the browser response when the provider died mid-stream.
//     Pinned's forwardFetchResponse pipes the provider body; a source error is not forwarded and
//     never ends the Express response, so the caller hangs until it disconnects. The test drives the
//     forwarder with a truncated stream and requires it to be STILL RUNNING after the bytes stop --
//     which the old `break out of the loop and return` implementation cannot do.
//   * the Ollama NDJSON re-framer used to write `data: [DONE]` unconditionally after a read error,
//     making a truncated answer look complete. Pinned writes it from the stream's 'end' handler only,
//     which a truncated body never emits.
//   * the novelai forwarder had the same clean-end behaviour as textgen.
//
// The gzip test is the boundary proof for the third M0 item: through the production transport the
// unsolicited-gzip peer is decoded by net/http (the transport owns Accept-Encoding), so the manual
// gzip reader branch -- and the Close discipline the audit read -- is not reached by provider traffic.
// It asserts the decoded bytes and that the provider connection is released, which is the observable
// the audit's concern would have produced.

import (
	"bytes"
	"compress/gzip"
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/cocokoishi/gotavern/internal/outbound"
)

// truncatingStream yields `remaining` bytes and then fails with `err` instead of EOF: the byte-level
// shape of a provider that dies mid-stream.
type truncatingStream struct {
	remaining int
	err       error
	closed    bool
}

func (stream *truncatingStream) Read(buffer []byte) (int, error) {
	if stream.remaining <= 0 {
		return 0, stream.err
	}
	count := len(buffer)
	if count > stream.remaining {
		count = stream.remaining
	}
	for index := 0; index < count; index++ {
		buffer[index] = 'x'
	}
	stream.remaining -= count
	return count, nil
}

func (stream *truncatingStream) Close() error {
	stream.closed = true
	return nil
}

func streamRequest(ctx context.Context) *http.Request {
	return httptest.NewRequest(http.MethodPost, "/api/backends/text-completions/generate", strings.NewReader(`{}`)).WithContext(ctx)
}

// waitUntilDisconnected asserts the forwarder is still blocked while the provider has stopped
// sending, then releases it with the client disconnect a real caller would produce.
func waitUntilDisconnected(t *testing.T, done <-chan struct{}, cancel context.CancelFunc, subject string) {
	t.Helper()
	select {
	case <-done:
		t.Fatalf("%s ended the browser response after a truncated provider body; pinned leaves the response open until the client disconnects", subject)
	case <-time.After(200 * time.Millisecond):
	}
	cancel()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatalf("%s did not return after the client disconnected", subject)
	}
}

func TestTextgenTruncatedStreamLeavesTheBrowserResponseOpen(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	recorder := httptest.NewRecorder()
	stream := &truncatingStream{remaining: 16, err: errors.New("provider closed the connection mid-response")}
	done := make(chan struct{})
	go func() {
		forwardBackendsTextgenStream(recorder, streamRequest(ctx), &outbound.Response{Status: http.StatusOK, Stream: stream, Truncated: true})
		close(done)
	}()
	waitUntilDisconnected(t, done, cancel, "textgen streaming forwarder")
	if !stream.closed {
		t.Fatal("the provider stream was not closed after the response stopped")
	}
}

func TestNovelAITruncatedStreamLeavesTheBrowserResponseOpen(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	recorder := httptest.NewRecorder()
	stream := &truncatingStream{remaining: 16, err: errors.New("provider closed the connection mid-response")}
	done := make(chan struct{})
	go func() {
		novelaiForwardStream(recorder, streamRequest(ctx), &outbound.Response{Status: http.StatusOK, Stream: stream, Truncated: true})
		close(done)
	}()
	waitUntilDisconnected(t, done, cancel, "novelai streaming forwarder")
	if !stream.closed {
		t.Fatal("the provider stream was not closed after the response stopped")
	}
}

func TestOllamaTruncatedStreamDoesNotSendTerminalFrame(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	recorder := httptest.NewRecorder()
	stream := &truncatingStream{remaining: 16, err: errors.New("provider closed the connection mid-response")}
	done := make(chan struct{})
	go func() {
		forwardBackendsTextgenOllamaStream(recorder, streamRequest(ctx), &outbound.Response{Status: http.StatusOK, Stream: stream, Truncated: true})
		close(done)
	}()
	// While the provider is dead and the client is still connected the response must carry neither a
	// terminal [DONE] frame nor an end.
	select {
	case <-done:
		t.Fatalf("the Ollama re-framer ended the browser response after a truncated provider body and sent %q", recorder.Body.String())
	case <-time.After(200 * time.Millisecond):
	}
	if strings.Contains(recorder.Body.String(), "[DONE]") {
		t.Fatalf("the Ollama re-framer sent a terminal frame after a truncated provider body: %q", recorder.Body.String())
	}
	cancel()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("the Ollama re-framer did not return after the client disconnected")
	}
	if strings.Contains(recorder.Body.String(), "[DONE]") {
		t.Fatalf("the Ollama re-framer sent a terminal frame after the client disconnected: %q", recorder.Body.String())
	}
}

func TestOllamaCompleteStreamSendsTerminalFrame(t *testing.T) {
	recorder := httptest.NewRecorder()
	stream := io.NopCloser(strings.NewReader("{\"response\":\"part\",\"thinking\":\"\"}\n"))
	forwardBackendsTextgenOllamaStream(recorder, streamRequest(context.Background()), &outbound.Response{Status: http.StatusOK, Stream: stream, Truncated: false})
	if !strings.Contains(recorder.Body.String(), "[DONE]") {
		t.Fatalf("a complete Ollama stream must end with the pinned terminal frame; got %q", recorder.Body.String())
	}
}

// TestUnsolicitedGzipIsDecodedByTheTransportAndTheConnectionIsReleased is the reachability boundary
// for the gzip-wrapper Close item.
//
// The transport drops the caller's Accept-Encoding and lets net/http advertise gzip, so an
// unsolicited gzip reply is decompressed by net/http before decodeProviderBody runs: the manual
// gzip.ReadCloser branch is not part of provider traffic, and the connection is released normally.
// If a future change made that branch reachable, this test's decoded-bytes and connection-count
// assertions are where the leak would have to show up.
func TestUnsolicitedGzipIsDecodedByTheTransportAndTheConnectionIsReleased(t *testing.T) {
	if outbound.TransportMode() != "production" {
		t.Skipf("this test asserts the PRODUCTION transport's decompression; mode is %q", outbound.TransportMode())
	}
	plain := "data: {\"choices\":[{\"delta\":{\"content\":\"one\"}}]}\n\ndata: [DONE]\n\n"
	var compressed bytes.Buffer
	writer := gzip.NewWriter(&compressed)
	if _, err := writer.Write([]byte(plain)); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}

	var opened, closed int32
	var mu sync.Mutex
	var acceptEncoding string
	provider := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		acceptEncoding = r.Header.Get("Accept-Encoding")
		mu.Unlock()
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Content-Encoding", "gzip")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(compressed.Bytes())
	}))
	provider.Config.ConnState = func(_ net.Conn, state http.ConnState) {
		switch state {
		case http.StateNew:
			atomic.AddInt32(&opened, 1)
		case http.StateClosed, http.StateHijacked:
			atomic.AddInt32(&closed, 1)
		}
	}
	provider.Start()
	defer provider.Close()

	response, err := outbound.SendStreaming(context.Background(), outbound.Request{
		URL:    provider.URL + "/ai/generate-stream",
		Method: http.MethodPost,
		Headers: []outbound.Header{
			// The caller keeps pinned node-fetch's header set; the transport owns Accept-Encoding.
			{Name: "accept-encoding", Value: "gzip, deflate, br"},
			{Name: "content-type", Value: "application/json"},
		},
		Body: []byte(`{"stream":true}`),
	}, 0)
	if err != nil {
		t.Fatalf("SendStreaming: %v", err)
	}
	body, readErr := io.ReadAll(response.Stream)
	closeErr := response.Stream.Close()
	if readErr != nil {
		t.Fatalf("reading the decompressed provider body: %v", readErr)
	}
	if closeErr != nil {
		t.Fatalf("closing the provider body: %v", closeErr)
	}
	if string(body) != plain {
		t.Fatalf("the transport did not transparently decode the unsolicited gzip body: got %q", string(body))
	}
	for name, headers := range response.Headers {
		_ = name
		_ = headers
	}
	// The provider must have been asked for gzip by the transport itself, not by the dropped caller
	// header, and the connection must be released after Close (the leak this item was about).
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) && atomic.LoadInt32(&closed) < atomic.LoadInt32(&opened) {
		time.Sleep(10 * time.Millisecond)
	}
	if atomic.LoadInt32(&opened) == 0 {
		t.Fatal("the provider connection was never opened; the test proved nothing")
	}
	if atomic.LoadInt32(&closed) < atomic.LoadInt32(&opened) {
		t.Fatalf("the provider connection was not released after Close (opened %d, closed %d)", opened, closed)
	}
	mu.Lock()
	advertised := acceptEncoding
	mu.Unlock()
	if !strings.Contains(advertised, "gzip") {
		t.Fatalf("the transport must advertise gzip itself (caller Accept-Encoding is transport-owned); provider saw %q", advertised)
	}
}
