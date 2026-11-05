package outbound

// A15 LANE C -- REDIRECT SEMANTICS AGAINST PINNED'S node-fetch 3.3.2.
//
// Pinned's provider traffic is node-fetch 3.3.2 (pinned tree:
// node_modules/node-fetch/src/index.js). Its redirect contract, read from that source rather than
// assumed, has two properties our production transport did not state:
//
//  1. FOLLOW LIMIT. `this.follow` defaults to 20 (src/request.js:134) and the redirect branch rejects
//     only when `request.counter >= request.follow` (src/index.js:178), i.e. pinned follows up to 20
//     redirects. Our CheckRedirect gave up after 5 (len(via) >= 5), so a provider chain longer than
//     four redirects failed where pinned succeeds.
//  2. SENSITIVE HEADERS ACROSS A PROTOCOL CHANGE. src/index.js:200-213 deletes authorization,
//     www-authenticate, cookie and cookie2 when the destination is not a domain/subdomain OR is not the
//     same PROTOCOL (`isSameProtocol`). Go's net/http only compares HOSTNAMES
//     (net/http/client.go shouldCopyHeaderOnRedirect), so on https://host -> http://host it keeps
//     forwarding the bearer token where pinned strips it. That is both a parity difference and a
//     credential leak that pinned deliberately avoided.
//
// These tests are written from the pinned rules, not from our implementation: the two "MUST FOLLOW /
// MUST STRIP" cases below were RED before transport.go matched them. The guards (same-origin keeps the
// header, cross-host strips it, method/body rules) pin the rest of the same contract.

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// refusedRedirectLimit is pinned's node-fetch limit (src/request.js:134: follow default 20) now in
// transport.go. It is restated here so a change to our constant is a reviewable edit to a pinned fact.
const pinnedRedirectLimit = 20

// redirectPeer records what a redirect target received.
type redirectTarget struct {
	server  *httptest.Server
	request atomic.Value // *http.Request snapshot (method, path, headers, body)
}

func newRedirectTarget(t *testing.T, body string) *redirectTarget {
	t.Helper()
	target := &redirectTarget{}
	target.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		target.request.Store(r)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(target.server.Close)
	return target
}

func (target *redirectTarget) last(t *testing.T) *http.Request {
	t.Helper()
	value := target.request.Load()
	if value == nil {
		t.Fatal("the redirect target received no request")
	}
	return value.(*http.Request)
}

// tlsPeerConfig trusts only the given TLS test server's certificate, so a redirect can cross into
// https without disabling verification (which would make the TLS half of this file prove nothing).
func tlsPeerConfig(t *testing.T, server *httptest.Server) *tls.Config {
	t.Helper()
	pool := x509.NewCertPool()
	pool.AddCert(server.Certificate())
	return &tls.Config{RootCAs: pool}
}

const redirectJSON = `{"choices":[{"message":{"content":"REDIRECTED-OK"}}]}`

// httpsRedirector starts an HTTPS server that 307-redirects every request to location().
func httpsRedirector(t *testing.T, location func(r *http.Request) string) (*httptest.Server, *tls.Config) {
	t.Helper()
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, location(r), http.StatusTemporaryRedirect)
	}))
	server.StartTLS()
	t.Cleanup(server.Close)
	return server, tlsPeerConfig(t, server)
}

// redirectCredentialRequest is a provider request carrying every header pinned treats as sensitive.
func redirectCredentialRequest(target string, clientTLS *tls.Config) Request {
	return Request{
		URL:    target,
		Method: http.MethodPost,
		Headers: []Header{
			{Name: "Content-Type", Value: "application/json"},
			{Name: "Authorization", Value: "Bearer a15-lane-c-secret"},
			{Name: "Cookie", Value: "session=a15-lane-c-cookie"},
			{Name: "WWW-Authenticate", Value: "Basic realm=a15"},
		},
		Body:      []byte(`{"model":"a15"}`),
		TLSConfig: clientTLS,
	}
}

// TestProductionTransportFollowsPinnedRedirectLimit pins node-fetch's follow=20. The chain of 12 below
// is longer than our old limit (4 followed redirects) and shorter than pinned's, so it separates the two
// contracts; the endless loop must fail with an error that names the redirect, as pinned's
// `maximum redirect reached` does.
func TestProductionTransportFollowsPinnedRedirectLimit(t *testing.T) {
	const chainLength = 12

	var hops int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hop := atomic.AddInt64(&hops, 1)
		if hop <= chainLength {
			http.Redirect(w, r, fmt.Sprintf("/hop/%d", hop), http.StatusTemporaryRedirect)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(redirectJSON))
	}))
	t.Cleanup(server.Close)

	request := redirectCredentialRequest(server.URL+"/start", nil)
	response, err := Send(context.Background(), request, 5*time.Second)
	if err != nil {
		t.Fatalf("a %d-redirect chain failed: %v; pinned node-fetch follows up to %d redirects (follow default 20)", chainLength, err, pinnedRedirectLimit)
	}
	if string(response.Body) != redirectJSON {
		t.Fatalf("body after a %d-redirect chain = %q, want the final provider JSON", chainLength, string(response.Body))
	}

	// And the limit itself: pinned rejects the request after 20 followed redirects.
	loop := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/loop", http.StatusTemporaryRedirect)
	}))
	t.Cleanup(loop.Close)
	_, err = Send(context.Background(), redirectCredentialRequest(loop.URL+"/loop", nil), 5*time.Second)
	if err == nil {
		t.Fatalf("an endless redirect loop returned no error; pinned rejects after %d redirects", pinnedRedirectLimit)
	}
	if !strings.Contains(strings.ToLower(err.Error()), "redirect") {
		t.Fatalf("redirect-limit error = %v, want it to name the redirect failure", err)
	}
}

// TestProductionTransportStripsSensitiveHeadersOnCrossProtocolRedirect is the pinned rule our transport
// was missing: https://127.0.0.1:P1 -> http://127.0.0.1:P2 is the SAME hostname, so net/http keeps
// forwarding the bearer token, while pinned's `isSameProtocol` check deletes it. The token must not reach
// the plaintext target.
func TestProductionTransportStripsSensitiveHeadersOnCrossProtocolRedirect(t *testing.T) {
	target := newRedirectTarget(t, redirectJSON)
	redirector, clientTLS := httpsRedirector(t, func(*http.Request) string { return target.server.URL + "/final" })

	response, err := Send(context.Background(), redirectCredentialRequest(redirector.URL+"/api", clientTLS), 5*time.Second)
	if err != nil {
		t.Fatalf("send: %v", err)
	}
	if string(response.Body) != redirectJSON {
		t.Fatalf("body = %q, want the final target's JSON", string(response.Body))
	}
	received := target.last(t)
	for _, header := range []string{"Authorization", "WWW-Authenticate", "Cookie"} {
		if value := received.Header.Get(header); value != "" {
			t.Fatalf("%s crossed an https->http redirect (value %q); pinned node-fetch deletes authorization, www-authenticate, cookie and cookie2 on a protocol change (src/index.js:200-213)", header, value)
		}
	}
}

// TestProductionTransportKeepsSensitiveHeadersOnSameOriginRedirect is the guard on the strip rule: a
// same-host same-protocol redirect must keep the bearer token, as pinned does, or every ordinary CDN
// edge redirect would lose the credential.
func TestProductionTransportKeepsSensitiveHeadersOnSameOriginRedirect(t *testing.T) {
	var seen string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/start" {
			http.Redirect(w, r, "/final", http.StatusTemporaryRedirect)
			return
		}
		seen = r.Header.Get("Authorization")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(redirectJSON))
	}))
	t.Cleanup(server.Close)

	response, err := Send(context.Background(), redirectCredentialRequest(server.URL+"/start", nil), 5*time.Second)
	if err != nil {
		t.Fatalf("send: %v", err)
	}
	if string(response.Body) != redirectJSON {
		t.Fatalf("body = %q, want the final JSON", string(response.Body))
	}
	if seen != "Bearer a15-lane-c-secret" {
		t.Fatalf("same-origin redirect lost the Authorization header (target saw %q); pinned forwards sensitive headers to the same domain and protocol", seen)
	}
}

// TestProductionTransportStripsSensitiveHeadersAcrossHosts is a guard for the half net/http already
// implements: the hostnames differ (127.0.0.1 -> localhost), so Authorization must be stripped. Pinned's
// isDomainOrSubdomain agrees, which is why no fix was needed here.
func TestProductionTransportStripsSensitiveHeadersAcrossHosts(t *testing.T) {
	target := newRedirectTarget(t, redirectJSON)
	redirector := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, strings.Replace(target.server.URL, "127.0.0.1", "localhost", 1)+"/final", http.StatusTemporaryRedirect)
	}))
	t.Cleanup(redirector.Close)

	response, err := Send(context.Background(), redirectCredentialRequest(redirector.URL+"/api", nil), 5*time.Second)
	if err != nil {
		t.Fatalf("send: %v", err)
	}
	if string(response.Body) != redirectJSON {
		t.Fatalf("body = %q, want the final JSON", string(response.Body))
	}
	if value := target.last(t).Header.Get("Authorization"); value != "" {
		t.Fatalf("Authorization crossed a host change (value %q); pinned strips sensitive headers when the destination is not the same domain or a subdomain", value)
	}
}

// TestProductionTransportFollowsCrossSchemeRedirects closes alpha.14's "cross-scheme redirects are
// unproven (no trusted TLS loopback peer)" limitation. Both directions are driven with a trusted TLS
// config, so this is a real cross-scheme follow with verification ON, not an InsecureSkipVerify shortcut.
// 307 keeps the method and body (pinned src/index.js:226-231 only rewrites method for 303 and 301/302 on
// POST), so the final peer receives the POST body in both directions.
func TestProductionTransportFollowsCrossSchemeRedirects(t *testing.T) {
	t.Run("http to https", func(t *testing.T) {
		var finalBody atomic.Value
		final := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			body := make([]byte, r.ContentLength)
			_, _ = r.Body.Read(body)
			finalBody.Store(string(body))
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(redirectJSON))
		}))
		final.StartTLS()
		t.Cleanup(final.Close)
		clientTLS := tlsPeerConfig(t, final)
		redirector := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			http.Redirect(w, r, final.URL+"/final", http.StatusTemporaryRedirect)
		}))
		t.Cleanup(redirector.Close)

		response, err := Send(context.Background(), redirectCredentialRequest(redirector.URL+"/api", clientTLS), 5*time.Second)
		if err != nil {
			t.Fatalf("http->https redirect failed: %v", err)
		}
		if string(response.Body) != redirectJSON {
			t.Fatalf("body = %q, want the HTTPS target's JSON", string(response.Body))
		}
		if got, _ := finalBody.Load().(string); got != `{"model":"a15"}` {
			t.Fatalf("the HTTPS target received body %q, want the POST body preserved across a 307 redirect", got)
		}
	})

	t.Run("https to http", func(t *testing.T) {
		target := newRedirectTarget(t, redirectJSON)
		redirector, clientTLS := httpsRedirector(t, func(*http.Request) string { return target.server.URL + "/final" })

		response, err := Send(context.Background(), redirectCredentialRequest(redirector.URL+"/api", clientTLS), 5*time.Second)
		if err != nil {
			t.Fatalf("https->http redirect failed: %v", err)
		}
		if string(response.Body) != redirectJSON {
			t.Fatalf("body = %q, want the plain target's JSON", string(response.Body))
		}
		received := target.last(t)
		if received.Method != http.MethodPost {
			t.Fatalf("method after a 307 redirect = %s, want POST", received.Method)
		}
		if received.ContentLength != int64(len(`{"model":"a15"}`)) {
			t.Fatalf("body length after a 307 redirect = %d, want the POST body preserved", received.ContentLength)
		}
	})
}

// TestProductionTransportRedirectMethodRules is a guard for the half both stacks agree on, pinned
// src/index.js:226-231: 303 always becomes GET; 301/302 become GET when the method is POST; 307/308 keep
// the method and body.
func TestProductionTransportRedirectMethodRules(t *testing.T) {
	for _, testCase := range []struct {
		name       string
		status     int
		method     string
		wantMethod string
		wantBody   string
	}{
		{name: "303 becomes GET", status: http.StatusSeeOther, method: http.MethodPost, wantMethod: http.MethodGet, wantBody: ""},
		{name: "302 POST becomes GET", status: http.StatusFound, method: http.MethodPost, wantMethod: http.MethodGet, wantBody: ""},
		{name: "307 keeps POST and body", status: http.StatusTemporaryRedirect, method: http.MethodPost, wantMethod: http.MethodPost, wantBody: `{"model":"a15"}`},
		{name: "308 keeps POST and body", status: http.StatusPermanentRedirect, method: http.MethodPost, wantMethod: http.MethodPost, wantBody: `{"model":"a15"}`},
	} {
		testCase := testCase
		t.Run(testCase.name, func(t *testing.T) {
			var gotMethod, gotBody atomic.Value
			final := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				body := make([]byte, r.ContentLength)
				_, _ = r.Body.Read(body)
				gotMethod.Store(r.Method)
				gotBody.Store(string(body))
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte(redirectJSON))
			}))
			t.Cleanup(final.Close)
			redirector := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				http.Redirect(w, r, final.URL+"/final", testCase.status)
			}))
			t.Cleanup(redirector.Close)

			request := redirectCredentialRequest(redirector.URL+"/api", nil)
			request.Method = testCase.method
			if _, err := Send(context.Background(), request, 5*time.Second); err != nil {
				t.Fatalf("send: %v", err)
			}
			if method, _ := gotMethod.Load().(string); method != testCase.wantMethod {
				t.Fatalf("status %d: method at the target = %s, want %s (pinned src/index.js:226-231)", testCase.status, method, testCase.wantMethod)
			}
			if body, _ := gotBody.Load().(string); body != testCase.wantBody {
				t.Fatalf("status %d: body at the target = %q, want %q", testCase.status, body, testCase.wantBody)
			}
		})
	}
}
