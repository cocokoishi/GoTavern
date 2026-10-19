// Command user-store-fixture exposes the startup account initializer to the
// pinned Node round-trip probe. It is a development test tool, not a runtime
// command in the GoTavern CLI.
package main

import (
	"encoding/json"
	"fmt"
	"os"

	"github.com/cocokoishi/gotavern/internal/startup"
)

func main() {
	if len(os.Args) != 2 {
		fmt.Fprintln(os.Stderr, "usage: user-store-fixture <data-root>")
		os.Exit(2)
	}
	handles, err := startup.InitializeUserStorage(os.Args[1])
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	if err := json.NewEncoder(os.Stdout).Encode(struct {
		Handles []string `json:"handles"`
	}{Handles: handles}); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
