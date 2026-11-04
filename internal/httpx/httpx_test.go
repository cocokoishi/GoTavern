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
