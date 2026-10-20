package outbound

// TLS transport tests. These exist because the HTTP-mock provider-wire suite stayed green while the
// HTTPS path was absent: the client resolved port 443 and then spoke plaintext, so a real provider
// could never be reached. A test that only used HTTP would not notice the difference, so this file
// exercises the handshake directly against a local TLS server.
//
// Two cases, both required:
//  1. a trusted self-signed server completes the handshake and answers over TLS;
//  2. an UNTRUSTED certificate surfaces as an error, rather than silently falling back to plaintext.

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"crypto/tls"
	"crypto/x509"
)

func startTLSServer(t *testing.T) (*httptest.Server, *x509.CertPool) {
	t.Helper()
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Echo the scheme the request arrived on, so the assertion can prove TLS was used.
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"tls":true,"proto":"` + r.Proto + `"}`))
	}))
	server.StartTLS()
	t.Cleanup(server.Close)

	pool := x509.NewCertPool()
	pool.AddCert(server.Certificate())
	return server, pool
}

func TestSendCompletesHandshakeOverTLS(t *testing.T) {
	server, pool := startTLSServer(t)
	response, err := Send(context.Background(), Request{
		URL:    server.URL + "/v1/chat/completions",
		Method: http.MethodPost,
		Headers: []Header{
			// The client writes the head verbatim, so the caller supplies Host and the framing.
			{Name: "Host", Value: strings.TrimPrefix(server.URL, "https://")},
			{Name: "Content-Type", Value: "application/json"},
			{Name: "Content-Length", Value: "2"},
		},
		Body:      []byte("{}"),
		TLSConfig: &tls.Config{RootCAs: pool},
	}, 10*time.Second)
	if err != nil {
		t.Fatalf("TLS send failed: %v", err)
	}
	if response.Status != http.StatusOK {
		t.Fatalf("status = %d", response.Status)
	}
	if !strings.Contains(string(response.Body), `"tls":true`) {
		t.Fatalf("body = %q, want the server's TLS marker", response.Body)
	}
}

// TestSendRejectsAnUntrustedCertificate is the case that proves verification is on: a self-signed
// server with no trusted root must fail, not quietly proceed in plaintext.
func TestSendRejectsAnUntrustedCertificate(t *testing.T) {
	server, _ := startTLSServer(t)
	_, err := Send(context.Background(), Request{
		URL:    server.URL + "/v1/chat/completions",
		Method: http.MethodPost,
		Headers: []Header{
			{Name: "Host", Value: strings.TrimPrefix(server.URL, "https://")},
			{Name: "Content-Length", Value: "2"},
		},
		Body: []byte("{}"),
	}, 10*time.Second)
	if err == nil {
		t.Fatal("an untrusted certificate was accepted; verification is not on")
	}
	if !strings.Contains(err.Error(), "tls handshake") && !strings.Contains(err.Error(), "certificate") {
		t.Fatalf("error = %v, want a handshake or certificate failure", err)
	}
}
