package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"

	"github.com/cocokoishi/gotavern/internal/app"
	"github.com/cocokoishi/gotavern/internal/assetmanifest"
	"github.com/cocokoishi/gotavern/internal/commandline"
	"github.com/cocokoishi/gotavern/internal/configinit"
	"github.com/cocokoishi/gotavern/internal/migrate"
	"github.com/cocokoishi/gotavern/internal/startup"
	"github.com/cocokoishi/gotavern/upstream"
)

var version = "0.0.0-dev"

type buildInfo struct {
	GoTavernVersion    string `json:"gotavern_version"`
	SillyTavernVersion string `json:"sillytavern_version"`
	SillyTavernCommit  string `json:"sillytavern_commit"`
}

func main() {
	if err := run(os.Args[1:]); err != nil {
		// A CONFIG THAT PINNED REFUSES PRINTS PINNED'S LINES AND EXITS 1, not a GoTavern-prefixed error and
		// exit 2. The recorded pinned boot (tests/oracle/sillytavern-1.19.0-config-duplicate-key.json) is
		// exit 1 with the yaml message reported twice around a FATAL line, and a user diffing the two
		// backends over a broken config.yaml must see the same thing from both. A hint is NOT printed for
		// this path: the pinned block is a fixture-asserted format and stays byte-identical.
		if code, reported := reportConfigParseFailure(os.Stderr, err); reported {
			os.Exit(code)
		}
		// A second Ctrl+C is the user asking for the forced shutdown, not a failure: exit 130 without
		// turning it into a "gotavern: ..." error line.
		var forced forcedShutdown
		if errors.As(err, &forced) {
			os.Exit(forced.ExitCode())
		}
		fmt.Fprintln(os.Stderr, "gotavern:", err)
		printErrorHint(os.Stderr, err)
		var exitError interface{ ExitCode() int }
		if errors.As(err, &exitError) {
			os.Exit(exitError.ExitCode())
		}
		os.Exit(2)
	}
}

// reportConfigParseFailure writes the two blocks pinned writes for a config.yaml it refuses, and reports
// whether it handled the error.
//
// PINNED'S SHAPE, from the recording: the migration pass catches the parse error and warns with the yaml
// message inline after "YAMLParseError: "; the first `getConfigValue` then re-parses, fails again, prints
// "FATAL: Failed to read config.yaml. Please check the file for syntax errors." and the message a second
// time, and exits 1. The recording also carries pinned's Node stack frames; they name pinned's module paths
// and a Go binary cannot emit them honestly, so they are omitted here and asserted absent rather than faked.
func reportConfigParseFailure(stderr io.Writer, err error) (int, bool) {
	var parseError *configinit.ParseError
	if !errors.As(err, &parseError) {
		return 0, false
	}
	fmt.Fprintf(stderr, "Could not add missing config values to config.yaml YAMLParseError: %s\n", parseError.Message)
	fmt.Fprintln(stderr, "FATAL: Failed to read config.yaml. Please check the file for syntax errors.")
	fmt.Fprintln(stderr, parseError.Message)
	return 1, true
}

func run(args []string) error {
	return runWithStreams(args, os.Stdout, os.Stderr)
}

// runWithStreams is run with its output streams injected, so a test can capture
// exactly what a user would see on stdout and stderr separately. pinned's own
// help and version output goes to stdout (yargs `showHelp("log")` /
// `showVersion("log")`), which the previous stderr-only usage text contradicted.
//
// HELP AND VERSION ARE HANDLED BEFORE DISPATCH, in ANY argument position (GOAL.md §15.5): pinned's
// yargs answers --help/--version wherever they appear, so `gotavern start --help` must print the help
// and exit 0 instead of booting a server. The top-level block is still the pinned option set.
func runWithStreams(args []string, stdout, stderr io.Writer) error {
	args, verbose := stripVerbose(args)
	if target, asked := requestedHelpTarget(args); asked {
		printCommandHelp(target, stdout)
		return nil
	}
	if versionRequestedAnywhere(args) {
		return printVersionRequested(args, stdout)
	}
	if len(args) == 0 || strings.HasPrefix(args[0], "--") {
		return withStartupTrace(verbose, func() error { return runServer(args, stdout, stderr) })
	}

	switch args[0] {
	case "version":
		if len(args) == 2 && args[1] == "--json" {
			return printVersion(stdout, true)
		}
		if len(args) != 1 {
			return fmt.Errorf("usage: gotavern version [--json]")
		}
		return printVersion(stdout, false)
	case "assets":
		if len(args) != 2 || args[1] != "verify" {
			return fmt.Errorf("usage: gotavern assets verify")
		}
		for _, item := range []struct {
			root     string
			manifest string
		}{
			{root: "public", manifest: "manifests/public.sha256"},
			{root: "default", manifest: "manifests/default.sha256"},
			{root: "generated", manifest: "manifests/generated.sha256"},
		} {
			if err := assetmanifest.Verify(upstream.Assets, item.root, item.manifest); err != nil {
				return err
			}
			fmt.Fprintf(stdout, "verified upstream/%s\n", item.root)
		}
		// tokenizers is shipped as a DIRECTORY BESIDE THE BINARY, not in the embedded filesystem,
		// because that is where the tokenizer routes read it from (<InstallRoot>/tokenizers). Only
		// its manifest is embedded, so the tree is hashed on disk against that manifest.
		//
		// This check exists because leaving it out was a real defect: with the tree absent the
		// routes take the pinned FALLBACK path -- ids [], chunks null, guesstimate counts about 25%
		// high -- so a release could pass verification and then silently count every prompt wrong.
		// A browser probe measured exactly that signature and it was misread as a tokenizer route
		// defect until the installation layout was checked.
		if err := verifyInstalledTokenizers(stdout); err != nil {
			return err
		}
		return nil
	case "migrate":
		// Copying a SillyTavern runtime is GoTavern product behaviour, not pinned parity: pinned has no
		// `migrate` subcommand. The contract and its consequences live in internal/migrate and
		// docs/INSTALLATION.md section 6. The source is never written; a refusal is a named error.
		options, parseErr := migrate.ParseOptions(args[1:])
		if parseErr != nil {
			return parseErr
		}
		return migrate.Run(options, stdout)
	case "help":
		printUsage(stdout)
		return nil
	case "start":
		return withStartupTrace(verbose, func() error { return runServer(args[1:], stdout, stderr) })
	default:
		printUsage(stdout)
		return fmt.Errorf("unknown command %q", args[0])
	}
}

// printVersion writes the version block shared by `gotavern version`, `--version` in any position and
// the JSON form. The text is the one the CLI already published; only the dispatch moved.
func printVersion(stdout io.Writer, asJSON bool) error {
	info := buildInfo{
		GoTavernVersion:    version,
		SillyTavernVersion: upstream.SillyTavernVersion,
		SillyTavernCommit:  upstream.SillyTavernCommit,
	}
	if asJSON {
		encoder := json.NewEncoder(stdout)
		encoder.SetIndent("", "  ")
		return encoder.Encode(info)
	}
	fmt.Fprintf(stdout, "GoTavern %s\nSillyTavern baseline %s (%s)\n", info.GoTavernVersion, info.SillyTavernVersion, info.SillyTavernCommit)
	return nil
}

// verifyInstalledTokenizers hashes the tokenizers directory beside the executable against the
// embedded manifest. It fails when the tree is absent, which is the point: without it the tokenizer
// routes silently degrade to guesstimates instead of reporting a broken installation.
func verifyInstalledTokenizers(stdout io.Writer) error {
	manifest, err := fs.ReadFile(upstream.Assets, "manifests/tokenizers.sha256")
	if err != nil {
		return fmt.Errorf("read embedded tokenizers manifest: %w", err)
	}
	executable, err := os.Executable()
	if err != nil {
		return fmt.Errorf("resolve executable path: %w", err)
	}
	installRoot := filepath.Dir(executable)
	// THREE real layouts exist and all must verify, because each belongs to a supported installation:
	//
	//	src/tokenizers         the RELEASE layout from this version on, which is also the pinned SillyTavern
	//	                       layout -- so a package unpacked over an existing tree verifies either way
	//	tokenizers             the layout release v0.1.0-alpha.1 shipped; still accepted so an install made
	//	                       from it verifies after only the binary is replaced
	//	upstream/tokenizers    a REPOSITORY CHECKOUT (and CI, which builds the binary at the repo root)
	//
	// Trying only the newest path would fail those older installs, and trying only the repository path would
	// miss a broken release. The path that matched is printed, so the log says which layout was verified.
	for _, candidate := range []struct{ dir, tree string }{
		{dir: filepath.Join(installRoot, "src", "tokenizers"), tree: "."},
		{dir: installRoot, tree: "tokenizers"},
		{dir: filepath.Join(installRoot, "upstream", "tokenizers"), tree: "."},
	} {
		if _, err := os.Stat(filepath.Join(candidate.dir, candidate.tree)); err != nil {
			continue
		}
		if err := assetmanifest.VerifyWithManifest(os.DirFS(candidate.dir), candidate.tree, "manifests/tokenizers.sha256", manifest); err != nil {
			return err
		}
		fmt.Fprintf(stdout, "verified installed tokenizers (%s)\n", filepath.Join(candidate.dir, candidate.tree))
		return nil
	}
	return fmt.Errorf("tokenizers are missing from %s, %s and %s: the tokenizer routes would silently fall back to guesstimates", filepath.Join(installRoot, "src", "tokenizers"), installRoot, filepath.Join(installRoot, "upstream", "tokenizers"))
}

func runServer(args []string, stdout, stderr io.Writer) error {
	workingDirectory, err := os.Getwd()
	if err != nil {
		return fmt.Errorf("get working directory: %w", err)
	}
	executable, err := os.Executable()
	if err != nil {
		return fmt.Errorf("resolve executable path: %w", err)
	}
	installRoot := filepath.Dir(executable)
	// UNKNOWN OPTIONS WARN (deliberate deviation from pinned, whose yargs ignores them silently). The
	// warning never changes the exit status: an invocation pinned accepted must still boot.
	printUnknownOptionWarnings(stderr, commandline.UnknownServerArguments(args))
	running, err := app.Start(app.StartOptions{
		Args:             args,
		WorkingDirectory: workingDirectory,
		InstallRoot:      installRoot,
		StartupTrace:     stderr,
	})
	if err != nil {
		var startupError *app.StartupError
		if errors.As(err, &startupError) {
			for _, event := range startupError.SecurityEvents {
				if len(event.Args) == 0 {
					fmt.Fprintln(stderr)
					continue
				}
				fmt.Fprintln(stderr, strings.Join(event.Args, " "))
			}
		}
		return err
	}
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = running.Close(ctx)
	}()

	for _, warning := range running.CommandLine.Paths.Warnings {
		fmt.Fprintln(stderr, warning.Message)
	}
	// AGENTS.md rule 18: a config key an operator set that GoTavern accepts and does not act on must
	// say so, by name, where an operator sees it. These are NOT claims that a feature works; each
	// message states that the behaviour is not implemented and that the setting has no effect. See
	// internal/commandline/unimplemented_config.go.
	printUnimplementedConfigWarnings(stderr, running.CommandLine.UnimplementedConfigWarnings)
	for _, diagnostic := range running.DataStartup.Diagnostics {
		fmt.Fprintf(stderr, "Warning: %s: %v\n", diagnostic.Stage, diagnostic.Err)
	}
	for _, failure := range running.ListenerFailures {
		family := "IPv4"
		if failure.IPv6 {
			family = "IPv6"
		}
		fmt.Fprintf(stderr, "Warning: failed to start server on %s: %v\n", family, failure.Err)
	}

	// FIRST-RUN IDENTITY, from the REAL runtime state printed before the pinned-order launch/listener
	// lines (GOAL.md §15.5). The paths are the ones app.Start actually resolved and used, so a boot from
	// a foreign CWD or in global mode names the tree it wrote to rather than the one the user guessed.
	stdoutPalette := newPalette(stdout)
	paths := running.CommandLine.Paths
	printStartupIdentity(stdout, stdoutPalette, startupIdentity{
		Version:    version,
		Baseline:   upstream.SillyTavernVersion,
		Commit:     upstream.SillyTavernCommit,
		InstallDir: installRoot,
		ConfigFile: paths.ConfigFile,
		DataRoot:   paths.RuntimeDataRoot,
	})

	// PINNED ORDER: postSetupTasks launches the browser (src/server-main.js:362-395) BEFORE it prints the
	// listener lines and the `Go to:` line (:421-446), so the launch line is the first thing a user sees.
	// The launch is gated on the existing `browserLaunch.enabled` key -- true on a fresh install because
	// GoTavern ships pinned's default/config.yaml -- and never fails the boot.
	options := running.CommandLine.Options
	launchBrowser(stdout, stderr, options, running.CommandLine.BrowserLaunchApp, running.Protocols.UseIPv6, running.Protocols.UseIPv4, runtime.GOOS, execBrowserOpener)

	if running.StartedIPv6 {
		fmt.Fprintf(stdout, "GoTavern is listening on IPv6: %s\n", stdoutPalette.green(running.Listeners()[0].Addr().String()))
	}
	if running.StartedIPv4 {
		index := 0
		if running.StartedIPv6 {
			index = 1
		}
		fmt.Fprintf(stdout, "GoTavern is listening on IPv4: %s\n", stdoutPalette.green(running.Listeners()[index].Addr().String()))
	}
	// PINNED `listen: true` HINT BLOCK (src/server-main.js:439-443). It is printed whenever the listener
	// is network-visible, and it is the operator's only pointer to the per-connection log.
	printListenHint(stdout, jsTruthy(options.Listen), paths.RuntimeDataRoot)
	browserURL := ""
	if resolved, urlErr := resolveBrowserLaunchTarget(options, running.Protocols.UseIPv6, running.Protocols.UseIPv4); urlErr == nil {
		browserURL = resolved
		fmt.Fprintf(stdout, "Go to: %s to open GoTavern\n", stdoutPalette.blue(resolved))
	}

	// READY LINE: printed only here, after app.Start returned -- which happens after the listeners are
	// bound and their Serve goroutines started -- and carrying the address a browser can actually reach.
	// The URL is derived from the BOUND sockets, so port 0 (an ephemeral port) is reported truthfully
	// rather than as the configured ":0".
	readyURL := ""
	if resolved, urlErr := serveURL(boundAddresses(running), jsTruthy(options.SSL)); urlErr == nil {
		readyURL = resolved
	} else {
		readyURL = browserURL
	}
	if readyURL != "" {
		printReadyLine(stdout, stdoutPalette, readyURL)
	}

	signals := make(chan os.Signal, 1)
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM)
	defer signal.Stop(signals)
	select {
	case received := <-signals:
		return shutdownAfterSignal(running, received, signals, stderr)
	case serveErr := <-running.ServeErrors():
		return fmt.Errorf("HTTP listener failed: %w", serveErr)
	}
}

// boundAddresses exposes the bound listener addresses, which is what the Ready line reports instead of
// re-deriving a URL from configuration that may already have been overridden.
func boundAddresses(running *app.RunningServer) []net.Addr {
	listeners := running.Listeners()
	addresses := make([]net.Addr, 0, len(listeners))
	for _, listener := range listeners {
		addresses = append(addresses, listener.Addr())
	}
	return addresses
}

// shutdownAfterSignal prints the friendly first-signal message, then drains for up to the pinned ten
// seconds. A SECOND signal during the drain force-closes the listeners (in-flight requests are aborted)
// instead of being ignored, and exits 130 (128+SIGINT) through forcedShutdown.
func shutdownAfterSignal(running *app.RunningServer, received os.Signal, signals <-chan os.Signal, stderr io.Writer) error {
	fmt.Fprintln(stderr, shutdownNotice(received))
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	closed := make(chan error, 1)
	go func() { closed <- running.Close(ctx) }()
	select {
	case closeErr := <-closed:
		return closeErr
	case again := <-signals:
		fmt.Fprintf(stderr, "Force closing after %s: closing listeners now (in-flight requests are aborted)\n", again)
		for _, listener := range running.Listeners() {
			_ = listener.Close()
		}
		return forcedShutdown{Signal: again.String()}
	}
}

// printUnimplementedConfigWarnings writes, to the same stream main already uses for startup warnings,
// one line per config key the operator set that GoTavern does not implement. It exists as a named
// function so the wiring can be tested with a buffer: the point of these lines is that a user sees
// them, so "the message was built" is not the claim — "the message was printed" is.
func printUnimplementedConfigWarnings(stderr io.Writer, warnings []commandline.UnimplementedConfigWarning) {
	for _, warning := range warnings {
		fmt.Fprintln(stderr, warning.Message)
	}
}

// printListenHint reproduces pinned's listen-mode hint block
// (src/server-main.js:439-443), including the blank line before it and the
// access.log path it names. It is printed on stdout whenever `listen` is true,
// independently of logging.enableAccessLog -- that is pinned's own condition.
func printListenHint(stdout io.Writer, listen bool, dataRoot string) {
	if !listen {
		return
	}
	fmt.Fprintln(stdout)
	fmt.Fprintln(stdout, `To limit connections to internal localhost only ([::1] or 127.0.0.1), change the setting in config.yaml to "listen: false".`)
	fmt.Fprintf(stdout, "Check the \"access.log\" file in the data directory to inspect incoming connections: %s\n", startup.AccessLogPath(dataRoot))
}

func printUsage(stdout io.Writer) {
	fmt.Fprintln(stdout, "Usage:")
	fmt.Fprintln(stdout, "  gotavern [server options]")
	fmt.Fprintln(stdout, "  gotavern start [server options]")
	fmt.Fprintln(stdout, "  gotavern version [--json]")
	fmt.Fprintln(stdout, "  gotavern assets verify")
	fmt.Fprintln(stdout, "  gotavern migrate --from <sillytavern-root> --dest <dir> [--dry-run] [--force]")
	fmt.Fprintln(stdout, "  gotavern help")
	fmt.Fprintln(stdout, "")
	fmt.Fprint(stdout, commandline.OptionsHelp())
	fmt.Fprint(stdout, helpFooter)
}
