package outbound

// THE PRODUCTION TRANSPORT MATRIX, WRITTEN TO FAIL AGAINST THE HAND-WRITTEN CLIENT.
//
// `raw.go` was written to reproduce pinned's request BYTES for the provider-wire oracle, and it is
// correct for that. It was then used to carry user traffic, where its contract is a different one, and
// the oracle could not see the difference: the recording peer is plain HTTP, answers complete bodies,
// never compresses, never redirects and never stalls. docs/network-egress.md measured eight gaps (D1-D8);
// this file turns the user-visible ones into assertions so that the fix has something to fail against
// (AGENTS.md rule 31: every bug is reproduced before it is fixed, and the reproducer must fail for the
// right reason).
//
// Every case here is red on the commit that adds this file, except the four marked GUARD, which were
// already correct and exist so that the replacement transport cannot regress them. Assertions are on the
// OBSERVABLE a user cares about -- the bytes the caller receives, and the error text it gets when there
// are none -- never on how the client is built.

import (
	"bytes"
	"compress/gzip"
	"compress/zlib"
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// startProductionAuditServer is a TLS server with its certificate trusted by the returned client config.
// The pattern is the same one tls_test.go already uses, so a failure here is about the transport's HTTP
// behaviour rather than about trust.
func startProductionAuditServer(t *testing.T, handler http.Handler) (*httptest.Server, *tls.Config) {
	t.Helper()
	server := httptest.NewUnstartedServer(handler)
	server.StartTLS()
	t.Cleanup(server.Close)
	pool := x509.NewCertPool()
	pool.AddCert(server.Certificate())
	return server, &tls.Config{RootCAs: pool}
}

// providerRequest builds the request shape the planners build: the caller owns Host and Content-Length
// because the wire-exact client writes the head verbatim. The production transport must tolerate both and
// own the framing itself.
func providerRequest(serverURL string, body []byte, clientTLS *tls.Config) Request {
	// The authority ALONE. Trimming the scheme off the whole URL yields
	// "127.0.0.1:PORT/v1/chat/completions", which the server rejects as a malformed Host before the
	// handler runs, so every assertion below would fail for a reason unrelated to what it measures.
	parsed, parseErr := url.Parse(serverURL)
	if parseErr != nil {
		panic("providerRequest: " + parseErr.Error())
	}
	return Request{
		URL:    serverURL,
		Method: http.MethodPost,
		Headers: []Header{
			{Name: "Host", Value: parsed.Host},
			{Name: "Content-Type", Value: "application/json"},
			{Name: "Content-Length", Value: fmt.Sprintf("%d", len(body))},
		},
		Body:      body,
		TLSConfig: clientTLS,
	}
}

const auditJSON = `{"choices":[{"message":{"content":"OK"}}]}`

// TestProductionTransportDecompressesGzipJSON is P0-A's primary shape. Every chat planner sends
// `accept-encoding: gzip, deflate, br` (chat_completions.go:670, deepseek_chat.go:323 and ten siblings)
// and the client decompresses nothing, so a compressing edge hands the JSON parse gzip bytes and the
// user is told the provider cannot be reached.
func TestProductionTransportDecompressesGzipJSON(t *testing.T) {
	server, clientTLS := startProductionAuditServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Content-Encoding", "gzip")
		writer := gzip.NewWriter(w)
		_, _ = writer.Write([]byte(auditJSON))
		_ = writer.Close()
	}))

	response, err := Send(context.Background(), providerRequest(server.URL+"/v1/chat/completions", []byte("{}"), clientTLS), 5*time.Second)
	if err != nil {
		t.Fatalf("send: %v", err)
	}
	if string(response.Body) != auditJSON {
		t.Fatalf("body = %q, want the DECODED provider JSON %q: gzip was not decompressed", string(response.Body), auditJSON)
	}
}

// TestProductionTransportDecompressesDeflateJSON covers the second encoding the planners advertise.
func TestProductionTransportDecompressesDeflateJSON(t *testing.T) {
	server, clientTLS := startProductionAuditServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Content-Encoding", "deflate")
		writer := zlib.NewWriter(w)
		_, _ = writer.Write([]byte(auditJSON))
		_ = writer.Close()
	}))

	response, err := Send(context.Background(), providerRequest(server.URL+"/v1/chat/completions", []byte("{}"), clientTLS), 5*time.Second)
	if err != nil {
		t.Fatalf("send: %v", err)
	}
	if string(response.Body) != auditJSON {
		t.Fatalf("body = %q, want the DECODED provider JSON %q: deflate was not decompressed", string(response.Body), auditJSON)
	}
}

// TestProductionTransportDecodesGzipOverChunkedFraming is the case that stops a half-fix. A transport
// that decompresses a Content-Length body but mishandles chunked framing passes the gzip test above and
// still fails every real streaming provider, so the two are asserted separately and TOGETHER.
func TestProductionTransportDecodesGzipOverChunkedFraming(t *testing.T) {
	const frames = "data: {\"delta\":\"OK\"}\n\ndata: [DONE]\n\n"
	server, clientTLS := startProductionAuditServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Content-Encoding", "gzip")
		// No Content-Length and an explicit flush: the reply is chunked, and the gzip stream is written
		// ACROSS chunk boundaries.
		w.WriteHeader(http.StatusOK)
		if flusher, ok := w.(http.Flusher); ok {
			flusher.Flush()
		}
		writer := gzip.NewWriter(w)
		_, _ = writer.Write([]byte(frames[:10]))
		_ = writer.Flush()
		if flusher, ok := w.(http.Flusher); ok {
			flusher.Flush()
		}
		_, _ = writer.Write([]byte(frames[10:]))
		_ = writer.Close()
	}))

	response, err := SendStreaming(context.Background(), providerRequest(server.URL+"/v1/chat/completions", []byte("{}"), clientTLS), 5*time.Second)
	if err != nil {
		t.Fatalf("send: %v", err)
	}
	defer response.Stream.Close()
	body, readErr := io.ReadAll(response.Stream)
	if readErr != nil {
		t.Fatalf("read stream: %v", readErr)
	}
	if string(body) != frames {
		t.Fatalf("stream = %q, want the DECODED SSE frames %q: gzip over chunked framing was not decoded", string(body), frames)
	}
}

// TestProductionTransportDoesNotAdvertiseAnEncodingItCannotDecode is the other half of D2. Advertising
// `br` without a brotli decoder invites a compliant edge to send bytes we cannot read. A transport that
// cannot decode an encoding must not ask for it.
func TestProductionTransportDoesNotAdvertiseAnEncodingItCannotDecode(t *testing.T) {
	var seen atomic.Value
	seen.Store("")
	server, clientTLS := startProductionAuditServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen.Store(r.Header.Get("Accept-Encoding"))
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(auditJSON))
	}))

	// The planners advertise all three encodings (deepseek_chat.go:323 and eleven siblings), so the
	// request supplies exactly that. What the server must then see is a list the client can DECODE.
	request := providerRequest(server.URL+"/v1/chat/completions", []byte("{}"), clientTLS)
	request.Headers = append(request.Headers, Header{Name: "Accept-Encoding", Value: "gzip, deflate, br"})
	if _, err := Send(context.Background(), request, 5*time.Second); err != nil {
		t.Fatalf("send: %v", err)
	}
	advertised := strings.ToLower(strings.TrimSpace(seen.Load().(string)))
	if strings.Contains(advertised, "br") {
		t.Fatalf("Accept-Encoding = %q: the client advertises br but has no brotli decoder, so a compliant edge may send bytes it cannot read", advertised)
	}
	if !strings.Contains(advertised, "gzip") {
		t.Fatalf("Accept-Encoding = %q: the client should still negotiate an encoding it CAN decode", advertised)
	}
}

// TestProductionTransportReportsAnUndecodableEncodingCausally covers the server that sends brotli anyway.
// The user must be told what happened; a decode failure deep inside a JSON parser reads as "cannot
// connect", which is the P0 symptom (rule 35: errors are causal).
func TestProductionTransportReportsAnUndecodableEncodingCausally(t *testing.T) {
	server, clientTLS := startProductionAuditServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Content-Encoding", "br")
		_, _ = w.Write([]byte("\x1b\x2e\x00\xe2\x9c\x00not-really-brotli"))
	}))

	response, err := Send(context.Background(), providerRequest(server.URL+"/v1/chat/completions", []byte("{}"), clientTLS), 5*time.Second)
	if err == nil {
		t.Fatalf("body = %q: an undecodable content-encoding was returned as if it were the provider's answer", string(response.Body))
	}
	message := strings.ToLower(err.Error())
	if !strings.Contains(message, "content-encoding") && !strings.Contains(message, "encoding") {
		t.Fatalf("error = %v, want it to NAME the undecodable content-encoding", err)
	}
}

// TestProductionTransportFollowsARedirect covers D4: a provider or CDN edge that answers 3xx must be
// followed, not handed back as a body the JSON parser then rejects.
func TestProductionTransportFollowsARedirect(t *testing.T) {
	// A RELATIVE Location, so the handler needs no handle on the server it is running in.
	server, clientTLS := startProductionAuditServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/moved" {
			http.Redirect(w, r, "/v1/chat/completions", http.StatusTemporaryRedirect)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(auditJSON))
	}))

	response, err := Send(context.Background(), providerRequest(server.URL+"/moved", []byte("{}"), clientTLS), 5*time.Second)
	if err != nil {
		t.Fatalf("send: %v", err)
	}
	if string(response.Body) != auditJSON {
		t.Fatalf("body = %q after a redirect, want the final provider JSON %q", string(response.Body), auditJSON)
	}
}

// TestProductionTransportReusesConnections covers D5. Every message currently pays a fresh TCP+TLS
// handshake, which is both slow and hostile to providers that rate-limit connection churn.
func TestProductionTransportReusesConnections(t *testing.T) {
	var connections int64
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(auditJSON))
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

	for attempt := 0; attempt < 2; attempt++ {
		response, err := Send(context.Background(), providerRequest(server.URL+"/v1/chat/completions", []byte("{}"), clientTLS), 5*time.Second)
		if err != nil {
			t.Fatalf("send %d: %v", attempt, err)
		}
		if string(response.Body) != auditJSON {
			t.Fatalf("send %d body = %q", attempt, string(response.Body))
		}
	}
	if got := atomic.LoadInt64(&connections); got != 1 {
		t.Fatalf("%d TCP connections for 2 sequential requests, want 1: the transport does not keep connections alive", got)
	}
}

// TestProductionTransportSurfacesAMidStreamCloseCausally covers the abrupt close. The pinned behaviour
// is to leave the caller hanging, which this package reproduces deliberately for parity -- but a real
// provider dying mid-reply must be distinguishable from a finished stream, and the error must say so.
func TestProductionTransportSurfacesAMidStreamCloseCausally(t *testing.T) {
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("data: {\"partial\":\"OK\"}\n\n"))
		if flusher, ok := w.(http.Flusher); ok {
			flusher.Flush()
		}
		// Kill the connection with no terminal chunk: the reply is cut mid-frame.
		if hijacker, ok := w.(http.Hijacker); ok {
			if connection, _, err := hijacker.Hijack(); err == nil {
				_ = connection.Close()
			}
		}
	}))
	server.StartTLS()
	t.Cleanup(server.Close)
	pool := x509.NewCertPool()
	pool.AddCert(server.Certificate())
	clientTLS := &tls.Config{RootCAs: pool}

	response, err := SendStreaming(context.Background(), providerRequest(server.URL+"/v1/chat/completions", []byte("{}"), clientTLS), 5*time.Second)
	if err == nil {
		_, readErr := io.ReadAll(response.Stream)
		_ = response.Stream.Close()
		if readErr == nil {
			t.Fatal("a connection cut mid-frame produced no error at all; a truncated reply is indistinguishable from a finished one")
		}
		err = readErr
	}
	message := err.Error()
	if !strings.Contains(message, "127.0.0.1") && !strings.Contains(message, "localhost") {
		t.Fatalf("error = %v, want it to NAME the provider host so the user can tell which provider died", message)
	}
}

// TestProductionTransportAttributesATimeoutToTheHeaderStage covers D1's user-visible half. Without a
// bound, a provider that accepts TCP and then stalls holds the request forever; with one, the error must
// say it was a timeout while waiting for headers from THAT host, not a generic failure.
func TestProductionTransportAttributesATimeoutToTheHeaderStage(t *testing.T) {
	// The handler stalls, but it must still RETURN: httptest.Server.Close waits for outstanding
	// handlers, and a handler blocked forever on r.Context() never learns the client went away (it is
	// not reading the connection), so the test would hang instead of failing. The released channel is closed by a
	// cleanup registered AFTER the server's own, so it runs BEFORE Close (cleanups are LIFO).
	released := make(chan struct{})
	server, clientTLS := startProductionAuditServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Accept the request and never answer: the shape of a provider that is up but wedged.
		select {
		case <-r.Context().Done():
		case <-released:
		}
	}))
	// Registered AFTER the server's own cleanup, so it runs BEFORE server.Close (cleanups are LIFO).
	// Getting this order wrong deadlocks: Close waits for the handler, the handler waits for released,
	// and released is only closed once Close has returned.
	t.Cleanup(func() { close(released) })

	// The caller's own deadline is what ends the test; the assertion is about what the error SAYS.
	ctx, cancel := context.WithTimeout(context.Background(), 400*time.Millisecond)
	defer cancel()
	_, err := Send(ctx, providerRequest(server.URL+"/v1/chat/completions", []byte("{}"), clientTLS), 0)
	if err == nil {
		t.Fatal("a stalled provider returned no error at all")
	}
	// Any of the three honest spellings counts: an explicit header timeout, or the caller's deadline.
	// What must not happen is a bare read error that says nothing about the stage.
	message := strings.ToLower(err.Error())
	if !strings.Contains(message, "timeout") && !strings.Contains(message, "timed out") && !strings.Contains(message, "deadline") {
		t.Fatalf("error = %v, want it to name a TIMEOUT", err)
	}
	if !strings.Contains(message, "127.0.0.1") {
		t.Fatalf("error = %v, want it to name the provider host", err)
	}
}

// TestProductionTransportPreservesUTF8AcrossAChunkSplit is a GUARD. A chunk boundary that splits a
// multi-byte character must not corrupt the bytes handed to the caller; it holds for the current client
// and must keep holding for the replacement, because SSE frames carry user text.
func TestProductionTransportPreservesUTF8AcrossAChunkSplit(t *testing.T) {
	// The e-acute is 0xC3 0xA9 in UTF-8: the split lands between those two bytes.
	const before, after = "data: {\"text\":\"caf", "\u00e9\"}\n\n"
	server, clientTLS := startProductionAuditServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(before))
		if flusher, ok := w.(http.Flusher); ok {
			flusher.Flush()
		}
		time.Sleep(20 * time.Millisecond)
		_, _ = w.Write([]byte(after))
	}))

	response, err := SendStreaming(context.Background(), providerRequest(server.URL+"/v1/chat/completions", []byte("{}"), clientTLS), 5*time.Second)
	if err != nil {
		t.Fatalf("send: %v", err)
	}
	defer response.Stream.Close()
	body, readErr := io.ReadAll(response.Stream)
	if readErr != nil {
		t.Fatalf("read stream: %v", readErr)
	}
	if want := before + after; string(body) != want {
		t.Fatalf("stream = %q, want %q: a chunk boundary inside a multi-byte character corrupted the frame", string(body), want)
	}
}

// TestProductionTransportSurfacesProviderStatuses is a GUARD: a 401/403/429/5xx must reach the caller as
// a status with the provider's body intact, because the routes map those to the pinned error envelopes.
func TestProductionTransportSurfacesProviderStatuses(t *testing.T) {
	for _, status := range []int{http.StatusUnauthorized, http.StatusForbidden, http.StatusTooManyRequests, http.StatusInternalServerError} {
		status := status
		t.Run(fmt.Sprintf("status_%d", status), func(t *testing.T) {
			server, clientTLS := startProductionAuditServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(status)
				_, _ = w.Write([]byte(`{"error":{"message":"provider says no"}}`))
			}))
			response, err := Send(context.Background(), providerRequest(server.URL+"/v1/chat/completions", []byte("{}"), clientTLS), 5*time.Second)
			if err != nil {
				t.Fatalf("send: %v", err)
			}
			if response.Status != status {
				t.Fatalf("status = %d, want %d", response.Status, status)
			}
			if !bytes.Contains(response.Body, []byte("provider says no")) {
				t.Fatalf("body = %q, want the provider's error body preserved", string(response.Body))
			}
		})
	}
}

// TestProductionTransportDoesNotLeakSecretsIntoErrors is a GUARD and an acceptance criterion: no API key,
// bearer token or proxy credential may appear in an error, whatever stage failed.
func TestProductionTransportDoesNotLeakSecretsIntoErrors(t *testing.T) {
	const secret = "sk-probe-must-not-appear"
	server, clientTLS := startProductionAuditServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if hijacker, ok := w.(http.Hijacker); ok {
			if connection, _, err := hijacker.Hijack(); err == nil {
				_ = connection.Close()
			}
		}
	}))

	request := Request{
		URL:    server.URL + "/v1/chat/completions",
		Method: http.MethodPost,
		Headers: []Header{
			{Name: "Content-Type", Value: "application/json"},
			{Name: "Authorization", Value: "Bearer " + secret},
		},
		Body: []byte("{}"), TLSConfig: clientTLS,
	}
	_, err := Send(context.Background(), request, 5*time.Second)
	if err == nil {
		t.Fatal("a closed connection produced no error")
	}
	if strings.Contains(err.Error(), secret) {
		t.Fatalf("error = %v: the bearer token leaked into the error", err)
	}
	if errors.Is(err, context.Canceled) {
		t.Fatalf("error = %v: a provider failure was reported as a caller cancellation", err)
	}
}
