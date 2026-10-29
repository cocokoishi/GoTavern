package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
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
		fmt.Fprintln(os.Stderr, "gotavern:", err)
		var exitError interface{ ExitCode() int }
		if errors.As(err, &exitError) {
			os.Exit(exitError.ExitCode())
		}
		os.Exit(2)
	}
}

func run(args []string) error {
	return runWithStreams(args, os.Stdout, os.Stderr)
}

// runWithStreams is run with its output streams injected, so a test can capture
// exactly what a user would see on stdout and stderr separately. pinned's own
// help and version output goes to stdout (yargs `showHelp("log")` /
// `showVersion("log")`), which the previous stderr-only usage text contradicted.
func runWithStreams(args []string, stdout, stderr io.Writer) error {
	if len(args) == 0 {
		return runServer(args, stdout, stderr)
	}
	if args[0] == "help" || args[0] == "--help" || args[0] == "-h" {
		printUsage(stdout)
		return nil
	}
	if args[0] == "--version" {
		return runWithStreams(append([]string{"version"}, args[1:]...), stdout, stderr)
	}
	if strings.HasPrefix(args[0], "--") {
		return runServer(args, stdout, stderr)
	}

	switch args[0] {
	case "version", "--version":
		info := buildInfo{
			GoTavernVersion:    version,
			SillyTavernVersion: upstream.SillyTavernVersion,
			SillyTavernCommit:  upstream.SillyTavernCommit,
		}
		if len(args) == 2 && args[1] == "--json" {
			encoder := json.NewEncoder(stdout)
			encoder.SetIndent("", "  ")
			return encoder.Encode(info)
		}
		if len(args) != 1 {
			return fmt.Errorf("usage: gotavern version [--json]")
		}
		fmt.Fprintf(stdout, "GoTavern %s\nSillyTavern baseline %s (%s)\n", info.GoTavernVersion, info.SillyTavernVersion, info.SillyTavernCommit)
		return nil
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
	default:
		if args[0] == "start" {
			return runServer(args[1:], stdout, stderr)
		}
		printUsage(stdout)
		return fmt.Errorf("unknown command %q", args[0])
	}
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

	// PINNED ORDER: postSetupTasks launches the browser (src/server-main.js:362-395) BEFORE it prints the
	// listener lines and the `Go to:` line (:421-446), so the launch line is the first thing a user sees.
	// The launch is gated on the existing `browserLaunch.enabled` key -- true on a fresh install because
	// GoTavern ships pinned's default/config.yaml -- and never fails the boot.
	options := running.CommandLine.Options
	launchBrowser(stdout, stderr, options, running.CommandLine.BrowserLaunchApp, running.Protocols.UseIPv6, running.Protocols.UseIPv4, runtime.GOOS, execBrowserOpener)

	if running.StartedIPv6 {
		fmt.Fprintf(stdout, "GoTavern is listening on IPv6: %s\n", running.Listeners()[0].Addr())
	}
	if running.StartedIPv4 {
		index := 0
		if running.StartedIPv6 {
			index = 1
		}
		fmt.Fprintf(stdout, "GoTavern is listening on IPv4: %s\n", running.Listeners()[index].Addr())
	}
	// PINNED `listen: true` HINT BLOCK (src/server-main.js:439-443). It is printed whenever the listener
	// is network-visible, and it is the operator's only pointer to the per-connection log.
	printListenHint(stdout, jsTruthy(options.Listen), running.CommandLine.Paths.RuntimeDataRoot)
	if browserURL, urlErr := resolveBrowserLaunchTarget(options, running.Protocols.UseIPv6, running.Protocols.UseIPv4); urlErr == nil {
		fmt.Fprintf(stdout, "Go to: %s to open GoTavern\n", browserURL)
	}

	signals := make(chan os.Signal, 1)
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM)
	defer signal.Stop(signals)
	select {
	case received := <-signals:
		fmt.Fprintf(stderr, "Shutting down after %s\n", received)
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		return running.Close(ctx)
	case serveErr := <-running.ServeErrors():
		return fmt.Errorf("HTTP listener failed: %w", serveErr)
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
}
