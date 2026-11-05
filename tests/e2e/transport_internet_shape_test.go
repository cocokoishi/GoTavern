package e2e

// THE INTERNET-SHAPED FAILURE, THROUGH THE SHIPPED BINARY.
//
// internal/outbound's transport_internet_shape_test.go proves the PRODUCTION TRANSPORT names a TLS, DNS,
// connect and proxy failure and never prints the bearer token. That is a package-level claim. AGENTS.md 23
// and 35 make the product claim: the artifact a user runs must surface the same causal message, because
// "cannot connect" is exactly the report P0-A started from.
//
// THE HARD PART, AND WHY THIS TEST IS SHAPED THIS WAY. Pinned's chat-completion catch throws the fetch error
// away: eight sources answer `{error:true}` with NO cause, so on those an artifact-level causal message would
// be impossible without diverging. GoTavern diverges DELIBERATELY and DECLAREDLY (see
// internal/server/chat_completions.go's pinnedChatCompletionTransportErrorFlagOK: the body is a SUPERSET --
// `error` stays exactly what pinned sends and a `message` member is added), so the assertion here is:
//   - the `error` member is exactly the shape that source's pinned branch sends, and
//   - a `message` member exists, names the TLS stage, and contains no credential.
//
// The peer is a local TLS listener with a self-signed certificate, which is the internet shape that a
// recording peer can never produce: it answers nothing, because the handshake fails first.

import (
	"crypto/tls"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func TestProviderTransportFailureIsCausalThroughTheShippedBinary(t *testing.T) {
	requireProductionTransport(t)
	fixture := loadProviderWireFixture(t)
	nonStream := fixture.scenario(t, "deepseek-nonstream")
	seam := deepSeekSeam(t, nonStream)

	// THE UNTRUSTED PEER. It is never reached: the server has system roots only, this certificate is
	// self-signed, so the handshake fails before any request is written. Its handler is deliberately a
	// failing assertion rather than a reply -- if it ever runs, the transport accepted an untrusted
	// certificate and that is the finding.
	untrusted := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Errorf("the server reached a provider whose certificate it does not trust; the TLS handshake should have failed first")
		w.WriteHeader(http.StatusTeapot)
	}))
	untrusted.TLS = &tls.Config{}
	untrusted.StartTLS()
	t.Cleanup(untrusted.Close)

	server := bootServer(t, map[string]string{seam: untrusted.URL})
	client := openSession(t, server.origin)
	writeSecret(t, client, deepSeekSecretKey, syntheticDeepSeekKey)

	status, _, body := client.postJSON(t, generateRoute, nonStream.driverBody(t, "deepseek-untrusted-tls"))
	if status != http.StatusOK && status != http.StatusBadGateway && status != http.StatusInternalServerError {
		t.Fatalf("POST %s = %d, want a chat-completion failure status (200 with error:true, 502 or 500): %s\n%s",
			generateRoute, status, compactForLog(body), server.diagnostic())
	}

	var payload map[string]json.RawMessage
	if err := json.Unmarshal([]byte(body), &payload); err != nil {
		t.Fatalf("the failure body is not JSON (%v): %s", err, compactForLog(body))
	}
	// The failure must be SIGNALLED the way the frontend reads it: either error:true or an error object.
	rawError, hasError := payload["error"]
	if !hasError {
		t.Fatalf("the failure body has no `error` member: %s", compactForLog(body))
	}
	// A CAUSAL MESSAGE IS THE POINT. Pinned drops it; GoTavern's declared superset keeps it.
	rawMessage, hasMessage := payload["message"]
	if !hasMessage {
		t.Fatalf("the failure body carries no `message`, so the user sees no cause (this is the P0-A shape): %s", compactForLog(body))
	}
	var message string
	if err := json.Unmarshal(rawMessage, &message); err != nil {
		t.Fatalf("the `message` member is not a string (%v): %s", err, compactForLog(body))
	}
	lowered := strings.ToLower(message)
	if !strings.Contains(lowered, "certificate") && !strings.Contains(lowered, "x509") && !strings.Contains(lowered, "tls") {
		t.Fatalf("the message %q does not name the TLS stage, so the user cannot tell a broken certificate from a dead provider", message)
	}
	if !strings.Contains(message, "127.0.0.1") && !strings.Contains(message, "localhost") {
		t.Fatalf("the message %q does not name the provider host the request was for", message)
	}
	// THE CREDENTIAL MUST NOT APPEAR IN THE PAYLOAD THE BROWSER RECEIVES. This is the artifact-level half of
	// the no-secret assertion in the transport tests: a diagnostic that echoes the bearer token hands the key
	// to anyone who can read a browser console, an error report or a log.
	if strings.Contains(string(body), syntheticDeepSeekKey) {
		t.Fatalf("the failure body leaked the provider credential: %s", compactForLog(body))
	}
	if strings.Contains(string(body), "Bearer") {
		t.Fatalf("the failure body carries the Authorization header: %s", compactForLog(body))
	}
	// And the `error` member still says what pinned's branch says, so the frontend's `error === true` (or its
	// object test) keeps working: the added member is a superset, never a replacement.
	if string(rawError) != "true" {
		var errorObject map[string]json.RawMessage
		if err := json.Unmarshal(rawError, &errorObject); err != nil || len(errorObject) == 0 {
			t.Fatalf("the `error` member is %s, which is neither `true` nor a non-empty object; the frontend's check breaks", string(rawError))
		}
	}
}

// TestProviderRedirectIsFollowedThroughTheShippedBinary is the artifact-level half of the redirect
// contract internal/outbound/a15_redirect_semantics_test.go measures in the package. A provider edge that
// 307-redirects the completion must be followed by the binary's production transport, with the POST body
// and the same-host credential intact (pinned node-fetch follows redirects with the same rules: 307 keeps
// method/body, same-domain sensitive headers survive). The final peer is asserted to have received the
// request; without the follow, the route would answer a transport/error body instead of the completion.
func TestProviderRedirectIsFollowedThroughTheShippedBinary(t *testing.T) {
	requireProductionTransport(t)
	fixture := loadProviderWireFixture(t)
	nonStream := fixture.scenario(t, "deepseek-nonstream")
	seam := deepSeekSeam(t, nonStream)

	var finalRequests, redirectRequests int64
	final := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt64(&finalRequests, 1)
		if r.Method != http.MethodPost {
			t.Errorf("the redirected completion reached the final peer with method %s, want POST (307 keeps it)", r.Method)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer "+syntheticDeepSeekKey {
			t.Errorf("the redirected completion lost its credential (Authorization = %q); a same-host redirect keeps sensitive headers in pinned node-fetch", got)
		}
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		_, _ = w.Write([]byte(nonStream.ProviderResponse.Body))
	}))
	t.Cleanup(final.Close)
	redirector := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt64(&redirectRequests, 1)
		http.Redirect(w, r, final.URL+"/v1/chat/completions", http.StatusTemporaryRedirect)
	}))
	t.Cleanup(redirector.Close)

	server := bootServer(t, map[string]string{seam: redirector.URL})
	client := openSession(t, server.origin)
	writeSecret(t, client, deepSeekSecretKey, syntheticDeepSeekKey)

	status, _, body := client.postJSON(t, generateRoute, nonStream.driverBody(t, "deepseek-nonstream"))
	if status != http.StatusOK {
		t.Fatalf("POST %s through a 307 provider redirect = %d, want 200: %s\n%s",
			generateRoute, status, compactForLog(body), server.diagnostic())
	}
	if got := atomic.LoadInt64(&redirectRequests); got != 1 {
		t.Fatalf("the redirect peer received %d requests, want exactly 1 (one request, one redirect)", got)
	}
	if got := atomic.LoadInt64(&finalRequests); got != 1 {
		t.Fatalf("the final peer received %d requests, want exactly 1: the production transport did not follow the redirect exactly once", got)
	}
	// The answer is the recorded completion, not an error envelope: the redirect was followed by the
	// transport the binary actually uses, and the provider's body came back intact.
	wantContent := completionContent(t, "recorded provider body", string(nonStream.ProviderResponse.Body))
	if wantContent == "" {
		t.Fatal("the capture records no completion content, so this assertion would be vacuous")
	}
	if got := completionContent(t, "redirected answer", body); got != wantContent {
		t.Fatalf("completion content after the redirect = %q, want the recorded %q; body: %s", got, wantContent, compactForLog(body))
	}
	if strings.Contains(string(body), syntheticDeepSeekKey) || strings.Contains(string(body), "Bearer") {
		t.Fatalf("the redirected answer leaked the provider credential: %s", compactForLog(body))
	}
}

// TestProviderProxyFromTheEnvironmentThroughTheShippedBinary proves the documented proxy path reaches the
// shipped artifact: with HTTP_PROXY exported and no requestProxy config, the binary's provider request must
// be sent to the proxy (absolute-form request target) instead of dialling the provider host. The provider
// host is deliberately a name that does not resolve -- if the request bypassed the proxy the route would
// answer a transport failure, so a success is only possible through the proxy. The environment spelling is
// the uppercase one; on Windows env names are case-insensitive, so a separate lowercase leg cannot be
// distinguished from this one (the trap is recorded in the lane ledger rather than faked as a second case).
func TestProviderProxyFromTheEnvironmentThroughTheShippedBinary(t *testing.T) {
	requireProductionTransport(t)
	fixture := loadProviderWireFixture(t)
	nonStream := fixture.scenario(t, "deepseek-nonstream")
	seam := deepSeekSeam(t, nonStream)

	var proxied int64
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt64(&proxied, 1)
		// A proxy receives the absolute request target, which is how this tells proxying apart from a
		// direct dial: r.URL is absolute here and r.RequestURI starts with the provider scheme/host.
		if !r.URL.IsAbs() || r.URL.Host != "provider.invalid" {
			t.Errorf("the proxy received a non-absolute target %q; the request was not proxied", r.RequestURI)
		}
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		_, _ = w.Write([]byte(nonStream.ProviderResponse.Body))
	}))
	t.Cleanup(proxy.Close)

	server := bootServer(t, map[string]string{
		seam:         "http://provider.invalid",
		"HTTP_PROXY": proxy.URL,
		"NO_PROXY":   "",
		"no_proxy":   "",
	})
	client := openSession(t, server.origin)
	writeSecret(t, client, deepSeekSecretKey, syntheticDeepSeekKey)

	status, _, body := client.postJSON(t, generateRoute, nonStream.driverBody(t, "deepseek-nonstream"))
	if status != http.StatusOK {
		t.Fatalf("POST %s with HTTP_PROXY set = %d, want 200: the provider host does not resolve, so a failure means the request bypassed the environment proxy: %s\n%s",
			generateRoute, status, compactForLog(body), server.diagnostic())
	}
	if got := atomic.LoadInt64(&proxied); got != 1 {
		t.Fatalf("the proxy received %d requests, want exactly 1; the provider host cannot be reached directly", got)
	}
	wantContent := completionContent(t, "recorded provider body", string(nonStream.ProviderResponse.Body))
	if got := completionContent(t, "proxied answer", body); got != wantContent {
		t.Fatalf("completion content through the proxy = %q, want the recorded %q", got, wantContent)
	}
}
