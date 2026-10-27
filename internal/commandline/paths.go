// Package commandline implements the pinned server entrypoint's config and
// data-root selection before the process changes to the server directory.
package commandline

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/cocokoishi/gotavern/internal/configinit"
	"gopkg.in/yaml.v3"
)

// ResolveOptions describes the parts of process startup needed to resolve the
// pinned config and data paths. Args contains command-line tokens after the
// executable and script name. Other SillyTavern flags are recognized only so
// their values are not mistaken for path arguments.
type ResolveOptions struct {
	Args                []string
	WorkingDirectory    string
	ServerDirectory     string
	ForceGlobalMode     *bool
	GlobalDataDirectory string
}

// PathWarning is a warning that upstream emits but does not use to stop
// command-line parsing, such as failure to create the data root.
type PathWarning struct {
	Message string
	Err     error
}

// ResolvedPaths preserves the path strings returned by the upstream parser as
// well as their absolute locations before and after server.js changes cwd.
type ResolvedPaths struct {
	Global               bool
	ConfigPath           string
	ConfigFile           string
	ConfigInitialization configinit.Result
	DataRoot             string
	DataRootCreationPath string
	DataRootCreated      bool
	RuntimeDataRoot      string
	Warnings             []PathWarning
}

type pathArguments struct {
	global     *bool
	configPath *string
	dataRoot   *string
}

// ResolvePaths follows CommandLineParser.parse() for config-path selection,
// config initialization, data-root precedence, and data-root creation. The
// caller remains responsible for the other server flags and for changing cwd
// to ServerDirectory before using RuntimeDataRoot.
func ResolvePaths(options ResolveOptions) (ResolvedPaths, error) {
	result := ResolvedPaths{}
	if options.WorkingDirectory == "" {
		workingDirectory, err := os.Getwd()
		if err != nil {
			return result, fmt.Errorf("get working directory: %w", err)
		}
		options.WorkingDirectory = workingDirectory
	}
	if options.ServerDirectory == "" {
		options.ServerDirectory = options.WorkingDirectory
	}
	workingDirectory, err := filepath.Abs(options.WorkingDirectory)
	if err != nil {
		return result, fmt.Errorf("resolve working directory: %w", err)
	}
	serverDirectory, err := filepath.Abs(options.ServerDirectory)
	if err != nil {
		return result, fmt.Errorf("resolve server directory: %w", err)
	}

	arguments, err := parsePathArguments(options.Args)
	if err != nil {
		return result, err
	}
	if options.ForceGlobalMode != nil {
		result.Global = *options.ForceGlobalMode
	} else if arguments.global != nil {
		result.Global = *arguments.global
	}

	globalDataDirectory := options.GlobalDataDirectory
	if result.Global && globalDataDirectory == "" {
		globalDataDirectory, err = DefaultGlobalDataDirectory()
		if err != nil {
			return result, fmt.Errorf("resolve global data directory: %w", err)
		}
	}

	if result.Global {
		if arguments.configPath != nil && *arguments.configPath != "" {
			result.Warnings = append(result.Warnings, PathWarning{Message: "Warning: \"--configPath\" argument is ignored in global mode"})
		}
		if arguments.dataRoot != nil && *arguments.dataRoot != "" {
			result.Warnings = append(result.Warnings, PathWarning{Message: "Warning: \"--dataRoot\" argument is ignored in global mode"})
		}
		result.ConfigPath = filepath.Join(globalDataDirectory, "config.yaml")
	} else if arguments.configPath != nil {
		result.ConfigPath = *arguments.configPath
	} else {
		result.ConfigPath = "./config.yaml"
	}

	if result.Global {
		configDirectory := filepath.Dir(result.ConfigPath)
		if _, err := os.Stat(configDirectory); errors.Is(err, fs.ErrNotExist) {
			if err := os.MkdirAll(configDirectory, 0o777); err != nil {
				return result, fmt.Errorf("create global config directory %s: %w", configDirectory, err)
			}
		} else if err != nil {
			return result, fmt.Errorf("inspect global config directory %s: %w", configDirectory, err)
		}
	}

	result.ConfigFile, err = absolutePathFrom(workingDirectory, result.ConfigPath)
	if err != nil {
		return result, fmt.Errorf("resolve config file: %w", err)
	}
	configResult, err := configinit.Initialize(result.ConfigFile)
	if err != nil {
		return result, fmt.Errorf("initialize config file %s: %w", result.ConfigPath, err)
	}
	result.ConfigInitialization = configResult

	if result.Global {
		result.DataRoot = filepath.Join(globalDataDirectory, "data")
	} else if arguments.dataRoot != nil {
		result.DataRoot = *arguments.dataRoot
	} else if configuredRoot, found, err := configuredDataRoot(result.ConfigFile); err != nil {
		return result, err
	} else if found {
		result.DataRoot = configuredRoot
	} else {
		result.DataRoot = "./data"
	}
	if !result.Global {
		if environmentRoot, exists := os.LookupEnv("SILLYTAVERN_DATAROOT"); exists {
			result.DataRoot = environmentRoot
		}
		if arguments.dataRoot != nil {
			result.DataRoot = *arguments.dataRoot
		}
	}

	result.DataRootCreationPath, err = absolutePathFrom(workingDirectory, result.DataRoot)
	if err != nil {
		return result, fmt.Errorf("resolve data root for initialization: %w", err)
	}
	result.RuntimeDataRoot, err = absolutePathFrom(serverDirectory, result.DataRoot)
	if err != nil {
		return result, fmt.Errorf("resolve runtime data root: %w", err)
	}
	// CREATE THE DIRECTORY THAT WILL BE USED, AND ONLY THAT ONE (ARCHITECTURE 34.5, 2026-10-26).
	//
	// PINNED CREATES THE OTHER ONE. `server.js:8` runs the parser -- and the creation lives inside it, at
	// `src/command-line.js:292-293` -- BEFORE `server.js:11 process.chdir(serverDirectory)`. So for a
	// RELATIVE dataRoot pinned renders the mkdir against the LAUNCH directory and then uses
	// `path.join(globalThis.DATA_ROOT, ...)` after the chdir, i.e. against the SERVER directory. Pinned
	// therefore creates one directory and serves another, silently: its own `mkdirSync` succeeds, so the
	// warning at `command-line.js:295-297` never fires, and the ENOENT arrives later on the first write.
	//
	// GoTavern diverges on purpose, for AGENTS 27: startup must not create state in a directory the user
	// did not name, and a relative `dataRoot` names ONE directory, not two. The directory created here is
	// the one the runtime will use; the launch-directory rendering is NOT created, and it is REPORTED when
	// it is a different path, so nothing is skipped invisibly.
	//
	// Both fields stay populated exactly as the pinned fixture records them
	// (tests/oracle/sillytavern-1.19.0-commandline-paths.json: dataRootCreationRelativeToCwd and
	// runtimeDataRootRelativeToServerDirectory), so the path PARITY is untouched and only the side effect
	// changes. See internal/commandline/paths_test.go for the divergence row that asserts both paths.
	switch {
	case result.DataRoot == "":
		// The empty value is pinned's own odd branch: it attempts `mkdirSync("")`, which fails, and keeps
		// going with a warning. The error is carried through unchanged so the recorded
		// `failedDataRootCreation: true` for scenario `empty-data-root` stays exactly what it is.
		createErr := os.MkdirAll(result.DataRoot, 0o777)
		result.Warnings = append(result.Warnings, PathWarning{
			Message: "Warning: Failed to create data root directory at . Please make sure the path is correct and writable.",
			Err:     createErr,
		})
	case result.DataRootCreationPath != result.RuntimeDataRoot:
		if _, statErr := os.Stat(result.RuntimeDataRoot); errors.Is(statErr, fs.ErrNotExist) {
			if createErr := os.MkdirAll(result.RuntimeDataRoot, 0o777); createErr != nil {
				result.Warnings = append(result.Warnings, PathWarning{
					Message: fmt.Sprintf("Warning: Failed to create data root directory at %s. Please make sure the path is correct and writable.", result.DataRoot),
					Err:     createErr,
				})
			} else {
				result.DataRootCreated = true
			}
		}
		// The discarded creation, said out loud and from the user's point of view: which directory was
		// asked for, which one is actually used, and that nothing was written to the other.
		result.Warnings = append(result.Warnings, PathWarning{
			Message: fmt.Sprintf(
				"Warning: dataRoot %q is relative, so it resolves against two different directories: %s "+
					"(where this process was started) and %s (the install directory, which is what the "+
					"running server uses). Only %s was created; nothing was written to %s. Use an absolute "+
					"path, or run the server from its install directory, to remove the ambiguity.",
				result.DataRoot, result.DataRootCreationPath, result.RuntimeDataRoot,
				result.RuntimeDataRoot, result.DataRootCreationPath),
		})
	default:
		if _, statErr := os.Stat(result.DataRootCreationPath); errors.Is(statErr, fs.ErrNotExist) {
			if createErr := os.MkdirAll(result.DataRootCreationPath, 0o777); createErr != nil {
				result.Warnings = append(result.Warnings, PathWarning{
					Message: fmt.Sprintf("Warning: Failed to create data root directory at %s. Please make sure the path is correct and writable.", result.DataRoot),
					Err:     createErr,
				})
			} else {
				result.DataRootCreated = true
			}
		}
	}
	return result, nil
}

// DefaultGlobalDataDirectory ports env-paths@3.0.0 with suffix disabled, as
// used by the pinned CommandLineParser for global mode.
func DefaultGlobalDataDirectory() (string, error) {
	switch runtime.GOOS {
	case "windows":
		localAppData := os.Getenv("LOCALAPPDATA")
		if localAppData != "" {
			return filepath.Join(localAppData, "SillyTavern", "Data"), nil
		}
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		localAppData = filepath.Join(home, "AppData", "Local")
		return filepath.Join(localAppData, "SillyTavern", "Data"), nil
	case "darwin":
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		return filepath.Join(home, "Library", "Application Support", "SillyTavern"), nil
	default:
		dataHome := os.Getenv("XDG_DATA_HOME")
		if dataHome != "" {
			return filepath.Join(dataHome, "SillyTavern"), nil
		}
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		dataHome = filepath.Join(home, ".local", "share")
		return filepath.Join(dataHome, "SillyTavern"), nil
	}
}

func configuredDataRoot(configPath string) (string, bool, error) {
	body, err := os.ReadFile(configPath)
	if err != nil {
		return "", false, fmt.Errorf("read initialized config file: %w", err)
	}
	var config map[string]any
	if err := yaml.Unmarshal(body, &config); err != nil {
		return "", false, fmt.Errorf("parse initialized config file: %w", err)
	}
	value, found := config["dataRoot"]
	if !found {
		return "", false, nil
	}
	root, ok := value.(string)
	if !ok {
		return "", false, fmt.Errorf("config dataRoot must be a string, got %T", value)
	}
	return root, true, nil
}

func absolutePathFrom(base, value string) (string, error) {
	if filepath.IsAbs(value) {
		return filepath.Abs(value)
	}
	return filepath.Abs(filepath.Join(base, value))
}

func parsePathArguments(args []string) (pathArguments, error) {
	var result pathArguments
	for index := 0; index < len(args); index++ {
		argument := args[index]
		if !strings.HasPrefix(argument, "--") {
			continue
		}
		name, inlineValue, hasInlineValue := strings.Cut(strings.TrimPrefix(argument, "--"), "=")
		if strings.HasPrefix(name, "no-") && !hasInlineValue {
			if name == "no-global" {
				value := false
				result.global = &value
			}
			continue
		}
		switch name {
		case "global":
			value := true
			if hasInlineValue {
				value = strings.EqualFold(inlineValue, "true")
			} else if index+1 < len(args) && (strings.EqualFold(args[index+1], "true") || strings.EqualFold(args[index+1], "false")) {
				value = strings.EqualFold(args[index+1], "true")
				index++
			}
			result.global = &value
		case "configPath":
			if value, next, present := optionalArgumentValue(args, index, inlineValue, hasInlineValue); present {
				result.configPath = &value
				index = next
			}
		case "dataRoot":
			if value, next, present := optionalArgumentValue(args, index, inlineValue, hasInlineValue); present {
				result.dataRoot = &value
				index = next
			}
		default:
			index = skipUnrelatedArgument(args, index, name, hasInlineValue)
		}
	}
	return result, nil
}

func optionalArgumentValue(args []string, index int, inlineValue string, hasInlineValue bool) (string, int, bool) {
	if hasInlineValue {
		return inlineValue, index, true
	}
	if index+1 < len(args) && !strings.HasPrefix(args[index+1], "--") {
		return args[index+1], index + 1, true
	}
	return "", index, false
}

func skipUnrelatedArgument(args []string, index int, name string, hasInlineValue bool) int {
	if hasInlineValue || isBooleanOption(name) {
		return index
	}
	if name == "requestProxyBypass" {
		for index+1 < len(args) && !strings.HasPrefix(args[index+1], "--") {
			index++
		}
		return index
	}
	if index+1 < len(args) && !strings.HasPrefix(args[index+1], "--") {
		return index + 1
	}
	return index
}

func isBooleanOption(name string) bool {
	switch name {
	case "global", "dnsPreferIPv6", "browserLaunchEnabled", "browserLaunchAvoidLocalhost", "listen", "corsProxy", "disableCsrf", "ssl", "whitelist", "basicAuthMode", "enableKeepAlive", "requestProxyEnabled", "autorun", "avoidLocalhost":
		return true
	default:
		return false
	}
}
