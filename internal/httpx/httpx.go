// Package httpx owns the HTTP response conventions that every GoTavern handler shares: the weak ETag
// the pinned express server emits, the JSON-bytes writer that fixes Content-Type/Length/ETag before the
// status line, and the plain-text status response used when a JSON body cannot be produced.
//
// MOVED, NOT REWRITTEN (GOAL.md §15.4). Every function below was extracted byte-for-byte from
// internal/server, where it had grown three callers and no owner; the tests that covered them
// (internal/httpx/httpx_test.go) pin the same bytes and headers the server tests pinned. No behaviour
// may change here without a differential gate: these headers are part of the pinned wire contract.
package httpx

import (
	"crypto/sha1" //nolint:gosec // the pinned express stack uses sha1 for weak ETags; this is not a security digest
	"encoding/base64"
	"fmt"
	"net/http"
	"regexp"
	"strconv"
	"strings"
)

// WeakETag reproduces express's weak ETag for a response body: sha1 over the exact bytes, base64 of the
// digest truncated to 27 characters, prefixed with the decimal body length. The 27-character truncation
// is express's own (its etag package slices the base64 digest to 27), and the server tests compare the
// literal header, so this is a wire contract rather than an implementation detail.
func WeakETag(body []byte) string {
	digest := sha1.Sum(body)
	encoded := base64.StdEncoding.EncodeToString(digest[:])
	return fmt.Sprintf("W/\"%x-%s\"", len(body), encoded[:27])
}

// WriteJSONBytes writes a response body that is already JSON, setting Content-Type, Content-Length and
// the weak ETag before the status line. Callers that already hold encoded bytes must use this rather
// than re-marshalling, because a re-encode can change bytes the pinned client compares.
func WriteJSONBytes(w http.ResponseWriter, status int, body []byte) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Content-Length", strconv.Itoa(len(body)))
	w.Header().Set("ETag", WeakETag(body))
	w.WriteHeader(status)
	_, _ = w.Write(body)
}

// WriteStatusText answers with the status line's own text, which is what the pinned server does when it
// cannot produce a JSON body. 204 and 304 are answered without a body or Content-Length, exactly as the
// pinned stack does.
func WriteStatusText(w http.ResponseWriter, status int) {
	if status == http.StatusNoContent || status == http.StatusNotModified {
		w.WriteHeader(status)
		return
	}
	body := []byte(http.StatusText(status))
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("Content-Length", strconv.Itoa(len(body)))
	w.Header().Set("ETag", WeakETag(body))
	w.WriteHeader(status)
	_, _ = w.Write(body)
}

// conditionalNoCachePattern is Express's `fresh` rule for a request that asks not to be served from cache:
// the `fresh` package tests the request Cache-Control for a `no-cache` token and refuses to be fresh.
var conditionalNoCachePattern = regexp.MustCompile(`(?:^|,)\s*?no-cache\s*?(?:,|$)`)

// IsFresh reproduces express's `req.fresh` for a response that carries `etag`, as the pinned stack applies it
// inside `res.send`: the request must be a conditional GET/HEAD carrying If-None-Match and/or If-Modified-Since;
// a request `Cache-Control` containing `no-cache` is never fresh; If-None-Match is parsed as a token list and
// compared with weak/strong equivalence (`*` matches any existing tag); If-Modified-Since can only be honoured
// when the response carries Last-Modified, which the JSON writer below does not emit, so an
// If-Modified-Since-only request is NOT fresh here. Every rule was measured against the pinned server with a
// raw socket on 2026-11-08 (see tests/e2e/a19_conditional_get_test.go for the matrix).
func IsFresh(r *http.Request, etag string) bool {
	if r == nil {
		return false
	}
	if method := r.Method; method != http.MethodGet && method != http.MethodHead {
		return false
	}
	noneMatch := r.Header.Get("If-None-Match")
	modifiedSince := r.Header.Get("If-Modified-Since")
	if noneMatch == "" && modifiedSince == "" {
		return false
	}
	if cacheControl := r.Header.Get("Cache-Control"); cacheControl != "" && conditionalNoCachePattern.MatchString(cacheControl) {
		return false
	}
	if noneMatch == "" {
		// If-Modified-Since alone: the writer emits no Last-Modified, so express's fresh module cannot judge it.
		return false
	}
	if noneMatch == "*" {
		return true
	}
	if etag == "" {
		return false
	}
	for _, token := range strings.Split(noneMatch, ",") {
		candidate := strings.TrimSpace(token)
		if candidate == "" {
			continue
		}
		if candidate == etag || candidate == "W/"+etag || "W/"+candidate == etag {
			return true
		}
	}
	return false
}

// WriteJSONBytesConditional is WriteJSONBytes with the pinned stack's freshness check in front of it: a
// conditional GET/HEAD whose validator matches the body's weak ETag receives the 304 face (ETag preserved,
// NO Content-Type and NO Content-Length because there is no representation), exactly as express's `res.send`
// answers the pinned route. Every other request takes the unchanged WriteJSONBytes path.
func WriteJSONBytesConditional(w http.ResponseWriter, r *http.Request, status int, body []byte) {
	etag := WeakETag(body)
	if status == http.StatusOK && IsFresh(r, etag) {
		w.Header().Set("ETag", etag)
		// THE PINNED 304 FACE (raw-socket measurement, docs/alpha19/findings/layer-b-conditional-get.md):
		// `Vary: Origin` only. The compression middleware appends Accept-Encoding to a REPRESENTATION it could
		// compress; a 304 has none, so pinned's 304 does not carry that token. The middleware here has already
		// appended it (it runs before the handler knows the status), so the token is removed to match.
		dropAcceptEncodingVary(w.Header())
		w.WriteHeader(http.StatusNotModified)
		return
	}
	WriteJSONBytes(w, status, body)
}

// dropAcceptEncodingVary removes the Accept-Encoding token from Vary, leaving the other Vary tokens (and deleting
// the header entirely when nothing else remains).
func dropAcceptEncodingVary(header http.Header) {
	values := header.Values("Vary")
	if len(values) == 0 {
		return
	}
	tokens := make([]string, 0, len(values))
	for _, value := range values {
		for _, token := range strings.Split(value, ",") {
			token = strings.TrimSpace(token)
			if token == "" || strings.EqualFold(token, "Accept-Encoding") {
				continue
			}
			tokens = append(tokens, token)
		}
	}
	if len(tokens) == 0 {
		header.Del("Vary")
		return
	}
	header.Set("Vary", strings.Join(tokens, ", "))
}
