// Command build-longlived materialises the complex long-lived SillyTavern instance used by the drop-in
// qualification harness (docs/longlived-complex-fixture.md).
//
// Usage:
//
//	go run ./cmd/build-longlived <empty-target-directory> [--small] [--seed <int64>] [--schema <file>] [--size-label <label>]
//
// It prints the fixture manifest (JSON) on stdout, so a caller can assert against what the builder planted
// without re-reading the tree. The target must be empty: overwriting a directory is never a convenience.
//
// `--schema <file>` additionally writes the SHARED corpus-schema manifest (gotavern-corpus-schema v1,
// internal/longlivedfixture/corpus_schema.go), INCLUDING the alpha.16 M1 optional scenario/interaction block:
// the tree is the E02 (long-lived normal) prototype environment, and the block declares its recipe, preboot
// tree digest, byte census, action log and the exact replay command that rebuilds it from the same seed.
// Write the schema OUTSIDE the tree by convention: it describes the tree and is excluded from the tree's own
// identity, and a consumer like `tools/longlived/verify-corpus-schema.mjs` takes both paths explicitly. The
// schema is a pure function of the tree bytes plus the declared scenario, so two builds of the same spec
// produce byte-identical schema files.
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
	seed := flag.Int64("seed", 0, "override the generator seed; the scenario replay command records it (0 = default)")
	schemaPath := flag.String("schema", "", "write the shared corpus-schema manifest (gotavern-corpus-schema v1 + optional E02 scenario) to this file")
	sizeLabel := flag.String("size-label", "", "size label recorded in the schema (default complex-small / complex-default)")
	flag.Parse()
	if flag.NArg() != 1 {
		fmt.Fprintln(os.Stderr, "usage: build-longlived [-small] [-seed <int64>] [-schema <file>] [-size-label <label>] <empty-target-directory>")
		os.Exit(2)
	}
	spec := longlivedfixture.DefaultSpec()
	if *seed != 0 {
		spec.Seed = *seed
	}
	label := "complex-default"
	if *small {
		spec = longlivedfixture.Spec{
			Seed: spec.Seed, Characters: 4, Worlds: 2, BigWorld: 12, ChatBase: 8, ChatStep: 2,
			Presets: 2, Themes: 1, QuickReply: 1, Personas: 2, Backgrounds: 2, Groups: 1,
		}
		label = "complex-small"
	}
	if *sizeLabel != "" {
		label = *sizeLabel
	}
	root := flag.Arg(0)
	manifest, err := longlivedfixture.Build(root, spec)
	if err != nil {
		fmt.Fprintf(os.Stderr, "build-longlived: %v\n", err)
		os.Exit(1)
	}
	if *schemaPath != "" {
		// The replay command is recorded verbatim in the scenario block, so it must name the flags that would
		// reproduce THIS tree: the seed always, and -small only when the small spec was used. Flags precede the
		// positional target because Go's flag package stops parsing at the first non-flag argument.
		replay := fmt.Sprintf("go run ./cmd/build-longlived -seed %d -schema <schema> <out>", spec.Seed)
		if *small {
			replay = fmt.Sprintf("go run ./cmd/build-longlived -seed %d -small -schema <schema> <out>", spec.Seed)
		}
		schema, err := longlivedfixture.BuildCorpusSchemaWithScenario(root, spec, manifest, label, replay)
		if err != nil {
			fmt.Fprintf(os.Stderr, "build-longlived: build schema: %v\n", err)
			os.Exit(1)
		}
		if err := longlivedfixture.WriteCorpusSchema(*schemaPath, schema); err != nil {
			fmt.Fprintf(os.Stderr, "build-longlived: write schema: %v\n", err)
			os.Exit(1)
		}
		environmentClass := "none"
		if schema.Scenario != nil {
			environmentClass = schema.Scenario.EnvironmentClass
		}
		fmt.Fprintf(os.Stderr, "build-longlived: wrote corpus schema %s (%d files, tree %s, scenario %s)\n",
			*schemaPath, schema.Tree.Files, schema.Tree.SHA256, environmentClass)
	}
	encoded, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		fmt.Fprintf(os.Stderr, "build-longlived: marshal manifest: %v\n", err)
		os.Exit(1)
	}
	os.Stdout.Write(encoded)
	os.Stdout.Write([]byte("\n"))
}
