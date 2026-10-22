package server

// Contract tests for the two pinned frontend-asset routes GoTavern did not serve, and that the
// extension E2E pair found as 404s where pinned answered 200.
//
// These are SOURCE-DERIVED (rule 4), labelled as such: the oracle is the pinned source, not a
// capture, because both routes need a session and a data root that no route-level fixture carries.
// The pinned lines are named per assertion:
//
//	GET /backgrounds/*   src/users.js:1213 (createRouteHandler, users.js:1092-1112)
//	GET /css/user.css    src/middleware/userCss.js:8-16, mounted at src/server-main.js:241, BEFORE
//	                     express.static (:242) and requireLoginMiddleware (:248)
//
// The end-to-end evidence that these routes now agree with pinned is the re-recorded extension pair,
// where `/backgrounds/__transparent.png` and `/css/user.css` stop being rows that differ.

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const frontendAssetCookieSecret = "gotavern-frontend-asset-cookie-secret"

type frontendAssetHarness struct {
	handler  http.Handler
	cookie   string
	token    string
	dataRoot string
}

func newFrontendAssetHarness(t *testing.T) frontendAssetHarness {
	t.Helper()
	dataRoot := t.TempDir()
	installRoot := t.TempDir()
	handler, cookie, token := newSDRouteHandler(t, dataRoot, installRoot, frontendAssetCookieSecret, sdFixtureAccount{
		Handle: "default-user", Name: "Frontend Asset Probe", Admin: true,
	})
	return frontendAssetHarness{handler: handler, cookie: cookie, token: token, dataRoot: dataRoot}
}

func (harness frontendAssetHarness) get(t *testing.T, target string, authenticated bool) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(http.MethodGet, target, nil)
	if authenticated {
		request.Header.Set("Cookie", harness.cookie)
	}
	recorder := httptest.NewRecorder()
	harness.handler.ServeHTTP(recorder, request)
	return recorder
}

// TestBackgroundsStaticMatchesPinnedCreateRouteHandler covers users.js:1213.
func TestBackgroundsStaticMatchesPinnedCreateRouteHandler(t *testing.T) {
	harness := newFrontendAssetHarness(t)
	backgrounds := filepath.Join(harness.dataRoot, "default-user", "backgrounds")
	body := []byte("PNG-BACKGROUND")
	if err := os.WriteFile(filepath.Join(backgrounds, "scene.png"), body, 0o600); err != nil {
		t.Fatal(err)
	}

	found := harness.get(t, "/backgrounds/scene.png", true)
	if found.Code != http.StatusOK {
		t.Fatalf("GET /backgrounds/scene.png = %d, pinned sends the file (body %q)", found.Code, found.Body.String())
	}
	if found.Body.String() != string(body) {
		t.Fatalf("GET /backgrounds/scene.png body = %q, want %q", found.Body.String(), body)
	}
	// send() sets these; an embedded asset cannot, which is why the route must serve from disk.
	for header, want := range map[string]string{
		"Content-Type":  "image/png",
		"Accept-Ranges": "bytes",
		"Cache-Control": "public, max-age=0",
	} {
		if got := found.Header().Get(header); got != want {
			t.Fatalf("GET /backgrounds/scene.png %s = %q, pinned sends %q", header, got, want)
		}
	}
	if found.Header().Get("ETag") == "" || found.Header().Get("Last-Modified") == "" {
		t.Fatalf("GET /backgrounds/scene.png validators = ETag %q / Last-Modified %q; send() always sends both",
			found.Header().Get("ETag"), found.Header().Get("Last-Modified"))
	}

	// createRouteHandler's own 404 is res.sendStatus, i.e. text/plain, not the application 404 page.
	missing := harness.get(t, "/backgrounds/absent.png", true)
	if missing.Code != http.StatusNotFound || !strings.HasPrefix(missing.Header().Get("Content-Type"), "text/plain") {
		t.Fatalf("GET /backgrounds/absent.png = %d %q, pinned answers 404 text/plain", missing.Code, missing.Header().Get("Content-Type"))
	}

	// A nested capture is served from the same root: the wildcard is multi-segment, exactly like the
	// pinned mount. The containment check itself is NOT reachable through Go's mux -- net/http
	// normalises .. and %2f before the handler runs, which extensions_static.go records as a known
	// gap for the same reason -- so it is cited rather than asserted here.
	subdirectory := filepath.Join(backgrounds, "nested")
	if err := os.MkdirAll(subdirectory, 0o777); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(subdirectory, "deep.png"), []byte("DEEP"), 0o600); err != nil {
		t.Fatal(err)
	}
	nested := harness.get(t, "/backgrounds/nested/deep.png", true)
	if nested.Code != http.StatusOK || nested.Body.String() != "DEEP" {
		t.Fatalf("GET /backgrounds/nested/deep.png = %d body %q, pinned serves it", nested.Code, nested.Body.String())
	}

	// res.sendFile throws for an empty path and the route's catch answers 500.
	empty := harness.get(t, "/backgrounds/", true)
	if empty.Code != http.StatusInternalServerError {
		t.Fatalf("GET /backgrounds/ = %d, pinned answers 500 for the empty capture", empty.Code)
	}

	// The route lives in the private router, so it is not public.
	anonymous := harness.get(t, "/backgrounds/scene.png", false)
	if anonymous.Code != http.StatusForbidden {
		t.Fatalf("anonymous GET /backgrounds/scene.png = %d, the pinned route requires a session", anonymous.Code)
	}
}

// TestUserCSSOverrideMatchesPinnedMiddleware covers src/middleware/userCss.js and its mount order.
func TestUserCSSOverrideMatchesPinnedMiddleware(t *testing.T) {
	harness := newFrontendAssetHarness(t)

	// Absent: the middleware falls through to express.static, which does not carry the file, so an
	// authenticated request reaches the application 404 page.
	absent := harness.get(t, "/css/user.css", true)
	if absent.Code != http.StatusNotFound {
		t.Fatalf("GET /css/user.css without an override = %d, pinned falls through to a 404", absent.Code)
	}

	override := filepath.Join(harness.dataRoot, "_css", "user.css")
	if err := os.MkdirAll(filepath.Dir(override), 0o777); err != nil {
		t.Fatal(err)
	}
	stylesheet := "body { --probe: 1; }\n"
	if err := os.WriteFile(override, []byte(stylesheet), 0o600); err != nil {
		t.Fatal(err)
	}

	// The middleware is mounted BEFORE requireLoginMiddleware, so this is served to a browser with
	// no session at all. That is the whole point of the publicness clause beside it.
	anonymous := harness.get(t, "/css/user.css", false)
	if anonymous.Code != http.StatusOK {
		t.Fatalf("anonymous GET /css/user.css with an override = %d, pinned serves it before login (body %q)", anonymous.Code, anonymous.Body.String())
	}
	if anonymous.Body.String() != stylesheet {
		t.Fatalf("GET /css/user.css body = %q, want %q", anonymous.Body.String(), stylesheet)
	}
	if got := anonymous.Header().Get("Content-Type"); got != "text/css; charset=UTF-8" {
		t.Fatalf("GET /css/user.css Content-Type = %q, mime@1.6.0 answers %q", got, "text/css; charset=UTF-8")
	}
	if anonymous.Header().Get("ETag") == "" || anonymous.Header().Get("Last-Modified") == "" {
		t.Fatalf("GET /css/user.css validators = ETag %q / Last-Modified %q; send() always sends both",
			anonymous.Header().Get("ETag"), anonymous.Header().Get("Last-Modified"))
	}

	// HEAD is not the middleware's method: it falls through exactly as pinned's `req.method === 'GET'`
	// check does, so the embedded static handler answers instead (and that file does not exist).
	head := httptest.NewRecorder()
	harness.handler.ServeHTTP(head, httptest.NewRequest(http.MethodHead, "/css/user.css", nil))
	if head.Code == http.StatusOK {
		t.Fatalf("HEAD /css/user.css = %d; pinned's middleware only answers GET", head.Code)
	}
}
