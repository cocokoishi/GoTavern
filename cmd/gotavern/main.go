package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/cocokoishi/gotavern/internal/app"
	"github.com/cocokoishi/gotavern/internal/assetmanifest"
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
		return nil
	default:
		if args[0] == "start" {
			return runServer(args[1:])
		}
		printUsage()
		return fmt.Errorf("unknown command %q", args[0])
	}
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
	fmt.Fprintln(os.Stderr, "  gotavern help")
	fmt.Fprintln(os.Stderr, "")
}
