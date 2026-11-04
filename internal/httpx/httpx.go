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
	"strconv"
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
