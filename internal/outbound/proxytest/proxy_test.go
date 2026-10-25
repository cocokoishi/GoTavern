// Package proxytest holds the proxy matrix for the production provider transport.
//
// It is a SEPARATE package, and therefore a separate test binary, because
// `http.ProxyFromEnvironment` resolves the environment ONCE per process and caches it. A proxy test that
// changed HTTP_PROXY/HTTPS_PROXY/NO_PROXY between sub-tests inside a shared binary would silently keep
// using the first configuration it saw and would pass or fail for a reason unrelated to the assertion.
// TestMain sets the environment BEFORE any request is made, so the cache is primed with exactly the
// values asserted here.
//
// THE TARGET CANNOT BE A LOOPBACK ADDRESS, and finding that out cost a run. Go's proxy resolution
// deliberately returns nil for `localhost` and for any loopback IP, so a test whose provider listens on
// 127.0.0.1 never consults the proxy at all -- both proxy assertions failed with "the proxy saw 0
// requests" while the transport was in fact proxy-aware, and the original NO_PROXY case passed for the
// wrong reason (the built-in loopback bypass, not the environment). The provider is therefore addressed
// as 192.0.2.1 (TEST-NET-1, guaranteed unroutable) on the SAME port as the real server, and the proxy
// rewrites or splices to 127.0.0.1 at that port. That is faithful: a user behind a proxy asks for the
// provider's host, and the proxy is what reaches it.
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
	"sync/atomic"
	"testing"
	"time"

	"github.com/cocokoishi/gotavern/internal/outbound"
)

const proxyJSON = `{"choices":[{"message":{"content":"OK"}}]}`

// unreachableProvider is addressed by the client and served by the local test server through the proxy.
const unreachableProvider = "192.0.2.1"

// bypassHost is listed in NO_PROXY, so proxy resolution must return nil for it. It is never dialled.
const bypassHost = "bypass.invalid"

var connectTunnels int64

var forwardedRequests int64

func TestMain(m *testing.M) {
	proxy := newProxyServer()
	_ = os.Setenv("HTTP_PROXY", proxy.URL)
	_ = os.Setenv("HTTPS_PROXY", proxy.URL)
	_ = os.Setenv("NO_PROXY", bypassHost)
	_ = os.Unsetenv("http_proxy")
	_ = os.Unsetenv("https_proxy")
	_ = os.Unsetenv("no_proxy")

	code := m.Run()
	// A kept-alive tunnel leaves a CONNECT handler blocked in io.Copy, and Close waits for handlers, so
	// the tunnels go first; otherwise the whole binary hangs at exit instead of reporting.
	proxy.CloseClientConnections()
	proxy.Close()
	os.Exit(code)
}

// rewriteLoopback maps a proxy request for the unroutable provider onto the local test server, keeping
// the port, so the shape of the request is real and only the address is substituted.
func rewriteLoopback(host string) string {
	hostname, port, err := net.SplitHostPort(host)
	if err != nil || hostname != unreachableProvider {
		return host
	}
	return net.JoinHostPort("127.0.0.1", port)
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
		outRequest.URL.Host = rewriteLoopback(outRequest.URL.Host)
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

// serveConnect is the tunnel half of an HTTP proxy: acknowledge, dial the target, splice the sockets.
func serveConnect(w http.ResponseWriter, r *http.Request) {
	hijacker, ok := w.(http.Hijacker)
	if !ok {
		http.Error(w, "proxy cannot hijack", http.StatusInternalServerError)
		return
	}
	upstream, err := net.DialTimeout("tcp", rewriteLoopback(r.Host), 5*time.Second)
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

// proxyRequest supplies the authority as well as the headers: the wire-exact client writes only what it
// is given, and a request without Host is refused before any handler runs.
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

// providerURL rewrites the test server's loopback authority to the unroutable one, keeping the port.
func providerURL(t *testing.T, server *httptest.Server) string {
	t.Helper()
	parsed, err := url.Parse(server.URL)
	if err != nil {
		t.Fatalf("parse %q: %v", server.URL, err)
	}
	_, port, err := net.SplitHostPort(parsed.Host)
	if err != nil {
		t.Fatalf("split %q: %v", parsed.Host, err)
	}
	return parsed.Scheme + "://" + net.JoinHostPort(unreachableProvider, port) + "/v1/chat/completions"
}

// TestHTTPSProviderUsesTheConnectProxy is P0-A behind a corporate network: the user can reach the proxy
// and nothing else. The assertion is that the CONNECT tunnel carried the request.
func TestHTTPSProviderUsesTheConnectProxy(t *testing.T) {
	server, pool := startProvider(t)
	before := atomic.LoadInt64(&connectTunnels)

	// ServerName pins the identity being verified: the client asks for the unroutable provider, the
	// proxy reaches the local server, and the certificate is the local server's.
	clientTLS := &tls.Config{RootCAs: pool, ServerName: "127.0.0.1"}
	response, err := outbound.Send(context.Background(), proxyRequest(t, providerURL(t, server), clientTLS), 5*time.Second)
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

	response, err := outbound.Send(context.Background(), proxyRequest(t, providerURL(t, server), nil), 5*time.Second)
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

// TestNoProxyIsHonoured is the counterweight, and it is asserted against the proxy RESOLVER rather than
// a live tunnel. It cannot be asserted with a tunnel: the only address a test can reach directly is
// loopback, and Go bypasses loopback before NO_PROXY is consulted, so a bypass case built on 127.0.0.1
// would pass even if NO_PROXY were ignored entirely -- a green that cannot fail. Asking the resolver
// directly measures the environment rule itself.
func TestNoProxyIsHonoured(t *testing.T) {
	proxied, err := http.ProxyFromEnvironment(&http.Request{URL: &url.URL{Scheme: "https", Host: "api.example.com"}})
	if err != nil {
		t.Fatalf("resolve proxy for a proxied host: %v", err)
	}
	if proxied == nil {
		t.Fatal("HTTPS_PROXY is not being applied to a non-loopback provider host")
	}
	bypassed, err := http.ProxyFromEnvironment(&http.Request{URL: &url.URL{Scheme: "https", Host: bypassHost}})
	if err != nil {
		t.Fatalf("resolve proxy for a NO_PROXY host: %v", err)
	}
	if bypassed != nil {
		t.Fatalf("NO_PROXY host %q resolved to proxy %v, want no proxy: traffic that should bypass the proxy would be sent through it", bypassHost, bypassed)
	}
}
