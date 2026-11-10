package server

// alpha.20 source-audit: the browser's page-load `/version` request is the only remaining JSON GET route
// that cannot answer a conditional request.
//
// MEASUREMENT FIRST (the Lead's instruction): the pinned frontend fetches `/version` on startup
// (public/script.js:504). Pinned's route is `app.get('/version', async (_, response) => { const data =
// await getVersion(); response.send(data); })` (src/server-main.js:272-275). `res.send(object)` is the
// SAME Express send path whose 304 face was measured with a raw socket for /api/extensions/discover in
// docs/alpha19/findings/layer-b-conditional-get.md: weak ETag, and on a fresh conditional GET/HEAD a 304
// with the ETag preserved and NO representation headers. GoTavern registered every other GET JSON route's
// conditional face in alpha.19 (/api/extensions/discover, /api/data-maid/view, /api/sprites/get,
// /api/users/me) -- the measured GET /api surface is exactly those plus /version, /csrf-token (its body
// carries a NEW token every request, so its ETag never matches and Express cannot answer 304) and the
// static/HTML routes. `/version` was therefore the whole remaining gap, not a class: this test measures
// that single route.

import (
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

func a20VersionRequest(t *testing.T, handler http.Handler, method string, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(method, "/version", nil)
	for name, value := range headers {
		request.Header.Set(name, value)
	}
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	return recorder
}

func TestA20VersionAnswersPinnedExpressFreshness(t *testing.T) {
	dataRoot := t.TempDir()
	handler := NewHTTPHandlerWithOptions(HTTPHandlerOptions{InstallRoot: dataRoot, DataRoot: dataRoot, DisableCSRF: true})

	first := a20VersionRequest(t, handler, http.MethodGet, nil)
	if first.Code != http.StatusOK {
		t.Fatalf("GET /version = %d, want 200", first.Code)
	}
	etag := first.Header().Get("ETag")
	if etag == "" {
		t.Fatalf("GET /version carries no ETag; pinned res.send sets one")
	}
	body, err := io.ReadAll(first.Body)
	if err != nil || len(body) == 0 {
		t.Fatalf("GET /version body: %d bytes, err %v", len(body), err)
	}

	cases := []struct {
		name       string
		method     string
		headers    map[string]string
		wantStatus int
		wantBody   bool
	}{
		{name: "matching weak If-None-Match is 304", method: http.MethodGet,
			headers: map[string]string{"If-None-Match": etag}, wantStatus: http.StatusNotModified},
		{name: "matching strong If-None-Match is 304", method: http.MethodGet,
			headers: map[string]string{"If-None-Match": etag[2:]}, wantStatus: http.StatusNotModified},
		{name: "HEAD revalidates too", method: http.MethodHead,
			headers: map[string]string{"If-None-Match": etag}, wantStatus: http.StatusNotModified},
		{name: "non-matching tag is 200 with the body", method: http.MethodGet,
			headers: map[string]string{"If-None-Match": `"nope"`}, wantStatus: http.StatusOK, wantBody: true},
		{name: "Cache-Control: no-cache is never fresh", method: http.MethodGet,
			headers: map[string]string{"If-None-Match": etag, "Cache-Control": "no-cache"}, wantStatus: http.StatusOK, wantBody: true},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			response := a20VersionRequest(t, handler, testCase.method, testCase.headers)
			if response.Code != testCase.wantStatus {
				t.Fatalf("%s + If-None-Match = %d, want %d (pinned res.send answers the measured 304 face)",
					testCase.method, response.Code, testCase.wantStatus)
			}
			if response.Code == http.StatusNotModified {
				if got := response.Header().Get("ETag"); got != etag {
					t.Fatalf("304 ETag = %q, want %q", got, etag)
				}
				if got := response.Header().Get("Content-Type"); got != "" {
					t.Fatalf("304 carries Content-Type %q; the pinned 304 face has no representation headers", got)
				}
				if got := response.Header().Get("Content-Length"); got != "" {
					t.Fatalf("304 carries Content-Length %q; the pinned 304 face has none", got)
				}
				if response.Body.Len() != 0 {
					t.Fatalf("304 carries a body of %d bytes", response.Body.Len())
				}
			}
			if testCase.wantBody && response.Body.Len() == 0 {
				t.Fatalf("%s + If-None-Match should have a representation, got no body", testCase.method)
			}
		})
	}
}
