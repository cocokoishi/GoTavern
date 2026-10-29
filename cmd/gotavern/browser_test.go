package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
	"unicode/utf16"

	"github.com/cocokoishi/gotavern/internal/app"
	"github.com/cocokoishi/gotavern/internal/commandline"
)

// recordedInvocation is one opener call as the injected opener saw it.
type recordedInvocation struct {
	name string
	args []string
}

type recordingOpener struct {
	invocations []recordedInvocation
	err         error
}

func (recorder *recordingOpener) open(name string, args ...string) error {
	recorder.invocations = append(recorder.invocations, recordedInvocation{name: name, args: append([]string(nil), args...)})
	return recorder.err
}

// pinnedCommandLineOracle is the subset of
// tests/oracle/sillytavern-1.19.0-commandline-paths.json this test needs: the
// options the pinned parser resolved, the protocol availability the pinned
// listener probe observed, and the launch URL pinned itself constructed. The
// expected URL therefore comes from a pinned capture, not from this test's own
// reading of the URL rules.
type pinnedCommandLineOracle struct {
	Baseline struct {
		Version string `json:"version"`
		Commit  string `json:"commit"`
	} `json:"baseline"`
	Scenarios map[string]struct {
		UseIPv4 bool `json:"useIPv4"`
		UseIPv6 bool `json:"useIPv6"`
		Result  struct {
			Options     commandline.ServerOptions `json:"options"`
			DerivedURLs struct {
				BrowserLaunchURL struct {
					Href string `json:"href"`
				} `json:"browserLaunchUrl"`
			} `json:"derivedURLs"`
		} `json:"result"`
	} `json:"scenarios"`
}

func readPinnedCommandLineOracle(t *testing.T) pinnedCommandLineOracle {
	t.Helper()
	body, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-commandline-paths.json"))
	if err != nil {
		t.Fatal(err)
	}
	var oracle pinnedCommandLineOracle
	if err := json.Unmarshal(body, &oracle); err != nil {
		t.Fatal(err)
	}
	if oracle.Baseline.Commit != "06bde939fb1e9c4c8d8641d810f0a916b5bce127" {
		t.Fatalf("command-line oracle baseline = %+v", oracle.Baseline)
	}
	return oracle
}

// TestBrowserLaunchUsesThePinnedResolvedURLForEveryProtocolCombination locks the
// launch target to the pinned capture for the four protocol/host combinations,
// and to the pinned source for the one combination the capture does not cover.
//
// The expectation is the fixture's own derivedURLs.browserLaunchUrl.href, which
// internal/commandline/paths_test.go already compares field-by-field against
// Node; this test then asserts that the browser launch hands THAT URL to the
// opener. The opener is injected, so no browser is started.
func TestBrowserLaunchUsesThePinnedResolvedURLForEveryProtocolCombination(t *testing.T) {
	oracle := readPinnedCommandLineOracle(t)

	cases := []struct {
		name     string
		scenario string
		useIPv6  bool
		useIPv4  bool
		// sourceDerived marks a row whose expected URL has no recorded capture,
		// because the fixture has no scenario for that combination. It is
		// derived from the pinned source and labelled rather than dressed up:
		// src/command-line.js:349-351 returns '[::1]' for an IPv6-only listener
		// and :360-368 builds '<scheme>://<hostname>:<port>'.
		sourceDerived bool
		expectedURL   string
	}{
		{name: "ipv4-only", scenario: "standalone-default", useIPv6: false, useIPv4: true},
		{name: "dual-protocol-localhost", scenario: "listen-mode-derived-urls", useIPv6: true, useIPv4: true},
		{name: "dual-protocol-avoid-localhost", scenario: "browser-launch-auto-dual-protocol", useIPv6: true, useIPv4: true},
		{name: "ipv6-only", useIPv6: true, useIPv4: false, sourceDerived: true, expectedURL: "http://[::1]:8000/"},
		{name: "no-detected-protocol", scenario: "browser-launch-auto-no-detected-protocol", useIPv6: false, useIPv4: false},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			options := commandline.ServerOptions{
				Port: 8000, BrowserLaunchEnabled: true, BrowserLaunchHostname: "auto",
				BrowserLaunchPort: -1, BrowserLaunchAvoidLocalhost: false,
			}
			expected := testCase.expectedURL
			if !testCase.sourceDerived {
				scenario, found := oracle.Scenarios[testCase.scenario]
				if !found {
					t.Fatalf("oracle scenario %q is missing from the pinned fixture", testCase.scenario)
				}
				if scenario.UseIPv4 != testCase.useIPv4 || scenario.UseIPv6 != testCase.useIPv6 {
					t.Fatalf("oracle scenario %q records protocols IPv4=%t IPv6=%t, test row declares IPv4=%t IPv6=%t",
						testCase.scenario, scenario.UseIPv4, scenario.UseIPv6, testCase.useIPv4, testCase.useIPv6)
				}
				options = scenario.Result.Options
				expected = scenario.Result.DerivedURLs.BrowserLaunchURL.Href
				if expected == "" {
					t.Fatalf("oracle scenario %q recorded no browser launch URL", testCase.scenario)
				}
			}
			if !jsTruthy(options.BrowserLaunchEnabled) {
				t.Fatalf("oracle scenario %q resolved browserLaunchEnabled=%v; the launch gate would be off", testCase.scenario, options.BrowserLaunchEnabled)
			}

			opener := &recordingOpener{}
			var stdout, stderr bytes.Buffer
			launchBrowser(&stdout, &stderr, options, "default", testCase.useIPv6, testCase.useIPv4, "linux", opener.open)

			if len(opener.invocations) != 1 {
				t.Fatalf("opener invocations = %+v, want exactly one", opener.invocations)
			}
			invocation := opener.invocations[0]
			if invocation.name != "xdg-open" {
				t.Errorf("opener command = %q, want xdg-open for the default application", invocation.name)
			}
			if len(invocation.args) != 1 || invocation.args[0] != expected {
				t.Errorf("opener target = %#v, want the pinned launch URL %q", invocation.args, expected)
			}
			if got := stdout.String(); got != "Launching in a browser: default...\n" {
				t.Errorf("stdout = %q, want the pinned launch line", got)
			}
			if stderr.Len() != 0 {
				t.Errorf("stderr = %q, want empty on a successful launch", stderr.String())
			}
		})
	}
}

// TestBrowserLaunchIsSilentWhenDisabled: `browserLaunch.enabled: false` must
// produce ZERO opener invocations (pinned gates the whole block at
// src/server-main.js:367).
func TestBrowserLaunchIsSilentWhenDisabled(t *testing.T) {
	opener := &recordingOpener{}
	var stdout, stderr bytes.Buffer
	launchBrowser(&stdout, &stderr, commandline.ServerOptions{
		Port: 8000, BrowserLaunchEnabled: false, BrowserLaunchHostname: "auto", BrowserLaunchPort: -1,
	}, "default", false, true, "linux", opener.open)

	if len(opener.invocations) != 0 {
		t.Fatalf("opener invocations = %+v, want none when browserLaunch.enabled is false", opener.invocations)
	}
	if stdout.Len() != 0 || stderr.Len() != 0 {
		t.Errorf("stdout=%q stderr=%q, want no output when the launch is disabled", stdout.String(), stderr.String())
	}
}

// TestBrowserLaunchFailureIsNonFatalAndPrintsPinnedMessage: a failing opener
// keeps the process alive and prints pinned's message
// (src/server-main.js:392-394).
func TestBrowserLaunchFailureIsNonFatalAndPrintsPinnedMessage(t *testing.T) {
	opener := &recordingOpener{err: errors.New("exec: \"xdg-open\": executable file not found in $PATH")}
	var stdout, stderr bytes.Buffer
	launchBrowser(&stdout, &stderr, commandline.ServerOptions{
		Port: 8000, BrowserLaunchEnabled: true, BrowserLaunchHostname: "auto", BrowserLaunchPort: -1,
	}, "default", false, true, "linux", opener.open)

	if len(opener.invocations) != 1 {
		t.Fatalf("opener invocations = %+v, want the one attempted launch", opener.invocations)
	}
	if got := stdout.String(); got != "Launching in a browser: default...\n" {
		t.Errorf("stdout = %q, want the pinned launch line printed before the attempt", got)
	}
	if !strings.Contains(stderr.String(), "Failed to launch the browser. Open the URL manually.") {
		t.Errorf("stderr = %q, want pinned's manual-open message", stderr.String())
	}
	if !strings.Contains(stderr.String(), "executable file not found") {
		t.Errorf("stderr = %q, want the causal opener error named", stderr.String())
	}
}

// TestBrowserLaunchInvocationPerOperatingSystem locks the per-OS opener table to
// the pinned `open` package's own commands (node_modules/open/index.js:147-233,
// :324-360), including the named-application set of src/server-main.js:373-384.
func TestBrowserLaunchInvocationPerOperatingSystem(t *testing.T) {
	const target = "http://127.0.0.1:8000/"

	cases := []struct {
		name          string
		goos          string
		app           string
		expectedNames []string
		expectedArgs  [][]string
	}{
		{
			name: "darwin default", goos: "darwin", app: "default",
			expectedNames: []string{"open"},
			expectedArgs:  [][]string{{target}},
		},
		{
			name: "darwin chrome", goos: "darwin", app: "chrome",
			expectedNames: []string{"open"},
			expectedArgs:  [][]string{{"-a", "google chrome", target}},
		},
		{
			name: "darwin firefox with surrounding whitespace and case", goos: "darwin", app: "  FireFox ",
			expectedNames: []string{"open"},
			expectedArgs:  [][]string{{"-a", "firefox", target}},
		},
		{
			name: "linux default", goos: "linux", app: "default",
			expectedNames: []string{"xdg-open"},
			expectedArgs:  [][]string{{target}},
		},
		{
			name: "linux chrome tries pinned candidates in order", goos: "linux", app: "chrome",
			expectedNames: []string{"google-chrome", "google-chrome-stable", "chromium"},
			expectedArgs:  [][]string{{target}, {target}, {target}},
		},
		{
			name: "linux edge", goos: "linux", app: "edge",
			expectedNames: []string{"microsoft-edge", "microsoft-edge-dev"},
			expectedArgs:  [][]string{{target}, {target}},
		},
		{
			name: "unknown application falls back to the default opener", goos: "linux", app: "netscape",
			expectedNames: []string{"xdg-open"},
			expectedArgs:  [][]string{{target}},
		},
		{
			name: "android has no named applications", goos: "android", app: "chrome",
			expectedNames: []string{"xdg-open"},
			expectedArgs:  [][]string{{target}},
		},
		{
			name: "windows default", goos: "windows", app: "default",
			expectedNames: []string{"powershell.exe"},
			expectedArgs:  [][]string{{"-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodePowerShellCommand("Start " + powerShellLiteral(target))}},
		},
		{
			name: "windows edge", goos: "windows", app: "edge",
			expectedNames: []string{"powershell.exe"},
			expectedArgs:  [][]string{{"-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodePowerShellCommand("Start " + powerShellLiteral("msedge") + " " + powerShellLiteral(target))}},
		},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			invocations := browserInvocations(testCase.goos, testCase.app, target)
			if len(invocations) != len(testCase.expectedNames) {
				t.Fatalf("invocations = %+v, want %d", invocations, len(testCase.expectedNames))
			}
			for index, invocation := range invocations {
				if invocation.name != testCase.expectedNames[index] {
					t.Errorf("invocation %d command = %q, want %q", index, invocation.name, testCase.expectedNames[index])
				}
				if fmt.Sprint(invocation.args) != fmt.Sprint(testCase.expectedArgs[index]) {
					t.Errorf("invocation %d args = %#v, want %#v", index, invocation.args, testCase.expectedArgs[index])
				}
			}
		})
	}
}

// TestBrowserLaunchOpenerIsAnArgumentVectorNotAShellString is the injection
// test: a launch URL carrying PowerShell/CMD metacharacters must arrive as ONE
// inert argv element, and the encoded script must keep it inside a single-quoted
// literal.
func TestBrowserLaunchOpenerIsAnArgumentVectorNotAShellString(t *testing.T) {
	hostile := "http://127.0.0.1:8000/'; Start-Process calc; '"
	invocations := browserInvocations("windows", "default", hostile)
	if len(invocations) != 1 {
		t.Fatalf("invocations = %+v, want one", invocations)
	}
	encoded := invocations[0].args[len(invocations[0].args)-1]
	script, err := decodePowerShellCommand(encoded)
	if err != nil {
		t.Fatalf("decode -EncodedCommand argument: %v", err)
	}
	// The only escaping that can happen is the single quote being doubled, so the
	// payload cannot close the literal and start a new statement.
	want := "Start '" + strings.ReplaceAll(hostile, "'", "''") + "'"
	if script != want {
		t.Errorf("decoded script = %q, want %q", script, want)
	}
	if quotes := strings.Count(script, "'"); quotes != 2+2*strings.Count(hostile, "'") {
		t.Errorf("decoded script carries %d quotes, want every one of the target's %d doubled plus the two delimiters", quotes, strings.Count(hostile, "'"))
	}
	// Undo PowerShell's single-quote escaping and read the literal back: it must be
	// the URL, payload and all, so the payload never became a second statement.
	literal := strings.TrimSuffix(strings.TrimPrefix(script, "Start '"), "'")
	if got := strings.ReplaceAll(literal, "''", "'"); got != hostile {
		t.Errorf("the PowerShell literal decodes to %q, want the URL %q", got, hostile)
	}
}

func decodePowerShellCommand(encoded string) (string, error) {
	raw, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return "", err
	}
	if len(raw)%2 != 0 {
		return "", fmt.Errorf("encoded command is not UTF-16LE")
	}
	units := make([]uint16, 0, len(raw)/2)
	for index := 0; index < len(raw); index += 2 {
		units = append(units, uint16(raw[index])|uint16(raw[index+1])<<8)
	}
	return string(utf16.Decode(units)), nil
}

// TestBrowserLaunchFailureLeavesTheServerServing is the "still serving" half of
// the requirement, measured rather than argued: a real server is booted, the
// launch fails, and the listener still answers afterwards.
func TestBrowserLaunchFailureLeavesTheServerServing(t *testing.T) {
	installRoot := t.TempDir()
	running, err := app.Start(app.StartOptions{
		Args: []string{
			"--enableIPv4", "true", "--enableIPv6", "false", "--listen", "false",
			"--port", "0", "--heartbeatInterval", "0", "--browserLaunchEnabled", "true",
		},
		WorkingDirectory:         installRoot,
		InstallRoot:              installRoot,
		WaitBeforeLegacyDataMove: func(time.Duration) {},
		InterfaceAddresses:       []net.Addr{},
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = running.Close(ctx)
	})
	if len(running.Listeners()) == 0 {
		t.Fatal("server started no listener")
	}

	opener := &recordingOpener{err: errors.New("no opener on this host")}
	var stdout, stderr bytes.Buffer
	launchBrowser(&stdout, &stderr, running.CommandLine.Options, running.CommandLine.BrowserLaunchApp, running.Protocols.UseIPv6, running.Protocols.UseIPv4, "linux", opener.open)
	if len(opener.invocations) != 1 {
		t.Fatalf("opener invocations = %+v, want the one attempted launch", opener.invocations)
	}
	if !strings.Contains(stderr.String(), "Failed to launch the browser. Open the URL manually.") {
		t.Fatalf("stderr = %q, want pinned's manual-open message", stderr.String())
	}

	client := &http.Client{Transport: &http.Transport{Proxy: nil}, Timeout: 10 * time.Second}
	response, err := client.Get("http://" + running.Listeners()[0].Addr().String() + "/version")
	if err != nil {
		t.Fatalf("server stopped serving after a failed browser launch: %v", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("GET /version after a failed launch = %d, want 200", response.StatusCode)
	}
}

// TestBrowserLaunchAppIsReadFromTheConfig pins the app label resolution against
// the pinned expression `String(getConfigValue('browserLaunch.browser',
// 'default') ?? empty)` (src/server-main.js:365), including the null case that
// the nullish fallback -- not a stringification -- decides.
func TestBrowserLaunchAppIsReadFromTheConfig(t *testing.T) {
	cases := []struct {
		name     string
		config   string
		expected string
	}{
		{name: "fresh install value", config: "browserLaunch:\n  browser: 'default'\n", expected: "default"},
		{name: "missing key uses the default", config: "browserLaunch:\n  enabled: true\n", expected: "default"},
		{name: "explicit null falls back to the empty string", config: "browserLaunch:\n  browser: null\n", expected: ""},
		{name: "named application is kept verbatim", config: "browserLaunch:\n  browser: 'chrome'\n", expected: "chrome"},
		{name: "non-string value is stringified", config: "browserLaunch:\n  browser: true\n", expected: "true"},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			installRoot := t.TempDir()
			configPath := filepath.Join(installRoot, "config.yaml")
			if err := os.WriteFile(configPath, []byte(testCase.config), 0o600); err != nil {
				t.Fatal(err)
			}
			result, err := commandline.ResolveCommandLine(commandline.ResolveOptions{
				Args:             []string{"--configPath", configPath, "--dataRoot", filepath.Join(installRoot, "data")},
				WorkingDirectory: installRoot,
				ServerDirectory:  installRoot,
			})
			if err != nil {
				t.Fatal(err)
			}
			if result.BrowserLaunchApp != testCase.expected {
				t.Errorf("BrowserLaunchApp = %q, want %q", result.BrowserLaunchApp, testCase.expected)
			}
		})
	}
}

// TestBrowserLaunchURLFailureIsReportedNotPanicked covers the one path pinned
// does not have: a launch hostname that cannot form a URL. pinned's
// `getBrowserLaunchUrl` would throw; GoTavern reports the manual-open message
// and keeps serving, and it must not call the opener with a broken target.
func TestBrowserLaunchURLFailureIsReportedNotPanicked(t *testing.T) {
	opener := &recordingOpener{}
	var stdout, stderr bytes.Buffer
	launchBrowser(&stdout, &stderr, commandline.ServerOptions{
		Port: 8000, BrowserLaunchEnabled: true, BrowserLaunchHostname: "not a host", BrowserLaunchPort: -1,
	}, "default", false, true, "linux", opener.open)

	if len(opener.invocations) != 0 {
		t.Fatalf("opener invocations = %+v, want none for an unparseable launch URL", opener.invocations)
	}
	if !strings.Contains(stderr.String(), "Failed to launch the browser. Open the URL manually.") {
		t.Errorf("stderr = %q, want pinned's manual-open message", stderr.String())
	}
	if !strings.Contains(stderr.String(), "Invalid URL") {
		t.Errorf("stderr = %q, want the causal URL error", stderr.String())
	}
}
