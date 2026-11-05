// Command build-longlived materialises the complex long-lived SillyTavern instance used by the drop-in
// qualification harness (docs/longlived-complex-fixture.md).
//
// Usage:
//
//	go run ./cmd/build-longlived <empty-target-directory> [--small]
//
// It prints the fixture manifest (JSON) on stdout, so a caller can assert against what the builder planted
// without re-reading the tree. The target must be empty: overwriting a directory is never a convenience.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"

	"github.com/cocokoishi/gotavern/internal/longlivedfixture"
)

func main() {
	small := flag.Bool("small", false, "build the small variant (a fast smoke, same code path)")
	flag.Parse()
	if flag.NArg() != 1 {
		fmt.Fprintln(os.Stderr, "usage: build-longlived [-small] <empty-target-directory>")
		os.Exit(2)
	}
	spec := longlivedfixture.DefaultSpec()
	if *small {
		spec = longlivedfixture.Spec{
			Seed: spec.Seed, Characters: 4, Worlds: 2, BigWorld: 12, ChatBase: 8, ChatStep: 2,
			Presets: 2, Themes: 1, QuickReply: 1, Personas: 2, Backgrounds: 2, Groups: 1,
		}
	}
	manifest, err := longlivedfixture.Build(flag.Arg(0), spec)
	if err != nil {
		fmt.Fprintf(os.Stderr, "build-longlived: %v\n", err)
		os.Exit(1)
	}
	encoded, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		fmt.Fprintf(os.Stderr, "build-longlived: marshal manifest: %v\n", err)
		os.Exit(1)
	}
	os.Stdout.Write(encoded)
	os.Stdout.Write([]byte("\n"))
}
