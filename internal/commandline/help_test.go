package commandline

import (
	"strings"
	"testing"
)

// TestEveryParserOptionIsDocumented is the gate that keeps `--help` honest. It
// compares the parser's own option table (cliOptionKinds), the rendering order
// (cliOptionOrder) and the description table (cliOptionDescriptions) as SETS in
// both directions, so:
//
//   - an option added to the parser without a pinned description fails here
//     rather than disappearing from --help;
//   - a description or order entry with no parser option behind it fails, so a
//     removed option cannot leave a phantom line in the help.
//
// The description TEXT itself is a transcription of the pinned source
// (src/command-line.js:112-266); this test does not re-derive it, it guards that
// every option HAS one and that the renderer emits it. The pinned-derived
// transcription is the oracle and the citation for each line is in help.go.
func TestEveryParserOptionIsDocumented(t *testing.T) {
	if len(cliOptionKinds) != 31 {
		t.Fatalf("cliOptionKinds has %d entries, want the pinned 31 (src/command-line.js:112-266)", len(cliOptionKinds))
	}

	seenOrder := make(map[string]bool, len(cliOptionOrder))
	for _, name := range cliOptionOrder {
		if seenOrder[name] {
			t.Errorf("cliOptionOrder lists %q twice", name)
		}
		seenOrder[name] = true
		if _, known := cliOptionKinds[name]; !known {
			t.Errorf("cliOptionOrder lists %q, which is not in cliOptionKinds", name)
		}
	}
	for name := range cliOptionKinds {
		if !seenOrder[name] {
			t.Errorf("cliOptionKinds has %q but cliOptionOrder does not, so --help would omit it", name)
		}
	}

	seenDescriptions := make(map[string]bool, len(cliOptionDescriptions))
	for name, description := range cliOptionDescriptions {
		seenDescriptions[name] = true
		if _, known := cliOptionKinds[name]; !known {
			t.Errorf("cliOptionDescriptions describes %q, which is not a parser option", name)
		}
		if strings.TrimSpace(description) == "" {
			t.Errorf("option %q has an empty description", name)
		}
	}
	for name := range cliOptionKinds {
		if !seenDescriptions[name] {
			t.Errorf("option %q has no pinned description, so --help cannot document it", name)
		}
	}
}

// TestOptionsHelpRendersEveryOptionWithItsPinnedText proves the renderer emits
// what the tables hold -- including a multi-line description, which is where a
// naive one-line renderer would silently drop pinned's second line.
func TestOptionsHelpRendersEveryOptionWithItsPinnedText(t *testing.T) {
	help := OptionsHelp()
	for name, description := range cliOptionDescriptions {
		if !strings.Contains(help, "--"+name) {
			t.Errorf("rendered help does not contain --%s", name)
		}
		for _, line := range strings.Split(description, "\n") {
			if !strings.Contains(help, line) {
				t.Errorf("rendered help does not contain the pinned description line %q of --%s", line, name)
			}
		}
	}
	if !strings.Contains(help, "[boolean]") || !strings.Contains(help, "[array]") {
		t.Errorf("rendered help = %q, want the per-option types yargs prints", help)
	}
}
