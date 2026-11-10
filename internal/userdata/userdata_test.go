package userdata

import (
	"strings"
	"testing"
)

// The table pins the PINNED sanitize-filename behaviour, not the implementation's shape: a case must be
// able to fail if the policy drifts. The multibyte case is the truncation-boundary discriminator (a
// byte-boundary truncation would split a rune and produce invalid UTF-8), and the C1 case is the
// control-character discriminator (nothing else in the pipeline replaces U+0080..U+009F).
//
// ALPHA.20 CORRECTION (measured, not re-derived): four replacement-mode rows were WRONG in the version
// that shipped through alpha.19 -- they encoded the one-pass reading that also made the implementation
// diverge. The pinned package (node_modules/sanitize-filename/index.js under Node 24.19.0) applies the
// reserved-name and trailing-run rules by replacing the WHOLE match with the replacement and then
// re-sanitizing with "", so "..." -> "_", "con.txt" -> "_", "COM1" -> "_" and "name. . " -> "name_".
// The oracle rows live in a20_sanitize_filename_test.go; these four were corrected rather than deleted.
func TestSanitizeFilenameMatchesThePinnedSanitizeFilename(t *testing.T) {
	cases := []struct {
		name        string
		input       string
		replacement string
		want        string
	}{
		{name: "illegal characters are replaced", input: `a/b?c<d>e\f:g*h|i"j`, replacement: "_", want: "a_b_c_d_e_f_g_h_i_j"},
		{name: "an empty replacement removes them", input: `a/b?c`, replacement: "", want: "abc"},
		{name: "C0 controls are replaced", input: "a\x00b\x1fc", replacement: "_", want: "a_b_c"},
		{name: "C1 controls are replaced", input: "a\u0080b\u009fc", replacement: "_", want: "a_b_c"},
		{name: "only dots becomes one replacement", input: "...", replacement: "_", want: "_"},
		{name: "a reserved device name becomes one replacement", input: "con.txt", replacement: "_", want: "_"},
		{name: "a reserved com port becomes one replacement", input: "COM1", replacement: "_", want: "_"},
		{name: "trailing dots and spaces become one replacement", input: "name. . ", replacement: "_", want: "name_"},
		{name: "an ordinary name is unchanged", input: "Seraphina (1).png", replacement: "_", want: "Seraphina (1).png"},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			if got := SanitizeFilename(test.input, test.replacement); got != test.want {
				t.Fatalf("SanitizeFilename(%q, %q) = %q, want %q", test.input, test.replacement, got, test.want)
			}
		})
	}
}

func TestSanitizeFilenameTruncatesOnARuneBoundary(t *testing.T) {
	// Two byte widths, two boundaries: a 3-byte rune divides 255 exactly (85 runes), while a 2-byte
	// rune does not, so the pinned package must cut BACK to 254 rather than split a rune. A
	// byte-boundary truncation would produce invalid UTF-8 in both cases, which the validity assertion
	// would catch only in the second one — so both are checked.
	cases := []struct {
		name       string
		runeValue  string
		wantLength int
	}{
		{name: "three-byte runes divide 255 exactly", runeValue: "\u4e00", wantLength: 255},
		{name: "two-byte runes cut back to 254", runeValue: "\u00e9", wantLength: 254},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			long := strings.Repeat(test.runeValue, 300)
			got := SanitizeFilename(long, "_")
			if len(got) != test.wantLength {
				t.Fatalf("length = %d, want %d", len(got), test.wantLength)
			}
			if !strings.HasPrefix(long, got) {
				t.Fatalf("the result is not a prefix of the input, so a rune was split or re-encoded")
			}
			if strings.ToValidUTF8(got, "\ufffd") != got {
				t.Fatalf("the truncated result is not valid UTF-8")
			}
		})
	}
}
