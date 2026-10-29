package commandline

import "math"

// cacheBuster.* — G-05.
//
// Pinned src/middleware/cacheBuster.js reads exactly two config keys when its module singleton is
// constructed, i.e. at startup:
//
//	:28  this.#isEnabled = !!getConfigValue('cacheBuster.enabled', false, 'boolean');
//	:29  const userAgentPattern = getConfigValue('cacheBuster.userAgentPattern', '');
//	:30-36  if (userAgentPattern) { try { this.#userAgentRegex = new RegExp(userAgentPattern, 'i'); }
//	                                catch { console.error('[Cache Buster] Invalid user agent pattern:', ...); } }
//
// Two details of that constructor are load-bearing and are reproduced rather than simplified:
//
//  1. `enabled` goes through the 'boolean' converter, so it is `toBoolean` (src/util.js:1107-1119):
//     a string "false" is FALSE and any other non-empty string ("yes", "1", "junk") is TRUE.
//     getConfigValue also lets `SILLYTAVERN_CACHEBUSTER_ENABLED` override the file, which is why the
//     shared helper is used here instead of a direct map lookup.
//  2. `userAgentPattern` is read with NO type converter, and the `if (userAgentPattern)` test is
//     JavaScript TRUTHINESS, not "is a non-empty string". A non-empty array, a mapping or the number
//     1 all pass the test and are then String()-coerced by `new RegExp(...)`. An empty array is
//     truthy in JavaScript too (Boolean([]) === true) but String([]) === '', so it yields a regex that
//     matches everything — the same observable as no pattern at all.
//
// So the resolved value this type carries is: `Enabled` after toBoolean, and `UserAgentPattern` the
// JavaScript String() of the configured value, or "" when the value is falsy.

// CacheBusterSettings is the cacheBuster.* configuration as pinned reads it at startup.
type CacheBusterSettings struct {
	// Enabled is `!!getConfigValue('cacheBuster.enabled', false, 'boolean')`
	// (src/middleware/cacheBuster.js:28). The pinned default is false.
	Enabled bool
	// UserAgentPattern is the JavaScript String() of `cacheBuster.userAgentPattern`
	// (src/middleware/cacheBuster.js:29), or "" when that value is falsy. "" means "bust every user
	// agent"; anything else is compiled as a case-insensitive regex
	// (`new RegExp(pattern, 'i')`, src/middleware/cacheBuster.js:32).
	UserAgentPattern string
}

// cacheBusterSettings resolves the two keys the pinned singleton reads.
func cacheBusterSettings(config map[string]any) CacheBusterSettings {
	enabled := jsBoolean(getConfigValue(config, "cacheBuster.enabled", false, cliBoolean))
	raw := getConfigValue(config, "cacheBuster.userAgentPattern", "", cliString)
	pattern := ""
	if jsTruthy(raw) {
		pattern = jsString(raw)
	}
	return CacheBusterSettings{Enabled: enabled, UserAgentPattern: pattern}
}

// jsTruthy is JavaScript's ToBoolean, which is what `if (userAgentPattern)` tests. It is deliberately
// NOT jsBoolean: jsBoolean mirrors pinned's `toBoolean` converter, where the STRING "false" is false,
// while `Boolean("false")` is true.
func jsTruthy(value any) bool {
	switch typed := value.(type) {
	case nil:
		return false
	case bool:
		return typed
	case string:
		return typed != ""
	case int:
		return typed != 0
	case int64:
		return typed != 0
	case uint64:
		return typed != 0
	case float64:
		return typed != 0 && !math.IsNaN(typed)
	case []any:
		// Boolean([]) === true, and Boolean([null]) === true, in JavaScript.
		return true
	case map[string]any:
		return true
	default:
		return true
	}
}
