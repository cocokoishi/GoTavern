package app

// The HTTP server's timeout configuration is compatibility behaviour, not a
// tuning knob: pinned Node's defaults decide when a stalled peer is closed, and
// the response side must stay unbounded because SSE must not be cut. These tests
// pin the values and then drive the two behaviours the values exist for.

import (
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"testing"
	"time"
)

// TestHTTPServerUsesPinnedNodeDefaults pins every field against Node 20's
// documented defaults (headersTimeout 60000 ms, keepAliveTimeout 5000 ms,
// maxHeaderSize 16384 bytes) and pins the two deliberate ZEROS: WriteTimeout
// (SSE) and ReadTimeout (Node's requestTimeout bounds the whole request,
// including the body, and is not mapped).
func TestHTTPServerUsesPinnedNodeDefaults(t *testing.T) {
	server := newHTTPServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	if got, want := server.ReadHeaderTimeout, 60*time.Second; got != want {
		t.Fatalf("ReadHeaderTimeout = %s, want the pinned Node headersTimeout %s", got, want)
	}
	if got, want := server.IdleTimeout, 5*time.Second; got != want {
		t.Fatalf("IdleTimeout = %s, want the pinned Node keepAliveTimeout %s", got, want)
	}
	if got, want := server.MaxHeaderBytes, 16<<10; got != want {
		t.Fatalf("MaxHeaderBytes = %d, want the pinned Node maxHeaderSize %d", got, want)
	}
	if server.WriteTimeout != 0 {
		t.Fatalf("WriteTimeout = %s, want 0: a write deadline would cut SSE/streaming responses", server.WriteTimeout)
	}
	if server.ReadTimeout != 0 {
		t.Fatalf("ReadTimeout = %s, want 0: Node's requestTimeout is not mapped because it would bound every upload body", server.ReadTimeout)
	}
	if server.Handler == nil {
		t.Fatal("the server has no handler")
	}
}

// startPinnedHTTPServer serves handler on a loopback listener using the real
// construction path, with an optional per-test tweak (used only to shorten the
// production 60 s header timeout so the slow-peer test is not a 60 s test).
func startPinnedHTTPServer(t *testing.T, handler http.Handler, tweak func(*http.Server)) (string, func()) {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	server := newHTTPServer(handler)
	if tweak != nil {
		tweak(server)
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		_ = server.Serve(listener)
	}()
	stop := func() {
		_ = server.Close()
		select {
		case <-done:
		case <-time.After(10 * time.Second):
			t.Fatalf("the HTTP server did not stop after Close")
		}
	}
	return "http://" + listener.Addr().String(), stop
}

// TestHTTPServerClosesAStalledHeaderWriterAndKeepsServing drives the pinned
// headersTimeout: a client that sends a partial request head and then stops is
// closed, and the listener keeps serving other clients. The deadline is
// shortened HERE ONLY for test duration; the production value is the first test.
func TestHTTPServerClosesAStalledHeaderWriterAndKeepsServing(t *testing.T) {
	url, stop := startPinnedHTTPServer(t,
		http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
			writer.WriteHeader(http.StatusNoContent)
		}),
		func(server *http.Server) { server.ReadHeaderTimeout = 150 * time.Millisecond },
	)
	defer stop()

	conn, err := net.Dial("tcp", strings.TrimPrefix(url, "http://"))
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close()
	// A complete request line and one header name, deliberately never terminated:
	// the server must give up waiting for the empty line that ends the head.
	if _, err := io.WriteString(conn, "GET / HTTP/1.1\r\nHost: localhost\r\nX-Stalled: "); err != nil {
		t.Fatalf("write partial header: %v", err)
	}
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	buffer := make([]byte, 64)
	if _, err := conn.Read(buffer); err == nil {
		t.Fatal("a stalled header writer received a response; the header deadline did not close it")
	} else {
		var netErr net.Error
		if errors.As(err, &netErr) && netErr.Timeout() {
			t.Fatalf("the server did not close the stalled header connection before the client's own deadline")
		}
	}

	// THE LISTENER KEEPS SERVING after the stalled peer was dropped.
	client := &http.Client{Timeout: 5 * time.Second}
	response, err := client.Get(url + "/")
	if err != nil {
		t.Fatalf("the server stopped serving after closing a stalled header writer: %v", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusNoContent {
		t.Fatalf("post-timeout request status = %d, want 204", response.StatusCode)
	}
}

// TestHTTPServerStreamingResponseCompletesWithoutWriteTimeout drives the zero
// WriteTimeout: a response that writes, flushes and then waits before writing
// again must deliver BOTH events. Any non-zero WriteTimeout would cut the
// second write and the body would be missing it.
func TestHTTPServerStreamingResponseCompletesWithoutWriteTimeout(t *testing.T) {
	handler := http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writer.Header().Set("Content-Type", "text/event-stream")
		writer.Header().Set("Cache-Control", "no-cache")
		writer.WriteHeader(http.StatusOK)
		flusher, _ := writer.(http.Flusher)
		fmt.Fprint(writer, "data: one\n\n")
		if flusher != nil {
			flusher.Flush()
		}
		time.Sleep(30 * time.Millisecond)
		fmt.Fprint(writer, "data: two\n\n")
		if flusher != nil {
			flusher.Flush()
		}
	})
	url, stop := startPinnedHTTPServer(t, handler, nil)
	defer stop()

	client := &http.Client{Timeout: 5 * time.Second}
	response, err := client.Get(url + "/events")
	if err != nil {
		t.Fatalf("streaming request: %v", err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatalf("read streaming body: %v", err)
	}
	if !strings.Contains(string(body), "data: one") || !strings.Contains(string(body), "data: two") {
		t.Fatalf("a streaming response was cut before both events arrived: %q", body)
	}
	if response.StatusCode != http.StatusOK {
		t.Fatalf("streaming status = %d, want 200", response.StatusCode)
	}
}
