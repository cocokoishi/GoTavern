package server

// THE PANIC BOUNDARY'S OBSERVABLE IS PINNED'S FINALHANDLER PAGE.
//
// The page below is what the pinned stack produced when probed directly against
// pinned's own express 4.22.1 / finalhandler 1.3.1 with NODE_ENV unset (the
// pinned server's default): status 500, finalhandler's headers, and a <pre>
// whose content is the V8 stack (environment-specific, see panic_boundary.go).
// The bytes GoTavern can honestly reproduce are the DOCUMENT: the doctype/head/
// body skeleton, the headers, and finalhandler's message transforms. The tests
// here assert those bytes exactly, and assert that a panic reaches them at all
// (without the boundary net/http closes the connection -- proven by the
// direct-middleware comparison below).

import (
	"errors"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// pinnedFinalHandlerDocumentGolden is finalhandler's createHtmlDocument with
// ONLY its message transforms applied. Expected strings are written out here
// rather than computed by the production helper, so a change in the helper is
// not silently accepted by its own output.
const pinnedFinalHandlerDocumentGolden = "<!DOCTYPE html>\n" +
	"<html lang=\"en\">\n" +
	"<head>\n" +
	"<meta charset=\"utf-8\">\n" +
	"<title>Error</title>\n" +
	"</head>\n" +
	"<body>\n" +
	"<pre>probe string</pre>\n" +
	"</body>\n" +
	"</html>\n"

// The measured pinned Content-Length for `<pre>probe string</pre>` and for the
// production `<pre>Internal Server Error</pre>`; independent of the renderer.
const (
	pinnedProbeStringPageLength = 139
	pinnedProductionPageLength  = 148
	pinnedProbeStringPageBody   = pinnedFinalHandlerDocumentGolden
	pinnedProductionPageBody    = "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n<title>Error</title>\n</head>\n<body>\n<pre>Internal Server Error</pre>\n</body>\n</html>\n"
	// `<pre>boom</pre>` is the same document with a 4-byte message: the measured
	// 139-byte probe page minus "probe string" (12 bytes) plus "boom" (4 bytes).
	pinnedBoomPageBody   = "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n<title>Error</title>\n</head>\n<body>\n<pre>boom</pre>\n</body>\n</html>\n"
	pinnedBoomPageLength = 131
	// finalhandler's transforms applied to `a<b&c"d'e\nf  g`.
	pinnedEscapedMessagePageFragment = "<pre>a&lt;b&amp;c&quot;d&#39;e<br>f &nbsp;g</pre>"
)

func TestPinnedFinalHandlerDocumentMatchesPinnedBytes(t *testing.T) {
	probeString := pinnedFinalHandlerDocument("probe string")
	if got, want := string(probeString), pinnedProbeStringPageBody; got != want {
		t.Fatalf("finalhandler document drifted from the pinned bytes\n got: %q\nwant: %q", got, want)
	}
	if len(probeString) != pinnedProbeStringPageLength {
		t.Fatalf("finalhandler document length = %d, want the measured pinned %d", len(probeString), pinnedProbeStringPageLength)
	}

	production := pinnedFinalHandlerDocument("Internal Server Error")
	if got, want := string(production), pinnedProductionPageBody; got != want {
		t.Fatalf("production finalhandler document drifted\n got: %q\nwant: %q", got, want)
	}
	if len(production) != pinnedProductionPageLength {
		t.Fatalf("production document length = %d, want the measured pinned %d", len(production), pinnedProductionPageLength)
	}

	// finalhandler's transforms: escapeHtml then newline-><br> then "  "->" &nbsp;".
	// Non-ASCII passes through, as escape-html does.
	escaped := pinnedFinalHandlerDocument("a<b&c\"d'e\nf  g")
	if !strings.Contains(string(escaped), pinnedEscapedMessagePageFragment) {
		t.Fatalf("finalhandler message transforms drifted: %q does not contain %q", escaped, pinnedEscapedMessagePageFragment)
	}
}

// registerPanicProbeRoute is a test-only route domain: it registers a path whose
// handler panics, which is the only way to drive the recovery boundary through a
// real handler construction without adding a panic route to production code.
func registerPanicProbeRoute(mux *http.ServeMux, _ *accountRuntime, _ []byte, _ HTTPHandlerOptions) {
	mux.HandleFunc("/panic-probe", func(http.ResponseWriter, *http.Request) {
		panic("boom")
	})
}

func TestPanicBoundaryAnswersThePinnedPageAndKeepsServing(t *testing.T) {
	handler := newHTTPHandlerWithRouteDomains(nil, HTTPHandlerOptions{
		DataRoot:    t.TempDir(),
		DisableCSRF: true,
	}, []routeDomain{{name: "panic-probe", register: registerPanicProbeRoute}})
	server := httptest.NewServer(handler)
	defer server.Close()

	response, err := server.Client().Get(server.URL + "/panic-probe")
	if err != nil {
		t.Fatalf("a panicking route dropped the connection instead of answering: %v", err)
	}
	body, readErr := io.ReadAll(response.Body)
	response.Body.Close()
	if readErr != nil {
		t.Fatalf("read panic page body: %v", readErr)
	}
	if response.StatusCode != http.StatusInternalServerError {
		t.Fatalf("panic status = %d, want 500", response.StatusCode)
	}
	if got, want := string(body), pinnedBoomPageBody; got != want {
		t.Fatalf("panic body drifted from the pinned finalhandler document\n got: %q\nwant: %q", got, want)
	}
	if got, want := response.Header.Get("Content-Type"), "text/html; charset=utf-8"; got != want {
		t.Fatalf("panic Content-Type = %q, want %q", got, want)
	}
	if got, want := response.Header.Get("Content-Security-Policy"), "default-src 'none'"; got != want {
		t.Fatalf("panic Content-Security-Policy = %q, want %q", got, want)
	}
	if got := response.Header.Get("X-Content-Type-Options"); got != "nosniff" {
		t.Fatalf("panic X-Content-Type-Options = %q, want nosniff", got)
	}
	if got, want := response.Header.Get("Content-Length"), "131"; got != want {
		t.Fatalf("panic Content-Length = %q, want %q", got, want)
	}
	if response.Header.Get("X-Response-Time") == "" {
		t.Fatal("panic page has no X-Response-Time; pinned's response-time middleware hooks the headers event and stamps the error page too")
	}
	// pinned's helmet headers were set before the route ran, so they survive the
	// error page; GoTavern sets the same headers in its middleware.
	if got := response.Header.Get("X-Frame-Options"); got != "SAMEORIGIN" {
		t.Fatalf("panic page lost the pre-panic security header X-Frame-Options: %q", got)
	}

	// THE SERVER KEEPS SERVING: the panic answered one request, it did not take
	// the process or the listener down.
	versionResponse, err := server.Client().Get(server.URL + "/version")
	if err != nil {
		t.Fatalf("the server did not keep serving after a panic: %v", err)
	}
	defer versionResponse.Body.Close()
	if versionResponse.StatusCode != http.StatusOK {
		t.Fatalf("post-panic /version status = %d, want 200", versionResponse.StatusCode)
	}
}

// TestPanicBoundaryIsWhatTurnsADroppedConnectionIntoA500 is the teeth in the
// most direct form: the SAME panicking handler, with and without the boundary.
// Without it net/http logs the panic and closes the connection (the pre-fix
// behaviour); with it the client receives the 500 page. If the boundary is
// removed from newHTTPHandler the first test fails; this test explains why.
func TestPanicBoundaryIsWhatTurnsADroppedConnectionIntoA500(t *testing.T) {
	panicking := http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		panic("unbounded")
	})

	unguarded := httptest.NewUnstartedServer(panicking)
	unguarded.Config.ErrorLog = log.New(io.Discard, "", 0)
	unguarded.Start()
	defer unguarded.Close()
	response, err := unguarded.Client().Get(unguarded.URL)
	if err == nil {
		response.Body.Close()
		t.Fatalf("without the boundary the client still received a response (status %d); net/http should have closed the connection", response.StatusCode)
	}

	guarded := httptest.NewServer(pinnedPanicBoundary(panicking, io.Discard))
	defer guarded.Close()
	guardedResponse, err := guarded.Client().Get(guarded.URL)
	if err != nil {
		t.Fatalf("with the boundary the client did not receive the 500 page: %v", err)
	}
	defer guardedResponse.Body.Close()
	if guardedResponse.StatusCode != http.StatusInternalServerError {
		t.Fatalf("guarded status = %d, want 500", guardedResponse.StatusCode)
	}
}

// TestPanicBoundaryLogsOnlyPathAndPanicValue proves the log line is the
// path and the value and NOTHING that could carry a credential: the request
// below carries an Authorization header, a session cookie and a body, and the
// assertion fails if any of it reaches the log.
func TestPanicBoundaryLogsOnlyPathAndPanicValue(t *testing.T) {
	var logged strings.Builder
	guarded := pinnedPanicBoundary(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		panic(errors.New("boom"))
	}), &logged)

	request := httptest.NewRequest(http.MethodPost, "/panic-log-probe?ignored=query", strings.NewReader("request body with topsecret-value"))
	request.Header.Set("Authorization", "Bearer topsecret-value")
	request.Header.Set("Cookie", "session=topsecret-value")
	guarded.ServeHTTP(httptest.NewRecorder(), request)

	line := logged.String()
	if !strings.Contains(line, "POST") || !strings.Contains(line, "/panic-log-probe") {
		t.Fatalf("panic log line does not name the request path: %q", line)
	}
	if !strings.Contains(line, "boom") {
		t.Fatalf("panic log line does not name the panic value: %q", line)
	}
	for _, forbidden := range []string{"topsecret-value", "Authorization", "Cookie", "session=", "request body"} {
		if strings.Contains(line, forbidden) {
			t.Fatalf("panic log line leaked %q: %q", forbidden, line)
		}
	}
}

// TestPanicAfterHeadersSentDestroysWithoutASecondPage covers finalhandler's
// headersSent branch: once the head is out it must not append a second status
// line or a second document, and the boundary must hand the connection to
// net/http's recovery (the pinned equivalent is req.socket.destroy()).
func TestPanicAfterHeadersSentDestroysWithoutASecondPage(t *testing.T) {
	guarded := pinnedPanicBoundary(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("partial-stream"))
		panic("thrown after the head")
	}), io.Discard)

	recorder := httptest.NewRecorder()
	var rethrown any
	func() {
		defer func() { rethrown = recover() }()
		guarded.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/stream-probe", nil))
	}()
	if rethrown == nil {
		t.Fatal("a panic after the head did not re-panic; the connection would be left half-written instead of closed")
	}
	if recorder.Code != http.StatusOK {
		t.Fatalf("recorder status = %d, want the already-written 200", recorder.Code)
	}
	if got := recorder.Body.String(); got != "partial-stream" {
		t.Fatalf("body after a post-head panic = %q, want only the bytes written before the panic", got)
	}
	if strings.Contains(recorder.Body.String(), "<!DOCTYPE html>") {
		t.Fatal("the boundary appended a second finalhandler page after the head was sent")
	}
}
