package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/cocokoishi/gotavern/internal/app"
	"github.com/cocokoishi/gotavern/internal/assetmanifest"
	"github.com/cocokoishi/gotavern/internal/migrate"
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
	if len(args) == 0 {
		return runServer(args)
	}
	if args[0] == "help" || args[0] == "--help" || args[0] == "-h" {
		printUsage()
		return nil
	}
	if args[0] == "--version" {
		return run(append([]string{"version"}, args[1:]...))
	}
	if strings.HasPrefix(args[0], "--") {
		return runServer(args)
	}

	switch args[0] {
	case "version", "--version":
		info := buildInfo{
			GoTavernVersion:    version,
			SillyTavernVersion: upstream.SillyTavernVersion,
			SillyTavernCommit:  upstream.SillyTavernCommit,
		}
		if len(args) == 2 && args[1] == "--json" {
			encoder := json.NewEncoder(os.Stdout)
			encoder.SetIndent("", "  ")
			return encoder.Encode(info)
		}
		if len(args) != 1 {
			return fmt.Errorf("usage: gotavern version [--json]")
		}
		fmt.Printf("GoTavern %s\nSillyTavern baseline %s (%s)\n", info.GoTavernVersion, info.SillyTavernVersion, info.SillyTavernCommit)
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
			fmt.Printf("verified upstream/%s\n", item.root)
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
		if err := verifyInstalledTokenizers(); err != nil {
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
		return migrate.Run(options, os.Stdout)
	default:
		if args[0] == "start" {
			return runServer(args[1:])
		}
		printUsage()
		return fmt.Errorf("unknown command %q", args[0])
	}
}

// verifyInstalledTokenizers hashes the tokenizers directory beside the executable against the
// embedded manifest. It fails when the tree is absent, which is the point: without it the tokenizer
// routes silently degrade to guesstimates instead of reporting a broken installation.
func verifyInstalledTokenizers() error {
	manifest, err := fs.ReadFile(upstream.Assets, "manifests/tokenizers.sha256")
	if err != nil {
		return fmt.Errorf("read embedded tokenizers manifest: %w", err)
	}
	executable, err := os.Executable()
	if err != nil {
		return fmt.Errorf("resolve executable path: %w", err)
	}
	installRoot := filepath.Dir(executable)
	// Two real layouts exist and both must verify. A RELEASE puts tokenizers/ beside the binary,
	// because that is where the routes look. A REPOSITORY CHECKOUT (and CI, which builds the binary
	// at the repo root) keeps them at upstream/tokenizers. Trying only the release path would fail
	// CI while trying only the repository path would miss a broken release, so both are accepted and
	// the one that matched is named.
	for _, candidate := range []struct{ dir, tree string }{
		{dir: installRoot, tree: "tokenizers"},
		{dir: filepath.Join(installRoot, "upstream", "tokenizers"), tree: "."},
	} {
		if _, err := os.Stat(filepath.Join(candidate.dir, candidate.tree)); err != nil {
			continue
		}
		if err := assetmanifest.VerifyWithManifest(os.DirFS(candidate.dir), candidate.tree, "manifests/tokenizers.sha256", manifest); err != nil {
			return err
		}
		fmt.Printf("verified installed tokenizers (%s)\n", filepath.Join(candidate.dir, candidate.tree))
		return nil
	}
	return fmt.Errorf("tokenizers are missing from %s and %s: the tokenizer routes would silently fall back to guesstimates", installRoot, filepath.Join(installRoot, "upstream", "tokenizers"))
}

func runServer(args []string) error {
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
	})
	if err != nil {
		var startupError *app.StartupError
		if errors.As(err, &startupError) {
			for _, event := range startupError.SecurityEvents {
				if len(event.Args) == 0 {
					fmt.Fprintln(os.Stderr)
					continue
				}
				fmt.Fprintln(os.Stderr, strings.Join(event.Args, " "))
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
		fmt.Fprintln(os.Stderr, warning.Message)
	}
	for _, diagnostic := range running.DataStartup.Diagnostics {
		fmt.Fprintf(os.Stderr, "Warning: %s: %v\n", diagnostic.Stage, diagnostic.Err)
	}
	for _, failure := range running.ListenerFailures {
		family := "IPv4"
		if failure.IPv6 {
			family = "IPv6"
		}
		fmt.Fprintf(os.Stderr, "Warning: failed to start server on %s: %v\n", family, failure.Err)
	}
	if running.StartedIPv6 {
		fmt.Printf("GoTavern is listening on IPv6: %s\n", running.Listeners()[0].Addr())
	}
	if running.StartedIPv4 {
		index := 0
		if running.StartedIPv6 {
			index = 1
		}
		fmt.Printf("GoTavern is listening on IPv4: %s\n", running.Listeners()[index].Addr())
	}
	hostname := running.CommandLine.Options.ResolveBrowserLaunchHostname(running.Protocols.UseIPv6, running.Protocols.UseIPv4)
	browserURL, err := running.CommandLine.Options.BrowserLaunchURL(fmt.Sprint(hostname))
	if err == nil {
		fmt.Printf("Go to: %s to open GoTavern\n", browserURL)
	}
	if running.CommandLine.Options.BrowserLaunchEnabled == true {
		fmt.Fprintln(os.Stderr, "Warning: automatic browser launch is not implemented; open the URL above manually")
	}

	signals := make(chan os.Signal, 1)
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM)
	defer signal.Stop(signals)
	select {
	case received := <-signals:
		fmt.Fprintf(os.Stderr, "Shutting down after %s\n", received)
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		return running.Close(ctx)
	case serveErr := <-running.ServeErrors():
		return fmt.Errorf("HTTP listener failed: %w", serveErr)
	}
}

func printUsage() {
	fmt.Fprintln(os.Stderr, "Usage:")
	fmt.Fprintln(os.Stderr, "  gotavern [server options]")
	fmt.Fprintln(os.Stderr, "  gotavern start [server options]")
	fmt.Fprintln(os.Stderr, "  gotavern version [--json]")
	fmt.Fprintln(os.Stderr, "  gotavern assets verify")
	fmt.Fprintln(os.Stderr, "  gotavern migrate --from <sillytavern-root> --dest <dir> [--dry-run] [--force]")
	fmt.Fprintln(os.Stderr, "  gotavern help")
	fmt.Fprintln(os.Stderr, "")
}
