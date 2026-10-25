package commandline

import "strings"

// AutoUpdateKey is the ONLY input that can enable automatic extension/plugin updating.
//
// WHY IT IS NOT ONE OF THE INHERITED KEYS. GoTavern's fresh install writes
// upstream/generated/default-config.yaml verbatim (hard rules 3 and 4, and
// TestInitializeCreatesPinnedFreshConfig byte-compares it), and that file contains
// `extensions.autoUpdate: true` and `enableServerPluginsAutoUpdate: true`. A fresh install and a migrated
// stock tree therefore carry an EXPLICIT true from the first boot, so "absent means off" would still leave
// every new user with updates they never asked for. The inherited keys are read for reporting only.
//
// The divergence is deliberate (ARCHITECTURE.md 34.3, AGENTS.md rules 26 and 28): pinned's own default is
// `true`; GoTavern's is `false`, from a key that is GoTavern's own.
const AutoUpdateKey = "gotavern.autoUpdateExtensions"

// ResolveAutoUpdate maps a raw configuration value to the update decision.
//
// TRUE only for a present Go bool `true`, or a string that equals "true" after ToLower(TrimSpace).
// EVERYTHING ELSE IS FALSE: absent, nil/null, "false", "", "yes", "on", "1", "0", junk, numbers,
// sequences, mappings and any unexpected type.
//
// IT DELIBERATELY DIVERGES FROM jsBoolean, which cannot be reused for this key. jsBoolean returns true
// for "yes", "on", "1", "0" and junk (`default: return typed != ""`), true for a number != 0, and true for
// an unexpected type (`default: return true`), so a malformed value would turn the feature ON -- the
// exact direction rule 26 names. A future reader must not "restore consistency" by routing this key back
// through jsBoolean: that silently re-opens P0-C.
func ResolveAutoUpdate(value any, present bool) bool {
	if !present {
		return false
	}
	switch typed := value.(type) {
	case bool:
		return typed
	case string:
		return strings.ToLower(strings.TrimSpace(typed)) == "true"
	default:
		return false
	}
}
