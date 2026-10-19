// Command assetmanifest creates or verifies deterministic SHA-256 tree manifests.
package main

import (
	"bytes"
	"flag"
	"fmt"
	"os"
	"path/filepath"

	"github.com/cocokoishi/gotavern/internal/assetmanifest"
)

func main() {
	root := flag.String("root", "", "asset directory to manifest")
	output := flag.String("output", "", "manifest file path")
	check := flag.Bool("check", false, "verify the existing manifest instead of writing it")
	flag.Parse()

	if *root == "" || *output == "" {
		fmt.Fprintln(os.Stderr, "usage: assetmanifest -root DIR -output FILE [-check]")
		os.Exit(2)
	}

	content, err := assetmanifest.Generate(os.DirFS(*root), ".")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	if *check {
		current, err := os.ReadFile(*output)
		if err != nil || !bytes.Equal(current, content) {
			fmt.Fprintln(os.Stderr, "manifest differs; regenerate it without -check")
			os.Exit(1)
		}
		fmt.Printf("verified %s against %s\n", *root, *output)
		return
	}
	if err := os.MkdirAll(filepath.Dir(*output), 0o755); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	if err := os.WriteFile(*output, content, 0o644); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	fmt.Printf("wrote %s\n", *output)
}
