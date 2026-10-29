package server

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/cocokoishi/gotavern/internal/startup"
)

// fixedAccessLogClock is the injected timestamp. `new Date().toISOString()`
// always renders three fractional digits and a trailing Z
// (src/middleware/accessLogWriter.js:46), so the expected line below is exact.
var fixedAccessLogClock = time.Date(2026, time.October, 29, 8, 35, 24, 123000000, time.UTC)

const expectedAccessLogLine = "2026-10-29T08:35:24.123Z 203.0.113.7 test-agent/1.0\n"

// accessLogHandler builds the REAL handler (so the middleware is mounted where
// the product mounts it, not called directly) with the pinned gates supplied by
// the test and both console streams captured.
func accessLogHandler(t *testing.T, options HTTPHandlerOptions) (http.Handler, *bytes.Buffer, *bytes.Buffer, string) {
	t.Helper()
	dataRoot := options.DataRoot
	if dataRoot == "" {
		dataRoot = t.TempDir()
	}
	console := &bytes.Buffer{}
	errors := &bytes.Buffer{}
	options.DataRoot = dataRoot
	options.accessLogConsole = console
	options.accessLogErrors = errors
	options.accessLogNow = func() time.Time { return fixedAccessLogClock }
	return NewHTTPHandlerWithOptions(options), console, errors, dataRoot
}

func requestFrom(remoteAddr, userAgent string) *http.Request {
	request := httptest.NewRequest(http.MethodGet, "/version", nil)
	request.RemoteAddr = remoteAddr
	if userAgent != "" {
		request.Header.Set("User-Agent", userAgent)
	}
	return request
}

// TestAccessLogWritesOneLinePerNewClientIP is the pinned contract of
// src/middleware/accessLogWriter.js:33-58: the FIRST request from an address
// writes one line and prints one console line; a later request from the same
// address writes nothing; a different address writes one more.
func TestAccessLogWritesOneLinePerNewClientIP(t *testing.T) {
	handler, console, errors, dataRoot := accessLogHandler(t, HTTPHandlerOptions{Listen: true, AccessLogEnabled: true})

	for _, remoteAddr := range []string{"203.0.113.7:4000", "203.0.113.7:4001", "198.51.100.9:4002"} {
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, requestFrom(remoteAddr, "test-agent/1.0"))
		if recorder.Code != http.StatusOK {
			t.Fatalf("GET /version from %s = %d, want 200", remoteAddr, recorder.Code)
		}
	}

	body, err := os.ReadFile(startup.AccessLogPath(dataRoot))
	if err != nil {
		t.Fatalf("read access log: %v", err)
	}
	// The whole file, byte for byte: one pinned line per distinct client IP, in
	// arrival order, each terminated by a single newline.
	want := expectedAccessLogLine + "2026-10-29T08:35:24.123Z 198.51.100.9 test-agent/1.0\n"
	if string(body) != want {
		t.Fatalf("access log = %q, want %q", string(body), want)
	}
	if got := console.String(); got != "New connection from 203.0.113.7; User Agent: test-agent/1.0\n\nNew connection from 198.51.100.9; User Agent: test-agent/1.0\n\n" {
		t.Errorf("console output = %q, want one pinned `New connection from` line per new address", got)
	}
	if errors.Len() != 0 {
		t.Errorf("error output = %q, want empty", errors.String())
	}
}

// TestAccessLogGatesArePinned: the middleware is mounted only in listen mode
// (src/server-main.js:152-154) and only appends when logging.enableAccessLog is
// true (accessLogWriter.js:6,43).
func TestAccessLogGatesArePinned(t *testing.T) {
	cases := []struct {
		name    string
		options HTTPHandlerOptions
		wantLog bool
	}{
		{name: "listen with the default-enabled log", options: HTTPHandlerOptions{Listen: true, AccessLogEnabled: true}, wantLog: true},
		{name: "not listening", options: HTTPHandlerOptions{Listen: false, AccessLogEnabled: true}, wantLog: false},
		{name: "logging disabled", options: HTTPHandlerOptions{Listen: true, AccessLogEnabled: false}, wantLog: false},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			handler, console, _, dataRoot := accessLogHandler(t, testCase.options)
			for index := 0; index < 2; index++ {
				recorder := httptest.NewRecorder()
				handler.ServeHTTP(recorder, requestFrom("203.0.113.7:4000", "test-agent/1.0"))
				if recorder.Code != http.StatusOK {
					t.Fatalf("GET /version = %d, want 200", recorder.Code)
				}
			}
			_, err := os.Stat(startup.AccessLogPath(dataRoot))
			switch {
			case testCase.wantLog && err != nil:
				t.Fatalf("access log missing with the log enabled: %v", err)
			case !testCase.wantLog && err == nil:
				t.Fatalf("access log written although the pinned gate is closed (%+v)", testCase.options)
			}
			if !testCase.wantLog && console.Len() != 0 {
				t.Errorf("console output = %q, want nothing when the pinned gate is closed", console.String())
			}
		})
	}
}

// TestAccessLogWriteFailureIsNonFatal: the pinned append reports its error and
// the request continues (accessLogWriter.js:49-53). The data root here has a
// FILE where its parent directory should be, so the append cannot succeed on any
// host.
func TestAccessLogWriteFailureIsNonFatal(t *testing.T) {
	blocker := filepath.Join(t.TempDir(), "not-a-directory")
	if err := os.WriteFile(blocker, []byte("file"), 0o600); err != nil {
		t.Fatal(err)
	}
	handler, console, errors, _ := accessLogHandler(t, HTTPHandlerOptions{
		DataRoot:         filepath.Join(blocker, "data"),
		Listen:           true,
		AccessLogEnabled: true,
	})

	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, requestFrom("203.0.113.7:4000", "test-agent/1.0"))
	if recorder.Code != http.StatusOK {
		t.Fatalf("GET /version with an unwritable data root = %d, want 200: a log failure must not fail the request", recorder.Code)
	}
	if !strings.Contains(console.String(), "New connection from 203.0.113.7") {
		t.Errorf("console output = %q, want the pinned connection line even when the append fails", console.String())
	}
	if !strings.Contains(errors.String(), "Failed to write access log:") {
		t.Errorf("error output = %q, want pinned's `Failed to write access log:` message", errors.String())
	}
}

// TestAccessLogClientAddressMatchesPinnedGetIpAddress covers
// `getIpAddress(req, true)` (src/express-common.js:70-74), including the
// forwarded form and the forwardedHeaders gate that suppresses it.
func TestAccessLogClientAddressMatchesPinnedGetIpAddress(t *testing.T) {
	realIP := true
	cases := []struct {
		name            string
		forwardedXReal  *bool
		header          string
		expectedAddress string
	}{
		{name: "forwarded address is appended", forwardedXReal: &realIP, header: "198.51.100.9", expectedAddress: "203.0.113.7 (forwarded: 198.51.100.9)"},
		{name: "forwarded header suppressed by its config gate", forwardedXReal: boolPointer(false), header: "198.51.100.9", expectedAddress: "203.0.113.7"},
		{name: "no forwarded header", forwardedXReal: &realIP, header: "", expectedAddress: "203.0.113.7"},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			handler, _, _, dataRoot := accessLogHandler(t, HTTPHandlerOptions{
				Listen: true, AccessLogEnabled: true, ForwardedXRealIP: testCase.forwardedXReal,
			})
			request := requestFrom("203.0.113.7:4000", "test-agent/1.0")
			if testCase.header != "" {
				request.Header.Set("X-Real-IP", testCase.header)
			}
			recorder := httptest.NewRecorder()
			handler.ServeHTTP(recorder, request)

			body, err := os.ReadFile(startup.AccessLogPath(dataRoot))
			if err != nil {
				t.Fatal(err)
			}
			want := "2026-10-29T08:35:24.123Z " + testCase.expectedAddress + " test-agent/1.0\n"
			if string(body) != want {
				t.Errorf("access log = %q, want %q", string(body), want)
			}
		})
	}
}

// TestAccessLogAbsentUserAgentIsThePinnedUndefined: pinned interpolates
// `req.headers['user-agent']` into a template string, so an absent header is the
// literal text `undefined` -- in the file AND on the console
// (accessLogWriter.js:36,44,47). A tidier empty field would be a different byte.
func TestAccessLogAbsentUserAgentIsThePinnedUndefined(t *testing.T) {
	handler, console, _, dataRoot := accessLogHandler(t, HTTPHandlerOptions{Listen: true, AccessLogEnabled: true})
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, requestFrom("203.0.113.7:4000", ""))

	body, err := os.ReadFile(startup.AccessLogPath(dataRoot))
	if err != nil {
		t.Fatal(err)
	}
	if want := "2026-10-29T08:35:24.123Z 203.0.113.7 undefined\n"; string(body) != want {
		t.Errorf("access log = %q, want %q", string(body), want)
	}
	if want := "New connection from 203.0.113.7; User Agent: undefined\n\n"; console.String() != want {
		t.Errorf("console output = %q, want %q", console.String(), want)
	}
}

// TestAccessLogIsMountedAfterTheWhitelist: a request the whitelist middleware
// refuses must not appear in the access log, which is what the pinned mount
// order (after the whitelist, src/server-main.js:145-154) produces. If the
// logger were mounted above the whitelist this test would see a log file.
func TestAccessLogIsMountedAfterTheWhitelist(t *testing.T) {
	handler, console, _, dataRoot := accessLogHandler(t, HTTPHandlerOptions{
		Listen: true, AccessLogEnabled: true, WhitelistEnabled: true, Whitelist: []string{"192.0.2.1"},
	})
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, requestFrom("203.0.113.7:4000", "test-agent/1.0"))
	if recorder.Code != http.StatusForbidden {
		t.Fatalf("whitelisted-out request = %d, want 403", recorder.Code)
	}
	if _, err := os.Stat(startup.AccessLogPath(dataRoot)); !os.IsNotExist(err) {
		t.Errorf("access log exists (%v) for a request the whitelist refused; the logger is mounted above the whitelist", err)
	}
	if console.Len() != 0 {
		t.Errorf("console output = %q, want nothing for a refused request", console.String())
	}
}
