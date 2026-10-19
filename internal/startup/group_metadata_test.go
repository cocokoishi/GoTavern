package startup

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"testing"
)

type groupMetadataMigrationOracle struct {
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

func TestMigrateGroupChatsMetadataFormatMatchesPinnedNode(t *testing.T) {
	body, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-group-metadata-migration.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture groupMetadataMigrationOracle
	if err := json.Unmarshal(body, &fixture); err != nil {
		t.Fatal(err)
	}
	if fixture.SchemaVersion != 1 || fixture.Baseline.Commit != "06bde939fb1e9c4c8d8641d810f0a916b5bce127" {
		t.Fatalf("unexpected group-metadata migration oracle baseline: %#v", fixture.Baseline)
	}
	if len(fixture.Scenarios) != 2 {
		t.Fatalf("oracle has %d scenarios, want noChanges and legacy", len(fixture.Scenarios))
	}

	for _, scenarioName := range []string{"noChanges", "legacy"} {
		scenario := fixture.Scenarios[scenarioName]
		t.Run(scenarioName, func(t *testing.T) {
			installRoot := filepath.Join(t.TempDir(), "install")
			dataRoot := filepath.Join(installRoot, "data")
			handles, err := InitializeUserStorage(dataRoot)
			if err != nil {
				t.Fatal(err)
			}
			directories, err := EnsureDirectories(installRoot, dataRoot, handles)
			if err != nil {
				t.Fatal(err)
			}
			for relative, content := range scenario.Inputs {
				target := filepath.Join(dataRoot, defaultHandle, filepath.FromSlash(relative))
				if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(target, []byte(content), 0o600); err != nil {
					t.Fatal(err)
				}
			}

			migrationErrors, err := MigrateGroupChatsMetadataFormat(directories)
			if err != nil {
				t.Fatal(err)
			}
			if len(migrationErrors) != 0 {
				t.Fatalf("group-metadata migration errors: %v", migrationErrors)
			}
			got := snapshotGroupMetadataTree(t, dataRoot)
			if !reflect.DeepEqual(got, scenario.Tree) {
				gotJSON, _ := json.MarshalIndent(got, "", "  ")
				wantJSON, _ := json.MarshalIndent(scenario.Tree, "", "  ")
				t.Fatalf("filesystem differs from pinned Node migration:\n got: %s\nwant: %s", gotJSON, wantJSON)
			}

			if migrationErrors, err := MigrateGroupChatsMetadataFormat(directories); err != nil || len(migrationErrors) != 0 {
				t.Fatalf("second migration returned errors %v, %v", migrationErrors, err)
			}
			if second := snapshotGroupMetadataTree(t, dataRoot); !reflect.DeepEqual(second, scenario.Tree) {
				t.Fatal("second migration changed the group and chat files")
			}
		})
	}
}

func snapshotGroupMetadataTree(t *testing.T, dataRoot string) []migrationTreeEntry {
	t.Helper()
	entries := make([]migrationTreeEntry, 0)
	for _, relativeRoot := range []string{
		filepath.Join(defaultHandle, "groups"),
		filepath.Join(defaultHandle, "group chats"),
		filepath.Join(defaultHandle, "backups"),
	} {
		root := filepath.Join(dataRoot, relativeRoot)
		err := filepath.WalkDir(root, func(current string, entry os.DirEntry, walkErr error) error {
			if walkErr != nil {
				return walkErr
			}
			relative, err := filepath.Rel(dataRoot, current)
			if err != nil {
				return err
			}
			observation := migrationTreeEntry{Path: filepath.ToSlash(relative)}
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
