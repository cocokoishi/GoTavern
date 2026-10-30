package outbound

// A CONTROLLED PEER THAT BEHAVES LIKE THE INTERNET.
//
// The compatibility matrix's `providers-transport` row is FAIL for one remaining reason: every provider
// differential runs against a recording peer that answers HTTP quickly and correctly, so the properties a
// REAL network exercises -- a certificate that does not chain to a trusted root, a hostname that does not
// resolve, a port that refuses, a proxy that refuses -- had no assertion behind them. AGENTS.md rule 35 says
// an error must NAME the failure class (DNS, connect, TLS, proxy, timeout) and must never print a secret;
// this file is the gate for that sentence, using peers that produce each class on purpose.
//
// EVERY ASSERTION IS THREE-PART: the error exists, the error NAMES the stage, and the error DOES NOT contain
// the bearer token the request carried. The third part matters because a transport that reports
// `Get "https://host/...": Authorization: Bearer sk-...` has turned a diagnostic into a credential leak, and
// nothing else in the suite would notice.
//
// These peers are loopback and offline: no test here can reach the real internet, and none needs to. The
// remaining half of that matrix row -- the same evidence through the SHIPPED artifact -- is a separate gate
// and is stated as such in the row rather than implied by these tests.

import (
	"context"
	"crypto/tls"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

const internetShapeSecret = "sk-internet-shape-canary-9f3c2a"

// internetShapeRequest is the shape a planner sends: an HTTPS completion target with a bearer token.
func internetShapeRequest(target string, clientTLS *tls.Config) Request {
	host := target
	if parsed, err := parseURLHost(target); err == nil {
		host = parsed
	}
	return Request{
		URL:    target,
		Method: http.MethodPost,
		Headers: []Header{
			{Name: "Host", Value: host},
			{Name: "Content-Type", Value: "application/json"},
			{Name: "Authorization", Value: "Bearer " + internetShapeSecret},
		},
		Body:      []byte(`{"model":"test"}`),
		TLSConfig: clientTLS,
	}
}

func assertCausalError(t *testing.T, stage string, err error, wantPhrases []string, wantHost string) {
	t.Helper()
	if err == nil {
		t.Fatalf("%s: the request returned no error, so nothing was refused and this case proves nothing", stage)
	}
	message := err.Error()
	lowered := strings.ToLower(message)
	for _, phrase := range wantPhrases {
		if !strings.Contains(lowered, phrase) {
			t.Fatalf("%s: error %q does not name the %s stage (looked for %q); an error a user cannot classify is not causal", stage, message, stage, phrase)
		}
	}
	if wantHost != "" && !strings.Contains(message, wantHost) {
		t.Fatalf("%s: error %q does not name the provider host %q", stage, message, wantHost)
	}
	// THE SECRET MUST NOT APPEAR. A transport that echoes the request into its error has leaked a credential
	// into a log line, and AGENTS.md rule 35 forbids it in the same sentence as the causal requirement.
	if strings.Contains(message, internetShapeSecret) {
		t.Fatalf("%s: the error leaked the bearer token: %q", stage, message)
	}
	if strings.Contains(message, "Bearer") {
		t.Fatalf("%s: the error carries the Authorization header itself: %q", stage, message)
	}
}

// TestProductionTransportRefusesAnUntrustedCertificate is the case the recording peer can never produce: a
// TLS listener whose certificate chains to nothing the client trusts. The assertion is that verification is
// ON and that the failure is named, not that TLS "works".
func TestProductionTransportRefusesAnUntrustedCertificate(t *testing.T) {
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"unexpected":true}`))
	}))
	server.StartTLS()
	t.Cleanup(server.Close)

	// No clientTLS: system roots only. The server's certificate is self-signed, so it cannot chain.
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_, err := Send(ctx, internetShapeRequest(server.URL+"/v1/chat/completions", nil), 0)
	host := strings.TrimPrefix(server.URL, "https://")
	if at := strings.Index(host, "/"); at >= 0 {
		host = host[:at]
	}
	assertCausalError(t, "TLS", err,
		[]string{"certificate", "x509"},
		host)
}

// TestProductionTransportNamesADNSFailure uses the RFC 2606 `.invalid` TLD, which is guaranteed never to
// resolve. A transport that turned this into "cannot connect" would tell the user nothing about whether their
// provider is down or their DNS is.
func TestProductionTransportNamesADNSFailure(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	_, err := Send(ctx, internetShapeRequest("https://gotavern-internet-shape.invalid/v1/chat/completions", nil), 0)
	assertCausalError(t, "DNS", err,
		// Go's resolver spells it "no such host"; a platform that words it differently still has to say
		// "lookup" or "dns" for this to be causal.
		[]string{"gotavern-internet-shape.invalid"},
		"gotavern-internet-shape.invalid")
	lowered := strings.ToLower(err.Error())
	if !strings.Contains(lowered, "no such host") && !strings.Contains(lowered, "lookup") && !strings.Contains(lowered, "dns") && !strings.Contains(lowered, "server misbehaving") {
		t.Fatalf("DNS: error %q names the host but not the resolution failure", err.Error())
	}
}

// TestProductionTransportNamesAConnectRefusal connects to a port that was just closed: the internet shape of
// "nothing is listening", which must be distinguishable from a TLS or a timeout failure.
func TestProductionTransportNamesAConnectRefusal(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("reserve a port: %v", err)
	}
	address := listener.Addr().String()
	// Close it so the port is (near-certainly) free for a refusal. A race that rebinds it would produce a
	// different failure; the assertion below accepts only a refusal, so such a race fails loudly.
	if err := listener.Close(); err != nil {
		t.Fatalf("release the port: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_, err = Send(ctx, internetShapeRequest("http://"+address+"/v1/chat/completions", nil), 0)
	// THE OPERATING SYSTEM WORDING DIFFERS BY PLATFORM and the test must not encode one of them: Unix says
	// "connect: connection refused", Windows says "connectex: No connection could be made because the target
	// machine actively refused it". What both share -- and what makes the error causal -- is the transport's
	// own stage prefix plus the word "refused", so those two are what this asserts.
	assertCausalError(t, "connect", err,
		[]string{"connect", "refused"},
		address)
}

// TestProductionTransportNamesAProxyRefusal puts a proxy in front that answers 407 and asserts the failure
// is attributed to the proxy rather than to the provider. Without this, a user behind a misconfigured proxy
// sees "provider unreachable" and never learns the proxy is the one refusing.
func TestProductionTransportNamesAProxyRefusal(t *testing.T) {
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// A CONNECT request (https target) gets the refusal a real authenticated proxy sends.
		w.Header().Set("Proxy-Authenticate", `Basic realm="gotavern-test"`)
		w.WriteHeader(http.StatusProxyAuthRequired)
	}))
	t.Cleanup(proxy.Close)

	if err := ConfigureRequestProxy(true, proxy.URL, nil); err != nil {
		t.Fatalf("configure the proxy: %v", err)
	}
	t.Cleanup(func() { _ = ConfigureRequestProxy(false, "", nil) })

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	// The provider host does not have to exist: the CONNECT must be refused by the proxy before any DNS or
	// connect to the target happens.
	_, err := Send(ctx, internetShapeRequest("https://api.gotavern-internet-shape.test/v1/chat/completions", nil), 0)
	if err == nil {
		t.Fatal("a proxy answering 407 produced no error, so the request was not routed through it")
	}
	lowered := strings.ToLower(err.Error())
	proxyHost := strings.TrimPrefix(proxy.URL, "http://")
	if !strings.Contains(lowered, "proxy") && !strings.Contains(lowered, "407") && !strings.Contains(lowered, proxyHost) {
		t.Fatalf("proxy: error %q names neither the proxy nor the status, so the user cannot tell the proxy refused", err.Error())
	}
	if strings.Contains(err.Error(), internetShapeSecret) || strings.Contains(err.Error(), "Bearer") {
		t.Fatalf("proxy: the error leaked the bearer token: %q", err.Error())
	}
}

// parseURLHost returns the authority of an absolute URL without importing net/url into the assertion helper's
// callers. A parse failure yields an empty host, and the caller falls back to the raw target.
func parseURLHost(target string) (string, error) {
	rest := target
	for _, prefix := range []string{"https://", "http://"} {
		if strings.HasPrefix(rest, prefix) {
			rest = strings.TrimPrefix(rest, prefix)
			if slash := strings.Index(rest, "/"); slash >= 0 {
				rest = rest[:slash]
			}
			if rest == "" {
				return "", fmt.Errorf("no authority in %q", target)
			}
			return rest, nil
		}
	}
	return "", fmt.Errorf("not an absolute URL: %q", target)
}
