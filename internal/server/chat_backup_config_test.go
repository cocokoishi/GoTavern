package server

// Config-resolution tests for the pinned chat auto-backup settings.
//
// PINNED SEMANTICS under test (src/endpoints/chats.js:27-30 and src/util.js:88-109):
//   - the four values are read ONCE, at module load (boot), through getConfigValue;
//   - precedence is environment (`SILLYTAVERN_` + upper-case key with '.' -> '_'),
//     then the runtime config.yaml, then the pinned default;
//   - 'number' is JavaScript parseFloat with the default on NaN;
//   - 'boolean' is toBoolean (trimmed case-insensitive "true"/"false", else
//     JavaScript truthiness).
//
// Defaults are default/config.yaml's backups block: enabled=true,
// chat.maxTotalBackups=-1, chat.throttleInterval=10000,
// common.numberOfBackups=50.

import (
	"math"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func chatBackupTestUnsetEnv(t *testing.T, key string) {
	t.Helper()
	previous, existed := os.LookupEnv(key)
	if !existed {
		return
	}
	if err := os.Unsetenv(key); err != nil {
		t.Fatalf("unset %s: %v", key, err)
	}
	t.Cleanup(func() { _ = os.Setenv(key, previous) })
}

func chatBackupTestClearEnvironment(t *testing.T) {
	t.Helper()
	for _, key := range []string{
		"SILLYTAVERN_BACKUPS_CHAT_ENABLED",
		"SILLYTAVERN_BACKUPS_CHAT_MAXTOTALBACKUPS",
		"SILLYTAVERN_BACKUPS_CHAT_THROTTLEINTERVAL",
		"SILLYTAVERN_BACKUPS_COMMON_NUMBEROFBACKUPS",
	} {
		chatBackupTestUnsetEnv(t, key)
	}
}

func chatBackupTestWriteConfig(t *testing.T, directory, body string) string {
	t.Helper()
	path := filepath.Join(directory, "config.yaml")
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
	return path
}

func chatBackupTestAssertSettings(t *testing.T, label string, settings chatBackupSettings, enabled bool, maxTotal float64, interval time.Duration, numberOfBackups float64) {
	t.Helper()
	if settings.enabled != enabled {
		t.Errorf("%s enabled = %v; want %v", label, settings.enabled, enabled)
	}
	if settings.maxTotalBackups != maxTotal {
		t.Errorf("%s maxTotalBackups = %v; want %v", label, settings.maxTotalBackups, maxTotal)
	}
	if settings.throttleInterval != interval {
		t.Errorf("%s throttleInterval = %v; want %v", label, settings.throttleInterval, interval)
	}
	if settings.numberOfBackups != numberOfBackups {
		t.Errorf("%s numberOfBackups = %v; want %v", label, settings.numberOfBackups, numberOfBackups)
	}
}

func TestChatBackupEnvironmentNamesMatchPinnedKeyToEnv(t *testing.T) {
	cases := map[string]string{
		"backups.chat.enabled":           "SILLYTAVERN_BACKUPS_CHAT_ENABLED",
		"backups.chat.maxTotalBackups":   "SILLYTAVERN_BACKUPS_CHAT_MAXTOTALBACKUPS",
		"backups.chat.throttleInterval":  "SILLYTAVERN_BACKUPS_CHAT_THROTTLEINTERVAL",
		"backups.common.numberOfBackups": "SILLYTAVERN_BACKUPS_COMMON_NUMBEROFBACKUPS",
	}
	for key, want := range cases {
		if got := chatBackupEnvironmentName(key); got != want {
			t.Errorf("chatBackupEnvironmentName(%q) = %q; pinned keyToEnv = %q", key, got, want)
		}
	}
}

func TestChatBackupConfigDefaultsMatchPinned(t *testing.T) {
	chatBackupTestClearEnvironment(t)
	settings := chatBackupSettingsForOptions(HTTPHandlerOptions{})
	chatBackupTestAssertSettings(t, "defaults", settings, true, -1, 10*time.Second, 50)
}

func TestChatBackupConfigComesFromRuntimeConfigFile(t *testing.T) {
	chatBackupTestClearEnvironment(t)
	installRoot := t.TempDir()
	chatBackupTestWriteConfig(t, installRoot, "backups:\n  chat:\n    enabled: false\n    maxTotalBackups: 2\n    throttleInterval: 250\n  common:\n    numberOfBackups: 7\n")
	settings := chatBackupSettingsForOptions(HTTPHandlerOptions{InstallRoot: installRoot})
	chatBackupTestAssertSettings(t, "config.yaml", settings, false, 2, 250*time.Millisecond, 7)
}

func TestChatBackupConfigConfigPathWinsOverInstallRoot(t *testing.T) {
	chatBackupTestClearEnvironment(t)
	installRoot := t.TempDir()
	chatBackupTestWriteConfig(t, installRoot, "backups:\n  chat:\n    throttleInterval: 111\n")
	otherRoot := t.TempDir()
	configPath := chatBackupTestWriteConfig(t, otherRoot, "backups:\n  chat:\n    throttleInterval: 222\n")
	settings := chatBackupSettingsForOptions(HTTPHandlerOptions{InstallRoot: installRoot, ConfigPath: configPath})
	if settings.throttleInterval != 222*time.Millisecond {
		t.Fatalf("throttleInterval = %v; the --configPath file is the runtime config (pinned getConfig reads it), want 222ms", settings.throttleInterval)
	}
}

func TestChatBackupConfigEnvironmentOverridesFile(t *testing.T) {
	chatBackupTestClearEnvironment(t)
	installRoot := t.TempDir()
	chatBackupTestWriteConfig(t, installRoot, "backups:\n  chat:\n    enabled: true\n    maxTotalBackups: 5\n    throttleInterval: 250\n  common:\n    numberOfBackups: 7\n")
	t.Setenv("SILLYTAVERN_BACKUPS_CHAT_ENABLED", "false")
	t.Setenv("SILLYTAVERN_BACKUPS_CHAT_MAXTOTALBACKUPS", "9")
	t.Setenv("SILLYTAVERN_BACKUPS_CHAT_THROTTLEINTERVAL", "40")
	t.Setenv("SILLYTAVERN_BACKUPS_COMMON_NUMBEROFBACKUPS", "3")
	settings := chatBackupSettingsForOptions(HTTPHandlerOptions{InstallRoot: installRoot})
	chatBackupTestAssertSettings(t, "environment", settings, false, 9, 40*time.Millisecond, 3)
}

func TestChatBackupConfigPinnedNumberCoercion(t *testing.T) {
	cases := []struct {
		label string
		value any
		want  float64
	}{
		{"plain", "10000", 10000},
		{"suffix", "10000ms", 10000},
		{"spaces", "  -1  ", -1},
		{"hexPrefix", "0x10", 0},
		{"infinity", "Infinity", math.Inf(1)},
		{"negativeInfinity", "-Infinity", math.Inf(-1)},
		{"fraction", ".5", 0.5},
		{"exponent", "1e3", 1000},
		{"bareExponent", "1e", 1},
		{"plus", "+2", 2},
		{"yamlInt", 12, 12},
		{"yamlFloat", 2.5, 2.5},
		{"emptyString", "", 99},
		{"notANumber", "abc", 99},
		{"null", nil, 99},
		{"boolean", true, 99},
	}
	for _, testCase := range cases {
		got := chatBackupNumber(testCase.value, 99)
		if got != testCase.want && !(math.IsInf(got, 1) && math.IsInf(testCase.want, 1)) && !(math.IsInf(got, -1) && math.IsInf(testCase.want, -1)) {
			t.Errorf("%s: chatBackupNumber(%#v, 99) = %v; pinned parseFloat/default = %v", testCase.label, testCase.value, got, testCase.want)
		}
	}
}

func TestChatBackupConfigPinnedBooleanCoercion(t *testing.T) {
	cases := []struct {
		label string
		value string
		want  bool
	}{
		{"trueText", "true", true},
		{"falseText", "false", false},
		{"mixedCase", "  TrUe  ", true},
		{"yesIsTruthy", "yes", true},
		{"emptyIsFalsy", "", false},
		{"zeroStringIsTruthy", "0", true},
	}
	for _, testCase := range cases {
		installRoot := t.TempDir()
		chatBackupTestWriteConfig(t, installRoot, "backups:\n  chat:\n    enabled: \""+testCase.value+"\"\n")
		chatBackupTestClearEnvironment(t)
		settings := chatBackupSettingsForOptions(HTTPHandlerOptions{InstallRoot: installRoot})
		if settings.enabled != testCase.want {
			t.Errorf("%s: enabled = %v; pinned toBoolean(%q) = %v", testCase.label, settings.enabled, testCase.value, testCase.want)
		}
	}
}

func TestChatBackupConfigNullBooleanAndNumberValues(t *testing.T) {
	chatBackupTestClearEnvironment(t)
	installRoot := t.TempDir()
	// null values are PRESENT in the config (lodash _.get returns null, not the
	// default): a null boolean is falsy, a null number falls back through parseFloat.
	chatBackupTestWriteConfig(t, installRoot, "backups:\n  chat:\n    enabled: null\n    maxTotalBackups: null\n    throttleInterval: null\n  common:\n    numberOfBackups: null\n")
	settings := chatBackupSettingsForOptions(HTTPHandlerOptions{InstallRoot: installRoot})
	chatBackupTestAssertSettings(t, "nulls", settings, false, -1, 10*time.Second, 50)
}

func TestChatBackupConfigThrottleIntervalConversion(t *testing.T) {
	cases := []struct {
		label        string
		milliseconds float64
		want         time.Duration
	}{
		{"tenSeconds", 10000, 10 * time.Second},
		{"fractional", 2.5, 2500 * time.Microsecond},
		{"zero", 0, 0},
		{"negative", -100, 0},
		{"nan", math.NaN(), 0},
	}
	for _, testCase := range cases {
		if got := chatBackupThrottle(testCase.milliseconds); got != testCase.want {
			t.Errorf("%s: chatBackupThrottle(%v) = %v; want %v", testCase.label, testCase.milliseconds, got, testCase.want)
		}
	}
}
