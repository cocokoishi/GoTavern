package server

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// These tests pin the OBSERVABLE contract of the pinned /proxy/:url(*) mount (server-main.js:257-265),
// which GoTavern did not register at all before alpha.17:
//
//   - disabled branch: 404 with the pinned message as the body (Express's res.send(string) -> text/html);
//   - enabled branch:  a DISTINGUISHABLE 501 naming the unimplemented boundary (AGENTS.md rule 17),
//     never a fabricated proxy and never the disabled branch's 404.
//
// The first test's third assertion is its own negative control: the pre-fix behaviour (Go's generic
// "404 page not found") is named explicitly, so a regression that silently unregisters the route fails
// here with that message instead of passing on the status alone.

func TestCorsProxyDisabledAnswersThePinnedRefusal(t *testing.T) {
	handler := NewHTTPHandlerWithOptions(HTTPHandlerOptions{DataRoot: t.TempDir()})
	// A real client encodes the proxied URL, so the request path has no `//`. A raw `https://` in the
	// path is canonicalised by net/http's ServeMux (a 307 to the cleaned path) BEFORE any handler runs;
	// that is a general Go mux property of this server, not this route's behaviour, and it is recorded
	// rather than papered over.
	for _, path := range []string{
		"/proxy/https%3A%2F%2Fexample.invalid%2Fx",
		"/proxy/example.invalid%2Fx",
	} {
		request := httptest.NewRequest(http.MethodGet, path, nil)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)

		if response.Code != http.StatusNotFound {
			t.Fatalf("GET %s answered %d; pinned's disabled CORS-proxy branch answers 404 (server-main.js:260-264)", path, response.Code)
		}
		if got := response.Body.String(); got == "404 page not found\n" {
			t.Fatalf("GET %s answered the Go mux's generic 404 page; pinned answers %q. The route is not registered or does not own the disabled branch", path, pinnedCorsProxyDisabledMessage)
		} else if got != pinnedCorsProxyDisabledMessage {
			t.Fatalf("GET %s body = %q; pinned's disabled CORS-proxy message is %q", path, got, pinnedCorsProxyDisabledMessage)
		}
		if got := response.Header().Get("Content-Type"); got != "text/html; charset=utf-8" {
			t.Fatalf("GET %s Content-Type = %q; Express res.send(string) answers text/html; charset=utf-8", path, got)
		}
	}
}

func TestCorsProxyEnabledAnswersADistinguishableUnimplementedStatus(t *testing.T) {
	handler := NewHTTPHandlerWithOptions(HTTPHandlerOptions{DataRoot: t.TempDir(), EnableCorsProxy: true})
	request := httptest.NewRequest(http.MethodGet, "/proxy/https%3A%2F%2Fexample.invalid%2Fx", nil)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)

	if response.Code == http.StatusNotFound {
		t.Fatalf("with the CORS proxy ENABLED the route answered 404; an unimplemented branch must be distinguishable from the disabled refusal (AGENTS.md rule 17)")
	}
	if response.Code != http.StatusNotImplemented {
		t.Fatalf("with the CORS proxy ENABLED the route answered %d (location %q); the unimplemented proxy must answer 501 with a named reason", response.Code, response.Header().Get("Location"))
	}
	if got := response.Body.String(); got == pinnedCorsProxyDisabledMessage {
		t.Fatalf("with the CORS proxy ENABLED the route answered the DISABLED branch's message; the two branches are not distinguishable")
	} else if got != pinnedCorsProxyUnimplementedMessage {
		t.Fatalf("with the CORS proxy ENABLED the body = %q; want the named unimplemented reason %q", got, pinnedCorsProxyUnimplementedMessage)
	}
	if got := response.Header().Get("Content-Type"); got != "text/html; charset=utf-8" {
		t.Fatalf("enabled branch Content-Type = %q; want text/html; charset=utf-8", got)
	}
}

func TestCorsProxyRouteDoesNotRequireAUserTree(t *testing.T) {
	// The pinned mount is registered before the per-user middleware, so reaching the disabled branch
	// must not depend on an account/session. A GET with no cookies still gets the pinned 404. (A POST
	// without a CSRF token is a different matter: with the proxy DISABLED the CSRF middleware is in
	// force for this path, exactly as it is for every other mutating route, so this test uses GET.)
	handler := NewHTTPHandlerWithOptions(HTTPHandlerOptions{DataRoot: t.TempDir()})
	request := httptest.NewRequest(http.MethodGet, "/proxy/https%3A%2F%2Fexample.invalid%2Fx", nil)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusNotFound || response.Body.String() != pinnedCorsProxyDisabledMessage {
		t.Fatalf("anonymous GET /proxy/... = %d %q; pinned answers 404 with %q", response.Code, response.Body.String(), pinnedCorsProxyDisabledMessage)
	}
}
