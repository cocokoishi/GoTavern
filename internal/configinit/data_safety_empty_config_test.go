package configinit

// AN EMPTY CONFIG MUST BE REPAIRED TO THE PINNED DEFAULTS, NOT BRICK THE BOOT.
//
// Found by FuzzParseConfigMapping's first seed (`""`). Measured before the fix: writing a 0-byte
// config.yaml and calling Initialize returned
//
//	serialize config <path>: yaml: cannot encode node with unknown kind 0
//
// because parseMapping replaced the CONTENT of the yaml document for an empty input but left the
// document's Kind at 0, which stringifyConfig refuses to encode. The caller (commandline/paths.go)
// returns that error, so a crash-truncated config file -- the exact state a full disk or a killed
// process leaves -- stopped the server from booting.
//
// WHAT PINNED DOES (src/config-init.js:164-243, read 2026-10-31): yaml.parse('') is null;
// getAllKeys(null) is []; `_.defaultsDeep(null, defaultConfig)` is defaultConfig; addedKeys is
// every default key, so pinned WRITES the full default config and continues. So the repaired file
// must be the pinned default document, and a second boot must find nothing to add.
//
// Teeth: the fix is a one-line construction of a proper yaml.DocumentNode. Mutating it back to
// "replace Content only" makes the first assertion red with the measured message above.

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"

	"github.com/cocokoishi/gotavern/upstream"
)

func TestEmptyOrCommentOnlyConfigIsRepairedToThePinnedDefaults(t *testing.T) {
	pinnedDefaults, err := upstream.Assets.ReadFile("generated/default-config.yaml")
	if err != nil {
		t.Fatalf("read the pinned default config: %v", err)
	}
	for _, scenario := range []struct {
		name string
		body string
	}{
		// The crash/full-disk shape: the file exists but holds no bytes.
		{name: "zero bytes", body: ""},
		// What an editor that strips everything leaves behind.
		{name: "whitespace only", body: "  \n\t\n\n"},
		// A config a user emptied by commenting out every line.
		{name: "comments only", body: "# config intentionally left blank\n"},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "config.yaml")
			if err := os.WriteFile(path, []byte(scenario.body), 0o644); err != nil {
				t.Fatal(err)
			}
			result, err := Initialize(path)
			if err != nil {
				t.Fatalf("Initialize refused a %s config (%q): %v. Pinned parses it as null, "+
					"applies the defaults and continues.", scenario.name, scenario.body, err)
			}
			if !result.Updated {
				t.Fatalf("Initialize reported no change for a %s config; pinned writes the full "+
					"default config for it", scenario.name)
			}
			got, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(got, pinnedDefaults) {
				t.Fatalf("the repaired %s config is not the pinned default document.\n  want %d bytes\n  got  %d bytes\n"+
					"  got head: %q", scenario.name, len(pinnedDefaults), len(got), headBytes(got, 200))
			}

			// The repair must be a one-time event, or every boot would rewrite a config the user
			// may have since edited.
			second, err := Initialize(path)
			if err != nil {
				t.Fatalf("the second Initialize failed on the repaired config: %v", err)
			}
			if second.Updated || second.Created {
				t.Fatalf("the repaired config is not stable: the second Initialize reported %+v", second)
			}
			assertNoTemporaryFiles(t, filepath.Dir(path))
		})
	}
}

func headBytes(body []byte, limit int) []byte {
	if len(body) <= limit {
		return body
	}
	return body[:limit]
}
