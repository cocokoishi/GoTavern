// Command flat-secrets-fixture exposes the startup secret migration to the
// pinned Node-to-Go-to-Node compatibility probe.
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"github.com/cocokoishi/gotavern/internal/startup"
)

func main() {
	if len(os.Args) != 2 {
		fmt.Fprintln(os.Stderr, "usage: flat-secrets-fixture <user-root>")
		os.Exit(2)
	}
	userRoot, err := filepath.Abs(os.Args[1])
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	errors := startup.MigrateFlatSecrets([]startup.UserDirectories{{
		"root":    userRoot,
		"backups": filepath.Join(userRoot, "backups"),
	}})
	messages := make([]string, len(errors))
	for index, err := range errors {
		messages[index] = err.Error()
	}
	if err := json.NewEncoder(os.Stdout).Encode(struct {
		Errors []string `json:"errors"`
	}{Errors: messages}); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
