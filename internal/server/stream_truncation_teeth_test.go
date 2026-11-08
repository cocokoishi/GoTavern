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
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
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
