package commandline

// UNIMPLEMENTED CONFIG KEYS — the honesty channel (G-06, G-07).
//
// AGENTS.md rule 18: "No fake compatibility. Missing/different behavior is `partial`, `unsupported` or
// `not implemented`; never fabricate success." A config key that GoTavern parses and then ignores
// violates that rule in the worst direction, because the operator believes a control is ON.
//
// This file turns that silent acceptance into a named startup warning. It is explicitly NOT an
// implementation of either feature, and the messages say so: each one names the key, states that the
// behaviour is NOT implemented and that the setting has no effect.
//
// WHY ONLY THESE KEYS, AND WHY NOT EVERY KEY IN THE TWO FAMILIES
//
// The condition is "pinned would behave differently from GoTavern, and the operator asked for the
// pinned behaviour". A warning on a key whose value GoTavern already reproduces would be noise, and
// noise is how a real warning gets ignored:
//
//   - `sso.trustedProxies` alone is NOT warned about. Its shipped default is `['::1', '127.0.0.1']`
//     (default/config.yaml:137-139), so "present and truthy" is true on every stock install, and the
//     list has no effect in pinned either unless an SSO method is enabled (src/users.js:761-767).
//     It is named inside the two switch warnings instead.
//   - `privateAddressWhitelist.allowedRanges`, `.log.blockedRequests`, `.log.allowedRequests` and
//     `.allowUnresolvedHosts` alone are NOT warned about. They are read only INSIDE
//     `initPrivateRequestFilter`'s enabled branch (src/private-request-filter.js:240-252), so with
//     `enabled: false` — the pinned default, and the shipped value — pinned ignores them too and
//     GoTavern matches pinned exactly. They are named inside the `enabled` warning instead.
//
// The two switches that DO warn are the ones where pinned and GoTavern diverge:
// `sso.autheliaAuth`/`sso.authentikAuth` (src/users.js:30-31, :761-767) and
// `privateAddressWhitelist.enabled` (src/server-main.js:340).

// UnimplementedConfigWarning is one config key the operator set that GoTavern accepts and does not act
// on. Key is carried separately from Message so a caller (and a test) can key on the setting rather
// than on prose.
type UnimplementedConfigWarning struct {
	Key     string
	Message string
}

// The pinned reads behind each warning, quoted so the condition can be re-checked without the pinned
// checkout:
//
//	sso.autheliaAuth     getConfigValue('sso.autheliaAuth', false, 'boolean')      src/users.js:30
//	sso.authentikAuth    getConfigValue('sso.authentikAuth', false, 'boolean')     src/users.js:31
//	                     if (AUTHELIA_AUTH && await autheliaUserLogin(request))     src/users.js:761-767
//	privateAddressWhitelist.enabled
//	                     getConfigValue('privateAddressWhitelist.enabled', false, 'boolean')
//	                                                                                src/server-main.js:340
//	                     http.globalAgent = agent; https.globalAgent = agent;       src/private-request-filter.js:254-255
const (
	ssoAutheliaKey   = "sso.autheliaAuth"
	ssoAuthentikKey  = "sso.authentikAuth"
	privateFilterKey = "privateAddressWhitelist.enabled"
)

// unimplementedConfigWarnings reports the config keys an operator set that GoTavern does not implement.
// The order is fixed so the startup output is deterministic.
func unimplementedConfigWarnings(config map[string]any) []UnimplementedConfigWarning {
	warnings := make([]UnimplementedConfigWarning, 0, 3)
	if jsBoolean(getConfigValue(config, ssoAutheliaKey, false, cliBoolean)) {
		warnings = append(warnings, UnimplementedConfigWarning{
			Key: ssoAutheliaKey,
			Message: "Warning: " + ssoAutheliaKey + " is true, but GoTavern does NOT implement SSO auto-login: " +
				"a request carrying the Authelia `Remote-User` header will not establish a session, and users must log in manually. " +
				"sso.trustedProxies is not consulted either. This setting has no effect.",
		})
	}
	if jsBoolean(getConfigValue(config, ssoAuthentikKey, false, cliBoolean)) {
		warnings = append(warnings, UnimplementedConfigWarning{
			Key: ssoAuthentikKey,
			Message: "Warning: " + ssoAuthentikKey + " is true, but GoTavern does NOT implement SSO auto-login: " +
				"a request carrying the Authentik `X-Authentik-Username` header will not establish a session, and users must log in manually. " +
				"sso.trustedProxies is not consulted either. This setting has no effect.",
		})
	}
	if jsBoolean(getConfigValue(config, privateFilterKey, false, cliBoolean)) {
		warnings = append(warnings, UnimplementedConfigWarning{
			Key: privateFilterKey,
			Message: "Warning: " + privateFilterKey + " is true, but GoTavern does NOT implement the private address filter: " +
				"outbound requests that resolve into a private IP range are NOT blocked. " +
				"privateAddressWhitelist.allowedRanges, privateAddressWhitelist.log.blockedRequests, " +
				"privateAddressWhitelist.log.allowedRequests and privateAddressWhitelist.allowUnresolvedHosts are not consulted either. " +
				"This setting has no effect.",
		})
	}
	return warnings
}
