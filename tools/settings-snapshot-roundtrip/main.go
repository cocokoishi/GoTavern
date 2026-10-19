package main

import (
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"strconv"

	"github.com/cocokoishi/gotavern/internal/startup"
)

func main() {
	if len(os.Args) < 4 {
		fail("usage: settings-snapshot-roundtrip <create|restore> <data-root> <handle> [snapshot-name|retention]")
	}
	operation, dataRoot, handle := os.Args[1], os.Args[2], os.Args[3]
	switch operation {
	case "create":
		retention := 50.0
		if len(os.Args) > 4 {
			parsed, err := strconv.ParseFloat(os.Args[4], 64)
			if err != nil {
				fail("invalid retention: " + err.Error())
			}
			retention = parsed
		}
		if err := startup.CreateSettingsSnapshot(dataRoot, handle, retention); err != nil {
			fail(err.Error())
		}
		directories, err := startup.DirectoriesForUser(dataRoot, handle)
		if err != nil {
			fail(err.Error())
		}
		entries, err := os.ReadDir(directories["backups"])
		if err != nil {
			fail(err.Error())
		}
		files := make([]string, 0, len(entries))
		prefix := startup.SettingsSnapshotPrefix(handle)
		for _, entry := range entries {
			if entry.Type().IsRegular() && len(entry.Name()) >= len(prefix) && entry.Name()[:len(prefix)] == prefix {
				files = append(files, entry.Name())
			}
		}
		sort.Strings(files)
		if len(files) == 0 {
			fail("settings snapshot was not created")
		}
		writeJSON(map[string]string{"name": files[len(files)-1]})
	case "restore":
		if len(os.Args) < 5 {
			fail("restore requires a snapshot name")
		}
		restored, err := startup.RestoreSettingsSnapshot(dataRoot, handle, os.Args[4])
		if err != nil {
			fail(err.Error())
		}
		if !restored {
			fail("settings snapshot not found")
		}
		writeJSON(map[string]bool{"restored": true})
	default:
		fail("unknown operation: " + operation)
	}
}

func writeJSON(value any) {
	if err := json.NewEncoder(os.Stdout).Encode(value); err != nil {
		fail(err.Error())
	}
}

func fail(message string) {
	if message == "" {
		message = "settings snapshot round-trip failed"
	}
	fmt.Fprintln(os.Stderr, message)
	os.Exit(1)
}
