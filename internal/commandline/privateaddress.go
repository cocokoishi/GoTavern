package commandline

// privateAddressWhitelist.* — the five keys pinned reads at src/server-main.js:337-348 and enforces in
// src/private-request-filter.js. Until this file existed GoTavern parsed none of them, so an operator who
// switched the SSRF filter ON got no filtering; the task-9 change made that visible with a startup
// warning, and this change implements the filter, which retires the warning because its text ("GoTavern
// does NOT implement the private address filter") is no longer true.
//
// Every default and every coercion below is the pinned one:
//
//	:340  enabled:              !!getConfigValue('privateAddressWhitelist.enabled', false, 'boolean')
//	:341  privateAddressWhitelist: getConfigValue('privateAddressWhitelist.allowedRanges', ['127.0.0.0/8', '::1/128'])
//	:342  logBlocked:           !!getConfigValue('privateAddressWhitelist.log.blockedRequests', true, 'boolean')
//	:343  logAllowed:           !!getConfigValue('privateAddressWhitelist.log.allowedRequests', false, 'boolean')
//	:344  allowUnresolvedHosts: !!getConfigValue('privateAddressWhitelist.allowUnresolvedHosts', false, 'boolean')
//
// TWO DETAILS OF :341 ARE REPRODUCED RATHER THAN SIMPLIFIED:
//
//  1. The value is read with NO type converter, and pinned's `filterValidIpPatterns` (express-common.js:92-112)
//     returns an EMPTY list for anything that is not an array. A scalar `allowedRanges: '10.0.0.0/8'`
//     therefore disables the whitelist entirely in pinned, rather than whitelisting that one entry -- and
//     because the DEFAULT is an array, an environment override is JSON-parsed and falls back to the
//     default when it does not parse.
//  2. Each entry is stringified the way `getMatch(`${entry}`)` stringifies it, so a number, a boolean or a
//     nested list becomes a string that the pattern parser then rejects and drops with a warning. Doing the
//     coercion here keeps the parser's input a []string and keeps the warning message naming what the
//     operator actually wrote.

// PrivateAddressFilterSettings is privateAddressWhitelist.* as pinned reads it.
type PrivateAddressFilterSettings struct {
	Enabled              bool
	AllowedRanges        []string
	LogBlocked           bool
	LogAllowed           bool
	AllowUnresolvedHosts bool
}

// pinnedPrivateAddressAllowedRanges is the pinned default for `allowedRanges` (server-main.js:341): the
// two loopback ranges, which is why a local request proxy keeps working with the filter enabled.
var pinnedPrivateAddressAllowedRanges = []any{"127.0.0.0/8", "::1/128"}

func privateAddressFilterSettings(config map[string]any) PrivateAddressFilterSettings {
	return PrivateAddressFilterSettings{
		Enabled:              jsBoolean(getConfigValue(config, "privateAddressWhitelist.enabled", false, cliBoolean)),
		AllowedRanges:        privateAddressAllowedRanges(config),
		LogBlocked:           jsBoolean(getConfigValue(config, "privateAddressWhitelist.log.blockedRequests", true, cliBoolean)),
		LogAllowed:           jsBoolean(getConfigValue(config, "privateAddressWhitelist.log.allowedRequests", false, cliBoolean)),
		AllowUnresolvedHosts: jsBoolean(getConfigValue(config, "privateAddressWhitelist.allowUnresolvedHosts", false, cliBoolean)),
	}
}

// privateAddressAllowedRanges resolves `privateAddressWhitelist.allowedRanges` with pinned's shape rule: a
// non-array yields no entries at all, and each entry is stringified.
func privateAddressAllowedRanges(config map[string]any) []string {
	value := getConfigValue(config, "privateAddressWhitelist.allowedRanges", pinnedPrivateAddressAllowedRanges, cliArray)
	items, isArray := value.([]any)
	if !isArray {
		return nil
	}
	entries := make([]string, 0, len(items))
	for _, item := range items {
		entries = append(entries, jsString(item))
	}
	return entries
}
