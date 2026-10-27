package commandline

// THE RELATIVE dataRoot PRODUCT DECISION (ARCHITECTURE 34.5, 2026-10-26).
//
// WHAT PINNED DOES, and this is now READ FROM the source rather than derived: `server.js:8` runs
// `new CommandLineParser().parse(...)`, and the data-root creation lives INSIDE it at
// `src/command-line.js:292-293` (`mkdirSync(dataRoot, {recursive: true})`). `server.js:11` then runs
// `process.chdir(serverDirectory)`, and every later use is `path.join(globalThis.DATA_ROOT, ...)`
// (`src/server-main.js:400,456`; `src/users.js:693,200`) against the post-chdir directory.
//
// So for a RELATIVE dataRoot pinned renders the mkdir against the LAUNCH directory (where the process
// started) and reads/writes against the SERVER directory. Two directories from one value, and SILENTLY:
// the mkdir succeeds, so the `Failed to create data root directory` warning at `command-line.js:295-297`
// never fires and the failure only appears later, as ENOENT on the first write into the directory nobody
// created.
//
// WHAT GOTAVERN DOES NOW, and why. It creates ONLY the directory the server will use, and reports the
// discarded rendering as a warning naming both paths. The reason is AGENTS 27 -- startup does not create
// state in a directory the user did not name -- and the precedent is ARCHITECTURE 34.3, where auto-update
// diverges from pinned's own default and is RECORDED rather than silently copied. What is NOT done:
// a relative dataRoot is still honoured (stopping that would break a working config), and the runtime
// root is still created (removing that is the P0-B ENOENT).
//
// The two path FIELDS keep their pinned values, because the pinned fixture records both and a change to
// either would fail TestResolveCommandLineMatchesPinnedNodeCommandLineParser. Only the side effect moves.
//
// WHAT THIS FILE ASSERTS:
//  1. the created path and the used path are THE SAME DIRECTORY after resolution (requirement (a));
//  2. the warning names both paths and says which one was used, and the launch-directory rendering was
//     never created (requirement (b));
//  3. the absolute and the coincident cases behave exactly as before, so the divergence is narrow.

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// resolveWithRelativeDataRoot runs the real resolver over a foreign working directory, a separate
// install (server) directory, and a config carrying `dataRoot: ./<name>`.
func resolveWithRelativeDataRoot(t *testing.T, relativeName string) ResolvedPaths {
	t.Helper()
	workingDirectory := filepath.Join(t.TempDir(), "launch")
	serverDirectory := filepath.Join(t.TempDir(), "install")
	for _, directory := range []string{workingDirectory, serverDirectory} {
		if err := os.MkdirAll(directory, 0o755); err != nil {
			t.Fatalf("create %s: %v", directory, err)
		}
	}
	if err := os.WriteFile(filepath.Join(serverDirectory, "config.yaml"), []byte("listen: false\nport: 8000\ndataRoot: ./"+relativeName+"\n"), 0o644); err != nil {
		t.Fatalf("write the config: %v", err)
	}
	resolved, err := ResolvePaths(ResolveOptions{
		Args:             []string{"--configPath", filepath.Join(serverDirectory, "config.yaml")},
		WorkingDirectory: workingDirectory,
		ServerDirectory:  serverDirectory,
	})
	if err != nil {
		t.Fatalf("ResolvePaths: %v", err)
	}
	return resolved
}

// TestRelativeDataRootCreatesOnlyTheDirectoryItUses is requirement (a): the directory CREATED and the
// directory USED are the same one, which is the invariant this whole lane is about.
func TestRelativeDataRootCreatesOnlyTheDirectoryItUses(t *testing.T) {
	const relativeName = "relative-marker-data"
	resolved := resolveWithRelativeDataRoot(t, relativeName)

	launchRendering := resolved.DataRootCreationPath
	runtimeRoot := resolved.RuntimeDataRoot
	if launchRendering == "" || runtimeRoot == "" {
		t.Fatalf("a resolved data root is empty (creation %q, runtime %q), so this test could not say "+
			"which directory was created", launchRendering, runtimeRoot)
	}
	// The case must be the two-bases case, or it proves nothing about the decision.
	if filepath.Clean(launchRendering) == filepath.Clean(runtimeRoot) {
		t.Fatalf("this fixture did not separate the two bases (both %q), so it cannot measure the "+
			"relative-dataRoot decision. The working directory and the server directory must differ",
			launchRendering)
	}
	if !strings.HasSuffix(runtimeRoot, relativeName) {
		t.Fatalf("the runtime data root %q does not carry the configured value %q", runtimeRoot, relativeName)
	}

	// (a) THE USED DIRECTORY EXISTS...
	if info, err := os.Stat(runtimeRoot); err != nil || !info.IsDir() {
		t.Fatalf("the directory the runtime will use (%s) was not created (err=%v): the first write would "+
			"fail with ENOENT, which is the P0-B shape", runtimeRoot, err)
	}
	// ...and the CREATED directory is that same one. `DataRootCreated` must not be claiming a creation
	// anywhere else, and the launch-directory rendering must not exist at all.
	if _, err := os.Stat(launchRendering); err == nil {
		t.Fatalf("the launch-directory rendering %s was CREATED. One relative dataRoot names one "+
			"directory; creating a second one in whatever directory the user happened to start from is the "+
			"unannounced write AGENTS 27 forbids (ARCHITECTURE 34.5)", launchRendering)
	} else if !os.IsNotExist(err) {
		t.Fatalf("could not tell whether %s exists: %v", launchRendering, err)
	}
	if !resolved.DataRootCreated {
		t.Fatalf("the runtime data root %s was created but DataRootCreated is false, so a caller cannot "+
			"report the one creation that did happen", runtimeRoot)
	}
}

// TestRelativeDataRootWarningNamesBothPaths is requirement (b): the warning is asserted BY CONTENT --
// both paths, and which one is used -- because "a warning exists" would pass for a warning that told the
// user nothing.
func TestRelativeDataRootWarningNamesBothPaths(t *testing.T) {
	const relativeName = "relative-marker-data"
	resolved := resolveWithRelativeDataRoot(t, relativeName)

	var divergence []string
	for _, warning := range resolved.Warnings {
		if strings.Contains(warning.Message, "resolves against two different directories") {
			divergence = append(divergence, warning.Message)
		}
	}
	if len(divergence) != 1 {
		t.Fatalf("expected exactly one relative-dataRoot warning naming the ambiguity, got %d: %v",
			len(divergence), resolved.Warnings)
	}
	message := divergence[0]
	for _, required := range []struct {
		what  string
		value string
	}{
		{"the configured value", `"` + "./" + relativeName + `"`},
		{"the launch-directory rendering", resolved.DataRootCreationPath},
		{"the directory actually used", resolved.RuntimeDataRoot},
		{"which one was created", "Only " + resolved.RuntimeDataRoot + " was created"},
		{"that the other was left alone", "nothing was written to " + resolved.DataRootCreationPath},
	} {
		if !strings.Contains(message, required.value) {
			t.Fatalf("the warning does not name %s (%q). A user reading it must be able to tell which "+
				"directory holds their data; the message was:\n%s", required.what, required.value, message)
		}
	}
	// It must not be a "failed to create" warning: nothing failed, and saying so would send a user looking
	// for a permissions problem that does not exist.
	if strings.Contains(message, "Failed to create") {
		t.Fatalf("the divergence is reported as a creation FAILURE, which it is not: %s", message)
	}
}

// TestAbsoluteDataRootStillCreatesExactlyOneUnambiguousDirectory is the control: the divergence must be
// narrow. An absolute dataRoot gives the same path in both bases, creates it, and adds no ambiguity
// warning -- so the new branch cannot be running where it has no business running.
func TestAbsoluteDataRootStillCreatesExactlyOneUnambiguousDirectory(t *testing.T) {
	workingDirectory := t.TempDir()
	serverDirectory := t.TempDir()
	absoluteRoot := filepath.Join(t.TempDir(), "absolute-data")

	resolved, err := ResolvePaths(ResolveOptions{
		Args:             []string{"--dataRoot", absoluteRoot},
		WorkingDirectory: workingDirectory,
		ServerDirectory:  serverDirectory,
	})
	if err != nil {
		t.Fatalf("ResolvePaths: %v", err)
	}
	if filepath.Clean(resolved.RuntimeDataRoot) != filepath.Clean(absoluteRoot) ||
		filepath.Clean(resolved.DataRootCreationPath) != filepath.Clean(absoluteRoot) {
		t.Fatalf("an absolute dataRoot resolved to two paths: creation %q, runtime %q, want both %q",
			resolved.DataRootCreationPath, resolved.RuntimeDataRoot, absoluteRoot)
	}
	if info, statErr := os.Stat(absoluteRoot); statErr != nil || !info.IsDir() {
		t.Fatalf("the absolute data root %s was not created (err=%v)", absoluteRoot, statErr)
	}
	for _, warning := range resolved.Warnings {
		if strings.Contains(warning.Message, "resolves against two different directories") {
			t.Fatalf("an ABSOLUTE dataRoot produced the ambiguity warning, so the new branch runs where it "+
				"should not: %s", warning.Message)
		}
	}
}
