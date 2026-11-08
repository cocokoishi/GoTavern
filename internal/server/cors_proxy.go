package server

// THE CORS PROXY (/proxy/:url(*) ENABLED BRANCH).
//
// PINNED SOURCE (read, not remembered):
//
//	src/server-main.js:110-111   bodyParser.json({limit:'500mb'}) runs BEFORE the proxy mount, for every
//	                             method, so req.body exists for the proxy and an invalid JSON body is
//	                             refused by body-parser with 400 before the proxy handler runs.
//	src/server-main.js:186-188   CSRF is skipped for /proxy/ ONLY when enableCorsProxy is true.
//	src/server-main.js:257-265   the mount, and the disabled branch this file also owns.
//	src/middleware/corsProxy.js  the whole handler: circular check, header removal list, forced
//	                             accept-encoding, JSON.stringify(req.body) for POST/PUT/PATCH only.
//	src/util.js:732-779          forwardFetchResponse: 401 -> 400, NO response headers copied, ok
//	                             responses streamed, error bodies read as text and ended.
//
// OBSERVED AGAINST THE PINNED PACKAGES (node 24.19.0, express 4.22.1, body-parser 1.20.4,
// node-fetch 3.3.2, local upstream only; the probe is recorded in the alpha.18 lane report):
//
//   - a successful proxied response carries NO upstream response header at all (no Content-Type, no
//     Content-Encoding, no Content-Length, no Set-Cookie, no X-*), and is answered with chunked framing;
//   - an upstream 401 becomes 400 with the upstream body; an upstream 404 keeps its status and body,
//     still with no Content-Type, and the body is answered with a Content-Length;
//   - `?query` written OUTSIDE the encoded target is dropped: `:url(*)` captures the path only, so only
//     a query encoded INSIDE the target survives (the frontend's encodeURIComponent carries it there);
//   - POST/PUT/PATCH bodies are JSON.stringify(req.body), not the raw bytes: key order (integer-like keys
//     first), duplicate-key collapse, 1.0 -> 1, 1e2 -> 100, `<&>` unescaped, non-ASCII unescaped;
//   - a POST with no body and no content-type still sends "{}" -- body-parser leaves req.body as {} and
//     node-fetch labels the string body text/plain;charset=UTF-8;
//   - node-fetch decompresses gzip, deflate and br; the forced accept-encoding is `gzip, deflate, br`;
//   - redirects follow node-fetch's rules (max 20; 303 and 301/302-on-POST rewrite to GET; 301/302 on
//     PUT/PATCH keep the method AND resend the body; sensitive headers are dropped across a protocol or
//     domain change; node-fetch never emits Referer on a redirect);
//   - a non-http(s) target and a DNS/TCP/TLS failure both answer 500 with body "Internal Server Error"
//     (text/plain; charset=utf-8, weak ETag);
//   - a circular target answers 400 with body "Circular requests are not allowed" (text/html);
//   - /proxy (no trailing slash) is NOT matched by /proxy/:url(*) and falls through to the pinned 404 page.

import (
	"bytes"
	"compress/gzip"
	"compress/zlib"
	"context"
	"io"
	"mime"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/cocokoishi/gotavern/internal/httpx"
)

// pinnedCorsProxyDisabledMessage is the exact body pinned sends when the CORS proxy is disabled:
//
//	// server-main.js:260-264
//	app.use('/proxy/:url(*)', async (_, res) => {
//	    const message = 'CORS proxy is disabled. Enable it in config.yaml or use the --corsProxy flag.';
//	    console.log(message);
//	    res.status(404).send(message);
//	});
//
// Express's res.send(string) sends text/html with that exact byte sequence, so the 404 status AND the
// body are both observable to an extension that probes the route.
const pinnedCorsProxyDisabledMessage = "CORS proxy is disabled. Enable it in config.yaml or use the --corsProxy flag."

// pinnedCorsProxyCircularMessage is corsProxy.js:15 verbatim.
const pinnedCorsProxyCircularMessage = "Circular requests are not allowed"

// pinnedCorsProxyAcceptEncoding is forced over whatever the client sent (corsProxy.js:33). The value is
// the pinned wire value; gzip and deflate are decoded by cors_proxy_transport.go, and br is a recorded
// divergence (Go's standard library has no brotli decoder and this project may not add a dependency).
const pinnedCorsProxyAcceptEncoding = "gzip, deflate, br"

// pinnedCorsProxyRemovedRequestHeaders is corsProxy.js:20-25, exactly, in the pinned order.
var pinnedCorsProxyRemovedRequestHeaders = []string{
	"x-csrf-token", "host", "referer", "origin", "cookie",
	"x-forwarded-for", "x-forwarded-protocol", "x-forwarded-proto",
	"x-forwarded-host", "x-real-ip", "sec-fetch-mode",
	"sec-fetch-site", "sec-fetch-dest",
}

// pinnedCorsProxyBodyLimit is body-parser's `limit: '500mb'` (server-main.js:110), the same constant the
// rest of this package uses for the pinned body-parser limit.
const pinnedCorsProxyBodyLimit = pinnedBodyParserLimit

// registerCorsProxyRoutes mirrors the pinned /proxy/:url(*) mount (server-main.js:257-265).
//
// pinned registers the mount in BOTH branches, and express's `/proxy/:url(*)` does not match `/proxy`
// itself: a probe of the pinned middleware stack answered /proxy with the pinned 404 page. Go's ServeMux
// would answer a 301 redirect to /proxy/ for the bare path when only "/proxy/" is registered, so the bare
// path is registered explicitly and answered by the same static/404 chain every other unmatched path uses.
func registerCorsProxyRoutes(mux *http.ServeMux, accounts *accountRuntime, notFoundPage []byte, options HTTPHandlerOptions) {
	mux.HandleFunc("/proxy", func(w http.ResponseWriter, request *http.Request) {
		serveStatic(w, request, notFoundPage, options)
	})
	mux.HandleFunc("/proxy/", func(w http.ResponseWriter, request *http.Request) {
		serveCorsProxyRequest(w, request, options)
	})
}

func serveCorsProxyRequest(w http.ResponseWriter, request *http.Request, options HTTPHandlerOptions) {
	if !options.EnableCorsProxy {
		respondText(w, http.StatusNotFound, "text/html; charset=utf-8", pinnedCorsProxyDisabledMessage)
		return
	}

	// `:url(*)` captures the PATH after the mount, decoded once by express's decodeParam, and the decoded
	// string is what fetch() receives. request.URL.Path is that same single decode, and it deliberately
	// excludes the raw query string: express params never include it (probed: `?a=1` outside the encoded
	// target is dropped, `%3Fa%3D1` inside it survives).
	target := strings.TrimPrefix(request.URL.Path, "/proxy/")

	// body-parser runs before the route (server-main.js:110), so its refusals take precedence over the
	// circular check and over URL errors.
	parsedBody, bodyStatus := corsProxyParseRequestBody(request)
	if bodyStatus != 0 {
		writeCorsProxyFinalHandlerPage(w, bodyStatus)
		return
	}

	// corsProxy.js:12-16. The comparison is a plain case-sensitive prefix test on the DECODED target, so
	// "http://host.evil.example/" also starts with "http://host" -- an inherited property, reproduced.
	if strings.HasPrefix(target, corsProxyRequestOrigin(request)) {
		respondText(w, http.StatusBadRequest, "text/html; charset=utf-8", pinnedCorsProxyCircularMessage)
		return
	}

	targetURL, urlStatus := corsProxyTargetURL(target)
	if urlStatus != 0 {
		corsProxyLogFailure("target URL is not an absolute http(s) URL")
		if urlStatus == http.StatusBadRequest {
			writeCorsProxyFinalHandlerPage(w, urlStatus)
			return
		}
		httpx.WriteStatusText(w, urlStatus)
		return
	}

	body, err := corsProxyOutboundBody(request.Method, parsedBody)
	if err != nil {
		corsProxyLogFailure("request body could not be re-encoded")
		httpx.WriteStatusText(w, http.StatusInternalServerError)
		return
	}

	response, err := corsProxyDoWithBrotliFallback(request.Context(), corsProxyMethod(request.Method), targetURL,
		corsProxyOutboundHeaders(request, body), body)
	if err != nil {
		corsProxyLogFailure(corsProxyFailureReason(err))
		httpx.WriteStatusText(w, http.StatusInternalServerError)
		return
	}
	defer response.Body.Close()

	corsProxyForwardResponse(w, request, response)
}

// corsProxyBrotliRefusal is the named reason a br-encoded reply is not served: this build has no brotli
// decoder and may not add a dependency. A GET/HEAD is retried once without br (corsProxyDoWithBrotliFallback);
// a request with side effects is NOT re-sent, because a second POST could duplicate the mutation.
type corsProxyBrotliRefusal struct {
	Method string
}

func (refusal *corsProxyBrotliRefusal) Error() string {
	return "CORS proxy refused a brotli-encoded upstream response that this build cannot decode (method " + refusal.Method + ")"
}

// corsProxyDoWithBrotliFallback performs the outbound request and handles the one encoding pinned decodes
// that this build cannot: brotli. The pinned wire value `gzip, deflate, br` is advertised on the FIRST
// request (that is the pinned request header), and a br reply to a GET or HEAD is retried ONCE with
// `Accept-Encoding: gzip, deflate` -- the protocol does not forbid re-sending a safe method, and refusing
// instead would break exactly the Cloudflare-fronted origins (which choose br when it is offered) that the
// proxy exists for. A POST/PUT/PATCH/DELETE reply is never retried; it answers the same 500 as any other
// upstream failure. If the retry itself is br-encoded the request gives up rather than loop.
func corsProxyDoWithBrotliFallback(ctx context.Context, method string, target *url.URL, headers http.Header, body []byte) (*http.Response, error) {
	response, err := corsProxyDo(ctx, method, target, headers, body)
	if err != nil {
		return nil, err
	}
	if !corsProxyResponseIsBrotli(response) {
		return response, nil
	}
	_ = response.Body.Close()
	switch method {
	case http.MethodGet, http.MethodHead:
	default:
		return nil, &corsProxyBrotliRefusal{Method: method}
	}
	retryHeaders := headers.Clone()
	retryHeaders.Set("Accept-Encoding", "gzip, deflate")
	retried, err := corsProxyDo(ctx, method, target, retryHeaders, body)
	if err != nil {
		return nil, err
	}
	if corsProxyResponseIsBrotli(retried) {
		_ = retried.Body.Close()
		return nil, &corsProxyBrotliRefusal{Method: method}
	}
	return retried, nil
}

// corsProxyResponseIsBrotli reports a br Content-Encoding, including the layered form ("gzip, br") that
// node-fetch would decode both layers of.
func corsProxyResponseIsBrotli(response *http.Response) bool {
	for _, value := range response.Header.Values("Content-Encoding") {
		for _, coding := range strings.Split(value, ",") {
			if strings.EqualFold(strings.TrimSpace(coding), "br") {
				return true
			}
		}
	}
	return false
}

// corsProxyDo builds and performs one outbound request. The body is a []byte so a retry can rebuild the
// reader; the headers are cloned because a retry must not inherit a mutation and net/http may mutate them.
func corsProxyDo(ctx context.Context, method string, target *url.URL, headers http.Header, body []byte) (*http.Response, error) {
	var reader io.Reader
	if body != nil {
		reader = bytes.NewReader(body)
	}
	outboundRequest, err := http.NewRequestWithContext(ctx, method, target.String(), reader)
	if err != nil {
		return nil, err
	}
	outboundRequest.Header = headers.Clone()
	return corsProxyHTTPClient().Do(outboundRequest)
}

// corsProxyRequestOrigin is a port of `req.protocol + '://' + req.get('host')` (corsProxy.js:13). pinned
// never sets express's `trust proxy` (grepped: no app.set('trust proxy', ...) in src/), so req.protocol is
// "https" only when the connection itself is TLS, and req.get('host') is the Host header. For an HTTP/1.0
// request with no Host header express concatenates the string "undefined"; that spelling is reproduced
// rather than an empty host, which would make every absolute http URL look circular.
func corsProxyRequestOrigin(request *http.Request) string {
	protocol := "http"
	if request.TLS != nil {
		protocol = "https"
	}
	host := request.Host
	if host == "" {
		host = "undefined"
	}
	return protocol + "://" + host
}

// corsProxyTargetURL applies the two URL rules node-fetch enforces before a socket is opened: the input
// must parse as an absolute URL and its scheme must be http or https (node-fetch rejects anything else
// with a TypeError, which corsProxy.js catches into sendStatus(500)).
func corsProxyTargetURL(target string) (*url.URL, int) {
	// express's decodeParam throws a 400 URIError on a percent sequence that does not decode to valid
	// UTF-8; Go's URL path decoder produces bytes instead, so the same refusal is applied here.
	if !utf8.ValidString(target) {
		return nil, http.StatusBadRequest
	}
	parsed, err := url.Parse(target)
	if err != nil {
		return nil, http.StatusInternalServerError
	}
	parsed.Scheme = strings.ToLower(parsed.Scheme)
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return nil, http.StatusInternalServerError
	}
	if parsed.Host == "" {
		return nil, http.StatusInternalServerError
	}
	return parsed, 0
}

// corsProxyMethod reproduces Node's HTTP parser, which uppercases the standard method tokens: a request
// sent as `post` reached the pinned middleware as POST (probed), body and all. Non-standard methods keep
// their spelling, which is also what Node does.
func corsProxyMethod(method string) string {
	upper := strings.ToUpper(method)
	switch upper {
	case http.MethodGet, http.MethodHead, http.MethodPost, http.MethodPut, http.MethodDelete,
		http.MethodPatch, http.MethodOptions, http.MethodTrace, http.MethodConnect:
		return upper
	}
	return method
}

// corsProxyOutboundBody is `body: bodyMethods.includes(req.method) ? JSON.stringify(req.body) : undefined`
// (corsProxy.js:35-40). body-parser leaves req.body as {} when it did not parse anything (no body, a
// non-JSON content type, or an empty JSON body), and JSON.stringify({}) is "{}" -- so POST/PUT/PATCH
// always carry a body, and every other method carries none.
func corsProxyOutboundBody(method string, parsed orderedNodeJSON) ([]byte, error) {
	switch corsProxyMethod(method) {
	case http.MethodPost, http.MethodPut, http.MethodPatch:
		return corsProxyBodyBytes(parsed)
	}
	return nil, nil
}

// corsProxyBodyBytes is the JS-equivalent JSON.stringify of the parsed body. decodeOrderedNodeJSON keeps
// object insertion order (with duplicate keys collapsed to the first position and the last value), and
// marshalOrderedNodeJSON emits integer-like keys first, ECMAScript numbers and JS string escaping -- the
// same transforms JSON.stringify applies, measured against the pinned probe's exact bytes.
func corsProxyBodyBytes(parsed orderedNodeJSON) ([]byte, error) {
	return marshalOrderedNodeJSON(parsed)
}

// corsProxyParseRequestBody is body-parser's json() for this route:
//
//   - it only parses when the media type is application/json (type-is, case-insensitive, params allowed);
//   - with no body (no content-length and no transfer-encoding) req.body stays {};
//   - a gzip or deflate request body is inflated first (body-parser's `inflate` default); any other
//     content-encoding is refused with 415, which is exactly raw-body/body-parser's
//     `unsupported content encoding` status;
//   - an EMPTY body after inflation is the special case body-parser's parse() has for `body.length === 0`:
//     it returns {}, so `JSON.stringify(req.body)` sends "{}" rather than a syntax error. A whitespace-only
//     body is not empty and fails strict mode;
//   - strict mode (body-parser's default) accepts only a top-level object or array;
//   - the limit is the pinned 500mb, and the failure statuses are body-parser's (400 parse, 413 too
//     large, 415 charset or content-encoding).
//
// NOT PORTED, named rather than hidden: utf-16 request bodies (body-parser iconv-decodes utf-*; this
// implementation decodes only utf-8, and answers 415 for another charset), and the urlencoded parser,
// which would make a POST form body reach the upstream as a JSON object instead of "{}". The gzip
// re-serialization has a pinned quirk that IS reproduced: body-parser inflates the request, the proxy
// re-serializes the parsed object, and the original `content-encoding` header is still forwarded, so the
// upstream receives plain JSON labelled gzip. It is pinned's observable, not an accident here.
func corsProxyParseRequestBody(request *http.Request) (orderedNodeJSON, int) {
	mediaType, parameters, err := mime.ParseMediaType(request.Header.Get("Content-Type"))
	if err != nil || !strings.EqualFold(mediaType, "application/json") {
		return nodeObject(), 0
	}
	if charset := parameters["charset"]; charset != "" && !strings.EqualFold(charset, "utf-8") {
		return orderedNodeJSON{}, http.StatusUnsupportedMediaType
	}
	// body-parser's hasBody: a transfer-encoding or a non-zero content-length. ContentLength is -1 for a
	// body whose length is not declared (chunked HTTP/1.1 and HTTP/2 without content-length), which is a
	// body and must be parsed, not the "no body" case.
	hasBody := request.ContentLength != 0 || len(request.TransferEncoding) > 0
	if !hasBody {
		return nodeObject(), 0
	}
	stream, streamStatus := corsProxyRequestBodyStream(request)
	if streamStatus != 0 {
		return orderedNodeJSON{}, streamStatus
	}
	raw, err := io.ReadAll(io.LimitReader(stream, pinnedCorsProxyBodyLimit+1))
	if err != nil {
		return orderedNodeJSON{}, http.StatusBadRequest
	}
	if int64(len(raw)) > pinnedCorsProxyBodyLimit {
		return orderedNodeJSON{}, http.StatusRequestEntityTooLarge
	}
	if len(raw) == 0 {
		// body-parser's json parse() special case: a zero-length body is {}, not a syntax error.
		return nodeObject(), 0
	}
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		// Whitespace is not empty: strict mode's firstchar is undefined and JSON.parse would throw.
		return orderedNodeJSON{}, http.StatusBadRequest
	}
	if first := trimmed[0]; first != '{' && first != '[' {
		return orderedNodeJSON{}, http.StatusBadRequest
	}
	parsed, err := decodeOrderedNodeJSON(trimmed)
	if err != nil {
		return orderedNodeJSON{}, http.StatusBadRequest
	}
	if parsed.kind != 'o' && parsed.kind != 'a' {
		return orderedNodeJSON{}, http.StatusBadRequest
	}
	return parsed, 0
}

// corsProxyRequestBodyStream applies body-parser's `contentstream` inflation. `identity` (and no header)
// is the request stream; gzip and deflate are inflated; everything else -- including br, which body-parser
// 1.20.4's zlib-only switch also refuses -- is body-parser's 415.
func corsProxyRequestBodyStream(request *http.Request) (io.Reader, int) {
	switch strings.ToLower(strings.TrimSpace(request.Header.Get("Content-Encoding"))) {
	case "", "identity":
		return request.Body, 0
	case "gzip":
		reader, err := gzip.NewReader(request.Body)
		if err != nil {
			return nil, http.StatusBadRequest
		}
		return reader, 0
	case "deflate":
		reader, err := zlib.NewReader(request.Body)
		if err != nil {
			return nil, http.StatusBadRequest
		}
		return reader, 0
	default:
		return nil, http.StatusUnsupportedMediaType
	}
}

// corsProxyOutboundHeaders forwards every request header except the pinned removal list, then applies
// node-fetch's observable defaults for the three headers it would have added itself.
//
// Go does not expose Host, Content-Length or Transfer-Encoding as Header entries (it parses them into
// Request fields), so the only headers this loop cannot carry are the ones the transport owns. That is a
// named transport-owned difference, not a silent drop: pinned forwards a browser's `Transfer-Encoding:
// chunked` and its stale Content-Length, which is how a DELETE carrying a body made the upstream wait
// forever in the probe; Go recomputes both from what it actually sends.
func corsProxyOutboundHeaders(request *http.Request, body []byte) http.Header {
	headers := make(http.Header, len(request.Header))
	for name, values := range request.Header {
		lower := strings.ToLower(name)
		if corsProxyHeaderIsRemoved(lower) {
			continue
		}
		for _, value := range values {
			headers.Add(name, value)
		}
	}
	headers.Set("Accept-Encoding", pinnedCorsProxyAcceptEncoding)
	// node-fetch's own defaults (src/index.js:120-126): Accept: */* and User-Agent: node-fetch are added
	// only when the caller did not supply them.
	if headers.Get("Accept") == "" {
		headers.Set("Accept", "*/*")
	}
	if headers.Get("User-Agent") == "" {
		headers.Set("User-Agent", "node-fetch")
	}
	// node-fetch labels a string body it created as text/plain;charset=UTF-8 when the request carried no
	// content type (probed: POST with no body and no content-type).
	if len(body) > 0 && headers.Get("Content-Type") == "" {
		headers.Set("Content-Type", "text/plain;charset=UTF-8")
	}
	return headers
}

func corsProxyHeaderIsRemoved(lowercaseName string) bool {
	for _, removed := range pinnedCorsProxyRemovedRequestHeaders {
		if lowercaseName == removed {
			return true
		}
	}
	return false
}

// corsProxyForwardResponse ports util.js forwardFetchResponse (:732-779):
//
//   - status 401 becomes 400 (and the reason phrase, which net/http cannot set, stays Go's "Bad Request"
//     where Node would say "Unauthorized" -- a named divergence);
//   - NO response header is copied at all, including content-encoding and content-length;
//   - a non-2xx body is read to completion and written as the body;
//   - a 2xx body is streamed.
//
// The Content-Type header key is set to a nil slice before the head is written: net/http sniffs a
// Content-Type when the key is absent, and pinned sends none. A nil-slice key is "present" to net/http's
// writer (`_, haveType := header["Content-Type"]`) but writes no header line.
func corsProxyForwardResponse(w http.ResponseWriter, request *http.Request, response *http.Response) {
	status := response.StatusCode
	if status == http.StatusUnauthorized {
		status = http.StatusBadRequest
	}
	method := corsProxyMethod(request.Method)

	body, err := corsProxyResponseBody(response, method)
	if err != nil {
		corsProxyLogFailure(err.Error())
		httpx.WriteStatusText(w, http.StatusInternalServerError)
		return
	}
	defer body.Close()

	w.Header()["Content-Type"] = nil

	if response.StatusCode < 200 || response.StatusCode >= 300 {
		payload, readErr := io.ReadAll(body)
		if readErr != nil {
			corsProxyLogFailure("upstream error body could not be read")
			httpx.WriteStatusText(w, http.StatusInternalServerError)
			return
		}
		if status != http.StatusNoContent && status != http.StatusNotModified {
			w.Header().Set("Content-Length", strconv.Itoa(len(payload)))
		}
		w.WriteHeader(status)
		if len(payload) > 0 {
			_, _ = w.Write(payload)
		}
		return
	}

	w.WriteHeader(status)
	if method == http.MethodHead || status == http.StatusNoContent || status == http.StatusNotModified {
		return
	}
	// Flush the head so net/http cannot invent a Content-Length for a small body: pinned streams every
	// successful response and answers it with chunked framing.
	if flusher, ok := w.(http.Flusher); ok {
		flusher.Flush()
	}
	buffer := make([]byte, 32*1024)
	for {
		count, readErr := body.Read(buffer)
		if count > 0 {
			if _, writeErr := w.Write(buffer[:count]); writeErr != nil {
				return
			}
			if flusher, ok := w.(http.Flusher); ok {
				flusher.Flush()
			}
		}
		if readErr != nil {
			if readErr != io.EOF {
				corsProxyLogFailure("upstream response ended mid-body")
			}
			return
		}
	}
}

// writeCorsProxyFinalHandlerPage answers a body-parser refusal the way express's finalhandler does:
// the status, Content-Security-Policy, X-Content-Type-Options, Content-Type text/html; charset=utf-8 and
// a Content-Length. The BODY is finalhandler's production rendering (the status text); pinned runs with
// NODE_ENV unset, so its <pre> holds a V8 stack with host-absolute paths, which cannot be reproduced and
// is not a stable observable. This is the same recorded split the panic boundary uses.
func writeCorsProxyFinalHandlerPage(w http.ResponseWriter, status int) {
	body := pinnedFinalHandlerDocument(http.StatusText(status))
	w.Header().Set("Content-Security-Policy", "default-src 'none'")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Content-Length", strconv.Itoa(len(body)))
	w.WriteHeader(status)
	_, _ = w.Write(body)
}
