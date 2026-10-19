package startup

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"sort"
	"testing"
	"time"
)

type settingsBackupOracle struct {
	SchemaVersion int                               `json:"schemaVersion"`
	Baseline      settingsBackupBaseline            `json:"baseline"`
	Scenarios     map[string]settingsBackupScenario `json:"scenarios"`
}

type settingsBackupBaseline struct {
	Version string `json:"version"`
	Commit  string `json:"commit"`
}

type settingsBackupScenario struct {
	Input  settingsBackupInput       `json:"input"`
	First  settingsBackupObservation `json:"first"`
	Second settingsBackupObservation `json:"second"`
}

type settingsBackupInput struct {
	RootExists             bool                 `json:"rootExists"`
	BackupsDirectoryExists *bool                `json:"backupsDirectoryExists"`
	Settings               *string              `json:"settings"`
	Backups                []settingsBackupSeed `json:"backups"`
	ChangeTimeGapMs        int                  `json:"changeTimeGapMs"`
	MaxBackups             int                  `json:"maxBackups"`
}

type settingsBackupSeed struct {
	Name     string `json:"name"`
	Contents string `json:"contents"`
	ModTime  int64  `json:"mtime"`
}

type settingsBackupObservation struct {
	ErrorCount int                      `json:"errorCount"`
	State      settingsBackupFilesystem `json:"state"`
}

type settingsBackupFilesystem struct {
	RootExists             bool                  `json:"rootExists"`
	Settings               *string               `json:"settings"`
	BackupsDirectoryExists bool                  `json:"backupsDirectoryExists"`
	Backups                []settingsBackupEntry `json:"backups"`
}

type settingsBackupEntry struct {
	Name     string `json:"name"`
	Contents string `json:"contents"`
}

func TestBackupSettingsMatchesPinnedNode(t *testing.T) {
	body, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-settings-backup.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture settingsBackupOracle
	if err := json.Unmarshal(body, &fixture); err != nil {
		t.Fatal(err)
	}
	if fixture.SchemaVersion != 1 || fixture.Baseline.Version != "1.19.0" || fixture.Baseline.Commit != "06bde939fb1e9c4c8d8641d810f0a916b5bce127" {
		t.Fatalf("unexpected settings-backup oracle baseline: %#v", fixture.Baseline)
	}
	if len(fixture.Scenarios) < 8 {
		t.Fatalf("settings-backup oracle has only %d scenarios", len(fixture.Scenarios))
	}

	for scenarioName, scenario := range fixture.Scenarios {
		t.Run(scenarioName, func(t *testing.T) {
			dataRoot := filepath.Join(t.TempDir(), "data")
			userRoot := filepath.Join(dataRoot, "default-user")
			backupsDirectory := filepath.Join(userRoot, "backups")
			if scenario.Input.RootExists {
				if err := os.MkdirAll(userRoot, 0o755); err != nil {
					t.Fatal(err)
				}
				backupsDirectoryExists := true
				if scenario.Input.BackupsDirectoryExists != nil {
					backupsDirectoryExists = *scenario.Input.BackupsDirectoryExists
				}
				if backupsDirectoryExists {
					if err := os.MkdirAll(backupsDirectory, 0o755); err != nil {
						t.Fatal(err)
					}
				}
				if scenario.Input.Settings != nil {
					if err := os.WriteFile(filepath.Join(userRoot, settingsFilename), []byte(*scenario.Input.Settings), 0o600); err != nil {
						t.Fatal(err)
					}
				}
				for index, backup := range scenario.Input.Backups {
					backupPath := filepath.Join(backupsDirectory, backup.Name)
					if err := os.WriteFile(backupPath, []byte(backup.Contents), 0o600); err != nil {
						t.Fatal(err)
					}
					modTime := time.UnixMilli(backup.ModTime)
					if err := os.Chtimes(backupPath, modTime, modTime); err != nil {
						t.Fatal(err)
					}
					if scenario.Input.ChangeTimeGapMs > 0 && index < len(scenario.Input.Backups)-1 {
						time.Sleep(time.Duration(scenario.Input.ChangeTimeGapMs) * time.Millisecond)
					}
				}
			}

			directories := UserDirectories{"root": userRoot, "backups": backupsDirectory}
			first := BackupSettings([]UserDirectories{directories}, scenario.Input.MaxBackups)
			if got := observeSettingsBackup(t, len(first), userRoot, backupsDirectory); !reflect.DeepEqual(got, scenario.First) {
				gotJSON, _ := json.MarshalIndent(got, "", "  ")
				wantJSON, _ := json.MarshalIndent(scenario.First, "", "  ")
				t.Fatalf("first settings backup differs from pinned Node:\n got: %s\nwant: %s", gotJSON, wantJSON)
			}

			second := BackupSettings([]UserDirectories{directories}, scenario.Input.MaxBackups)
			if got := observeSettingsBackup(t, len(second), userRoot, backupsDirectory); !reflect.DeepEqual(got, scenario.Second) {
				gotJSON, _ := json.MarshalIndent(got, "", "  ")
				wantJSON, _ := json.MarshalIndent(scenario.Second, "", "  ")
				t.Fatalf("second settings backup differs from pinned Node:\n got: %s\nwant: %s", gotJSON, wantJSON)
			}
		})
	}
}

func observeSettingsBackup(t *testing.T, errorCount int, userRoot, backupsDirectory string) settingsBackupObservation {
	t.Helper()
	state := settingsBackupFilesystem{
		Backups: []settingsBackupEntry{},
	}
	if info, err := os.Stat(userRoot); err == nil {
		state.RootExists = info.IsDir()
	} else if !os.IsNotExist(err) {
		t.Fatal(err)
	}
	if state.RootExists {
		if body, err := os.ReadFile(filepath.Join(userRoot, settingsFilename)); err == nil {
			state.Settings = settingsBackupString(string(body))
		} else if !os.IsNotExist(err) {
			t.Fatal(err)
		}
	}
	if info, err := os.Stat(backupsDirectory); err == nil {
		state.BackupsDirectoryExists = info.IsDir()
		if state.BackupsDirectoryExists {
			entries, err := os.ReadDir(backupsDirectory)
			if err != nil {
				t.Fatal(err)
			}
			for _, entry := range entries {
				if !entry.Type().IsRegular() {
					continue
				}
				body, err := os.ReadFile(filepath.Join(backupsDirectory, entry.Name()))
				if err != nil {
					t.Fatal(err)
				}
				name := settingsBackupTimestampPattern.ReplaceAllString(entry.Name(), "settings_default-user_<timestamp>.json")
				state.Backups = append(state.Backups, settingsBackupEntry{Name: name, Contents: string(body)})
			}
			sort.SliceStable(state.Backups, func(left, right int) bool { return state.Backups[left].Name < state.Backups[right].Name })
		}
	} else if !os.IsNotExist(err) {
		t.Fatal(err)
	}
	return settingsBackupObservation{ErrorCount: errorCount, State: state}
}

var settingsBackupTimestampPattern = regexp.MustCompile(`settings_default-user_\d{8}-\d{6}\.json`)

func settingsBackupString(value string) *string { return &value }

func TestBackupSettingsStopsAfterFirstUserError(t *testing.T) {
	dataRoot := t.TempDir()
	firstRoot := filepath.Join(dataRoot, "first-user")
	if err := os.MkdirAll(firstRoot, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(firstRoot, settingsFilename), []byte("first"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(firstRoot, "backups"), 0o755); err != nil {
		t.Fatal(err)
	}
	secondRoot := filepath.Join(dataRoot, "second-user")
	if err := os.MkdirAll(secondRoot, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(secondRoot, settingsFilename), []byte("second"), 0o600); err != nil {
		t.Fatal(err)
	}

	users := []UserDirectories{
		{"root": firstRoot, "backups": filepath.Join(firstRoot, "backups")},
		{"root": secondRoot},
	}
	errorsFound := BackupSettings(users, 50)
	if len(errorsFound) != 1 {
		t.Fatalf("expected one error from the first bad user, got %d", len(errorsFound))
	}
	firstEntries, err := os.ReadDir(filepath.Join(firstRoot, "backups"))
	if err != nil {
		t.Fatal(err)
	}
	if len(firstEntries) != 1 {
		t.Fatalf("first user's successful backup was not kept before the later error: %v", firstEntries)
	}
	if _, err := os.Stat(filepath.Join(secondRoot, "backups")); !os.IsNotExist(err) {
		t.Fatalf("processing continued after the first user error: %v", err)
	}
}
