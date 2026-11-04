package main

// CLI experience layer (GOAL.md §15.5): subcommand help/version in any argument position, TTY-aware
// colour, the first-run identity + Ready block, unknown-option warnings, friendly shutdown and
// actionable error hints. The pinned option set and the pinned config-refusal block are NOT changed:
// help still renders commandline.OptionsHelp(), and reportConfigParseFailure still returns before any
// hint is printed.

import (
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"os"
	"strings"

	"github.com/cocokoishi/gotavern/internal/commandline"
	"github.com/cocokoishi/gotavern/internal/migrate"
)

// ---------------------------------------------------------------------------------------------------
// Per-subcommand usage. The top-level help keeps rendering commandline.OptionsHelp() (the pinned
// option set); these blocks only describe GoTavern's own commands.
// ---------------------------------------------------------------------------------------------------

const versionUsage = `Usage: gotavern version [--json]

Prints the GoTavern version and the pinned SillyTavern baseline. --json emits
gotavern_version, sillytavern_version and sillytavern_commit as a JSON object.
`

const assetsUsage = `Usage: gotavern assets verify

Verifies the embedded pinned asset trees (upstream/public, upstream/default and
upstream/generated) against their embedded manifests, then hashes the installed
tokenizers beside the binary against the embedded tokenizer manifest. Exits
non-zero when a tree is missing or differs, so a broken installation is named
rather than silently degraded.
`

const startUsageHeader = `Usage: gotavern [server options]
       gotavern start [server options]

Starts the GoTavern server. Server options fall back to config.yaml, which falls
back to the pinned SillyTavern defaults.

`

// helpFooter records the deliberate GoTavern deviations from pinned's CLI, where an operator can read
// them: the unknown-option warning and the --verbose opt-in have no pinned equivalent.
const helpFooter = `GoTavern additions and deliberate deviations:
  --verbose   Print internal startup stage timings to stderr (same as GOTAVERN_STARTUP_TRACE=1).
              The default boot is quiet: normal runs print no stage timings.

  An unrecognised --option is reported on stderr and otherwise ignored. Pinned SillyTavern's argument
  parser silently ignores unknown options; GoTavern keeps the same exit status and only adds the
  warning, so a typo such as --prot is visible instead of silently binding the default port.
`

// commandNames are the subcommands that accept their own --help/version.
var commandNames = []string{"start", "version", "assets", "migrate", "help"}

func isCommandName(value string) bool {
	for _, name := range commandNames {
		if value == name {
			return true
		}
	}
	return false
}

// requestedHelpTarget reports which help block a command line asks for, in any argument position.
// "help <command>" and "<command> --help" name the same block; a --help with no command names the
// top-level block.
func requestedHelpTarget(args []string) (string, bool) {
	asked := false
	for _, argument := range args {
		if argument == "-h" || argument == "--help" || argument == "help" {
			asked = true
			break
		}
	}
	if !asked {
		return "", false
	}
	// `gotavern help migrate` / `gotavern help start`
	if len(args) > 1 && args[0] == "help" && isCommandName(args[1]) {
		return args[1], true
	}
	for _, argument := range args {
		if isCommandName(argument) {
			return argument, true
		}
	}
	return "help", true
}

// versionRequestedAnywhere reports a --version request in any position. Pinned's yargs handles
// --version wherever it appears; `gotavern start --version` must print the version, not boot.
func versionRequestedAnywhere(args []string) bool {
	for _, argument := range args {
		if argument == "--version" {
			return true
		}
	}
	return false
}

// printCommandHelp writes the requested help block to stdout and returns nil (exit 0), so asking for
// help never boots a server and never fails.
func printCommandHelp(target string, stdout io.Writer) {
	switch target {
	case "version":
		fmt.Fprint(stdout, versionUsage)
	case "assets":
		fmt.Fprint(stdout, assetsUsage)
	case "migrate":
		fmt.Fprint(stdout, migrate.UsageText())
	case "start":
		fmt.Fprint(stdout, startUsageHeader)
		fmt.Fprint(stdout, commandline.OptionsHelp())
		fmt.Fprint(stdout, helpFooter)
	default:
		printUsage(stdout)
	}
}

// printVersionRequested writes the version block for a --version request in any argument position.
func printVersionRequested(args []string, stdout io.Writer) error {
	json := false
	for _, argument := range args {
		if argument == "--json" {
			json = true
		}
	}
	return printVersion(stdout, json)
}

// ---------------------------------------------------------------------------------------------------
// Unknown option warning (deliberate deviation: pinned yargs ignores unknown options silently).
// ---------------------------------------------------------------------------------------------------

// printUnknownOptionWarnings reports each unrecognised --option on stderr. It never changes the exit
// status: the warning exists so a typo is visible, not so a previously accepted invocation fails.
func printUnknownOptionWarnings(stderr io.Writer, unknown []string) {
	for _, option := range unknown {
		fmt.Fprintf(stderr, "Warning: unknown option %q is ignored; run \"gotavern --help\" for the supported options.\n", option)
	}
}

// ---------------------------------------------------------------------------------------------------
// Verbose: a --verbose flag is a GoTavern addition. It is stripped before the pinned option parser
// sees it and turns on the startup-stage trace for this boot only.
// ---------------------------------------------------------------------------------------------------

// stripVerbose removes --verbose / --verbose=true|false from the argument list and reports whether the
// trace was requested. It is a GoTavern-only flag, so it must not reach the pinned parser (where it
// would be an unknown option and produce a warning).
func stripVerbose(args []string) ([]string, bool) {
	stripped := make([]string, 0, len(args))
	verbose := false
	for _, argument := range args {
		switch argument {
		case "--verbose":
			verbose = true
		case "--verbose=true":
			verbose = true
		case "--verbose=false":
			verbose = false
		default:
			stripped = append(stripped, argument)
		}
	}
	return stripped, verbose
}

// withStartupTrace sets GOTAVERN_STARTUP_TRACE for the duration of fn when verbose was requested,
// restoring the previous value afterwards. The tracer reads the environment when app.Start builds it.
func withStartupTrace(verbose bool, fn func() error) error {
	if !verbose {
		return fn()
	}
	previous, existed := os.LookupEnv("GOTAVERN_STARTUP_TRACE")
	_ = os.Setenv("GOTAVERN_STARTUP_TRACE", "1")
	defer func() {
		if existed {
			_ = os.Setenv("GOTAVERN_STARTUP_TRACE", previous)
		} else {
			_ = os.Unsetenv("GOTAVERN_STARTUP_TRACE")
		}
	}()
	return fn()
}

// ---------------------------------------------------------------------------------------------------
// TTY-aware colour. NO_COLOR/FORCE_COLOR/TERM=dumb are honoured; a stream that is not a terminal is
// plain. No new dependency: os.File.Stat's ModeCharDevice is the cross-platform tty check.
// ---------------------------------------------------------------------------------------------------

type palette struct {
	enabled bool
}

// colorEnabled decides whether ANSI colour may be written to w.
//
// Precedence, from the conventions the task names:
//   - FORCE_COLOR set to a non-empty value that is not 0/false/no/off forces colour ON, even piped;
//   - FORCE_COLOR=0 (or false/no/off) forces colour OFF;
//   - NO_COLOR set to a non-empty value disables colour;
//   - TERM=dumb disables colour;
//   - otherwise colour is on only when w is a terminal.
func colorEnabled(w io.Writer) bool {
	force, forceSet := os.LookupEnv("FORCE_COLOR")
	noColor, noColorSet := os.LookupEnv("NO_COLOR")
	return colorPolicy(force, forceSet, noColor, noColorSet, os.Getenv("TERM"), writerIsTerminal(w))
}

// colorPolicy is the testable decision behind colorEnabled.
//
// Precedence, from the conventions the task names:
//   - FORCE_COLOR set to a non-empty value that is not 0/false/no/off forces colour ON, even piped;
//   - FORCE_COLOR=0 (or false/no/off) forces colour OFF;
//   - NO_COLOR set to a non-empty value disables colour;
//   - TERM=dumb disables colour;
//   - otherwise colour is on only when the stream is a terminal.
func colorPolicy(force string, forceSet bool, noColor string, noColorSet bool, term string, isTerminal bool) bool {
	if forceSet && force != "" {
		switch strings.ToLower(strings.TrimSpace(force)) {
		case "0", "false", "no", "off":
			return false
		default:
			return true
		}
	}
	if noColorSet && noColor != "" {
		return false
	}
	if strings.EqualFold(strings.TrimSpace(term), "dumb") {
		return false
	}
	return isTerminal
}

// writerIsTerminal reports whether w is an os.File attached to a character device (a console/tty).
// Buffers used by tests are not, which is what keeps captured output plain and comparable.
func writerIsTerminal(w io.Writer) bool {
	file, ok := w.(*os.File)
	if !ok {
		return false
	}
	info, err := file.Stat()
	if err != nil {
		return false
	}
	return info.Mode()&os.ModeCharDevice != 0
}

func newPalette(w io.Writer) palette { return palette{enabled: colorEnabled(w)} }

func (p palette) wrap(code, text string) string {
	if !p.enabled || text == "" {
		return text
	}
	return "\x1b[" + code + "m" + text + "\x1b[0m"
}

func (p palette) green(text string) string  { return p.wrap("32", text) }
func (p palette) blue(text string) string   { return p.wrap("34", text) }
func (p palette) yellow(text string) string { return p.wrap("33", text) }
func (p palette) bold(text string) string   { return p.wrap("1", text) }

// ---------------------------------------------------------------------------------------------------
// First-run identity + Ready block.
// ---------------------------------------------------------------------------------------------------

// startupIdentity is the REAL runtime state printed before the listener lines: the build identity from
// the same constants `gotavern version` prints, and the resolved paths app.Start actually used.
type startupIdentity struct {
	Version    string
	Baseline   string
	Commit     string
	InstallDir string
	ConfigFile string
	DataRoot   string
}

// printStartupIdentity writes the identity/paths block. It is deliberately independent of app so it
// can be unit-tested over injected streams; runServer fills it from RunningServer.CommandLine.Paths.
func printStartupIdentity(stdout io.Writer, p palette, identity startupIdentity) {
	fmt.Fprintf(stdout, "%s (SillyTavern %s baseline, %s)\n",
		p.bold("GoTavern "+identity.Version), identity.Baseline, identity.Commit)
	fmt.Fprintf(stdout, "Install root: %s\n", identity.InstallDir)
	fmt.Fprintf(stdout, "Config file:  %s\n", identity.ConfigFile)
	fmt.Fprintf(stdout, "Data root:    %s\n", identity.DataRoot)
}

// printReadyLine writes the explicit Ready line carrying the URL the runtime is ACTUALLY serving:
// it is derived from the bound listener addresses, not from the configured port, so it stays truthful
// when port 0 selected an ephemeral port or a configured port was overridden.
func printReadyLine(stdout io.Writer, p palette, url string) {
	fmt.Fprintf(stdout, "%s GoTavern is serving at %s\n", p.green("Ready:"), p.blue(url))
}

// serveURL derives the URL a browser on this host can open from the listener addresses. The first
// bound address wins; an unspecified bind address (0.0.0.0 / [::]) is rendered as localhost because
// the wildcard address is not a browsable target, and an ephemeral port is kept as bound.
func serveURL(addresses []net.Addr, useTLS bool) (string, error) {
	if len(addresses) == 0 {
		return "", errors.New("no bound listener address")
	}
	scheme := "http"
	if useTLS {
		scheme = "https"
	}
	raw := addresses[0].String()
	host, port, err := net.SplitHostPort(raw)
	if err != nil {
		return "", fmt.Errorf("read listener address %q: %w", raw, err)
	}
	ip := net.ParseIP(host)
	switch {
	case ip == nil:
		// A hostname (tests, or a future listener type): keep it.
	case ip.IsUnspecified():
		host = "localhost"
	case ip.To4() == nil:
		host = "[" + host + "]"
	}
	return scheme + "://" + host + ":" + port + "/", nil
}

// ---------------------------------------------------------------------------------------------------
// Actionable error hints. Each hint names the cause AND the next step. The pinned config-refusal block
// is handled earlier in main and never receives a hint (reportConfigParseFailure returns first).
// ---------------------------------------------------------------------------------------------------

func errorHint(err error) string {
	if err == nil {
		return ""
	}
	message := strings.ToLower(err.Error())
	switch {
	case strings.Contains(message, "already in use"):
		return "another process is listening on that port; stop it or choose a different port with --port <n>."
	case errors.Is(err, fs.ErrPermission) || strings.Contains(message, "permission denied") || strings.Contains(message, "access is denied"):
		return "the directory or file is not writable; check its ownership and permissions, or pass --dataRoot <dir>."
	case strings.Contains(message, "tokenizers are missing"):
		return "reinstall the release so src/tokenizers/ sits beside the binary, then run \"gotavern assets verify\"."
	case strings.Contains(message, "ssl certificate path does not exist") ||
		strings.Contains(message, "ssl key path does not exist") ||
		strings.Contains(message, "load ssl certificate") ||
		strings.Contains(message, "decrypt ssl private key"):
		return "check ssl.certPath and ssl.keyPath in config.yaml (or --certPath/--keyPath): both files must exist and be readable."
	case strings.Contains(message, "corrupt") ||
		strings.Contains(message, "invalid json") ||
		strings.Contains(message, "unexpected end of json") ||
		strings.Contains(message, "cannot unmarshal"):
		return "a data file could not be decoded; restore it from backups/ (or move it aside) and retry."
	case strings.Contains(message, "failed to start server") || strings.Contains(message, "http listener failed"):
		return "check the listen/protocol settings and that the address is available (--listen, --port, --listenAddressIPv4/IPv6)."
	}
	return ""
}

// printErrorHint writes the hint for err to stderr, when there is one.
func printErrorHint(stderr io.Writer, err error) {
	if hint := errorHint(err); hint != "" {
		fmt.Fprintf(stderr, "Hint: %s\n", hint)
	}
}

// ---------------------------------------------------------------------------------------------------
// Shutdown messages and the forced-shutdown sentinel.
// ---------------------------------------------------------------------------------------------------

// forcedShutdown is returned when a second Ctrl+C aborts the drain. It carries the conventional 130
// exit status (128+SIGINT) and is not printed as a "gotavern:" error: the user asked for it.
type forcedShutdown struct {
	Signal string
}

func (forced forcedShutdown) Error() string { return "forced shutdown after " + forced.Signal }
func (forced forcedShutdown) ExitCode() int { return 130 }

// shutdownNotice is the friendly first-signal line. The existing prefix is kept so an operator (or a
// grep) that watched the previous message still sees "Shutting down".
func shutdownNotice(signal fmt.Stringer) string {
	return fmt.Sprintf("Shutting down after %s (Ctrl+C again to force)", signal)
}
