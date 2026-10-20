package server

// Pinned response-time middleware, from src/server-main.js:108
// (`app.use(responseTime())`) and node_modules/response-time: every response
// carries `X-Response-Time: <milliseconds, three decimals>ms`, and an existing
// value is left alone.
//
// GoTavern does not install this middleware for the whole server yet. The
// provider-wire differential surfaced that gap, because its tier-3 exclusion
// rule requires the header to be present before its wall-clock value can be
// excluded: a rule that names a header the backend never sends is treated as
// stale rather than ignored. The chat-completion route therefore stamps its own
// responses, and the shared middleware still needs the same call before the
// header is universal.

import (
	"net/http"
	"strconv"
	"time"
)

// pinnedResponseTimeValue formats the pinned middleware's value.
func pinnedResponseTimeValue(elapsed time.Duration) string {
	return strconv.FormatFloat(float64(elapsed.Nanoseconds())/1e6, 'f', 3, 64) + "ms"
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

func (writer *pinnedResponseTimeWriter) WriteHeader(status int) {
	if !writer.wroteHead {
		writer.wroteHead = true
		if writer.Header().Get("X-Response-Time") == "" {
			writer.Header().Set("X-Response-Time", pinnedResponseTimeValue(time.Since(writer.started)))
		}
	}
	writer.ResponseWriter.WriteHeader(status)
}

func (writer *pinnedResponseTimeWriter) Write(body []byte) (int, error) {
	if !writer.wroteHead {
		writer.WriteHeader(http.StatusOK)
	}
	return writer.ResponseWriter.Write(body)
}

// Flush keeps the streaming path's http.Flusher assertion working.
func (writer *pinnedResponseTimeWriter) Flush() {
	if flusher, ok := writer.ResponseWriter.(http.Flusher); ok {
		flusher.Flush()
	}
}

// Unwrap lets http.ResponseController reach the underlying writer.
func (writer *pinnedResponseTimeWriter) Unwrap() http.ResponseWriter {
	return writer.ResponseWriter
}
