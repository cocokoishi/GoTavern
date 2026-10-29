package commandline

import (
	"fmt"
	"strings"
)

// This file generates the option half of `gotavern --help` from the SAME table
// the parser uses, so an option can no longer exist without being documented.
//
// PINNED SOURCE (read, not remembered): src/command-line.js:110-267 declares 31
// `.option(...)` blocks inside a yargs chain, each with a `describe` string;
// yargs enables its `help` built-in unconditionally, so pinned's help and every
// one of those descriptions reach STDOUT with exit 0.
//
// THE LAYOUT IS A DERIVATION, THE CONTENT IS NOT. The option set, the per-option
// type and every description below are transcribed from the pinned source, and
// the test compares the generated text against those transcriptions. The column
// alignment is GoTavern's own rendering: yargs' formatter wraps at the terminal
// width, so a byte-exact copy of its layout is neither stable across
// environments nor the observable a user depends on. What a user depends on --
// every option being discoverable, on stdout, with pinned's own words -- is
// asserted exactly.

// cliOptionOrder is pinned's declaration order (src/command-line.js:112-266).
// The help is rendered in this order, and a test fails if this list and
// cliOptionKinds ever disagree in either direction -- so an option added to the
// parser cannot silently stay undocumented.
var cliOptionOrder = []string{
	"global",
	"configPath",
	"enableIPv6",
	"enableIPv4",
	"port",
	"dnsPreferIPv6",
	"browserLaunchEnabled",
	"browserLaunchHostname",
	"browserLaunchPort",
	"browserLaunchAvoidLocalhost",
	"listen",
	"listenAddressIPv6",
	"listenAddressIPv4",
	"corsProxy",
	"disableCsrf",
	"ssl",
	"certPath",
	"keyPath",
	"keyPassphrase",
	"whitelist",
	"dataRoot",
	"basicAuthMode",
	"enableKeepAlive",
	"requestProxyEnabled",
	"requestProxyUrl",
	"requestProxyBypass",
	"heartbeatInterval",
	"autorun",
	"autorunHostname",
	"autorunPortOverride",
	"avoidLocalhost",
}

// cliOptionDescriptions is the `describe` text of every option, transcribed
// from src/command-line.js:112-266. The embedded newlines are pinned's own
// (e.g. dnsPreferIPv6 at :140 and browserLaunchHostname at :150), so they are
// kept rather than flattened.
var cliOptionDescriptions = map[string]string{
	"global":                      "Use global data and config paths instead of the server directory",
	"configPath":                  "Path to the config file (only for standalone mode)",
	"enableIPv6":                  "Enables IPv6 protocol",
	"enableIPv4":                  "Enables IPv4 protocol",
	"port":                        "Sets the server listening port",
	"dnsPreferIPv6":               "Prefers IPv6 for DNS\nYou should probably have the enabled if you're on an IPv6 only network",
	"browserLaunchEnabled":        "Automatically launch SillyTavern in the browser",
	"browserLaunchHostname":       "Sets the browser launch hostname, best left on 'auto'.\nUse values like 'localhost', 'st.example.com'",
	"browserLaunchPort":           "Overrides the port for browser launch with open your browser with this port and ignore what port the server is running on. -1 is use server port",
	"browserLaunchAvoidLocalhost": "Avoids using 'localhost' for browser launch in auto mode.\nUse if you don't have 'localhost' in your hosts file",
	"listen":                      "Whether to listen on all network interfaces",
	"listenAddressIPv6":           "Specific IPv6 address to listen to",
	"listenAddressIPv4":           "Specific IPv4 address to listen to",
	"corsProxy":                   "Enables CORS proxy",
	"disableCsrf":                 "Disables CSRF protection - NOT RECOMMENDED",
	"ssl":                         "Enables SSL",
	"certPath":                    "Path to SSL certificate file",
	"keyPath":                     "Path to SSL private key file",
	"keyPassphrase":               "Passphrase for the SSL private key",
	"whitelist":                   "Enables whitelist mode",
	"dataRoot":                    "Root directory for data storage (only for standalone mode)",
	"basicAuthMode":               "Enables basic authentication",
	"enableKeepAlive":             "Enable HTTP/HTTPS keep-alive globally",
	"requestProxyEnabled":         "Enables a use of proxy for outgoing requests",
	"requestProxyUrl":             "Request proxy URL (HTTP or SOCKS protocols)",
	"requestProxyBypass":          "Request proxy bypass list (space separated list of hosts)",
	"heartbeatInterval":           "Interval in seconds to write a heartbeat file. 0 to disable.",
	"autorun":                     `DEPRECATED: Use "browserLaunchEnabled" instead.`,
	"autorunHostname":             `DEPRECATED: Use "browserLaunchHostname" instead.`,
	"autorunPortOverride":         `DEPRECATED: Use "browserLaunchPort" instead.`,
	"avoidLocalhost":              `DEPRECATED: Use "browserLaunchAvoidLocalhost" instead.`,
}

// cliOptionTypeNames are yargs' type names for the four kinds the parser knows.
var cliOptionTypeNames = map[cliOptionKind]string{
	cliBoolean: "boolean",
	cliString:  "string",
	cliNumber:  "number",
	cliArray:   "array",
}

// OptionNames returns the option names in pinned's declaration order. It is
// exported for the CLI help test, which asserts that every one of them appears
// in the output a user sees.
func OptionNames() []string {
	return append([]string(nil), cliOptionOrder...)
}

// OptionsHelp renders the pinned option set, one line per option, with the
// pinned description and type. It is deterministic: the order is pinned's
// declaration order and the column width comes from the longest option name.
func OptionsHelp() string {
	maxName := 0
	for _, name := range cliOptionOrder {
		if len(name) > maxName {
			maxName = len(name)
		}
	}
	// The description column: two leading spaces, "--", the longest option name,
	// and two separating spaces.
	indent := strings.Repeat(" ", 2+2+maxName+2)
	var builder strings.Builder
	builder.WriteString("Options that are not provided will be filled with config values.\n\n")
	builder.WriteString("Options:\n")
	for _, name := range cliOptionOrder {
		lines := strings.Split(cliOptionDescriptions[name], "\n")
		fmt.Fprintf(&builder, "  --%s%s%s  [%s]\n", name, strings.Repeat(" ", maxName-len(name)+2), lines[0], cliOptionTypeNames[cliOptionKinds[name]])
		for _, continuation := range lines[1:] {
			builder.WriteString(indent)
			builder.WriteString(continuation)
			builder.WriteString("\n")
		}
	}
	return builder.String()
}
