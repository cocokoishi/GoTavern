package startup

import (
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

const statsOracleNow = int64(1735689600000)

type statisticsInitOracle struct {
	SchemaVersion int                           `json:"schemaVersion"`
	Baseline      settingsBackupBaseline        `json:"baseline"`
	Scenarios     map[string]statisticsScenario `json:"scenarios"`
	RoundTrip     statisticsRoundTrip           `json:"roundTrip"`
}

type statisticsScenario struct {
	Input       statisticsInput       `json:"input"`
	Observation statisticsObservation `json:"observation"`
}

type statisticsInput struct {
	StatsFileContent          *string                                  `json:"statsFileContent"`
	CharactersDirectoryExists *bool                                    `json:"charactersDirectoryExists"`
	CharacterFiles            []string                                 `json:"characterFiles"`
	ChatFiles                 map[string]map[string]statisticsChatFile `json:"chatFiles"`
}

type statisticsChatFile struct {
	Contents string `json:"contents"`
	ModTime  int64  `json:"mtime"`
}

type statisticsObservation struct {
	Logs          []statisticsLog `json:"logs"`
	IntervalCalls []int           `json:"intervalCalls"`
	Memory        any             `json:"memory"`
	Filesystem    statisticsFS    `json:"filesystem"`
}

type statisticsLog struct {
	Level     string  `json:"level"`
	Message   string  `json:"message"`
	ErrorCode *string `json:"errorCode"`
}

type statisticsFS struct {
	StatsFileExists  bool    `json:"statsFileExists"`
	StatsFileContent *string `json:"statsFileContent"`
}

type statisticsRoundTrip struct {
	Errors       []string        `json:"errors"`
	FileContent  string          `json:"fileContent"`
	Memory       json.RawMessage `json:"memory"`
	NodeReadback any             `json:"nodeReadback"`
}

func TestInitializeStatisticsMatchesPinnedNode(t *testing.T) {
	fixture := loadStatisticsInitOracle(t)
	if len(fixture.Scenarios) < 5 {
		t.Fatalf("stats-init oracle has only %d scenarios", len(fixture.Scenarios))
	}
	if len(fixture.RoundTrip.Errors) != 0 {
		t.Fatalf("Node-to-Go-to-Node stats round trip returned errors: %v", fixture.RoundTrip.Errors)
	}
	characterScenario := fixture.Scenarios["missingStatsChatHistory"].Observation
	if characterScenario.Filesystem.StatsFileContent == nil || fixture.RoundTrip.FileContent != *characterScenario.Filesystem.StatsFileContent {
		t.Fatalf("Go stats round-trip bytes differ from the pinned Node recreation: %q", fixture.RoundTrip.FileContent)
	}
	var roundTripMemory any
	if err := json.Unmarshal(fixture.RoundTrip.Memory, &roundTripMemory); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(roundTripMemory, fixture.RoundTrip.NodeReadback) {
		t.Fatalf("Node could not read the Go-created stats value: Go=%#v Node=%#v", roundTripMemory, fixture.RoundTrip.NodeReadback)
	}

	for scenarioName, scenario := range fixture.Scenarios {
		t.Run(scenarioName, func(t *testing.T) {
			userRoot, directories := materializeStatisticsScenario(t, scenario.Input)

			result := InitializeStatistics([]UserDirectories{directories}, time.UnixMilli(statsOracleNow))
			got := observeStatistics(t, result, userRoot)
			if !statisticsObservationsEqual(got, scenario.Observation) {
				gotJSON, _ := json.MarshalIndent(got, "", "  ")
				wantJSON, _ := json.MarshalIndent(scenario.Observation, "", "  ")
				t.Fatalf("stats initialization differs from pinned Node:\n got: %s\nwant: %s", gotJSON, wantJSON)
			}
			if !reflect.DeepEqual(scenario.Observation.IntervalCalls, []int{300_000}) {
				t.Fatalf("pinned stats.init() interval changed: %v", scenario.Observation.IntervalCalls)
			}
		})
	}
}

// TestRecreateUserStatisticsReplacesAValidStatsFile covers the one behaviour that separates the
// recreate route (pinned stats.js:151) from the startup hook: recreateStats never reads the stored
// file, so a valid stats.json is overwritten. The expected replacement bytes are the pinned Node
// recreation of the same chat tree, not a hand derivation.
func TestRecreateUserStatisticsReplacesAValidStatsFile(t *testing.T) {
	fixture := loadStatisticsInitOracle(t)
	scenario, ok := fixture.Scenarios["missingStatsChatHistory"]
	if !ok {
		t.Fatal("the stats-init oracle lost the missingStatsChatHistory scenario")
	}
	want := scenario.Observation.Filesystem.StatsFileContent
	if want == nil {
		t.Fatal("the pinned recreation of this scenario produced no stats file")
	}
	userRoot, directories := materializeStatisticsScenario(t, scenario.Input)
	statsPath := filepath.Join(userRoot, statisticsFilename)
	const stale = `{"marker":true,"timestamp":1}`
	if err := os.WriteFile(statsPath, []byte(stale), 0o600); err != nil {
		t.Fatal(err)
	}

	body, err := RecreateUserStatistics(directories, time.UnixMilli(statsOracleNow))
	if err != nil {
		t.Fatal(err)
	}
	if string(body) != *want {
		t.Fatalf("recreate bytes differ from the pinned Node recreation:\n got: %s\nwant: %s", body, *want)
	}
	onDisk, err := os.ReadFile(statsPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(onDisk) != string(body) {
		t.Fatalf("the recalculated stats were not persisted:\n got: %s\nwant: %s", onDisk, body)
	}
	if strings.Contains(string(onDisk), "marker") {
		t.Fatalf("the valid stale stats file survived the recreate: %s", onDisk)
	}
}

// TestRecreateUserStatisticsFailsWithoutCharacterDirectory pins the error branch: the pinned
// recreateStats calls readdir(charactersPath) without guarding, so a missing directory rejects and
// POST /api/stats/recreate answers 500.
func TestRecreateUserStatisticsFailsWithoutCharacterDirectory(t *testing.T) {
	fixture := loadStatisticsInitOracle(t)
	scenario, ok := fixture.Scenarios["missingCharactersDirectory"]
	if !ok {
		t.Skip("the stats-init oracle has no missingCharactersDirectory scenario")
	}
	userRoot, directories := materializeStatisticsScenario(t, scenario.Input)
	if _, err := RecreateUserStatistics(directories, time.UnixMilli(statsOracleNow)); err == nil {
		t.Fatal("recreate succeeded with no character directory")
	}
	if _, err := os.Stat(filepath.Join(userRoot, statisticsFilename)); err == nil {
		t.Fatal("a failed recreate still wrote a stats file")
	}
}

func loadStatisticsInitOracle(t *testing.T) statisticsInitOracle {
	t.Helper()
	body, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-stats-init.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture statisticsInitOracle
	if err := json.Unmarshal(body, &fixture); err != nil {
		t.Fatal(err)
	}
	if fixture.SchemaVersion != 1 || fixture.Baseline.Version != "1.19.0" || fixture.Baseline.Commit != "06bde939fb1e9c4c8d8641d810f0a916b5bce127" {
		t.Fatalf("unexpected stats-init oracle baseline: %#v", fixture.Baseline)
	}
	return fixture
}

// materializeStatisticsScenario writes one oracle scenario's input tree and returns the user root
// plus the directory set the pinned hooks are given.
func materializeStatisticsScenario(t *testing.T, input statisticsInput) (string, UserDirectories) {
	t.Helper()
	dataRoot := filepath.Join(t.TempDir(), "data")
	userRoot := filepath.Join(dataRoot, "default-user")
	charactersDirectory := filepath.Join(userRoot, "characters")
	chatsDirectory := filepath.Join(userRoot, "chats")
	if err := os.MkdirAll(chatsDirectory, 0o755); err != nil {
		t.Fatal(err)
	}
	charactersDirectoryExists := true
	if input.CharactersDirectoryExists != nil {
		charactersDirectoryExists = *input.CharactersDirectoryExists
	}
	if charactersDirectoryExists {
		if err := os.MkdirAll(charactersDirectory, 0o755); err != nil {
			t.Fatal(err)
		}
		for _, filename := range input.CharacterFiles {
			if err := os.WriteFile(filepath.Join(charactersDirectory, filename), nil, 0o600); err != nil {
				t.Fatal(err)
			}
		}
	}
	for character, files := range input.ChatFiles {
		chatDirectory := filepath.Join(chatsDirectory, character)
		if err := os.MkdirAll(chatDirectory, 0o755); err != nil {
			t.Fatal(err)
		}
		for filename, chat := range files {
			chatPath := filepath.Join(chatDirectory, filename)
			if err := os.WriteFile(chatPath, []byte(chat.Contents), 0o600); err != nil {
				t.Fatal(err)
			}
			if chat.ModTime != 0 {
				modTime := time.UnixMilli(chat.ModTime)
				if err := os.Chtimes(chatPath, modTime, modTime); err != nil {
					t.Fatal(err)
				}
			}
		}
	}
	if input.StatsFileContent != nil {
		if err := os.WriteFile(filepath.Join(userRoot, statisticsFilename), []byte(*input.StatsFileContent), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return userRoot, UserDirectories{
		"root":       userRoot,
		"characters": charactersDirectory,
		"chats":      chatsDirectory,
	}
}

func observeStatistics(t *testing.T, result StatisticsInitialization, userRoot string) statisticsObservation {
	t.Helper()
	observation := statisticsObservation{
		Logs:          []statisticsLog{},
		IntervalCalls: []int{},
		Memory:        json.RawMessage("{}"),
		Filesystem: statisticsFS{
			StatsFileContent: nil,
		},
	}
	for _, err := range result.Errors {
		log := statisticsLog{Level: "error", Message: "Failed to initialize stats:"}
		if errors.Is(err, fs.ErrNotExist) {
			code := "ENOENT"
			log.ErrorCode = &code
		}
		observation.Logs = append(observation.Logs, log)
	}
	if value, ok := result.Values["default-user"]; ok {
		observation.Memory = value
	}
	statsPath := filepath.Join(userRoot, statisticsFilename)
	if info, err := os.Stat(statsPath); err == nil {
		observation.Filesystem.StatsFileExists = info.Mode().IsRegular()
		if observation.Filesystem.StatsFileExists {
			body, err := os.ReadFile(statsPath)
			if err != nil {
				t.Fatal(err)
			}
			observation.Filesystem.StatsFileContent = statisticsString(string(body))
		}
	} else if !os.IsNotExist(err) {
		t.Fatal(err)
	}
	return observation
}

func statisticsObservationsEqual(got, want statisticsObservation) bool {
	if got.Filesystem.StatsFileExists != want.Filesystem.StatsFileExists || !reflect.DeepEqual(got.Filesystem.StatsFileContent, want.Filesystem.StatsFileContent) {
		return false
	}
	if !reflect.DeepEqual(got.Logs, wantErrorLogs(want.Logs)) {
		return false
	}
	var gotMemory, wantMemory any
	if json.Unmarshal(got.Memory.(json.RawMessage), &gotMemory) != nil || json.Unmarshal(mustMarshal(want.Memory), &wantMemory) != nil {
		return false
	}
	return reflect.DeepEqual(gotMemory, wantMemory)
}

func wantErrorLogs(logs []statisticsLog) []statisticsLog {
	filtered := make([]statisticsLog, 0, len(logs))
	for _, log := range logs {
		if log.Level == "error" {
			filtered = append(filtered, log)
		}
	}
	return filtered
}

func mustMarshal(value any) []byte {
	body, _ := json.Marshal(value)
	return body
}

func statisticsString(value string) *string { return &value }
