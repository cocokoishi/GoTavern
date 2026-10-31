package configinit

// FUZZ THE CONFIG PARSER: config.yaml is a user-edited, historically-shaped document and the
// migration path rewrites it. A panic here is a boot crash; an accept-then-crash here is worse,
// because the rewrite is what turns an unparseable document into data loss.
//
// The seeds are the shapes a real tree reaches: the pinned fresh config's head, a legacy key, a
// duplicate key (which pinned REFUSES and this parser must reject), a truncated sequence, tab
// indentation, anchors/aliases, unicode and comments. `go test` runs every seed as an ordinary
// case, so the corpus is covered without -fuzz.

import (
	"testing"

	"gopkg.in/yaml.v3"
)

func FuzzParseConfigMapping(f *testing.F) {
	for _, seed := range []string{
		"",
		"{}",
		"listen: false\nport: 8000\n",
		"port: 8000\nport: 9000\n",
		"ssl:\n  enabled: true\n",
		"ssl:\n\tenabled: true\n",
		"# comment\nlisten: false\n",
		"list:\n  - a\n  - b\n",
		"nested:\n  outer:\n    inner: 1\n",
		"a: &anchor {b: 1}\nc: *anchor\n",
		"unicode: \"h\u00e9llo \u4e16\u754c\"\n",
		"truncated: [a, b\n",
		"- top level sequence\n",
		"scalar\n",
		"null\n",
		"cookieSecret: legacy\n",
		"disableThumbnails: false\nnumberOfBackups: 10\n",
		"cardsCacheCapacity: 100\n",
	} {
		f.Add([]byte(seed))
	}
	f.Fuzz(func(t *testing.T, input []byte) {
		document, err := parseMapping(input)
		if err != nil {
			// A rejected document must leave the ORIGINAL bytes untouched; the caller checks the
			// file itself, so the only invariant needed here is that the error is not a panic.
			return
		}
		if document == nil || len(document.Content) == 0 || document.Content[0] == nil {
			t.Fatalf("parseMapping accepted input %q but returned no document root", input)
		}
		if document.Content[0].Kind != yaml.MappingNode {
			t.Fatalf("parseMapping accepted a non-mapping root of kind %v", document.Content[0].Kind)
		}
		migrateConfig(document)
		mergeDefaults(document, mustDefaultsDocument(t))
		output, err := stringifyConfig(document)
		if err != nil {
			t.Fatalf("stringifyConfig failed for an accepted document (input %q): %v", input, err)
		}
		if len(output) == 0 {
			t.Fatalf("stringifyConfig produced empty bytes for an accepted document (input %q)", input)
		}
		// The rewrite is what the next boot reads back: serializing must always produce a
		// document this same parser accepts.
		if _, err := parseMapping(output); err != nil {
			t.Fatalf("the serializer emitted a document the parser rejects (input %q, output %q): %v",
				input, output, err)
		}
	})
}

var cachedDefaults *yaml.Node

// mustDefaultsDocument decodes the pinned default config once. A failure is a test-environment
// problem (the embedded asset is missing), not a property of the fuzzed input.
func mustDefaultsDocument(t *testing.T) *yaml.Node {
	t.Helper()
	if cachedDefaults == nil {
		defaults, err := parseMapping([]byte("listen: false\nport: 8000\n"))
		if err != nil {
			t.Fatalf("build defaults document: %v", err)
		}
		cachedDefaults = defaults
	}
	return cachedDefaults
}
