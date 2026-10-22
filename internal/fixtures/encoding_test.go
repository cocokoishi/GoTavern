// Package fixtures holds cross-cutting assertions about the committed oracle and scenario files.
//
// WHY THIS EXISTS. A byte-order mark is invisible to almost every reader and fatal to the one that
// matters: a lane generated four provider-wire scenario files with a shell that prepends one, and
// `JSON.parse` failed with an "unexpected token" error -- a message that named neither the file nor the cause.
// The same class has already cost this project more than once: a CP1252-decoded literal recorded into a
// fixture, a workflow restored through a UTF-16LE shell redirect, and a commit message written with a
// BOM. The lane that found the scenario-file case asked for the check to live in the harness rather than
// in somebody's shell history, and a Go test is the only place that runs on every push without wiring.
package fixtures

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestCommittedJSONArtifactsStartWithAnObject pins two properties of every committed JSON artifact:
//
//  1. it starts with the ASCII byte `{`, so no encoder has prepended a BOM or a UTF-16LE marker;
//  2. it decodes strictly as UTF-8, so no writer has produced bytes that only a lenient decoder accepts.
//
// Both are properties of the COMMITTED BYTES, which is what a fixture is. A test that decodes leniently
// would pass on exactly the files this exists to catch.
func TestCommittedJSONArtifactsStartWithAnObject(t *testing.T) {
	roots := []string{
		filepath.Join("..", "..", "tests", "oracle"),
		filepath.Join("..", "..", "tests", "provider-wire", "scenarios"),
		filepath.Join("..", "..", "tests", "browser"),
	}
	checked := 0
	skipped := 0
	for _, root := range roots {
		entries, err := os.ReadDir(root)
		if err != nil {
			t.Fatalf("read %s: %v", root, err)
		}
		for _, entry := range entries {
			if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
				continue
			}
			// The browser directory also carries per-run leg captures, which are gitignored and not
			// artifacts: their absence from git is the property, so a missing file is not a failure,
			// but a PRESENT one is held to the same rule.
			path := filepath.Join(root, entry.Name())
			body, err := os.ReadFile(path)
			if err != nil {
				t.Fatalf("read %s: %v", path, err)
			}
			if len(body) == 0 {
				t.Fatalf("%s is empty; an empty artifact proves nothing", path)
			}
			if body[0] != '{' {
				t.Fatalf("%s starts with byte %#x, not '{': a BOM or a UTF-16LE marker would do exactly this, and both make a JSON reader fail with a message that names neither the file nor the cause", path, body[0])
			}
			// A BOM IN THE MIDDLE IS DATA, NOT CORRUPTION, and this check found that out on its first
			// run: `sillytavern-1.19.0-flat-secrets.json` carries `"whitespace":"\ufeff   "` -- a secret
			// VALUE that really does begin with a BOM and spaces, recorded because the pinned code has to
			// preserve it. Rejecting every occurrence would have made a correct fixture unfixable
			// without editing the behaviour it records, so the rule is the ENCODING one: the artifact must
			// OPEN with `{` (checked above) and decode strictly. A writer that prepends a BOM puts it at
			// byte 0, which the first check catches.
			if !strictUTF8(body) {
				t.Fatalf("%s is not strict UTF-8; a lenient decoder would have accepted it and hidden the damage", path)
			}
			checked++
		}
	}
	if checked < 100 {
		// A sweep that suddenly finds almost nothing is a broken sweep, not a clean repository.
		t.Fatalf("checked only %d JSON artifacts (%d skipped); the sweep is looking in the wrong place", checked, skipped)
	}
	t.Logf("checked %d committed JSON artifacts for a leading '{' and strict UTF-8", checked)
}

// strictUTF8 reports whether body is valid UTF-8 with no replacement needed anywhere.
func strictUTF8(body []byte) bool {
	for len(body) > 0 {
		r, size := decodeRuneStrict(body)
		if r == 0xFFFD && size == 1 {
			// A genuine U+FFFD in the source is encoded as three bytes; a one-byte decode means the
			// decoder rejected the input, which is what this check is for.
			if len(body) < 3 || body[0] != 0xEF || body[1] != 0xBF || body[2] != 0xBD {
				return false
			}
		}
		if size == 0 {
			return false
		}
		body = body[size:]
	}
	return true
}

// decodeRuneStrict decodes one rune, returning U+FFFD with size 1 for an invalid sequence.
func decodeRuneStrict(body []byte) (rune, int) {
	for size := 1; size <= 4 && size <= len(body); size++ {
		candidate := body[:size]
		if decoded, ok := decodeExact(candidate); ok {
			return decoded, size
		}
	}
	return 0xFFFD, 1
}

// decodeExact decodes candidate only if it is a complete, well-formed UTF-8 sequence of exactly that
// length, so a truncated multi-byte sequence is rejected rather than half-read.
func decodeExact(candidate []byte) (rune, bool) {
	var runeValue rune
	switch {
	case candidate[0] < 0x80:
		if len(candidate) != 1 {
			return 0, false
		}
		return rune(candidate[0]), true
	case candidate[0]&0xE0 == 0xC0:
		if len(candidate) != 2 {
			return 0, false
		}
		runeValue = rune(candidate[0]&0x1F)<<6 | rune(candidate[1]&0x3F)
		if runeValue < 0x80 {
			return 0, false
		}
	case candidate[0]&0xF0 == 0xE0:
		if len(candidate) != 3 {
			return 0, false
		}
		runeValue = rune(candidate[0]&0x0F)<<12 | rune(candidate[1]&0x3F)<<6 | rune(candidate[2]&0x3F)
		if runeValue < 0x800 || (runeValue >= 0xD800 && runeValue <= 0xDFFF) {
			return 0, false
		}
	case candidate[0]&0xF8 == 0xF0:
		if len(candidate) != 4 {
			return 0, false
		}
		runeValue = rune(candidate[0]&0x07)<<18 | rune(candidate[1]&0x3F)<<12 | rune(candidate[2]&0x3F)<<6 | rune(candidate[3]&0x3F)
		if runeValue < 0x10000 || runeValue > 0x10FFFF {
			return 0, false
		}
	default:
		return 0, false
	}
	for _, continuation := range candidate[1:] {
		if continuation&0xC0 != 0x80 {
			return 0, false
		}
	}
	return runeValue, true
}
