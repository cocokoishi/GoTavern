package startup

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"
)

type userDataMigrationOracle struct {
	SchemaVersion int `json:"schemaVersion"`
	Baseline      struct {
		Version string `json:"version"`
		Commit  string `json:"commit"`
	} `json:"baseline"`
	Scenarios map[string]struct {
		Inputs map[string]string    `json:"inputs"`
		Tree   []migrationTreeEntry `json:"tree"`
	} `json:"scenarios"`
}

func TestMigrateUserDataMatchesPinnedNode(t *testing.T) {
	body, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-user-data-migration.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture userDataMigrationOracle
	if err := json.Unmarshal(body, &fixture); err != nil {
		t.Fatal(err)
	}
	if fixture.SchemaVersion != 1 || fixture.Baseline.Commit != "06bde939fb1e9c4c8d8641d810f0a916b5bce127" {
		t.Fatalf("unexpected user-data migration oracle baseline: %#v", fixture.Baseline)
	}
	if len(fixture.Scenarios) != 2 {
		t.Fatalf("oracle has %d scenarios, want noLegacyCharacters and legacy", len(fixture.Scenarios))
	}

	for _, scenarioName := range []string{"noLegacyCharacters", "legacy"} {
		scenario := fixture.Scenarios[scenarioName]
		t.Run(scenarioName, func(t *testing.T) {
			installRoot := filepath.Join(t.TempDir(), "install")
			dataRoot := filepath.Join(installRoot, "data")
			handles, err := InitializeUserStorage(dataRoot)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := EnsureDirectories(installRoot, dataRoot, handles); err != nil {
				t.Fatal(err)
			}
			utcDate := time.Now().UTC().Format("2006-01-02")
			for relative, content := range scenario.Inputs {
				relative = strings.ReplaceAll(relative, "__UTC_DATE__", utcDate)
				target := filepath.Join(installRoot, filepath.FromSlash(relative))
				if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(target, []byte(content), 0o600); err != nil {
					t.Fatal(err)
				}
			}

			var delays []time.Duration
			migrationErrors, err := MigrateUserData(installRoot, dataRoot, func(delay time.Duration) {
				delays = append(delays, delay)
			})
			if err != nil {
				t.Fatal(err)
			}
			if len(migrationErrors) != 0 {
				t.Fatalf("user-data migration errors: %v", migrationErrors)
			}
			wantDelays := []time.Duration(nil)
			if scenarioName == "legacy" {
				wantDelays = []time.Duration{userDataMigrationDelay}
			}
			if !reflect.DeepEqual(delays, wantDelays) {
				t.Fatalf("migration delays = %v, want %v", delays, wantDelays)
			}

			got := snapshotUserDataMigrationTree(t, installRoot)
			if !reflect.DeepEqual(got, scenario.Tree) {
				gotJSON, _ := json.MarshalIndent(got, "", "  ")
				wantJSON, _ := json.MarshalIndent(scenario.Tree, "", "  ")
				t.Fatalf("filesystem differs from pinned Node migration:\n got: %s\nwant: %s", gotJSON, wantJSON)
			}

			// Successful migration removes its legacy character directory, so a
			// subsequent startup takes the pinned no-legacy fast path.
			if migrationErrors, err := MigrateUserData(installRoot, dataRoot, func(delay time.Duration) {
				t.Errorf("second migration unexpectedly delayed for %s", delay)
			}); err != nil || len(migrationErrors) != 0 {
				t.Fatalf("second migration returned errors %v, %v", migrationErrors, err)
			}
			if second := snapshotUserDataMigrationTree(t, installRoot); !reflect.DeepEqual(second, scenario.Tree) {
				t.Fatal("second migration changed files after moving the legacy characters directory")
			}
		})
	}
}

func snapshotUserDataMigrationTree(t *testing.T, installRoot string) []migrationTreeEntry {
	t.Helper()
	var entries []migrationTreeEntry
	for _, relativeRoot := range []string{"public", "thumbnails", "vectors", "secrets.json", "data/default-user", "backups"} {
		root := filepath.Join(installRoot, filepath.FromSlash(relativeRoot))
		if _, err := os.Lstat(root); os.IsNotExist(err) {
			continue
		} else if err != nil {
			t.Fatalf("inspect %s: %v", relativeRoot, err)
		}
		err := filepath.WalkDir(root, func(current string, entry os.DirEntry, walkErr error) error {
			if walkErr != nil {
				return walkErr
			}
			relative, err := filepath.Rel(installRoot, current)
			if err != nil {
				return err
			}
			relative = filepath.ToSlash(relative)
			relative = strings.ReplaceAll(relative, "backups/_migration/"+time.Now().UTC().Format("2006-01-02"), "backups/_migration/<date>")
			observation := migrationTreeEntry{Path: relative}
			if entry.IsDir() {
				observation.Type = "directory"
			} else {
				info, err := entry.Info()
				if err != nil {
					return err
				}
				if !info.Mode().IsRegular() {
					return os.ErrInvalid
				}
				body, err := os.ReadFile(current)
				if err != nil {
					return err
				}
				digest := sha256.Sum256(body)
				observation.Type = "file"
				observation.Bytes = len(body)
				observation.SHA256 = hex.EncodeToString(digest[:])
			}
			entries = append(entries, observation)
			return nil
		})
		if err != nil {
			t.Fatalf("snapshot %s: %v", relativeRoot, err)
		}
	}
	sort.Slice(entries, func(left, right int) bool { return entries[left].Path < entries[right].Path })
	return entries
}

func TestMigrateUserDataRejectsTargetSymlinkEscapeAndContinues(t *testing.T) {
	root := t.TempDir()
	installRoot := filepath.Join(root, "install")
	dataRoot := filepath.Join(installRoot, "data")
	handles, err := InitializeUserStorage(dataRoot)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := EnsureDirectories(installRoot, dataRoot, handles); err != nil {
		t.Fatal(err)
	}

	outside := filepath.Join(root, "outside")
	if err := os.MkdirAll(outside, 0o755); err != nil {
		t.Fatal(err)
	}
	assetsDirectory := filepath.Join(dataRoot, defaultHandle, "assets")
	if err := os.Remove(assetsDirectory); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, assetsDirectory); err != nil {
		t.Skipf("directory symlinks unavailable: %v", err)
	}

	legacyAssets := filepath.Join(installRoot, "public", "assets")
	if err := os.MkdirAll(legacyAssets, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(legacyAssets, "payload.json"), []byte(`{"legacy":true}`), 0o600); err != nil {
		t.Fatal(err)
	}
	legacyCharacters := filepath.Join(installRoot, "public", "characters", "Alice")
	if err := os.MkdirAll(legacyCharacters, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(legacyCharacters, "card.json"), []byte(`{"name":"Alice"}`), 0o600); err != nil {
		t.Fatal(err)
	}

	migrationErrors, err := MigrateUserData(installRoot, dataRoot, func(time.Duration) {})
	if err != nil {
		t.Fatal(err)
	}
	if len(migrationErrors) != 1 {
		t.Fatalf("migration errors = %v, want the single unsafe-assets-target error", migrationErrors)
	}
	if _, err := os.Stat(filepath.Join(legacyAssets, "payload.json")); err != nil {
		t.Fatalf("source assets were removed after the blocked copy: %v", err)
	}
	if _, err := os.Stat(filepath.Join(outside, "payload.json")); !os.IsNotExist(err) {
		t.Fatalf("migration wrote outside the default user's data root: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dataRoot, defaultHandle, "characters", "Alice", "card.json")); err != nil {
		t.Fatalf("migration stopped after one item error instead of continuing: %v", err)
	}
	if _, err := os.Stat(filepath.Join(installRoot, "public", "characters")); !os.IsNotExist(err) {
		t.Fatalf("successfully migrated character source remains: %v", err)
	}
}
