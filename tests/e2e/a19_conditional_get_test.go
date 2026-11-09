package e2e

// LAYER-B PRODUCT BUG, REPRODUCED BEFORE THE FIX: `GET /api/extensions/discover` answers 200 with the full
// JSON body where pinned answers 304 for a conditional request whose `If-None-Match` matches the response's
// weak ETag. The OBSERVABLE behaviour this test asserts is pinned's, measured on 2026-11-08 against the
// pinned checkout at 06bde939 using a RAW SOCKET (no client cache, no undici quirks):
//
//	GET  /api/extensions/discover  (no conditional)                    -> 200, Content-Type
//	       application/json; charset=utf-8, Content-Length 523, ETag W/"20b-…"
//	GET  /api/extensions/discover  If-None-Match: W/"20b-…"             -> 304, Vary: Origin, ETag kept,
//	                                                                      NO Content-Type, NO Content-Length
//	GET  ...  If-None-Match: "20b-…"     (strong form of the same tag)   -> 304
//	GET  ...  If-None-Match: "nope", W/"20b-…" (multi-value list)       -> 304
//	GET  ...  If-None-Match: *                                          -> 304
//	GET  ...  If-None-Match: "nope"                                     -> 200 + body
//	GET  ...  If-None-Match: <match> + Cache-Control: no-cache          -> 200 + body
//	GET  ...  If-Modified-Since: <future> (the route sends no Last-Modified) -> 200 + body
//	HEAD ...  If-None-Match: <match>                                    -> 304 with the same header face
//	HEAD ...  (no conditional)                                          -> 200, Content-Type/Length/ETag
//
// WHY THESE ARE PINNED'S RULES AND NOT MINE: pinned's route is an Express `router.get('/discover', ...)`
// whose last statement is `response.send(...)` (src/endpoints/extensions.js:479-...). Express's `res.send`
// sets the weak ETag and then, for GET/HEAD, answers 304 when `req.fresh` — the `fresh` package, which
// returns false when there is no If-None-Match/If-Modified-Since, false when the request `Cache-Control`
// contains `no-cache`, compares If-None-Match as a token list with weak/strong equivalence, and ignores
// `Pragma`. It can only honour If-Modified-Since when the response carries Last-Modified, and this route
// carries none. GoTavern's writer set the same ETag but had no request and never checked freshness
// (internal/httpx/httpx.go:32-41), which is why the browser re-downloaded 523 bytes where pinned answered
// 304 — and why the live oracle's layer-B comparison reds.
//
// THE GENERAL GAP IS RECORDED, NOT FIXED HERE: every Express JSON GET route gets this behaviour for free;
// this patch routes only /api/extensions/discover through the new conditional writer (docs/compat-matrix.md
// keeps the rest as `partial`).

import (
	"io"
	"net/http"
	"regexp"
	"strings"
	"testing"
)

// pinnedWeakETagShape is the shape of Express's weak ETag: W/"<hex body length>-<27 base64 characters>".
// The test does not derive the expected tag from GoTavern's own httpx.WeakETag: the SHAPE is checked here
// and every behavioural assertion uses the tag the server itself returned, so the oracle is pinned's
// measured behaviour rather than the implementation under test.
var pinnedWeakETagShape = regexp.MustCompile(`^W/"[0-9a-f]+-[A-Za-z0-9+/]{27}"$`)

// conditionalGet performs one GET/HEAD with the given headers and returns everything the assertions need,
// including the header MAP so "Content-Type absent" is a statement about presence, not about an empty value.
func conditionalGet(t *testing.T, origin, method string, headers map[string]string) (*http.Response, string, http.Header) {
	t.Helper()
	request, err := http.NewRequest(method, origin+"/api/extensions/discover", nil)
	if err != nil {
		t.Fatalf("build %s request: %v", method, err)
	}
	for name, value := range headers {
		request.Header.Set(name, value)
	}
	// A fresh client per request, and a transport that never serves from a cache: a cached answer could
	// make a broken server look fresh (the failure this test exists to prove).
	client := &http.Client{Transport: &http.Transport{DisableKeepAlives: true}}
	response, err := client.Do(request)
	if err != nil {
		t.Fatalf("%s /api/extensions/discover: %v", method, err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatalf("read %s body: %v", method, err)
	}
	return response, string(body), response.Header.Clone()
}

// assertNoRepresentationHeaders is pinned's 304 face: no Content-Type and no Content-Length travel with a
// 304 from this route (measured with a raw socket; Express removes them for a fresh response).
func assertNoRepresentationHeaders(t *testing.T, label string, header http.Header) {
	t.Helper()
	if value, present := header["Content-Type"]; present {
		t.Fatalf("%s: a 304 must not carry Content-Type; got %q", label, value)
	}
	if value, present := header["Content-Length"]; present {
		t.Fatalf("%s: a 304 must not carry Content-Length; got %q", label, value)
	}
}

// TestA19ExtensionsDiscoverConditionalGetMatchesPinnedExpressFreshness is the RED test for the conditional-GET
// gap: it fails on the pre-fix tree at the matching-If-None-Match case with "got 200 (523 bytes), want 304".
func TestA19ExtensionsDiscoverConditionalGetMatchesPinnedExpressFreshness(t *testing.T) {
	requireProductionTransport(t)
	server := bootServer(t, nil)
	defer server.stop()

	first, firstBody, firstHeader := conditionalGet(t, server.origin, http.MethodGet, nil)
	if first.StatusCode != http.StatusOK {
		t.Fatalf("unconditional GET /api/extensions/discover = %d, want 200 (pinned answers 200 with the JSON list); headers %v", first.StatusCode, firstHeader)
	}
	etag := first.Header.Get("ETag")
	if !pinnedWeakETagShape.MatchString(etag) {
		t.Fatalf("ETag = %q; pinned Express emits a weak tag of the shape %q", etag, pinnedWeakETagShape.String())
	}
	if contentType := first.Header.Get("Content-Type"); contentType != "application/json; charset=utf-8" {
		t.Fatalf("unconditional GET Content-Type = %q, want application/json; charset=utf-8", contentType)
	}
	if firstBody == "" {
		t.Fatalf("unconditional GET returned an empty body; the fixture is only meaningful with a body to revalidate")
	}

	// THE BUG: a matching If-None-Match must be 304 with no representation, not 200 + the whole body.
	t.Run("matching weak If-None-Match is 304 with no representation", func(t *testing.T) {
		response, body, header := conditionalGet(t, server.origin, http.MethodGet, map[string]string{"If-None-Match": etag})
		if response.StatusCode != http.StatusNotModified {
			t.Fatalf("GET with If-None-Match: %s = %d (%d bytes), want 304 (pinned Express res.send answers 304 when req.fresh); headers %v", etag, response.StatusCode, len(body), header)
		}
		if body != "" {
			t.Fatalf("a 304 must carry an empty body; got %d bytes", len(body))
		}
		assertNoRepresentationHeaders(t, "matching If-None-Match", header)
		if got := response.Header.Get("ETag"); got != etag {
			t.Fatalf("a 304 must preserve the ETag %q; got %q", etag, got)
		}
		// Pinned's 304 face carries Vary: Origin ONLY (raw-socket measurement): the compression middleware's
		// Accept-Encoding token describes a representation, and a 304 has none.
		if got := response.Header.Get("Vary"); got != "Origin" {
			t.Fatalf("304 Vary = %q, want %q (Accept-Encoding belongs to a representation, not a 304)", got, "Origin")
		}
	})

	t.Run("strong form of the same tag is 304", func(t *testing.T) {
		strong := strings.TrimPrefix(etag, "W/")
		response, body, _ := conditionalGet(t, server.origin, http.MethodGet, map[string]string{"If-None-Match": strong})
		if response.StatusCode != http.StatusNotModified {
			t.Fatalf("GET with strong If-None-Match: %s = %d, want 304 (the fresh module compares weak and strong forms as equivalent); headers %v", strong, response.StatusCode, response.Header)
		}
		if body != "" {
			t.Fatalf("a 304 must carry an empty body; got %d bytes", len(body))
		}
	})

	t.Run("multi-value If-None-Match containing the tag is 304", func(t *testing.T) {
		response, _, _ := conditionalGet(t, server.origin, http.MethodGet, map[string]string{"If-None-Match": `"nope", ` + etag})
		if response.StatusCode != http.StatusNotModified {
			t.Fatalf("GET with If-None-Match: \"nope\", %s = %d, want 304 (fresh parses the header as a token list)", etag, response.StatusCode)
		}
	})

	t.Run("wildcard If-None-Match is 304", func(t *testing.T) {
		response, _, _ := conditionalGet(t, server.origin, http.MethodGet, map[string]string{"If-None-Match": "*"})
		if response.StatusCode != http.StatusNotModified {
			t.Fatalf("GET with If-None-Match: * = %d, want 304 (fresh treats * as fresh whenever an ETag exists)", response.StatusCode)
		}
	})

	t.Run("non-matching If-None-Match is 200 with the body", func(t *testing.T) {
		response, body, header := conditionalGet(t, server.origin, http.MethodGet, map[string]string{"If-None-Match": `"nope"`})
		if response.StatusCode != http.StatusOK {
			t.Fatalf("GET with a non-matching If-None-Match = %d, want 200 (a stale validator must not be treated as fresh); headers %v", response.StatusCode, header)
		}
		if body != firstBody {
			t.Fatalf("a 200 revalidation must return the same body: got %d bytes, first response had %d", len(body), len(firstBody))
		}
	})

	t.Run("Cache-Control no-cache forces 200", func(t *testing.T) {
		response, body, header := conditionalGet(t, server.origin, http.MethodGet, map[string]string{"If-None-Match": etag, "Cache-Control": "no-cache"})
		if response.StatusCode != http.StatusOK {
			t.Fatalf("GET with If-None-Match and Cache-Control: no-cache = %d, want 200 (fresh refuses to be fresh when the request says no-cache); headers %v", response.StatusCode, header)
		}
		if body != firstBody {
			t.Fatalf("the 200 body = %d bytes, first response had %d", len(body), len(firstBody))
		}
	})

	t.Run("If-Modified-Since alone is 200 because the route sends no Last-Modified", func(t *testing.T) {
		response, _, header := conditionalGet(t, server.origin, http.MethodGet, map[string]string{"If-Modified-Since": "Wed, 01 Jan 2031 00:00:00 GMT"})
		if response.StatusCode != http.StatusOK {
			t.Fatalf("GET with If-Modified-Since only = %d, want 200 (fresh needs a response Last-Modified to honour it, and this route sends none); headers %v", response.StatusCode, header)
		}
	})

	t.Run("HEAD has the same 304 face", func(t *testing.T) {
		response, _, _ := conditionalGet(t, server.origin, http.MethodHead, map[string]string{"If-None-Match": etag})
		if response.StatusCode != http.StatusNotModified {
			t.Fatalf("HEAD with If-None-Match: %s = %d, want 304 (Express checks freshness for HEAD as well)", etag, response.StatusCode)
		}
	})

	t.Run("HEAD without a conditional is a 200 with representation headers", func(t *testing.T) {
		response, _, header := conditionalGet(t, server.origin, http.MethodHead, nil)
		if response.StatusCode != http.StatusOK {
			t.Fatalf("HEAD /api/extensions/discover = %d, want 200", response.StatusCode)
		}
		if header.Get("ETag") != etag || header.Get("Content-Type") == "" {
			t.Fatalf("HEAD 200 must carry the same ETag %q and a Content-Type; headers %v", etag, header)
		}
	})
}
