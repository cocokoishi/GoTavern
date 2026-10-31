package startup

// FUZZ THE TWO PARSERS EVERY USER-CONTROLLED SETTINGS/FILENAME PATH GOES THROUGH.
//
// FormatSettingsJSON is /api/settings/save's whole body: the file a user keeps for months is the
// output of this function, so a panic or a non-deterministic rewrite is a data-safety problem, not
// a formatting nit. SanitizeUserFilename is the single choke point between a client-supplied name
// and a user-tree path (presets, themes, worlds, chats, characters, uploads); its invariant is the
// path-traversal guard, so the fuzz assertions are about the PROPERTY (no separator, no "..", no
// control bytes, bounded length), not about a table of expected outputs.

import (
	"path/filepath"
	"strings"
	"testing"
	"unicode/utf8"
)

func FuzzFormatSettingsJSON(f *testing.F) {
	for _, seed := range []string{
		`{}`,
		`[]`,
		`{"temperature":0.5}`,
		`[1,2,3]`,
		`{"nested":{"a":[{"b":null}]}}`,
		`{"unicode":"h\u00e9llo \u4e16\u754c"}`,
		`{"escaped":"\ud83d\ude00"}`,
		`{"dup":1,"dup":2}`,
		`{"number":1e999}`,
		`{"number":-0.0}`,
		`{"number":9007199254740993}`,
		`null`, `true`, `42`, `"scalar"`,
		`{"truncated":`,
		`{`,
		`[`,
		"{'single':'quotes'}",
		``,
	} {
		f.Add([]byte(seed))
	}
	f.Fuzz(func(t *testing.T, body []byte) {
		formatted, err := FormatSettingsJSON(body)
		if err != nil {
			return
		}
		if len(formatted) == 0 {
			t.Fatalf("FormatSettingsJSON accepted %q and produced no bytes", body)
		}
		// The formatted output is written to settings.json and read back by every later boot and
		// by the settings/get route: it must re-parse to a value of the same JavaScript kind, and
		// formatting it again must be byte-identical (idempotence), or every save would grow the
		// file.
		reformatted, err := FormatSettingsJSON(formatted)
		if err != nil {
			t.Fatalf("FormatSettingsJSON emitted output it cannot parse (input %q): %v", body, err)
		}
		if string(reformatted) != string(formatted) {
			t.Fatalf("FormatSettingsJSON is not idempotent for input %q", body)
		}
	})
}

func FuzzSanitizeUserFilename(f *testing.F) {
	for _, seed := range []string{
		"", ".", "..", "...", "normal.json", "with spaces.json",
		"../../etc/passwd", "..\\..\\windows\\system32", "/absolute/path",
		"a/b", "a\\b", "CON", "con.txt", "NUL.json", "COM1", "lpt9.log",
		"name.", "name ", "trailing...", "nul\x00byte", "\x01control\x1f",
		"tab\there", "colon:name", "star*", "question?", "pipe|", "quote\"",
		"h\u00e9llo \u4e16\u754c.json", "\uFFFD", "😀.json",
		strings.Repeat("a", 400) + ".json",
	} {
		f.Add(seed)
	}
	f.Fuzz(func(t *testing.T, input string) {
		sanitized := SanitizeUserFilename(input)
		if !utf8.ValidString(sanitized) {
			t.Fatalf("SanitizeUserFilename returned invalid UTF-8 for %q", input)
		}
		if len(sanitized) > 255 {
			t.Fatalf("SanitizeUserFilename returned %d bytes for %q, more than the 255-byte limit",
				len(sanitized), input)
		}
		for _, forbidden := range []string{"/", "\\", "\x00"} {
			if strings.Contains(sanitized, forbidden) {
				t.Fatalf("SanitizeUserFilename kept %q in %q (input %q): a separator here escapes the user tree",
					forbidden, sanitized, input)
			}
		}
		if sanitized == "." || sanitized == ".." {
			t.Fatalf("SanitizeUserFilename returned the traversal component %q for input %q", sanitized, input)
		}
		// A trailing dot or space after TRUNCATION is an INHERITED pinned property, not a bug in
		// this port: sanitize-filename 1.6.3 (node_modules/sanitize-filename/index.js:48-49)
		// strips trailing dots/spaces and THEN truncates to 255 bytes, so a >255-byte name whose
		// 255th byte lands on a space/dot ends with one again. Fuzz found exactly that
		// (testdata/fuzz/FuzzSanitizeUserFilename/55b532a140fa5370); it is recorded as inherited
		// and pinned by TestSanitizeUserFilenameKeepsPinnedTrimThenTruncateOrder rather than
		// silently diverging from pinned. The containment properties below are what protect the
		// tree and are asserted strictly.
		if sanitized != "" && isWindowsReservedUserPresetName(sanitized) {
			t.Fatalf("SanitizeUserFilename returned the Windows-reserved name %q for input %q", sanitized, input)
		}
		for _, character := range sanitized {
			if character <= 0x1f || (character >= 0x80 && character <= 0x9f) {
				t.Fatalf("SanitizeUserFilename kept control character %#x in %q (input %q)",
					character, sanitized, input)
			}
		}
		// The property that actually protects the tree: joining the result under a directory can
		// never leave it.
		if sanitized != "" && filepath.Base(sanitized) != sanitized {
			t.Fatalf("SanitizeUserFilename result %q is not its own base name (input %q)", sanitized, input)
		}
	})
}

// TestSanitizeUserFilenameKeepsPinnedTrimThenTruncateOrder pins the INHERITED pinned ordering that
// fuzzing measured: sanitize-filename 1.6.3 trims trailing dots/spaces and then truncates to 255
// bytes, so a name longer than the limit can end in a space or dot AFTER the trim. This port must
// reproduce it (AGENTS.md: inherited weaknesses are reproduced AND recorded, not silently fixed);
// a future change that re-trims after truncation must be a visible product decision, and this test
// is where that decision becomes red on purpose.
func TestSanitizeUserFilenameKeepsPinnedTrimThenTruncateOrder(t *testing.T) {
	longName := strings.Repeat("a", 254) + " " + "b"
	if got, want := SanitizeUserFilename(longName), strings.Repeat("a", 254)+" "; got != want {
		t.Fatalf("SanitizeUserFilename(%d-byte name) = %q (len %d), want the pinned trim-then-truncate result %q",
			len(longName), got, len(got), want)
	}
}
