package server

import (
	"fmt"
	"io"
	"net/http"
	"os"
	"sync"
	"time"

	"github.com/cocokoishi/gotavern/internal/startup"
)

// This file implements the pinned per-connection access log, which GoTavern did
// not have: only the legacy-file migration existed, so an operator following
// pinned's own instruction ("Check the \"access.log\" file in the data directory
// to inspect incoming connections", src/server-main.js:442) found a file that
// never grew.
//
// PINNED SOURCE (read, not remembered):
//   - src/middleware/accessLogWriter.js:6 -- `enableAccessLog` from
//     `logging.enableAccessLog`, default true.
//   - src/middleware/accessLogWriter.js:10 -- the path is
//     `path.join(DATA_ROOT, 'access.log')`.
//   - src/middleware/accessLogWriter.js:33-58 -- the middleware: the client IP
//     comes from `getIpAddress(req, true)`, a first request from an unseen IP
//     prints `New connection from <ip>; User Agent: <ua>` and appends
//     `<iso> <ip> <ua>\n`; a later request from the same IP does nothing.
//   - src/server-main.js:152-154 -- the middleware is mounted ONLY when
//     `cliArgs.listen` is true. That gate matters: the fresh-install config has
//     `listen: false` (upstream/default/config.yaml:6), so a default install
//     writes no access log however `logging.enableAccessLog` is set.
//   - src/server-main.js:150-156 -- its position is after the whitelist and
//     host-whitelist middleware and before the cookie session.
//
// DERIVATION, STATED: pinned appends asynchronously (`fs.appendFile` with a
// callback) and GoTavern appends synchronously inside the request. The file
// CONTENT is identical; only the moment the bytes land differs, and a
// synchronous append is what makes the behaviour assertable without a sleep.

// accessLogWriter holds the per-process state of the pinned middleware. pinned's
// `knownIPs` is a module-level Set (accessLogWriter.js:8); one handler per
// process makes this the same scope.
type accessLogWriter struct {
	mu       sync.Mutex
	knownIPs map[string]struct{}

	enabled  bool
	dataRoot string

	forwardedXRealIP        *bool
	forwardedCFConnectingIP *bool
	forwardedXForwardedFor  *bool

	console io.Writer
	errors  io.Writer

	now        func() time.Time
	appendLine func(path string, line []byte) error
}

func newAccessLogWriter(options HTTPHandlerOptions) *accessLogWriter {
	now := options.accessLogNow
	if now == nil {
		now = time.Now
	}
	return &accessLogWriter{
		knownIPs:                make(map[string]struct{}),
		enabled:                 options.AccessLogEnabled,
		dataRoot:                options.DataRoot,
		forwardedXRealIP:        options.ForwardedXRealIP,
		forwardedCFConnectingIP: options.ForwardedCFConnectingIP,
		forwardedXForwardedFor:  options.ForwardedXForwardedFor,
		console:                 options.accessLogConsole,
		errors:                  options.accessLogErrors,
		now:                     now,
		appendLine:              appendAccessLogLine,
	}
}

// record runs the pinned middleware body for one request. It never fails the
// request: a write error is logged and the handler continues, which is pinned's
// own behaviour (the append callback only reports the error).
func (writer *accessLogWriter) record(request *http.Request) {
	clientIP := getIpAddress(request, HTTPHandlerOptions{
		ForwardedXRealIP:        writer.forwardedXRealIP,
		ForwardedCFConnectingIP: writer.forwardedCFConnectingIP,
		ForwardedXForwardedFor:  writer.forwardedXForwardedFor,
	})

	writer.mu.Lock()
	_, known := writer.knownIPs[clientIP]
	if !known {
		writer.knownIPs[clientIP] = struct{}{}
	}
	enabled := writer.enabled
	writer.mu.Unlock()

	if known || !enabled {
		return
	}

	userAgent := request.Header.Get("User-Agent")
	if userAgent == "" {
		// pinned interpolates `req.headers['user-agent']` into a template string, so an
		// absent header is the literal text `undefined` in BOTH the console line and
		// the file line (accessLogWriter.js:36,44,47). That is a pinned byte, not an
		// oversight, so it is reproduced rather than tidied into an empty field.
		userAgent = "undefined"
	}

	// console.info(color.yellow(`New connection from ${clientIp}; User Agent: ${userAgent}\n`))
	// console.info adds its own newline, so the console output ends with a blank line.
	// The colour wrapper is not reproduced: GoTavern's startup output is uncoloured
	// throughout, and the coloured and plain renderings are the same bytes off a TTY.
	//
	// GATED BY `logging.minLogLevel`: this is a console.info call made WHILE SERVING, which pinned
	// replaces with a no-op unless the level is <= INFO (src/util.js:1140). The FILE line below is not
	// gated, because pinned replaces the console function and leaves the append alone.
	consoleInfof(writer.consoleWriter(), "New connection from %s; User Agent: %s\n\n", clientIP, userAgent)

	line := fmt.Sprintf("%s %s %s\n", writer.now().UTC().Format("2006-01-02T15:04:05.000Z"), clientIP, userAgent)
	if err := writer.appendLine(startup.AccessLogPath(writer.dataRoot), []byte(line)); err != nil {
		// console.error('Failed to write access log:', err)
		consoleErrorf(writer.errorWriter(), "Failed to write access log: %v\n", err)
	}
}

func (writer *accessLogWriter) consoleWriter() io.Writer {
	if writer.console != nil {
		return writer.console
	}
	return os.Stdout
}

func (writer *accessLogWriter) errorWriter() io.Writer {
	if writer.errors != nil {
		return writer.errors
	}
	return os.Stderr
}

// getIpAddress is the pinned express-common helper with includeHeaderIp = true
// (src/express-common.js:70-74): the socket address, plus the forwarded address
// in parentheses when one of the enabled forwarded headers carries it.
func getIpAddress(request *http.Request, options HTTPHandlerOptions) string {
	socketIP := requestClientIP(request)
	if forwardedIP := realOrForwardedIP(request, options); forwardedIP != "" {
		return socketIP + " (forwarded: " + forwardedIP + ")"
	}
	return socketIP
}

// appendAccessLogLine appends one line to the log. pinned's fs.appendFile
// creates the file with mode 0o666 when it is missing, which is what this does.
func appendAccessLogLine(path string, line []byte) error {
	file, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o666)
	if err != nil {
		return err
	}
	if _, err := file.Write(line); err != nil {
		_ = file.Close()
		return err
	}
	return file.Close()
}
