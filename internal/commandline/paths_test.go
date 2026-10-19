package commandline

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
)

type commandlinePathsFixture struct {
	Baseline struct {
		Version string `json:"version"`
		Commit  string `json:"commit"`
	} `json:"baseline"`
	Scenarios map[string]commandlinePathsScenario `json:"scenarios"`
}

type commandlinePathsScenario struct {
	Args                []string               `json:"args"`
	InitialConfigPath   *string                `json:"initialConfigPath"`
	InitialConfig       *string                `json:"initialConfig"`
	EnvironmentDataRoot *string                `json:"environmentDataRoot"`
	ForceGlobal         bool                   `json:"forceGlobal"`
	BlockerFile         *string                `json:"blockerFile"`
	ExistingDataRoot    *string                `json:"existingDataRoot"`
	Result              commandlinePathsResult `json:"result"`
}

type commandlinePathsResult struct {
	Global                             bool                    `json:"global"`
	ConfigPath                         string                  `json:"configPath"`
	ConfigFileRelativeToCWD            string                  `json:"configFileRelativeToCwd"`
	DataRoot                           string                  `json:"dataRoot"`
	DataRootCreationRelativeToCWD      string                  `json:"dataRootCreationRelativeToCwd"`
	RuntimeDataRootRelativeToServerDir string                  `json:"runtimeDataRootRelativeToServerDirectory"`
	ConfigBytes                        int64                   `json:"configBytes"`
	ConfigSHA256                       string                  `json:"configSha256"`
	ConfigCreated                      bool                    `json:"configCreated"`
	ConfigUpdated                      bool                    `json:"configUpdated"`
	DataRootIsDirectory                bool                    `json:"dataRootIsDirectory"`
	DataRootWasDirectoryBeforeParse    bool                    `json:"dataRootWasDirectoryBeforeParse"`
	Warnings                           commandlinePathWarnings `json:"warnings"`
}

type commandlinePathWarnings struct {
	IgnoredConfigPath      bool `json:"ignoredConfigPath"`
	IgnoredDataRoot        bool `json:"ignoredDataRoot"`
	FailedDataRootCreation bool `json:"failedDataRootCreation"`
}

func TestResolvePathsMatchesPinnedNodeCommandLineParser(t *testing.T) {
	fixtureBytes, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-commandline-paths.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture commandlinePathsFixture
	if err := json.Unmarshal(fixtureBytes, &fixture); err != nil {
		t.Fatal(err)
	}
	if fixture.Baseline.Version != "1.19.0" || fixture.Baseline.Commit != "06bde939fb1e9c4c8d8641d810f0a916b5bce127" {
		t.Fatalf("command-line oracle baseline = %+v", fixture.Baseline)
	}
	for name, scenario := range fixture.Scenarios {
		t.Run(name, func(t *testing.T) {
			workingDirectory := filepath.Join(t.TempDir(), "working")
			serverDirectory := filepath.Join(t.TempDir(), "server")
			if err := os.MkdirAll(workingDirectory, 0o755); err != nil {
				t.Fatal(err)
			}
			if err := os.MkdirAll(serverDirectory, 0o755); err != nil {
				t.Fatal(err)
			}
			if scenario.InitialConfigPath != nil {
				configFile := filepath.Join(workingDirectory, filepath.FromSlash(*scenario.InitialConfigPath))
				if err := os.MkdirAll(filepath.Dir(configFile), 0o755); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(configFile, []byte(*scenario.InitialConfig), 0o644); err != nil {
					t.Fatal(err)
				}
			}
			if scenario.BlockerFile != nil {
				if err := os.WriteFile(filepath.Join(workingDirectory, filepath.FromSlash(*scenario.BlockerFile)), []byte("blocker"), 0o644); err != nil {
					t.Fatal(err)
				}
			}
			if scenario.ExistingDataRoot != nil {
				if err := os.MkdirAll(filepath.Join(workingDirectory, filepath.FromSlash(*scenario.ExistingDataRoot)), 0o755); err != nil {
					t.Fatal(err)
				}
			}
			setEnvironment(t, "SILLYTAVERN_DATAROOT", scenario.EnvironmentDataRoot)
			globalDataDirectory := filepath.Join(t.TempDir(), "globalData")
			var forceGlobalMode *bool
			if scenario.ForceGlobal {
				forced := true
				forceGlobalMode = &forced
			}
			got, err := ResolvePaths(ResolveOptions{
				Args:                scenario.Args,
				WorkingDirectory:    workingDirectory,
				ServerDirectory:     serverDirectory,
				ForceGlobalMode:     forceGlobalMode,
				GlobalDataDirectory: globalDataDirectory,
			})
			if err != nil {
				t.Fatal(err)
			}

			if got.Global != scenario.Result.Global {
				t.Errorf("global mode = %t, Node has %t", got.Global, scenario.Result.Global)
			}
			if value := normalizeGlobalPath(got.ConfigPath, globalDataDirectory, got.Global); value != scenario.Result.ConfigPath {
				t.Errorf("configPath = %q, Node has %q", value, scenario.Result.ConfigPath)
			}
			if value := relativeOrGlobal(got.ConfigFile, workingDirectory, globalDataDirectory, got.Global); value != scenario.Result.ConfigFileRelativeToCWD {
				t.Errorf("config file path = %q, Node has %q", value, scenario.Result.ConfigFileRelativeToCWD)
			}
			if value := normalizeGlobalPath(got.DataRoot, globalDataDirectory, got.Global); value != scenario.Result.DataRoot {
				t.Errorf("dataRoot = %q, Node has %q", value, scenario.Result.DataRoot)
			}
			if value := relativeOrGlobal(got.DataRootCreationPath, workingDirectory, globalDataDirectory, got.Global); value != scenario.Result.DataRootCreationRelativeToCWD {
				t.Errorf("data-root creation path = %q, Node has %q", value, scenario.Result.DataRootCreationRelativeToCWD)
			}
			if value := relativeOrGlobal(got.RuntimeDataRoot, serverDirectory, globalDataDirectory, got.Global); value != scenario.Result.RuntimeDataRootRelativeToServerDir {
				t.Errorf("runtime data root = %q, Node has %q", value, scenario.Result.RuntimeDataRootRelativeToServerDir)
			}
			configBytes, err := os.ReadFile(got.ConfigFile)
			if err != nil {
				t.Fatal(err)
			}
			digest := sha256.Sum256(configBytes)
			if int64(len(configBytes)) != scenario.Result.ConfigBytes || hex.EncodeToString(digest[:]) != scenario.Result.ConfigSHA256 {
				t.Errorf("initialized config bytes/hash = %d/%s, Node has %d/%s", len(configBytes), hex.EncodeToString(digest[:]), scenario.Result.ConfigBytes, scenario.Result.ConfigSHA256)
			}
			if got.ConfigInitialization.Created != scenario.Result.ConfigCreated || got.ConfigInitialization.Updated != scenario.Result.ConfigUpdated {
				t.Errorf("config initialization = %+v, Node has created=%t updated=%t", got.ConfigInitialization, scenario.Result.ConfigCreated, scenario.Result.ConfigUpdated)
			}
			dataInfo, dataErr := os.Stat(got.DataRootCreationPath)
			dataRootIsDirectory := dataErr == nil && dataInfo.IsDir()
			if dataRootIsDirectory != scenario.Result.DataRootIsDirectory {
				t.Errorf("data root is directory = %t, Node has %t (stat: %v)", dataRootIsDirectory, scenario.Result.DataRootIsDirectory, dataErr)
			}
			expectedCreated := !scenario.Result.DataRootWasDirectoryBeforeParse && scenario.Result.DataRootIsDirectory && !scenario.Result.Warnings.FailedDataRootCreation
			if got.DataRootCreated != expectedCreated {
				t.Errorf("data root created = %t, Node setup implies %t", got.DataRootCreated, expectedCreated)
			}
			warnings := summarizePathWarnings(got.Warnings)
			if !reflect.DeepEqual(warnings, scenario.Result.Warnings) {
				t.Errorf("path warnings = %+v, Node has %+v", warnings, scenario.Result.Warnings)
			}
		})
	}
}

func TestDefaultGlobalDataDirectoryMatchesPinnedEnvPathsLayout(t *testing.T) {
	// This table mirrors the platform branches in the pinned env-paths@3.0.0
	// package used by CommandLineParser.getDefaultConfig().
	base := t.TempDir()
	var expected string
	switch runtime.GOOS {
	case "windows":
		t.Setenv("LOCALAPPDATA", base)
		expected = filepath.Join(base, "SillyTavern", "Data")
	case "darwin":
		t.Setenv("HOME", base)
		expected = filepath.Join(base, "Library", "Application Support", "SillyTavern")
	default:
		t.Setenv("XDG_DATA_HOME", base)
		expected = filepath.Join(base, "SillyTavern")
	}
	got, err := DefaultGlobalDataDirectory()
	if err != nil {
		t.Fatal(err)
	}
	if got != expected {
		t.Fatalf("global data directory = %q, pinned env-paths has %q", got, expected)
	}
}

func normalizeGlobalPath(value, globalDataDirectory string, global bool) string {
	if !global {
		return value
	}
	relative, err := filepath.Rel(globalDataDirectory, value)
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) || filepath.IsAbs(relative) {
		return value
	}
	if relative == "." {
		return "<globalData>"
	}
	return "<globalData>/" + filepath.ToSlash(relative)
}

func relativeOrGlobal(value, base, globalDataDirectory string, global bool) string {
	if global {
		return normalizeGlobalPath(value, globalDataDirectory, true)
	}
	relative, err := filepath.Rel(base, value)
	if err != nil {
		return value
	}
	if relative == "." {
		return ""
	}
	return filepath.ToSlash(relative)
}

func summarizePathWarnings(warnings []PathWarning) commandlinePathWarnings {
	result := commandlinePathWarnings{}
	for _, warning := range warnings {
		result.IgnoredConfigPath = result.IgnoredConfigPath || strings.Contains(warning.Message, "--configPath") && strings.Contains(warning.Message, "ignored in global mode")
		result.IgnoredDataRoot = result.IgnoredDataRoot || strings.Contains(warning.Message, "--dataRoot") && strings.Contains(warning.Message, "ignored in global mode")
		result.FailedDataRootCreation = result.FailedDataRootCreation || strings.Contains(warning.Message, "Failed to create data root directory")
	}
	return result
}

func setEnvironment(t *testing.T, name string, value *string) {
	t.Helper()
	previous, existed := os.LookupEnv(name)
	if value == nil {
		if err := os.Unsetenv(name); err != nil {
			t.Fatal(err)
		}
	} else if err := os.Setenv(name, *value); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		var err error
		if existed {
			err = os.Setenv(name, previous)
		} else {
			err = os.Unsetenv(name)
		}
		if err != nil {
			t.Errorf("restore environment variable %s: %v", name, err)
		}
	})
}
