package httpx

import (
	"crypto/sha1" //nolint:gosec // the pinned express stack uses sha1 for weak ETags; this is not a security digest
	"encoding/base64"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
)

// expectedWeakETag is written out independently of WeakETag so the test pins the PINNED EXPRESS SHAPE
// (W/"<length>-<first 27 base64 chars of the sha1 digest>") rather than agreeing with the code it tests.
func expectedWeakETag(body []byte) string {
	digest := sha1.Sum(body)
	encoded := base64.StdEncoding.EncodeToString(digest[:])
	return fmt.Sprintf("W/\"%x-%s\"", len(body), encoded[:27])
}

func TestWeakETagMatchesThePinnedExpressShape(t *testing.T) {
	cases := [][]byte{[]byte(""), []byte("{}"), []byte(`{"message":"ok"}`), []byte("status text")}
	for _, body := range cases {
		if got, want := WeakETag(body), expectedWeakETag(body); got != want {
			t.Fatalf("WeakETag(%q) = %q, want %q", body, got, want)
		}
	}
}

func TestWriteJSONBytesSetsTheHeadersThePinnedStackSets(t *testing.T) {
	body := []byte(`{"message":"ok"}`)
	recorder := httptest.NewRecorder()
	WriteJSONBytes(recorder, http.StatusBadRequest, body)

	if got := recorder.Code; got != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d", got, http.StatusBadRequest)
	}
	if got := recorder.Header().Get("Content-Type"); got != "application/json; charset=utf-8" {
		t.Fatalf("Content-Type = %q", got)
	}
	if got := recorder.Header().Get("Content-Length"); got != fmt.Sprintf("%d", len(body)) {
		t.Fatalf("Content-Length = %q, want %d", got, len(body))
	}
	if got := recorder.Header().Get("ETag"); got != expectedWeakETag(body) {
		t.Fatalf("ETag = %q, want %q", got, expectedWeakETag(body))
	}
	if got := recorder.Body.String(); got != string(body) {
		t.Fatalf("body = %q, want %q", got, string(body))
	}
}

func TestWriteStatusTextAnswersNoContentAndNotModifiedWithoutABody(t *testing.T) {
	for _, status := range []int{http.StatusNoContent, http.StatusNotModified} {
		recorder := httptest.NewRecorder()
		WriteStatusText(recorder, status)

		if got := recorder.Code; got != status {
			t.Fatalf("status = %d, want %d", got, status)
		}
		if got := recorder.Body.Len(); got != 0 {
			t.Fatalf("status %d wrote %d body bytes, want 0", status, got)
		}
		if got := recorder.Header().Get("Content-Type"); got != "" {
			t.Fatalf("status %d set Content-Type %q, want none", status, got)
		}
	}
}

func TestWriteStatusTextCarriesTheStatusTextAndETag(t *testing.T) {
	recorder := httptest.NewRecorder()
	WriteStatusText(recorder, http.StatusTeapot)

	body := []byte(http.StatusText(http.StatusTeapot))
	if got := recorder.Body.String(); got != string(body) {
		t.Fatalf("body = %q, want %q", got, string(body))
	}
	if got := recorder.Header().Get("Content-Type"); got != "text/plain; charset=utf-8" {
		t.Fatalf("Content-Type = %q", got)
	}
	if got := recorder.Header().Get("ETag"); got != expectedWeakETag(body) {
		t.Fatalf("ETag = %q, want %q", got, expectedWeakETag(body))
	}
}

// TestIsFreshMatchesPinnedExpressFreshness pins the rules measured against the pinned server with a raw
// socket on 2026-11-08 (the matrix and the route are in tests/e2e/a19_conditional_get_test.go): a
// conditional GET/HEAD is fresh when If-None-Match matches the response's weak tag (weak/strong forms are
// equivalent, a token list is parsed, `*` matches any tag), a request Cache-Control with no-cache is never
// fresh, and If-Modified-Since alone is not fresh because the JSON writer emits no Last-Modified.
func TestIsFreshMatchesPinnedExpressFreshness(t *testing.T) {
	const etag = `W/"20b-ZX5Nge4s+cqyRysIE8Nu06nh73A"`
	build := func(method string, headers map[string]string) *http.Request {
		request := httptest.NewRequest(method, "/api/extensions/discover", nil)
		for name, value := range headers {
			request.Header.Set(name, value)
		}
		return request
	}
	cases := []struct {
		name    string
		request *http.Request
		want    bool
	}{
		{"matching weak", build(http.MethodGet, map[string]string{"If-None-Match": etag}), true},
		{"matching strong form", build(http.MethodGet, map[string]string{"If-None-Match": `"20b-ZX5Nge4s+cqyRysIE8Nu06nh73A"`}), true},
		{"multi-value list containing it", build(http.MethodGet, map[string]string{"If-None-Match": `"nope", ` + etag}), true},
		{"wildcard", build(http.MethodGet, map[string]string{"If-None-Match": "*"}), true},
		{"HEAD matching", build(http.MethodHead, map[string]string{"If-None-Match": etag}), true},
		{"non-matching", build(http.MethodGet, map[string]string{"If-None-Match": `"nope"`}), false},
		{"no conditional", build(http.MethodGet, nil), false},
		{"request no-cache", build(http.MethodGet, map[string]string{"If-None-Match": etag, "Cache-Control": "no-cache"}), false},
		{"request no-cache with other directives", build(http.MethodGet, map[string]string{"If-None-Match": etag, "Cache-Control": "max-age=0, no-cache"}), false},
		{"request max-age=0 stays fresh", build(http.MethodGet, map[string]string{"If-None-Match": etag, "Cache-Control": "max-age=0"}), true},
		{"If-Modified-Since alone", build(http.MethodGet, map[string]string{"If-Modified-Since": "Wed, 01 Jan 2031 00:00:00 GMT"}), false},
		{"Pragma no-cache is ignored", build(http.MethodGet, map[string]string{"If-None-Match": etag, "Pragma": "no-cache"}), true},
		{"POST with a validator is not fresh", build(http.MethodPost, map[string]string{"If-None-Match": etag}), false},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			if got := IsFresh(testCase.request, etag); got != testCase.want {
				t.Fatalf("IsFresh(%s %v) = %v, want %v", testCase.request.Method, testCase.request.Header, got, testCase.want)
			}
		})
	}
}

// TestWriteJSONBytesConditionalKeepsThePinned304Face states that a 304 carries the ETag and NO representation
// headers (measured pinned 304 face), while a non-fresh request gets the unchanged WriteJSONBytes bytes.
func TestWriteJSONBytesConditionalKeepsThePinned304Face(t *testing.T) {
	body := []byte(`[{"type":"system","name":"a"}]`)
	freshRequest := httptest.NewRequest(http.MethodGet, "/api/extensions/discover", nil)
	freshRequest.Header.Set("If-None-Match", WeakETag(body))
	recorder := httptest.NewRecorder()
	WriteJSONBytesConditional(recorder, freshRequest, http.StatusOK, body)
	if recorder.Code != http.StatusNotModified {
		t.Fatalf("fresh conditional request status = %d, want 304", recorder.Code)
	}
	if got := recorder.Body.String(); got != "" {
		t.Fatalf("a 304 must carry no body; got %q", got)
	}
	if got := recorder.Header().Get("ETag"); got != WeakETag(body) {
		t.Fatalf("a 304 must preserve the ETag %q; got %q", WeakETag(body), got)
	}
	if value, present := recorder.Header()["Content-Type"]; present {
		t.Fatalf("a 304 must not carry Content-Type; got %q", value)
	}
	if value, present := recorder.Header()["Content-Length"]; present {
		t.Fatalf("a 304 must not carry Content-Length; got %q", value)
	}

	staleRequest := httptest.NewRequest(http.MethodGet, "/api/extensions/discover", nil)
	staleRequest.Header.Set("If-None-Match", `"nope"`)
	stale := httptest.NewRecorder()
	WriteJSONBytesConditional(stale, staleRequest, http.StatusOK, body)
	if stale.Code != http.StatusOK {
		t.Fatalf("non-fresh request status = %d, want 200", stale.Code)
	}
	if got := stale.Body.String(); got != string(body) {
		t.Fatalf("non-fresh body = %q, want %q", got, string(body))
	}
	if got := stale.Header().Get("Content-Length"); got != fmt.Sprintf("%d", len(body)) {
		t.Fatalf("non-fresh Content-Length = %q", got)
	}
}

// TestWriteJSONBytesConditionalDropsTheCompressionVaryOn304 pins the measured 304 header face: the compression
// middleware has already appended Accept-Encoding (it runs before the handler knows the status), but pinned's 304
// carries Vary: Origin only because a 304 has no representation to compress. The token must be REMOVED, which is
// why the recorder is seeded with it.
func TestWriteJSONBytesConditionalDropsTheCompressionVaryOn304(t *testing.T) {
	body := []byte(`[{"type":"system","name":"a"}]`)
	request := httptest.NewRequest(http.MethodGet, "/api/extensions/discover", nil)
	request.Header.Set("If-None-Match", WeakETag(body))
	recorder := httptest.NewRecorder()
	recorder.Header().Set("Vary", "Origin, Accept-Encoding")
	WriteJSONBytesConditional(recorder, request, http.StatusOK, body)
	if recorder.Code != http.StatusNotModified {
		t.Fatalf("status = %d, want 304", recorder.Code)
	}
	if got := recorder.Header().Get("Vary"); got != "Origin" {
		t.Fatalf("304 Vary = %q, want %q (Accept-Encoding belongs to a representation, not a 304)", got, "Origin")
	}
	// A 200 keeps the compression middleware's Vary untouched.
	stale := httptest.NewRecorder()
	stale.Header().Set("Vary", "Origin, Accept-Encoding")
	WriteJSONBytesConditional(stale, httptest.NewRequest(http.MethodGet, "/api/extensions/discover", nil), http.StatusOK, body)
	if stale.Code != http.StatusOK {
		t.Fatalf("stale status = %d, want 200", stale.Code)
	}
	if got := stale.Header().Get("Vary"); got != "Origin, Accept-Encoding" {
		t.Fatalf("200 Vary = %q, want the middleware value untouched", got)
	}
}