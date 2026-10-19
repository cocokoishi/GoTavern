package commandline

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
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
	OptionEnvironment   map[string]string      `json:"optionEnvironment"`
	ForceGlobal         bool                   `json:"forceGlobal"`
	UseIPv4             bool                   `json:"useIPv4"`
	UseIPv6             bool                   `json:"useIPv6"`
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
	Options                            map[string]any          `json:"options"`
	StartupSettings                    map[string]any          `json:"startupSettings"`
	OptionWarnings                     OptionWarnings          `json:"optionWarnings"`
	DerivedURLs                        commandlineDerivedURLs  `json:"derivedURLs"`
}

type commandlineDerivedURLs struct {
	IPv4ListenURL         commandlineURLCapture `json:"ipv4ListenUrl"`
	IPv6ListenURL         commandlineURLCapture `json:"ipv6ListenUrl"`
	BrowserLaunchHostname any                   `json:"browserLaunchHostname"`
	BrowserLaunchURL      commandlineURLCapture `json:"browserLaunchUrl"`
}

type commandlineURLCapture struct {
	Href         string `json:"href,omitempty"`
	ErrorName    string `json:"errorName,omitempty"`
	ErrorMessage string `json:"errorMessage,omitempty"`
}

type commandlinePathWarnings struct {
	IgnoredConfigPath      bool `json:"ignoredConfigPath"`
	IgnoredDataRoot        bool `json:"ignoredDataRoot"`
	FailedDataRootCreation bool `json:"failedDataRootCreation"`
}

func TestResolveCommandLineMatchesPinnedNodeCommandLineParser(t *testing.T) {
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
			clearOptionEnvironment(t)
			for key, value := range scenario.OptionEnvironment {
				t.Setenv(key, value)
			}
			setEnvironment(t, "SILLYTAVERN_DATAROOT", scenario.EnvironmentDataRoot)
			globalDataDirectory := filepath.Join(t.TempDir(), "globalData")
			var forceGlobalMode *bool
			if scenario.ForceGlobal {
				forced := true
				forceGlobalMode = &forced
			}
			got, err := ResolveCommandLine(ResolveOptions{
				Args:                scenario.Args,
				WorkingDirectory:    workingDirectory,
				ServerDirectory:     serverDirectory,
				ForceGlobalMode:     forceGlobalMode,
				GlobalDataDirectory: globalDataDirectory,
			})
			if err != nil {
				t.Fatal(err)
			}

			if got.Paths.Global != scenario.Result.Global {
				t.Errorf("global mode = %t, Node has %t", got.Paths.Global, scenario.Result.Global)
			}
			if value := normalizeGlobalPath(got.Paths.ConfigPath, globalDataDirectory, got.Paths.Global); value != scenario.Result.ConfigPath {
				t.Errorf("configPath = %q, Node has %q", value, scenario.Result.ConfigPath)
			}
			if value := relativeOrGlobal(got.Paths.ConfigFile, workingDirectory, globalDataDirectory, got.Paths.Global); value != scenario.Result.ConfigFileRelativeToCWD {
				t.Errorf("config file path = %q, Node has %q", value, scenario.Result.ConfigFileRelativeToCWD)
			}
			if value := normalizeGlobalPath(got.Paths.DataRoot, globalDataDirectory, got.Paths.Global); value != scenario.Result.DataRoot {
				t.Errorf("dataRoot = %q, Node has %q", value, scenario.Result.DataRoot)
			}
			if value := relativeOrGlobal(got.Paths.DataRootCreationPath, workingDirectory, globalDataDirectory, got.Paths.Global); value != scenario.Result.DataRootCreationRelativeToCWD {
				t.Errorf("data-root creation path = %q, Node has %q", value, scenario.Result.DataRootCreationRelativeToCWD)
			}
			if value := relativeOrGlobal(got.Paths.RuntimeDataRoot, serverDirectory, globalDataDirectory, got.Paths.Global); value != scenario.Result.RuntimeDataRootRelativeToServerDir {
				t.Errorf("runtime data root = %q, Node has %q", value, scenario.Result.RuntimeDataRootRelativeToServerDir)
			}
			configBytes, err := os.ReadFile(got.Paths.ConfigFile)
			if err != nil {
				t.Fatal(err)
			}
			digest := sha256.Sum256(configBytes)
			if int64(len(configBytes)) != scenario.Result.ConfigBytes || hex.EncodeToString(digest[:]) != scenario.Result.ConfigSHA256 {
				t.Errorf("initialized config bytes/hash = %d/%s, Node has %d/%s", len(configBytes), hex.EncodeToString(digest[:]), scenario.Result.ConfigBytes, scenario.Result.ConfigSHA256)
			}
			if got.Paths.ConfigInitialization.Created != scenario.Result.ConfigCreated || got.Paths.ConfigInitialization.Updated != scenario.Result.ConfigUpdated {
				t.Errorf("config initialization = %+v, Node has created=%t updated=%t", got.Paths.ConfigInitialization, scenario.Result.ConfigCreated, scenario.Result.ConfigUpdated)
			}
			dataInfo, dataErr := os.Stat(got.Paths.DataRootCreationPath)
			dataRootIsDirectory := dataErr == nil && dataInfo.IsDir()
			if dataRootIsDirectory != scenario.Result.DataRootIsDirectory {
				t.Errorf("data root is directory = %t, Node has %t (stat: %v)", dataRootIsDirectory, scenario.Result.DataRootIsDirectory, dataErr)
			}
			expectedCreated := !scenario.Result.DataRootWasDirectoryBeforeParse && scenario.Result.DataRootIsDirectory && !scenario.Result.Warnings.FailedDataRootCreation
			if got.Paths.DataRootCreated != expectedCreated {
				t.Errorf("data root created = %t, Node setup implies %t", got.Paths.DataRootCreated, expectedCreated)
			}
			warnings := summarizePathWarnings(got.Paths.Warnings)
			if !reflect.DeepEqual(warnings, scenario.Result.Warnings) {
				t.Errorf("path warnings = %+v, Node has %+v", warnings, scenario.Result.Warnings)
			}
			actualOptions, err := json.Marshal(jsonSafe(got.Options))
			if err != nil {
				t.Fatal(err)
			}
			var normalizedOptions map[string]any
			if err := json.Unmarshal(actualOptions, &normalizedOptions); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(normalizedOptions, scenario.Result.Options) {
				t.Errorf("server options = %#v, Node has %#v", normalizedOptions, scenario.Result.Options)
			}
			actualStartupSettings, err := json.Marshal(jsonSafe(got.StartupSettings))
			if err != nil {
				t.Fatal(err)
			}
			var normalizedStartupSettings map[string]any
			if err := json.Unmarshal(actualStartupSettings, &normalizedStartupSettings); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(normalizedStartupSettings, scenario.Result.StartupSettings) {
				t.Errorf("startup settings = %#v, Node has %#v", normalizedStartupSettings, scenario.Result.StartupSettings)
			}
			if !reflect.DeepEqual(got.Warnings, scenario.Result.OptionWarnings) {
				t.Errorf("server option warnings = %+v, Node has %+v", got.Warnings, scenario.Result.OptionWarnings)
			}
			browserLaunchHostname := got.Options.ResolveBrowserLaunchHostname(scenario.UseIPv6, scenario.UseIPv4)
			derivedURLs := commandlineDerivedURLs{
				IPv4ListenURL:         captureCommandLineURL(got.Options.IPv4ListenURL()),
				IPv6ListenURL:         captureCommandLineURL(got.Options.IPv6ListenURL()),
				BrowserLaunchHostname: browserLaunchHostname,
				BrowserLaunchURL:      captureCommandLineURL(got.Options.BrowserLaunchURL(browserLaunchHostname)),
			}
			if !reflect.DeepEqual(derivedURLs, scenario.Result.DerivedURLs) {
				t.Errorf("derived server URLs = %+v, Node has %+v", derivedURLs, scenario.Result.DerivedURLs)
			}
		})
	}
}

func captureCommandLineURL(href string, err error) commandlineURLCapture {
	if err != nil {
		return commandlineURLCapture{ErrorName: "TypeError", ErrorMessage: err.Error()}
	}
	return commandlineURLCapture{Href: href}
}

func clearOptionEnvironment(t *testing.T) {
	t.Helper()
	for _, entry := range os.Environ() {
		key, value, found := strings.Cut(entry, "=")
		if !found || !strings.HasPrefix(strings.ToUpper(key), "SILLYTAVERN_") {
			continue
		}
		if err := os.Unsetenv(key); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() {
			_ = os.Setenv(key, value)
		})
	}
}

func jsonSafe(value any) any {
	if value == nil {
		return nil
	}
	return jsonSafeValue(reflect.ValueOf(value))
}

func jsonSafeValue(value reflect.Value) any {
	if value.Kind() == reflect.Interface || value.Kind() == reflect.Pointer {
		if value.IsNil() {
			return nil
		}
		return jsonSafeValue(value.Elem())
	}
	switch value.Kind() {
	case reflect.Float32, reflect.Float64:
		if math.IsNaN(value.Float()) || math.IsInf(value.Float(), 0) {
			return nil
		}
		return value.Interface()
	case reflect.Struct:
		copy := make(map[string]any, value.NumField())
		typeOf := value.Type()
		for index := 0; index < value.NumField(); index++ {
			field := typeOf.Field(index)
			if !field.IsExported() {
				continue
			}
			name := strings.Split(field.Tag.Get("json"), ",")[0]
			if name == "" {
				name = field.Name
			}
			copy[name] = jsonSafeValue(value.Field(index))
		}
		return copy
	case reflect.Map:
		copy := make(map[string]any, value.Len())
		iterator := value.MapRange()
		for iterator.Next() {
			copy[fmt.Sprint(iterator.Key().Interface())] = jsonSafeValue(iterator.Value())
		}
		return copy
	case reflect.Slice, reflect.Array:
		copy := make([]any, value.Len())
		for index := 0; index < value.Len(); index++ {
			copy[index] = jsonSafeValue(value.Index(index))
		}
		return copy
	default:
		return value.Interface()
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
