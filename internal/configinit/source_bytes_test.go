package configinit

// THE SOURCE TREE ITSELF IS AN ARTEFACT, AND ITS BYTES ARE NOT IMPLIED BY ITS BEING READABLE.
//
// WHY THIS EXISTS, in one measurement. While recovering this file's neighbour after a bad commit, a
// restore was written through a shell redirect and through `Set-Content -Encoding utf8`. Both produced
// files that a reader could open and that `git diff` called binary: the first was UTF-16LE with a byte
// order mark (`ff fe 2f 00 2f 00`, so every ASCII byte was followed by a NUL), the second was UTF-8 WITH a
// BOM and had collapsed 613 lines into 1. The commit went in. Every grep-based report afterwards was
// reading a file no Go compiler could build, and the only reason it was caught is that the recovery was
// verified with `git hash-object` against the original blob id rather than by looking at the file.
//
// That is AGENTS.md verification rule 12 ("a file that is readable may still be corrupt") applied to the
// REPOSITORY rather than to one generated document, and it is the check that turns the rule into a gate:
// every committed Go source must be UTF-8, BOM-free, NUL-free, and mind its line endings. A BOM decodes
// perfectly, so a decoder cannot be the check; the FIRST BYTES have to be.
//
// WHAT THIS DOES NOT DO: it says nothing about whether the code is correct, and a green here is not
// evidence that any other file in the tree is intact beyond the two properties it names.

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"unicode/utf8"
)

// repositoryRoot walks up from this package to the directory holding go.mod. It is derived rather than
// hard-coded so the test works from any worktree, which is the situation that produced the defect.
func repositoryRoot(t *testing.T) string {
	t.Helper()
	directory, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	for {
		if _, err := os.Stat(filepath.Join(directory, "go.mod")); err == nil {
			return directory
		}
		parent := filepath.Dir(directory)
		if parent == directory {
			t.Fatal("no go.mod above the working directory")
		}
		directory = parent
	}
}

// utf8BOM is what `Set-Content -Encoding utf8` prepends and what no Go source may start with.
var utf8BOM = []byte{0xEF, 0xBB, 0xBF}

// TestCommittedGoSourcesAreWellFormedUTF8 is the gate.
func TestCommittedGoSourcesAreWellFormedUTF8(t *testing.T) {
	root := repositoryRoot(t)
	checked := 0
	err := filepath.Walk(root, func(path string, info os.FileInfo, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		name := info.Name()
		if info.IsDir() {
			// Skipped directories are skipped for a reason, and each reason is a real one: .git holds
			// objects rather than sources, and a worktree nested inside another checkout (this project
			// creates them beside, not inside, but a stray one must not double-report) would be noise.
			if name == ".git" || name == "node_modules" || name == ".reference" {
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(name, ".go") {
			return nil
		}
		body, err := os.ReadFile(path)
		if err != nil {
			t.Errorf("%s: %v", relative(root, path), err)
			return nil
		}
		checked++
		report := relative(root, path)

		// FIRST BYTES BEFORE DECODING, because a BOM decodes perfectly and a UTF-16 file "decodes" into
		// text full of NULs that most readers silently drop.
		if bytes.HasPrefix(body, utf8BOM) {
			t.Errorf("%s: starts with a UTF-8 byte order mark (EF BB BF); a Go toolchain tolerates it and a "+
				"diff/reader hides it, which is why the check has to be on the bytes", report)
		}
		if bytes.HasPrefix(body, []byte{0xFF, 0xFE}) || bytes.HasPrefix(body, []byte{0xFE, 0xFF}) {
			t.Errorf("%s: starts with a UTF-16 byte order mark; a shell redirect (`>` in PowerShell writes "+
				"UTF-16LE) produced it, and every ASCII byte in the file is followed by a NUL", report)
		}
		if index := bytes.IndexByte(body, 0); index >= 0 {
			nuls := bytes.Count(body, []byte{0})
			t.Errorf("%s: contains %d NUL byte(s), first at offset %d; a Go source is never UTF-16, and git "+
				"reports such a file as binary", report, nuls, index)
		}
		if !utf8.Valid(body) {
			t.Errorf("%s: is not valid UTF-8", report)
		}
		if strings.ContainsRune(string(body), utf8.RuneError) {
			t.Errorf("%s: contains U+FFFD, which is what a lossy decode leaves behind; the original bytes "+
				"have already been destroyed at this point", report)
		}

		// LINE ENDINGS. A checkout on Windows with core.autocrlf rewrites these, so a CRLF file here is
		// legitimate and must not fail; a MIXED file is never legitimate, and neither is a lone CR, because
		// both mean something wrote part of the file through a path that is not the editor or git.
		crlf := bytes.Count(body, []byte("\r\n"))
		lone := bytes.Count(body, []byte("\r")) - crlf
		if lone > 0 {
			t.Errorf("%s: %d carriage return(s) not part of a CRLF pair", report, lone)
		}
		lf := bytes.Count(body, []byte("\n"))
		if crlf > 0 && crlf != lf {
			t.Errorf("%s: mixed line endings (%d CRLF, %d LF) -- a whole-file write and a partial write "+
				"disagree about the file, and the half that was written by the shell is the suspect half",
				report, crlf, lf)
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walk %s: %v", root, err)
	}
	// A GATE THAT CHECKED NOTHING MUST NOT PASS. A walk that found no Go files means the root is wrong or
	// the filter is wrong, and both would read as a green tree.
	if checked < 100 {
		t.Fatalf("only %d Go files were checked under %s; this repository has far more, so the walk or the "+
			"filter is wrong and the gate proved nothing", checked, root)
	}
	t.Logf("checked %d Go sources under %s", checked, root)
}

func relative(root, path string) string {
	if value, err := filepath.Rel(root, path); err == nil {
		return value
	}
	return path
}
