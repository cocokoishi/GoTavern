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

type publicOverridesMigrationOracle struct {
	SchemaVersion int `json:"schemaVersion"`
	Baseline      struct {
		Version string `json:"version"`
		Commit  string `json:"commit"`
	} `json:"baseline"`
	Scenarios map[string]struct {
		Inputs struct {
			Sources              map[string]string `json:"sources"`
			Destinations         map[string]string `json:"destinations"`
			ReadOnlySources      []string          `json:"readOnlySources"`
			ReadOnlyDestinations []string          `json:"readOnlyDestinations"`
		} `json:"inputs"`
		Tree []migrationTreeEntry `json:"tree"`
	} `json:"scenarios"`
}

func TestMigratePublicOverridesMatchesPinnedNode(t *testing.T) {
	body, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-public-overrides-migration.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture publicOverridesMigrationOracle
	if err := json.Unmarshal(body, &fixture); err != nil {
		t.Fatal(err)
	}
	if fixture.SchemaVersion != 1 || fixture.Baseline.Commit != "06bde939fb1e9c4c8d8641d810f0a916b5bce127" {
		t.Fatalf("unexpected public-overrides migration oracle baseline: %#v", fixture.Baseline)
	}
	if len(fixture.Scenarios) != 2 {
		t.Fatalf("oracle has %d scenarios, want noOverrides and mixed", len(fixture.Scenarios))
	}

	for _, scenarioName := range []string{"noOverrides", "mixed"} {
		scenario := fixture.Scenarios[scenarioName]
		t.Run(scenarioName, func(t *testing.T) {
			installRoot := filepath.Join(t.TempDir(), "install")
			dataRoot := filepath.Join(installRoot, "data")
			if err := os.MkdirAll(dataRoot, 0o755); err != nil {
				t.Fatal(err)
			}
			for relative, content := range scenario.Inputs.Sources {
				target := filepath.Join(installRoot, filepath.FromSlash(relative))
				if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(target, []byte(content), 0o600); err != nil {
					t.Fatal(err)
				}
			}
			for relative, content := range scenario.Inputs.Destinations {
				target := filepath.Join(installRoot, filepath.FromSlash(relative))
				if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(target, []byte(content), 0o600); err != nil {
					t.Fatal(err)
				}
			}
			for _, relative := range scenario.Inputs.ReadOnlySources {
				if err := os.Chmod(filepath.Join(installRoot, filepath.FromSlash(relative)), 0o400); err != nil {
					t.Fatal(err)
				}
			}
			for _, relative := range scenario.Inputs.ReadOnlyDestinations {
				if err := os.Chmod(filepath.Join(installRoot, filepath.FromSlash(relative)), 0o400); err != nil {
					t.Fatal(err)
				}
			}

			migrationErrors, err := MigratePublicOverrides(installRoot, dataRoot)
			if err != nil {
				t.Fatal(err)
			}
			if len(migrationErrors) != 0 {
				t.Fatalf("public-overrides migration errors: %v", migrationErrors)
			}
			got := snapshotPublicOverridesTree(t, installRoot)
			if !reflect.DeepEqual(got, scenario.Tree) {
				gotJSON, _ := json.MarshalIndent(got, "", "  ")
				wantJSON, _ := json.MarshalIndent(scenario.Tree, "", "  ")
				t.Fatalf("filesystem differs from pinned Node migration:\n got: %s\nwant: %s", gotJSON, wantJSON)
			}

			if migrationErrors, err := MigratePublicOverrides(installRoot, dataRoot); err != nil || len(migrationErrors) != 0 {
				t.Fatalf("second migration returned errors %v, %v", migrationErrors, err)
			}
			if second := snapshotPublicOverridesTree(t, installRoot); !reflect.DeepEqual(second, scenario.Tree) {
				t.Fatal("second migration changed files after destination precedence took effect")
			}
		})
	}
}

func snapshotPublicOverridesTree(t *testing.T, installRoot string) []migrationTreeEntry {
	t.Helper()
	entries := make([]migrationTreeEntry, 0)
	for _, relativeRoot := range []string{
		filepath.Join("public", "error"),
		filepath.Join("public", "css", "user.css"),
		filepath.Join("data", "_errors"),
		filepath.Join("data", "_css"),
	} {
		root := filepath.Join(installRoot, relativeRoot)
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
				ownerWritable := info.Mode().Perm()&0o200 != 0
				observation.OwnerWritable = &ownerWritable
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

func TestMigratePublicOverridesRejectsSymlinkEscapeAndContinues(t *testing.T) {
	root := t.TempDir()
	installRoot := filepath.Join(root, "install")
	dataRoot := filepath.Join(installRoot, "data")
	outside := filepath.Join(root, "outside")
	if err := os.MkdirAll(filepath.Join(installRoot, "public", "error"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(installRoot, "public", "css"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(dataRoot, "_errors"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(outside, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(dataRoot, "_errors")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(dataRoot, "_errors")); err != nil {
		t.Skipf("directory symlinks unavailable: %v", err)
	}
	for relative, content := range map[string]string{
		"public/error/forbidden-by-whitelist.html": "blocked override",
		"public/css/user.css":                      "body { --user-css: true; }",
	} {
		if err := os.WriteFile(filepath.Join(installRoot, relative), []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}

	migrationErrors, err := MigratePublicOverrides(installRoot, dataRoot)
	if err != nil {
		t.Fatal(err)
	}
	if len(migrationErrors) != 1 {
		t.Fatalf("migration errors = %v, want one blocked error-page destination", migrationErrors)
	}
	if _, err := os.Stat(filepath.Join(installRoot, "public", "error", "forbidden-by-whitelist.html")); err != nil {
		t.Fatalf("blocked source override was removed: %v", err)
	}
	if _, err := os.Stat(filepath.Join(outside, "forbidden-by-whitelist.html")); !os.IsNotExist(err) {
		t.Fatalf("migration wrote outside the data root: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dataRoot, "_css", "user.css")); err != nil {
		t.Fatalf("migration stopped after the blocked error page instead of moving CSS: %v", err)
	}
	if _, err := os.Stat(filepath.Join(installRoot, "public", "css", "user.css")); !os.IsNotExist(err) {
		t.Fatalf("successfully migrated CSS source remains: %v", err)
	}
}
