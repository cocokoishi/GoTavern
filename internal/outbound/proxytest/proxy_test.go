// Package proxytest holds the proxy matrix for the production provider transport.
//
// It is a SEPARATE package, and therefore a separate test binary, because
// `http.ProxyFromEnvironment` resolves the environment ONCE per process and caches it. A proxy test that
// changed HTTP_PROXY/HTTPS_PROXY/NO_PROXY between sub-tests inside a shared binary would silently keep
// using the first configuration it saw and would pass or fail for a reason unrelated to the assertion --
// rule 7's "evidence that cannot fail", in the proxy dimension. TestMain sets the environment BEFORE any
// request is made, so the cache is primed with exactly the values asserted here.
//
// What is asserted is the USER's requirement, not an implementation detail: a request must LEAVE through
// the proxy the user configured, and must NOT leave through it when NO_PROXY says so. The peer (proxy)
// counts what it actually received, so a transport that ignores the environment shows up as a proxy that
// saw nothing -- the same "a request that escapes must appear as a missing request" rule the egress
// doctrine applies to probes (AGENTS.md differential doctrine 6).
package proxytest

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/cocokoishi/gotavern/internal/outbound"
)

const proxyJSON = `{"choices":[{"message":{"content":"OK"}}]}`

var connectTunnels int64

var forwardedRequests int64

// TestMain configures the process environment the way a user behind a corporate proxy would, before any
// request can prime net/http's environment cache, and runs a proxy that supports both shapes a provider
// client needs: absolute-form forwarding for http targets and CONNECT tunnelling for https targets.
func TestMain(t *testing.M) {
	proxy := newProxyServer()
	// A user's shell exports these. NO_PROXY names `localhost`, so the bypass case has a host it can use
	// that still resolves to the loopback interface.
	_ = os.Setenv("HTTP_PROXY", proxy.URL)
	_ = os.Setenv("HTTPS_PROXY", proxy.URL)
	_ = os.Setenv("NO_PROXY", "localhost")
	_ = os.Unsetenv("http_proxy")
	_ = os.Unsetenv("https_proxy")
	_ = os.Unsetenv("no_proxy")

	code := t.Run()
	// A kept-alive tunnel leaves a CONNECT handler blocked in io.Copy, and Close waits for handlers, so
	// tear the tunnels down before closing the proxy -- otherwise the whole binary hangs at exit.
	proxy.CloseClientConnections()
	proxy.Close()
	os.Exit(code)
}

func newProxyServer() *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodConnect {
			atomic.AddInt64(&connectTunnels, 1)
			serveConnect(w, r)
			return
		}
		atomic.AddInt64(&forwardedRequests, 1)
		outRequest := r.Clone(r.Context())
		outRequest.RequestURI = "" // RoundTrip requires an empty RequestURI for an absolute-form target.
		response, err := http.DefaultTransport.RoundTrip(outRequest)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
		defer response.Body.Close()
		for name, values := range response.Header {
			for _, value := range values {
				w.Header().Add(name, value)
			}
		}
		w.WriteHeader(response.StatusCode)
		_, _ = io.Copy(w, response.Body)
	}))
}

// serveConnect implements the tunnel half of an HTTP proxy: acknowledge, dial the target, then splice the
// two connections. Anything less would not be a proxy the user's network could actually give us.
func serveConnect(w http.ResponseWriter, r *http.Request) {
	hijacker, ok := w.(http.Hijacker)
	if !ok {
		http.Error(w, "proxy cannot hijack", http.StatusInternalServerError)
		return
	}
	upstream, err := net.DialTimeout("tcp", r.Host, 5*time.Second)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	client, _, err := hijacker.Hijack()
	if err != nil {
		_ = upstream.Close()
		return
	}
	_, _ = client.Write([]byte("HTTP/1.1 200 Connection Established\r\n\r\n"))
	go func() {
		_, _ = io.Copy(upstream, client)
		_ = upstream.Close()
	}()
	_, _ = io.Copy(client, upstream)
	_ = client.Close()
}

func startProvider(t *testing.T) (*httptest.Server, *x509.CertPool) {
	t.Helper()
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(proxyJSON))
	}))
	t.Cleanup(server.Close)
	pool := x509.NewCertPool()
	pool.AddCert(server.Certificate())
	return server, pool
}

// proxyRequest supplies the authority as well as the headers. The wire-exact client writes ONLY the
// headers it is given, so a request without Host is refused by the server before any handler runs and
// the assertion below would fail for a reason that has nothing to do with proxying.
func proxyRequest(t *testing.T, target string, clientTLS *tls.Config) outbound.Request {
	t.Helper()
	parsed, err := url.Parse(target)
	if err != nil {
		t.Fatalf("parse %q: %v", target, err)
	}
	return outbound.Request{
		URL:    target,
		Method: http.MethodPost,
		Headers: []outbound.Header{
			{Name: "Host", Value: parsed.Host},
			{Name: "Content-Type", Value: "application/json"},
		},
		Body:      []byte("{}"),
		TLSConfig: clientTLS,
	}
}

// TestHTTPSProviderUsesTheConnectProxy is P0-A behind a corporate network: the user can reach the proxy and
// nothing else. The assertion is that the CONNECT tunnel carried the request.
func TestHTTPSProviderUsesTheConnectProxy(t *testing.T) {
	server, pool := startProvider(t)
	before := atomic.LoadInt64(&connectTunnels)

	response, err := outbound.Send(context.Background(), proxyRequest(t, server.URL+"/v1/chat/completions", &tls.Config{RootCAs: pool}), 5*time.Second)

	if err != nil {
		t.Fatalf("send through HTTPS_PROXY: %v", err)
	}
	if string(response.Body) != proxyJSON {
		t.Fatalf("body = %q, want %q", string(response.Body), proxyJSON)
	}
	if got := atomic.LoadInt64(&connectTunnels) - before; got != 1 {
		t.Fatalf("the CONNECT proxy saw %d tunnels, want 1: HTTPS_PROXY is ignored, so a user who can only reach the internet through their proxy cannot reach any provider", got)
	}
}

// TestHTTPProviderUsesTheForwardProxy covers the absolute-form half: an http:// provider base (a local
// gateway, an LLM server on the LAN, a proxy-only mirror) must also leave through HTTP_PROXY.
func TestHTTPProviderUsesTheForwardProxy(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(proxyJSON))
	}))
	t.Cleanup(server.Close)
	before := atomic.LoadInt64(&forwardedRequests)

	response, err := outbound.Send(context.Background(), proxyRequest(t, server.URL+"/v1/chat/completions", nil), 5*time.Second)

	if err != nil {
		t.Fatalf("send through HTTP_PROXY: %v", err)
	}
	if string(response.Body) != proxyJSON {
		t.Fatalf("body = %q, want %q", string(response.Body), proxyJSON)
	}
	if got := atomic.LoadInt64(&forwardedRequests) - before; got != 1 {
		t.Fatalf("the forward proxy saw %d requests, want 1: HTTP_PROXY is ignored", got)
	}
}

// TestNoProxyBypassesTheConfiguredProxy is the counterweight. A user whose provider is on the LAN sets
// NO_PROXY so that traffic does not detour through a proxy that cannot reach it. Without this case a
// transport could "support proxies" by sending everything through one, which would be a new defect.
func TestNoProxyBypassesTheConfiguredProxy(t *testing.T) {
	server, pool := startProvider(t)
	// NO_PROXY names `localhost`; the certificate is issued for the loopback IP, so ServerName pins the
	// identity being verified while the DIAL still resolves `localhost`, which is the part under test.
	bypassed := strings.Replace(server.URL, "127.0.0.1", "localhost", 1)
	before := atomic.LoadInt64(&connectTunnels)

	response, err := outbound.Send(context.Background(), proxyRequest(t, bypassed+"/v1/chat/completions", &tls.Config{RootCAs: pool, ServerName: "127.0.0.1"}), 5*time.Second)

	if err != nil {
		t.Fatalf("send to a NO_PROXY host: %v", err)
	}
	if string(response.Body) != proxyJSON {
		t.Fatalf("body = %q, want %q", string(response.Body), proxyJSON)
	}
	if got := atomic.LoadInt64(&connectTunnels) - before; got != 0 {
		t.Fatalf("the proxy saw %d tunnels for a NO_PROXY host, want 0: traffic that should bypass the proxy was sent through it", got)
	}
}
