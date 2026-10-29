package outbound

// DNS RESULT ORDER -- the `dnsPreferIPv6` / `--dnsPreferIPv6` option.
//
// THE PINNED BEHAVIOUR, in its own lines:
//
//	src/command-line.js:309   `dnsPreferIPv6: cliArguments.dnsPreferIPv6 ?? getConfigValue('dnsPreferIPv6',
//	                          defaultConfig.dnsPreferIPv6, 'boolean')`, whose default is FALSE
//	                          (src/command-line.js:66, default/config.yaml:17-18).
//	src/server-main.js:465-477 `setDnsResolutionOrder()`: `dns.setDefaultResultOrder('ipv6first')` when the
//	                          flag is on, `dns.setDefaultResultOrder('ipv4first')` when it is off, and a
//	                          warning if the Node version cannot do it.
//	src/server-main.js:481   the call runs in the startup chain (`.then(setDnsResolutionOrder)`), i.e.
//	                          before the listener and before any provider request.
//
// WHAT THAT CALL MEANS, and nothing more: `dns.setDefaultResultOrder` sets the ORDER of the address list
// that `dns.lookup` returns; it does not add or drop addresses and it does not make an unreachable family
// reachable. So the observable is *which of a host's addresses the connect attempt is made to first*, and
// the Go equivalent has to produce the same thing.
//
// WHY THIS IS NOT A `net.Dialer` KNOB: Go has no equivalent switch. `net.Dialer`'s list comes from
// `internetAddrList`, which SORTS a multi-family answer with `sortByRFC6724` before the dialer sees it, so
// neither `GODEBUG` nor a custom `Resolver` can impose the pinned order -- the sort runs after the resolver.
// The only place the preference can be applied is therefore between the lookup and the connect, which is
// what this file does: resolve once, order, then dial in that order and stop at the first success.
//
// WHAT IS NOT CLAIMED: Node >= 20 also runs `autoSelectFamily` (a happy-eyeballs race) underneath, and the
// pinned source line says nothing about it. This implementation keeps an explicit fallback -- every
// candidate is attempted, preferred family first -- because a port that only listens on the non-preferred
// family must still be reachable; that fallback is our bound, not a pinned byte.

import (
	"context"
	"net"
	"net/netip"
	"sync/atomic"
	"time"
)

// hostLookup is the resolver the ordering dialer uses. It is a variable rather than a direct call for one
// reason: a host that resolves to BOTH families without depending on this machine's DNS is the only way to
// assert the preference, and a test that cannot present such a host would pass whether or not the ordering
// existed. It is never assigned outside a test.
var hostLookup = func(ctx context.Context, host string) ([]netip.Addr, error) {
	return net.DefaultResolver.LookupNetIP(ctx, "ip", host)
}

// dnsOrderCount counts the ordering decisions this process made, so a test can prove the wrapper RAN
// rather than inferring it from a connection that could have been made by luck.
var dnsOrderCount atomic.Int64

// dialContextFunc is the shape net/http.Transport calls for a connection.
type dialContextFunc func(ctx context.Context, network, address string) (net.Conn, error)

// dnsOrderedDialContext wraps a dialer with the pinned DNS result order:
//
//   - the host is an IP literal (the common case in tests and for a proxy) -> delegate unchanged, because
//     there is no order to choose between;
//   - the network is family-specific (`tcp4` / `tcp6`) -> delegate unchanged, because the caller already
//     constrained the family and re-resolving could only break it;
//   - otherwise -> resolve once, put the preferred family first, and connect to each candidate in that
//     order, returning the first connection that opens.
//
// The per-attempt budget is the base dialer's `Timeout` divided by the number of candidates, so a
// black-holed preferred family cannot consume the whole connect window and leave the fallback untried. The
// whole loop is additionally bounded by the base dialer's `Timeout`, so runtime cannot park here.
func dnsOrderedDialContext(inner dialContextFunc, base *net.Dialer) dialContextFunc {
	return func(ctx context.Context, network, address string) (net.Conn, error) {
		host, port, splitErr := net.SplitHostPort(address)
		if splitErr != nil {
			return inner(ctx, network, address)
		}
		if _, parseErr := netip.ParseAddr(host); parseErr == nil {
			return inner(ctx, network, address)
		}
		switch network {
		case "tcp4", "tcp6", "tcp4tls", "tcp6tls":
			return inner(ctx, network, address)
		}
		addresses, lookupErr := hostLookup(ctx, host)
		if lookupErr != nil {
			// The pinned call has no error path either: a lookup failure is the dialer's to report, and
			// resolving it again here would make a name that only the system resolver understands
			// unreachable. Hand the ORIGINAL address back to the inner dial so the error names the host.
			return inner(ctx, network, address)
		}
		ordered := orderAddresses(currentProductionTransport().PreferIPv6, addresses)
		if len(ordered) == 0 {
			return inner(ctx, network, address)
		}
		dnsOrderCount.Add(1)

		attemptContext := ctx
		cancel := context.CancelFunc(func() {})
		if base.Timeout > 0 {
			attemptContext, cancel = context.WithTimeout(ctx, base.Timeout)
		}
		defer cancel()

		perAttempt := time.Duration(0)
		if base.Timeout > 0 {
			perAttempt = base.Timeout / time.Duration(len(ordered))
		}

		var lastErr error
		for _, candidate := range ordered {
			candidateContext := attemptContext
			cancelCandidate := context.CancelFunc(func() {})
			if perAttempt > 0 {
				candidateContext, cancelCandidate = context.WithTimeout(attemptContext, perAttempt)
			}
			connection, dialErr := inner(candidateContext, network, net.JoinHostPort(candidate.String(), port))
			cancelCandidate()
			if dialErr == nil {
				return connection, nil
			}
			lastErr = dialErr
			if attemptContext.Err() != nil {
				break
			}
		}
		return nil, lastErr
	}
}

// orderAddresses puts the preferred family first and keeps the resolver's own order inside each family.
// It is stable, and it never drops an address: the preference is an order, not a filter.
func orderAddresses(preferIPv6 bool, addresses []netip.Addr) []netip.Addr {
	preferred := make([]netip.Addr, 0, len(addresses))
	rest := make([]netip.Addr, 0, len(addresses))
	for _, address := range addresses {
		isIPv6 := address.Is6() && !address.Is4In6()
		if isIPv6 == preferIPv6 {
			preferred = append(preferred, address)
			continue
		}
		rest = append(rest, address)
	}
	return append(preferred, rest...)
}
