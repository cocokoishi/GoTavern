package server

// `requestOverrides` -- the operator's per-host header overrides for outgoing API requests.
//
// THE PINNED SOURCE, in full, because every part of it is behaviour:
//
//	src/additional-headers.js:202-210
//	  export function getOverrideHeaders(urlHost) {
//	      const requestOverrides = getConfigValue('requestOverrides', []);
//	      const overrideHeaders = requestOverrides?.find((e) => e.hosts?.includes(urlHost))?.headers;
//	      if (overrideHeaders && urlHost) { return overrideHeaders; } else { return {}; }
//	  }
//
//	src/additional-headers.js:248-265 (inside setAdditionalHeadersByType)
//	  const getHeaders = headerGetters[type];
//	  const headers = getHeaders ? getHeaders(directories, secretId) : {};
//	  if (typeof server === 'string' && server.length > 0) {
//	      try {
//	          const url = new URL(server);
//	          const overrideHeaders = getOverrideHeaders(url.host);
//	          if (overrideHeaders && Object.keys(overrideHeaders).length > 0) {
//	              Object.assign(headers, overrideHeaders);
//	          }
//	      } catch { /* Do nothing */ }
//	  }
//	  Object.assign(requestHeaders, headers);
//
// So the contract this file reproduces is:
//
//   - the key is `requestOverrides`, read from the runtime config on EVERY call (not module load) with a
//     default of `[]`, and it is read RAW -- `getConfigValue('requestOverrides', [])` has no conversion
//     argument, so a value that is not an array makes `.find` throw and the whole override is skipped. That
//     is why a non-array config value must produce NO overrides rather than a best-effort guess.
//   - the match key is `new URL(server).host`: the hostname lowercased, with the port EXCEPT when the port is
//     the scheme's default (WHATWG drops `:80` for http and `:443` for https). An IPv6 authority keeps its
//     brackets. The pinned comment in default/config.yaml:285 says the same thing in the operator's words:
//     "host includes the port number if it's not the default (80 or 443)".
//   - `hosts?.includes(urlHost)` is EXACT membership in the FIRST entry that matches; `find` stops there, so
//     a first matching entry WITHOUT headers suppresses every later entry rather than falling through.
//   - `e.hosts` may be a STRING as far as the language is concerned (`'abc'.includes` exists), and then the
//     match is a SUBSTRING test. Reproduced rather than "corrected", because a config written that way
//     behaves that way on the pinned server.
//   - the override is applied with `Object.assign` AFTER the type's own headers, so it OVERRIDES them --
//     including `Authorization` and `Content-Type`. The pinned call sites set `Content-Type` in the `args`
//     literal BEFORE calling setAdditionalHeaders (text-completions.js:111-115, :326-334), which is why the
//     Go call sites apply this AFTER their own content-type assignment.
//   - an empty or missing `headers` object applies nothing (`Object.keys(...).length > 0`).
//   - header NAMES are case-insensitive on the wire: node-fetch normalises them into a `Headers` object, so
//     an override spelled `Authorization` replaces a bearer header spelled `authorization`. Our header maps
//     are lowercase-keyed, so the override keys are lowercased to reproduce that replacement.
//
// WHAT IT LOOKS LIKE TO A USER: this is the documented way (default/config.yaml:284-294) to reach a provider
// that wants a specific Host/User-Agent/Content-Type or an extra auth header, and it is the only way to make
// an overridden `Authorization` win. Before this file, GoTavern parsed the key and applied nothing, so a
// config that named hosts and headers produced a request without them.

import (
	"net/url"
	"strconv"
	"strings"

	"github.com/cocokoishi/gotavern/internal/startup"
)

// pinnedRequestOverrideHeadersFor is `getOverrideHeaders(new URL(server).host)` for the header set about to be
// sent to serverURL: the first matching entry's headers, lowercased, or nil.
func pinnedRequestOverrideHeadersFor(directories startup.UserDirectories, serverURL string) map[string]string {
	if serverURL == "" {
		// `typeof server === 'string' && server.length > 0`: an absent target applies nothing.
		return nil
	}
	host, ok := pinnedURLHost(serverURL)
	if !ok {
		// `new URL(server)` threw, and the pinned catch swallows it.
		return nil
	}
	value, exists := pinnedChatConfigValue(directories, []string{"requestOverrides"})
	if !exists {
		return nil
	}
	entries, isArray := value.([]any)
	if !isArray {
		// `requestOverrides?.find` on a non-array throws in pinned, inside a catch that does nothing.
		return nil
	}
	for _, entry := range entries {
		object, isObject := entry.(map[string]any)
		if !isObject {
			// `e.hosts?.includes` on a null/primitive entry: `?.` yields undefined for null, and a
			// primitive has no `hosts`, so the entry cannot match.
			continue
		}
		hosts, hasHosts := object["hosts"]
		if !hasHosts || hosts == nil {
			continue
		}
		if !pinnedHostsInclude(hosts, host) {
			continue
		}
		// THE FIRST MATCH DECIDES, headers or not: `find` stops at the entry whose HOSTS matched.
		headers, hasHeaders := object["headers"]
		if !hasHeaders || headers == nil {
			return nil
		}
		headerObject, isHeaderObject := headers.(map[string]any)
		if !isHeaderObject || len(headerObject) == 0 {
			// `overrideHeaders && Object.keys(overrideHeaders).length > 0`.
			return nil
		}
		applied := make(map[string]string, len(headerObject))
		for name, headerValue := range headerObject {
			applied[strings.ToLower(name)] = pinnedJavaScriptString(headerValue)
		}
		return applied
	}
	return nil
}

// pinnedHostsInclude is `hosts.includes(host)` for the two shapes the language accepts: an ARRAY (exact
// membership, so only a string entry can match) and a STRING (substring, because String.prototype.includes
// exists and `hosts?.includes` does not type-check).
func pinnedHostsInclude(hosts any, host string) bool {
	switch typed := hosts.(type) {
	case string:
		return strings.Contains(typed, host)
	case []any:
		for _, candidate := range typed {
			if text, isString := candidate.(string); isString && text == host {
				return true
			}
		}
		return false
	default:
		return false
	}
}

// pinnedApplyRequestOverrides assigns the overrides onto a header map the way `Object.assign(headers,
// overrideHeaders)` does: replace an existing header of the same name, add the ones that are absent, leave
// everything else untouched.
func pinnedApplyRequestOverrides(directories startup.UserDirectories, serverURL string, headers map[string]string) {
	if headers == nil {
		return
	}
	for name, value := range pinnedRequestOverrideHeadersFor(directories, serverURL) {
		headers[name] = value
	}
}

// pinnedURLHost is `new URL(raw).host`: the lowercased authority with the scheme's DEFAULT port removed
// (WHATWG URL serialisation), which is the key `requestOverrides[].hosts` is matched against.
func pinnedURLHost(raw string) (string, bool) {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return "", false
	}
	host := strings.ToLower(parsed.Host)
	if port := parsed.Port(); port != "" && port == defaultPortForScheme(parsed.Scheme) {
		// Strip the default port from the AUTHORITY, keeping an IPv6 bracket pair intact.
		if strings.HasPrefix(host, "[") {
			if end := strings.Index(host, "]"); end >= 0 {
				return host[:end+1], true
			}
			return host, true
		}
		return strings.TrimSuffix(host, ":"+port), true
	}
	return host, true
}

// defaultPortForScheme is the WHATWG default port table for the schemes a provider URL can carry.
func defaultPortForScheme(scheme string) string {
	switch strings.ToLower(scheme) {
	case "http", "ws":
		return "80"
	case "https", "wss":
		return "443"
	case "ftp":
		return "21"
	default:
		return ""
	}
}

// pinnedJavaScriptString is `String(value)` for a config-supplied header value, so a YAML number or boolean
// reaches the wire the way the pinned assignment would render it.
func pinnedJavaScriptString(value any) string {
	switch typed := value.(type) {
	case nil:
		return "null"
	case bool:
		return strconv.FormatBool(typed)
	case string:
		return typed
	case int:
		return strconv.Itoa(typed)
	case int64:
		return strconv.FormatInt(typed, 10)
	case uint64:
		return strconv.FormatUint(typed, 10)
	case float64:
		return strconv.FormatFloat(typed, 'g', -1, 64)
	case []any:
		parts := make([]string, 0, len(typed))
		for _, item := range typed {
			if item == nil {
				// JS Array#join renders null and undefined as empty.
				parts = append(parts, "")
				continue
			}
			parts = append(parts, pinnedJavaScriptString(item))
		}
		return strings.Join(parts, ",")
	case map[string]any:
		return "[object Object]"
	default:
		return ""
	}
}
