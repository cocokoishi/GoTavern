package outbound

// THE PRIVATE ADDRESS REQUEST FILTER.
//
// pinned reads five keys at src/server-main.js:337-348 and implements the policy in
// src/private-request-filter.js, then installs it by REPLACING THE GLOBAL AGENTS
// (`http.globalAgent = agent; https.globalAgent = agent;` :254-255). That placement is the whole design:
// the check happens when a socket is opened, so it covers the first request AND every redirect hop, and
// no route can opt out of it. GoTavern's equivalent single policy point is this package -- the production
// transport's DialContext -- for the reason docs/api-inventory.md:232 already gives: a route-local dial
// policy would be strictly less safe, because a route that forgot it would be unfiltered.
//
// WHAT IS REPRODUCED, with the pinned line that decides it:
//
//	the eight private ranges (:15-32)                    127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12,
//	                                                     192.168.0.0/16, 169.254.0.0/16, ::1/128,
//	                                                     fc00::/7, fe80::/10 -- exactly these, no more
//	the block is on the RESOLVED address (:166-195)      `dns.promises.lookup(host)` then validate
//	the whitelist is consulted for a private address      `#isAllowedPrivateAddress` (:99-102)
//	an unresolvable host is refused unless opted in (:187-191)
//	`log.blockedRequests` gates the block line (:115-120, :158)
//	`log.allowedRequests` gates the allow line (:151-153)
//	the error text (:158)                                `Blocked request to private IP address: ${ip}`
//	the unresolved-host error text (:190)                `Unable to resolve host: ${host}. Set
//	                                                     privateAddressWhitelist.allowUnresolvedHosts to
//	                                                     true to bypass this check.`
//	the enabled banner (:257-262)                        blank, `[Private Request Filter] Enabled`,
//	                                                     optional `Allowed private addresses: <list>`, blank
//	the disabled-with-listen warning (:243-249)          three lines on stderr
//
// THREE DECISIONS THAT ARE OURS, each recorded rather than hidden:
//
//  1. A v4-mapped-v6 address is treated as its IPv4 address (`::ffff:10.0.0.1` IS `10.0.0.1`). MEASURED
//     against the pinned package: `require('ip-matching').getMatch('10.0.0.0/8').matches('::ffff:10.0.0.1')`
//     answers FALSE, so pinned lets a v4-mapped address walk past every IPv4 range AND every IPv4
//     whitelist entry. That is an inherited SSRF bypass, and AGENTS.md's boundary 5 permits closing one
//     only as a VISIBLE product decision: this is that decision. The whitelist keeps both readings (the
//     raw address for a v6 pattern, the canonical one for a v4 pattern), so an operator who whitelisted
//     `::ffff:0:0/96` is not broken by the hardening.
//
//  2. Every address a hostname resolves to is checked, and the transport dials only an address that
//     passed. pinned resolves once (`dns.promises.lookup`, which returns a single address) and connects
//     to exactly what it checked. Checking all candidates and then dialling one of them preserves that
//     property -- the checked address IS the dialled address -- while keeping the multi-address fallback
//     a host with both A and AAAA records needs. A host whose every address is private is blocked; a
//     host with a public address is reachable through it.
//
//  3. The wire-exact client (`raw.go`) is NOT filtered. It exists to reproduce pinned's request BYTES and
//     is reachable only when GOTAVERN_OUTBOUND_WIRE_EXACT=1 is in the process environment; it carries no
//     user traffic (ARCHITECTURE.md 34.1, AGENTS.md rule 30), so an operator cannot reach it.

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/netip"
	"os"
	"strings"
	"sync/atomic"
)

// privateFilterLogHeader is pinned's LOG_HEADER (src/private-request-filter.js:12). The `color.*` wrappers
// around it are terminal decoration: chalk renders them as nothing when the stream is not a TTY, and this
// implementation never emits ANSI escapes, so the plain form is what both write to a log file. That is
// the one place the log lines are not byte-identical to a colour terminal's.
const privateFilterLogHeader = "[Private Request Filter]"

// pinnedPrivateRanges is pinned's `privateIpRanges` (src/private-request-filter.js:15-32), in its order.
var pinnedPrivateRanges = []netip.Prefix{
	netip.MustParsePrefix("127.0.0.0/8"),
	netip.MustParsePrefix("10.0.0.0/8"),
	netip.MustParsePrefix("172.16.0.0/12"),
	netip.MustParsePrefix("192.168.0.0/16"),
	netip.MustParsePrefix("169.254.0.0/16"),
	netip.MustParsePrefix("::1/128"),
	netip.MustParsePrefix("fc00::/7"),
	netip.MustParsePrefix("fe80::/10"),
}

// PrivateAddressFilterOptions is the resolved privateAddressWhitelist.* configuration
// (src/server-main.js:337-348) plus the streams the pinned console lines go to.
type PrivateAddressFilterOptions struct {
	// Enabled is `privateAddressWhitelist.enabled`, default false (server-main.js:340).
	Enabled bool
	// AllowedRanges is `privateAddressWhitelist.allowedRanges`, default ['127.0.0.0/8','::1/128']
	// (server-main.js:341). Each entry is parsed with the pinned package's grammar; an invalid entry is
	// DROPPED with a warning, never fatal (express-common.js:99-109).
	AllowedRanges []string
	// LogBlocked is `privateAddressWhitelist.log.blockedRequests`, default true (server-main.js:342).
	LogBlocked bool
	// LogAllowed is `privateAddressWhitelist.log.allowedRequests`, default false (server-main.js:343).
	LogAllowed bool
	// AllowUnresolvedHosts is `privateAddressWhitelist.allowUnresolvedHosts`, default false
	// (server-main.js:344).
	AllowUnresolvedHosts bool
	// Listen is the server's `listen` option. It only selects pinned's disabled-with-listen warning
	// (private-request-filter.js:243-249); it does not affect the filter.
	Listen bool
	// Console receives pinned's console.info lines (nil means os.Stdout). Errors receives its
	// console.warn/console.error lines (nil means os.Stderr) -- Node's own split.
	Console io.Writer
	Errors  io.Writer
}

// privateAddressFilter is the installed policy. It is read on every dial rather than captured when a
// client is built, because the production client is cached per TLS configuration (transport.go
// `transportFor`) and a filter configured after a client exists would otherwise be invisible -- the
// "capability that never reaches the behaviour" failure this project keeps finding.
type privateAddressFilter struct {
	enabled              bool
	allowed              []ipPattern
	logBlocked           bool
	logAllowed           bool
	allowUnresolvedHosts bool
	console              io.Writer
	errors               io.Writer
}

// privateAddressFilterState holds the installed filter. The zero value (nothing stored) is a disabled
// filter, so a process that never calls ConfigurePrivateAddressFilter behaves exactly as it did before
// this file existed.
var privateAddressFilterState atomic.Value // privateAddressFilter

// BlockedPrivateAddressError is the refusal, typed so a caller can tell a policy refusal from a peer that
// is simply not listening. Its message is pinned's, verbatim (src/private-request-filter.js:158).
type BlockedPrivateAddressError struct {
	Address netip.Addr
}

func (err *BlockedPrivateAddressError) Error() string {
	return "Blocked request to private IP address: " + err.Address.String()
}

// UnresolvedHostError is pinned's refusal for a host its lookup could not resolve
// (src/private-request-filter.js:190).
type UnresolvedHostError struct {
	Host string
}

func (err *UnresolvedHostError) Error() string {
	return "Unable to resolve host: " + err.Host + ". Set privateAddressWhitelist.allowUnresolvedHosts to true to bypass this check."
}

// ConfigurePrivateAddressFilter installs the policy. It never fails the boot: pinned does not fail it
// either (an invalid whitelist entry is dropped with a warning, and a disabled filter is not an error),
// and a boot that refused here would turn a typo in one whitelist entry into an unreachable server.
func ConfigurePrivateAddressFilter(options PrivateAddressFilterOptions) error {
	console := options.Console
	if console == nil {
		console = os.Stdout
	}
	errStream := options.Errors
	if errStream == nil {
		errStream = os.Stderr
	}

	allowed := make([]ipPattern, 0, len(options.AllowedRanges))
	for _, entry := range options.AllowedRanges {
		pattern, err := parseIPPattern(entry)
		if err != nil {
			// pinned filterValidIpPatterns (express-common.js:104-107) warns and drops:
			// `Warning: Ignoring invalid private whitelist entry <entry> - <message>`
			fmt.Fprintf(errStream, "Warning: Ignoring invalid private whitelist entry %s - %v\n", entry, err)
			continue
		}
		allowed = append(allowed, pattern)
	}

	filter := privateAddressFilter{
		enabled:              options.Enabled,
		allowed:              allowed,
		logBlocked:           options.LogBlocked,
		logAllowed:           options.LogAllowed,
		allowUnresolvedHosts: options.AllowUnresolvedHosts,
		console:              console,
		errors:               errStream,
	}
	privateAddressFilterState.Store(filter)

	if !filter.enabled {
		// pinned private-request-filter.js:243-249: a listen-mode server with the filter off says so.
		if options.Listen {
			fmt.Fprintln(errStream)
			fmt.Fprintln(errStream, "Warning: listen is enabled but private request filter is disabled. This may expose your server to SSRF attacks.")
			fmt.Fprintln(errStream, "To enable, provide trusted addresses in privateAddressWhitelist.allowedRanges and set privateAddressWhitelist.enabled to true in config.yaml and restart the server.")
		}
		return nil
	}

	// pinned private-request-filter.js:257-262.
	fmt.Fprintln(console)
	fmt.Fprintf(console, "%s Enabled\n", privateFilterLogHeader)
	if len(filter.allowed) > 0 {
		rendered := make([]string, 0, len(filter.allowed))
		for _, pattern := range filter.allowed {
			rendered = append(rendered, pattern.String())
		}
		fmt.Fprintf(console, "%s Allowed private addresses: %s\n", privateFilterLogHeader, strings.Join(rendered, ", "))
	}
	fmt.Fprintln(console)
	return nil
}

// DisablePrivateAddressFilter restores the pre-configuration state. It exists for tests and for a caller
// that must undo an installation; production installs once at boot.
func DisablePrivateAddressFilter() {
	privateAddressFilterState.Store(privateAddressFilter{})
}

// currentPrivateAddressFilter returns the installed filter, or a disabled one when nothing was installed.
func currentPrivateAddressFilter() privateAddressFilter {
	filter, _ := privateAddressFilterState.Load().(privateAddressFilter)
	return filter
}

// isPrivateAddress reports whether the address falls in one of pinned's eight ranges. The address is
// CANONICALISED first, which is decision 1 above: a v4-mapped-v6 address is its IPv4 address, so it
// cannot slip past the IPv4 ranges. (netip.Prefix.Contains would answer false for a mapped address even
// for a matching IPv4 prefix -- "an IPv4-mapped IPv6 address will not match an IPv4 prefix" -- so the
// unmap is load-bearing, not cosmetic.)
func isPrivateAddress(address netip.Addr) bool {
	canonical := canonicalAddress(address)
	for _, block := range pinnedPrivateRanges {
		if block.Contains(canonical) {
			return true
		}
	}
	return false
}

// canonicalAddress maps a v4-mapped-v6 address onto its IPv4 address and leaves everything else alone.
func canonicalAddress(address netip.Addr) netip.Addr {
	if address.Is4In6() {
		return address.Unmap()
	}
	return address
}

// allows reports whether the whitelist covers the address. A v4 pattern also covers the v4-mapped
// spelling of the same address, so the hardening in decision 1 does not narrow an existing whitelist.
func (filter privateAddressFilter) allows(address netip.Addr) bool {
	if matchesAnyPattern(filter.allowed, address) {
		return true
	}
	canonical := canonicalAddress(address)
	if canonical == address {
		return false
	}
	return matchesAnyPattern(filter.allowed, canonical)
}

func matchesAnyPattern(patterns []ipPattern, address netip.Addr) bool {
	for _, pattern := range patterns {
		if pattern.matches(address) {
			return true
		}
	}
	return false
}

// check is pinned's `validateIpAddress` (src/private-request-filter.js:143-159): a non-private address
// passes silently, a private address passes only through the whitelist, and the refusal is returned as
// well as logged (the log is gated by log.blockedRequests; the refusal never is).
func (filter privateAddressFilter) check(address netip.Addr) error {
	if !isPrivateAddress(address) {
		return nil
	}
	if filter.allows(address) {
		if filter.logAllowed && filter.console != nil {
			fmt.Fprintf(filter.console, "%s Allowed request to private IP address: %s\n", privateFilterLogHeader, canonicalAddress(address))
		}
		return nil
	}
	if filter.logBlocked && filter.errors != nil {
		fmt.Fprintf(filter.errors, "%s Blocked request to private IP address: %s\n", privateFilterLogHeader, canonicalAddress(address))
	}
	return &BlockedPrivateAddressError{Address: canonicalAddress(address)}
}

// privateAddressDialContext wraps a dialer with the policy. It is installed on the PRODUCTION transport
// only, and it reads the installed filter at DIAL time, so:
//
//   - with nothing configured (or configured disabled) it delegates to the base dialer untouched, which
//     is the byte-identical behaviour every existing user gets;
//   - every redirect hop opens a new connection through this function, so every hop is validated --
//     pinned gets the same property from replacing the global agent rather than from a per-request hook.
func privateAddressDialContext(base *net.Dialer) func(ctx context.Context, network, address string) (net.Conn, error) {
	return func(ctx context.Context, network, address string) (net.Conn, error) {
		filter := currentPrivateAddressFilter()
		if !filter.enabled {
			return base.DialContext(ctx, network, address)
		}
		return filter.dial(ctx, base, network, address)
	}
}

// dial is the filtered connect. It never dials an address it has not checked.
func (filter privateAddressFilter) dial(ctx context.Context, base *net.Dialer, network, address string) (net.Conn, error) {
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		// net/http always passes host:port. A form this cannot parse is refused rather than dialled
		// unchecked: "could not parse" must not become "therefore allowed".
		return nil, fmt.Errorf("private address filter cannot parse the dial address %q: %w", address, err)
	}

	if literal, parseErr := netip.ParseAddr(host); parseErr == nil {
		if checkErr := filter.check(literal); checkErr != nil {
			return nil, checkErr
		}
		return base.DialContext(ctx, network, address)
	}

	addresses, lookupErr := net.DefaultResolver.LookupNetIP(ctx, "ip", host)
	if lookupErr != nil {
		if filter.allowUnresolvedHosts {
			// pinned private-request-filter.js:187-189: `connect()` with the ORIGINAL options, i.e. the
			// hostname, letting the system resolver decide. Reproduced, hole and all.
			return base.DialContext(ctx, network, address)
		}
		refusal := &UnresolvedHostError{Host: host}
		if filter.errors != nil {
			fmt.Fprintf(filter.errors, "%s %s\n", privateFilterLogHeader, refusal.Error())
		}
		return nil, refusal
	}

	permitted := make([]netip.Addr, 0, len(addresses))
	var refusal error
	for _, candidate := range addresses {
		if checkErr := filter.check(candidate); checkErr != nil {
			if refusal == nil {
				refusal = checkErr
			}
			continue
		}
		permitted = append(permitted, candidate)
	}
	if len(permitted) == 0 {
		if refusal == nil {
			// LookupNetIP returned an empty list without an error. Refuse rather than dial unchecked.
			refusal = &UnresolvedHostError{Host: host}
		}
		return nil, refusal
	}

	var lastErr error
	for _, candidate := range permitted {
		connection, dialErr := base.DialContext(ctx, network, net.JoinHostPort(candidate.String(), port))
		if dialErr == nil {
			return connection, nil
		}
		lastErr = dialErr
	}
	return nil, lastErr
}

// NOT COVERED, stated so a reader does not have to discover it: the wire-exact measuring client
// (raw.go) dials through its own net.Dialer, so it is not filtered. It exists to reproduce pinned's
// request bytes and is reachable only with GOTAVERN_OUTBOUND_WIRE_EXACT=1 in the process environment; it
// carries no user traffic (ARCHITECTURE.md 34.1, AGENTS.md rule 30).
