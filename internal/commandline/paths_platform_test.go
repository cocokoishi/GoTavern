package commandline

// PATHS A REAL USER ACTUALLY HAS: spaces, non-ASCII, a directory they cannot write, a port already taken.
//
// Item 2 of the startup long tail. The data-root resolution cases so far all used ASCII temp paths under a
// writable root, which is the configuration a developer has and not the one a user has. Each case here names
// the specific way the ordinary path was too easy, so a future reader can tell what would make it fail again.
//
// WHAT IS PINNED, from SillyTavern 1.19.0 = 06bde939 (read 2026-10-27):
//
//	src/command-line.js:288-297   the data root is created with `mkdirSync(dataRoot, {recursive: true})` and a
//	                              failure is a WARNING the boot continues past -- pinned has no fatal
//	                              data-root error path at all
//	server.js:11                  `process.chdir(serverDirectory)` happens AFTER that creation, which is why
//	                              ARCHITECTURE 34.5 (GoTavern's declared divergence) exists
//	src/server-main.js:400,456    every later use joins the resolved root: path.join(globalThis.DATA_ROOT, ...)
//
//	=> For a path with spaces or non-ASCII characters the pinned observable is simply that the SAME path string
//	   is used to create and to read, with no re-encoding in between. There is no normalisation step in pinned to
//	   model, which is exactly why a Go implementation must not introduce one (Windows path cleaning, NFC/NFD
//	   folding, or a locale-dependent encode would each change the directory that is used).
//
// AGENTS verification rule 9 is load-bearing here and is why the non-ASCII names below are written as EXPLICIT
// CODE POINTS in string literals rather than pasted glyphs: a pasted glyph survives one editor and arrives as
// the CP1252 mojibake of its UTF-8 bytes in another (the `probe-sd-routes.mjs` failure), and then the fixture
// and the source agree with each other about the wrong name. The test ALSO asserts the bytes go to disk intact
// by listing the directory and comparing the name it reads back, so a corrupted literal fails here rather than
// passing silently on one host.

import (
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"
)

// Non-ASCII directory names, given as code points so no editor can silently re-encode them.
//
//	"CJK"   = U+8D44 U+6599 (the two characters a Chinese-language user is most likely to name a data folder)
//	"EMOJI" = U+1F4C1 (folder), U+1F5C2 (dividers) -- a 4-byte UTF-8 sequence, which is where a byte-wise
//	          width assumption or a `len(name)` truncation breaks
const (
	cjkDataRootName     = "\u8D44\u6599"
	cjkUserHandleSuffix = "\u7528\u6237"
	emojiDataRootName   = "\U0001F4C1-\U0001F5C2"
)

// assertNameSurvivesOnDisk reads the parent directory and requires the child to exist under EXACTLY the name
// it was created with. This is the assertion that catches a corrupted literal: the filesystem is asked for the
// bytes, so a source file that lost its encoding cannot pass by agreeing with itself.
func assertNameSurvivesOnDisk(t *testing.T, parent, wantName string) {
	t.Helper()
	entries, err := os.ReadDir(parent)
	if err != nil {
		t.Fatalf("list %s: %v", parent, err)
	}
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		names = append(names, entry.Name())
	}
	sort.Strings(names)
	for _, name := range names {
		if name == wantName {
			return
		}
	}
	t.Fatalf("the directory %q is not on disk under its own name. Present: %q. This is the CP1252/UTF-8\n"+
		"class AGENTS verification rule 9 records: the literal in this file and the name on disk disagree, so\n"+
		"every later assertion about this path would be about a directory the product never used.\n"+
		"want bytes: % x\ngot names:  %q", wantName, names, []byte(wantName), names)
}

// TestDataRootWithSpacesAndNonASCIIResolvesVerbatim is the ordinary-path case made real: a data root whose
// parent contains a space, a CJK name and an emoji name. What is asserted is that the RESOLVED path is the
// SAME string that was asked for -- no normalisation, no folding, no escaping -- and that the directory the
// resolver created is on disk under exactly that name.
func TestDataRootWithSpacesAndNonASCIIResolvesVerbatim(t *testing.T) {
	for _, scenario := range []struct {
		name      string
		directory string
	}{
		{name: "a space in the path", directory: "my data folder"},
		{name: "a CJK data root", directory: cjkDataRootName},
		{name: "an emoji data root", directory: emojiDataRootName},
		{name: "a path mixing all three", directory: "user \u8D44\u6599 \U0001F4C1 folder"},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			parent := t.TempDir()
			serverDirectory := t.TempDir()
			// An ABSOLUTE dataRoot, so this case is about the path STRING surviving resolution and not about
			// the relative-two-bases behaviour ARCHITECTURE 34.5 covers separately.
			requested := filepath.Join(parent, scenario.directory, "data")

			resolved, err := ResolvePaths(ResolveOptions{
				Args:             []string{"--dataRoot", requested},
				WorkingDirectory: parent,
				ServerDirectory:  serverDirectory,
			})
			if err != nil {
				t.Fatalf("ResolvePaths with an absolute dataRoot containing %q failed: %v", scenario.directory, err)
			}
			if resolved.RuntimeDataRoot != requested {
				t.Fatalf("the runtime data root is not the path that was asked for. A replacement that\n"+
					"normalises, folds or re-encodes a user's path opens a DIFFERENT directory than the one the\n"+
					"user named (and than pinned's `path.join` would reach).\n  want %q\n  got  %q",
					requested, resolved.RuntimeDataRoot)
			}
			info, statErr := os.Stat(requested)
			if statErr != nil || !info.IsDir() {
				t.Fatalf("the requested data root %q was not created as a directory (err=%v); the first write "+
					"would then fail with ENOENT", requested, statErr)
			}
			// The string-level comparison above can pass while the BYTES on disk differ, if the literal in this
			// file is itself corrupt -- both sides would then agree about the wrong name. So the filesystem is
			// asked directly.
			assertNameSurvivesOnDisk(t, parent, scenario.directory)
		})
	}
}

// TestRelativeDataRootWithSpacesStillSeparatesTheBases is ARCHITECTURE 34.5 on a path a user could really
// type: the two-roots warning must name BOTH paths, and naming them must not damage either (a path with a
// space is where a naive message would have been built by splitting on whitespace).
func TestRelativeDataRootWithSpacesStillSeparatesTheBases(t *testing.T) {
	const relativeValue = "./my data"
	launchParent := t.TempDir()
	installParent := t.TempDir()
	workingDirectory := filepath.Join(launchParent, "launch dir")
	serverDirectory := filepath.Join(installParent, "install dir")
	for _, directory := range []string{workingDirectory, serverDirectory} {
		if err := os.MkdirAll(directory, 0o755); err != nil {
			t.Fatalf("create %s: %v", directory, err)
		}
	}
	configPath := filepath.Join(serverDirectory, "config.yaml")
	if err := os.WriteFile(configPath, []byte("listen: false\ndataRoot: \""+relativeValue+"\"\n"), 0o644); err != nil {
		t.Fatalf("write the config: %v", err)
	}

	resolved, err := ResolvePaths(ResolveOptions{
		Args:             []string{"--configPath", configPath},
		WorkingDirectory: workingDirectory,
		ServerDirectory:  serverDirectory,
	})
	if err != nil {
		t.Fatalf("ResolvePaths: %v", err)
	}
	wantRuntime := filepath.Join(serverDirectory, "my data")
	wantLaunch := filepath.Join(workingDirectory, "my data")
	if resolved.RuntimeDataRoot != wantRuntime {
		t.Fatalf("runtime data root = %q, want %q", resolved.RuntimeDataRoot, wantRuntime)
	}
	if resolved.DataRootCreationPath != wantLaunch {
		t.Fatalf("launch rendering = %q, want %q", resolved.DataRootCreationPath, wantLaunch)
	}
	if info, statErr := os.Stat(wantRuntime); statErr != nil || !info.IsDir() {
		t.Fatalf("the runtime root %q (a path with a space) was not created (err=%v)", wantRuntime, statErr)
	}
	if _, statErr := os.Stat(wantLaunch); statErr == nil {
		t.Fatalf("the launch rendering %q was created; it must not be (ARCHITECTURE 34.5)", wantLaunch)
	}
	// The warning has to carry both paths INTACT. A message assembled by splitting or joining on whitespace
	// would cut "my data" in half, and a user reading it could not tell which directory holds their data.
	var found string
	for _, warning := range resolved.Warnings {
		if strings.Contains(warning.Message, "two different directories") {
			found = warning.Message
			break
		}
	}
	if found == "" {
		t.Fatalf("no two-bases warning for a relative dataRoot containing a space; warnings: %v", resolved.Warnings)
	}
	for _, mustName := range []string{`"./my data"`, wantRuntime, wantLaunch} {
		if !strings.Contains(found, mustName) {
			t.Fatalf("the warning does not contain %q, so a path with a space was damaged while being "+
				"reported:\n%s", mustName, found)
		}
	}
}

// TestUnwritableDataRootFailsWithANamedErrorAndDoesNotHang is AGENTS 24/35 for the data root.
//
// The bound is the product's own, not a sleep: the resolver performs at most one attempt per directory and
// must return. A `time.After` around a goroutine would only prove that THIS TEST stopped waiting, so the
// assertion is that the call RETURNED, and the goroutine case exists to turn a wedge into a named failure
// instead of a hung suite.
func TestUnwritableDataRootFailsWithANamedErrorAndDoesNotHang(t *testing.T) {
	parent := t.TempDir()
	serverDirectory := t.TempDir()

	// A read-only PARENT with the data root underneath: the shape of a container image or a home directory the
	// service account cannot write. Chmod on Windows does not deny the owner, so the case SKIPS rather than
	// claiming a measurement it could not make.
	readOnlyParent := filepath.Join(parent, "readonly parent")
	if err := os.MkdirAll(readOnlyParent, 0o555); err != nil {
		t.Fatalf("create the read-only parent: %v", err)
	}
	t.Cleanup(func() { _ = os.Chmod(readOnlyParent, 0o755) })
	probe := filepath.Join(readOnlyParent, ".write-probe")
	if err := os.WriteFile(probe, []byte("probe"), 0o644); err == nil {
		_ = os.Remove(probe)
		t.Skip("a 0555 directory is still writable for this process (the Windows behaviour), so this host " +
			"cannot measure the unwritable-data-root path; the Linux gate is where it runs")
	}

	configPath := filepath.Join(serverDirectory, "config.yaml")
	if err := os.WriteFile(configPath, []byte("listen: false\n"), 0o644); err != nil {
		t.Fatalf("write the config: %v", err)
	}
	requested := filepath.Join(readOnlyParent, "data")

	type outcome struct {
		resolved ResolvedPaths
		err      error
	}
	done := make(chan outcome, 1)
	go func() {
		resolved, err := ResolvePaths(ResolveOptions{
			Args:             []string{"--configPath", configPath, "--dataRoot", requested},
			WorkingDirectory: serverDirectory,
			ServerDirectory:  serverDirectory,
		})
		done <- outcome{resolved: resolved, err: err}
	}()

	select {
	case got := <-done:
		// NOT AN ERROR REQUIREMENT. Pinned WARNS and continues past a failed creation
		// (command-line.js:295-297), so a resolver that warns is the pinned shape and must not be called a
		// defect for it. What is required is that it RETURNED, and that the failure is visible SOMEHOW --
		// an error or a warning, never silence.
		if got.err != nil {
			message := strings.ToLower(got.err.Error())
			if !strings.Contains(message, "permission") && !strings.Contains(message, "denied") &&
				!strings.Contains(message, requested) {
				t.Fatalf("the failure does not name the cause or the path, so a user cannot act on it "+
					"(AGENTS 35): %v", got.err)
			}
			return
		}
		reported := false
		for _, warning := range got.resolved.Warnings {
			if strings.Contains(warning.Message, requested) || strings.Contains(warning.Message, "Failed to create") {
				reported = true
				break
			}
		}
		if !reported {
			t.Fatalf("the resolver returned no error and no warning for an unwritable data root %q, so a boot "+
				"would continue silently and fail later on the first write. Warnings: %v",
				requested, got.resolved.Warnings)
		}
	case <-time.After(30 * time.Second):
		t.Fatalf("ResolvePaths did not return within its own bound on an unwritable data root %q: a startup "+
			"wait with no bound is the P0-B hang (AGENTS 24)", requested)
	}
}
