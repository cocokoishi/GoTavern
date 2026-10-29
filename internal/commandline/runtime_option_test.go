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
