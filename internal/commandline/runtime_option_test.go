package commandline

import (
	"os"
	"path/filepath"
	"testing"
)

// TestAccessLogEnabledResolvesLikeThePinnedMiddleware pins
// `getConfigValue('logging.enableAccessLog', true, 'boolean')`
// (src/middleware/accessLogWriter.js:6) through the real config-reading path:
// the default is true, an explicit false disables it, and the documented
// environment override wins.
func TestAccessLogEnabledResolvesLikeThePinnedMiddleware(t *testing.T) {
	cases := []struct {
		name        string
		config      string
		environment string
		expected    bool
	}{
		{name: "missing key uses the pinned default of true", config: "listen: true\n", expected: true},
		{name: "fresh install value", config: "logging:\n  enableAccessLog: true\n", expected: true},
		{name: "explicitly disabled", config: "logging:\n  enableAccessLog: false\n", expected: false},
		{name: "environment override wins", config: "logging:\n  enableAccessLog: true\n", environment: "false", expected: false},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			installRoot := t.TempDir()
			configPath := filepath.Join(installRoot, "config.yaml")
			if err := os.WriteFile(configPath, []byte(testCase.config), 0o600); err != nil {
				t.Fatal(err)
			}
			if testCase.environment != "" {
				t.Setenv("SILLYTAVERN_LOGGING_ENABLEACCESSLOG", testCase.environment)
			}
			result, err := ResolveCommandLine(ResolveOptions{
				Args:             []string{"--configPath", configPath, "--dataRoot", filepath.Join(installRoot, "data")},
				WorkingDirectory: installRoot,
				ServerDirectory:  installRoot,
			})
			if err != nil {
				t.Fatal(err)
			}
			if result.AccessLogEnabled != testCase.expected {
				t.Errorf("AccessLogEnabled = %t, want %t", result.AccessLogEnabled, testCase.expected)
			}
		})
	}
}

// TestConsoleMinLogLevelResolvesLikeSetupLogLevel pins
// `getConfigValue('logging.minLogLevel', LOG_LEVELS.DEBUG, 'number')` (src/util.js:1137) through the real
// config-reading path: the default is 0 (DEBUG), a configured integer survives, a fractional value survives
// AS a fraction (because the pinned gate compares numbers, so truncating 2.5 to 2 would let WARN through),
// and the documented environment override wins. The key is also the migration target of the legacy top-level
// `minLogLevel` (src/config-init.js:85-89), which is why `logging.minLogLevel` is the name read here.
func TestConsoleMinLogLevelResolvesLikeSetupLogLevel(t *testing.T) {
	cases := []struct {
		name        string
		config      string
		environment string
		expected    float64
	}{
		{name: "missing key uses the pinned default of 0", config: "listen: true\n", expected: 0},
		{name: "fresh install value", config: "logging:\n  minLogLevel: 0\n", expected: 0},
		{name: "an explicit WARN level", config: "logging:\n  minLogLevel: 2\n", expected: 2},
		{name: "a fractional level is kept as a number", config: "logging:\n  minLogLevel: 2.5\n", expected: 2.5},
		{name: "a quoted number is still a number", config: "logging:\n  minLogLevel: '3'\n", expected: 3},
		{name: "an unparseable value keeps the default", config: "logging:\n  minLogLevel: quiet\n", expected: 0},
		{name: "environment override wins", config: "logging:\n  minLogLevel: 0\n", environment: "2", expected: 2},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			installRoot := t.TempDir()
			configPath := filepath.Join(installRoot, "config.yaml")
			if err := os.WriteFile(configPath, []byte(testCase.config), 0o600); err != nil {
				t.Fatal(err)
			}
			if testCase.environment != "" {
				t.Setenv("SILLYTAVERN_LOGGING_MINLOGLEVEL", testCase.environment)
			}
			result, err := ResolveCommandLine(ResolveOptions{
				Args:             []string{"--configPath", configPath, "--dataRoot", filepath.Join(installRoot, "data")},
				WorkingDirectory: installRoot,
				ServerDirectory:  installRoot,
			})
			if err != nil {
				t.Fatal(err)
			}
			if result.ConsoleMinLogLevel != testCase.expected {
				t.Errorf("ConsoleMinLogLevel = %v, want %v", result.ConsoleMinLogLevel, testCase.expected)
			}
		})
	}
}
