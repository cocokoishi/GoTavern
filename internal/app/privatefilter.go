package app

import (
	"os"

	"github.com/cocokoishi/gotavern/internal/commandline"
	"github.com/cocokoishi/gotavern/internal/outbound"
)

// THE PRIVATE ADDRESS FILTER AT BOOT.
//
// pinned runs `initPrivateRequestFilter(requestFilterOptions)` in preSetupTasks (src/server-main.js:348)
// BEFORE `initRequestProxy(...)` (:351), and the order matters for one real case: with the filter enabled
// and the DEFAULT whitelist (the two loopback ranges), a request proxy on localhost still works, and with
// a narrowed whitelist it does not -- in both implementations, because the filter sees the address the
// transport is about to dial, which for a proxied request is the PROXY's address. Configuring the filter
// first and the proxy second reproduces that ordering.
//
// The five values arrive resolved from the command-line layer (internal/commandline/privateaddress.go),
// which reads them with pinned's own getConfigValue semantics -- environment override first, then the
// config file, then the pinned default. `listen` is read here because it selects pinned's
// disabled-with-listen warning (src/private-request-filter.js:243-249) and nothing else.
//
// The console streams are pinned's split: `console.info` (the Enabled banner) goes to stdout and
// `console.warn`/`console.error` (the listen warning, a blocked request, an invalid whitelist entry) go
// to stderr. `outbound` defaults them to the process streams when they are nil; they are passed
// explicitly here so the split is visible at the call site rather than implied.
func configurePrivateAddressFilter(parsed commandline.CommandLineResult) error {
	settings := parsed.PrivateAddressFilter
	return outbound.ConfigurePrivateAddressFilter(outbound.PrivateAddressFilterOptions{
		Enabled:              settings.Enabled,
		AllowedRanges:        settings.AllowedRanges,
		LogBlocked:           settings.LogBlocked,
		LogAllowed:           settings.LogAllowed,
		AllowUnresolvedHosts: settings.AllowUnresolvedHosts,
		Listen:               nodeTruthyOption(parsed.Options.Listen),
		Console:              os.Stdout,
		Errors:               os.Stderr,
	})
}

// nodeTruthyOption coerces a command-line option to a boolean the way pinned's `!!` does, so a `listen`
// value that arrives as the string "true" (or as any other non-empty string) is TRUE, exactly as
// `!!cliArgs.listen` is in the pinned startup. The filter only uses it to decide whether to print a
// warning, so a value that cannot be coerced simply does not warn.
func nodeTruthyOption(value any) bool {
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
	case float64:
		return typed != 0
	default:
		return true
	}
}
