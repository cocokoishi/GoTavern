package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"

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
		os.Exit(2)
	}
}

func run(args []string) error {
	if len(args) == 0 {
		printUsage()
		return errors.New("server startup is not implemented yet")
	}
	if args[0] == "help" || args[0] == "--help" || args[0] == "-h" {
		printUsage()
		return nil
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
		printUsage()
		return fmt.Errorf("unknown command %q", args[0])
	}
}

func printUsage() {
	fmt.Fprintln(os.Stderr, "Usage:")
	fmt.Fprintln(os.Stderr, "  gotavern version [--json]")
	fmt.Fprintln(os.Stderr, "  gotavern assets verify")
	fmt.Fprintln(os.Stderr, "  gotavern help")
	fmt.Fprintln(os.Stderr, "")
	fmt.Fprintln(os.Stderr, "The SillyTavern-compatible server is not implemented in this Phase 0 build.")
}
