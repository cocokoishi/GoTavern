package server

// Pinned response-time middleware, from src/server-main.js:108
// (`app.use(responseTime())`) and node_modules/response-time: every response
// carries `X-Response-Time: <milliseconds, three decimals>ms`, and an existing
// value is left alone.
//
// Its value is a wall-clock measurement, so it can never be pinned; presence is
// the contract, and presence is asserted where it genuinely can be. The
// provider-wire differential's headerCoverage rule fails closed when a declared
// normalization rule names a header the backend never sent, which is how the
// missing middleware was found: the domain probes filter this header out of
// their comparisons because its value is unpinnable, and that filtering hid the
// omission for the whole project.

import (
	"net/http"
	"strconv"
	"time"
)

// pinnedResponseTimeValue formats the pinned middleware's value.
func pinnedResponseTimeValue(elapsed time.Duration) string {
	return strconv.FormatFloat(float64(elapsed.Nanoseconds())/1e6, 'f', 3, 64) + "ms"
}

// pinnedResponseTimeMiddleware installs the pinned middleware for every
// response, in the position the pinned server installs it: before its routes.
func pinnedResponseTimeMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writer := withPinnedResponseTime(w)
		next.ServeHTTP(writer, r)
		// A handler that returned without writing anything still gets the
		// header: net/http flushes its implicit 200 only after the handler
		// returns, so the head is still mutable here.
		writer.ensureResponseTimeHeader()
	})
}

// pinnedResponseTimeWriter stamps the header when the response head is written,
// which is where the pinned middleware's onHeaders hook runs.
type pinnedResponseTimeWriter struct {
	http.ResponseWriter
	started   time.Time
	wroteHead bool
}

func withPinnedResponseTime(writer http.ResponseWriter) *pinnedResponseTimeWriter {
	return &pinnedResponseTimeWriter{ResponseWriter: writer, started: time.Now()}
}

func (writer *pinnedResponseTimeWriter) ensureResponseTimeHeader() {
	if writer.wroteHead {
		return
	}
	if writer.Header().Get("X-Response-Time") == "" {
		writer.Header().Set("X-Response-Time", pinnedResponseTimeValue(time.Since(writer.started)))
	}
}

func (writer *pinnedResponseTimeWriter) WriteHeader(status int) {
	if !writer.wroteHead {
		// Stamp before recording that the head was written: the stamp itself is
		// a no-op once wroteHead is set.
		writer.ensureResponseTimeHeader()
		writer.wroteHead = true
	}
	writer.ResponseWriter.WriteHeader(status)
}

func (writer *pinnedResponseTimeWriter) Write(body []byte) (int, error) {
	if !writer.wroteHead {
		writer.WriteHeader(http.StatusOK)
	}
	return writer.ResponseWriter.Write(body)
}

// Flush keeps a streaming handler's http.Flusher assertion working.
func (writer *pinnedResponseTimeWriter) Flush() {
	if flusher, ok := writer.ResponseWriter.(http.Flusher); ok {
		flusher.Flush()
	}
}

// Unwrap lets http.ResponseController reach the underlying writer.
func (writer *pinnedResponseTimeWriter) Unwrap() http.ResponseWriter {
	return writer.ResponseWriter
}
