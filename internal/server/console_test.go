package server

// `logging.minLogLevel` -- the pinned console gate (src/util.js:1133-1143, installed at
// src/server-main.js:448):
//
//	const logLevel = getConfigValue('logging.minLogLevel', LOG_LEVELS.DEBUG, 'number');
//	globalThis.console.debug = logLevel <= LOG_LEVELS.DEBUG ? console.debug : () => { };
//	globalThis.console.info  = logLevel <= LOG_LEVELS.INFO  ? console.info  : () => { };
//	globalThis.console.warn  = logLevel <= LOG_LEVELS.WARN  ? console.warn  : () => { };
//	globalThis.console.error = logLevel <= LOG_LEVELS.ERROR ? console.error : () => { };
//
// with LOG_LEVELS {DEBUG:0, INFO:1, WARN:2, ERROR:3} (src/constants.js:517-522).
//
// THE TEST HAS TO DISTINGUISH TWO THINGS THAT LOOK ALIKE, or it proves nothing:
//
//   - the FILE line of the access log is NOT gated, because pinned replaces the console FUNCTION and leaves
//     the append alone (src/middleware/accessLogWriter.js:44-47). A gate that also suppressed the file would
//     be a different, wrong behaviour and would pass a test that only looked at the console;
//   - `console.log` is NOT among the four replaced functions, so the account recovery/reset code lines
//     (src/endpoints/users-public.js:135, src/endpoints/users-private.js:246) stay visible at every level.
//     That is asserted below too, because "apply the level to everything" is the tidy rewrite this test is
//     here to forbid.
//
// The fractional case is the one a truncating implementation gets wrong: at 2.5 pinned's `2.5 <= 2` is
// false, so the WARN line is silenced while ERROR survives.

import (
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/cocokoishi/gotavern/internal/startup"
)

func TestConsoleMinLogLevelGatesTheAccessLogConsoleLineOnly(t *testing.T) {
	for _, testCase := range []struct {
		name              string
		minLevel          float64
		wantConsoleOutput string
	}{
		{
			name:              "0 DEBUG is the shipped default and shows the console.info line",
			minLevel:          0,
			wantConsoleOutput: "New connection from 203.0.113.7; User Agent: test-agent/1.0\n\n",
		},
		{
			name:              "1 INFO still shows console.info",
			minLevel:          1,
			wantConsoleOutput: "New connection from 203.0.113.7; User Agent: test-agent/1.0\n\n",
		},
		{
			name:              "2 WARN hides console.info",
			minLevel:          2,
			wantConsoleOutput: "",
		},
		{
			name:              "3 ERROR hides console.info",
			minLevel:          3,
			wantConsoleOutput: "",
		},
		{
			name:              "2.5 hides WARN too, because the pinned comparison is numeric",
			minLevel:          2.5,
			wantConsoleOutput: "",
		},
		{
			name:              "4 silences every level",
			minLevel:          4,
			wantConsoleOutput: "",
		},
		{
			name:              "a negative level shows everything",
			minLevel:          -1,
			wantConsoleOutput: "New connection from 203.0.113.7; User Agent: test-agent/1.0\n\n",
		},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			handler, console, errors, dataRoot := accessLogHandler(t, HTTPHandlerOptions{
				Listen: true, AccessLogEnabled: true, ConsoleMinLogLevel: testCase.minLevel,
			})
			recorder := httptest.NewRecorder()
			handler.ServeHTTP(recorder, requestFrom("203.0.113.7:4000", "test-agent/1.0"))
			if recorder.Code != 200 {
				t.Fatalf("GET /version = %d, want 200", recorder.Code)
			}

			if got := console.String(); got != testCase.wantConsoleOutput {
				t.Errorf("console output = %q, want %q at logging.minLogLevel=%v", got, testCase.wantConsoleOutput, testCase.minLevel)
			}
			if errors.Len() != 0 {
				t.Errorf("error output = %q, want empty", errors.String())
			}
			// THE FILE IS NOT GATED. This is the half that separates a faithful port from "the setting turns
			// logging off": pinned replaces the console function, not the append.
			body, err := os.ReadFile(startup.AccessLogPath(dataRoot))
			if err != nil {
				t.Fatalf("read access log: %v", err)
			}
			if want := expectedAccessLogLine; string(body) != want {
				t.Errorf("access log = %q, want %q: logging.minLogLevel must not gate the file", string(body), want)
			}
		})
	}
}

// TestConsoleMinLogLevelGatesWarningsButNotConsoleLog covers the two calls that a blanket "silence the
// output" change would get wrong:
//
//   - the host-whitelist scan warning is `console.warn` (src/middleware/hostWhitelist.js:29-36), so WARN and
//     below show it and ERROR/above hide it;
//   - the account recovery code line is `console.log` (src/endpoints/users-public.js:135), which
//     setupLogLevel does NOT replace, so it survives at every level.
func TestConsoleMinLogLevelGatesWarningsButNotConsoleLog(t *testing.T) {
	for _, testCase := range []struct {
		name             string
		minLevel         float64
		wantWarningShown bool
	}{
		{name: "0 DEBUG shows the warning", minLevel: 0, wantWarningShown: true},
		{name: "2 WARN shows the warning", minLevel: 2, wantWarningShown: true},
		{name: "2.5 hides the warning because 2.5 <= 2 is false", minLevel: 2.5, wantWarningShown: false},
		{name: "3 ERROR hides the warning", minLevel: 3, wantWarningShown: false},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			warnings := &strings.Builder{}
			options := HTTPHandlerOptions{
				DataRoot:                   t.TempDir(),
				HostWhitelistScan:          true,
				ConsoleMinLogLevel:         testCase.minLevel,
				hostWhitelistWarningWriter: warnings,
			}
			handler := NewHTTPHandlerWithOptions(options)
			recorder := httptest.NewRecorder()
			request := requestFrom("203.0.113.7:4000", "test-agent/1.0")
			request.Host = "untrusted.example"
			handler.ServeHTTP(recorder, request)

			shown := strings.Contains(warnings.String(), "Request from untrusted host: untrusted.example")
			if shown != testCase.wantWarningShown {
				t.Errorf("warning shown = %t, want %t at logging.minLogLevel=%v (output %q)",
					shown, testCase.wantWarningShown, testCase.minLevel, warnings.String())
			}
		})
	}
}
