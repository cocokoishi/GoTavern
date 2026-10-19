package startup

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"testing"
)

type flatSecretsOracle struct {
	SchemaVersion int `json:"schemaVersion"`
	Baseline      struct {
		Version string `json:"version"`
		Commit  string `json:"commit"`
	} `json:"baseline"`
	Scenarios map[string]flatSecretsOracleScenario `json:"scenarios"`
	RoundTrip struct {
		GoErrors                      []string          `json:"goErrors"`
		NodeReadActiveSecrets         map[string]string `json:"nodeReadActiveSecrets"`
		NodeReadMigratedMarkerIsArray bool              `json:"nodeReadMigratedMarkerIsArray"`
		NodeReadSecretKeys            []string          `json:"nodeReadSecretKeys"`
		BackupNames                   []string          `json:"backupNames"`
		BackupMatchesOriginal         bool              `json:"backupMatchesOriginal"`
	} `json:"roundTrip"`
}

type flatSecretsOracleScenario struct {
	Inputs []flatSecretsInput  `json:"inputs"`
	First  flatSecretsSnapshot `json:"first"`
	Second flatSecretsSnapshot `json:"second"`
}

type flatSecretsInput struct {
	Handle  string  `json:"handle"`
	Secrets *string `json:"secrets"`
}

type flatSecretsSnapshot struct {
	Events []struct {
		Level string `json:"level"`
	} `json:"events"`
	Users []flatSecretsUserSnapshot `json:"users"`
}

type flatSecretsUserSnapshot struct {
	Handle  string              `json:"handle"`
	Secrets *string             `json:"secrets"`
	Backups []flatSecretsBackup `json:"backups"`
}

type flatSecretsBackup struct {
	Name     string `json:"name"`
	Contents string `json:"contents"`
}

var flatSecretUUIDPattern = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

func TestMigrateFlatSecretsMatchesPinnedNode(t *testing.T) {
	body, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-flat-secrets.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture flatSecretsOracle
	if err := json.Unmarshal(body, &fixture); err != nil {
		t.Fatal(err)
	}
	if fixture.SchemaVersion != 1 || fixture.Baseline.Version != "1.19.0" || fixture.Baseline.Commit != "06bde939fb1e9c4c8d8641d810f0a916b5bce127" {
		t.Fatalf("unexpected flat-secrets oracle baseline: %#v", fixture.Baseline)
	}
	if len(fixture.Scenarios) < 8 {
		t.Fatalf("flat-secrets oracle has only %d scenarios", len(fixture.Scenarios))
	}
	if len(fixture.RoundTrip.GoErrors) != 0 || !fixture.RoundTrip.NodeReadMigratedMarkerIsArray || !fixture.RoundTrip.BackupMatchesOriginal ||
		!reflect.DeepEqual(fixture.RoundTrip.NodeReadActiveSecrets, map[string]string{"api_key_openai": "round-trip-secret-value"}) ||
		!reflect.DeepEqual(fixture.RoundTrip.NodeReadSecretKeys, []string{"api_key_openai", "_migrated"}) ||
		!reflect.DeepEqual(fixture.RoundTrip.BackupNames, []string{"secrets_migration_<timestamp>.json"}) {
		t.Fatalf("flat-secrets Node-to-Go-to-Node round trip is incomplete: %#v", fixture.RoundTrip)
	}

	for scenarioName, scenario := range fixture.Scenarios {
		t.Run(scenarioName, func(t *testing.T) {
			dataRoot := filepath.Join(t.TempDir(), "data")
			directories := make([]UserDirectories, 0, len(scenario.Inputs))
			for _, input := range scenario.Inputs {
				userRoot := filepath.Join(dataRoot, input.Handle)
				backups := filepath.Join(userRoot, "backups")
				if err := os.MkdirAll(backups, 0o755); err != nil {
					t.Fatal(err)
				}
				if input.Secrets != nil {
					if err := os.WriteFile(filepath.Join(userRoot, "secrets.json"), []byte(*input.Secrets), 0o600); err != nil {
						t.Fatal(err)
					}
				}
				directories = append(directories, UserDirectories{"root": userRoot, "backups": backups})
			}

			firstErrors := MigrateFlatSecrets(directories)
			if len(firstErrors) != flatSecretsWarningCount(scenario.First) {
				t.Fatalf("first migration returned %d errors, pinned Node warned %d times: %v", len(firstErrors), flatSecretsWarningCount(scenario.First), firstErrors)
			}
			if got := snapshotFlatSecrets(t, dataRoot, scenario.Inputs); !reflect.DeepEqual(got, scenario.First.Users) {
				gotJSON, _ := json.MarshalIndent(got, "", "  ")
				wantJSON, _ := json.MarshalIndent(scenario.First.Users, "", "  ")
				t.Fatalf("first migration differs from pinned Node:\n got: %s\nwant: %s", gotJSON, wantJSON)
			}

			secondErrors := MigrateFlatSecrets(directories)
			if len(secondErrors) != flatSecretsWarningCount(scenario.Second) {
				t.Fatalf("second migration returned %d errors, pinned Node warned %d times: %v", len(secondErrors), flatSecretsWarningCount(scenario.Second), secondErrors)
			}
			if got := snapshotFlatSecrets(t, dataRoot, scenario.Inputs); !reflect.DeepEqual(got, scenario.Second.Users) {
				gotJSON, _ := json.MarshalIndent(got, "", "  ")
				wantJSON, _ := json.MarshalIndent(scenario.Second.Users, "", "  ")
				t.Fatalf("second migration differs from pinned Node:\n got: %s\nwant: %s", gotJSON, wantJSON)
			}
		})
	}
}

func flatSecretsWarningCount(snapshot flatSecretsSnapshot) int {
	count := 0
	for _, event := range snapshot.Events {
		if event.Level == "warn" {
			count++
		}
	}
	return count
}

func snapshotFlatSecrets(t *testing.T, dataRoot string, inputs []flatSecretsInput) []flatSecretsUserSnapshot {
	t.Helper()
	users := make([]flatSecretsUserSnapshot, 0, len(inputs))
	for _, input := range inputs {
		userRoot := filepath.Join(dataRoot, input.Handle)
		secretPath := filepath.Join(userRoot, "secrets.json")
		var secrets *string
		body, err := os.ReadFile(secretPath)
		if err == nil {
			normalized := normalizeFlatSecretsJSON(body)
			secrets = &normalized
		} else if !os.IsNotExist(err) {
			t.Fatalf("read secrets file for %s: %v", input.Handle, err)
		}

		backupsDirectory := filepath.Join(userRoot, "backups")
		entries, err := os.ReadDir(backupsDirectory)
		if err != nil {
			t.Fatalf("read secrets backup directory for %s: %v", input.Handle, err)
		}
		backups := make([]flatSecretsBackup, 0, len(entries))
		for _, entry := range entries {
			backupBody, err := os.ReadFile(filepath.Join(backupsDirectory, entry.Name()))
			if err != nil {
				t.Fatalf("read secrets backup %s: %v", entry.Name(), err)
			}
			backups = append(backups, flatSecretsBackup{
				Name:     normalizeFlatSecretsBackupName(entry.Name()),
				Contents: string(backupBody),
			})
		}
		sortFlatSecretsBackups(backups)
		users = append(users, flatSecretsUserSnapshot{Handle: input.Handle, Secrets: secrets, Backups: backups})
	}
	return users
}

func normalizeFlatSecretsJSON(body []byte) string {
	value, err := decodeOrderedJSON(body)
	if err != nil {
		return string(body)
	}
	var normalize func(any)
	normalize = func(value any) {
		switch typed := value.(type) {
		case *orderedJSONObject:
			for index := range typed.members {
				member := &typed.members[index]
				if member.key == "id" {
					if identifier, ok := member.value.(nodeJSONString); ok && flatSecretUUIDPattern.MatchString(string(identifier)) {
						member.value = nodeJSONString("<uuid>")
						continue
					}
				}
				normalize(member.value)
			}
		case orderedJSONArray:
			for _, item := range typed {
				normalize(item)
			}
		}
	}
	normalize(value)
	normalized, err := marshalNodeJSONIndent(value)
	if err != nil {
		return string(body)
	}
	return string(normalized)
}

func normalizeFlatSecretsBackupName(name string) string {
	const prefix = "secrets_migration_"
	const suffix = ".json"
	if !strings.HasPrefix(name, prefix) || !strings.HasSuffix(name, suffix) {
		return name
	}
	timestamp := strings.TrimSuffix(strings.TrimPrefix(name, prefix), suffix)
	if len(timestamp) != 13 {
		return name
	}
	if _, err := strconv.ParseInt(timestamp, 10, 64); err != nil {
		return name
	}
	return prefix + "<timestamp>" + suffix
}

func sortFlatSecretsBackups(backups []flatSecretsBackup) {
	sort.Slice(backups, func(left, right int) bool { return backups[left].Name < backups[right].Name })
}
