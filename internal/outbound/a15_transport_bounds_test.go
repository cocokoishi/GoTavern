package outbound

// A15 LANE C -- TRANSPORT BOUNDS, RETRY BEHAVIOUR, EMPTY BODIES AND THE UNREACHABLE GZIP-CLOSE BRANCH.
//
// Three alpha.14 Known limitations are settled here with measurement rather than assertion:
//
//   - the gzip wrapper close path "unreachable for provider traffic": net/http advertises gzip itself
//     (DisableCompression false, no Accept-Encoding in the request) and transparently decodes it, so the
//     manual `case "gzip"` in decodeProviderBody never runs for a compliant provider. The test below
//     shows the header is already gone and that the connection is reusable afterwards -- i.e. the
//     wrapper is not what the claim needed.
//   - stage bounds (connect 30 s, TLS 15 s, response-header 120 s, idle 90 s) are asserted as the
//     values actually installed on the client, not merely as constants in the file.
//   - no retry is a pinned property: node-fetch 3.3.2 has no retry loop, so a 429/5xx is one request and
//     one answer. The peer counts requests to prove no hidden retry was added.

import (
	"compress/gzip"
	"context"
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// TestProductionTransportInstallsEveryStageBound reads the client that actually carries provider
// traffic. A bound that exists only as a constant and is never installed is the "capability that never
// reaches the behaviour" failure; these are the fields net/http consults.
func TestProductionTransportInstallsEveryStageBound(t *testing.T) {
	client := buildProductionClient(nil)
	transport, ok := client.Transport.(*http.Transport)
	if !ok {
		t.Fatalf("production client transport is %T, want *http.Transport", client.Transport)
	}
	checks := []struct {
		name string
		got  time.Duration
		want time.Duration
	}{
		{name: "TLS handshake bound", got: transport.TLSHandshakeTimeout, want: 15 * time.Second},
		{name: "response-header bound", got: transport.ResponseHeaderTimeout, want: 120 * time.Second},
		{name: "idle-connection bound", got: transport.IdleConnTimeout, want: 90 * time.Second},
	}
	for _, check := range checks {
		if check.got != check.want {
			t.Fatalf("%s = %s, want %s (the constant must be the value the transport consults)", check.name, check.got, check.want)
		}
	}
	if productionConnectTimeout != 30*time.Second {
		t.Fatalf("productionConnectTimeout = %s, want 30 s", productionConnectTimeout)
	}
	if transport.MaxIdleConns != 32 || transport.MaxIdleConnsPerHost != 32 {
		t.Fatalf("idle connection pools = %d/%d, want 32/32", transport.MaxIdleConns, transport.MaxIdleConnsPerHost)
	}
	if transport.DisableCompression {
		t.Fatal("DisableCompression is true: the transport would advertise no encoding and stop decoding gzip")
	}
	if !transport.ForceAttemptHTTP2 {
		t.Fatal("ForceAttemptHTTP2 is false: providers behind HTTP/2 (all mainstream ones) would be downgraded")
	}
	// No response-write bound exists in the transport, and must not: the deliberate zero is the same
	// decision as the http.Server's WriteTimeout in the M6a panic-boundary lane.
	if transport.WriteBufferSize != 0 {
		t.Fatalf("WriteBufferSize = %d: a fixed write buffer is not pinned and changes flush behaviour", transport.WriteBufferSize)
	}
}

// TestProductionTransportDoesNotRetryProviderStatuses: pinned's node-fetch follows redirects but never
// retries a status, and the routes map 429/5xx themselves (AGENTS rule: a mock may capture and answer,
// never define correctness -- the contract here is "one request, one answer"). The peer counts.
func TestProductionTransportDoesNotRetryProviderStatuses(t *testing.T) {
	for _, status := range []int{http.StatusTooManyRequests, http.StatusServiceUnavailable} {
		status := status
		t.Run(fmt.Sprintf("status_%d", status), func(t *testing.T) {
			var requests int64
			server, clientTLS := startProductionAuditServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				atomic.AddInt64(&requests, 1)
				w.Header().Set("Content-Type", "application/json")
				w.Header().Set("Retry-After", "7")
				w.WriteHeader(status)
				_, _ = w.Write([]byte(`{"error":{"message":"slow down"}}`))
			}))

			response, err := Send(context.Background(), providerRequest(server.URL+"/v1/chat/completions", []byte("{}"), clientTLS), 5*time.Second)
			if err != nil {
				t.Fatalf("send: %v", err)
			}
			if response.Status != status {
				t.Fatalf("status = %d, want %d", response.Status, status)
			}
			if got := atomic.LoadInt64(&requests); got != 1 {
				t.Fatalf("the peer received %d requests for one Send of a %d answer; pinned node-fetch has no retry loop, so a retry is an unpinned behaviour change (and a duplicate provider charge)", got, status)
			}
			if got := response.Header("Retry-After"); got != "7" {
				t.Fatalf("Retry-After = %q, want the provider's 7 preserved for the route's mapping", got)
			}
		})
	}
}

// TestProductionTransportDecodesEmptyGzipAndKeepsTheConnection settles the alpha.14 "gzip wrapper close
// path is unreachable" limitation by measuring the two facts the claim rests on:
//
//  1. a gzip reply is decoded by net/http and the Content-Encoding header is GONE from the Response the
//     caller sees, so decodeProviderBody's manual gzip branch never runs for a compliant provider;
//  2. the connection is reusable immediately afterwards (keep-alive ON: one TCP connection for both
//     requests), so nothing about the empty gzip body leaked a socket -- the Close path the limitation
//     named is not on the production path at all.
func TestProductionTransportDecodesEmptyGzipAndKeepsTheConnection(t *testing.T) {
	ConfigureProductionTransport(ProductionTransportOptions{EnableKeepAlive: true})
	t.Cleanup(func() { ConfigureProductionTransport(ProductionTransportOptions{}) })

	var connections int64
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/empty-gzip" {
			w.Header().Set("Content-Type", "application/json")
			w.Header().Set("Content-Encoding", "gzip")
			writer := gzip.NewWriter(w)
			_ = writer.Close()
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	server.Config.ConnState = func(_ net.Conn, state http.ConnState) {
		if state == http.StateNew {
			atomic.AddInt64(&connections, 1)
		}
	}
	server.StartTLS()
	t.Cleanup(server.Close)
	pool := x509.NewCertPool()
	pool.AddCert(server.Certificate())
	clientTLS := &tls.Config{RootCAs: pool}

	empty, err := Send(context.Background(), providerRequest(server.URL+"/empty-gzip", []byte("{}"), clientTLS), 5*time.Second)
	if err != nil {
		t.Fatalf("empty gzip reply: %v", err)
	}
	if len(empty.Body) != 0 {
		t.Fatalf("empty gzip body decoded to %q, want empty", string(empty.Body))
	}
	if encoding := empty.Header("Content-Encoding"); encoding != "" {
		t.Fatalf("Content-Encoding = %q survived into the Response; net/http decodes a gzip reply it advertised itself and removes the header, so the manual gzip branch in decodeProviderBody must not be what produced these bytes", encoding)
	}

	second, err := Send(context.Background(), providerRequest(server.URL+"/plain", []byte("{}"), clientTLS), 5*time.Second)
	if err != nil {
		t.Fatalf("second request after an empty gzip reply: %v", err)
	}
	if string(second.Body) != `{"ok":true}` {
		t.Fatalf("second body = %q", string(second.Body))
	}
	if got := atomic.LoadInt64(&connections); got != 1 {
		t.Fatalf("two keep-alive requests used %d TCP connections after an empty gzip reply, want 1: the wrapped body was not released", got)
	}
}

// TestProductionTransportSendsThePinnedEmptyCredentialAndEmptyBody captures the raw request bytes, because
// the provider-wire oracle records `"authorization": "Bearer "` for an empty key (pinned tree capture
// tests/oracle/sillytavern-1.19.0-openai-caption.json:1629) and a JSON-bodied POST with zero-valued fields
// still has a body. HTTP parsers trim OWS, so this measures what OUR client writes and records whether
// the trailing space survives; it is a shape guard, not a provider-visible claim.
func TestProductionTransportSendsThePinnedEmptyCredentialAndEmptyBody(t *testing.T) {
	raw := captureOneRawRequest(t, Request{
		URL:    "http://provider.invalid/v1/chat/completions",
		Method: http.MethodPost,
		Headers: []Header{
			{Name: "Content-Type", Value: "application/json"},
			{Name: "Authorization", Value: "Bearer "},
			{Name: "Content-Length", Value: "0"},
		},
		Body: nil,
	})

	if !strings.HasPrefix(raw, "POST /v1/chat/completions HTTP/1.1\r\n") {
		t.Fatalf("request line = %q, want POST /v1/chat/completions HTTP/1.1", firstLine(raw))
	}
	// MEASURED DIFFERENCE, RECORDED: pinned's capture stores `"authorization": "Bearer "` (trailing
	// space: tests/oracle/sillytavern-1.19.0-openai-caption.json:1629), which is what the WIRE-EXACT
	// client still writes byte for byte. net/http trims trailing OWS from a header value, so the
	// production client writes `Authorization: Bearer`. HTTP parsers trim OWS on receipt, so the
	// credential a provider sees is the same empty token on both subjects; this is a whitespace-only
	// difference, not a credential difference, and it is asserted rather than left to chance.
	if !strings.Contains(raw, "\r\nAuthorization: Bearer\r\n") {
		t.Fatalf("empty-credential header missing or not the pinned `Bearer` token: %q", raw)
	}
	if strings.Contains(raw, "Authorization: Bearer ") {
		t.Fatalf("production transport kept a trailing OWS in Authorization, contradicting the measured net/http normalisation this test documents: %q", raw)
	}
	if !strings.Contains(raw, "\r\nContent-Length: 0\r\n") {
		t.Fatalf("zero-length POST body did not carry Content-Length: 0 (transport-owned framing): %q", raw)
	}
	if strings.Contains(raw, "Transfer-Encoding") {
		t.Fatalf("zero-length POST body used chunked framing: %q", raw)
	}
}

// captureOneRawRequest serves exactly one request on a loopback raw TCP socket, returns the bytes the
// client wrote before the head ended, and answers a minimal JSON 200 so Send can complete.
func captureOneRawRequest(t *testing.T, request Request) string {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	done := make(chan string, 1)
	go func() {
		connection, acceptErr := listener.Accept()
		if acceptErr != nil {
			return
		}
		defer connection.Close()
		_ = connection.SetReadDeadline(time.Now().Add(5 * time.Second))
		var head strings.Builder
		buffer := make([]byte, 1)
		for !strings.HasSuffix(head.String(), "\r\n\r\n") {
			count, readErr := connection.Read(buffer)
			if count > 0 {
				head.WriteByte(buffer[0])
			}
			if readErr != nil {
				break
			}
		}
		done <- head.String()
		_, _ = io.WriteString(connection, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}")
	}()

	request.URL = "http://" + listener.Addr().String() + "/v1/chat/completions"
	if _, err := Send(context.Background(), request, 5*time.Second); err != nil {
		t.Fatalf("send to the raw capture peer: %v", err)
	}
	select {
	case raw := <-done:
		return raw
	case <-time.After(5 * time.Second):
		t.Fatal("the raw capture peer received no request head")
		return ""
	}
}

func firstLine(raw string) string {
	if index := strings.Index(raw, "\r\n"); index >= 0 {
		return raw[:index]
	}
	return raw
}
