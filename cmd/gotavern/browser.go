package main

import (
	"encoding/base64"
	"fmt"
	"io"
	"os/exec"
	"strings"
	"unicode/utf16"

	"github.com/cocokoishi/gotavern/internal/commandline"
)

// This file implements the post-listener browser launch of the pinned server,
// which GoTavern previously declined to perform.
//
// PINNED SOURCE (read, not remembered):
//   - default/config.yaml:20-38 -- `browserLaunch.enabled: true` (:22) and
//     `browserLaunch.browser: 'default'` (:27). Because GoTavern ships the same
//     fresh config, `browserLaunch.enabled` already resolves true for a fresh
//     install, so this path is the DEFAULT path and not an opt-in.
//   - src/server-main.js:362-395 -- postSetupTasks reads
//     `browserLaunch.browser` (:365), logs `Launching in a browser: <app>...`
//     (:390) and awaits the opener (:391), and catches a launch failure
//     NON-FATALLY (:392-394) with `Failed to launch the browser. Open the URL
//     manually.`
//   - src/server-main.js:373-384 -- the ONLY named applications pinned accepts
//     are firefox, chrome, edge and brave, matched after
//     `browserLaunchApp.trim().toLowerCase()`; anything else (including the
//     fresh-install value 'default') falls through to the OS default opener.
//   - node_modules/open/index.js (the module server-main imports at :370) --
//     darwin `open [-a <app>] <target>` (:147-164), win32 PowerShell
//     `Start "<app>" "<target>"` through an ENCODED COMMAND (:165-203), and
//     linux `<app> <target>` or `xdg-open <target>` (:204-233), with an array of
//     candidate commands tried in order (:57-69, :324-360).
//
// DIVERGENCE THAT IS DELIBERATE (rule 18 has no bearing here: this is a
// hardening the task mandates): pinned interpolates the target URL into a
// PowerShell command string with DOUBLE quotes (open/index.js:189-195), so a
// configured `browserLaunch.hostname` carrying a quote could break out of the
// literal. This implementation builds the same script out of PowerShell
// SINGLE-quoted literals -- where the quote is the only character that can end
// the literal and is escaped by doubling -- and then base64-encodes it into an
// argument vector. There is no shell string concatenation anywhere on this
// path, and no argv element is ever re-parsed by a shell.

// browserOpener runs one platform opener with an argument vector. It is the
// seam a test uses to observe the launch without starting a real browser.
type browserOpener func(name string, args ...string) error

// execBrowserOpener is the production opener. It uses os/exec with an argument
// vector, never a shell: the URL is a single argv element that no shell parses.
func execBrowserOpener(name string, args ...string) error {
	command := exec.Command(name, args...)
	// A nil Stdout/Stderr sends the child's output to the null device, which is
	// what pinned's `open` does for the detached linux path (open/index.js:230).
	if err := command.Start(); err != nil {
		return err
	}
	// Reap the child so a short-lived opener does not stay a zombie for the
	// lifetime of a long-running server. `open` detaches and unrefs instead
	// (open/index.js:261); Go has no unref, and waiting is the equivalent.
	go func() {
		_ = command.Wait()
	}()
	return nil
}

// browserInvocation is one opener command line, as an argument vector.
type browserInvocation struct {
	name string
	args []string
}

// browserApplication is the per-OS command pinned's `open` package uses for one
// of the four named applications (node_modules/open/index.js:324-360).
type browserApplication struct {
	darwin  string
	windows string
	linux   []string
}

// pinnedBrowserApplications is the exact set of named applications pinned
// accepts, with open/index.js's per-OS command for each. The linux entries are
// the candidate lists that `pTryEach` tries in order (open/index.js:57-69).
var pinnedBrowserApplications = map[string]browserApplication{
	"chrome":  {darwin: "google chrome", windows: "chrome", linux: []string{"google-chrome", "google-chrome-stable", "chromium"}},
	"brave":   {darwin: "brave browser", windows: "brave", linux: []string{"brave-browser", "brave"}},
	"firefox": {darwin: "firefox", windows: `C:\Program Files\Mozilla Firefox\firefox.exe`, linux: []string{"firefox"}},
	"edge":    {darwin: "microsoft edge", windows: "msedge", linux: []string{"microsoft-edge", "microsoft-edge-dev"}},
}

// browserInvocations returns the ordered opener command lines for one launch.
// An empty or unknown app name selects the OS default, which is pinned's
// behaviour for anything outside the four names above -- including the
// fresh-install 'default'.
func browserInvocations(goos, app, target string) []browserInvocation {
	application, known := pinnedBrowserApplications[strings.ToLower(strings.TrimSpace(app))]
	// pinned's getBrowsers() returns {} on Android (src/server-main.js:374-377),
	// so no named application exists there and the default opener is used.
	if goos == "android" {
		known = false
	}
	switch goos {
	case "darwin":
		if !known {
			return []browserInvocation{{name: "open", args: []string{target}}}
		}
		return []browserInvocation{{name: "open", args: []string{"-a", application.darwin, target}}}
	case "windows":
		if !known {
			return []browserInvocation{windowsStartInvocation("", target)}
		}
		return []browserInvocation{windowsStartInvocation(application.windows, target)}
	default:
		if !known {
			return []browserInvocation{{name: "xdg-open", args: []string{target}}}
		}
		invocations := make([]browserInvocation, 0, len(application.linux))
		for _, candidate := range application.linux {
			invocations = append(invocations, browserInvocation{name: candidate, args: []string{target}})
		}
		return invocations
	}
}

// windowsStartInvocation builds pinned's win32 opener: PowerShell's `Start`,
// passed as a base64-encoded command (open/index.js:165-203).
func windowsStartInvocation(app, target string) browserInvocation {
	script := "Start " + powerShellLiteral(target)
	if app != "" {
		script = "Start " + powerShellLiteral(app) + " " + powerShellLiteral(target)
	}
	return browserInvocation{
		name: "powershell.exe",
		args: []string{"-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodePowerShellCommand(script)},
	}
}

// powerShellLiteral renders a value as a PowerShell single-quoted string.
// Single-quoted strings have no escape sequences in PowerShell, so the only
// character that can terminate one is the single quote itself, which is escaped
// by doubling it. A URL carrying `"`, `$`, backtick or `;` therefore stays inert
// text inside the literal.
func powerShellLiteral(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "''") + "'"
}

// encodePowerShellCommand base64-encodes a script as UTF-16LE, the encoding
// PowerShell's -EncodedCommand expects (open/index.js:203 does the same).
func encodePowerShellCommand(script string) string {
	units := utf16.Encode([]rune(script))
	encoded := make([]byte, 0, len(units)*2)
	for _, unit := range units {
		encoded = append(encoded, byte(unit), byte(unit>>8))
	}
	return base64.StdEncoding.EncodeToString(encoded)
}

// resolveBrowserLaunchTarget returns the URL pinned hands to the opener. It
// reuses the oracle-tested command-line URL derivation rather than re-deriving
// it: internal/commandline/urls.go is compared against the pinned capture for
// every protocol/host combination in
// tests/oracle/sillytavern-1.19.0-commandline-paths.json.
func resolveBrowserLaunchTarget(options commandline.ServerOptions, useIPv6, useIPv4 bool) (string, error) {
	hostname := options.ResolveBrowserLaunchHostname(useIPv6, useIPv4)
	return options.BrowserLaunchURL(hostname)
}

// launchBrowser performs pinned's postSetupTasks browser launch
// (src/server-main.js:362-395). It never returns an error and never stops the
// server: a failed launch prints pinned's manual-open message and the server
// keeps serving, which is pinned's own non-fatal catch.
func launchBrowser(stdout, stderr io.Writer, options commandline.ServerOptions, app string, useIPv6, useIPv4 bool, goos string, opener browserOpener) {
	if !jsTruthy(options.BrowserLaunchEnabled) {
		return
	}
	target, err := resolveBrowserLaunchTarget(options, useIPv6, useIPv4)
	if err != nil {
		// DELIBERATE DEVIATION, with the pinned behaviour named: pinned builds the URL at
		// src/server-main.js:363-364 BEFORE the enabled gate and its `.then(postSetupTasks)` at :490
		// has no catch, so an unparseable `browserLaunch.hostname` is an unhandled rejection that
		// terminates the pinned process -- even with browser launching disabled. GoTavern must not die
		// on a config value (rules 24 and 31), so it reports the causal error and keeps serving. The
		// pinned launch line is still printed first, because pinned logs the app name before awaiting
		// the opener, so a failed launch still names the app.
		fmt.Fprintf(stdout, "Launching in a browser: %s...\n", app)
		fmt.Fprintf(stderr, "Failed to launch the browser. Open the URL manually. %v\n", err)
		return
	}
	fmt.Fprintf(stdout, "Launching in a browser: %s...\n", app)
	var launchErr error
	for _, invocation := range browserInvocations(goos, app, target) {
		if launchErr = opener(invocation.name, invocation.args...); launchErr == nil {
			return
		}
	}
	fmt.Fprintf(stderr, "Failed to launch the browser. Open the URL manually. %v\n", launchErr)
}

// jsTruthy is JavaScript's truthiness for the generic values ServerOptions
// carries. pinned gates the launch with `if (cliArgs.browserLaunchEnabled)`.
func jsTruthy(value any) bool {
	switch typed := value.(type) {
	case nil:
		return false
	case bool:
		return typed
	case string:
		return typed != ""
	case int:
		return typed != 0
	case int64:
		return typed != 0
	case float64:
		return typed != 0
	default:
		return true
	}
}
