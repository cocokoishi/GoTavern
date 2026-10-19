package startup

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"testing"
)

type uploadCleanupOracle struct {
	SchemaVersion int `json:"schemaVersion"`
	Baseline      struct {
		Version string `json:"version"`
		Commit  string `json:"commit"`
	} `json:"baseline"`
	Scenarios map[string]uploadCleanupScenario `json:"scenarios"`
}

type uploadCleanupScenario struct {
	Input  uploadCleanupInput       `json:"input"`
	First  uploadCleanupObservation `json:"first"`
	Second uploadCleanupObservation `json:"second"`
}

type uploadCleanupInput struct {
	Setup    string            `json:"setup"`
	Files    map[string]string `json:"files"`
	Contents string            `json:"contents"`
}

type uploadCleanupObservation struct {
	Debug      []string                `json:"debug"`
	ErrorCount int                     `json:"errorCount"`
	State      uploadCleanupFilesystem `json:"state"`
}

type uploadCleanupFilesystem struct {
	Exists      bool                     `json:"exists"`
	IsDirectory bool                     `json:"isDirectory"`
	Contents    *string                  `json:"contents"`
	Entries     []uploadCleanupTreeEntry `json:"entries"`
}

type uploadCleanupTreeEntry struct {
	Path     string  `json:"path"`
	Type     string  `json:"type"`
	Contents *string `json:"contents"`
}

func TestCleanUploadsMatchesPinnedNode(t *testing.T) {
	body, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-upload-cleanup.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture uploadCleanupOracle
	if err := json.Unmarshal(body, &fixture); err != nil {
		t.Fatal(err)
	}
	if fixture.SchemaVersion != 1 || fixture.Baseline.Version != "1.19.0" || fixture.Baseline.Commit != "06bde939fb1e9c4c8d8641d810f0a916b5bce127" {
		t.Fatalf("unexpected upload-cleanup oracle baseline: %#v", fixture.Baseline)
	}
	if len(fixture.Scenarios) < 5 {
		t.Fatalf("upload-cleanup oracle has only %d scenarios", len(fixture.Scenarios))
	}

	for scenarioName, scenario := range fixture.Scenarios {
		t.Run(scenarioName, func(t *testing.T) {
			dataRoot := filepath.Join(t.TempDir(), "data")
			if err := os.MkdirAll(dataRoot, 0o755); err != nil {
				t.Fatal(err)
			}
			uploadsPath := filepath.Join(dataRoot, "_uploads")
			switch scenario.Input.Setup {
			case "absent":
			case "empty":
				if err := os.MkdirAll(uploadsPath, 0o755); err != nil {
					t.Fatal(err)
				}
			case "files":
				if err := os.MkdirAll(uploadsPath, 0o755); err != nil {
					t.Fatal(err)
				}
				for name, contents := range scenario.Input.Files {
					if err := os.WriteFile(filepath.Join(uploadsPath, name), []byte(contents), 0o600); err != nil {
						t.Fatal(err)
					}
				}
			case "childDirectory":
				nested := filepath.Join(uploadsPath, "pending")
				if err := os.MkdirAll(nested, 0o755); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(filepath.Join(nested, "keep.tmp"), []byte("inside nested directory"), 0o600); err != nil {
					t.Fatal(err)
				}
			case "pathFile":
				if err := os.WriteFile(uploadsPath, []byte(scenario.Input.Contents), 0o600); err != nil {
					t.Fatal(err)
				}
			default:
				t.Fatalf("unknown upload-cleanup setup %q", scenario.Input.Setup)
			}

			first := CleanUploads(dataRoot)
			if got := observeUploadCleanup(t, first, uploadsPath); !reflect.DeepEqual(got, scenario.First) {
				gotJSON, _ := json.MarshalIndent(got, "", "  ")
				wantJSON, _ := json.MarshalIndent(scenario.First, "", "  ")
				t.Fatalf("first upload cleanup differs from pinned Node:\n got: %s\nwant: %s", gotJSON, wantJSON)
			}

			second := CleanUploads(dataRoot)
			if got := observeUploadCleanup(t, second, uploadsPath); !reflect.DeepEqual(got, scenario.Second) {
				gotJSON, _ := json.MarshalIndent(got, "", "  ")
				wantJSON, _ := json.MarshalIndent(scenario.Second, "", "  ")
				t.Fatalf("second upload cleanup differs from pinned Node:\n got: %s\nwant: %s", gotJSON, wantJSON)
			}
		})
	}
}

func observeUploadCleanup(t *testing.T, result UploadCleanupResult, uploadsPath string) uploadCleanupObservation {
	t.Helper()
	observation := uploadCleanupObservation{Debug: []string{}, ErrorCount: len(result.Errors)}
	if result.Count > 0 {
		observation.Debug = append(observation.Debug, fmt.Sprintf("Cleaning uploads folder (%d files)", result.Count))
	}
	state := &observation.State
	info, err := os.Stat(uploadsPath)
	if os.IsNotExist(err) {
		state.Entries = []uploadCleanupTreeEntry{}
		return observation
	}
	if err != nil {
		t.Fatal(err)
	}
	state.Exists = true
	if !info.IsDir() {
		state.Contents = uploadCleanupString(readUploadFile(t, uploadsPath))
		state.Entries = []uploadCleanupTreeEntry{}
		return observation
	}
	state.IsDirectory = true
	state.Entries = snapshotUploadTree(t, uploadsPath, "")
	return observation
}

func snapshotUploadTree(t *testing.T, directory, prefix string) []uploadCleanupTreeEntry {
	t.Helper()
	entries, err := os.ReadDir(directory)
	if err != nil {
		t.Fatal(err)
	}
	output := make([]uploadCleanupTreeEntry, 0)
	for _, entry := range entries {
		relative := entry.Name()
		if prefix != "" {
			relative = prefix + "/" + entry.Name()
		}
		info, err := os.Lstat(filepath.Join(directory, entry.Name()))
		if err != nil {
			t.Fatal(err)
		}
		if info.IsDir() {
			output = append(output, uploadCleanupTreeEntry{Path: relative, Type: "directory"})
			output = append(output, snapshotUploadTree(t, filepath.Join(directory, entry.Name()), relative)...)
			continue
		}
		contents := readUploadFile(t, filepath.Join(directory, entry.Name()))
		output = append(output, uploadCleanupTreeEntry{Path: relative, Type: "file", Contents: uploadCleanupString(contents)})
	}
	sort.Slice(output, func(left, right int) bool { return output[left].Path < output[right].Path })
	return output
}

func readUploadFile(t *testing.T, filePath string) string {
	t.Helper()
	body, err := os.ReadFile(filePath)
	if err != nil {
		t.Fatal(err)
	}
	return string(body)
}

func uploadCleanupString(value string) *string {
	return &value
}
