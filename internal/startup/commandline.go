package startup

import (
	"errors"
	"math"
	"strconv"
	"time"

	"github.com/cocokoishi/gotavern/internal/commandline"
)

// InitializeDataStartupFromCommandLine translates the pinned parser's result
// and config-derived startup settings into the pre-listener data chain.
func InitializeDataStartupFromCommandLine(installRoot string, parsed commandline.CommandLineResult, now time.Time, waitBeforeLegacyDataMove func(time.Duration)) (DataStartupResult, error) {
	if parsed.Paths.RuntimeDataRoot == "" {
		return DataStartupResult{}, errors.New("command line has no resolved runtime data root")
	}
	settings := parsed.StartupSettings
	legacySecret, err := legacySecretString(settings.LegacyCookieSecret)
	if err != nil {
		return DataStartupResult{}, err
	}
	return InitializeDataStartup(DataStartupOptions{
		InstallRoot:        installRoot,
		DataRoot:           parsed.Paths.RuntimeDataRoot,
		LegacyCookieSecret: legacySecret,
		Security: SecuritySettingsInput{
			Listen:             nodeConfigBoolean(parsed.Options.Listen),
			BasicAuthMode:      nodeConfigBoolean(parsed.Options.BasicAuthMode),
			WhitelistMode:      nodeConfigBoolean(parsed.Options.WhitelistMode),
			EnableUserAccounts: settings.EnableUserAccounts,
			SecurityOverride:   settings.SecurityOverride,
			PerUserBasicAuth:   settings.PerUserBasicAuth,
			BasicAuthUsername:  settings.BasicAuthUsername,
			BasicAuthPassword:  settings.BasicAuthPassword,
		},
		Seed:                     SeedOptions{SkipContentCheck: nodeConfigBoolean(settings.SkipContentCheck)},
		CharacterDiskCache:       nodeConfigBoolean(settings.UseDiskCache),
		SettingsBackupRetention:  startupBackupRetention(settings.SettingsBackupRetention),
		Now:                      now,
		WaitBeforeLegacyDataMove: waitBeforeLegacyDataMove,
	})
}

func legacySecretString(value any) (string, error) {
	if value == nil {
		return "", nil
	}
	secret, ok := value.(string)
	if !ok && nodeTruthy(value) {
		return "", errors.New("legacy cookie secret from config must be a string")
	}
	return secret, nil
}

func startupBackupRetention(value any) int {
	var number float64
	switch typed := value.(type) {
	case int:
		number = float64(typed)
	case int64:
		number = float64(typed)
	case float64:
		number = typed
	case string:
		parsed, err := strconv.ParseFloat(typed, 64)
		if err != nil {
			return 50
		}
		number = parsed
	default:
		return 50
	}
	if math.IsNaN(number) {
		return math.MaxInt
	}
	if number >= float64(math.MaxInt) {
		return math.MaxInt
	}
	if number <= float64(math.MinInt) {
		return math.MinInt
	}
	return int(math.Trunc(number))
}
