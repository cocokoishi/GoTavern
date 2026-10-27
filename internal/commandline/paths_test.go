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

// pinnedDivergences lists the fields where GoTavern deliberately resolves differently from the pinned Node
// command-line parser, with BOTH values recorded so neither side can drift silently. Keyed by the exact
// option field name -- never a pattern or a wildcard, which would turn a product decision into the widened
// normalisation that provider-wire discipline forbids.
var pinnedDivergences = map[string]struct {
	gotavern any
	// pinned is the SET of values the pinned fixture is allowed to hold for this field. A set rather than a single
	// value because pinned's parser genuinely yields both: it follows whatever the config says, so a scenario whose
	// config asks for false records false. Ours is the constant in gotavern, in every scenario. Every value observed
	// must be declared, and every declared value must be observed at least once -- otherwise the entry has stopped
	// describing a real divergence and is reported instead of kept as permission.
	pinned map[string]any
	reason string
}{
	"extensionsAutoUpdate": {
		gotavern: false,
		pinned:   map[string]any{"true": true, "false": false},
		reason:   "ARCHITECTURE 34.3 / rule 26: GoTavern never enables extension auto-update from an inherited key; pinned follows the config and its own default is true (upstream/default/config.yaml:301), and that default is deliberately not honoured",
	},
}

// twoDataRootBases reports whether the creation path and the runtime path disagree, which is the ONLY
// situation ARCHITECTURE 34.5 changes. All recorded scenarios boot with CWD == server directory, so this is
// false for every one of them; the guard in the parity test fails if that ever stops being true, because a
// fixture change that silently makes this true would otherwise switch the pinned comparison off.
func twoDataRootBases(paths ResolvedPaths) bool {
	return filepath.Clean(paths.DataRootCreationPath) != filepath.Clean(paths.RuntimeDataRoot)
}

// relativeDataRootDivergence is the RECORDED divergence for a relative dataRoot (ARCHITECTURE 34.5), stated as
// the one value that differs so it cannot drift into a permission. Pinned creates the launch-directory
// rendering and uses the server-directory one; GoTavern creates only the one it uses and warns naming both.
//
// Pinned creates the launch-directory rendering and uses the server-directory one: server.js:8 runs the
// parser (creation at command-line.js:292-293), then server.js:11 chdirs, then server-main.js:400,456 reads
// through the post-chdir directory. GoTavern creates <serverDir>/data only, and reports the difference as a
// PathWarning naming both paths.
var relativeDataRootDivergence = struct {
	createsLaunchRendering bool
	reason                 string
}{
	createsLaunchRendering: false,
	reason: "AGENTS 27 outranks parity here: startup must not create state in a directory the user did not " +
		"name, and a relative dataRoot names one directory. Precedent ARCHITECTURE 34.3 (auto-update). The " +
		"pinned values of both data-root FIELDS are unchanged; only the side effect moves. NOT here, and " +
		"deliberately: `FailedDataRootCreation` is EXCLUDED rather than given a value, because that field " +
		"reports pinned's launch-path mkdir, which this project does not perform -- so there is no GoTavern " +
		"value for it to hold, and restating it as false would be a comparison against a fact that does not " +
		"exist.",
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
			// NOTE ON SCOPE, so a future reader does not repeat my mistake. This harness runs every scenario
			// with workingDirectory and serverDirectory in DIFFERENT TempDirs (paths_test.go:139-140), so the
			// two data-root bases differ for nearly every scenario. That is a property of the HARNESS, not a
			// pinned measurement -- the pinned probe recorded its scenarios with CWD == server directory, where
			// the bases coincide -- and it means the creation-path comparison is governed by ARCHITECTURE 34.5
			// below. The single-base guard is written there, next to the stat it depends on, and fails only
			// where the bases coincide AND the pinned value does not hold: the case the divergence does not cover.
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
			// THE CREATION PATH IS COMPARED EXCEPT WHERE THIS PROJECT DELIBERATELY DOES NOT CREATE IT
			// (ARCHITECTURE 34.5), AND THE STAT IS TAKEN BEFORE THE DIVERGENCE RAN.
			//
			// Pinned creates DataRootCreationPath and then USES RuntimeDataRoot. For a RELATIVE dataRoot this
			// harness renders those against different TempDirs, so GoTavern now creates only the runtime one and
			// leaves the launch rendering absent -- which is why the stat must be taken BEFORE any divergence
			// branch can run, so that what it observes is the state the pinned field describes. That ordering
			// was paid for: the first version of this test stat'd after the divergence and compared a directory
			// against the pinned value, so `standalone-existing-data-root` (which the harness pre-creates)
			// disagreed for a reason that had nothing to do with the product.
			//
			// The three pre-existing shapes, each decided by a flag the fixture records rather than by a guess:
			//   preCreated            the harness made it; the pinned value is the only thing to compare;
			//   empty value           pinned's own odd branch: mkdir("") fails, isDir is stat("") = the CWD, the
			//                         warning fires, nothing is created -- compared against pinned exactly;
			//   two bases, not created  the divergence: the launch rendering must stay absent.
			preCreated := scenario.Result.DataRootWasDirectoryBeforeParse
			emptyValue := got.Paths.DataRoot == ""
			if preCreated || emptyValue {
				if dataRootIsDirectory != scenario.Result.DataRootIsDirectory {
					t.Errorf("data root is directory = %t, Node has %t (stat: %v)", dataRootIsDirectory, scenario.Result.DataRootIsDirectory, dataErr)
				}
			} else if !twoDataRootBases(got.Paths) {
				if dataRootIsDirectory != scenario.Result.DataRootIsDirectory {
					t.Errorf("data root is directory = %t, Node has %t (stat: %v): the two bases coincide, so "+
						"ARCHITECTURE 34.5 does not apply and the pinned value must hold",
						dataRootIsDirectory, scenario.Result.DataRootIsDirectory, dataErr)
				}
			} else if dataRootIsDirectory != relativeDataRootDivergence.createsLaunchRendering {
				t.Errorf("the two data-root bases differ, so the launch-directory rendering %s must be created=%t "+
					"(ARCHITECTURE 34.5: only the runtime root is created); is-directory = %t",
					got.Paths.DataRootCreationPath, relativeDataRootDivergence.createsLaunchRendering, dataRootIsDirectory)
			}
			// `DataRootCreated` MEANS "THIS PROCESS CREATED A DIRECTORY THAT WAS NOT THERE", so under two bases
			// it is derived from what the product itself did, not from Node's derived isDir -- which describes
			// the LAUNCH path and would answer a different question.
			//
			// IT IS NOT DERIVED FROM PINNED UNDER TWO BASES AT ALL, and this is the third ordering mistake in
			// this block (measured on run 40448384831): pinned's `failedDataRootCreation` reports its
			// LAUNCH-path mkdir, which this project does not perform, so deriving an expectation from that raw
			// field here made `failed-data-root-create` expect `created=false` while the product had correctly
			// created the RUNTIME root. Under two bases there is no pinned value for this field to compare
			// against, so the assertion becomes the one that has teeth and needs no oracle: the runtime
			// directory the product says it created EXISTS on disk. A `true` over a missing directory, or a
			// `false` over one that is there, both fail.
			if twoDataRootBases(got.Paths) && !emptyValue {
				_, runtimeErr := os.Stat(got.Paths.RuntimeDataRoot)
				switch {
				case got.Paths.DataRootCreated && runtimeErr != nil:
					t.Errorf("DataRootCreated is true but the runtime data root %s does not exist (%v): the boot "+
						"reported a directory it did not make", got.Paths.RuntimeDataRoot, runtimeErr)
				case !got.Paths.DataRootCreated && runtimeErr == nil:
					t.Errorf("DataRootCreated is false but the runtime data root %s exists: either the product "+
						"made it without recording that, or something else did", got.Paths.RuntimeDataRoot)
				}
			} else {
				expectedCreated := !scenario.Result.DataRootWasDirectoryBeforeParse && scenario.Result.DataRootIsDirectory && !scenario.Result.Warnings.FailedDataRootCreation
				if got.Paths.DataRootCreated != expectedCreated {
					t.Errorf("data root created = %t, Node setup implies %t", got.Paths.DataRootCreated, expectedCreated)
				}
			}
			warnings := summarizePathWarnings(got.Paths.Warnings)
			// PINNED'S `failedDataRootCreation` DESCRIBES THE LAUNCH PATH, AND THIS PROJECT NO LONGER MKDS IT.
			//
			// The pinned probe's `failed-data-root-create` scenario puts `--dataRoot ./file-blocker/child` with
			// `./file-blocker` a FILE -- created in the launch directory (paths_test.go:164-166) -- so pinned's
			// `mkdirSync` against the launch directory fails and it warns. Under ARCHITECTURE 34.5 GoTavern
			// mkdirs the INSTALL-side rendering, where there is no blocker, so the creation SUCCEEDS and the
			// failure warning is correctly absent. The two sides are then describing different mkds.
			//
			// This was measured, not reasoned: run 40448068426 still reported
			// `FailedDataRootCreation:false, Node has true` after the failure arm had been added, and that is the
			// correct product answer for a directory that did get created.
			//
			// THE FIELD IS REMOVED FROM THE COMPARISON, NOT OVERWRITTEN. A mask that SET it to the declared
			// value left the comparison to run against Node's `true` and fail anyway (run 40448697864), which is
			// the difference between neutralising a field and restating it: the two sides must be brought to a
			// common shape, and comparisons in this file drop the member rather than give it a value. So both
			// sides lose it under two bases, and the field is still compared exactly wherever the bases
			// coincide. It is recorded with its reason, the way the auto-update key is (ARCHITECTURE 34.3).
			if twoDataRootBases(got.Paths) && !emptyValue {
				gotWarnings := warnings
				pinnedWarnings := scenario.Result.Warnings
				gotWarnings.FailedDataRootCreation = false
				pinnedWarnings.FailedDataRootCreation = false
				if !reflect.DeepEqual(gotWarnings, pinnedWarnings) {
					t.Errorf("path warnings = %+v, Node has %+v (FailedDataRootCreation excluded under two bases: "+
						"it reports pinned's launch-path mkdir, which this project does not perform)",
						gotWarnings, pinnedWarnings)
				}
			} else if !reflect.DeepEqual(warnings, scenario.Result.Warnings) {
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
			// PINNED DIVERGENCES, DECLARED EXACTLY, BY FIELD, AND CHECKED ON BOTH SURFACES.
			//
			// The field this project deliberately resolves differently (extensionsAutoUpdate, ARCHITECTURE 34.3 /
			// rule 26) is reported in the STARTUP SETTINGS, not in the resolved options -- the first version of
			// this declaration named the right field for the wrong surface and the phantom-entry guard said so
			// ("not in GoTavern's resolved options"), which is the guard working. So the declaration is applied to
			// both comparable surfaces, each entry must hold on BOTH sides wherever it appears, and it must be met
			// at least once or it is dead permission.
			usedDivergences := make(map[string]bool, len(pinnedDivergences))
			remainingActual, remainingPinned := dropPinnedDivergences(t, "resolved options", normalizedOptions, scenario.Result.Options, usedDivergences)
			if !reflect.DeepEqual(remainingActual, remainingPinned) {
				t.Errorf("server options = %#v, Node has %#v", remainingActual, remainingPinned)
			}
			actualStartupSettings, err := json.Marshal(jsonSafe(got.StartupSettings))
			if err != nil {
				t.Fatal(err)
			}
			var normalizedStartupSettings map[string]any
			if err := json.Unmarshal(actualStartupSettings, &normalizedStartupSettings); err != nil {
				t.Fatal(err)
			}
			remainingSettings, remainingPinnedSettings := dropPinnedDivergences(t, "startup settings", normalizedStartupSettings, scenario.Result.StartupSettings, usedDivergences)
			if !reflect.DeepEqual(remainingSettings, remainingPinnedSettings) {
				t.Errorf("startup settings = %#v, Node has %#v", remainingSettings, remainingPinnedSettings)
			}
			for field := range pinnedDivergences {
				if !usedDivergences[field] {
					t.Errorf("declared divergence %q matched neither the resolved options nor the startup settings; delete the declaration", field)
				}
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

// dropPinnedDivergences applies the declared per-field divergences to one pair of comparable surfaces and
// returns copies with the declared fields removed. Each entry asserts BOTH values where it appears, so a
// declaration can only survive while it is still true about both sides, and it records which fields it actually
// met so a declaration that matches nothing is reported instead of silently granting permission.
func dropPinnedDivergences(t *testing.T, surface string, actual, pinned map[string]any, used map[string]bool) (map[string]any, map[string]any) {
	t.Helper()
	remainingActual := make(map[string]any, len(actual))
	for field, value := range actual {
		remainingActual[field] = value
	}
	remainingPinned := make(map[string]any, len(pinned))
	for field, value := range pinned {
		remainingPinned[field] = value
	}
	for field, divergence := range pinnedDivergences {
		gotValue, gotPresent := remainingActual[field]
		pinnedValue, pinnedPresent := remainingPinned[field]
		if !gotPresent && !pinnedPresent {
			continue
		}
		if !gotPresent {
			t.Errorf("%s: declared divergence %q is absent from GoTavern's value but present in the pinned fixture", surface, field)
			continue
		}
		if !pinnedPresent {
			t.Errorf("%s: declared divergence %q is absent from the pinned fixture but present in GoTavern's value", surface, field)
			continue
		}
		if !reflect.DeepEqual(gotValue, divergence.gotavern) {
			t.Errorf("%s: %s = %#v, declared GoTavern value is %#v (%s)", surface, field, gotValue, divergence.gotavern, divergence.reason)
		}
		declared := false
		for _, allowed := range divergence.pinned {
			if reflect.DeepEqual(pinnedValue, allowed) {
				declared = true
				break
			}
		}
		if !declared {
			t.Errorf("%s: %s is %#v in the pinned fixture, which is not one of the declared pinned values %#v; re-read the declaration before changing it (%s)", surface, field, pinnedValue, divergence.pinned, divergence.reason)
		}
		used[field] = true
		delete(remainingActual, field)
		delete(remainingPinned, field)
	}
	return remainingActual, remainingPinned
}

func TestResolveCommandLineMarksExplicitNullThumbnailDimensionsAsConfigured(t *testing.T) {
	workingDirectory := t.TempDir()
	serverDirectory := t.TempDir()
	config := "thumbnails:\n  dimensions:\n    bg: null\n    avatar: null\n    persona: null\n"
	if err := os.WriteFile(filepath.Join(workingDirectory, "config.yaml"), []byte(config), 0o644); err != nil {
		t.Fatal(err)
	}
	clearOptionEnvironment(t)
	setEnvironment(t, "SILLYTAVERN_DATAROOT", nil)

	parsed, err := ResolveCommandLine(ResolveOptions{
		WorkingDirectory: workingDirectory,
		ServerDirectory:  serverDirectory,
	})
	if err != nil {
		t.Fatal(err)
	}
	settings := parsed.StartupSettings
	if !settings.ThumbnailDimensionsSet || settings.ThumbnailDimensionsBG != nil || settings.ThumbnailDimensionsAvatar != nil || settings.ThumbnailDimensionsPersona != nil {
		t.Fatalf("configured thumbnail dimensions = %+v", settings)
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
			if name == "-" {
				continue
			}
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
