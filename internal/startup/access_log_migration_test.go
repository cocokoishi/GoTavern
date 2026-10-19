package startup

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"
)

type accessLogMigrationOracle struct {
	SchemaVersion int `json:"schemaVersion"`
	Baseline      struct {
		Version string `json:"version"`
		Commit  string `json:"commit"`
	} `json:"baseline"`
	Scenarios map[string]accessLogMigrationScenario `json:"scenarios"`
}

type accessLogMigrationScenario struct {
	Input  accessLogMigrationInput       `json:"input"`
	First  accessLogMigrationObservation `json:"first"`
	Second accessLogMigrationObservation `json:"second"`
}

type accessLogMigrationInput struct {
	SameRoot            bool    `json:"sameRoot"`
	DataRootKind        string  `json:"dataRootKind"`
	DataRootContents    string  `json:"dataRootContents"`
	SourceKind          string  `json:"sourceKind"`
	SourceContents      *string `json:"sourceContents"`
	DestinationContents *string `json:"destinationContents"`
}

type accessLogMigrationObservation struct {
	Logs            []string                     `json:"logs"`
	ErrorCount      int                          `json:"errorCount"`
	Infos           []string                     `json:"infos"`
	DestinationPath string                       `json:"destinationPath"`
	Filesystem      accessLogMigrationFilesystem `json:"filesystem"`
}

type accessLogMigrationFilesystem struct {
	DataRoot    accessLogPathSnapshot `json:"dataRoot"`
	Source      accessLogPathSnapshot `json:"source"`
	Destination accessLogPathSnapshot `json:"destination"`
}

type accessLogPathSnapshot struct {
	Exists   bool                 `json:"exists"`
	Type     string               `json:"type"`
	Contents *string              `json:"contents"`
	Entries  []accessLogTreeEntry `json:"entries"`
}

type accessLogTreeEntry struct {
	Path     string  `json:"path"`
	Type     string  `json:"type"`
	Contents *string `json:"contents"`
}

func TestMigrateAccessLogMatchesPinnedNode(t *testing.T) {
	body, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-access-log-migration.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture accessLogMigrationOracle
	if err := json.Unmarshal(body, &fixture); err != nil {
		t.Fatal(err)
	}
	if fixture.SchemaVersion != 1 || fixture.Baseline.Version != "1.19.0" || fixture.Baseline.Commit != "06bde939fb1e9c4c8d8641d810f0a916b5bce127" {
		t.Fatalf("unexpected access-log migration oracle baseline: %#v", fixture.Baseline)
	}
	if len(fixture.Scenarios) < 6 {
		t.Fatalf("access-log migration oracle has only %d scenarios", len(fixture.Scenarios))
	}

	for scenarioName, scenario := range fixture.Scenarios {
		t.Run(scenarioName, func(t *testing.T) {
			installRoot := filepath.Join(t.TempDir(), "install")
			if err := os.MkdirAll(installRoot, 0o755); err != nil {
				t.Fatal(err)
			}
			dataRoot := filepath.Join(installRoot, "data")
			if scenario.Input.SameRoot {
				dataRoot = installRoot
			}
			if scenario.Input.DataRootKind == "file" {
				if err := os.WriteFile(dataRoot, []byte(scenario.Input.DataRootContents), 0o600); err != nil {
					t.Fatal(err)
				}
			} else if !scenario.Input.SameRoot {
				if err := os.MkdirAll(dataRoot, 0o755); err != nil {
					t.Fatal(err)
				}
			}
			sourcePath := filepath.Join(installRoot, "access.log")
			switch scenario.Input.SourceKind {
			case "directory":
				nested := filepath.Join(sourcePath, "legacy-entry.txt")
				if err := os.MkdirAll(filepath.Dir(nested), 0o755); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(nested, []byte("nested legacy log entry"), 0o600); err != nil {
					t.Fatal(err)
				}
			case "", "file":
				if scenario.Input.SourceContents != nil {
					if err := os.WriteFile(sourcePath, []byte(*scenario.Input.SourceContents), 0o600); err != nil {
						t.Fatal(err)
					}
				}
			default:
				t.Fatalf("unknown access-log source kind %q", scenario.Input.SourceKind)
			}
			if scenario.Input.DestinationContents != nil {
				if err := os.MkdirAll(dataRoot, 0o755); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(filepath.Join(dataRoot, "access.log"), []byte(*scenario.Input.DestinationContents), 0o600); err != nil {
					t.Fatal(err)
				}
			}

			first := MigrateAccessLog(installRoot, dataRoot)
			if got := observeAccessLogMigration(t, first, installRoot, dataRoot); !reflect.DeepEqual(got, scenario.First) {
				gotJSON, _ := json.MarshalIndent(got, "", "  ")
				wantJSON, _ := json.MarshalIndent(scenario.First, "", "  ")
				t.Fatalf("first access-log migration differs from pinned Node:\n got: %s\nwant: %s", gotJSON, wantJSON)
			}

			second := MigrateAccessLog(installRoot, dataRoot)
			if got := observeAccessLogMigration(t, second, installRoot, dataRoot); !reflect.DeepEqual(got, scenario.Second) {
				gotJSON, _ := json.MarshalIndent(got, "", "  ")
				wantJSON, _ := json.MarshalIndent(scenario.Second, "", "  ")
				t.Fatalf("second access-log migration differs from pinned Node:\n got: %s\nwant: %s", gotJSON, wantJSON)
			}
		})
	}
}

func observeAccessLogMigration(t *testing.T, result AccessLogMigrationResult, installRoot, dataRoot string) accessLogMigrationObservation {
	t.Helper()
	dataRootSnapshot := snapshotAccessLogDataRoot(t, dataRoot)
	destinationSnapshot := accessLogPathSnapshot{Entries: []accessLogTreeEntry{}}
	if dataRootSnapshot.Type != "file" {
		destinationSnapshot = snapshotAccessLogPath(t, filepath.Join(dataRoot, "access.log"))
	}
	observation := accessLogMigrationObservation{
		Logs:            []string{},
		ErrorCount:      len(result.Errors),
		Infos:           []string{},
		DestinationPath: "<data-root>/access.log",
		Filesystem: accessLogMigrationFilesystem{
			DataRoot:    dataRootSnapshot,
			Source:      snapshotAccessLogPath(t, filepath.Join(installRoot, "access.log")),
			Destination: destinationSnapshot,
		},
	}
	if result.Migrated {
		observation.Logs = append(observation.Logs, "Migrated access.log to new location: <data-root>/access.log")
	}
	if len(result.Errors) > 0 {
		observation.Infos = append(observation.Infos, "Please move access.log to the data directory manually.")
	}
	return observation
}

func snapshotAccessLogDataRoot(t *testing.T, dataRoot string) accessLogPathSnapshot {
	t.Helper()
	snapshot := snapshotAccessLogPath(t, dataRoot)
	if snapshot.Type == "directory" {
		entries := make([]accessLogTreeEntry, 0)
		for _, entry := range snapshot.Entries {
			if entry.Path == "access.log" || strings.HasPrefix(entry.Path, "access.log/") {
				entries = append(entries, entry)
			}
		}
		snapshot.Entries = entries
	}
	return snapshot
}

func snapshotAccessLogPath(t *testing.T, target string) accessLogPathSnapshot {
	t.Helper()
	info, err := os.Lstat(target)
	if os.IsNotExist(err) {
		return accessLogPathSnapshot{Entries: []accessLogTreeEntry{}}
	}
	if err != nil {
		t.Fatal(err)
	}
	snapshot := accessLogPathSnapshot{Exists: true, Entries: []accessLogTreeEntry{}}
	if info.IsDir() {
		snapshot.Type = "directory"
		snapshot.Entries = snapshotAccessLogTree(t, target, "")
		return snapshot
	}
	snapshot.Type = "file"
	contents := readAccessLogFile(t, target)
	snapshot.Contents = &contents
	return snapshot
}

func snapshotAccessLogTree(t *testing.T, directory, prefix string) []accessLogTreeEntry {
	t.Helper()
	entries, err := os.ReadDir(directory)
	if err != nil {
		t.Fatal(err)
	}
	output := make([]accessLogTreeEntry, 0)
	for _, entry := range entries {
		relative := entry.Name()
		if prefix != "" {
			relative = prefix + "/" + entry.Name()
		}
		entryPath := filepath.Join(directory, entry.Name())
		info, err := os.Lstat(entryPath)
		if err != nil {
			t.Fatal(err)
		}
		if info.IsDir() {
			output = append(output, accessLogTreeEntry{Path: relative, Type: "directory"})
			output = append(output, snapshotAccessLogTree(t, entryPath, relative)...)
			continue
		}
		contents := readAccessLogFile(t, entryPath)
		output = append(output, accessLogTreeEntry{Path: relative, Type: "file", Contents: &contents})
	}
	sort.Slice(output, func(left, right int) bool { return output[left].Path < output[right].Path })
	return output
}

func readAccessLogFile(t *testing.T, target string) string {
	t.Helper()
	body, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	return string(body)
}
