package outbound

// A15 LANE C -- STREAMING OBSERVABLES: clean end, partial frames, and CANCELLATION THAT REACHES THE PEER.
//
// The pinned contract for a streaming completion (SillyTavern src/endpoints/backends/chat-completions.js:
// `const controller = new AbortController(); request.socket.on('close', () => controller.abort());` and
// src/util.js forwardFetchResponse, which destroys the remote body when the client socket closes) is that
// a browser disconnect ABORTS the provider request. It is not enough for our client to stop reading: the
// upstream peer must observe the abort, or the provider keeps generating (and billing) a reply nobody
// will read. These tests assert the observable at the PEER (its request context), and the clean-end
// contract that distinguishes a finished stream from a truncated one.

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// TestProductionTransportCancelAbortsTheUpstreamRequest is the pinned socket-close -> abort contract,
// measured at the PEER'S TCP CONNECTION: when the caller's context is cancelled mid-stream, the
// connection carrying the provider request must be closed, which is what pinned's
// `request.socket.on('close', () => controller.abort())` + `from.body.destroy()` accomplish
// (chat-completions.js:241-244, util.js forwardFetchResponse). A client that merely stops reading leaves
// the provider generating a reply nobody will read and billing for it.
//
// The peer is a raw TCP socket rather than an http.Handler on purpose: a Go server whose handler is
// blocked in select() does not observe a client disconnect until it writes, so an http.Handler would
// measure the server's detection latency, not whether our client closed the connection.
func TestProductionTransportCancelAbortsTheUpstreamRequest(t *testing.T) {
	const firstFrame = "data: {\"delta\":\"first\"}\n\n"
	peerAborted := make(chan struct{})
	peerServed := make(chan struct{})
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	go func() {
		connection, acceptErr := listener.Accept()
		if acceptErr != nil {
			return
		}
		defer connection.Close()
		_ = connection.SetReadDeadline(time.Now().Add(10 * time.Second))
		// Read the request head, then stream one SSE frame and wait for the client to close.
		head := make([]byte, 0, 4096)
		buffer := make([]byte, 512)
		for !strings.Contains(string(head), "\r\n\r\n") {
			count, readErr := connection.Read(buffer)
			if count > 0 {
				head = append(head, buffer[:count]...)
			}
			if readErr != nil {
				return
			}
		}
		_, _ = io.WriteString(connection, "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n")
		_, _ = fmt.Fprintf(connection, "%x\r\n%s\r\n", len(firstFrame), firstFrame)
		close(peerServed)
		// A blocking read returns as soon as the client closes its side: that IS the abort.
		_ = connection.SetReadDeadline(time.Now().Add(10 * time.Second))
		if _, readErr := connection.Read(buffer); readErr != nil {
			close(peerAborted)
		}
	}()

	ctx, cancel := context.WithCancel(context.Background())
	response, err := SendStreaming(ctx, Request{
		URL:    "http://" + listener.Addr().String() + "/v1/chat/completions",
		Method: http.MethodPost,
		Headers: []Header{
			{Name: "Content-Type", Value: "application/json"},
			{Name: "Accept", Value: "text/event-stream"},
		},
		Body: []byte("{}"),
	}, 0)
	if err != nil {
		cancel()
		t.Fatalf("send streaming: %v", err)
	}
	<-peerServed
	gotPrefix := make([]byte, len(firstFrame))
	if _, readErr := io.ReadFull(response.Stream, gotPrefix); readErr != nil {
		cancel()
		_ = response.Stream.Close()
		t.Fatalf("read the first frame: %v", readErr)
	}
	if string(gotPrefix) != firstFrame {
		t.Errorf("first frame = %q, want the ordered prefix the peer flushed", string(gotPrefix))
	}
	cancel()
	_ = response.Stream.Close()

	select {
	case <-peerAborted:
	case <-time.After(5 * time.Second):
		t.Fatal("the caller cancelled but the provider connection stayed open: the upstream request was not aborted (pinned's socket-close -> controller.abort() contract)")
	}
}

// TestProductionTransportStreamEndsCleanlyAfterPinnedDone guards the other half: a provider that finishes
// normally must end the caller's stream with EOF, and the frames (including the [DONE] sentinel) must be
// delivered byte for byte. A close that a caller cannot distinguish from a truncation is the defect the
// stream-termination oracle captured; here the transport's own answer is asserted.
func TestProductionTransportStreamEndsCleanlyAfterPinnedDone(t *testing.T) {
	const exchange = "data: {\"delta\":\"hi\"}\n\ndata: [DONE]\n\n"
	server, clientTLS := startProductionAuditServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, exchange)
	}))

	response, err := SendStreaming(context.Background(), providerRequest(server.URL+"/v1/chat/completions", []byte("{}"), clientTLS), 5*time.Second)
	if err != nil {
		t.Fatalf("send streaming: %v", err)
	}
	defer response.Stream.Close()
	body, readErr := io.ReadAll(response.Stream)
	if readErr != nil {
		t.Fatalf("a cleanly finished stream returned read error %v, want EOF", readErr)
	}
	if string(body) != exchange {
		t.Fatalf("stream = %q, want the provider's exact frames %q", string(body), exchange)
	}
	if !strings.HasSuffix(string(body), "data: [DONE]\n\n") {
		t.Fatalf("stream does not end in the pinned [DONE] sentinel: %q", tailOf(string(body), 80))
	}
	if response.Truncated {
		t.Fatal("a cleanly finished stream was marked Truncated")
	}
}

// TestProductionTransportDeliversAFrameSplitAcrossWrites: a provider (or a proxy) may split an SSE frame
// at any byte boundary. The transport must not re-frame, drop, or reorder the bytes; the SSE parser above
// it owns framing. This is the transport half of "partial SSE frames".
func TestProductionTransportDeliversAFrameSplitAcrossWrites(t *testing.T) {
	const whole = "data: {\"text\":\"split frame\"}\n\n"
	split := len(whole) / 2
	server, clientTLS := startProductionAuditServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, whole[:split])
		if flusher, ok := w.(http.Flusher); ok {
			flusher.Flush()
		}
		time.Sleep(20 * time.Millisecond)
		_, _ = io.WriteString(w, whole[split:])
	}))

	response, err := SendStreaming(context.Background(), providerRequest(server.URL+"/v1/chat/completions", []byte("{}"), clientTLS), 5*time.Second)
	if err != nil {
		t.Fatalf("send streaming: %v", err)
	}
	defer response.Stream.Close()
	body, readErr := io.ReadAll(response.Stream)
	if readErr != nil {
		t.Fatalf("read stream: %v", readErr)
	}
	if string(body) != whole {
		t.Fatalf("stream = %q, want the frame reassembled byte for byte %q", string(body), whole)
	}
	if response.Truncated {
		t.Fatal("a frame split across writes was reported as Truncated; a split is not a truncation")
	}
}

// TestProductionTransportTruncatedStreamIsNotACleanEnd is the control: a stream that ends inside a frame
// (hijacked close, no terminal chunk) must be reported as an error, not as EOF, so the layer above can
// emit the pinned error termination instead of a silent clean end.
func TestProductionTransportTruncatedStreamIsNotACleanEnd(t *testing.T) {
	var bytesWritten int64
	server, clientTLS := startProductionAuditServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, "data: {\"delta\":\"partial")
		if flusher, ok := w.(http.Flusher); ok {
			flusher.Flush()
		}
		atomic.AddInt64(&bytesWritten, 1)
		if hijacker, ok := w.(http.Hijacker); ok {
			if connection, _, err := hijacker.Hijack(); err == nil {
				_ = connection.Close()
			}
		}
	}))

	response, err := SendStreaming(context.Background(), providerRequest(server.URL+"/v1/chat/completions", []byte("{}"), clientTLS), 5*time.Second)
	if err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "closed") || strings.Contains(strings.ToLower(err.Error()), "eof") {
			return
		}
		t.Fatalf("send streaming: %v", err)
	}
	defer response.Stream.Close()
	if _, readErr := io.ReadAll(response.Stream); readErr == nil {
		t.Fatal("a stream cut mid-frame ended with EOF: a truncation is indistinguishable from a clean end")
	}
}

func tailOf(body string, length int) string {
	if len(body) <= length {
		return body
	}
	return body[len(body)-length:]
}
