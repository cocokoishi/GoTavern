package startup

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"testing"
	"time"
)

type characterDiskCacheFixture struct {
	SchemaVersion int `json:"schemaVersion"`
	Baseline      struct {
		Version string `json:"version"`
		Commit  string `json:"commit"`
	} `json:"baseline"`
	Scenarios map[string]characterDiskCacheObservation `json:"scenarios"`
}

type characterDiskCacheObservation struct {
	Errors               []string                   `json:"errors"`
	CacheDirectoryExists bool                       `json:"cacheDirectoryExists"`
	Records              []characterDiskCacheRecord `json:"records"`
	Values               map[string]any             `json:"values"`
}

type characterDiskCacheRecord struct {
	Name  string `json:"name"`
	Value any    `json:"value"`
}

type characterDiskCacheSeed struct {
	name string
	kind string
	file string
}

func TestVerifyCharacterDiskCacheMatchesPinnedNode(t *testing.T) {
	body, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-character-disk-cache.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture characterDiskCacheFixture
	if err := json.Unmarshal(body, &fixture); err != nil {
		t.Fatal(err)
	}
	if fixture.SchemaVersion != 1 || fixture.Baseline.Version != "1.19.0" || fixture.Baseline.Commit != "06bde939fb1e9c4c8d8641d810f0a916b5bce127" {
		t.Fatalf("unexpected character disk-cache oracle baseline: %#v", fixture.Baseline)
	}

	for _, scenarioName := range []string{"disabled", "empty", "prune"} {
		want, exists := fixture.Scenarios[scenarioName]
		if !exists {
			t.Fatalf("character disk-cache oracle is missing scenario %q", scenarioName)
		}
		t.Run(scenarioName, func(t *testing.T) {
			useDiskCache := scenarioName != "disabled"
			characterFiles := map[string]string{}
			seeds := []characterDiskCacheSeed(nil)
			if scenarioName == "prune" {
				characterFiles = map[string]string{
					"valid.png":          "png card bytes",
					"ignored.jpg":        "jpeg bytes",
					"upper.PNG":          "uppercase extension bytes",
					"nested/ignored.png": "nested card bytes",
				}
				seeds = []characterDiskCacheSeed{
					{name: "valid", kind: "character", file: "valid.png"},
					{name: "jpg", kind: "character", file: "ignored.jpg"},
					{name: "stale", kind: "missing"},
					{name: "shadow", kind: "shadow"},
				}
			}

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
			characterDirectory := directories[0]["characters"]
			for relative, contents := range characterFiles {
				target := filepath.Join(characterDirectory, filepath.FromSlash(relative))
				if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(target, []byte(contents), 0o600); err != nil {
					t.Fatal(err)
				}
				fixedTime := time.UnixMilli(1_700_000_000_000)
				if err := os.Chtimes(target, fixedTime, fixedTime); err != nil {
					t.Fatal(err)
				}
			}

			cacheDirectory := filepath.Join(dataRoot, "_cache", "characters")
			originalKeys := make(map[string]string, len(seeds))
			if useDiskCache && len(seeds) > 0 {
				if err := os.MkdirAll(cacheDirectory, 0o755); err != nil {
					t.Fatal(err)
				}
				for _, seed := range seeds {
					key := characterDiskCacheSeedKey(t, characterDirectory, seed)
					originalKeys[seed.name] = key
					value, err := json.Marshal(map[string]string{"marker": seed.name})
					if err != nil {
						t.Fatal(err)
					}
					record, err := json.Marshal(storeEntry{Key: key, Value: value})
					if err != nil {
						t.Fatal(err)
					}
					if err := os.WriteFile(filepath.Join(cacheDirectory, storeFilename(key)), record, 0o600); err != nil {
						t.Fatal(err)
					}
				}
			}

			if errors := VerifyCharacterDiskCache(dataRoot, directories, useDiskCache); len(errors) != 0 {
				t.Fatalf("character disk-cache verification returned errors: %v", errors)
			}
			got := observeCharacterDiskCache(t, cacheDirectory, originalKeys)
			if !reflect.DeepEqual(got, want) {
				gotJSON, _ := json.MarshalIndent(got, "", "  ")
				wantJSON, _ := json.MarshalIndent(want, "", "  ")
				t.Fatalf("character disk-cache filesystem differs from pinned Node:\n got: %s\nwant: %s", gotJSON, wantJSON)
			}

			if errors := VerifyCharacterDiskCache(dataRoot, directories, useDiskCache); len(errors) != 0 {
				t.Fatalf("second character disk-cache verification returned errors: %v", errors)
			}
			if second := observeCharacterDiskCache(t, cacheDirectory, originalKeys); !reflect.DeepEqual(second, want) {
				t.Fatal("second character disk-cache verification changed the observation")
			}
		})
	}
}

func characterDiskCacheSeedKey(t *testing.T, characterDirectory string, seed characterDiskCacheSeed) string {
	t.Helper()
	switch seed.kind {
	case "character":
		filePath := filepath.Join(characterDirectory, seed.file)
		info, err := os.Stat(filePath)
		if err != nil {
			t.Fatal(err)
		}
		mtimeMS := float64(info.ModTime().UnixNano()) / 1e6
		return filePath + "-" + javascriptNumberString(mtimeMS)
	case "missing":
		return fmt.Sprintf("missing-character-%s-1700000000000", seed.name)
	case "shadow":
		staleKey := "missing-character-stale-1700000000000"
		digest := sha256.Sum256([]byte(staleKey))
		return hex.EncodeToString(digest[:])
	default:
		t.Fatalf("unknown character disk-cache seed kind %q", seed.kind)
		return ""
	}
}

func observeCharacterDiskCache(t *testing.T, cacheDirectory string, originalKeys map[string]string) characterDiskCacheObservation {
	t.Helper()
	observation := characterDiskCacheObservation{
		Errors:  []string{},
		Records: []characterDiskCacheRecord{},
		Values:  make(map[string]any, len(originalKeys)),
	}
	if _, err := os.Stat(cacheDirectory); err == nil {
		observation.CacheDirectoryExists = true
	} else if !os.IsNotExist(err) {
		t.Fatal(err)
	}

	keysByRecord := make(map[string]string, len(originalKeys))
	for name, key := range originalKeys {
		keysByRecord[storeFilename(key)] = name
		observation.Values[name] = nil
	}
	if observation.CacheDirectoryExists {
		entries, err := os.ReadDir(cacheDirectory)
		if err != nil {
			t.Fatal(err)
		}
		for _, entry := range entries {
			body, err := os.ReadFile(filepath.Join(cacheDirectory, entry.Name()))
			if err != nil {
				t.Fatal(err)
			}
			var stored storeEntry
			if err := json.Unmarshal(body, &stored); err != nil {
				t.Fatalf("decode node-persist-compatible record %s: %v", entry.Name(), err)
			}
			name := keysByRecord[entry.Name()]
			if name == "" {
				name = "other"
			}
			var value any
			if err := json.Unmarshal(stored.Value, &value); err != nil {
				t.Fatalf("decode value in cache record %s: %v", entry.Name(), err)
			}
			observation.Records = append(observation.Records, characterDiskCacheRecord{Name: name, Value: value})
			if originalKey, exists := originalKeys[name]; exists && originalKey == stored.Key {
				observation.Values[name] = value
			}
		}
	}
	sort.Slice(observation.Records, func(left, right int) bool {
		return observation.Records[left].Name < observation.Records[right].Name
	})
	return observation
}
