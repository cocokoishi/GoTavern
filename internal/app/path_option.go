package app

import "strings"

// hasExplicitPathOption reports whether the caller named a path the pinned command-line parser would honour.
//
// It exists for ONE decision: reproducing pinned's `process.chdir(serverDirectory)` (server.js:11) at the app
// boundary. When the user says nothing about where their files are, everything resolves against the install root,
// exactly as it does for pinned; when they name a path, that path wins, because it is the only way to run the tree
// from somewhere else on purpose.
//
// The spellings are the ones the parser accepts (internal/commandline/options.go:133 configPath, :152 dataRoot) in
// both the `--flag value` and `--flag=value` forms, and the scan is deliberately conservative: an unrecognised
// spelling is treated as "no explicit path", because the failure mode of guessing wrong here is creating files in a
// directory the user did not name.
func hasExplicitPathOption(args []string) bool {
	for _, argument := range args {
		for _, name := range []string{"--configPath", "--config-path", "--dataRoot", "--data-root"} {
			if argument == name || strings.HasPrefix(argument, name+"=") {
				return true
			}
		}
	}
	return false
}
