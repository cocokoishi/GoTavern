package userdata

// alpha.20 source-audit reproducer: internal/userdata.SanitizeFilename must reproduce the pinned
// sanitize-filename package exactly, because it is the pinned naming policy for user-controlled files
// and the BYAF card import builds the stored PNG name / chat name / alt-image folder from it.
//
// ORACLE, not a derivation: the pinned dependency itself (SillyTavern/node_modules/sanitize-filename/
// index.js, sanitize-filename 1.6.x) was executed under Node 24.19.0 against both the exported function's
// two modes -- `sanitize(x)` (removal) and `sanitize(x, {replacement: () => "_"})` (the pinned
// `sanitizeSafeCharacterReplacements`) -- and the rows below are its measured output. Reproduce with:
//
//	node -e 'import("file:///.../SillyTavern/node_modules/sanitize-filename/index.js").then(({default:s})=>...'
//
// The one-pass implementation that shipped through alpha.19 fails the reserved-name rows, the
// trailing-run rows in replacement mode, and both device-number-0 rows.

import (
	"strings"
	"testing"
)

func TestA20SanitizeFilenameMatchesThePinnedPackage(t *testing.T) {
	cases := []struct {
		input       string
		plain       string // sanitize(x)
		replacement string // sanitize(x, {replacement: () => "_"})
		why         string
	}{
		{input: "", plain: "", replacement: "", why: "an empty name stays empty in both passes"},
		{input: " ", plain: "", replacement: "_", why: "the trailing-run rule replaces the whole run, even when it is the whole name"},
		{input: ".", plain: "", replacement: "_", why: "reservedRe /^\\.+$/ replaces the whole match"},
		{input: "..", plain: "", replacement: "_", why: "reservedRe, whole match"},
		{input: "...", plain: "", replacement: "_", why: "reservedRe, whole match"},
		{input: " .", plain: "", replacement: "_", why: "dots-and-space run"},
		{input: ". .", plain: "", replacement: "_", why: "dots-and-space run"},
		{input: "con ..", plain: "con", replacement: "con_", why: "windowsReservedRe needs the dot immediately after CON, so only the trailing run applies"},
		{input: "com0", plain: "", replacement: "_", why: "windowsReservedRe is com[0-9] -- ZERO IS RESERVED"},
		{input: "com0.txt", plain: "", replacement: "_", why: "windowsReservedRe is com[0-9] -- ZERO IS RESERVED"},
		{input: "lpt0", plain: "", replacement: "_", why: "windowsReservedRe is lpt[0-9] -- ZERO IS RESERVED"},
		{input: "com9", plain: "", replacement: "_", why: "windowsReservedRe, upper end of the class"},
		{input: "COM0.PNG", plain: "", replacement: "_", why: "case-insensitive, whole match including the extension"},
		{input: "CON", plain: "", replacement: "_", why: "reserved name becomes ONE replacement char, not empty"},
		{input: "con.txt", plain: "", replacement: "_", why: "reserved name with extension"},
		{input: "NUL.tar.gz", plain: "", replacement: "_", why: "reserved name with two extensions: the whole match is replaced"},
		{input: "aux.", plain: "", replacement: "_", why: "reserved name whose extension is empty"},
		{input: "COM1.png", plain: "", replacement: "_", why: "device name with an extension"},
		{input: "a. ", plain: "a", replacement: "a_", why: "trailing run in replacement mode becomes one replacement"},
		{input: "a ", plain: "a", replacement: "a_", why: "trailing space in replacement mode"},
		{input: " a ", plain: " a", replacement: " a_", why: "only the TRAILING run is replaced"},
		{input: "trailing...   ", plain: "trailing", replacement: "trailing_", why: "the whole trailing run, not one replacement per character"},
		{input: "a?b", plain: "ab", replacement: "a_b", why: "illegal per-char replacement"},
		{input: "a/b", plain: "ab", replacement: "a_b", why: "illegal per-char replacement"},
		{input: "a\\b", plain: "ab", replacement: "a_b", why: "one illegal character is one replacement"},
		{input: "a\\\\b", plain: "ab", replacement: "a__b", why: "two illegal characters are TWO replacements"},
		{input: "a\x00b", plain: "ab", replacement: "a_b", why: "NUL is a control character"},
		{input: "a\u0085b", plain: "ab", replacement: "a_b", why: "C1 control range 0x80-0x9f"},
		{input: "café", plain: "café", replacement: "café", why: "non-ASCII is legal"},
		{input: "emoji-😀", plain: "emoji-😀", replacement: "emoji-😀", why: "astral rune preserved"},
		{input: strings.Repeat("a", 254) + "😀", plain: strings.Repeat("a", 254), replacement: strings.Repeat("a", 254),
			why: "truncated at 255 BYTES on a code-point boundary, not in the middle of the emoji"},
		{input: strings.Repeat("a", 200) + "con.", plain: strings.Repeat("a", 200) + "con", replacement: strings.Repeat("a", 200) + "con_",
			why: "trailing dot at the end of a long name"},
	}

	for _, testCase := range cases {
		if got := SanitizeFilename(testCase.input, ""); got != testCase.plain {
			t.Errorf("SanitizeFilename(%q, \"\") = %q, want %q (%s)", testCase.input, got, testCase.plain, testCase.why)
		}
		if got := SanitizeFilename(testCase.input, "_"); got != testCase.replacement {
			t.Errorf("SanitizeFilename(%q, \"_\") = %q, want %q (%s)", testCase.input, got, testCase.replacement, testCase.why)
		}
	}
}

// TestA20SanitizeFilenameTruncatesTo255Bytes pins the truncation bound itself, separately from the
// per-character rules: the pinned `truncate-utf8-bytes` dependency caps every pass at 255 bytes and the
// first pass's truncation can expose a reserved/trailing rule to the second pass.
func TestA20SanitizeFilenameTruncatesEachPassTo255Bytes(t *testing.T) {
	long := strings.Repeat("x", 300)
	if got := SanitizeFilename(long, ""); len(got) != 255 || got != strings.Repeat("x", 255) {
		t.Fatalf("plain truncation = %d bytes %q, want 255 x's", len(got), got[:min(len(got), 8)])
	}
	if got := SanitizeFilename(long, "_"); len(got) != 255 || got != strings.Repeat("x", 255) {
		t.Fatalf("replacement truncation = %d bytes, want 255 x's", len(got))
	}
	// A trailing run that survives the first pass is applied BEFORE truncation: the underscore is cut
	// off, exactly as the oracle row (255 a's + ". ") produced 255 a's with no underscore.
	longTrailing := strings.Repeat("a", 255) + ". "
	if got := SanitizeFilename(longTrailing, "_"); got != strings.Repeat("a", 255) {
		t.Fatalf("replacement with a 255-byte prefix + trailing run = %q, want 255 a's (the underscore is truncated)", got[len(got)-3:])
	}
}
