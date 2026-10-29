package main

import (
	"bytes"
	"strings"
	"testing"

	"github.com/cocokoishi/gotavern/internal/commandline"
)

// TestHelpGoesToStdoutWithEveryOption covers the two divergences G-08 recorded:
// the stream (pinned's yargs writes help to stdout, exit 0 -- GoTavern wrote it
// to stderr) and the content (pinned documents all 31 server options; GoTavern
// documented none).
//
// The completeness half is a gate with teeth: it iterates the parser's own
// option table, so an option added to `cliOptionKinds` without a pinned
// description fails here instead of disappearing from --help. The layout of the
// block is GoTavern's own rendering; the option set and the description text are
// the pinned source's (src/command-line.js:112-266).
func TestHelpGoesToStdoutWithEveryOption(t *testing.T) {
	for _, argument := range []string{"help", "--help", "-h"} {
		t.Run(argument, func(t *testing.T) {
			var stdout, stderr bytes.Buffer
			if err := runWithStreams([]string{argument}, &stdout, &stderr); err != nil {
				t.Fatalf("gotavern %s returned %v, want nil", argument, err)
			}
			if stderr.Len() != 0 {
				t.Errorf("stderr = %q, want empty: pinned's help goes to stdout only", stderr.String())
			}
			if stdout.Len() == 0 {
				t.Fatal("stdout is empty; a redirected `gotavern --help` would show nothing")
			}
			help := stdout.String()
			if !strings.Contains(help, "Usage:") {
				t.Errorf("stdout = %q, want the usage banner", help)
			}
			for _, option := range commandline.OptionNames() {
				if !strings.Contains(help, "--"+option) {
					t.Errorf("stdout does not document --%s", option)
				}
			}
			for _, subcommand := range []string{"gotavern version", "gotavern assets verify", "gotavern migrate", "gotavern help"} {
				if !strings.Contains(help, subcommand) {
					t.Errorf("stdout does not document %q", subcommand)
				}
			}
		})
	}
}

// TestUnknownCommandStillNamesItself: the unknown-command path prints the usage
// block to stdout and returns an error, so the exit status is non-zero while the
// guidance a user needs is on the stream they read.
func TestUnknownCommandStillNamesItself(t *testing.T) {
	var stdout, stderr bytes.Buffer
	err := runWithStreams([]string{"frobnicate"}, &stdout, &stderr)
	if err == nil {
		t.Fatal("unknown command returned nil error")
	}
	if !strings.Contains(err.Error(), "frobnicate") {
		t.Errorf("error = %v, want the unknown command named", err)
	}
	if !strings.Contains(stdout.String(), "Usage:") {
		t.Errorf("stdout = %q, want the usage banner", stdout.String())
	}
}
