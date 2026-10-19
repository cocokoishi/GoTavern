// Command stats-fixture exposes startup statistics initialization to the
// pinned Node-to-Go-to-Node compatibility probe. It is not a runtime command.
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"time"

	"github.com/cocokoishi/gotavern/internal/startup"
)

func main() {
	if len(os.Args) != 3 {
		fmt.Fprintln(os.Stderr, "usage: stats-fixture <user-root> <now-unix-ms>")
		os.Exit(2)
	}
	userRoot, err := filepath.Abs(os.Args[1])
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	nowMillis, err := strconv.ParseInt(os.Args[2], 10, 64)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	result := startup.InitializeStatistics([]startup.UserDirectories{{
		"root":       userRoot,
		"characters": filepath.Join(userRoot, "characters"),
		"chats":      filepath.Join(userRoot, "chats"),
	}}, time.UnixMilli(nowMillis))
	errors := make([]string, len(result.Errors))
	for index, err := range result.Errors {
		errors[index] = err.Error()
	}
	value := result.Values[filepath.Base(userRoot)]
	body, err := os.ReadFile(filepath.Join(userRoot, statisticsFilename))
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	if err := json.NewEncoder(os.Stdout).Encode(struct {
		Errors      []string        `json:"errors"`
		Memory      json.RawMessage `json:"memory"`
		FileContent string          `json:"fileContent"`
	}{Errors: errors, Memory: value, FileContent: string(body)}); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

const statisticsFilename = "stats.json"
