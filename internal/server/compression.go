package server

// PINNED RESPONSE COMPRESSION (`app.use(compression())`, src/server-main.js:107).
//
// WHY THIS FILE EXISTS. Pinned mounts the `compression` middleware with no options and its recorded oracle
// fixtures carry `content-encoding: gzip`; GoTavern reproduced only the Vary side of that middleware and
// served every byte identity-encoded. Every comparator normalized Content-Encoding away, so the gap was
// invisible to the gates and cost real wire bytes: a page load is ~229 assets and `script.js` alone is
// 497,669 B. tools/probe-compression.mjs records the pinned observable and
// tests/oracle/sillytavern-1.19.0-compression.json is the contract this middleware matches.
//
// THE PINNED MIDDLEWARE, read from node_modules/compression@1.8.1/index.js and recorded by the probe:
//   - filter: `compressible(Content-Type)` (mime-db compressible flag) and `Cache-Control` without
//     `no-transform`; a response with no Content-Type is NOT filtered in (that is why SSE is never touched:
//     src/util.js forwardFetchResponse pipes the provider stream and sets no content type).
//   - Vary: Accept-Encoding is appended BEFORE the threshold/HEAD/negotiation checks, so a compressible
//     response carries it even when the body is not compressed (identity client, HEAD, below threshold,
//     Range). A non-compressible response does not get it.
//   - threshold: 1024 bytes, measured from Content-Length when present; a streamed body without a declared
//     length is compressed (the pinned condition `length < threshold` is false when length is undefined).
//   - HEAD: never compressed (but Vary is still added for a compressible type).
//   - negotiation: `negotiator.encoding(['br','gzip','deflate','identity'], ['br','gzip'])` on Node 24, so
//     brotli wins when offered. GoTavern supports gzip and deflate from the standard library and therefore
//     answers gzip where pinned answers br. THIS IS THE ONE RECORDED DEVIATION: a client that offers br+gzip
//     receives gzip (decodable, smaller than identity); a client that offers ONLY br receives identity
//     because GoTavern cannot produce br. The probe records both halves and the replay asserts them.
//   - when compressing: `Content-Encoding: <method>` is set and `Content-Length` is REMOVED; Node then uses
//     chunked transfer framing. ETag/Last-Modified are NOT touched (pinned does not make them
//     representation-specific), and 304 revalidation is untouched because a 304 has no Content-Type.
//   - compression is STREAMED (zlib stream piped to the response); no unbounded buffer exists here either:
//     compress/gzip holds a bounded deflate window.
//
// WHERE IT SITS. Pinned order is compression (107) before responseTime (108), CORS (138), sessions and the
// routes; this middleware is therefore the OUTERMOST wrapper in NewHTTPHandlerWithOptions (http.go), so it
// sees the final headers of every response, including the CORS/security middleware's Vary and the handlers'
// Content-Length/ETag.
//
// WHAT IT DOES NOT CHANGE. SSE framing and cancellation: the streaming responses set no Content-Type, so the
// filter never matches them; the probe records `sse.generateStream` with no content-encoding and the decoded
// frames intact, and the replay asserts the same bytes. Provider-wire bytes are untouched (this is a
// server->browser concern only).

import (
	"compress/gzip"
	"compress/zlib"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"
)

const pinnedCompressionThresholdBytes = 1024

// pinnedCompressionMiddleware wraps next with the pinned compression contract.
func pinnedCompressionMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		compressed := &pinnedCompressionWriter{inner: writer, request: request}
		defer compressed.close()
		next.ServeHTTP(compressed, request)
	})
}

type pinnedCompressionWriter struct {
	inner    http.ResponseWriter
	request  *http.Request
	decided  bool
	compress bool
	wrote    bool
	stream   io.WriteCloser
	// pooledGzip is the pooled gzip writer behind stream when gzip is in use; it is returned to the pool after
	// Close so a 229-asset page load does not pay a flate-table allocation per response.
	pooledGzip *gzip.Writer
}

// pinnedGzipWriterPool reuses gzip.Writer state (the flate compressor's hash tables are the expensive part).
// The MEASURED cost without it was 204.7 MB allocated per 229-asset page load vs 25.0 MB identity; the pool
// removes the per-response setup without changing a single output byte, because Reset starts a fresh stream.
var pinnedGzipWriterPool = sync.Pool{
	New: func() any { return gzip.NewWriter(io.Discard) },
}

func (writer *pinnedCompressionWriter) Header() http.Header { return writer.inner.Header() }

func (writer *pinnedCompressionWriter) WriteHeader(status int) {
	if writer.wrote {
		return
	}
	writer.decide(status)
	writer.wrote = true
	writer.inner.WriteHeader(status)
	// A compressed body has no declared length; flush the head so net/http cannot buffer the (small) gzip body
	// and invent a Content-Length for it. Pinned answers these responses with chunked framing, and the probe
	// records transfer-encoding: chunked.
	if writer.compress {
		flushPinnedResponseWriter(writer.inner)
	}
}

func (writer *pinnedCompressionWriter) Write(body []byte) (int, error) {
	if !writer.wrote {
		writer.decide(http.StatusOK)
		writer.wrote = true
		writer.inner.WriteHeader(http.StatusOK)
	}
	if writer.compress {
		return writer.stream.Write(body)
	}
	return writer.inner.Write(body)
}

// Flush preserves streaming behaviour for a compressed response and delegates to the real writer otherwise.
// The pinned middleware exposes res.flush and flushes the zlib stream; handlers here type-assert
// http.Flusher, so the wrapper must keep the capability visible.
func (writer *pinnedCompressionWriter) Flush() {
	if writer.compress && writer.stream != nil {
		if flusher, ok := writer.stream.(interface{ Flush() error }); ok {
			_ = flusher.Flush()
		}
	}
	flushPinnedResponseWriter(writer.inner)
}

// Unwrap lets http.ResponseController reach the underlying writer.
func (writer *pinnedCompressionWriter) Unwrap() http.ResponseWriter { return writer.inner }

func (writer *pinnedCompressionWriter) close() {
	if writer.compress && writer.stream != nil {
		_ = writer.stream.Close()
	}
	if writer.pooledGzip != nil {
		writer.pooledGzip.Reset(io.Discard)
		pinnedGzipWriterPool.Put(writer.pooledGzip)
		writer.pooledGzip = nil
		writer.stream = nil
	}
}

// decide applies the pinned onHeaders hook exactly once, at the first WriteHeader/Write.
func (writer *pinnedCompressionWriter) decide(status int) {
	if writer.decided {
		return
	}
	writer.decided = true
	header := writer.inner.Header()
	// A 1xx/204/304 response has no representation to transform; pinned never compresses the first two and its
	// static 304 path removes Content-Type, so the filter cannot match it either.
	if status < 200 || status == http.StatusNoContent || status == http.StatusNotModified {
		return
	}
	contentType := header.Get("Content-Type")
	if !pinnedCompressibleContentType(contentType) {
		return
	}
	if pinnedCacheControlForbidsTransform(header.Get("Cache-Control")) {
		return
	}
	if header.Get("Content-Encoding") != "" {
		return
	}
	// The pinned Vary step runs here, before every reason not to compress.
	pinnedAppendVaryAcceptEncoding(header)
	if writer.request.Method == http.MethodHead {
		return
	}
	if declared := header.Get("Content-Length"); declared != "" {
		if length, err := strconv.ParseInt(declared, 10, 64); err == nil && length < pinnedCompressionThresholdBytes {
			return
		}
	}
	encoding := pinnedNegotiateEncoding(writer.request.Header.Get("Accept-Encoding"))
	if encoding == "" {
		return
	}
	header.Del("Content-Length")
	header.Set("Content-Encoding", encoding)
	if encoding == "gzip" {
		pooled := pinnedGzipWriterPool.Get().(*gzip.Writer)
		pooled.Reset(writer.inner)
		writer.stream = pooled
		writer.pooledGzip = pooled
	} else {
		// pinnedNegotiateEncoding only returns gzip or deflate; deflate is zlib-wrapped, which is what
		// zlib.createDeflate produces.
		writer.stream = zlib.NewWriter(writer.inner)
	}
	writer.compress = true
}

// pinnedCacheControlForbidsTransform mirrors the pinned `no-transform` check.
func pinnedCacheControlForbidsTransform(cacheControl string) bool {
	for _, directive := range strings.Split(cacheControl, ",") {
		if strings.EqualFold(strings.TrimSpace(directive), "no-transform") {
			return true
		}
	}
	return false
}

// pinnedAppendVaryAcceptEncoding mirrors the pinned `vary(res, 'Accept-Encoding')` call: append unless
// already present (case-insensitive) and never touch `Vary: *`.
func pinnedAppendVaryAcceptEncoding(header http.Header) {
	for _, value := range header.Values("Vary") {
		for _, token := range strings.Split(value, ",") {
			token = strings.TrimSpace(token)
			if token == "*" {
				return
			}
			if strings.EqualFold(token, "Accept-Encoding") {
				return
			}
		}
	}
	existing := strings.TrimSpace(header.Get("Vary"))
	if existing == "" {
		header.Set("Vary", "Accept-Encoding")
		return
	}
	header.Set("Vary", existing+", Accept-Encoding")
}

// pinnedNegotiateEncoding returns the encoding GoTavern will serve for this Accept-Encoding header, or "" for
// identity. It follows the pinned negotiator's q-value rules over the encodings GoTavern can produce:
//   - no Accept-Encoding header: pinned's enforceEncoding is identity, so no compression;
//   - gzip is chosen when acceptable, else deflate;
//   - brotli is deliberately not produced (no standard-library encoder); a br-only client receives identity.
//     tools/probe-compression.mjs records pinned's br answer and the replay test asserts BOTH halves.
func pinnedNegotiateEncoding(acceptEncoding string) string {
	if strings.TrimSpace(acceptEncoding) == "" {
		return ""
	}
	quality := map[string]float64{}
	wildcard := -1.0
	for _, entry := range strings.Split(acceptEncoding, ",") {
		parts := strings.Split(strings.TrimSpace(entry), ";")
		name := strings.ToLower(strings.TrimSpace(parts[0]))
		if name == "" {
			continue
		}
		q := 1.0
		for _, parameter := range parts[1:] {
			parameter = strings.TrimSpace(parameter)
			if !strings.HasPrefix(strings.ToLower(parameter), "q=") {
				continue
			}
			if parsed, err := strconv.ParseFloat(strings.TrimSpace(parameter[2:]), 64); err == nil {
				q = parsed
			}
		}
		if name == "*" {
			wildcard = q
			continue
		}
		quality[name] = q
	}
	acceptable := func(name string) float64 {
		if q, ok := quality[name]; ok {
			return q
		}
		if wildcard >= 0 {
			return wildcard
		}
		return 0
	}
	if acceptable("gzip") > 0 {
		return "gzip"
	}
	if acceptable("deflate") > 0 {
		return "deflate"
	}
	return ""
}

// flushPinnedResponseWriter reaches the real http.ResponseWriter through wrappers that do not expose Flusher
// themselves (pinnedResponseTimeWriter embeds the writer without implementing Flush).
func flushPinnedResponseWriter(writer http.ResponseWriter) {
	switch typed := writer.(type) {
	case interface{ Flush() }:
		typed.Flush()
	case interface{ Unwrap() http.ResponseWriter }:
		flushPinnedResponseWriter(typed.Unwrap())
	case *pinnedResponseTimeWriter:
		flushPinnedResponseWriter(typed.ResponseWriter)
	}
}
