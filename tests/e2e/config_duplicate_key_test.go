package e2e

// A CONFIG.yaml THAT PINNED REFUSES MUST BE REFUSED THE SAME WAY BY THE SHIPPED BINARY.
//
// The oracle is tests/oracle/sillytavern-1.19.0-config-duplicate-key.json, which records the pinned boot on
// three documents: a control with no duplicate (exit 0, config migrated), and a flat duplicate and a nested
// one (exit 1, config byte-identical, stderr carrying the yaml message twice around a FATAL line). The
// config layer's own test replays that recording against `configinit.Initialize`; THIS test proves the part
// only a process can: the exit code a shell sees, the exact bytes on stderr, and that no `gotavern:` prefix
// or fake Node stack frame appears where pinned prints neither.
//
// It is deliberately at the binary level rather than against `runWithStreams`, because the claim is about
// what a user runs: `./gotavern start` in a directory whose config.yaml has the same key twice.

import (
	"bytes"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestDuplicateKeyConfigExitsOneWithPinnedLines(t *testing.T) {
	installRoot := t.TempDir()
	document := "port: 8000\nport: 9000\nlisten: false\n"
	configPath := filepath.Join(installRoot, "config.yaml")
	if err := os.WriteFile(configPath, []byte(document), 0o600); err != nil {
		t.Fatalf("plant the config: %v", err)
	}
	before, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatalf("read the planted config: %v", err)
	}

	binary := resolveBinary(t, installRoot)
	command := exec.Command(binary, "start")
	command.Dir = installRoot
	command.Env = childEnvironment(nil)
	var stdout, stderr bytes.Buffer
	command.Stdout = &stdout
	command.Stderr = &stderr
	runErr := command.Run()

	exitCode := 0
	if runErr != nil {
		var exitError *exec.ExitError
		if !errors.As(runErr, &exitError) {
			t.Fatalf("run %s: %v", binary, runErr)
		}
		exitCode = exitError.ExitCode()
	}
	if exitCode != 1 {
		t.Fatalf("exit code = %d, want 1 (the pinned recording's exitCode for a duplicate key); stderr:\n%s", exitCode, stderr.String())
	}

	got := stderr.String()
	lines := strings.Split(strings.TrimSuffix(got, "\n"), "\n")

	// THE ORDER IS THE CONTRACT: the migration pass warns with the message inline, then the boot dies and
	// prints FATAL, then the message again. Asserting only that each string appears would pass a program that
	// printed them in any order or twice in the wrong place.
	wantPrefix := "Could not add missing config values to config.yaml YAMLParseError: Map keys must be unique at line 2, column 1:"
	if len(lines) == 0 || lines[0] != wantPrefix {
		t.Fatalf("stderr line 0 = %q, want the pinned YAMLParseError warning %q\nfull stderr:\n%s", firstLine(lines), wantPrefix, got)
	}
	wantAfterPrefix := []string{"port: 8000", "port: 9000", "^"}
	if len(lines) < 4 {
		t.Fatalf("stderr has %d line(s), want at least 4 (warning, frame, caret, FATAL):\n%s", len(lines), got)
	}
	for index, want := range wantAfterPrefix {
		if lines[1+index] != want {
			t.Fatalf("stderr line %d = %q, want the recorded frame line %q\nfull stderr:\n%s", 1+index, lines[1+index], want, got)
		}
	}
	fatalAt := -1
	for index, line := range lines {
		if line == "FATAL: Failed to read config.yaml. Please check the file for syntax errors." {
			fatalAt = index
			break
		}
	}
	if fatalAt < 0 {
		t.Fatalf("stderr never carries the pinned FATAL line; full stderr:\n%s", got)
	}
	// The message appears a SECOND time after FATAL, and the frame with it.
	wantTail := []string{"Map keys must be unique at line 2, column 1:", "port: 8000", "port: 9000", "^"}
	if fatalAt+len(wantTail) >= len(lines) {
		t.Fatalf("stderr ends before the repeated message after FATAL; full stderr:\n%s", got)
	}
	for index, want := range wantTail {
		if lines[fatalAt+1+index] != want {
			t.Fatalf("stderr line %d (after FATAL) = %q, want %q\nfull stderr:\n%s", fatalAt+1+index, lines[fatalAt+1+index], want, got)
		}
	}

	// WHAT MUST NOT APPEAR. A "gotavern:" prefix is our generic error channel; "at Composer" is pinned's Node
	// stack, which this binary cannot honestly emit. Either one would mean the parity claim is dressing.
	for _, forbidden := range []string{"gotavern:", "at Composer", "node_modules"} {
		if strings.Contains(got, forbidden) {
			t.Fatalf("stderr contains %q, which pinned does not print here and a Go binary cannot honestly reproduce; full stderr:\n%s", forbidden, got)
		}
	}
	if strings.Contains(stdout.String(), "FATAL") {
		t.Fatalf("the FATAL line went to stdout; pinned writes diagnostics to stderr. stdout:\n%s", stdout.String())
	}

	// THE TREE IS UNTOUCHED, which is the part a user cares about: they can fix the duplicate and restart
	// with nothing lost, instead of having the config rewritten on the way to a crash.
	after, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatalf("read the config back: %v", err)
	}
	if !bytes.Equal(before, after) {
		t.Fatalf("the refused config was MODIFIED:\n  before %q\n  after  %q", string(before), string(after))
	}
}

func firstLine(lines []string) string {
	if len(lines) == 0 {
		return ""
	}
	return lines[0]
}
