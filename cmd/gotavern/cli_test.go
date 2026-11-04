package main

import (
	"bytes"
	"errors"
	"net"
	"os"
	"strings"
	"testing"

	"github.com/cocokoishi/gotavern/internal/commandline"
	"github.com/cocokoishi/gotavern/internal/configinit"
)

// GOAL.md §15.5: --help and --version work for every subcommand and in ANY argument position, and
// asking for help never boots the server. These cases are the user-visible contract; a regression that
// returns to booting is caught because the assertions look for help text instead of a listener line.
func TestHelpAndVersionWorkInAnyPosition(t *testing.T) {
	helpCases := []struct {
		args []string
		want []string
	}{
		{args: []string{"--help"}, want: []string{"Usage:", "--global", "unknown option"}},
		{args: []string{"-h"}, want: []string{"Usage:", "--global"}},
		{args: []string{"help"}, want: []string{"Usage:", "--global"}},
		{args: []string{"help", "start"}, want: []string{"Usage: gotavern [server options]", "--global"}},
		{args: []string{"start", "--help"}, want: []string{"Usage: gotavern [server options]", "--global"}},
		{args: []string{"start", "-h"}, want: []string{"Usage: gotavern [server options]"}},
		{args: []string{"version", "--help"}, want: []string{"Usage: gotavern version [--json]", "SillyTavern baseline"}},
		{args: []string{"version", "-h"}, want: []string{"Usage: gotavern version"}},
		{args: []string{"assets", "--help"}, want: []string{"Usage: gotavern assets verify", "tokenizers"}},
		{args: []string{"assets", "verify", "--help"}, want: []string{"Usage: gotavern assets verify"}},
		{args: []string{"migrate", "--help"}, want: []string{"Usage:", "gotavern migrate --from", "SOURCE IS NEVER MODIFIED"}},
		{args: []string{"migrate", "-h"}, want: []string{"gotavern migrate --source-global"}},
		{args: []string{"help", "migrate"}, want: []string{"gotavern migrate --from"}},
		{args: []string{"--verbose", "--help"}, want: []string{"Usage:", "GoTavern additions"}},
	}
	for _, testCase := range helpCases {
		t.Run(strings.Join(testCase.args, "_"), func(t *testing.T) {
			var stdout, stderr bytes.Buffer
			if err := runWithStreams(testCase.args, &stdout, &stderr); err != nil {
				t.Fatalf("runWithStreams(%v) = %v, want nil (help exits 0)", testCase.args, err)
			}
			output := stdout.String()
			for _, want := range testCase.want {
				if !strings.Contains(output, want) {
					t.Errorf("stdout does not contain %q:\n%s", want, output)
				}
			}
			// The failure this test exists to prevent: a help request that boots a server.
			for _, bootLine := range []string{"Launching in a browser", "GoTavern is listening on", "Ready: GoTavern is serving"} {
				if strings.Contains(output, bootLine) {
					t.Errorf("a help request printed %q, so it booted instead of printing help:\n%s", bootLine, output)
				}
			}
			if stderr.Len() != 0 {
				t.Errorf("stderr = %q, want empty: help goes to stdout", stderr.String())
			}
		})
	}
}

// --version in any position prints the same block `gotavern version` prints, and --json still works.
func TestVersionWorksInAnyPosition(t *testing.T) {
	cases := [][]string{
		{"version"},
		{"--version"},
		{"start", "--version"},
		{"gotavern", "--version"}, // an unknown positional does not matter; --version wins
	}
	for _, args := range cases {
		t.Run(strings.Join(args, "_"), func(t *testing.T) {
			var stdout, stderr bytes.Buffer
			if err := runWithStreams(args, &stdout, &stderr); err != nil {
				t.Fatalf("runWithStreams(%v) = %v, want nil", args, err)
			}
			output := stdout.String()
			if !strings.Contains(output, "GoTavern "+version) {
				t.Errorf("stdout = %q, want the GoTavern version", output)
			}
			if !strings.Contains(output, "SillyTavern baseline") {
				t.Errorf("stdout = %q, want the pinned baseline", output)
			}
			if strings.Contains(output, "GoTavern is listening on") {
				t.Errorf("--version booted a server:\n%s", output)
			}
		})
	}

	for _, args := range [][]string{{"version", "--json"}, {"--version", "--json"}} {
		var stdout, stderr bytes.Buffer
		if err := runWithStreams(args, &stdout, &stderr); err != nil {
			t.Fatalf("runWithStreams(%v) = %v, want nil", args, err)
		}
		for _, field := range []string{"gotavern_version", "sillytavern_version", "sillytavern_commit"} {
			if !strings.Contains(stdout.String(), field) {
				t.Errorf("--json output does not carry %q:\n%s", field, stdout.String())
			}
		}
	}
}

// Unknown --options are reported on stderr, in argument order, and detection must not mistake a VALUE
// for an option (a value-taking flag consumes the next token).
func TestUnknownServerArguments(t *testing.T) {
	cases := []struct {
		name string
		args []string
		want []string
	}{
		{name: "a typo is named", args: []string{"--prot", "3000"}, want: []string{"--prot"}},
		{name: "known options and their values are not unknown", args: []string{"--port", "3000", "--dataRoot", "/tmp/x"}, want: nil},
		{name: "inline values are not options", args: []string{"--port=3000", "--browserLaunchHostname=localhost"}, want: nil},
		{name: "an unknown option between known ones", args: []string{"--listen", "--nosuch", "true"}, want: []string{"--nosuch"}},
		{name: "a negated known boolean is recognised", args: []string{"--no-listen"}, want: nil},
		{name: "an array consumes its values", args: []string{"--requestProxyBypass", "a", "b", "--nosuch"}, want: []string{"--nosuch"}},
		{name: "a missing value does not swallow the next option", args: []string{"--configPath", "--nosuch"}, want: []string{"--nosuch"}},
		{name: "the terminator ends the scan", args: []string{"--", "--nosuch"}, want: nil},
		{name: "existing flags only", args: []string{"--listen", "true", "--port", "0", "--enableIPv4", "true", "--enableIPv6", "false"}, want: nil},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			got := commandline.UnknownServerArguments(testCase.args)
			if strings.Join(got, ",") != strings.Join(testCase.want, ",") {
				t.Fatalf("UnknownServerArguments(%v) = %v, want %v", testCase.args, got, testCase.want)
			}
			var warnings bytes.Buffer
			printUnknownOptionWarnings(&warnings, got)
			for _, name := range testCase.want {
				if !strings.Contains(warnings.String(), name) {
					t.Errorf("warning output does not name %q:\n%s", name, warnings.String())
				}
			}
			if len(testCase.want) == 0 && warnings.Len() != 0 {
				t.Errorf("warnings = %q, want none", warnings.String())
			}
		})
	}
}

// Colour policy: NO_COLOR/FORCE_COLOR/TERM=dumb precedence, and plain output for a non-terminal.
func TestColorPolicy(t *testing.T) {
	cases := []struct {
		name        string
		force       string
		forceSet    bool
		noColor     string
		noColorSet  bool
		term        string
		isTerminal  bool
		wantEnabled bool
	}{
		{name: "terminal enables", isTerminal: true, wantEnabled: true},
		{name: "pipe disables", isTerminal: false, wantEnabled: false},
		{name: "FORCE_COLOR forces on even piped", force: "1", forceSet: true, wantEnabled: true},
		{name: "FORCE_COLOR=0 forces off on a terminal", force: "0", forceSet: true, isTerminal: true, wantEnabled: false},
		{name: "FORCE_COLOR=false forces off", force: "false", forceSet: true, isTerminal: true, wantEnabled: false},
		{name: "FORCE_COLOR beats NO_COLOR", force: "1", forceSet: true, noColor: "1", noColorSet: true, wantEnabled: true},
		{name: "NO_COLOR disables on a terminal", noColor: "1", noColorSet: true, isTerminal: true, wantEnabled: false},
		{name: "an empty NO_COLOR does not disable", noColor: "", noColorSet: true, isTerminal: true, wantEnabled: true},
		{name: "TERM=dumb disables on a terminal", term: "dumb", isTerminal: true, wantEnabled: false},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			got := colorPolicy(testCase.force, testCase.forceSet, testCase.noColor, testCase.noColorSet, testCase.term, testCase.isTerminal)
			if got != testCase.wantEnabled {
				t.Fatalf("colorPolicy(...) = %t, want %t", got, testCase.wantEnabled)
			}
		})
	}

	var buffer bytes.Buffer
	plain := newPalette(&buffer)
	if plain.enabled {
		t.Fatal("a bytes.Buffer must be treated as a non-terminal")
	}
	if got := plain.green("x"); got != "x" {
		t.Errorf("plain palette green(%q) = %q, want no escapes", "x", got)
	}
	coloured := palette{enabled: true}
	if got := coloured.green("x"); got != "\x1b[32mx\x1b[0m" {
		t.Errorf("coloured palette green = %q", got)
	}
	if got := coloured.blue("u"); got != "\x1b[34mu\x1b[0m" {
		t.Errorf("coloured palette blue = %q", got)
	}
}

// The first-run block names GoTavern, its version, its baseline and the REAL resolved paths.
func TestStartupIdentityNamesVersionBaselineAndPaths(t *testing.T) {
	var stdout bytes.Buffer
	printStartupIdentity(&stdout, palette{}, startupIdentity{
		Version:    "9.9.9",
		Baseline:   "1.19.0",
		Commit:     "06bde939fb1e9c4c8d8641d810f0a916b5bce127",
		InstallDir: "/opt/gotavern",
		ConfigFile: "/srv/st/config.yaml",
		DataRoot:   "/srv/st/data",
	})
	output := stdout.String()
	for _, want := range []string{
		"GoTavern 9.9.9 (SillyTavern 1.19.0 baseline, 06bde939fb1e9c4c8d8641d810f0a916b5bce127)",
		"Install root: /opt/gotavern",
		"Config file:  /srv/st/config.yaml",
		"Data root:    /srv/st/data",
	} {
		if !strings.Contains(output, want) {
			t.Errorf("identity output does not contain %q:\n%s", want, output)
		}
	}
}

// The Ready line carries the URL the runtime is actually serving.
func TestReadyLineCarriesTheURL(t *testing.T) {
	var stdout bytes.Buffer
	printReadyLine(&stdout, palette{}, "http://127.0.0.1:8000/")
	want := "Ready: GoTavern is serving at http://127.0.0.1:8000/\n"
	if stdout.String() != want {
		t.Fatalf("Ready line = %q, want %q", stdout.String(), want)
	}
}

type testAddr struct{ value string }

func (a testAddr) Network() string { return "tcp" }
func (a testAddr) String() string  { return a.value }

// The Ready URL is derived from the BOUND socket, so a wildcard address is rendered as localhost and an
// ephemeral port is reported as bound instead of as the configured ":0".
func TestServeURLFromBoundAddresses(t *testing.T) {
	cases := []struct {
		name    string
		address string
		tls     bool
		want    string
	}{
		{name: "loopback v4", address: "127.0.0.1:8000", want: "http://127.0.0.1:8000/"},
		{name: "loopback v6", address: "[::1]:8000", want: "http://[::1]:8000/"},
		{name: "wildcard v4 is not browsable", address: "0.0.0.0:8000", want: "http://localhost:8000/"},
		{name: "wildcard v6 is not browsable", address: "[::]:9000", want: "http://localhost:9000/"},
		{name: "ephemeral port is kept", address: "127.0.0.1:54123", want: "http://127.0.0.1:54123/"},
		{name: "https when ssl is on", address: "127.0.0.1:8000", tls: true, want: "https://127.0.0.1:8000/"},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			got, err := serveURL([]net.Addr{testAddr{value: testCase.address}}, testCase.tls)
			if err != nil {
				t.Fatalf("serveURL(%q) = %v", testCase.address, err)
			}
			if got != testCase.want {
				t.Fatalf("serveURL(%q) = %q, want %q", testCase.address, got, testCase.want)
			}
		})
	}
	if _, err := serveURL(nil, false); err == nil {
		t.Fatal("serveURL with no listeners returned nil error, want a named failure")
	}
}

// Actionable hints: cause plus next step, and the pinned config-refusal type gets NO hint because its
// block is fixture-asserted and must stay byte-identical.
func TestErrorHints(t *testing.T) {
	cases := []struct {
		err  error
		want string
	}{
		{err: errors.New("listen tcp4 127.0.0.1:8000: bind: address already in use"), want: "another process is listening on that port"},
		{err: errors.New("open /srv/data: permission denied"), want: "not writable"},
		{err: errors.New("tokenizers are missing from /a, /b and /c: the tokenizer routes would silently fall back to guesstimates"), want: "reinstall the release"},
		{err: errors.New("Error: SSL certificate path does not exist"), want: "ssl.certPath"},
		{err: errors.New("Error: SSL key path does not exist"), want: "ssl.certPath"},
		{err: errors.New("decode data/characters/x.png: corrupt PNG"), want: "restore it from backups/"},
		{err: errors.New("Error: Failed to start server on both IPv6 and IPv4"), want: "check the listen/protocol settings"},
		{err: errors.New("something unrelated"), want: ""},
		{err: &configinit.ParseError{Message: "Map keys must be unique at line 2, column 1:\nport: 8000\nport: 9000\n^"}, want: ""},
	}
	for _, testCase := range cases {
		t.Run(strings.TrimSpace(testCase.want), func(t *testing.T) {
			hint := errorHint(testCase.err)
			if testCase.want == "" {
				if hint != "" {
					t.Fatalf("errorHint(%v) = %q, want none", testCase.err, hint)
				}
				return
			}
			if !strings.Contains(hint, testCase.want) {
				t.Fatalf("errorHint(%v) = %q, want it to contain %q", testCase.err, hint, testCase.want)
			}
			var stderr bytes.Buffer
			printErrorHint(&stderr, testCase.err)
			if !strings.Contains(stderr.String(), "Hint: ") {
				t.Errorf("printErrorHint wrote %q, want a Hint: line", stderr.String())
			}
		})
	}

	// The pinned refusal block is printed by reportConfigParseFailure, BEFORE any hint. Assert that the
	// function still writes the pinned bytes and that a hint would never be appended to them.
	var stderr bytes.Buffer
	code, reported := reportConfigParseFailure(&stderr, &configinit.ParseError{Message: "Map keys must be unique at line 2, column 1:\nport: 8000\nport: 9000\n^"})
	if !reported || code != 1 {
		t.Fatalf("reportConfigParseFailure reported=%t code=%d, want true/1", reported, code)
	}
	for _, pinned := range []string{
		"Could not add missing config values to config.yaml YAMLParseError: Map keys must be unique",
		"FATAL: Failed to read config.yaml. Please check the file for syntax errors.",
	} {
		if !strings.Contains(stderr.String(), pinned) {
			t.Errorf("pinned refusal block is missing %q:\n%s", pinned, stderr.String())
		}
	}
	if strings.Contains(stderr.String(), "Hint:") {
		t.Errorf("a hint was appended to the pinned config-refusal block:\n%s", stderr.String())
	}
}

// --verbose is a GoTavern addition: it is stripped before the pinned parser sees it and it enables the
// startup trace for this boot only, restoring the previous environment afterwards.
func TestVerboseFlagStrippingAndTraceScope(t *testing.T) {
	cases := []struct {
		name        string
		args        []string
		wantArgs    []string
		wantVerbose bool
	}{
		{name: "plain remove", args: []string{"--verbose", "--port", "1"}, wantArgs: []string{"--port", "1"}, wantVerbose: true},
		{name: "inline true", args: []string{"--verbose=true"}, wantArgs: nil, wantVerbose: true},
		{name: "inline false", args: []string{"--verbose=false"}, wantArgs: nil, wantVerbose: false},
		{name: "absent", args: []string{"--port", "1"}, wantArgs: []string{"--port", "1"}, wantVerbose: false},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			gotArgs, gotVerbose := stripVerbose(testCase.args)
			if strings.Join(gotArgs, ",") != strings.Join(testCase.wantArgs, ",") || gotVerbose != testCase.wantVerbose {
				t.Fatalf("stripVerbose(%v) = (%v, %t), want (%v, %t)", testCase.args, gotArgs, gotVerbose, testCase.wantArgs, testCase.wantVerbose)
			}
		})
	}

	// A --verbose help request never boots, so it must not leak the env var either.
	original, had := os.LookupEnv("GOTAVERN_STARTUP_TRACE")
	_ = os.Unsetenv("GOTAVERN_STARTUP_TRACE")
	defer func() {
		if had {
			_ = os.Setenv("GOTAVERN_STARTUP_TRACE", original)
		} else {
			_ = os.Unsetenv("GOTAVERN_STARTUP_TRACE")
		}
	}()
	if err := withStartupTrace(true, func() error {
		if got := os.Getenv("GOTAVERN_STARTUP_TRACE"); got != "1" {
			return errors.New("trace environment was not enabled inside the scope")
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if got := os.Getenv("GOTAVERN_STARTUP_TRACE"); got != "" {
		t.Fatalf("GOTAVERN_STARTUP_TRACE = %q after the scope, want it restored", got)
	}
}

// The friendly shutdown contract: the first signal says what is happening and how to force it, and the
// forced sentinel exits 130 without being dressed up as a product error.
func TestShutdownMessagesAndForcedExit(t *testing.T) {
	var interrupt os.Signal = os.Interrupt
	notice := shutdownNotice(interrupt)
	if !strings.Contains(notice, "Shutting down") {
		t.Errorf("shutdown notice = %q, want the existing prefix a grep may still expect", notice)
	}
	if !strings.Contains(notice, "Ctrl+C again to force") {
		t.Errorf("shutdown notice = %q, want the second-signal guidance", notice)
	}

	forced := forcedShutdown{Signal: interrupt.String()}
	if forced.ExitCode() != 130 {
		t.Errorf("forced shutdown exit code = %d, want 130 (128+SIGINT)", forced.ExitCode())
	}
	if !strings.Contains(forced.Error(), "forced shutdown") {
		t.Errorf("forced shutdown error = %q, want it named", forced.Error())
	}
}

// The top-level help keeps the pinned option set and records the deliberate deviations where an
// operator reads them. This is the documentation half of deliverable 3.
func TestTopLevelHelpRecordsDeviations(t *testing.T) {
	var stdout, stderr bytes.Buffer
	if err := runWithStreams([]string{"--help"}, &stdout, &stderr); err != nil {
		t.Fatalf("--help = %v, want nil", err)
	}
	output := stdout.String()
	for _, option := range commandline.OptionNames() {
		if !strings.Contains(output, "--"+option) {
			t.Errorf("top-level help no longer documents the pinned option --%s", option)
		}
	}
	for _, want := range []string{"--verbose", "unknown option", "Pinned SillyTavern's argument"} {
		if !strings.Contains(output, want) {
			t.Errorf("top-level help does not record %q:\n%s", want, output)
		}
	}
}

// Browser-launch failures are non-fatal (pinned's catch) but must name the next step, per GOAL.md §15.5.
func TestBrowserLaunchFailureCarriesAHint(t *testing.T) {
	failing := func(string, ...string) error {
		return errors.New(`exec: "xdg-open": executable file not found in $PATH`)
	}
	var stdout, stderr bytes.Buffer
	launchBrowser(&stdout, &stderr, commandline.ServerOptions{
		Port: 8000, BrowserLaunchEnabled: true, BrowserLaunchHostname: "auto", BrowserLaunchPort: -1,
	}, "default", false, true, "linux", failing)
	if !strings.Contains(stderr.String(), "Failed to launch the browser. Open the URL manually.") {
		t.Fatalf("stderr = %q, want pinned's manual-open message", stderr.String())
	}
	if !strings.Contains(stderr.String(), "Hint: open http://127.0.0.1:8000/") {
		t.Fatalf("stderr = %q, want a hint naming the URL to open", stderr.String())
	}

	var stdoutMalformed, stderrMalformed bytes.Buffer
	launchBrowser(&stdoutMalformed, &stderrMalformed, commandline.ServerOptions{
		Port: 8000, BrowserLaunchEnabled: true, BrowserLaunchHostname: "bad host:99999", BrowserLaunchPort: -1,
	}, "default", false, true, "linux", failing)
	if !strings.Contains(stderrMalformed.String(), "Hint: check browserLaunch.hostname") {
		t.Fatalf("stderr = %q, want a hostname hint for an unparseable launch URL", stderrMalformed.String())
	}
}
