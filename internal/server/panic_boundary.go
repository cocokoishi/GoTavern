package server

// THE PANIC BOUNDARY: the pinned server answers a thrown route error with
// Express's finalhandler 500 page; before this file GoTavern had no recover()
// boundary at all, so a handler panic left net/http to log it and close the
// connection. The client saw a dropped connection instead of a 500, which is a
// compatibility difference (and a worse failure mode for the browser: fetch
// rejects rather than receiving an HTML error page).
//
// PINNED SOURCE, read not remembered: pinned SillyTavern 1.19.0 runs Express
// 4.22.1 (node_modules/express/package.json) whose default route-error handler is
// finalhandler 1.3.1 (node_modules/finalhandler/index.js). A synchronous throw
// in a route reaches finalhandler, which:
//   - keeps status 500 (`res.statusCode = 500`);
//   - removes Content-Encoding/Content-Language/Content-Range;
//   - sets Content-Security-Policy: default-src 'none', X-Content-Type-Options:
//     nosniff, Content-Type: text/html; charset=utf-8, and Content-Length;
//   - writes createHtmlDocument(getErrorMessage(err, status, env)).
//
// getErrorMessage uses `err.stack` when NODE_ENV is not 'production', otherwise
// `statuses.message[status]` ("Internal Server Error"). pinned SillyTavern does
// not set NODE_ENV (server.js:5 prints `process.env.NODE_ENV` as undefined and
// nothing in src/ sets it), so the pinned default page is the DEVELOPMENT page:
// the <pre> block is the V8 stack, which embeds the temp path, pinned line
// numbers and Node internals. That text is environment-specific and cannot be
// reproduced from Go. MEASURED with a probe against pinned's own express and
// finalhandler (NODE_ENV unset): status "500 Internal Server Error", CSP
// `default-src 'none'`, X-Content-Type-Options nosniff, Content-Type
// text/html; charset=utf-8, and a body whose <pre> starts `Error: probe boom<br>
// &nbsp; &nbsp;at ...` (a thrown non-Error string yields `<pre>probe string
// </pre>`). MEASURED with NODE_ENV=production: Content-Length 148 and <pre>
// Internal Server Error</pre>.
//
// WHAT THIS BOUNDARY REPRODUCES: the status, the finalhandler document shape
// (exact bytes around the message), the finalhandler headers, and the
// escapeHtml + newline-><br> + double-space->" &nbsp;" message transforms.
// WHAT IT DOES NOT REPRODUCE, recorded as the environment-specific difference:
// the development page's stack frames, because they are V8/host-specific; the
// message is the Go panic value instead. `panic(err)` therefore yields
// `<pre>err text</pre>` where pinned yields `<pre>Error: err text<br> ...at
// ...</pre>`. This is the same difference the extension static handler records
// (extensions.go: "...the <pre> block is the V8 stack with host-absolute paths
// and pinned line numbers; GoTavern answers the same status with httpx.WriteStatusText").
//
// HEADERS FROM MIDDLEWARE THAT ALREADY RAN ARE KEPT, as Express keeps them:
// pinned's helmet security headers are set before the route and survive the
// error page, and GoTavern's setPinnedSecurityHeaders/response-time headers are
// stamped before this boundary decides to answer, so they survive too. The
// finalhandler's own four headers override/add on top.
//
// AFTER THE HEAD IS SENT: finalhandler cannot answer (headersSent(res) is true);
// it destroys the socket instead. This boundary does the same by re-panicking
// once the head is out, which is the one path where net/http's own recovery is
// still wanted: it closes the connection, which is the pinned observable for a
// throw inside a streaming response.

import (
	"fmt"
	"io"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// finalHandlerDoubleSpace matches finalhandler's DOUBLE_SPACE_REGEXP /\x20{2}/g.
var finalHandlerDoubleSpace = regexp.MustCompile(`\x20{2}`)

// pinnedFinalHandlerDocument renders finalhandler 1.3.1's createHtmlDocument.
// The skeleton is byte-identical to `pinnedSendErrorDocument` (the send() page);
// only the <pre> content transform differs, and it is finalhandler's own:
// escapeHtml, then newline -> <br>, then each pair of spaces -> " &nbsp;".
func pinnedFinalHandlerDocument(message string) []byte {
	transformed := finalHandlerEscapeHTML(message)
	transformed = strings.ReplaceAll(transformed, "\n", "<br>")
	transformed = finalHandlerDoubleSpace.ReplaceAllString(transformed, " &nbsp;")
	return []byte("<!DOCTYPE html>\n" +
		"<html lang=\"en\">\n" +
		"<head>\n" +
		"<meta charset=\"utf-8\">\n" +
		"<title>Error</title>\n" +
		"</head>\n" +
		"<body>\n" +
		"<pre>" + transformed + "</pre>\n" +
		"</body>\n" +
		"</html>\n")
}

// finalHandlerEscapeHTML is escape-html's table exactly: & < > " and ' only,
// with `"` as &quot; (Go's html.EscapeString uses &#34; for a double quote, so
// it cannot be used for a byte-exact page). Non-ASCII passes through unchanged,
// as in the pinned package.
func finalHandlerEscapeHTML(value string) string {
	var builder strings.Builder
	builder.Grow(len(value))
	for _, char := range value {
		switch char {
		case '&':
			builder.WriteString("&amp;")
		case '<':
			builder.WriteString("&lt;")
		case '>':
			builder.WriteString("&gt;")
		case '"':
			builder.WriteString("&quot;")
		case '\'':
			builder.WriteString("&#39;")
		default:
			builder.WriteRune(char)
		}
	}
	return builder.String()
}

// panicBoundaryWriter records whether the response head has been written, which
// is the condition finalhandler checks before deciding between the page and
// destroying the socket.
type panicBoundaryWriter struct {
	http.ResponseWriter
	wroteHeader bool
}

func (writer *panicBoundaryWriter) WriteHeader(status int) {
	writer.wroteHeader = true
	writer.ResponseWriter.WriteHeader(status)
}

func (writer *panicBoundaryWriter) Write(body []byte) (int, error) {
	// An explicit WriteHeader already recorded the head; a bare Write makes
	// net/http write the implicit 200, which is equally a sent head.
	writer.wroteHeader = true
	return writer.ResponseWriter.Write(body)
}

// Flush keeps a streaming handler's http.Flusher assertion working.
func (writer *panicBoundaryWriter) Flush() {
	if flusher, ok := writer.ResponseWriter.(http.Flusher); ok {
		flusher.Flush()
	}
}

// Unwrap lets http.ResponseController reach the underlying writer.
func (writer *panicBoundaryWriter) Unwrap() http.ResponseWriter {
	return writer.ResponseWriter
}

// pinnedPanicBoundary installs the finalhandler-equivalent recovery at the
// outermost position: it must see a panic from every middleware and route. The
// log line is deliberately only the method, the request path and the panic
// value -- never request headers, cookies or body, which can carry credentials.
func pinnedPanicBoundary(next http.Handler, failures io.Writer) http.Handler {
	if failures == nil {
		failures = os.Stderr
	}
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		started := time.Now()
		tracked := &panicBoundaryWriter{ResponseWriter: writer}
		defer func() {
			recovered := recover()
			if recovered == nil {
				return
			}
			fmt.Fprintf(failures, "GoTavern: panic serving %s %s: %v\n", request.Method, request.URL.Path, recovered)
			if tracked.wroteHeader {
				// finalhandler: "cannot %d after headers sent" then
				// req.socket.destroy(). Re-panicking hands the connection to
				// net/http's recovery, which closes it without writing a second
				// status line into the stream.
				panic(recovered)
			}
			writePinnedFinalHandlerPage(tracked, request, recovered, started)
		}()
		next.ServeHTTP(tracked, request)
	})
}

// writePinnedFinalHandlerPage writes finalhandler's 500 page. The response-time
// middleware sits inside this boundary, so its header normally runs after the
// wrapped handler returns; a panic unwinds past it, and pinned's response-time
// middleware still stamps the error page because it hooks the headers event.
// This boundary therefore stamps the same header (presence is the contract; the
// value is a wall-clock measurement and never pinned) before writing the head.
func writePinnedFinalHandlerPage(writer *panicBoundaryWriter, request *http.Request, recovered any, started time.Time) {
	message := fmt.Sprint(recovered)
	if message == "" {
		message = http.StatusText(http.StatusInternalServerError)
	}
	body := pinnedFinalHandlerDocument(message)
	header := writer.Header()
	for _, contentHeader := range []string{"Content-Encoding", "Content-Language", "Content-Range"} {
		header.Del(contentHeader)
	}
	header.Set("Content-Security-Policy", "default-src 'none'")
	header.Set("X-Content-Type-Options", "nosniff")
	header.Set("Content-Type", "text/html; charset=utf-8")
	header.Set("Content-Length", strconv.Itoa(len(body)))
	if header.Get("X-Response-Time") == "" {
		header.Set("X-Response-Time", pinnedResponseTimeValue(time.Since(started)))
	}
	writer.WriteHeader(http.StatusInternalServerError)
	if request.Method == http.MethodHead {
		return
	}
	_, _ = writer.Write(body)
}
