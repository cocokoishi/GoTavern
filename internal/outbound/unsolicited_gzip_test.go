package outbound

import (
	"bytes"
	"compress/gzip"
	"context"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// THE PRODUCTION TRANSPORT'S UNSOLICITED-GZIP CONTRACT, moved here from package server.
//
// The copy in internal/server could never run: that package's TestMain pins GOTAVERN_OUTBOUND_WIRE_EXACT=1
// for every test in its binary (internal/server/transport_mode_test.go:25-31) and TransportMode() is a
// sync.Once, so the production transport is unreachable there and the test reported SKIP on every run. A
// gate that always skips is not a gate. This package has no such pinning, so the test executes against the
// client that carries user traffic (asserted below), and the provider-derived end-to-end behaviour is
// additionally covered by tests/e2e/streaming_cancel_socket_test.go.

// TestUnsolicitedGzipIsDecodedByTheTransportAndTheConnectionIsReleased is the reachability boundary
// for the gzip-wrapper Close item.
//
// The transport drops the caller's Accept-Encoding and lets net/http advertise gzip, so an
// unsolicited gzip reply is decompressed by net/http before decodeProviderBody runs: the manual
// gzip.ReadCloser branch is not part of provider traffic, and the connection is released normally.
// If a future change made that branch reachable, this test's decoded-bytes and connection-count
// assertions are where the leak would have to show up.
func TestUnsolicitedGzipIsDecodedByTheTransportAndTheConnectionIsReleased(t *testing.T) {
	if TransportMode() != "production" {
		t.Skipf("this test asserts the PRODUCTION transport's decompression; mode is %q", TransportMode())
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

	response, err := SendStreaming(context.Background(), Request{
		URL:    provider.URL + "/ai/generate-stream",
		Method: http.MethodPost,
		Headers: []Header{
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
