package configinit

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

type oracleFixture struct {
	Scenarios map[string]oracleScenario `json:"scenarios"`
}

type oracleScenario struct {
	Input       *string            `json:"input"`
	OutputYAML  string             `json:"outputYaml"`
	Bytes       int                `json:"bytes"`
	SHA256      string             `json:"sha256"`
	Environment map[string]*string `json:"environment"`
}

func readOracleFixture(t *testing.T) oracleFixture {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-config-init.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture oracleFixture
	if err := json.Unmarshal(data, &fixture); err != nil {
		t.Fatal(err)
	}
	return fixture
}

func verifyScenarioBytes(t *testing.T, path string, expected oracleScenario) []byte {
	t.Helper()
	actual, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(actual) != expected.Bytes {
		t.Fatalf("config size: got %d, Node oracle has %d", len(actual), expected.Bytes)
	}
	if string(actual) != expected.OutputYAML {
		index := 0
		for index < len(actual) && index < len(expected.OutputYAML) && actual[index] == expected.OutputYAML[index] {
			index++
		}
		start := max(index-40, 0)
		actualEnd := min(index+80, len(actual))
		expectedEnd := min(index+80, len(expected.OutputYAML))
		t.Fatalf("config bytes differ from Node oracle at byte %d:\n got: %q\nwant: %q", index, actual[start:actualEnd], expected.OutputYAML[start:expectedEnd])
	}
	digest := sha256.Sum256(actual)
	if got := hex.EncodeToString(digest[:]); got != expected.SHA256 {
		t.Fatalf("config SHA-256: got %s, Node oracle has %s", got, expected.SHA256)
	}
	return actual
}

// verifyScenarioBytesExcludingOperatorOwnedDefaults compares our migrated output against the pinned recorded bytes,
// minus the keys GoTavern deliberately never materialises (operatorOwnedDefaults). The exemption is by EXACT
// dotted path, it is computed from the pinned expectation itself, everything else is still compared byte for byte,
// and the three keys are then asserted ABSENT from our file so the exemption cannot hide them reappearing.
func verifyScenarioBytesExcludingOperatorOwnedDefaults(t *testing.T, path string, expected oracleScenario) []byte {
	t.Helper()
	actual, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	expectation, parseErr := parseMapping([]byte(expected.OutputYAML))
	if parseErr != nil {
		t.Fatalf("parse the pinned expectation: %v", parseErr)
	}
	for _, key := range operatorOwnedDefaults {
		unsetPath(expectation, key)
	}
	trimmed, stringifyErr := stringifyConfig(expectation)
	if stringifyErr != nil {
		t.Fatalf("re-serialize the pinned expectation: %v", stringifyErr)
	}
	if string(trimmed) != string(actual) {
		index := 0
		for index < len(actual) && index < len(trimmed) && actual[index] == trimmed[index] {
			index++
		}
		start := max(index-40, 0)
		t.Fatalf("config bytes differ from the pinned expectation minus %v at byte %d: got %q want %q",
			operatorOwnedDefaults, index, actual[start:min(index+80, len(actual))], trimmed[start:min(index+80, len(trimmed))])
	}
	written, parseErr := parseMapping(actual)
	if parseErr != nil {
		t.Fatalf("parse our own output: %v", parseErr)
	}
	for _, key := range operatorOwnedDefaults {
		if _, exists := getPath(written, key); exists {
			t.Fatalf("GoTavern materialised %q into the user config; it must never write an auto-update key (AGENTS rule 26, ARCHITECTURE 34.3)", key)
		}
	}
	return actual
}

func TestInitializeCreatesPinnedFreshConfig(t *testing.T) {
	fixture := readOracleFixture(t)
	expected := fixture.Scenarios["fresh"]
	configPath := filepath.Join(t.TempDir(), "config.yaml")

	result, err := Initialize(configPath)
	if err != nil {
		t.Fatal(err)
	}
	if !result.Created || result.Updated {
		t.Fatalf("unexpected result: %+v", result)
	}
	verifyScenarioBytes(t, configPath, expected)
}

func TestInitializeMigratesLegacyConfigAndPreservesUnknownFields(t *testing.T) {
	fixture := readOracleFixture(t)
	expected := fixture.Scenarios["migrationsAndUnknownFields"]
	if expected.Input == nil {
		t.Fatal("migration oracle is missing its input YAML")
	}
	configPath := filepath.Join(t.TempDir(), "config.yaml")
	if err := os.WriteFile(configPath, []byte(*expected.Input), 0o600); err != nil {
		t.Fatal(err)
	}
	before, err := os.Stat(configPath)
	if err != nil {
		t.Fatal(err)
	}

	result, err := Initialize(configPath)
	if err != nil {
		t.Fatal(err)
	}
	if result.Created || !result.Updated {
		t.Fatalf("unexpected result: %+v", result)
	}
	after, err := os.Stat(configPath)
	if err != nil {
		t.Fatal(err)
	}
	if before.Mode().Perm() != after.Mode().Perm() {
		t.Fatalf("config permissions changed from %04o to %04o", before.Mode().Perm(), after.Mode().Perm())
	}
	actual := verifyScenarioBytesExcludingOperatorOwnedDefaults(t, configPath, expected)

	second, err := Initialize(configPath)
	if err != nil {
		t.Fatal(err)
	}
	if second.Created || second.Updated {
		t.Fatalf("second initialization should not rewrite an up-to-date config: %+v", second)
	}
	afterSecond, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(afterSecond) != string(actual) {
		t.Fatal("second initialization changed config bytes")
	}
}

func TestInitializeMigratesLegacyEnvironmentVariable(t *testing.T) {
	fixture := readOracleFixture(t)
	expected := fixture.Scenarios["environmentMigration"]
	configPath := filepath.Join(t.TempDir(), "config.yaml")
	if expected.Input == nil {
		t.Fatal("environment migration oracle is missing its input YAML")
	}
	if err := os.WriteFile(configPath, []byte(*expected.Input), 0o600); err != nil {
		t.Fatal(err)
	}

	var environmentBefore = make(map[string]struct {
		value  string
		exists bool
	})
	for _, item := range migrations {
		for _, name := range []string{environmentName(item.oldKey), environmentName(item.newKey)} {
			if name == "SILLYTAVERN_" {
				continue
			}
			if _, saved := environmentBefore[name]; saved {
				continue
			}
			value, exists := os.LookupEnv(name)
			environmentBefore[name] = struct {
				value  string
				exists bool
			}{value: value, exists: exists}
			_ = os.Unsetenv(name)
		}
	}
	t.Cleanup(func() {
		for name, previous := range environmentBefore {
			if previous.exists {
				_ = os.Setenv(name, previous.value)
			} else {
				_ = os.Unsetenv(name)
			}
		}
	})
	oldName := environmentName("disableThumbnails")
	newName := environmentName("thumbnails.enabled")
	if err := os.Setenv(oldName, "false"); err != nil {
		t.Fatal(err)
	}

	result, err := Initialize(configPath)
	if err != nil {
		t.Fatal(err)
	}
	if !result.Updated {
		t.Fatalf("expected default insertion to update config, got %+v", result)
	}
	for name, want := range expected.Environment {
		got, exists := os.LookupEnv(name)
		if want == nil {
			if exists {
				t.Fatalf("environment variable %s = %q, want unset", name, got)
			}
			continue
		}
		if !exists || got != *want {
			t.Fatalf("environment variable %s = %q (exists=%v), want %q", name, got, exists, *want)
		}
	}
	if _, exists := os.LookupEnv(oldName); exists {
		t.Fatalf("legacy environment variable %s remains set", oldName)
	}
	if got, exists := os.LookupEnv(newName); !exists || got != "true" {
		t.Fatalf("migrated environment variable = %q (exists=%v), want true", got, exists)
	}
	verifyScenarioBytes(t, configPath, expected)
}

func TestInitializeLeavesMalformedConfigUntouched(t *testing.T) {
	configPath := filepath.Join(t.TempDir(), "config.yaml")
	input := []byte("not: [valid\n")
	if err := os.WriteFile(configPath, input, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Initialize(configPath); err == nil {
		t.Fatal("expected malformed YAML to return an error")
	}
	actual, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(actual) != string(input) {
		t.Fatalf("malformed config changed: got %q, want %q", actual, input)
	}
}

func TestInitializeLocksConcurrentFreshWrites(t *testing.T) {
	expected := readOracleFixture(t).Scenarios["fresh"]
	configPath := filepath.Join(t.TempDir(), "config.yaml")
	const callers = 12
	results := make(chan Result, callers)
	errors := make(chan error, callers)
	for range callers {
		go func() {
			result, err := Initialize(configPath)
			if err != nil {
				errors <- err
				return
			}
			results <- result
		}()
	}
	created := 0
	for range callers {
		select {
		case err := <-errors:
			t.Fatal(err)
		case result := <-results:
			if result.Created {
				created++
			}
		}
	}
	if created != 1 {
		t.Fatalf("concurrent initializers reported %d creations, want 1", created)
	}
	verifyScenarioBytes(t, configPath, expected)
}
