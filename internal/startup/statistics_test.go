package startup

import (
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
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
	StatsFileContent          *string  `json:"statsFileContent"`
	CharactersDirectoryExists *bool    `json:"charactersDirectoryExists"`
	CharacterFiles            []string `json:"characterFiles"`
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
	if len(fixture.Scenarios) < 5 {
		t.Fatalf("stats-init oracle has only %d scenarios", len(fixture.Scenarios))
	}
	if len(fixture.RoundTrip.Errors) != 0 {
		t.Fatalf("Node-to-Go-to-Node stats round trip returned errors: %v", fixture.RoundTrip.Errors)
	}
	characterScenario := fixture.Scenarios["missingStatsCharacterWithoutChats"].Observation
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
			dataRoot := filepath.Join(t.TempDir(), "data")
			userRoot := filepath.Join(dataRoot, "default-user")
			charactersDirectory := filepath.Join(userRoot, "characters")
			chatsDirectory := filepath.Join(userRoot, "chats")
			if err := os.MkdirAll(chatsDirectory, 0o755); err != nil {
				t.Fatal(err)
			}
			charactersDirectoryExists := true
			if scenario.Input.CharactersDirectoryExists != nil {
				charactersDirectoryExists = *scenario.Input.CharactersDirectoryExists
			}
			if charactersDirectoryExists {
				if err := os.MkdirAll(charactersDirectory, 0o755); err != nil {
					t.Fatal(err)
				}
				for _, filename := range scenario.Input.CharacterFiles {
					if err := os.WriteFile(filepath.Join(charactersDirectory, filename), nil, 0o600); err != nil {
						t.Fatal(err)
					}
				}
			}
			if scenario.Input.StatsFileContent != nil {
				if err := os.WriteFile(filepath.Join(userRoot, statisticsFilename), []byte(*scenario.Input.StatsFileContent), 0o600); err != nil {
					t.Fatal(err)
				}
			}

			result := InitializeStatistics([]UserDirectories{{
				"root":       userRoot,
				"characters": charactersDirectory,
				"chats":      chatsDirectory,
			}}, time.UnixMilli(statsOracleNow))
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
