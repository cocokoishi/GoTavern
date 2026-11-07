package e2e

// NICHE HTTP BOUNDARIES (alpha.17; domain IDs HTTP-001..HTTP-006).
//
// These cases attack the middleware stack the frontend actually crosses: the panic boundary, the security
// headers, CORS, CSRF, the JSON body reader, the static frontend layer and the mux's path rules. Each case
// asserts STATUS + the key HEADERS + the BODY SHAPE, because a route can answer the right status with the
// wrong content type or an empty body and the browser would still break.
//
// THE ABSENT 405 IS ASSERTED, NOT ASSUMED. Pinned is Express with a final 404 static handler; GoTavern
// reproduces that stack, so a wrong METHOD on a POST-only route reaches the catch-all and answers 404, not
// 405. Writing "want 405" here would record the wrong product.
//
// WHAT IS NOT EXECUTED: the 500 MiB body limit (settingsSaveBodyLimit / pinnedBodyParserLimit are both
// 500<<20). Sending limit+1 bytes would allocate and transfer half a gigabyte per request, far outside this
// suite's runtime budget; the boundary is recorded as UNEXECUTED in docs/alpha17/new-test-evidence.md
// rather than guessed at.

import (
	"bytes"
	"io"
	"net/http"
	"path/filepath"
	"strings"
	"testing"
)

// nicheResponse is one raw HTTP exchange.
type nicheResponse struct {
	status int
	header http.Header
	body   string
}

// nicheDo issues one request with FULL control over method, body and repeated headers, so a case can send a
// duplicate header (Header.Add rather than Set) and a body whose Content-Type it chooses.
func nicheDo(t *testing.T, client *session, method, path string, body []byte, headers [][2]string) nicheResponse {
	t.Helper()
	request, err := http.NewRequest(method, client.origin+path, bytes.NewReader(body))
	if err != nil {
		t.Fatalf("build %s %s: %v", method, path, err)
	}
	for _, header := range headers {
		request.Header.Add(header[0], header[1])
	}
	response, err := client.client.Do(request)
	if err != nil {
		t.Fatalf("%s %s: %v", method, path, err)
	}
	defer response.Body.Close()
	payload, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatalf("read %s %s: %v", method, path, err)
	}
	return nicheResponse{status: response.StatusCode, header: response.Header, body: string(payload)}
}

// nicheDoNoRedirect is nicheDo with redirects disabled, so a case can assert the REDIRECT itself (status +
// Location) rather than the destination the Go client would otherwise follow.
func nicheDoNoRedirect(t *testing.T, client *session, method, path string) nicheResponse {
	t.Helper()
	noRedirect := *client.client
	noRedirect.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	request, err := http.NewRequest(method, client.origin+path, nil)
	if err != nil {
		t.Fatalf("build %s %s: %v", method, path, err)
	}
	response, err := noRedirect.Do(request)
	if err != nil {
		t.Fatalf("%s %s: %v", method, path, err)
	}
	defer response.Body.Close()
	payload, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatalf("read %s %s: %v", method, path, err)
	}
	return nicheResponse{status: response.StatusCode, header: response.Header, body: string(payload)}
}

// nicheJSONHeaders is the header set the frontend sends for a write: a JSON content type plus the session's
// CSRF token and cookie (both empty when the caller wants to test their absence).
func nicheJSONHeaders(client *session) [][2]string {
	headers := [][2]string{{"Content-Type", "application/json"}}
	if client.cookie != "" {
		headers = append(headers, [2]string{"Cookie", client.cookie})
	}
	if client.token != "" {
		headers = append(headers, [2]string{"X-CSRF-Token", client.token})
	}
	return headers
}

// HTTP-001: the method matrix and the shape of the answers, including the security headers every response
// carries and the absence of 405 on a POST-only route.
func TestNicheHTTPMethodMatrixAndResponseShape(t *testing.T) {
	tree := newNicheTree(t)
	booted := tree.boot(t, nil)
	client := booted.client

	get := nicheDo(t, client, http.MethodGet, "/version", nil, nil)
	if err := nicheCheckStatus("GET /version", get.status, 200); err != nil {
		t.Fatalf("%v", err)
	}
	if err := nicheCheckHeader("GET /version", "Content-Type", get.header.Get("Content-Type"), "application/json; charset=utf-8"); err != nil {
		t.Fatalf("%v", err)
	}
	if err := nicheCheckContains("GET /version", get.body, `"pkgVersion":"1.19.0"`); err != nil {
		t.Fatalf("%v", err)
	}
	if get.header.Get("ETag") == "" {
		t.Fatalf("GET /version carries no ETag; the pinned response is a JSON body with a weak validator")
	}
	if err := nicheCheckHeader("GET /version", "X-Content-Type-Options", get.header.Get("X-Content-Type-Options"), "nosniff"); err != nil {
		t.Fatalf("%v: the pinned security header set is not applied", err)
	}
	if err := nicheCheckHeader("GET /version", "X-Frame-Options", get.header.Get("X-Frame-Options"), "SAMEORIGIN"); err != nil {
		t.Fatalf("%v", err)
	}

	head := nicheDo(t, client, http.MethodHead, "/version", nil, nil)
	if err := nicheCheckStatus("HEAD /version", head.status, 200); err != nil {
		t.Fatalf("%v", err)
	}
	if err := nicheCheckBody("HEAD /version", head.body, ""); err != nil {
		t.Fatalf("%v", err)
	}
	if err := nicheCheckHeader("HEAD /version", "Content-Length", head.header.Get("Content-Length"), get.header.Get("Content-Length")); err != nil {
		t.Fatalf("%v: a HEAD must describe the GET it stands for", err)
	}

	// Wrong methods on the GET-only /version fall through to the static catch-all: 404 with the pinned
	// not-found page, NOT 405. A route that added method dispatch would change this observable.
	cases := []struct{ method, label string }{
		{http.MethodPost, "POST /version"},
		{http.MethodPut, "PUT /version"},
		{http.MethodDelete, "DELETE /version"},
	}
	for _, scenario := range cases {
		response := nicheDo(t, client, scenario.method, "/version", nil, nicheJSONHeaders(client))
		if err := nicheCheckStatus(scenario.label, response.status, 404); err != nil {
			t.Fatalf("%v (the pinned stack's catch-all answers 404, never 405)", err)
		}
		if err := nicheCheckHeader(scenario.label, "Content-Type", response.header.Get("Content-Type"), "text/html; charset=utf-8"); err != nil {
			t.Fatalf("%v", err)
		}
		if err := nicheCheckContains(scenario.label, response.body, "The requested URL was not found on this server."); err != nil {
			t.Fatalf("%v", err)
		}
	}

	// The POST-only chat route with GET: same catch-all, not a 405.
	wrongMethod := nicheDo(t, client, http.MethodGet, "/api/chats/get", nil, nil)
	if err := nicheCheckStatus("GET /api/chats/get", wrongMethod.status, 404); err != nil {
		t.Fatalf("%v", err)
	}

	// A mutating route with NO CSRF token is refused BEFORE the route sees the body: 403, the pinned error
	// page, and the CSP that makes that page inert.
	blocked := nicheDo(t, client, http.MethodPost, "/api/chats/get", []byte("{}"), [][2]string{{"Content-Type", "application/json"}})
	if err := nicheCheckStatus("POST /api/chats/get without CSRF", blocked.status, 403); err != nil {
		t.Fatalf("%v", err)
	}
	if err := nicheCheckHeader("POST /api/chats/get without CSRF", "Content-Security-Policy", blocked.header.Get("Content-Security-Policy"), "default-src 'none'"); err != nil {
		t.Fatalf("%v", err)
	}
	if err := nicheCheckContains("POST /api/chats/get without CSRF", blocked.body, "<!DOCTYPE html>"); err != nil {
		t.Fatalf("%v", err)
	}
}

// HTTP-002: the JSON body reader's five shapes. A malformed body, an array, a primitive and a wrong content
// type are 400; JSON null and an EMPTY application/json body become the empty object that body-parser
// leaves on request.body, so the route answers its normal empty result.
func TestNicheHTTPJSONBodyShapes(t *testing.T) {
	tree := newNicheTree(t)
	booted := tree.boot(t, nil)
	client := booted.client
	headers := nicheJSONHeaders(client)

	invalid := []struct{ label, body string }{
		{"malformed JSON", `{not json`},
		{"array body", `[]`},
		{"number body", `42`},
		{"string body", `"text"`},
	}
	for _, scenario := range invalid {
		response := nicheDo(t, client, http.MethodPost, "/api/chats/get", []byte(scenario.body), headers)
		if err := nicheCheckStatus("chats/get "+scenario.label, response.status, 400); err != nil {
			t.Fatalf("%v", err)
		}
		if err := nicheCheckHeader("chats/get "+scenario.label, "Content-Type", response.header.Get("Content-Type"), "text/plain; charset=utf-8"); err != nil {
			t.Fatalf("%v", err)
		}
		if err := nicheCheckContains("chats/get "+scenario.label, response.body, "Bad Request"); err != nil {
			t.Fatalf("%v", err)
		}
	}
	for _, scenario := range []struct{ label, body string }{
		{"JSON null", `null`},
		{"empty body", ``},
		{"empty object", `{}`},
	} {
		response := nicheDo(t, client, http.MethodPost, "/api/chats/get", []byte(scenario.body), headers)
		if err := nicheCheckStatus("chats/get "+scenario.label, response.status, 200); err != nil {
			t.Fatalf("%v", err)
		}
		if err := nicheCheckHeader("chats/get "+scenario.label, "Content-Type", response.header.Get("Content-Type"), "application/json; charset=utf-8"); err != nil {
			t.Fatalf("%v", err)
		}
		if err := nicheCheckBody("chats/get "+scenario.label, response.body, "{}"); err != nil {
			t.Fatalf("%v", err)
		}
	}
}

// HTTP-003: CSRF acceptance and refusal at the exact boundary the frontend crosses. A duplicate token
// header is refused because csrfTokenFromHeader JOINS repeated values with "," (csrf_session.go:229-235),
// which no longer equals the stored token -- the pinned-style duplicate-header behaviour, asserted rather
// than tolerated.
func TestNicheHTTPCSRFBoundaries(t *testing.T) {
	tree := newNicheTree(t)
	booted := tree.boot(t, nil)
	client := booted.client

	valid := nicheDo(t, client, http.MethodPost, "/api/chats/get", []byte("{}"), nicheJSONHeaders(client))
	if err := nicheCheckStatus("valid token", valid.status, 200); err != nil {
		t.Fatalf("%v", err)
	}

	wrong := nicheDo(t, client, http.MethodPost, "/api/chats/get", []byte("{}"), [][2]string{
		{"Content-Type", "application/json"}, {"Cookie", client.cookie}, {"X-CSRF-Token", "not-the-token"},
	})
	if err := nicheCheckStatus("wrong token", wrong.status, 403); err != nil {
		t.Fatalf("%v", err)
	}

	duplicate := nicheDo(t, client, http.MethodPost, "/api/chats/get", []byte("{}"), [][2]string{
		{"Content-Type", "application/json"}, {"Cookie", client.cookie},
		{"X-CSRF-Token", client.token}, {"X-CSRF-Token", "not-the-token"},
	})
	if err := nicheCheckStatus("duplicate token headers", duplicate.status, 403); err != nil {
		t.Fatalf("%v: repeated X-CSRF-Token values are joined and must not equal the stored token", err)
	}

	// A tampered session cookie cannot vouch for any token: the signature check fails, the server starts an
	// empty session, and the stored token is therefore absent.
	tamperedCookie := client.cookie
	if len(tamperedCookie) > 1 {
		last := tamperedCookie[len(tamperedCookie)-1]
		replacement := byte('A')
		if last == 'A' {
			replacement = 'B'
		}
		tamperedCookie = tamperedCookie[:len(tamperedCookie)-1] + string(replacement)
	}
	tampered := nicheDo(t, client, http.MethodPost, "/api/chats/get", []byte("{}"), [][2]string{
		{"Content-Type", "application/json"}, {"Cookie", tamperedCookie}, {"X-CSRF-Token", client.token},
	})
	if err := nicheCheckStatus("tampered session cookie", tampered.status, 403); err != nil {
		t.Fatalf("%v", err)
	}

	// Browsers may resend the same cookie name twice; the first value is the session and the request must
	// still authenticate. This is a duplicate-COOKIE boundary, distinct from the duplicate CSRF header.
	duplicatedCookie := nicheDo(t, client, http.MethodPost, "/api/chats/get", []byte("{}"), [][2]string{
		{"Content-Type", "application/json"}, {"Cookie", client.cookie + "; " + client.cookie},
		{"X-CSRF-Token", client.token},
	})
	if err := nicheCheckStatus("duplicated session cookie", duplicatedCookie.status, 200); err != nil {
		t.Fatalf("%v", err)
	}
}

// HTTP-004: CORS and preflight. The default configuration is `origin: ["null"]` (cors.go:24), so an OPTIONS
// preflight is answered 204 for every path, `Access-Control-Allow-Origin` is set ONLY for the allowed
// origin, and an ordinary request carrying `Origin: null` gets the header while any other origin does not.
func TestNicheHTTPCORSAndPreflight(t *testing.T) {
	tree := newNicheTree(t)
	booted := tree.boot(t, nil)
	client := booted.client

	noOrigin := nicheDo(t, client, http.MethodOptions, "/api/chats/get", nil, nil)
	if err := nicheCheckStatus("OPTIONS no origin", noOrigin.status, 204); err != nil {
		t.Fatalf("%v", err)
	}
	if err := nicheCheckHeader("OPTIONS no origin", "Access-Control-Allow-Methods", noOrigin.header.Get("Access-Control-Allow-Methods"), "OPTIONS"); err != nil {
		t.Fatalf("%v", err)
	}
	if err := nicheCheckHeaderAbsent("OPTIONS no origin", "Access-Control-Allow-Origin", noOrigin.header.Get("Access-Control-Allow-Origin")); err != nil {
		t.Fatalf("%v", err)
	}
	// A 204 response has no body, and net/http strips the Content-Length header a handler sets on it, so
	// the observable is its ABSENCE rather than "0" -- asserted, because writing "0" would pin a header the
	// wire never carries.
	if err := nicheCheckHeaderAbsent("OPTIONS no origin", "Content-Length", noOrigin.header.Get("Content-Length")); err != nil {
		t.Fatalf("%v", err)
	}

	allowed := nicheDo(t, client, http.MethodOptions, "/api/chats/get", nil, [][2]string{{"Origin", "null"}})
	if err := nicheCheckStatus("OPTIONS origin null", allowed.status, 204); err != nil {
		t.Fatalf("%v", err)
	}
	if err := nicheCheckHeader("OPTIONS origin null", "Access-Control-Allow-Origin", allowed.header.Get("Access-Control-Allow-Origin"), "null"); err != nil {
		t.Fatalf("%v", err)
	}

	foreign := nicheDo(t, client, http.MethodOptions, "/api/chats/get", nil, [][2]string{{"Origin", "http://evil.example"}})
	if err := nicheCheckStatus("OPTIONS foreign origin", foreign.status, 204); err != nil {
		t.Fatalf("%v", err)
	}
	if err := nicheCheckHeaderAbsent("OPTIONS foreign origin", "Access-Control-Allow-Origin", foreign.header.Get("Access-Control-Allow-Origin")); err != nil {
		t.Fatalf("%v: a foreign origin must not be reflected", err)
	}

	ordinary := nicheDo(t, client, http.MethodGet, "/version", nil, [][2]string{{"Origin", "null"}})
	if err := nicheCheckHeader("GET /version Origin null", "Access-Control-Allow-Origin", ordinary.header.Get("Access-Control-Allow-Origin"), "null"); err != nil {
		t.Fatalf("%v", err)
	}
	if err := nicheCheckContains("GET /version Origin null", ordinary.header.Get("Vary"), "Origin"); err != nil {
		t.Fatalf("%v", err)
	}
}

// HTTP-005: validators and ranges on a DISK-backed static asset (seeded under installRoot/public before the
// boot, so the pinned stat-based validators exist) and on the EMBEDDED frontend tree. The embedded residual
// is asserted explicitly: static.go:46-49 records that an embedded-only file carries no ETag and no
// Last-Modified, so it answers 200 where a disk file answers 304. A future change that adds embedded
// validators must update this test and that comment together.
func TestNicheHTTPStaticValidatorsRangesAndEmbeddedResidual(t *testing.T) {
	tree := newNicheTree(t)
	asset := []byte("0123456789abcdefghij")
	nicheWriteFile(t, filepath.Join(tree.installRoot, "public", "niche-probe.txt"), asset)
	booted := tree.boot(t, nil)
	client := booted.client

	get := nicheDo(t, client, http.MethodGet, "/niche-probe.txt", nil, nil)
	if err := nicheCheckStatus("GET disk asset", get.status, 200); err != nil {
		t.Fatalf("%v", err)
	}
	if err := nicheCheckBody("GET disk asset", get.body, string(asset)); err != nil {
		t.Fatalf("%v", err)
	}
	for _, header := range []struct{ name, want string }{
		{"Content-Type", "text/plain; charset=UTF-8"},
		{"Accept-Ranges", "bytes"},
		{"Cache-Control", "public, max-age=0"},
	} {
		if err := nicheCheckHeader("GET disk asset", header.name, get.header.Get(header.name), header.want); err != nil {
			t.Fatalf("%v", err)
		}
	}
	etag := get.header.Get("ETag")
	if etag == "" || get.header.Get("Last-Modified") == "" {
		t.Fatalf("the disk-backed asset carries no ETag/Last-Modified (etag=%q, last-modified=%q); pinned's send() derives both from stat", etag, get.header.Get("Last-Modified"))
	}

	head := nicheDo(t, client, http.MethodHead, "/niche-probe.txt", nil, nil)
	if err := nicheCheckStatus("HEAD disk asset", head.status, 200); err != nil {
		t.Fatalf("%v", err)
	}
	if err := nicheCheckBody("HEAD disk asset", head.body, ""); err != nil {
		t.Fatalf("%v", err)
	}
	if err := nicheCheckHeader("HEAD disk asset", "Content-Length", head.header.Get("Content-Length"), "20"); err != nil {
		t.Fatalf("%v", err)
	}

	rangeResponse := nicheDo(t, client, http.MethodGet, "/niche-probe.txt", nil, [][2]string{{"Range", "bytes=0-3"}})
	if err := nicheCheckStatus("Range 0-3", rangeResponse.status, 206); err != nil {
		t.Fatalf("%v", err)
	}
	if err := nicheCheckBody("Range 0-3", rangeResponse.body, "0123"); err != nil {
		t.Fatalf("%v", err)
	}
	if err := nicheCheckHeader("Range 0-3", "Content-Range", rangeResponse.header.Get("Content-Range"), "bytes 0-3/20"); err != nil {
		t.Fatalf("%v", err)
	}

	unsatisfiable := nicheDo(t, client, http.MethodGet, "/niche-probe.txt", nil, [][2]string{{"Range", "bytes=100-200"}})
	if err := nicheCheckStatus("unsatisfiable range", unsatisfiable.status, 416); err != nil {
		t.Fatalf("%v", err)
	}
	if err := nicheCheckHeader("unsatisfiable range", "Content-Range", unsatisfiable.header.Get("Content-Range"), "bytes */20"); err != nil {
		t.Fatalf("%v", err)
	}
	if err := nicheCheckContains("unsatisfiable range", unsatisfiable.body, "Requested Range Not Satisfiable"); err != nil {
		t.Fatalf("%v", err)
	}

	// A stale validator must NOT produce 304: the response is the full body.
	stale := nicheDo(t, client, http.MethodGet, "/niche-probe.txt", nil, [][2]string{{"If-None-Match", `W/"stale-validator"`}})
	if err := nicheCheckStatus("stale If-None-Match", stale.status, 200); err != nil {
		t.Fatalf("%v", err)
	}
	if err := nicheCheckBody("stale If-None-Match", stale.body, string(asset)); err != nil {
		t.Fatalf("%v", err)
	}

	fresh := nicheDo(t, client, http.MethodGet, "/niche-probe.txt", nil, [][2]string{{"If-Modified-Since", "Wed, 21 Oct 2099 07:28:00 GMT"}})
	if err := nicheCheckStatus("future If-Modified-Since", fresh.status, 304); err != nil {
		t.Fatalf("%v", err)
	}
	if err := nicheCheckBody("future If-Modified-Since", fresh.body, ""); err != nil {
		t.Fatalf("%v", err)
	}

	// The EMBEDDED residual: /script.js exists only in the vendored tree, so it must serve 200 + a range
	// but carry no ETag. This is the documented boundary of static.go:46-49, not an accident.
	embedded := nicheDo(t, client, http.MethodGet, "/script.js", nil, [][2]string{{"Range", "bytes=0-0"}})
	if err := nicheCheckStatus("embedded range", embedded.status, 206); err != nil {
		t.Fatalf("%v", err)
	}
	if err := nicheCheckHeader("embedded range", "Content-Type", embedded.header.Get("Content-Type"), "application/javascript; charset=UTF-8"); err != nil {
		t.Fatalf("%v", err)
	}
	if err := nicheCheckHeaderAbsent("embedded range", "ETag", embedded.header.Get("ETag")); err != nil {
		t.Fatalf("%v: the embedded tree has no stat identity; static.go:46-49 records this residual", err)
	}
	if !strings.HasPrefix(embedded.header.Get("Content-Range"), "bytes 0-0/") {
		t.Fatalf("embedded range Content-Range = %q, want a bytes 0-0/<size> form", embedded.header.Get("Content-Range"))
	}
}

// HTTP-006: path normalisation and directory-escape attempts. `..` encoded as %2F or as %2e%2e must not
// reach anything outside the frontend tree, and the two percent-decoded forms answer differently (403 for
// the /characters/ mount, 404 for the root static handler) because they reach different handlers -- that
// distinction is the observable, so it is asserted exactly.
func TestNicheHTTPPathEncodingsAndTraversalRefusals(t *testing.T) {
	tree := newNicheTree(t)
	booted := tree.boot(t, nil)
	client := booted.client

	trailing := nicheDo(t, client, http.MethodGet, "/version/", nil, nil)
	if err := nicheCheckStatus("GET /version/", trailing.status, 404); err != nil {
		t.Fatalf("%v", err)
	}
	if err := nicheCheckHeader("GET /version/", "Content-Type", trailing.header.Get("Content-Type"), "text/html; charset=utf-8"); err != nil {
		t.Fatalf("%v", err)
	}

	double := nicheDoNoRedirect(t, client, http.MethodGet, "//version")
	if err := nicheCheckStatus("GET //version", double.status, 307); err != nil {
		t.Fatalf("%v", err)
	}
	if err := nicheCheckHeader("GET //version", "Location", double.header.Get("Location"), "/version"); err != nil {
		t.Fatalf("%v", err)
	}

	encoded := nicheDo(t, client, http.MethodGet, "/%76ersion", nil, nil)
	if err := nicheCheckStatus("GET /%76ersion", encoded.status, 200); err != nil {
		t.Fatalf("%v: an encoded path character must decode before the mux matches", err)
	}
	if err := nicheCheckContains("GET /%76ersion", encoded.body, `"pkgVersion"`); err != nil {
		t.Fatalf("%v", err)
	}

	query := nicheDo(t, client, http.MethodGet, "/version?a=1&a=2", nil, nil)
	if err := nicheCheckStatus("GET /version?a=1&a=2", query.status, 200); err != nil {
		t.Fatalf("%v", err)
	}
	if err := nicheCheckBody("GET /version?a=1&a=2", query.body, encoded.body); err != nil {
		t.Fatalf("%v: duplicate query parameters must not change the route's answer", err)
	}

	// Directory escape through the characters mount: refused as POLICY (403 text/plain Forbidden), which is
	// distinguishable from the 404 of a path that simply does not exist.
	escape := nicheDo(t, client, http.MethodGet, "/characters/..%2F..%2Fconfig.yaml", nil, nil)
	if err := nicheCheckStatus("GET /characters/..%2F..%2Fconfig.yaml", escape.status, 403); err != nil {
		t.Fatalf("%v", err)
	}
	if err := nicheCheckBody("GET /characters/..%2F..%2Fconfig.yaml", escape.body, "Forbidden"); err != nil {
		t.Fatalf("%v", err)
	}
	if err := nicheCheckHeader("GET /characters/..%2F..%2Fconfig.yaml", "Content-Type", escape.header.Get("Content-Type"), "text/plain; charset=utf-8"); err != nil {
		t.Fatalf("%v", err)
	}
	for _, path := range []string{"/..%2Fconfig.yaml", "/%2e%2e/config.yaml"} {
		response := nicheDo(t, client, http.MethodGet, path, nil, nil)
		if err := nicheCheckStatus("GET "+path, response.status, 404); err != nil {
			t.Fatalf("%v", err)
		}
		if err := nicheCheckContains("GET "+path, response.body, "Not Found"); err != nil {
			t.Fatalf("%v", err)
		}
	}
}
